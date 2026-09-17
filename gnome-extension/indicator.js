// indicator.js - step-1 UI: a top-bar button showing the current mode with a
// radio menu to switch it. Created only while the headset control link is up.

import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {MODES, MODE_LABELS} from './sony.js';

export const Xm5Indicator = GObject.registerClass(
class Xm5Indicator extends PanelMenu.Button {
    _init(backend, gicons) {
        super._init(0.5, 'WH-1000XM5', false);
        this._backend = backend;
        this._gicons = gicons;

        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._items = new Map();
        for (const mode of MODES) {
            const item = new PopupMenu.PopupMenuItem(MODE_LABELS[mode]);
            item.connect('activate', () => {
                this._backend.setMode(mode).catch(e =>
                    console.error(`[xm5-mode] setMode(${mode}) failed: ${e.message}`));
            });
            this.menu.addMenuItem(item);
            this._items.set(mode, item);
        }

        this._backend.connectObject('mode-changed', (b, mode) => this._update(mode), this);
        this._update(this._backend.mode);

        this.connect('destroy', () => {
            this._backend?.disconnectObject(this);
            this._backend = null;
        });
    }

    _update(mode) {
        this._icon.gicon = this._gicons[mode] ?? this._gicons.off;
        for (const [m, item] of this._items)
            item.setOrnament(m === mode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
    }
});
