#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Sergei Nizovtsev <snizovtsev@gmail.com>

"""
xm5.py - show / set the noise-control mode of Sony WH-1000XM5 headphones
from Linux over the existing Bluetooth connection (Sony proprietary RFCOMM
protocol, "v2" variant as reverse-engineered by Gadgetbridge).

Usage:
    xm5.py                      show current mode
    xm5.py get                  same, explicit
    xm5.py set nc               noise cancelling
    xm5.py set ambient          ambient sound (transparency)
    xm5.py set off              normal (both off)
    xm5.py set ambient --level 12 --voice
    xm5.py toggle               cycle off -> nc -> ambient -> off
    xm5.py --json ...           machine-readable output (for bars / knobs)

Options:
    -d, --device ADDR|NAME      pick a device (default: first connected WH-1000XM5)
    -c, --channel N             skip BlueZ profile API, connect RFCOMM channel N directly
    -v, --verbose               dump frames

Dependencies: python3, dbus-python, PyGObject (only for the default BlueZ
profile connection). With --channel only the stdlib is needed.

Protocol summary (see Gadgetbridge SonyProtocolImplV2 / Message.java):
    frame     = 0x3E  escape(type seq len[4,BE] payload checksum)  0x3C
    escape    = 0x3E/0x3C/0x3D -> 0x3D, (b & 0xEF)
    checksum  = sum(type..payload) & 0xFF
    types     = ACK 0x01, COMMAND_1 0x0C, COMMAND_2 0x0E
    every COMMAND is answered by an ACK carrying (1 - seq); our own seq
    is updated from the ACK we receive.
    ambient sound control (COMMAND_1):
        GET 0x66 <sub>              -> RET 0x67 <sub> 01 <on> <amb> [<wind>] <voice> <level>
        SET 0x68 <sub> 01 <on> <amb> [<wind>] <voice> <level>
        sub = 0x15 (7-byte form) or 0x17 (8-byte form incl. wind byte)
"""

import argparse
import json
import os
import select
import socket
import struct
import sys
import time

SONY_UUID_V1 = "96cc203e-5068-46ad-b32d-e316f5e069ba"
SONY_UUID_V2 = "956c7b26-d49a-4ba8-b03f-b17d393cb6e2"

HDR, TRL, ESC, ESC_MASK = 0x3E, 0x3C, 0x3D, 0xEF
T_ACK, T_CMD1, T_CMD2 = 0x01, 0x0C, 0x0E

P_INIT_REQ, P_INIT_REP = 0x00, 0x01
P_ASC_GET, P_ASC_RET, P_ASC_SET, P_ASC_NOTIFY = 0x66, 0x67, 0x68, 0x69

MODES = ("off", "nc", "ambient")
MODE_LABEL = {"off": "off (normal)", "nc": "noise cancelling", "ambient": "ambient sound"}

VERBOSE = False


def log(*a):
    if VERBOSE:
        print(*a, file=sys.stderr)


# --------------------------------------------------------------------------- #
# framing
# --------------------------------------------------------------------------- #
def escape(b: bytes) -> bytes:
    out = bytearray()
    for x in b:
        if x in (HDR, TRL, ESC):
            out += bytes((ESC, x & ESC_MASK))
        else:
            out.append(x)
    return bytes(out)


def unescape(b: bytes) -> bytes:
    out = bytearray()
    it = iter(b)
    for x in it:
        if x == ESC:
            out.append(next(it) | ~ESC_MASK & 0xFF)
        else:
            out.append(x)
    return bytes(out)


def encode(mtype: int, seq: int, payload: bytes = b"") -> bytes:
    body = struct.pack(">BBI", mtype, seq, len(payload)) + payload
    chk = sum(body) & 0xFF
    return bytes((HDR,)) + escape(body + bytes((chk,))) + bytes((TRL,))


def decode(frame: bytes):
    """frame: bytes between (and excluding) HDR and TRL. Returns (type, seq, payload)."""
    body = unescape(frame)
    if len(body) < 7:
        raise ValueError("short frame %s" % body.hex())
    if sum(body[:-1]) & 0xFF != body[-1]:
        raise ValueError("bad checksum in %s" % body.hex())
    mtype, seq, plen = struct.unpack(">BBI", body[:6])
    payload = body[6:-1]
    if len(payload) != plen:
        raise ValueError("length mismatch in %s" % body.hex())
    return mtype, seq, payload


