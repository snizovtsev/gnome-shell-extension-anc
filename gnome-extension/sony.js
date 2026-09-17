// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Sergei Nizovtsev <snizovtsev@gmail.com>
//
// sony.js - Sony headphones RFCOMM protocol ("v2" variant, WH-1000XM5).
// Port of xm5.py. Shell-independent: only GLib/GObject/Gio, usable from plain gjs.
//
// frame     = 0x3E  escape(type seq len[4,BE] payload checksum)  0x3C
// escape    = 0x3E/0x3C/0x3D -> 0x3D, (b & 0xEF)
// checksum  = sum(type..payload) & 0xFF
// types     = ACK 0x01, COMMAND_1 0x0C, COMMAND_2 0x0E
// every COMMAND is answered with an ACK carrying (1 - seq); our own seq is
// adopted from the ACK we receive.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

export const SONY_UUID_V1 = '96cc203e-5068-46ad-b32d-e316f5e069ba';
export const SONY_UUID_V2 = '956c7b26-d49a-4ba8-b03f-b17d393cb6e2';

const HDR = 0x3E, TRL = 0x3C, ESC = 0x3D, ESC_MASK = 0xEF;

export const MessageType = {ACK: 0x01, CMD1: 0x0C, CMD2: 0x0E};

export const Payload = {
    INIT_REQ: 0x00, INIT_REP: 0x01,
    ASC_GET: 0x66, ASC_RET: 0x67, ASC_SET: 0x68, ASC_NOTIFY: 0x69,
};

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

function escape(bytes) {
    const out = [];
    for (const b of bytes) {
        if (b === HDR || b === TRL || b === ESC)
            out.push(ESC, b & ESC_MASK);
        else
            out.push(b);
    }
    return out;
}

function unescape(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === ESC) {
            if (++i >= bytes.length)
                throw new Error('escape at end of frame');
            out.push((bytes[i] | ~ESC_MASK) & 0xFF);
        } else {
            out.push(bytes[i]);
        }
    }
    return out;
}

