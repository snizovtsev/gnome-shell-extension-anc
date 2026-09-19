#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Sergei Nizovtsev <snizovtsev@gmail.com>

"""
buds.py - show / set the noise-control mode of Samsung Galaxy Buds (FE, 2,
2 Pro, Pro and similar) from Linux over the existing Bluetooth connection
(Samsung proprietary SPP protocol, as reverse-engineered by GalaxyBudsClient).

Usage:
    buds.py                     show current mode
    buds.py get                 same, explicit
    buds.py set nc              active noise cancelling
    buds.py set ambient         ambient sound (transparency)
    buds.py set off             normal (both off)
    buds.py set ambient --level 2
    buds.py set nc --anc-level high
    buds.py toggle              cycle off -> nc -> ambient -> off
    buds.py --json ...          machine-readable output (for bars / knobs)

Options:
    -d, --device ADDR|NAME      pick a device (default: first connected Galaxy Buds)
    -c, --channel N             skip BlueZ profile API, connect RFCOMM channel N directly
    -v, --verbose               dump frames

Dependencies: python3, dbus-python, PyGObject (only for the default BlueZ
profile connection). With --channel only the stdlib is needed.

Protocol summary (see GalaxyBudsClient SppMessage.cs / ExtendedStatusUpdateDecoder.cs):
    frame     = 0xFD  hdr[2, LE]  id  payload  crc16[2, LE]  0xDD
    hdr       = size | flags;  size = len(payload) + 3 (id + crc),
                0x1000 set on device -> host messages (response), 0x2000 = fragment
    crc16     = CRC-16/XMODEM (poly 0x1021, init 0) over id + payload
    on connect the buds push EXTENDED_STATUS_UPDATED (0x61):
        payload[0] revision, [2] battery L, [3] battery R,
        [12] noise-control mode (0 off, 1 anc, 2 ambient, 3 adaptive),
        [23] ambient volume, [24] anc level (0 low, 1 high)
    NOISE_CONTROLS (0x78) <mode>      set mode
    every SET that changes something is answered by ACK (0x42) <id> <value>;
    a no-op SET gets a new EXTENDED_STATUS_UPDATED + NOISE_CONTROLS_UPDATE instead
    NOISE_CONTROLS_UPDATE (0x77) <mode> [<wear>]  pushed when changed on the buds
    AMBIENT_VOLUME (0x84) <0..N>      ambient volume
    NOISE_REDUCTION_LEVEL (0x83) <0|1> anc level low / high
"""

import argparse
import json
import os
import select
import socket
import struct
import sys
import time

# GalaxyBudsClient Uuids.SppNew: Buds Pro / 2 / 2 Pro / FE / 3 control service
BUDS_UUID_NEW = "2e73a4ad-332d-41fc-90e2-16bef06523f2"
# original Galaxy Buds (2019) and Buds+ / Live use these instead (untested here)
BUDS_UUID_LEGACY = "00001102-0000-1000-8000-00805f9b34fd"
BUDS_UUIDS = (BUDS_UUID_NEW, BUDS_UUID_LEGACY)

SOM, EOM = 0xFD, 0xDD
HDR_RESPONSE, HDR_FRAGMENT, HDR_SIZE = 0x1000, 0x2000, 0x03FF

M_STATUS_UPDATED = 0x60
M_EXTENDED_STATUS_UPDATED = 0x61
M_NOISE_CONTROLS_UPDATE = 0x77
M_NOISE_CONTROLS = 0x78
M_ACK = 0x42  # UNIVERSAL_MSG_ID_ACKNOWLEDGEMENT: payload = <acked id> <value>
M_NOISE_REDUCTION_LEVEL = 0x83
M_AMBIENT_VOLUME = 0x84

MODES = ("off", "nc", "ambient")
MODE_CODE = {"off": 0, "nc": 1, "ambient": 2, "adaptive": 3}
CODE_MODE = {v: k for k, v in MODE_CODE.items()}
MODE_LABEL = {"off": "off (normal)", "nc": "noise cancelling", "ambient": "ambient sound", "adaptive": "adaptive"}

VERBOSE = False


