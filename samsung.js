// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Sergei Nizovtsev <snizovtsev@gmail.com>
//
// samsung.js - Samsung Galaxy Buds SPP protocol (Buds FE; Buds Pro / 2 / 2 Pro
// use the same service and messages but are untested here).
// Port of scripts/buds.py; the protocol was documented by GalaxyBudsClient.
//
// frame    = 0xFD  hdr[2, LE]  id  payload  crc16[2, LE]  0xDD
// hdr      = size | flags;  size = len(payload) + 3 (id + crc),
//            0x1000 set on device -> host messages (response), 0x2000 = fragment
// crc16    = CRC-16/XMODEM (poly 0x1021, init 0) over id + payload
// on connect the buds push EXTENDED_STATUS_UPDATED (0x61):
//     payload[0] revision, [2] battery L, [3] battery R,
//     [12] noise-control mode (0 off, 1 anc, 2 ambient, 3 adaptive),
//     [23] ambient volume, [24] anc level (0 low, 1 high)
// NOISE_CONTROLS (0x78) <mode>              set mode
// a SET that changes something is answered by ACK (0x42) <id> <value>; a no-op
// SET gets a fresh EXTENDED_STATUS_UPDATED + NOISE_CONTROLS_UPDATE instead
// NOISE_CONTROLS_UPDATE (0x77) <mode> [..]   pushed when changed on the buds
// AMBIENT_VOLUME (0x84) <0..2>               ambient volume
// NOISE_REDUCTION_LEVEL (0x83) <0|1>         anc level low / high

import GObject from 'gi://GObject';

import {StreamSession, MODES, hex} from './session.js';

// GalaxyBudsClient Uuids.SppNew: Buds Pro / 2 / 2 Pro / FE / 3 control service
export const BUDS_UUID_NEW = '2e73a4ad-332d-41fc-90e2-16bef06523f2';
// original Galaxy Buds (2019) and Buds+ / Live; this is the generic SIG "LAP"
// UUID, so it is only trusted together with the device name
export const BUDS_UUID_LEGACY = '00001102-0000-1000-8000-00805f9b34fd';

const SOM = 0xFD, EOM = 0xDD;
const HDR_RESPONSE = 0x1000, HDR_FRAGMENT = 0x2000, HDR_SIZE = 0x03FF;
const MAX_FRAME = 1 + 2 + HDR_SIZE + 1;

export const Msg = {
    ACK: 0x42,                      // <acked id> <value>
    STATUS_UPDATED: 0x60,
    EXTENDED_STATUS_UPDATED: 0x61,
    NOISE_CONTROLS_UPDATE: 0x77,
    NOISE_CONTROLS: 0x78,
    NOISE_REDUCTION_LEVEL: 0x83,
    AMBIENT_VOLUME: 0x84,
};

const MODE_CODE = {off: 0, nc: 1, ambient: 2, adaptive: 3};
const CODE_MODE = Object.fromEntries(Object.entries(MODE_CODE).map(([m, c]) => [c, m]));

const REPLY_TIMEOUT_MS = 3000;
const STATUS_TIMEOUT_MS = 4000;

/** CRC-16/XMODEM: poly 0x1021, init 0, no reflection, no final xor. */
export function crc16(bytes) {
    let crc = 0;
    for (const b of bytes) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++)
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
}

export function encode(id, payload = [], response = false) {
    const body = [id, ...payload];
    const hdr = (body.length + 2) | (response ? HDR_RESPONSE : 0);
    const crc = crc16(body);
    return new Uint8Array([SOM, hdr & 0xFF, hdr >> 8, ...body, crc & 0xFF, crc >> 8, EOM]);
}

/**
 * Pop complete frames off the front of `buf` (a plain array of bytes, modified
 * in place). Returns [{id, payload: Uint8Array, response, fragment}, ...].
 * Junk and frames with a bad CRC/EOM are skipped byte by byte until the next SOM.
 */
export function extractFrames(buf, log = () => {}) {
    const frames = [];
    for (;;) {
        const start = buf.indexOf(SOM);
        if (start < 0) {
            buf.length = 0;
            return frames;
        }
        if (start > 0) {
            log(`skipping ${start} junk bytes: ${hex(buf.slice(0, start))}`);
            buf.splice(0, start);
        }
        if (buf.length < 3)
            return frames;
        const hdr = buf[1] | (buf[2] << 8);
        const size = hdr & HDR_SIZE;
        const total = 1 + 2 + size + 1;
        if (size >= 3 && buf.length < total)
            return frames;
        const body = buf.slice(3, 3 + size - 2);
        const crc = buf[3 + size - 2] | (buf[3 + size - 1] << 8);
        if (size < 3 || buf[total - 1] !== EOM || crc16(body) !== crc) {
            log(`bad frame: ${hex(buf.slice(0, Math.min(total, MAX_FRAME)))}`);
            buf.splice(0, 1);   // resync on the next SOM
            continue;
        }
        buf.splice(0, total);
        frames.push({
            id: body[0],
            payload: Uint8Array.from(body.slice(1)),
            response: !!(hdr & HDR_RESPONSE),
            fragment: !!(hdr & HDR_FRAGMENT),
        });
    }
}

