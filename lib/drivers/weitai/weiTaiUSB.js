/*
 * == BSD2 LICENSE ==
 * Copyright (c) 2021, Tidepool Project
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the associated License, which is identical to the BSD 2-Clause
 * License as published by the Open Source Initiative at opensource.org.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the License for more details.
 *
 * You should have received a copy of the License along with this program; if
 * not, you can obtain one from Tidepool Project at tidepool.org.
 * == BSD2 LICENSE ==
 */

import _ from 'lodash';
import sundial from 'sundial';

import crypto from 'crypto';
import TZOUtil from '../../TimezoneOffsetUtil';
import UsbDevice from '../../usbDevice';
import {
  cRC8,
  packFrame,
  unpackFrame,
  uintFromArrayBuffer,
  formatString,
  uint8ArrayToString
} from './utils';

const { promisify } = require('util');

const isBrowser = typeof window !== 'undefined';
const debug = isBrowser ? require('bows')('WeitaiUSBDriver') : console.log;

const usb = require('usb');

class WeitaiUSB {
  constructor(cfg) {
    this.cfg = cfg;
  }

  static get TIMEOUT() {
    return 5000;
  }

  async openDevice(deviceInfo, cb) {
    this.usbDevice = new UsbDevice(deviceInfo);
    try {
      this.usbDevice.device.open(false);
    } catch (err) {
      debug(err);
      return cb(err, null);
    }
    this.usbDevice.device.setConfiguration(1, async () => {
      if (this.usbDevice.device.interfaces == null) {
        return cb(new Error('Please unplug device and retry.'), null);
      }

      if (deviceInfo.vendorId == 6353 && deviceInfo.productId == 11521) {
        await this.open18d1(cb);
      } else {
        try {
          this.usbDevice.iface = this.usbDevice.device.interfaces[3];
          this.usbDevice.iface.claim();
          this.usbDevice.iface.endpoints[0].timeout = WeitaiUSB.TIMEOUT;
        } catch (e) {
          return cb(e, null);
        }

        try {
          const getStatus = {
            requestType: 'vendor',
            recipient: 'device',
            request: 0x33,
            value: 0x00,
            index: 0x00,
          };

          const incoming_control = await this.usbDevice.controlTransferIn(
            getStatus,
            2
          );

          if (incoming_control.toString('hex') != '0200') {
            return cb(new Error('Could not connect to the device'), null);
          }

          const getStatus1 = {
            requestType: 'vendor',
            recipient: 'device',
            request: 0x34,
            value: 0x00,
            index: 0x00,
          };
          var buff1 = new Buffer('MicrotechMD\0');
          await this.usbDevice.controlTransferOut(getStatus1, buff1);

          const getStatus2 = {
            requestType: 'vendor',
            recipient: 'device',
            request: 0x34,
            value: 0x00,
            index: 0x01,
          };
          var buff2 = new Buffer('Equil\0');
          await this.usbDevice.controlTransferOut(getStatus2, buff2);

          const getStatus3 = {
            requestType: 'vendor',
            recipient: 'device',
            request: 0x34,
            value: 0x00,
            index: 0x03,
          };
          var buff3 = new Buffer('1.0\0');
          await this.usbDevice.controlTransferOut(getStatus3, buff3);

          const getStatus4 = {
            requestType: 'vendor',
            recipient: 'device',
            request: 0x35,
            value: 0x00,
            index: 0x00,
          };

          await this.usbDevice.controlTransferOut(getStatus4, Buffer.alloc(0));
          this.usbDevice.device.close(false);
          setTimeout(() => {
            let newDevice = deviceInfo;
            newDevice.vendorId = 6353;
            newDevice.productId = 11521;
            this.openDevice(newDevice, cb);
          }, 3000);
        } catch (error) {
          if (error.message === 'LIBUSB_TRANSFER_TIMED_OUT') {
            error.code = 'E_UNPLUG_AND_RETRY';
          }
          return cb(error, null);
        }
      }
    });
  }

  async open18d1(cb) {
    debug('in Accessory Mode!');
    [this.usbDevice.iface] = this.usbDevice.device.interfaces;
    this.usbDevice.iface.claim();

    this.usbDevice.iface.endpoints[0].transferType =
      usb.LIBUSB_TRANSFER_TYPE_BULK;
    this.usbDevice.iface.endpoints[1].transferType =
      usb.LIBUSB_TRANSFER_TYPE_BULK;
    this.usbDevice.iface.endpoints[0].timeout = WeitaiUSB.TIMEOUT;
    this.usbDevice.iface.endpoints[1].timeout = WeitaiUSB.TIMEOUT;

    [this.inEndpoint, this.outEndpoint] = this.usbDevice.iface.endpoints;
    return cb(null);
  }

  static buildSettingPacket(payload, commandBody) {
    const md5 = crypto
      .createHash('md5')
      .update(payload)
      .digest();
    const data = Buffer.concat([payload, md5], payload.length + md5.length);

    commandBody.writeUInt32LE(data.length, 4); //Length

    const crc8 = cRC8(
      Buffer.concat(
        [commandBody.slice(0, 3), commandBody.slice(4)],
        commandBody.length - 1
      )
    );
    commandBody.writeUInt8(crc8, 3); //Checksum_CRC8

    const command = new Buffer(packFrame(commandBody));

    const packet = Buffer.concat([command, data], command.length + data.length);

    return packet;
  }