# --------------------------------------------------------------------------- #
# transport: BlueZ Profile1 (resolves RFCOMM channel by UUID) or raw channel
# --------------------------------------------------------------------------- #
def find_device(match=None):
    """Return (object_path, address, name, uuid) of a connected Sony device via BlueZ D-Bus."""
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
        elif not (SONY_UUID_V2 in uuids or SONY_UUID_V1 in uuids or "WH-1000XM5" in name):
            continue
        cands.append((bool(dev.get("Connected", False)), str(path), addr, name, uuids))
    if not cands:
        raise SystemExit("no matching Sony device known to BlueZ (is it paired?)")
    cands.sort(reverse=True)  # connected first
    connected, path, addr, name, uuids = cands[0]
    if not connected:
        raise SystemExit("%s (%s) is not connected" % (name, addr))
    uuid = SONY_UUID_V2 if SONY_UUID_V2 in uuids else SONY_UUID_V1
    return path, addr, name, uuid


def connect_via_profile(dev_path, uuid, timeout=10.0):
    """Ask BlueZ to connect the Sony RFCOMM service by UUID; get back a socket fd."""
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

    prof_path = "/xm5/profile%d" % os.getpid()
    profile = Profile(bus, prof_path)
    pm = dbus.Interface(bus.get_object("org.bluez", "/org/bluez"), "org.bluez.ProfileManager1")
    pm.RegisterProfile(prof_path, uuid, {"Role": "client", "AutoConnect": False, "Name": "xm5.py"})
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
# Sony session
# --------------------------------------------------------------------------- #
class Sony:
    def __init__(self, sock):
        self.sock = sock
        self.sock.setblocking(False)
        self.seq = 0
        self.buf = bytearray()
        self.inbox = []  # decoded (type, seq, payload) of non-ACK messages

    def _send_raw(self, data):
        log("-> %s" % data.hex())
        self.sock.sendall(data)

    def _pump(self, timeout):
        """Read until at least one complete frame is parsed or timeout. Returns list of frames."""
        frames = []
        end = time.monotonic() + timeout
        while not frames:
            remain = end - time.monotonic()
            if remain <= 0:
                break
            r, _, _ = select.select([self.sock], [], [], remain)
            if not r:
                break
            data = self.sock.recv(1024)
            if not data:
                raise ConnectionError("headphones closed the connection")
            for b in data:
                if b == HDR:
                    self.buf = bytearray()
                elif b == TRL:
                    try:
                        frames.append(decode(bytes(self.buf)))
                    except ValueError as e:
                        log("bad frame:", e)
                    self.buf = bytearray()
                else:
                    self.buf.append(b)
        return frames

    def _handle(self, frame):
        mtype, seq, payload = frame
        log("<- type=%02x seq=%d payload=%s" % (mtype, seq, payload.hex()))
        if mtype == T_ACK:
            self.seq = seq  # adopt the sequence number the device acked with
            return True
        if mtype in (T_CMD1, T_CMD2):
            self._send_raw(encode(T_ACK, 1 - seq))
            self.inbox.append(frame)
        return False

    def command(self, payload, mtype=T_CMD1, timeout=3.0):
        """Send a command and wait for its ACK. Incoming commands are ACKed and queued."""
        self._send_raw(encode(mtype, self.seq, payload))
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for f in self._pump(end - time.monotonic()):
                if self._handle(f):
                    return
        raise TimeoutError("no ACK for %s" % payload.hex())

    def wait_for(self, ptype, timeout=3.0):
        """Wait for a COMMAND_1 message whose first payload byte == ptype."""
        end = time.monotonic() + timeout
        while True:
            for i, (mt, sq, pl) in enumerate(self.inbox):
                if mt == T_CMD1 and pl and pl[0] == ptype:
                    return self.inbox.pop(i)[2]
            remain = end - time.monotonic()
            if remain <= 0:
                raise TimeoutError("no reply 0x%02x" % ptype)
            for f in self._pump(remain):
                self._handle(f)

    # ---- high level ----
    def init(self):
        self.command(bytes((P_INIT_REQ, 0x00)))
        rep = self.wait_for(P_INIT_REP)
        log("init reply:", rep.hex())
        return rep

    def get_asc(self):
        """Return dict with mode/voice/level plus the raw payload (needed to SET back)."""
        for sub in (0x17, 0x15):
            self.command(bytes((P_ASC_GET, sub)))
            try:
                pl = self.wait_for(P_ASC_RET, timeout=2.0)
            except TimeoutError:
                continue
            if len(pl) >= 7 and pl[1] in (0x15, 0x17):
                return parse_asc(pl)
        raise RuntimeError("headphones did not answer ambient sound control GET")

    def set_asc(self, cur, mode, level=None, voice=None):
        pl = bytearray(cur["raw"])
        pl[0] = P_ASC_SET
        pl[2] = 0x01
        pl[3] = 0x00 if mode == "off" else 0x01
        pl[4] = 0x01 if mode == "ambient" else 0x00
        if cur["wind_byte"] is not None:
            pl[5] = 0x02  # "no wind noise reduction" marker in the 8-byte form
        vi = 6 if cur["wind_byte"] is not None else 5
        if voice is not None:
            pl[vi] = 0x01 if voice else 0x00
        if level is not None:
            pl[vi + 1] = max(1, min(20, int(level)))
        self.command(bytes(pl))
        # device usually follows with a NOTIFY (0x69) carrying the new state
        try:
            return parse_asc(self.wait_for(P_ASC_NOTIFY, timeout=1.5))
        except TimeoutError:
            return None