/** Parse EXTENDED_STATUS_UPDATED; null if the payload is too short. */
export function parseExtendedStatus(pl) {
    if (pl.length < 25)
        return null;
    return {
        mode: CODE_MODE[pl[12]] ?? 'unknown',
        ambientLevel: pl[23],
        ancLevel: pl[24] ? 'high' : 'low',
        batteryLeft: pl[2],
        batteryRight: pl[3],
        revision: pl[0],
        raw: Uint8Array.from(pl),
    };
}

/**
 * Galaxy Buds session.
 *
 * state = {mode, ambientLevel (0..2), ancLevel ('low'|'high'), batteryLeft,
 *          batteryRight, revision, raw}
 * Message ids are the _waitAny/_dispatch keys.
 */
export const BudsSession = GObject.registerClass(
class BudsSession extends StreamSession {
    constructor(inputStream, outputStream, opts = {}) {
        super(inputStream, outputStream, opts);
        this._buf = [];
    }

    // ---- framing -------------------------------------------------------

    _onData(data) {
        this._buf.push(...data);
        for (const frame of extractFrames(this._buf, this._log))
            this._handle(frame);
    }

    _handle({id, payload, response}) {
        this._log(`<- id=${id.toString(16)} ${response ? 'rsp' : 'req'} payload=${hex(payload)}`);
        switch (id) {
        case Msg.EXTENDED_STATUS_UPDATED: {
            const st = parseExtendedStatus(payload);
            if (st)
                this._setState(st);
            else
                this._log(`extended status too short (${payload.length} bytes)`);
            break;
        }
        case Msg.NOISE_CONTROLS_UPDATE:
            if (payload.length >= 1)
                this._updateMode(payload[0]);
            break;
        case Msg.ACK:
            if (payload.length >= 2)
                this._applyAck(payload[0], payload[1]);
            break;
        default:
            break;
        }
        this._dispatch(id, payload);
    }

    _updateMode(code) {
        this._setState({...this.state ?? {}, mode: CODE_MODE[code] ?? 'unknown'});
    }

    _applyAck(id, value) {
        if (!this.state)
            return;
        switch (id) {
        case Msg.NOISE_CONTROLS:
            this._updateMode(value);
            break;
        case Msg.AMBIENT_VOLUME:
            this.state.ambientLevel = value;
            break;
        case Msg.NOISE_REDUCTION_LEVEL:
            this.state.ancLevel = value ? 'high' : 'low';
            break;
        default:
            break;
        }
    }

    // ---- requests ------------------------------------------------------

    _send(id, payload = []) {
        return this._write(encode(id, payload));
    }

    /** One-byte SET acknowledged by ACK <id> <value>; resolves with the acked value. */
    async _set(id, value) {
        const ack = this._waitFor(Msg.ACK, REPLY_TIMEOUT_MS, pl => pl.length >= 1 && pl[0] === id);
        ack.catch(() => {});
        await this._send(id, [value & 0xFF]);
        const pl = await ack;
        return pl.length > 1 ? pl[1] : value;
    }

    // ---- high level ----------------------------------------------------

    /** The buds push EXTENDED_STATUS_UPDATED right after the SPP link comes up. */
    async open() {
        if (this.state?.raw)
            return;
        await this._waitFor(Msg.EXTENDED_STATUS_UPDATED, STATUS_TIMEOUT_MS);
        if (!this.state?.raw)
            throw new Error('unusable extended status from the buds');
    }

    /**
     * Set the mode ('off' | 'nc' | 'ambient'). A real change is ACKed; re-selecting
     * the current mode is answered with a fresh status + NOISE_CONTROLS_UPDATE
     * instead, so either counts as confirmation. Resolves with the confirmed mode.
     */
    async setMode(mode) {
        if (!MODES.includes(mode))
            throw new Error(`unknown mode ${mode}`);
        const reply = this._waitAny({
            [Msg.ACK]: pl => pl.length >= 2 && pl[0] === Msg.NOISE_CONTROLS,
            [Msg.NOISE_CONTROLS_UPDATE]: pl => pl.length >= 1,
        }, REPLY_TIMEOUT_MS);
        reply.catch(() => {});
        await this._send(Msg.NOISE_CONTROLS, [MODE_CODE[mode]]);
        const {key, payload} = await reply;
        const code = Number(key) === Msg.ACK ? payload[1] : payload[0];
        return CODE_MODE[code] ?? 'unknown';
    }

    /** Ambient sound volume 0..2. */
    setAmbientLevel(level) {
        return this._set(Msg.AMBIENT_VOLUME, Math.max(0, Math.min(2, level | 0)));
    }

    /** ANC strength; the Buds FE firmware accepts it although Samsung's app hides it. */
    async setAncLevel(high) {
        return await this._set(Msg.NOISE_REDUCTION_LEVEL, high ? 1 : 0) ? 'high' : 'low';
    }
});

/** Driver descriptor consumed by devices.js. */
export const SAMSUNG_DRIVER = {
    id: 'samsung',
    Session: BudsSession,
    match({name, uuids}) {
        if (uuids.includes(BUDS_UUID_NEW))
            return BUDS_UUID_NEW;
        if (uuids.includes(BUDS_UUID_LEGACY) && /galaxy buds/i.test(name ?? ''))
            return BUDS_UUID_LEGACY;
        return null;
    },
};