  static parseSettingPacket(packet, name, cb) {
    const command = WeitaiUSB.getCommand(packet);

    if (command.length < 12) {
      return cb(new Error('Command length check failed'), null);
    }
    const commandBody = new Buffer(unpackFrame(command));
    const crc8 = commandBody[3];
    const length = commandBody.readInt32LE(4);

    const crc8_c = cRC8(
      Buffer.concat(
        [commandBody.slice(0, 3), commandBody.slice(4)],
        commandBody.length - 1
      )
    );

    if (crc8 != crc8_c) {
      return cb(new Error('CRC-8 check failed'), null);
    }

    if (packet.length < command.length + length) {
      return cb(new Error('Packet length check failed'), null);
    }

    const data = packet.slice(command.length, command.length + length);

    const payload = data.slice(0, data.length - 16);
    const md5 = data.slice(data.length - 16, data.length);

    const md5_c = crypto
      .createHash('md5')
      .update(payload)
      .digest();

    if (!md5.equals(md5_c)) {
      return cb(new Error('MD5 check failed'), null);
    }
    let inComeRes = [];
    if (name == 'name') {
      inComeRes = WeitaiUSB.parseSettingAndNamePayload(payload, cb);
    }else if (name == 'PDASN') {
      inComeRes = WeitaiUSB.parseSnPayload(payload, cb);
    } else {
      inComeRes = WeitaiUSB.parseSettingPayload(payload, cb);
    }
    return inComeRes;
  }

  static parseSnPayload(payload, cb) {

    let inComeRes = [];
    if (payload.length == 0) {
      return cb({ code: 'E_READ_FILE' }, null);
    }
    const pdaSn = uint8ArrayToString(payload);
    debug('pdaSn',pdaSn);
    return pdaSn;
  }

  static parseSettingAndNamePayload(payload, cb) {
    let inComeRes = [];
    if (payload.length == 0) {
      return cb({ code: 'E_READ_FILE' }, null);
    }

    let slice = payload.slice(96);
    let sliceArray = [];
    let name = '';
    if (slice.length) {
      for (var b = 0; b < slice.byteLength; b++) {
        sliceArray[b] = slice[b];
      }
      var encoded = '';
      for (var i = 0; i < sliceArray.length; i++) {
        encoded += '%' + sliceArray[i].toString(16);
      }
      name = decodeURIComponent(encoded);
      debug('payload', decodeURIComponent(encoded));
    }

    for (let i = 0; i < 96; i += 2) {
      const history = payload.slice(i, i + 2);
      const lowerRes = uintFromArrayBuffer(history, true);
      inComeRes.push(lowerRes);
    }
    return { name, inComeRes };
  }

  static parseSettingPayload(payload, cb) {
    let inComeRes = [];
    if (payload.length == 0) {
      return cb(new Error('No data'), null);
    }

    for (let i = 0; i < payload.length; i += 2) {
      const history = payload.slice(i, i + 2);
      const lowerRes = uintFromArrayBuffer(history, true);
      inComeRes.push(lowerRes);
    }
    return { inComeRes };
  }

  static buildPacket(payload) {
    const md5 = crypto
      .createHash('md5')
      .update(payload)
      .digest();
    const data = Buffer.concat([payload, md5], payload.length + md5.length);

    const commandBody = Buffer.alloc(8);

    commandBody.writeUInt8(0x05, 0); //Port
    commandBody.writeUInt8(0x01, 1); //Parameter
    commandBody.writeUInt8(0x02, 2); //Operation
    commandBody.writeUInt32LE(data.length, 4); //Length

    const crc8 = cRC8(
      Buffer.concat(
        [commandBody.slice(0, 3), commandBody.slice(4)],
        commandBody.length - 1
      )
    );
    commandBody.writeUInt8(crc8, 3);

    const command = new Buffer(packFrame(commandBody));

    const packet = Buffer.concat([command, data], command.length + data.length);

    return packet;
  }

  static parsePacket(packet, cfg, cb) {
    const command = WeitaiUSB.getCommand(packet);

    if (command.length < 12) {
      return false;
    }
    const commandBody = new Buffer(unpackFrame(command));

    const port = commandBody[0];
    const parameter = commandBody[1];
    const operation = commandBody[2];
    const crc8 = commandBody[3];
    const length = commandBody.readInt32LE(4);

    const crc8_c = cRC8(
      Buffer.concat(
        [commandBody.slice(0, 3), commandBody.slice(4)],
        commandBody.length - 1
      )
    );

    if (crc8 != crc8_c) {
      return cb(new Error('CRC8 checksums not matching'), null);
    }

    if (packet.length < command.length + length) {
      return cb(new Error('Incorrect packet length'), null);
    }

    const data = packet.slice(command.length, command.length + length);

    const payload = data.slice(0, data.length - 16);
    const md5 = data.slice(data.length - 16, data.length);

    const md5_c = crypto
      .createHash('md5')
      .update(payload)
      .digest();

    if (!md5.equals(md5_c)) {
      return cb(new Error('MD5 checksums not matching'), null);
    }

    let inComeRes = WeitaiUSB.parsePayload(payload, cfg, cb);

    return inComeRes;
  }

