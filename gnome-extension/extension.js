// XM5 Noise Control - GNOME Shell extension entry point.
//
// Owns one Xm5Backend (BlueZ + Sony protocol) and two optional UI pieces:
//   - Xm5Indicator: top-bar button with a radio menu (debug / fallback UI)
//   - HeaderPillInstaller: the clickable mode "pill" replacing the headset icon in
//     Quick Settings -> volume output -> device list header ("Sound Output")
// Both only exist while the headset's control link is up.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Xm5Backend} from './bluez.js';
import {Xm5Indicator} from './indicator.js';
import {HeaderPillInstaller} from './headerPill.js';
import {MODES} from './sony.js';

// Top-bar indicator. The primary UI is the pill in the Sound Output header; the
// indicator is a debugging aid and a fallback for when the volume slider has no
// device menu (only one output device present, so the `>` never appears). Flip
// to true to always show a mode button in the top bar.
const SHOW_INDICATOR = false;

export default class Xm5Extension extends Extension {
    enable() {
        this._gicons = Object.fromEntries(MODES.map(m =>
            [m, Gio.icon_new_for_string(`${this.path}/icons/xm5-${m}-symbolic.svg`)]));

        this._backend = new Xm5Backend({log: msg => console.log(`[xm5-mode] ${msg}`)});
        this._backend.connectObject('state-changed', () => this._sync(), this);

        this._pill = new HeaderPillInstaller(this._backend, this._gicons);
        this._indicator = null;

        this._backend.start().catch(e => console.error(`[xm5-mode] backend start failed: ${e.message}`));
        this._sync();
    }

    _sync() {
        const connected = this._backend?.connected ?? false;

        if (SHOW_INDICATOR) {
            if (connected && !this._indicator) {
                this._indicator = new Xm5Indicator(this._backend, this._gicons);
                Main.panel.addToStatusArea(this.uuid, this._indicator);
            } else if (!connected && this._indicator) {
                this._indicator.destroy();
                this._indicator = null;
            }
        }

        this._pill?.sync();
    }

    disable() {
        this._pill?.destroy();
        this._pill = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._backend?.disconnectObject(this);
        this._backend?.destroy();
        this._backend = null;

        this._gicons = null;
    }
}
