// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Sergei Nizovtsev <snizovtsev@gmail.com>
//
// bluez.js - find a connected Sony headset via BlueZ, open its RFCOMM control
// service through the org.bluez.Profile1 API (BlueZ resolves the channel from the
// service UUID and hands us a socket fd), and keep a SonySession alive on it.
//
// Shell-independent: usable from plain gjs (see test-backend.js).

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

import {SonySession, SONY_UUID_V1, SONY_UUID_V2} from './sony.js';

const BLUEZ = 'org.bluez';
const DEVICE_IFACE = 'org.bluez.Device1';
const PROFILE_XML = `
<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg type="o" name="device" direction="in"/>
      <arg type="h" name="fd" direction="in"/>
      <arg type="a{sv}" name="fd_properties" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg type="o" name="device" direction="in"/>
    </method>
  </interface>
</node>`;

const CONNECT_DELAY_MS = 1000;      // let A2DP/HFP settle before ConnectProfile
const CONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = [3000, 10000, 30000];

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.DBusObjectManagerClient, 'new', 'new_finish');

/**
 * Xm5Backend - the only object the UI talks to.
 *
 * Properties (read-only): connected, name, mode, level, focusOnVoice
 * Signals:
 *   state-changed(connected: bool)      headset control link up / down
 *   mode-changed(mode, level, voice)    confirmed state from the headset
 */
