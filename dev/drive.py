#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Sergei Nizovtsev <snizovtsev@gmail.com>

"""
drive.py - poke a (headless) nested GNOME Shell over its session bus.

    drive.py [-a ADDR_FILE] shot OUT.png            screenshot of the whole stage
    drive.py move X Y                                 move pointer to absolute X Y
    drive.py click X Y [button]                       move + click (button: left|right|middle)
    drive.py key KEYSYM [KEYSYM...]                   press+release keysyms (e.g. Escape, super)
    drive.py sleep SECONDS

Multiple commands can be chained with '--' separators:
    drive.py click 1500 12 -- sleep 0.6 -- shot qs.png

Screenshots use org.gnome.Shell.Screenshot; the shell only allows a few well-known
callers, so we own the name org.gnome.SettingsDaemon.MediaKeys on the (private) nested bus.
Input goes through org.gnome.Mutter.RemoteDesktop (works without a screencast
stream by using relative pointer motion from the top-left corner).
"""
import os
import sys
import time

import dbus

BTN = {"left": 0x110, "right": 0x111, "middle": 0x112}


def connect(addr_file):
    addr = open(addr_file).read().strip()
    return dbus.bus.BusConnection(addr)


def screenshot(bus, out):
    bus.request_name("org.gnome.SettingsDaemon.MediaKeys")
    obj = bus.get_object("org.gnome.Shell.Screenshot", "/org/gnome/Shell/Screenshot")
    iface = dbus.Interface(obj, "org.gnome.Shell.Screenshot")
    ok, used = iface.Screenshot(False, False, os.path.abspath(out), timeout=15)
    if not ok:
        raise SystemExit("screenshot failed")
    print(used)


class Input:
    def __init__(self, bus):
        self.bus = bus
        rd = dbus.Interface(bus.get_object("org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop"),
                            "org.gnome.Mutter.RemoteDesktop")
        path = rd.CreateSession()
        self.session = dbus.Interface(bus.get_object("org.gnome.Mutter.RemoteDesktop", path),
                                      "org.gnome.Mutter.RemoteDesktop.Session")
        self.session.Start()
        self.dead = False

    def move(self, x, y):
        # Pointer position is unknown and relative motion is subject to pointer
        # acceleration (fast jumps travel farther than the delta). Slam into the
        # top-left corner, then walk to the target in small steps so velocity stays
        # low and the mapping is ~1:1.
        for _ in range(6):
            self.session.NotifyPointerMotionRelative(-4000.0, -4000.0)
        step = 8.0
        moved = 0.0
        while moved < x:
            d = min(step, x - moved); self.session.NotifyPointerMotionRelative(d, 0.0); moved += d
        moved = 0.0
        while moved < y:
            d = min(step, y - moved); self.session.NotifyPointerMotionRelative(0.0, d); moved += d
        time.sleep(0.05)

    def click(self, x, y, button="left"):
        self.move(x, y)
        time.sleep(0.05)
        self.session.NotifyPointerButton(dbus.Int32(BTN[button]), True)
        time.sleep(0.08)
        try:
            self.session.NotifyPointerButton(dbus.Int32(BTN[button]), False)
        except dbus.exceptions.DBusException as e:
            # mutter drops the session when the press opens a shell grab (menu);
            # destroying the virtual device releases the button implicitly
            print(f"(session ended at release: {str(e).splitlines()[0][:80]})", file=sys.stderr)
            self.dead = True

    def key(self, keysym_name):
        from Xlib import XK  # python-xlib, only for keysym lookup
        ks = XK.string_to_keysym(keysym_name)
        if ks == 0:
            raise SystemExit(f"unknown keysym {keysym_name}")
        self.session.NotifyKeyboardKeysym(dbus.UInt32(ks), True)
        time.sleep(0.03)
        self.session.NotifyKeyboardKeysym(dbus.UInt32(ks), False)

    def stop(self):
        try:
            self.session.Stop()
        except Exception:
            pass


def main():
    args = sys.argv[1:]
    addr_file = "/tmp/anc-nested-bus"
    if args[:1] == ["-a"]:
        addr_file = args[1]
        args = args[2:]
    bus = connect(addr_file)
    inp = None
    cmds, cur = [], []
    for a in args:
        if a == "--":
            cmds.append(cur)
            cur = []
        else:
            cur.append(a)
    if cur:
        cmds.append(cur)
    # An active RemoteDesktop session adds a "screen sharing" indicator to the top
    # bar, shifting the other indicators. Open the session up front (and wait for
    # the bar to settle) so screenshots and clicks see the same layout.
    if any(c and c[0] in ("move", "click", "key") for c in cmds):
        inp = Input(bus)
        time.sleep(0.6)
    try:
        for c in cmds:
            op, rest = c[0], c[1:]
            if op == "shot":
                screenshot(bus, rest[0])
            elif op in ("move", "click", "key"):
                if inp is None or inp.dead:
                    inp = Input(bus)
                if op == "move":
                    inp.move(int(rest[0]), int(rest[1]))
                elif op == "click":
                    inp.click(int(rest[0]), int(rest[1]), *(rest[2:3]))
                else:
                    for k in rest:
                        inp.key(k)
            elif op == "sleep":
                time.sleep(float(rest[0]))
            else:
                raise SystemExit(f"unknown command {op}")
    finally:
        if inp:
            inp.stop()


if __name__ == "__main__":
    main()
