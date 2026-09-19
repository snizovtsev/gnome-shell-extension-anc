// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Sergei Nizovtsev <snizovtsev@gmail.com>
//
// devices.js - the list of supported headsets. To add one: write a
// StreamSession subclass (see session.js for the contract), export a driver
// descriptor next to it, and append it here.
//
// A driver descriptor is a plain object:
//   id                       short tag for logs
//   match({name, uuids})     given a BlueZ Device1's Alias/Name and its service
//                            UUIDs (lower-case), return the UUID to open with
//                            ConnectProfile, or null if this is not our device
//   Session                  the StreamSession subclass speaking its protocol

import {SONY_DRIVER} from './sony.js';
import {SAMSUNG_DRIVER} from './samsung.js';

export const DRIVERS = [SONY_DRIVER, SAMSUNG_DRIVER];

/** @returns {{driver, uuid}|null} the first driver claiming the device */
export function findDriver(props) {
    for (const driver of DRIVERS) {
        const uuid = driver.match(props);
        if (uuid)
            return {driver, uuid};
    }
    return null;
}
