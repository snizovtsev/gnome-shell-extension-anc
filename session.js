// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Sergei Nizovtsev <snizovtsev@gmail.com>
//
// session.js - the device-independent half of a headset control session.
//
// A "driver" (sony.js, samsung.js) subclasses StreamSession and implements its
// vendor protocol on top of the byte stream; HeadsetBackend (bluez.js) and the
// UI only ever use the contract documented on StreamSession below.
//
// Shell-independent: only GLib/GObject/Gio, usable from plain gjs.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

/** The three modes every supported headset has; the UI is built around these. */
export const MODES = ['off', 'nc', 'ambient'];
export const MODE_LABELS = {
    off: 'Off',
    nc: 'Noise Cancelling',
    ambient: 'Ambient Sound',
};

Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');

export function hex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * StreamSession - one RFCOMM control session with a headset.
 *
 * Contract (what HeadsetBackend relies on; drivers may add vendor extras):
 *   constructor(inputStream, outputStream, {log})
 *   async open()             handshake; resolves once `mode` is known
 *   async setMode(mode)      mode in MODES; resolves with the confirmed mode
 *   get mode                 last confirmed mode ('off' | 'nc' | 'ambient' |
 *                            vendor-specific such as 'wind'), or null
 *   get state                driver-specific details (levels, battery, ...), or null
 *   get closed
 *   close()
 *   signals: mode-changed(mode: string)   confirmed state, including changes made
 *                                          with the buttons on the headset
 *            closed()
 *
 * The base class owns the read loop, serialized writes and a "wait for the next
 * message matching X" registry. Subclasses implement _onData(bytes) to frame the
 * stream and call _dispatch(key, payload) for every decoded message, and use
 * _setState() when the headset reports its state.
 */
export const StreamSession = GObject.registerClass({
    GTypeFlags: GObject.TypeFlags.ABSTRACT,
    Signals: {
        'mode-changed': {param_types: [GObject.TYPE_STRING]},
        'closed': {},
    },
}, class StreamSession extends GObject.Object {
    constructor(inputStream, outputStream, {log = null} = {}) {
        super();
        this._in = inputStream;
        this._out = outputStream;
        this._log = log ?? (() => {});
        this._cancellable = new Gio.Cancellable();
        this._closed = false;
        this._waiters = [];                   // {matchers, resolve, reject, timeoutId}
        this._writeChain = Promise.resolve(); // serialize stream writes
        this.state = null;
        this._readLoop().catch(e => {
            if (!this._cancellable.is_cancelled())
                this._log(`read loop error: ${e.message}`);
            this.close();
        });
    }

    get closed() {
        return this._closed;
    }

    get mode() {
        return this.state?.mode ?? null;
    }

    // ---- to be implemented by drivers ------------------------------------

    /* eslint-disable no-unused-vars */
    async open() {
        throw new Error(`${this.constructor.name}.open() not implemented`);
    }

    async setMode(mode, opts = {}) {
        throw new Error(`${this.constructor.name}.setMode() not implemented`);
    }

    _onData(data) {
        throw new Error(`${this.constructor.name}._onData() not implemented`);
    }
    /* eslint-enable no-unused-vars */

    // ---- transport -------------------------------------------------------

    async _readLoop() {
        for (;;) {
            const bytes = await this._in.read_bytes_async(512, GLib.PRIORITY_DEFAULT, this._cancellable);
            const data = bytes.toArray();
            if (data.length === 0)
                throw new Error('EOF');
            this._onData(data);
        }
    }

    _write(bytes) {
        this._log(`-> ${hex(bytes)}`);
        const p = this._writeChain.then(() =>
            this._out.write_all_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable));
        this._writeChain = p.catch(() => {});
        return p;
    }

    // ---- state -----------------------------------------------------------

    /** Record a state reported by the headset and tell listeners. */
    _setState(state) {
        this.state = state;
        this.emit('mode-changed', state.mode);
    }

    // ---- request/reply matching -----------------------------------------

    /**
     * Resolve with {key, payload} on the first _dispatch(key, payload) where
     * `matchers` has an entry for `key` (a null predicate accepts any payload).
     * Call it *before* sending the request so a fast reply is not missed.
     */
    _waitAny(matchers, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (this._closed) {
                reject(new Error('session closed'));
                return;
            }
            const w = {matchers, resolve, reject, timeoutId: 0};
            w.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                w.timeoutId = 0;
                const i = this._waiters.indexOf(w);
                if (i >= 0)
                    this._waiters.splice(i, 1);
                const keys = Object.keys(matchers).map(k => `0x${Number(k).toString(16)}`).join('/');
                reject(new Error(`no reply ${keys}`));
                return GLib.SOURCE_REMOVE;
            });
            this._waiters.push(w);
        });
    }

    /** Shorthand for a single key; resolves with the payload. */
    async _waitFor(key, timeoutMs, pred = null) {
        const {payload} = await this._waitAny({[key]: pred}, timeoutMs);
        return payload;
    }

    /** Hand a decoded message to the oldest waiter interested in it. */
    _dispatch(key, payload) {
        const i = this._waiters.findIndex(w => {
            const pred = w.matchers[key];
            return pred !== undefined && (pred === null || pred(payload));
        });
        if (i < 0)
            return false;
        const [w] = this._waiters.splice(i, 1);
        GLib.Source.remove(w.timeoutId);
        w.resolve({key, payload});
        return true;
    }

    // ---- teardown --------------------------------------------------------

    close() {
        if (this._closed)
            return;
        this._closed = true;
        this._cancellable.cancel();
        const waiters = this._waiters;
        this._waiters = [];
        for (const w of waiters) {
            if (w.timeoutId)
                GLib.Source.remove(w.timeoutId);
            w.reject(new Error('session closed'));
        }
        this._onClose();
        try {
            this._out.close(null);
        } catch (e) { /* ignore */ }
        try {
            this._in.close(null);
        } catch (e) { /* ignore */ }
        this.emit('closed');
    }

    /** Hook for drivers with extra pending work to fail on close. */
    _onClose() {
    }
});