def log(*a):
    if VERBOSE:
        print(*a, file=sys.stderr)


# --------------------------------------------------------------------------- #
# framing
# --------------------------------------------------------------------------- #
def crc16(data: bytes) -> int:
    """CRC-16/XMODEM: poly 0x1021, init 0, no reflection, no final xor."""
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def encode(mid: int, payload: bytes = b"", response: bool = False) -> bytes:
    body = bytes((mid,)) + payload
    hdr = (len(body) + 2) | (HDR_RESPONSE if response else 0)
    return bytes((SOM,)) + struct.pack("<H", hdr) + body + struct.pack("<H", crc16(body)) + bytes((EOM,))


def extract_frames(buf: bytearray):
    """Pop complete frames from buf. Yields (id, payload, is_response)."""
    while True:
        start = buf.find(SOM)
        if start < 0:
            buf.clear()
            return
        if start:
            log("skipping %d junk bytes: %s" % (start, bytes(buf[:start]).hex()))
            del buf[:start]
        if len(buf) < 3:
            return
        hdr = struct.unpack_from("<H", buf, 1)[0]
        size = hdr & HDR_SIZE
        total = 1 + 2 + size + 1
        if len(buf) < total:
            return
        frame = bytes(buf[:total])
        body, crc, eom = frame[3:3 + size - 2], struct.unpack_from("<H", frame, 3 + size - 2)[0], frame[-1]
        if size < 3 or eom != EOM or crc16(body) != crc:
            log("bad frame: %s" % frame.hex())
            del buf[:1]  # resync on next SOM
            continue
        del buf[:total]
        yield body[0], body[1:], bool(hdr & HDR_RESPONSE)


# --------------------------------------------------------------------------- #
# transport: BlueZ Profile1 (resolves RFCOMM channel by UUID) or raw channel
# --------------------------------------------------------------------------- #
def find_device(match=None):
    """Return (object_path, address, name, uuid) of a connected Galaxy Buds via BlueZ D-Bus."""
    import dbus
    import dbus.mainloop.glib
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    om = dbus.Interface(bus.get_object("org.bluez", "/"), "org.freedesktop.DBus.ObjectManager")
    cands = []
    for path, ifaces in om.GetManagedObjects().items():
        dev = ifaces.get("org.bluez.Device1")
        if not dev:
            continue
        addr, name = str(dev.get("Address", "")), str(dev.get("Name", dev.get("Alias", "")))
        uuids = [str(u).lower() for u in dev.get("UUIDs", [])]
        if match:
            if match.lower() not in (addr.lower(), name.lower()) and match.lower() not in name.lower():
                continue
        elif not (any(u in uuids for u in BUDS_UUIDS) or "Galaxy Buds" in name):
            continue
        cands.append((bool(dev.get("Connected", False)), str(path), addr, name, uuids))
    if not cands:
        raise SystemExit("no matching Galaxy Buds known to BlueZ (are they paired?)")
    cands.sort(reverse=True)  # connected first
    connected, path, addr, name, uuids = cands[0]
    if not connected:
        raise SystemExit("%s (%s) is not connected" % (name, addr))
    uuid = next((u for u in BUDS_UUIDS if u in uuids), BUDS_UUID_NEW)
    return path, addr, name, uuid