export const Xm5Backend = GObject.registerClass({
    Signals: {
        'state-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'mode-changed': {param_types: [GObject.TYPE_STRING, GObject.TYPE_INT, GObject.TYPE_BOOLEAN]},
    },
}, class Xm5Backend extends GObject.Object {
    constructor({log = null, verbose = false} = {}) {
        super();
        this._logFn = log ?? ((msg) => console.log(`[xm5] ${msg}`));
        this._verbose = verbose;
        this._cancellable = new Gio.Cancellable();
        this._profilePath = `/org/xm5mode/profile${GLib.get_monotonic_time() % 100000}`;
        this._exported = null;
        this._registered = false;
        this._manager = null;
        this._device = null;      // Gio.DBusProxy of the tracked Device1
        this._deviceUuid = null;  // Sony service UUID used for ConnectProfile
        this._session = null;
        this._fdWaiter = null;    // {resolve, reject} while ConnectProfile is in flight
        this._timeoutId = 0;
        this._reconnectAttempt = 0;
        this._destroyed = false;
        this._connectGeneration = 0;
    }

    _log(msg) {
        this._logFn(msg);
    }

    _debug(msg) {
        if (this._verbose)
            this._logFn(msg);
    }

    // ---- public state ----------------------------------------------------

    get connected() {
        return !!this._session && !this._session.closed && !!this._session.state;
    }

    get name() {
        return this._device?.get_cached_property('Alias')?.deepUnpack()
            ?? this._device?.get_cached_property('Name')?.deepUnpack() ?? null;
    }

    get mode() {
        return this._session?.state?.mode ?? null;
    }

    get level() {
        return this._session?.state?.level ?? null;
    }

    get focusOnVoice() {
        return this._session?.state?.focusOnVoice ?? null;
    }

    async setMode(mode, opts = {}) {
        if (!this.connected)
            throw new Error('headset not connected');
        return this._session.setMode(mode, opts);
    }

    // ---- lifecycle -------------------------------------------------------

    async start() {
        this._exportProfile();
        this._manager = await Gio.DBusObjectManagerClient.new(
            Gio.DBus.system, Gio.DBusObjectManagerClientFlags.NONE,
            BLUEZ, '/', null, this._cancellable);
        if (this._destroyed)
            return;
        this._manager.connect('interface-added', (m, obj, iface) => this._onInterfaceAdded(iface));
        this._manager.connect('interface-removed', (m, obj, iface) => this._onInterfaceRemoved(iface));
        this._manager.connect('interface-proxy-properties-changed',
            (m, obj, iface, changed) => this._onPropertiesChanged(iface, changed));
        this._manager.connect('object-removed', (m, obj) => {
            for (const iface of obj.get_interfaces())
                this._onInterfaceRemoved(iface);
        });
        this._scan();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._cancellable.cancel();
        this._clearTimeout();
        this._teardownSession();
        if (this._device && this._deviceUuid)
            this._callDevice(this._device, 'DisconnectProfile', new GLib.Variant('(s)', [this._deviceUuid]))
                .catch(() => {});
        this._device = null;
        if (this._registered) {
            Gio.DBus.system.call(BLUEZ, '/org/bluez', 'org.bluez.ProfileManager1', 'UnregisterProfile',
                new GLib.Variant('(o)', [this._profilePath]), null, Gio.DBusCallFlags.NONE, -1, null)
                .catch(e => this._debug(`UnregisterProfile: ${e.message}`));
            this._registered = false;
        }
        if (this._exported) {
            this._exported.unexport();
            this._exported = null;
        }
        this._manager = null;
    }

    // ---- Profile1 --------------------------------------------------------

    _exportProfile() {
        this._exported = Gio.DBusExportedObject.wrapJSObject(PROFILE_XML, this);
        this._exported.export(Gio.DBus.system, this._profilePath);
    }

    async _ensureRegistered(uuid) {
        if (this._registered)
            return;
        await Gio.DBus.system.call(BLUEZ, '/org/bluez', 'org.bluez.ProfileManager1', 'RegisterProfile',
            new GLib.Variant('(osa{sv})', [this._profilePath, uuid, {
                Role: new GLib.Variant('s', 'client'),
                AutoConnect: new GLib.Variant('b', false),
                Name: new GLib.Variant('s', 'xm5-mode'),
            }]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable);
        this._registered = true;
    }

    // Profile1 method handlers (called by Gio.DBusExportedObject)
    Release() {
        this._debug('Profile1.Release');
    }

    RequestDisconnection(devicePath) {
        this._debug(`Profile1.RequestDisconnection ${devicePath}`);
        this._teardownSession();
    }

    NewConnectionAsync(params, invocation) {
        const args = Array.isArray(params) ? params : params.deepUnpack();
        const [devicePath, fdIndex] = args;
        let fd = -1;
        try {
            fd = invocation.get_message().get_unix_fd_list().get(fdIndex);
        } catch (e) {
            invocation.return_dbus_error('org.bluez.Error.Rejected', `no fd: ${e.message}`);
            return;
        }
        this._debug(`Profile1.NewConnection ${devicePath} fd=${fd}`);
        if (this._fdWaiter) {
            const w = this._fdWaiter;
            this._fdWaiter = null;
            w.resolve(fd);
            invocation.return_value(null);
        } else {
            GLib.close(fd);
            invocation.return_dbus_error('org.bluez.Error.Rejected', 'unexpected connection');
        }
    }

    // ---- device tracking -------------------------------------------------

    _sonyUuid(iface) {
        const uuids = iface.get_cached_property('UUIDs')?.deepUnpack() ?? [];
        const lower = uuids.map(u => u.toLowerCase());
        if (lower.includes(SONY_UUID_V2))
            return SONY_UUID_V2;
        if (lower.includes(SONY_UUID_V1))
            return SONY_UUID_V1;
        return null;
    }

    _isConnected(iface) {
        return !!iface.get_cached_property('Connected')?.deepUnpack();
    }

    _scan() {
        for (const obj of this._manager.get_objects()) {
            const iface = obj.get_interface(DEVICE_IFACE);
            if (iface && this._sonyUuid(iface) && this._isConnected(iface)) {
                this._adoptDevice(iface);
                return;
            }
        }
    }

    _onInterfaceAdded(iface) {
        if (iface.get_interface_name() !== DEVICE_IFACE || this._device)
            return;
        if (this._sonyUuid(iface) && this._isConnected(iface))
            this._adoptDevice(iface);
    }

    _onInterfaceRemoved(iface) {
        if (this._device && iface.get_object_path() === this._device.get_object_path())
            this._dropDevice();
    }

    _onPropertiesChanged(iface, changed) {
        if (iface.get_interface_name() !== DEVICE_IFACE)
            return;
        const props = changed.deepUnpack();
        if (!('Connected' in props))
            return;
        const connected = props.Connected.deepUnpack();
        if (this._device && iface.get_object_path() === this._device.get_object_path()) {
            if (!connected)
                this._dropDevice();
        } else if (!this._device && connected && this._sonyUuid(iface)) {
            this._adoptDevice(iface);
        }
    }

    _adoptDevice(iface) {
        this._device = iface;
        this._deviceUuid = this._sonyUuid(iface);
        this._reconnectAttempt = 0;
        this._log(`headset ${this.name} (${iface.get_object_path()}) connected, opening control link`);
        this._scheduleConnect(CONNECT_DELAY_MS);
    }

    _dropDevice() {
        this._log(`headset ${this.name} disconnected`);
        this._clearTimeout();
        this._connectGeneration++;
        this._teardownSession();
        this._device = null;
        this._deviceUuid = null;
        // maybe another Sony device is connected
        if (this._manager)
            this._scan();
    }

    // ---- control link ----------------------------------------------------

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _scheduleConnect(delayMs) {
        this._clearTimeout();
        const gen = ++this._connectGeneration;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._timeoutId = 0;
            this._connect(gen).catch(e => this._log(`connect failed: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _connect(gen) {
        const device = this._device;
        const uuid = this._deviceUuid;
        if (!device || this._destroyed)
            return;
        await this._ensureRegistered(uuid);
        let lastErr = null;
        for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
            if (gen !== this._connectGeneration || this._destroyed)
                return;
            try {
                const fd = await this._connectProfile(device, uuid);
                if (gen !== this._connectGeneration || this._destroyed) {
                    GLib.close(fd);
                    return;
                }
                await this._openSession(fd, gen);
                return;
            } catch (e) {
                lastErr = e;
                this._debug(`ConnectProfile attempt ${attempt}: ${e.message}`);
                await this._sleep(1500);
            }
        }
        throw lastErr ?? new Error('ConnectProfile failed');
    }

    _connectProfile(device, uuid) {
        return new Promise((resolve, reject) => {
            this._fdWaiter = {resolve, reject};
            this._callDevice(device, 'ConnectProfile', new GLib.Variant('(s)', [uuid]))
                .then(() => {
                    // BlueZ calls NewConnection before replying; if it did not, fail.
                    if (this._fdWaiter) {
                        this._fdWaiter = null;
                        reject(new Error('ConnectProfile returned without NewConnection'));
                    }
                })
                .catch(e => {
                    if (this._fdWaiter) {
                        this._fdWaiter = null;
                        reject(e);
                    }
                });
        });
    }

    async _openSession(fd, gen) {
        const input = new GioUnix.InputStream({fd, close_fd: true});
        const output = new GioUnix.OutputStream({fd, close_fd: false});
        const session = new SonySession(input, output, {log: msg => this._debug(msg)});
        this._session = session;
        session.connect('mode-changed', (s, mode, level, voice) => {
            if (s === this._session)
                this.emit('mode-changed', mode, level, voice);
        });
        session.connect('closed', s => {
            if (s !== this._session)
                return;
            this._session = null;
            this.emit('state-changed', false);
            if (this._device && !this._destroyed) {
                const delay = RECONNECT_BACKOFF_MS[Math.min(this._reconnectAttempt++, RECONNECT_BACKOFF_MS.length - 1)];
                this._log(`control link closed, reconnecting in ${delay / 1000}s`);
                this._scheduleConnect(delay);
            }
        });
        try {
            await session.init();
            await session.getState();
        } catch (e) {
            session.close();
            throw e;
        }
        if (gen !== this._connectGeneration) {
            session.close();
            return;
        }
        this._reconnectAttempt = 0;
        this._log(`control link up: ${this.name} mode=${this.mode}`);
        this.emit('state-changed', true);
    }

    _teardownSession() {
        if (this._fdWaiter) {
            const w = this._fdWaiter;
            this._fdWaiter = null;
            w.reject(new Error('cancelled'));
        }
        const s = this._session;
        if (s) {
            this._session = null;
            s.close();
            this.emit('state-changed', false);
        }
    }

    _callDevice(device, method, args) {
        return Gio.DBus.system.call(BLUEZ, device.get_object_path(), DEVICE_IFACE, method,
            args, null, Gio.DBusCallFlags.NONE, 15000, null);
    }

    _sleep(ms) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
});
