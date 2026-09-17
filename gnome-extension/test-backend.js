#!/usr/bin/env -S gjs -m
// Standalone test of the backend without GNOME Shell:
//   gjs -m test-backend.js            watch: print state changes, exit on Ctrl-C
//   gjs -m test-backend.js nc         set a mode once connected, then exit
//   gjs -m test-backend.js cycle      cycle nc -> ambient -> off, then exit
// Note: disable the extension in the shell first (one RFCOMM client at a time).

import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import {Xm5Backend} from './bluez.js';

const arg = ARGV[0] ?? null;
const loop = new GLib.MainLoop(null, false);
const backend = new Xm5Backend({verbose: true});

backend.connect('mode-changed', (b, mode, level, voice) =>
    print(`*** mode=${mode} level=${level} voice=${voice}`));

backend.connect('state-changed', (b, connected) => {
    print(`*** connected=${connected} name=${b.name} mode=${b.mode}`);
    if (connected && arg)
        run().catch(e => { printerr(e.message); quit(); });
});

async function run() {
    const modes = arg === 'cycle' ? ['nc', 'ambient', 'off'] : [arg];
    for (const m of modes) {
        const st = await backend.setMode(m);
        print(`*** set ${m} -> confirmed ${st.mode}`);
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => { r(); return GLib.SOURCE_REMOVE; }));
    }
    quit();
}

function quit() {
    backend.destroy();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
}

GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 2, () => { quit(); return GLib.SOURCE_REMOVE; });

backend.start().catch(e => { printerr(`start failed: ${e.message}`); quit(); });
loop.run();