def connect_via_profile(dev_path, uuid, timeout=10.0):
    """Ask BlueZ to connect the Samsung SPP service by UUID; get back a socket fd."""
    import dbus
    import dbus.service
    import dbus.mainloop.glib
    from gi.repository import GLib

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    loop = GLib.MainLoop()
    result = {}

    class Profile(dbus.service.Object):
        @dbus.service.method("org.bluez.Profile1", in_signature="oha{sv}", out_signature="")
        def NewConnection(self, device, fd, props):
            result["fd"] = os.dup(fd.take())
            log("NewConnection from", device)
            loop.quit()

        @dbus.service.method("org.bluez.Profile1", in_signature="o", out_signature="")
        def RequestDisconnection(self, device):
            pass

        @dbus.service.method("org.bluez.Profile1", in_signature="", out_signature="")
        def Release(self):
            pass

    prof_path = "/buds/profile%d" % os.getpid()
    profile = Profile(bus, prof_path)
    pm = dbus.Interface(bus.get_object("org.bluez", "/org/bluez"), "org.bluez.ProfileManager1")
    pm.RegisterProfile(prof_path, uuid, {"Role": "client", "AutoConnect": False, "Name": "buds.py"})
    dev = dbus.Interface(bus.get_object("org.bluez", dev_path), "org.bluez.Device1")

    def on_err(e):
        result["err"] = str(e)
        loop.quit()

    dev.ConnectProfile(uuid, reply_handler=lambda: None, error_handler=on_err, timeout=timeout)
    GLib.timeout_add(int(timeout * 1000), lambda: (result.setdefault("err", "timeout"), loop.quit()) and False)
    loop.run()

    def cleanup():
        try:
            dev.DisconnectProfile(uuid, reply_handler=lambda: None, error_handler=lambda e: None)
        except Exception:
            pass
        try:
            pm.UnregisterProfile(prof_path)
        except Exception:
            pass

    if "fd" not in result:
        cleanup()
        raise SystemExit("ConnectProfile failed: %s" % result.get("err"))
    sock = socket.socket(fileno=result["fd"])
    return sock, cleanup


def connect_raw(addr, channel):
    s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    s.settimeout(10)
    s.connect((addr, channel))
    return s, (lambda: None)


# --------------------------------------------------------------------------- #
# Buds session
# --------------------------------------------------------------------------- #
class Buds:
    def __init__(self, sock):
        self.sock = sock
        self.sock.setblocking(False)
        self.buf = bytearray()
        self.inbox = []  # (id, payload, is_response)

    def send(self, mid, payload=b""):
        data = encode(mid, payload)
        log("-> id=%02x payload=%s  [%s]" % (mid, payload.hex(), data.hex()))
        self.sock.sendall(data)

    def _pump(self, timeout):
        """Read until at least one complete frame arrives or timeout. Appends to inbox."""
        got = 0
        end = time.monotonic() + timeout
        while not got:
            remain = end - time.monotonic()
            if remain <= 0:
                break
            r, _, _ = select.select([self.sock], [], [], remain)
            if not r:
                break
            data = self.sock.recv(4096)
            if not data:
                raise ConnectionError("buds closed the connection")
            self.buf += data
            for f in extract_frames(self.buf):
                log("<- id=%02x %s payload=%s" % (f[0], "rsp" if f[2] else "req", f[1].hex()))
                self.inbox.append(f)
                got += 1
        return got

    def wait_any(self, matchers, timeout=3.0):
        """matchers: {id: predicate-or-None}. Returns (id, payload) of the first match."""
        end = time.monotonic() + timeout
        while True:
            for i, (m, pl, rsp) in enumerate(self.inbox):
                if m in matchers and (matchers[m] is None or matchers[m](pl)):
                    return self.inbox.pop(i)[:2]
            remain = end - time.monotonic()
            if remain <= 0:
                raise TimeoutError("no message %s" % ", ".join("0x%02x" % m for m in matchers))
            self._pump(remain)

    def wait_for(self, mid, timeout=3.0, pred=None):
        """Wait for a message with the given id (and optional payload predicate). Returns payload."""
        return self.wait_any({mid: pred}, timeout)[1]

    # ---- high level ----
    def status(self, timeout=4.0):
        """The buds push EXTENDED_STATUS_UPDATED right after the SPP link comes up."""
        pl = self.wait_for(M_EXTENDED_STATUS_UPDATED, timeout)
        return parse_extended_status(pl)

    def set(self, mid, value, timeout=3.0):
        """Send a one-byte SET and wait for its ACK. Returns the acked value."""
        self.send(mid, bytes((value,)))
        ack = self.wait_for(M_ACK, timeout, pred=lambda pl: pl and pl[0] == mid)
        log("ack for %02x: %s" % (mid, ack.hex()))
        return ack[1] if len(ack) > 1 else value

    def set_mode(self, mode):
        # A real change is ACKed (0x42 78 <mode>). Re-selecting the current mode is
        # not: the buds push a fresh status and NOISE_CONTROLS_UPDATE (0x77 <mode> ...)
        # instead, so accept either as confirmation.
        self.send(M_NOISE_CONTROLS, bytes((MODE_CODE[mode],)))
        mid, pl = self.wait_any({
            M_ACK: lambda pl: pl and pl[0] == M_NOISE_CONTROLS,
            M_NOISE_CONTROLS_UPDATE: None,
        })
        log("mode confirmed by %02x: %s" % (mid, pl.hex()))
        code = pl[1] if mid == M_ACK else pl[0]
        return CODE_MODE.get(code, "unknown")

    def set_ambient_volume(self, level):
        return self.set(M_AMBIENT_VOLUME, level)

    def set_anc_level(self, high):
        return "high" if self.set(M_NOISE_REDUCTION_LEVEL, 1 if high else 0) else "low"