  static parsePayload(payload, cfg, cb) {
    let inComeRes = {
      BloodGlucoses: [],
      BasalRates: [],
      BolusRates: [],
      lastBasals: [],
      alarm: [],
      status: [],
      reservoirChanges:[],
      primes:[],
      sn: 0,
      snObj: {},
    };

    if (payload.length == 0) {
<<<<<<< HEAD
=======
      // 无数据
      // no data available
>>>>>>> 2c46721993549cd434b0639ae9bc796fde7a72ac
      return cb({ code: 'E_READ_FILE' }, null);
    }

    if (payload.length % 28) {
      return cb(new Error('Incorrect payload length'), null);
    }

    for (let i = 0; i < payload.length; i += 28) {
      const history = payload.slice(i, i + 28);

      const ID = history.slice(0, 4);
      const SN = history.slice(4, 10);
      const dateTime = history.slice(10, 16);
      const status = history.slice(16, 22);
      const event = history.slice(22, 28);

      const recordID = uintFromArrayBuffer(ID, true);
      const deviceSn = uint8ArrayToString(SN);

      const year = uintFromArrayBuffer(dateTime.slice(0, 1), true) + 2000;
      const month = uintFromArrayBuffer(dateTime.slice(1, 2), true);
      const day = uintFromArrayBuffer(dateTime.slice(2, 3), true);
      const hour = uintFromArrayBuffer(dateTime.slice(3, 4), true);
      const minute = uintFromArrayBuffer(dateTime.slice(4, 5), true);
      const second = uintFromArrayBuffer(dateTime.slice(5, 6), true);

      const battery = uintFromArrayBuffer(status.slice(0, 1), true);
      const reservoir = uintFromArrayBuffer(status.slice(1, 2), true);
      const basalRate = uintFromArrayBuffer(status.slice(2, 4), true);
      const bolusRate = uintFromArrayBuffer(status.slice(4, 6), true);

      const eventIndex = uintFromArrayBuffer(event.slice(0, 2), true);
      const eventPort = uintFromArrayBuffer(event.slice(2, 3), true);
      const eventType = uintFromArrayBuffer(event.slice(3, 4), true);
      const eventUrgency = uintFromArrayBuffer(event.slice(4, 5), true);
      const eventValue = uintFromArrayBuffer(event.slice(5, 6), true);

      const timeText =
        year +
        '-' +
        (month + 100).toString().substring(1) +
        '-' +
        (day + 100).toString().substring(1) +
        'T' +
        (hour + 100).toString().substring(1) +
        ':' +
        (minute + 100).toString().substring(1) +
        ':' +
        (second + 100).toString().substring(1);
      let recoder = {
        deviceTime: timeText,
        recordId: recordID,
        eventPort,
        deviceSn
      };

      if (SN == '000000') {
        continue;
      }

      if (eventPort == 4 && eventType == 1 && eventUrgency == 1) {
        inComeRes.alarm.push({
          index: eventIndex,
          type: 'low_insulin',
          deviceTime: timeText,
        });
      }

      if (eventPort == 4 && eventType == 5 && eventUrgency == 0) {
        inComeRes.status.push({
          index: eventIndex,
          type: 'suspend',
          deviceTime: timeText,
        });
      }

      if (eventPort == 4 && eventType == 1 && eventUrgency == 2) {
        inComeRes.alarm.push({
          index: eventIndex,
          type: 'no_insulin',
          deviceTime: timeText,
        });
      }

      if (eventPort == 5 && eventType == 0 && eventUrgency == 1) {
        inComeRes.alarm.push({
          index: eventIndex,
          type: 'low_power',
          deviceTime: timeText,
        });
      }

      if (eventPort == 5 && eventType == 1 && eventUrgency == 2) {
        inComeRes.alarm.push({
          index: eventIndex,
          type: 'no_power',
          deviceTime: timeText,
        });
      }

      if (eventPort == 4 && eventType == 6 && eventUrgency == 2) {
        inComeRes.alarm.push({
          index: eventIndex,
          type: 'auto_off',
          deviceTime: timeText,
        });
      }

      if (eventPort == 4 && eventType == 2) {
        inComeRes.alarm.push({
          index: eventIndex,
          type: 'occlusion',
          deviceTime: timeText,
        });
      }

      
      if (eventPort == 4 && eventType == 8) {
        inComeRes.reservoirChanges.push({
          index: eventIndex,
          type: 'reservoirChanges',
          deviceTime: timeText,
        });
      }

      if (eventPort == 4 && eventType == 7) {
        inComeRes.primes.push({
          index: eventIndex,
          type: 'prime',
          deviceTime: timeText,
        });
      }

      if (eventPort == 4 && eventType == 3) {
        inComeRes.alarm.push({
          index: eventIndex,
          type: 'occlusion',
          deviceTime: timeText,
        });
      }

      debug('lastUpload',cfg.lastUpload);
      if (new Date(timeText).valueOf() < cfg.lastUpload) {
        if (eventPort != 3) {
          recoder.BasalRate =
            parseInt(formatString(basalRate.toString(), 4, true)) * 0.00625;
          inComeRes.lastBasals.push(recoder);
        }
        continue;
      }
      if (eventPort == 3 && eventType == 0) {
        recoder.BloodGlucose = formatString(basalRate.toString(), 4, true);
        inComeRes.BloodGlucoses.push(recoder);
        continue;
      }

      //Carbohydrate
      if (eventPort == 3 && eventType == 1) {
        continue;
      }

      //Basal
      if (eventPort != 3) {
        recoder.BasalRate =
          parseInt(formatString(basalRate.toString(), 4, true)) * 0.00625;
        inComeRes.BasalRates.push(recoder);
      }

      //BolusRate
      if (parseInt(formatString(bolusRate.toString(), 6, true)) == 0) {
        if (
          inComeRes.BolusRates[inComeRes.BolusRates.length - 1] &&
          parseInt(
            inComeRes.BolusRates[inComeRes.BolusRates.length - 1].BolusRate
          ) != 0
        ) {
          recoder.BolusRate = formatString(bolusRate.toString(), 6, true);
          inComeRes.BolusRates.push(recoder);
        } else {
          if (!inComeRes.BolusRates.length) {
            recoder.BolusRate = formatString(bolusRate.toString(), 6, true);
            inComeRes.BolusRates.push(recoder);
          }
        }
      }
      if (parseInt(formatString(bolusRate.toString(), 6, true)) != 0) {
        recoder.BolusRate = formatString(bolusRate.toString(), 6, true);
        inComeRes.BolusRates.push(recoder);
      }

      const text1 = (recordID + 1000).toString().substring(1);
      const text2 =
        year +
        '-' +
        (month + 100).toString().substring(1) +
        '-' +
        (day + 100).toString().substring(1) +
        ' ' +
        (hour + 100).toString().substring(1) +
        ':' +
        (minute + 100).toString().substring(1) +
        ':' +
        (second + 100).toString().substring(1);

      const text3 =
        ' Battery/Flag: ' +
        formatString(battery.toString(), 3, true) +
        ' Reservoir/Type: ' +
        formatString(reservoir.toString(), 3, true) +
        ' BasalRate/BloodGlucose: ' +
        formatString(basalRate.toString(), 4, true) +
        ' BolusRate/Carbohydrate: ' +
        formatString(bolusRate.toString(), 6, true);

      const text4 =
        ' EventIndex: ' +
        formatString(eventIndex.toString(), 4, true) +
        ' EventPort: ' +
        eventPort +
        ' EventType: ' +
        eventType +
        ' EventUrgency: ' +
        eventUrgency +
        ' EventValue: ' +
        eventValue;

    }
    if (inComeRes.lastBasals.length) {
      inComeRes.lastBasals.sort(function(a, b) {
        return a.deviceTime < b.deviceTime ? -1 : 1;
      });
      inComeRes.BasalRates.unshift(
        inComeRes.lastBasals[inComeRes.lastBasals.length - 1]
      );
    }
    return inComeRes;
  }

