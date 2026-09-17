# xm5.py — Sony WH-1000XM5 noise-control knob for Linux

Shows and switches the headset's mode (normal / noise cancelling / ambient sound)
over the already-established Bluetooth connection, using Sony's proprietary
RFCOMM protocol (the "v2" variant, as reverse-engineered by Gadgetbridge).
No Sony app, no root, no extra pairing.

    ./xm5.py                 # WH-1000XM5: off (normal)
    ./xm5.py set nc          # noise cancelling
    ./xm5.py set ambient --level 12 --voice
    ./xm5.py set off         # normal
    ./xm5.py toggle          # off -> nc -> ambient -> off  (bind this to a key)
    ./xm5.py --json          # {"mode": "nc", "focus_on_voice": false, "ambient_level": 20, ...}
    ./xm5.py -v get          # dump raw frames

Dependencies: python3, dbus-python, PyGObject (Arch: `python-dbus python-gobject`).
BlueZ resolves the RFCOMM channel for Sony's service UUID
`956c7b26-d49a-4ba8-b03f-b17d393cb6e2` via the Profile1 D-Bus API, so no
sdptool is needed. `-c N` connects to RFCOMM channel N directly with the
stdlib only (untested fallback).

Each invocation takes roughly a second: connect, init handshake, GET, optional
SET, disconnect. The headset keeps A2DP/HFP running throughout.

## Protocol notes (as observed on this unit, fw reported by init reply `01 00 03 00 20 16 00 00`)

    frame    = 3E  escape(type seq len:4BE payload chk)  3C
    escape   = 3E/3C/3D -> 3D (b & EF);  chk = sum(type..payload) & FF
    types    = ACK 01, COMMAND_1 0C;  every COMMAND is ACKed with seq' = 1 - seq
    init     : 0C [00 00]  ->  ACK, 0C [01 ...]
    get mode : 0C [66 17]  ->  ACK, 0C [67 17 01 on amb voice level]
    set mode : 0C [68 17 01 on amb voice level]  ->  ACK, 0C [69 17 ...] (notify)
        on=00 -> normal; on=01,amb=00 -> noise cancelling; on=01,amb=01 -> ambient
        voice = focus-on-voice (00/01), level = ambient level 1..20

Sources: Gadgetbridge `service/devices/sony/headphones/` (SonyProtocolImplV2,
Message.java, PayloadTypeV1), https://github.com/Freeyourgadget/Gadgetbridge

## License

GPL-2.0-or-later — see `LICENSE`.

The wire protocol above was documented by the Gadgetbridge project
(AGPL-3.0-or-later); the code here is an independent implementation written from
that documentation, not a translation of their sources.