def parse_extended_status(pl):
    if len(pl) < 25:
        raise RuntimeError("extended status too short (%d bytes): %s" % (len(pl), pl.hex()))
    return {
        "revision": pl[0],
        "battery_left": pl[2],
        "battery_right": pl[3],
        "mode": CODE_MODE.get(pl[12], "unknown"),
        "ambient_level": pl[23],
        "anc_level": "high" if pl[24] else "low",
        "raw": bytes(pl),
    }


# --------------------------------------------------------------------------- #
def main():
    global VERBOSE
    ap = argparse.ArgumentParser(description="Samsung Galaxy Buds noise-control mode from Linux")
    ap.add_argument("-d", "--device", help="device address or name (default: connected Galaxy Buds)")
    ap.add_argument("-c", "--channel", type=int, help="RFCOMM channel (bypass BlueZ profile API)")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--json", action="store_true", help="JSON output")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("get")
    sp = sub.add_parser("set")
    sp.add_argument("mode", choices=MODES)
    sp.add_argument("--level", type=int, help="ambient sound volume 0..2")
    sp.add_argument("--anc-level", choices=("low", "high"),
                    help="noise cancelling strength (accepted by Buds FE firmware, but Samsung's app does not expose it there)")
    sub.add_parser("toggle", help="cycle off -> nc -> ambient")
    args = ap.parse_args()
    VERBOSE = args.verbose

    path, addr, name, uuid = None, args.device, "?", BUDS_UUID_NEW
    if args.channel is None or not args.device or ":" not in args.device:
        path, addr, name, uuid = find_device(args.device)
    log("device %s %s path=%s uuid=%s" % (name, addr, path, uuid))

    if args.channel is not None:
        sock, cleanup = connect_raw(addr, args.channel)
    else:
        sock, cleanup = connect_via_profile(path, uuid)

    try:
        buds = Buds(sock)
        cur = buds.status()
        log("extended status:", cur["raw"].hex())
        result = dict(cur)
        if args.cmd in ("set", "toggle"):
            if args.cmd == "toggle":
                mode = MODES[(MODES.index(cur["mode"]) + 1) % len(MODES)] if cur["mode"] in MODES else "off"
                level, anc_level = None, None
            else:
                mode, level, anc_level = args.mode, args.level, args.anc_level
            if level is not None:
                result["ambient_level"] = buds.set_ambient_volume(max(0, min(2, level)))
            if anc_level is not None:
                result["anc_level"] = buds.set_anc_level(anc_level == "high")
            result["mode"] = buds.set_mode(mode)
    finally:
        try:
            sock.close()
        finally:
            cleanup()

    out = {
        "device": name, "address": addr,
        "mode": result["mode"],
        "ambient_level": result["ambient_level"],
        "anc_level": result["anc_level"],
        "battery_left": result["battery_left"],
        "battery_right": result["battery_right"],
    }
    if args.json:
        print(json.dumps(out))
    else:
        extra = ""
        if result["mode"] == "ambient":
            extra = "  level=%d" % result["ambient_level"]
        elif result["mode"] == "nc":
            extra = "  anc=%s" % result["anc_level"]
        print("%s: %s%s  (battery L %d%% R %d%%)" % (
            name, MODE_LABEL.get(result["mode"], result["mode"]), extra,
            result["battery_left"], result["battery_right"]))


if __name__ == "__main__":
    main()