  static getCommand(buffer) {
    var begin = -1;
    var end = -1;
    for (var i = 0; i < buffer.length - 1; ++i) {
      if (begin < 0) {
        const c1 = buffer[i];
        const c2 = buffer[i + 1];
        if (c1 == 0x2b && c2 == 0x2b) {
          begin = i;
          i++;
        }
      } else {
        const c1 = buffer[i];
        const c2 = buffer[i + 1];
        if (c1 == 0x2b && c2 == 0x2b) {
          end = i + 1;
          break;
        }
      }
    }
    if (begin < 0 || end < 0) {
      return Buffer.alloc(0);
    }
    return buffer.slice(begin, end + 1);
  }

  async getPdaSn(cb) {
    let done = false;
    let count = 1;
    let pdaSn = 'unkonwSn';
    let commandBodyLength = 0;
    let payload = Buffer.alloc(4);
    let commandBody = Buffer.alloc(8);
    payload.writeUInt8(0x00, 0);
    payload.writeUInt8(0x00, 1);
    payload.writeUInt8(0x00, 2);
    payload.writeUInt8(0x00, 3);

    commandBody.writeUInt8(0x00, 0); //Port
    commandBody.writeUInt8(0x07, 1); //Parameter
    commandBody.writeUInt8(0x02, 2); //Operation
    const buffer = WeitaiUSB.buildSettingPacket(payload, commandBody);
    await this.usbDevice.transferOut(this.outEndpoint.address, buffer);
    var incomingA = Buffer.alloc(0);
    while (!done) {
      await this.usbDevice
        .transferIn(this.inEndpoint.address, 10240)
        .then((res) => {
          const incoming = res;
          console.log(incoming.length);
          incomingA = Buffer.concat(
            [incomingA, incoming],
            incomingA.length + incoming.length
          );
          debug('Received', _.toUpper(incoming.toString('hex')));
          if (count == 1) {
            const command = WeitaiUSB.getCommand(incomingA);
            const commandBody = new Buffer(unpackFrame(command));
            commandBodyLength = commandBody.readInt32LE(4);
            count++;
          } else {
            commandBodyLength = commandBodyLength - incoming.length;
            if (commandBodyLength == 0) {
              done = true;
              pdaSn = WeitaiUSB.parseSettingPacket(incomingA, 'PDASN', cb);
            }
          }
        });
    }
    return pdaSn;
  }

  async getConfig(data, cb) {
    this.current = 0;
    let settings = {};
    try {
      for (let i = 0; i < this.setTypes.length; i++) {
        settings = await this.getSetting(cb);
      }
    } catch (e) {
      return cb({ code: 'E_READ_FILE' }, null);
    }
    let pdaSn = '';
    try {
      pdaSn = await this.getPdaSn(cb);
    } catch (e) {
      return cb({ code: 'E_READ_FILE' }, null);
    }
    let done = false;
    let count = 1;
    let commandBodyLength = 0;
    const buffer = WeitaiUSB.buildPacket(Buffer.alloc(0));
    await this.usbDevice.transferOut(this.outEndpoint.address, buffer);
    var incomingA = Buffer.alloc(0);
    while (!done) {
      await this.usbDevice
        .transferIn(this.inEndpoint.address, 10240)
        .then((res) => {
          const incoming = res;
          console.log(incoming.length);
          incomingA = Buffer.concat(
            [incomingA, incoming],
            incomingA.length + incoming.length
          );
          debug('Received', _.toUpper(incoming.toString('hex')));
          if (count == 1) {
            const command = WeitaiUSB.getCommand(incomingA);
            const commandBody = new Buffer(unpackFrame(command));
            commandBodyLength = commandBody.readInt32LE(4);
            count++;
          } else {
            commandBodyLength = commandBodyLength - incoming.length;
            if (commandBodyLength == 0) {
              done = true;
            }
          }
        });
    }
    const getMostRecentUpload = promisify(
      this.cfg.api.getMostRecentUploadRecord
    );

    this.cfg.lastUpload = 0;
    const inComeRes = WeitaiUSB.parsePacket(incomingA, this.cfg, cb);
    this.cfg.deviceInfo.deviceId = 'equil-' + pdaSn;
    this.cfg.deviceInfo.serialNumber = pdaSn;
    const res = await getMostRecentUpload(
      this.cfg.groupId,
      this.cfg.deviceInfo.deviceId
    );
    if (res && res.time) {
      this.cfg.lastUpload = new Date(res.time).valueOf();
    } else {
      this.cfg.lastUpload = 0;
    }

    data.incomingA = incomingA;
    data.settings = settings;
    data.pdaSn = pdaSn;
    return data;
  }