export function encode(type, seq, payload = []) {
    const len = payload.length;
    const body = [type, seq & 0xFF,
        (len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF,
        ...payload];
    const chk = body.reduce((a, b) => a + b, 0) & 0xFF;
    return new Uint8Array([HDR, ...escape([...body, chk]), TRL]);
}

/** @param frame bytes strictly between HDR and TRL; returns {type, seq, payload: Uint8Array} */
export function decode(frame) {
    const body = unescape(frame);
    if (body.length < 7)
        throw new Error(`short frame ${hex(body)}`);
    const chk = body.slice(0, -1).reduce((a, b) => a + b, 0) & 0xFF;
    if (chk !== body[body.length - 1])
        throw new Error(`bad checksum in ${hex(body)}`);
    const [type, seq] = body;
    const len = ((body[2] << 24) | (body[3] << 16) | (body[4] << 8) | body[5]) >>> 0;
    const payload = new Uint8Array(body.slice(6, -1));
    if (payload.length !== len)
        throw new Error(`length mismatch in ${hex(body)}`);
    return {type, seq, payload};
}

/** Parse an AMBIENT_SOUND_CONTROL RET/NOTIFY payload (7 or 8 bytes). */
export function parseAsc(pl) {
    if (pl.length < 7 || (pl[1] !== 0x15 && pl[1] !== 0x17))
        return null;
    const hasWind = pl[1] === 0x17 && pl.length > 7;
    const on = pl[3], amb = pl[4];
    const wind = hasWind ? pl[5] : null;
    const vi = hasWind ? 6 : 5;
    let mode;
    if (on === 0)
        mode = 'off';
    else if (hasWind && (wind === 0x03 || wind === 0x05))
        mode = 'wind';
    else
        mode = amb === 1 ? 'ambient' : 'nc';
    return {
        mode,
        focusOnVoice: pl[vi] !== 0,
        level: pl[vi + 1],
        hasWind,
        raw: Uint8Array.from(pl),
    };
}

const ACK_TIMEOUT_MS = 3000;

/**
 * One RFCOMM session with the headset. Owns the read loop, ACK/sequence
 * bookkeeping and the ambient-sound-control state.
 *
 * Signals:
 *   mode-changed(mode: string, level: int, focusOnVoice: bool)
 *   closed()
 */
export const SonySession = GObject.registerClass({
    Signals: {
        'mode-changed': {param_types: [GObject.TYPE_STRING, GObject.TYPE_INT, GObject.TYPE_BOOLEAN]},
        'closed': {},
    },
}, class SonySession extends GObject.Object {
    constructor(inputStream, outputStream, {log = null} = {}) {
        super();
        this._in = inputStream;
        this._out = outputStream;
        this._log = log ?? (() => {});
        this._cancellable = new Gio.Cancellable();
        this._seq = 0;
        this._buf = [];
        this._closed = false;
        this._pendingAck = null;           // {resolve, reject, timeoutId}
        this._waiters = new Map();         // payload type -> [{resolve, reject, timeoutId}]
        this._cmdChain = Promise.resolve(); // serialize commands (one in flight)
        this._writeChain = Promise.resolve(); // serialize stream writes
        this.state = null;                 // last parseAsc() result
        this._readLoop().catch(e => {
            if (!this._cancellable.is_cancelled())
                this._log(`read loop error: ${e.message}`);
            this.close();
        });
    }

    get closed() {
        return this._closed;
    }

    // ---- transport -----------------------------------------------------

    async _readLoop() {
        for (;;) {
            const bytes = await this._in.read_bytes_async(512, GLib.PRIORITY_DEFAULT, this._cancellable);
            const data = bytes.toArray();
            if (data.length === 0)
                throw new Error('EOF');
            for (const b of data) {
                if (b === HDR) {
                    this._buf = [];
                } else if (b === TRL) {
                    let frame = null;
                    try {
                        frame = decode(this._buf);
                    } catch (e) {
                        this._log(`bad frame: ${e.message}`);
                    }
                    this._buf = [];
                    if (frame)
                        this._handle(frame);
                } else {
                    this._buf.push(b);
                }
            }
        }
    }

    _write(bytes) {
        this._log(`-> ${hex(bytes)}`);
        const p = this._writeChain.then(() =>
            this._out.write_all_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable));
        this._writeChain = p.catch(() => {});
        return p;
    }

    _handle({type, seq, payload}) {
        this._log(`<- type=${type.toString(16)} seq=${seq} payload=${hex(payload)}`);
        if (type === MessageType.ACK) {
            this._seq = seq;
            const p = this._pendingAck;
            if (p) {
                this._pendingAck = null;
                GLib.Source.remove(p.timeoutId);
                p.resolve();
            }
            return;
        }
        if (type !== MessageType.CMD1 && type !== MessageType.CMD2)
            return;
        this._write(encode(MessageType.ACK, 1 - seq)).catch(() => {});
        if (payload.length === 0)
            return;

        const ptype = payload[0];
        if (type === MessageType.CMD1 && (ptype === Payload.ASC_RET || ptype === Payload.ASC_NOTIFY)) {
            const st = parseAsc(payload);
            if (st) {
                this.state = st;
                this.emit('mode-changed', st.mode, st.level, st.focusOnVoice);
            }
        }
        const ws = this._waiters.get(ptype);
        if (ws && ws.length) {
            const w = ws.shift();
            GLib.Source.remove(w.timeoutId);
            w.resolve(payload);
        }
    }

    /** Register interest in the next COMMAND_1 message with payload[0] === ptype. */
    _waitFor(ptype, timeoutMs) {
        return new Promise((resolve, reject) => {
            const w = {resolve, reject, timeoutId: 0};
            w.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                const ws = this._waiters.get(ptype) ?? [];
                const i = ws.indexOf(w);
                if (i >= 0)
                    ws.splice(i, 1);
                reject(new Error(`no reply 0x${ptype.toString(16)}`));
                return GLib.SOURCE_REMOVE;
            });
            if (!this._waiters.has(ptype))
                this._waiters.set(ptype, []);
            this._waiters.get(ptype).push(w);
        });
    }

    /** Send a COMMAND and resolve when the headset ACKs it. Commands are serialized. */
    command(payload, type = MessageType.CMD1) {
        const run = () => new Promise((resolve, reject) => {
            if (this._closed) {
                reject(new Error('session closed'));
                return;
            }
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ACK_TIMEOUT_MS, () => {
                if (this._pendingAck?.timeoutId === timeoutId) {
                    this._pendingAck = null;
                    reject(new Error(`no ACK for ${hex(payload)}`));
                }
                return GLib.SOURCE_REMOVE;
            });
            this._pendingAck = {resolve, reject, timeoutId};
            this._write(encode(type, this._seq, payload)).catch(e => {
                GLib.Source.remove(timeoutId);
                this._pendingAck = null;
                reject(e);
            });
        });
        const p = this._cmdChain.then(run, run);
        this._cmdChain = p.catch(() => {});
        return p;
    }

    // ---- high level ----------------------------------------------------

    async init() {
        const reply = this._waitFor(Payload.INIT_REP, ACK_TIMEOUT_MS);
        await this.command([Payload.INIT_REQ, 0x00]);
        const pl = await reply;
        this._log(`init reply: ${hex(pl)}`);
        return pl;
    }

    /** Query ambient sound control; resolves with parseAsc() result (also emits mode-changed). */
    async getState() {
        for (const sub of [0x17, 0x15]) {
            const reply = this._waitFor(Payload.ASC_RET, 2000);
            await this.command([Payload.ASC_GET, sub]);
            try {
                const pl = await reply;
                const st = parseAsc(pl);
                if (st)
                    return st;
            } catch (e) {
                this._log(`GET sub=0x${sub.toString(16)}: ${e.message}`);
            }
        }
        throw new Error('headphones did not answer ambient sound control GET');
    }

    /**
     * Set the mode ('off' | 'nc' | 'ambient'); optional {level: 1..20, voice: bool}.
     * Resolves with the confirmed state (from NOTIFY, or a fresh GET).
     */
    async setMode(mode, {level = null, voice = null} = {}) {
        if (!MODES.includes(mode))
            throw new Error(`unknown mode ${mode}`);
        const cur = this.state ?? await this.getState();
        const pl = Array.from(cur.raw);
        pl[0] = Payload.ASC_SET;
        pl[2] = 0x01;
        pl[3] = mode === 'off' ? 0x00 : 0x01;
        pl[4] = mode === 'ambient' ? 0x01 : 0x00;
        let vi = 5;
        if (cur.hasWind) {
            pl[5] = 0x02; // no wind-noise reduction, 8-byte form
            vi = 6;
        }
        if (voice !== null)
            pl[vi] = voice ? 0x01 : 0x00;
        if (level !== null)
            pl[vi + 1] = Math.max(1, Math.min(20, level | 0));

        const notify = this._waitFor(Payload.ASC_NOTIFY, 1500);
        await this.command(pl);
        try {
            return parseAsc(await notify);
        } catch (e) {
            return this.getState();
        }
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        this._cancellable.cancel();
        if (this._pendingAck) {
            GLib.Source.remove(this._pendingAck.timeoutId);
            this._pendingAck.reject(new Error('session closed'));
            this._pendingAck = null;
        }
        for (const ws of this._waiters.values()) {
            for (const w of ws) {
                GLib.Source.remove(w.timeoutId);
                w.reject(new Error('session closed'));
            }
        }
        this._waiters.clear();
        try {
            this._out.close(null);
        } catch (e) { /* ignore */ }
        try {
            this._in.close(null);
        } catch (e) { /* ignore */ }
        this.emit('closed');
    }
});
