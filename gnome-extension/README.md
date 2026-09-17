# XM5 Noise Control — GNOME Shell extension

Switch the Sony WH-1000XM5 noise-control mode (normal / noise cancelling / ambient
sound) from GNOME's Quick Settings, without the Sony app. Speaks Sony's RFCOMM
protocol directly (the same "v2" protocol `../xm5.py` uses), entirely in GJS.

The headset icon in the **Sound Output** header (Quick Settings → volume slider →
`>`) becomes a clickable "pill":

- Collapsed, it is a single circle showing the current mode's icon.
- Click it and it grows into a row of three icons: the current mode plus the two
  others.
- Click another mode and the headset switches; the pill collapses back to a circle
  showing the new mode. Clicking the current mode just collapses.

It is active only while a WH-1000XM5 is connected. When the headset disconnects (or
the extension is disabled) the stock headphones icon is restored.

![pill collapsed and expanded](../docs/pill.png)

## Requirements

- GNOME Shell 50 (Wayland or X11), tested on 50.4.
- A WH-1000XM5 paired and connected over Bluetooth.
- No root, no `dbus-python`; the extension uses GJS + BlueZ only.

## Install

```
ln -s "$PWD/gnome-extension" ~/.local/share/gnome-shell/extensions/xm5-mode@nizovtsev
```

Then log out and back in (Wayland cannot reload the live shell), and:

```
gnome-extensions enable xm5-mode@snizovtsev.github.io
```

## How it works

- `sony.js` — the protocol: frame encode/decode, sequence/ACK handling, and the
  ambient-sound-control GET/SET/NOTIFY messages. A direct port of `../xm5.py`.
- `bluez.js` — `Xm5Backend`: watches BlueZ for a connected Sony device, opens its
  RFCOMM control service through the `org.bluez.Profile1` D-Bus API (BlueZ resolves
  the channel from the service UUID and hands over a socket fd), and keeps one
  `SonySession` alive. Emits `state-changed` and `mode-changed`. Because it holds
  the RFCOMM link open, it follows mode changes made with the button on the headset
  itself.
- `headerPill.js` — `Xm5Pill` (the widget) and `HeaderPillInstaller` (swaps it into
  the Sound Output header and restores the stock icon).
- `indicator.js` — an optional top-bar button (radio menu). Off by default; set
  `SHOW_INDICATOR = true` in `extension.js` to show it. Useful as a fallback when
  the volume slider has no device menu (only one output device present).

Only one program can hold the RFCOMM control link at a time, so `../xm5.py` cannot
connect while the extension is enabled, and vice versa.

## Development

`dev/run-headless.sh` starts a throwaway nested GNOME Shell (in-memory settings, so
nothing touches your real session) with only this extension enabled, and
`dev/drive.py` screenshots and clicks it over the nested session bus. Setting
`XM5_TEST_OPEN=1` makes the extension auto-open the Sound Output menu so the pill is
easy to screenshot. These live under `dev/` and are not part of the shipped
extension.

```
XM5_TEST_OPEN=1 dev/run-headless.sh /tmp/xm5-bus &
dev/drive.py -a /tmp/xm5-bus shot /tmp/shot.png
```
