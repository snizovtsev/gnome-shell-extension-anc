// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Sergei Nizovtsev <snizovtsev@gmail.com>
//
// headerPill.js - step-2 UI.
//
// AncPill: an St.BoxLayout that looks like the stock Quick Settings header icon
// circle (`.quick-toggle-menu .header .icon`), shows the current mode, and on
// click grows into a "sausage" of three mode buttons. Selecting another mode
// emits 'mode-selected' and collapses back (optimistically showing the new mode,
// dimmed until the headset confirms via setMode()).
//
// HeaderPillInstaller: swaps the pill into the "Sound Output" header of the volume
// output slider's menu while the headset is connected, and restores the stock icon.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MODES, MODE_LABELS} from './session.js';

const ANIM_MS = 180;
const PENDING_TIMEOUT_MS = 4000;

export const AncPill = GObject.registerClass({
    Signals: {'mode-selected': {param_types: [GObject.TYPE_STRING]}},
}, class AncPill extends St.BoxLayout {
    _init(gicons) {
        super._init({
            style_class: 'anc-pill',
            orientation: Clutter.Orientation.HORIZONTAL,
            clip_to_allocation: true,
            reactive: true,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._gicons = gicons;
        this._mode = null;        // last confirmed mode
        this._expanded = false;
        this._pending = false;
        this._pendingTimeoutId = 0;

        this._current = this._makeButton(true);
        this._alts = [this._makeButton(false), this._makeButton(false)];
        this.add_child(this._current);
        for (const b of this._alts) {
            b.hide();
            this.add_child(b);
        }

        this.connect('destroy', () => this._onDestroy());
    }

    _makeButton(isCurrent) {
        const icon = new St.Icon({style_class: 'anc-pill-icon'});
        const btn = new St.Button({
            style_class: `anc-pill-button${isCurrent ? ' current' : ''}`,
            child: icon,
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
            accessible_role: Atk.Role.RADIO_BUTTON,
        });
        btn._icon = icon;
        btn._mode = null;
        btn.connect('clicked', () => this._onClicked(btn));
        return btn;
    }

    _assign(btn, mode) {
        btn._mode = mode;
        btn._icon.gicon = this._gicons[mode] ?? null;
        btn.accessible_name = MODE_LABELS[mode] ?? mode;
    }

    // ---- public --------------------------------------------------------

    /** Confirmed state from the headset. */
    setMode(mode) {
        this._clearPending();
        this._mode = mode;
        this._assign(this._current, mode);
        const others = MODES.filter(m => m !== mode);
        this._alts.forEach((b, i) => this._assign(b, others[i] ?? others[0]));
        if (this._expanded)
            this._collapse(true);
    }

    collapse() {
        this._collapse(true);
    }

    collapseNow() {
        this._collapse(false);
    }

    // ---- interaction ---------------------------------------------------

    _onClicked(btn) {
        if (this._pending)
            return;
        if (!this._expanded) {
            this._expand();
            return;
        }
        if (btn === this._current) {
            this._collapse(true);
            return;
        }
        const requested = btn._mode;
        this._assign(this._current, requested);   // optimistic
        this._setPending(true);
        this._collapse(true);
        this.emit('mode-selected', requested);
    }

    _setPending(on) {
        this._pending = on;
        if (on)
            this.add_style_class_name('pending');
        else
            this.remove_style_class_name('pending');
        for (const b of [this._current, ...this._alts]) {
            b.reactive = !on;
            b.can_focus = !on;
        }
        if (on) {
            this._pendingTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PENDING_TIMEOUT_MS, () => {
                this._pendingTimeoutId = 0;
                if (this._mode)
                    this.setMode(this._mode);   // revert to last confirmed
                else
                    this._setPending(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clearPending() {
        if (this._pendingTimeoutId) {
            GLib.Source.remove(this._pendingTimeoutId);
            this._pendingTimeoutId = 0;
        }
        if (this._pending)
            this._setPending(false);
    }

    // ---- animation -----------------------------------------------------

    _expand() {
        if (this._expanded)
            return;
        this._expanded = true;
        this.add_style_class_name('expanded');

        this.remove_all_transitions();
        this.width = -1;
        const [, from] = this.get_preferred_width(-1);
        for (const b of this._alts) {
            b.remove_all_transitions();
            b.opacity = 0;
            b.show();
        }
        const [, to] = this.get_preferred_width(-1);
        this.width = from;
        this.ease({
            width: to,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this.width = -1;
            },
        });
        for (const b of this._alts) {
            b.ease({
                opacity: 255,
                duration: ANIM_MS,
                delay: ANIM_MS / 3,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _collapse(animate) {
        if (!this._expanded)
            return;
        this._expanded = false;
        this.remove_style_class_name('expanded');

        if (this._alts.some(b => b.has_key_focus()))
            this._current.grab_key_focus();

        this.remove_all_transitions();
        for (const b of this._alts)
            b.remove_all_transitions();

        if (!animate || !this.mapped) {
            for (const b of this._alts)
                b.hide();
            this.width = -1;
            return;
        }

        this.width = -1;
        const [, from] = this.get_preferred_width(-1);
        for (const b of this._alts)
            b.hide();
        const [, to] = this.get_preferred_width(-1);
        for (const b of this._alts)
            b.show();
        this.width = from;
        for (const b of this._alts) {
            b.ease({
                opacity: 0,
                duration: ANIM_MS / 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this.ease({
            width: to,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                for (const b of this._alts)
                    b.hide();
                this.width = -1;
            },
        });
    }

    _onDestroy() {
        if (this._pendingTimeoutId) {
            GLib.Source.remove(this._pendingTimeoutId);
            this._pendingTimeoutId = 0;
        }
        this.remove_all_transitions();
    }
});

/**
 * Installs/removes the pill in the volume output menu header depending on
 * backend.connected. Call sync() whenever the backend state changes.
 */
export class HeaderPillInstaller {
    constructor(backend, gicons) {
        this._backend = backend;
        this._gicons = gicons;
        this._pill = null;
        this._menu = null;
        this._menuSignalId = 0;
        this._pollId = 0;
        this._pollCount = 0;
    }

    _output() {
        return Main.panel.statusArea.quickSettings?._volumeOutput?._output ?? null;
    }

    sync() {
        const connected = this._backend.connected;
        const output = this._output();

        if (connected && !output) {
            // Quick Settings indicators are created asynchronously at login.
            this._startPoll();
            return;
        }
        this._stopPoll();

        if (connected && output && !this._pill)
            this._install(output);
        else if (!connected && this._pill)
            this._uninstall();
    }

    _startPoll() {
        if (this._pollId)
            return;
        this._pollCount = 0;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (this._output() || ++this._pollCount > 40) {
                this._pollId = 0;
                this.sync();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPoll() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
    }

    _install(output) {
        const menu = output.menu;
        const header = menu?._header;
        const stockIcon = menu?._headerIcon;
        if (!header || !stockIcon || stockIcon.get_parent() !== header) {
            console.warn('[anc-mode] volume output menu header not found; pill not installed');
            return;
        }

        const pill = new AncPill(this._gicons);
        this._pill = pill;
        this._menu = menu;

        stockIcon.hide();
        header.layout_manager.attach(pill, 0, 0, 1, 2);

        pill.setMode(this._backend.mode ?? 'off');
        pill.connect('mode-selected', (p, mode) => {
            this._backend.setMode(mode).catch(e => {
                console.error(`[anc-mode] setMode(${mode}) failed: ${e.message}`);
                if (this._pill === p)
                    p.setMode(this._backend.mode ?? 'off');
            });
        });
        this._backend.connectObject('mode-changed', (b, mode) => pill.setMode(mode), pill);

        this._menuSignalId = menu.connect('open-state-changed', (m, open) => {
            if (!open)
                this._pill?.collapseNow();
        });
        // If the shell destroys the menu under us, forget our references.
        pill.connect('destroy', () => {
            if (this._pill === pill) {
                this._pill = null;
                this._menu = null;
                this._menuSignalId = 0;
            }
        });

        // Test hook (headless dev only): keep the QS panel and the output submenu
        // open so a screenshot can capture the pill without simulating a precise
        // click on the slider's tiny arrow.
        if (GLib.getenv('ANC_TEST_OPEN')) {
            this._testTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                const qs = Main.panel.statusArea.quickSettings.menu;
                if (!qs.isOpen) {
                    qs.open();
                    output.menu.open(false);
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _uninstall() {
        const pill = this._pill;
        const menu = this._menu;
        this._pill = null;
        this._menu = null;
        if (this._testTimerId) {
            GLib.Source.remove(this._testTimerId);
            this._testTimerId = 0;
        }
        if (!pill)
            return;

        if (menu && this._menuSignalId) {
            menu.disconnect(this._menuSignalId);
            this._menuSignalId = 0;
        }
        this._backend.disconnectObject(pill);
        pill.collapseNow();
        pill.get_parent()?.remove_child(pill);
        pill.destroy();
        menu?._headerIcon?.show();
    }

    destroy() {
        this._stopPoll();
        this._uninstall();
        this._backend = null;
        this._gicons = null;
    }
}