def parse_asc(pl):
    sub = pl[1]
    has_wind = sub == 0x17 and len(pl) > 7
    on, amb = pl[3], pl[4]
    wind = pl[5] if has_wind else None
    vi = 6 if has_wind else 5
    if on == 0:
        mode = "off"
    elif has_wind and wind in (0x03, 0x05):
        mode = "wind"
    else:
        mode = "ambient" if amb == 1 else "nc"
    return {
        "mode": mode,
        "focus_on_voice": bool(pl[vi]),
        "ambient_level": pl[vi + 1],
        "wind_byte": wind,
        "raw": bytes(pl),
    }


# --------------------------------------------------------------------------- #
def main():
    global VERBOSE
    ap = argparse.ArgumentParser(description="Sony WH-1000XM5 noise-control mode from Linux")
    ap.add_argument("-d", "--device", help="device address or name (default: connected WH-1000XM5)")
    ap.add_argument("-c", "--channel", type=int, help="RFCOMM channel (bypass BlueZ profile API)")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--json", action="store_true", help="JSON output")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("get")
    sp = sub.add_parser("set")
    sp.add_argument("mode", choices=MODES)
    sp.add_argument("--level", type=int, help="ambient level 1..20")
    sp.add_argument("--voice", dest="voice", action="store_true", default=None, help="focus on voice on")
    sp.add_argument("--no-voice", dest="voice", action="store_false", help="focus on voice off")
    sub.add_parser("toggle", help="cycle off -> nc -> ambient")
    args = ap.parse_args()
    VERBOSE = args.verbose

    path, addr, name, uuid = None, args.device, "?", SONY_UUID_V2
    if args.channel is None or not args.device or ":" not in args.device:
        path, addr, name, uuid = find_device(args.device)
    log("device %s %s path=%s uuid=%s" % (name, addr, path, uuid))

    if args.channel is not None:
        sock, cleanup = connect_raw(addr, args.channel)
    else:
        sock, cleanup = connect_via_profile(path, uuid)

    try:
        hp = Sony(sock)
        hp.init()
        cur = hp.get_asc()
        result = cur
        if args.cmd in ("set", "toggle"):
            if args.cmd == "toggle":
                mode = MODES[(MODES.index(cur["mode"]) + 1) % len(MODES)] if cur["mode"] in MODES else "off"
                level, voice = None, None
            else:
                mode, level, voice = args.mode, args.level, args.voice
            new = hp.set_asc(cur, mode, level, voice)
            result = new or hp.get_asc()
    finally:
        try:
            sock.close()
        finally:
            cleanup()

    out = {
        "device": name, "address": addr,
        "mode": result["mode"],
        "focus_on_voice": result["focus_on_voice"],
        "ambient_level": result["ambient_level"],
    }
    if args.json:
        print(json.dumps(out))
    else:
        extra = ""
        if result["mode"] == "ambient":
            extra = "  level=%d voice=%s" % (result["ambient_level"], "on" if result["focus_on_voice"] else "off")
        print("%s: %s%s" % (name, MODE_LABEL.get(result["mode"], result["mode"]), extra))


if __name__ == "__main__":
    main()