  current = 0;
  settingUpload = {};
  setTypes = [
    'lowBg',
    'highBg',
    'defaultCho',
    'sensitiveSilver',
    'originBasal',
    'bolusRate',
    'maxBolus',
    'doubleBolus',
    'effectiveTime',
    'program0',
    'program1',
    'program2',
    'program3',
    'program4',
    'program5',
    'program6',
  ];
  async getSetting(cb) {
    let done = false;
    let SettingRes = {};
    var incomingA = Buffer.alloc(0);
    let counter = 1;
    let commandBodyLength = 0;
    let payload = Buffer.alloc(4);
    let commandBody = Buffer.alloc(8);
    payload.writeUInt8(0x01, 0);
    payload.writeUInt8(0x00, 1);
    payload.writeUInt8(0x00, 2);
    payload.writeUInt8(0x00, 3);

    commandBody.writeUInt8(0x03, 0); //Port
    commandBody.writeUInt8(0x11, 1); //Parameter
    commandBody.writeUInt8(0x02, 2); //Operation
    if (this.current == 1) {
      payload.writeUInt8(0x00, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x03, 0); //Port
      commandBody.writeUInt8(0x11, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 2) {
      payload.writeUInt8(0x02, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x03, 0); //Port
      commandBody.writeUInt8(0x11, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 3) {
      //sensitiveSilver
      payload.writeUInt8(0x03, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x03, 0); //Port
      commandBody.writeUInt8(0x11, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 4) {
      //originBasal
      payload.writeUInt8(0x0c, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x05, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }

    if (this.current == 5) {
      //bolusRate
      payload.writeUInt8(0x0a, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x05, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 6) {
      //maxBolus
      payload.writeUInt8(0x08, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x05, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }

    if (this.current == 7) {
      //doubleBolus
      payload.writeUInt8(0x0d, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x05, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 8) {
      //effectiveTime
      payload.writeUInt8(0x03, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x03, 0); //Port
      commandBody.writeUInt8(0x10, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 9) {
      payload.writeUInt8(0x00, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x02, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 10) {
      payload.writeUInt8(0x01, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x02, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 11) {
      payload.writeUInt8(0x02, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x02, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 12) {
      payload.writeUInt8(0x03, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x02, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 13) {
      payload.writeUInt8(0x04, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x02, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 14) {
      payload.writeUInt8(0x05, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x02, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    if (this.current == 15) {
      payload.writeUInt8(0x06, 0);
      payload.writeUInt8(0x00, 1);
      payload.writeUInt8(0x00, 2);
      payload.writeUInt8(0x00, 3);

      commandBody.writeUInt8(0x04, 0); //Port
      commandBody.writeUInt8(0x02, 1); //Parameter
      commandBody.writeUInt8(0x02, 2); //Operation
    }
    const buffer = WeitaiUSB.buildSettingPacket(payload, commandBody);
    await this.usbDevice.transferOut(this.outEndpoint.address, buffer);
    while (!done) {
      await this.usbDevice
        .transferIn(this.inEndpoint.address, 10240)
        .then((res) => {
          const incoming = res;
          incomingA = Buffer.concat(
            [incomingA, incoming],
            incomingA.length + incoming.length
          );
          if (counter == 1) {
            const command = WeitaiUSB.getCommand(incomingA);
            const commandBody = new Buffer(unpackFrame(command));

            commandBodyLength = commandBody.readInt32LE(4);
            counter++;
          } else {
            commandBodyLength = commandBodyLength - incoming.length;
            if (commandBodyLength == 0) {
              done = true;
              let inComeRes = {};
              if (this.current > 8) {
                inComeRes = WeitaiUSB.parseSettingPacket(incomingA, 'name', cb);
              } else {
                inComeRes = WeitaiUSB.parseSettingPacket(incomingA, '', cb);
              }
              this.settingUpload[this.setTypes[this.current]] =
                inComeRes.inComeRes;
              this.settingUpload[this.setTypes[this.current] + '_name'] =
                inComeRes.name;
              this.current = this.current + 1;
            }
          }
        });
    }
    return this.settingUpload;
  }

  async close(cb) {
    try {
      this.usbDevice.device.close();
      cb();
      // this.usbDevice.iface.release(true, () => {
      //   this.usbDevice.device.close();
      //   cb();
      // });
    } catch (err) {
      return cb(err, null);
    }
  }
}

module.exports = (config) => {
  const cfg = _.clone(config);
  _.assign(cfg.deviceInfo, {
    tags: ['insulin-pump'],
    manufacturers: ['MicroTech'],
  });
  const driver = new WeitaiUSB(cfg);

  cfg.tzoUtil = new TZOUtil(cfg.timezone, new Date().toISOString(), []);

  return {
    detect(deviceInfo, cb) {
      debug('no detect function needed', deviceInfo);
      cb(null, deviceInfo);
    },

    setup(deviceInfo, progress, cb) {
      debug('in setup!');
      progress(100);
      cb(null, { deviceInfo });
    },

    connect(progress, data, cb) {
      debug('in connect!');
      driver.openDevice(data.deviceInfo, (err) => {
        if (err) {
          data.disconnect = true;
          debug('Error:', err);
          return cb(err, null);
        }
        return cb(null, data);
      });
    },

    getConfigInfo(progress, data, cb) {
      debug('in getConfigInfo', data);
      progress(0);
      let _this = this;
      (async () => {
        //start
        const result = await driver.getConfig(data, cb);
        data.deviceDetails = result;
        cb(null, data);
      })().catch((error) => {
        debug('Error in getConfigInfo: ', error);
        cb(error, null);
      });
    },

    buildBasalSchedules(settings) {
      //carbRatio
      let choList = settings.defaultCho;
      let carbRatio = [];
      for (let c = 0; c < choList.length; c++) {
        if (c == 0) {
          carbRatio.push({
            amount: choList[c],
            start: 0,
          });
        } else {
          let choLgth = choList.length;
          if (choList[c] != choList[choLgth - 1]) {
            carbRatio.push({
              amount: choList[c],
              start: c * 30 * 60 * 1000,
            });
          }
        }
      }

      //insulinSensitivity
      let senList = settings.sensitiveSilver;
      let insulinSensitivity = [];
      for (let c = 0; c < senList.length; c++) {
        if (c == 0) {
          insulinSensitivity.push({
            amount: senList[c] / 10,
            start: 0,
          });
        } else {
          let senLgtn = senList.length;
          if (senList[c] != senList[senLgtn - 1]) {
            insulinSensitivity.push({
              amount: senList[c] / 10,
              start: c * 30 * 60 * 1000,
            });
          }
        }
      }

      //insulinSensitivity
      let bgList = settings.lowBg;
      let bgHighList = settings.highBg;
      let bgTarget = [];
      for (let c = 0; c < bgList.length; c++) {
        if (c == 0) {
          bgTarget.push({
            start: 0,
            low: parseInt( bgList[0] / 10 ),
            high: parseInt( bgHighList[0] / 10 ),
          });
        } else {
          let targetLength = bgList.length;
          if (bgList[c] != bgList[targetLength - 1] || bgHighList[c] != bgHighList[targetLength - 1]) {
            bgTarget.push({
              start: 2 * 30 * 60 * 1000,
              low: bgList[c] / 10,
              high: bgHighList[c] / 10,
            });
          }
        }
      }

      //basalSchedules
      let basalSchedules = {};
      let activeName = '';
      for (let i = 0; i < 7; i++) {
        let nameIndex = 'program' + i + '_name';
        let name = settings[nameIndex] || 'basal_' + i;
        if (settings[nameIndex]) {
          activeName = settings[nameIndex];
        }
        let basalList = settings['program' + i] || [];
        basalSchedules[name] = [];
        if (basalList.length) {
          for (let b = 0; b < basalList.length; b++) {
            if (b == 0) {
              basalSchedules[name].push({
                start: 0,
                rate: basalList[b] * 0.0125,
              });
            } else {
              if (basalList[b] != basalList[b - 1]) {
                basalSchedules[name].push({
                  start: b * 30 * 60 * 1000,
                  rate: basalList[b] * 0.0125,
                });
              }
            }
          }
        }
      }
      return {
        carbRatio,
        insulinSensitivity,
        bgTarget,
        basalSchedules,
        activeName,
      };
    },

    buildSettings(settings) {
      let res = [];
      //basalSchedules
      let settingRes = this.buildBasalSchedules(settings);
      var postsettings = cfg.builder
        .makePumpSettings()
        .with_activeSchedule(settingRes.activeName || 'basal_1')
        .with_units({ carb: 'grams', bg: 'mg/dL' })
        .with_basalSchedules(settingRes.basalSchedules)
        .with_carbRatio(settingRes.carbRatio)
        .with_insulinSensitivity(settingRes.insulinSensitivity)
        .with_bgTarget(settingRes.bgTarget)
        .with_manufacturers(['Microtech'])
        .with_serialNumber(cfg.deviceInfo.serialNumber)
        .with_deviceTime(sundial.formatDeviceTime(new Date('2020-02-28 10:00:00').valueOf()))
        .with_time(
          sundial.applyTimezone(new Date(), cfg.timezone).toISOString()
        )
        .with_timezoneOffset(0)
        .with_conversionOffset(0)
        .done();

      return postsettings;
    },

    buildBlood(BloodGlucoses) {
      let res = [];
      for (let blood of BloodGlucoses) {
        if (new Date(blood.deviceTime).valueOf() < cfg.lastUpload) {
          continue;
        }
        const recordBuilder = cfg.builder
          .makeSMBG()
          .with_value(parseFloat(blood.BloodGlucose))
          .with_units('mg/dL') // values are always in 'mg/dL'
          .with_deviceTime(
            sundial.formatDeviceTime(new Date(blood.deviceTime).valueOf())
          )
          .set('index', blood.recordId);

        cfg.tzoUtil.fillInUTCInfo(
          recordBuilder,
          new Date(blood.deviceTime).valueOf()
        );
        const postRecord = recordBuilder.done();
        delete postRecord.index;
        res.push(postRecord);
      }
      return res;
    },

    buildBasal(BasalRates) {
      let res = [];
      BasalRates.sort(function(a, b) {
        return a.deviceTime < b.deviceTime ? -1 : 1;
      });
      for (let i = 0; i < BasalRates.length; i++) {
        if(BasalRates[i].recordId == 515){
          console.log(BasalRates[i]);
        }
        let currDu = new Date(BasalRates[i].deviceTime).valueOf();
        let nextDu = BasalRates[i + 1]
          ? new Date(BasalRates[i + 1].deviceTime).valueOf()
          : currDu + 1000;
        if (nextDu - currDu < 0) {
          debug('error-basal', BasalRates[i]);
        }
        if (i == BasalRates.length - 1) {
          break;
        };
        let currentDur = (nextDu - currDu) < 604800000 ? (nextDu - currDu) : 604799999;
        let basalBuilder = cfg.builder
          .makeScheduledBasal()
          .with_scheduleName('basal_1')
          .with_deviceTime(
            sundial.formatDeviceTime(
              new Date(BasalRates[i].deviceTime).valueOf()
            )
          )
          .with_rate(BasalRates[i].BasalRate)
          .with_duration(currentDur)
          .set('index', BasalRates[i].recordId);
        cfg.tzoUtil.fillInUTCInfo(
          basalBuilder,
          new Date(BasalRates[i].deviceTime).valueOf()
        );
        const postRecord = basalBuilder.done();
        if (res[i - 1]) {
          let preRes = JSON.stringify(res[i - 1]);
          preRes = JSON.parse(preRes);
          delete preRes.previous;
          postRecord.previous = preRes;
        }
        res.push(postRecord);
      }
      return res;
    },

    buildBolus(BolusRates) {
      let postRes = [];
      let itemRes = [];
      for (let bolus of BolusRates) {
        if (!itemRes.length) {
          itemRes.push(bolus);
          continue;
        }
        if (bolus.BolusRate == '0') {
          itemRes.push(bolus);
          let chckRes = this.checkBolus(itemRes);
          if (chckRes == 'normal') {
            let postAary = this.buildBolusNormal(itemRes);
            postRes = postRes.concat(postAary);
          }
          if (chckRes == 'square') {
            let postAary = this.buildBolusSquare(itemRes);
            postRes = postRes.concat(postAary);
          }
          if (chckRes == 'dulSquare') {
            let postAary = this.buildBolusDualSquare(itemRes);
            postRes = postRes.concat(postAary);
          }
          itemRes = [];
          continue;
        } else {
          itemRes.push(bolus);
          continue;
        }
      }
      return postRes;
    },
    checkBolus(blous) {
      let normal = false;
      let square = false;
      let returnStr = '';
      for (let item of blous) {
        if (parseInt(item.BolusRate) > 0 && parseInt(item.BolusRate) <= 12800) {
          square = true;
        }
        if (parseInt(item.BolusRate) > 12800) {
          normal = true;
        }
      }
      if (normal && square) {
        returnStr = 'dulSquare';
      }
      if (normal && !square) {
        returnStr = 'normal';
      }
      if (!normal && square) {
        returnStr = 'square';
      }
      return returnStr;
    },
    buildBolusNormal(bolus) {
      let bolusArray = [];
      for (let i = 0; i < bolus.length; i++) {
        if (bolus[i].BolusRate != '0') {
          let currTimeStamp = new Date(bolus[i].deviceTime).valueOf();
          let nextTimeStamp = bolus[i + 1]
            ? new Date(bolus[i + 1].deviceTime).valueOf()
            : new Date(bolus[i].deviceTime).valueOf();
          let durCalcut = (nextTimeStamp - currTimeStamp) / 1000;
          let boluMount = this.buildValue(
            (parseInt(bolus[i].BolusRate) * 0.00625 * durCalcut) / (60 * 60)
          );
          let postbolus = cfg.builder
            .makeNormalBolus()
            .with_normal(boluMount)
            .with_deviceTime(
              sundial.formatDeviceTime(new Date(bolus[i].deviceTime).valueOf())
            )
            .set('index', bolus[i].recordId);
          cfg.tzoUtil.fillInUTCInfo(
            postbolus,
            new Date(bolus[i].deviceTime).valueOf()
          );
          postbolus = postbolus.done();
          bolusArray.push(postbolus);
        }
      }
      return bolusArray;
    },

    buildBolusSquare(bolus) {
      let bolusArray = [];
      for (let i = 0; i < bolus.length; i++) {
        if (bolus[i].BolusRate != '0') {
          let currTimeStamp = new Date(bolus[i].deviceTime).valueOf();
          let nextTimeStamp = bolus[i + 1]
            ? new Date(bolus[i + 1].deviceTime).valueOf()
            : new Date(bolus[i].deviceTime).valueOf();
          let durCalcut = (nextTimeStamp - currTimeStamp) / 1000;
          let boluMount = this.buildValue(
            (parseInt(bolus[i].BolusRate) * 0.00625 * durCalcut) / (60 * 60)
          );
          let postbolus = cfg.builder
            .makeSquareBolus()
            .with_deviceTime(
              sundial.formatDeviceTime(new Date(bolus[i].deviceTime).valueOf())
            )
            .with_extended(boluMount)
            .with_duration(nextTimeStamp - currTimeStamp)
            .set('index', bolus[i].recordId);
          cfg.tzoUtil.fillInUTCInfo(
            postbolus,
            new Date(bolus[i].deviceTime).valueOf()
          );
          postbolus = postbolus.done();
          bolusArray.push(postbolus);
        }
      }
      return bolusArray;
    },

    buildBolusDualSquare(bolus) {
      let bolusArray = [];
      let normal = 0;
      let square = 0;
      let dur = 0;
      let deviceTime;
      let index = 0;
      for (let i = 0; i < bolus.length; i++) {
        let currTimeStamp = new Date(bolus[i].deviceTime).valueOf();
        let nextTimeStamp = bolus[i + 1]
          ? new Date(bolus[i + 1].deviceTime).valueOf()
          : new Date(bolus[i].deviceTime).valueOf();
        let currDur = nextTimeStamp - currTimeStamp;
        let durCalcut = (nextTimeStamp - currTimeStamp) / 1000;
        let boluMount =
          (parseInt(bolus[i].BolusRate) * 0.00625 * durCalcut) / (60 * 60);
        if (bolus[i].BolusRate != '0' && parseInt(bolus[i].BolusRate) > 12800) {
          normal = boluMount + normal;
          deviceTime = bolus[i].deviceTime;
          index = bolus[i].recordId;
        }
        if (bolus[i].BolusRate != '0' && parseInt(bolus[i].BolusRate) < 12800) {
          square = boluMount + square;
          dur = currDur + dur;
        }
      }
      let postbolus = cfg.builder
        .makeDualBolus()
        .with_normal(this.buildValue(normal))
        .with_deviceTime(
          sundial.formatDeviceTime(new Date(deviceTime).valueOf())
        )
        .with_extended(this.buildValue(square))
        .with_duration(dur)
        .set('index', index);
      cfg.tzoUtil.fillInUTCInfo(postbolus, new Date(deviceTime).valueOf());
      postbolus = postbolus.done();
      bolusArray.push(postbolus);
      return bolusArray;
    },

    buildValue(originValue) {
      let value = this.formatDecimal(originValue, 2);
      let res = (value * 1000) / 25;
      let floorRes = Math.floor(res);
      let floor = floorRes * 25;
      if (res > floorRes) {
        floor = (floor + 25) / 1000;
      } else {
        floor = floor / 1000;
      }
      return floor;
    },
    buildStatus(status) {
      let statusRes = [];
      for (var b in status) {
        var suspendresumedatum = status[b];
        try {
          var suspend = cfg.builder.makeDeviceEventSuspend()
            .with_deviceTime(suspendresumedatum.suspendDeviceTime)
            .with_reason({suspended: 'manual'})
            .set('index', suspendresumedatum.index);
          cfg.tzoUtil.fillInUTCInfo(suspend, suspendresumedatum.suspendJsDate);
          statusRes.push(suspend.done());
        } catch (e) {
          debug('alarm', e);
        }
      }
      return statusRes;
    },
    buildAlerm(alarmRecords) {
      let alermRes = [];
      for (var b in alarmRecords) {
        var alarmdatum = alarmRecords[b];
        try {
          var alarmRecord = cfg.builder
            .makeDeviceEventAlarm()
            .with_deviceTime(alarmdatum.deviceTime)
            .set('index', alarmdatum.index)
            .with_alarmType(alarmdatum.type);
          cfg.tzoUtil.fillInUTCInfo(
            alarmRecord,
            new Date(alarmdatum.deviceTime).valueOf()
          );
          alarmRecord = alarmRecord.done();
        } catch (e) {
          debug('alarm', e);
        }

        alermRes.push(alarmRecord);
      }
      return alermRes;
    },
    buildReservoirChange(resRecords) {
      let reservoirRes = [];
      for (var b in resRecords) {
        var reservoir = resRecords[b];
        try {
          var reservoirRecord = cfg.builder
            .makeDeviceEventReservoirChange()
            .with_deviceTime(reservoir.deviceTime)
            .set('index', reservoir.index);
          cfg.tzoUtil.fillInUTCInfo(
            reservoirRecord,
            new Date(reservoir.deviceTime).valueOf()
          );
          reservoirRecord = reservoirRecord.done();
        } catch (e) {
          debug('reservoir', e);
        }

        reservoirRes.push(reservoirRecord);
      }
      return reservoirRes;
    },

    buildPrime(primeRecords) {
      let primeRes = [];
      for (var b in primeRecords) {
        var prime = primeRecords[b];
        try {
          var primeRecord = cfg.builder
          .makeDeviceEventPrime()
          .with_deviceTime(prime.deviceTime)
          .with_primeTarget('cannula')
          // .with_volume(prime.deliveredAmount)
          .set('index', prime.index);
          cfg.tzoUtil.fillInUTCInfo(
            primeRecord,
            new Date(prime.deviceTime).valueOf()
          );
          primeRecord = primeRecord.done();
        } catch (e) {
          debug('prime', e);
        }

        primeRes.push(primeRecord);
      }
      return primeRes;
    },

    formatDecimal(originnum, decimal) {
      let num = originnum.toString();
      let index = num.indexOf('.');
      let resNum = '';
      if (index !== -1) {
        resNum = num.substring(0, decimal + index + 1);
      } else {
        resNum = num.substring(0);
      }
      return parseFloat(resNum).toFixed(decimal);
    },
    fetchData(progress, data, cb) {
      let records = [];
      let incomingA = data.incomingA;
      const inComeRes = WeitaiUSB.parsePacket(incomingA, cfg, cb);
      data.BloodGlucoses = inComeRes.BloodGlucoses;
      data.BasalRates = inComeRes.BasalRates;
      data.BolusRates = inComeRes.BolusRates;
      data.reservoirChanges = inComeRes.reservoirChanges;
      data.primes = inComeRes.primes;
      data.alarm = inComeRes.alarm;
      data.records = records;
      return cb(null, data);
    },

    processData(progress, data, cb) {
      cfg.builder.setDefaults({ deviceId: cfg.deviceInfo.deviceId});
      progress(100);
      let settings = data.settings;
      let alerms = data.alarm;
      let status = data.status;
      let postSetting = this.buildSettings(settings);
      let bloodRes = this.buildBlood(data.BloodGlucoses);
      let basalRes = this.buildBasal(data.BasalRates);
      let bolusRes = this.buildBolus(data.BolusRates);
      let reservoirChanges = this.buildReservoirChange(data.reservoirChanges);
      let primes = this.buildPrime(data.primes);
      basalRes = basalRes.length > 1 ? basalRes : [];
      let alermRes = this.buildAlerm(alerms);
      let statusRes = this.buildStatus(status);
      let post_records = [].concat(
        bloodRes,
        basalRes,
        bolusRes,
        postSetting,
        alermRes,
        statusRes,
        primes,
        reservoirChanges
      );
      if (!post_records.length) {
        let err = new Error();
        err.code = 'E_NO_NEW_RECORDS';
        return cb(err, null);
      }
      data.post_records = post_records;
      return cb(null, data);
    },

    uploadData(progress, data, cb) {
      progress(0);
      const sessionInfo = {
        delta: cfg.delta,
        deviceTags: cfg.deviceInfo.tags,
        deviceManufacturers: ['Microtech'],
        deviceModel: 'equil',//only one device model
        deviceSerialNumber: cfg.deviceInfo.serialNumber,
        deviceId: cfg.deviceInfo.deviceId,
        start: sundial.utcDateString(),
        timeProcessing: cfg.tzoUtil.type,
        tzName: cfg.timezone,
        version: cfg.version,
      };
      cfg.api.upload.toPlatform(
        data.post_records,
        sessionInfo,
        progress,
        cfg.groupId,
        (err, result) => {
          progress(100);

          if (err) {
            debug(err);
            debug(result);
            return cb(err, null);
          }
          data.cleanup = true;
          return cb(null, data);
        },
        'dataservices'
      );
    },
    disconnect(progress, data, cb) {
      debug('in disconnect');
      progress(100);
      cb(null, data);
    },

    cleanup(progress, data, cb) {
      debug('in cleanup');
      driver.close(() => {
        progress(100);
        data.cleanup = true;
        cb(null, data);
      });
    },
  };
};