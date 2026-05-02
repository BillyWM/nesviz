import net from 'node:net';
import { EventEmitter } from 'node:events';

import { getActiveRomSummary } from './analysisIpc.js';
import { formatBytes } from '../shared/utils/byteFormatUtils.js';
import { isLoopbackAddress } from './utils/networkUtils.js';

const TRACE_STREAMER_PORT = 63783; // "NES 83"

function blankRomInfo() {
  return {
    emulatorName: '',
    gameName: '',
    checksum: '',
    mapper: '',
    submapper: '',
    prgRom: '',
    chrRom: '',
    prgRam: '',
    prgNvram: '',
    chrRam: '',
    chrNvram: '',
    mirroring: '',
    battery: '',
    trainer: '',
    fourScreen: ''
  };
}

class TraceStreamerService extends EventEmitter {
  constructor() {
    super();
    this._server = null;
    this._socket = null;
    this._status = {
      port: TRACE_STREAMER_PORT,
      listening: false,
      connected: false,
      lastError: null,
      ...blankRomInfo()
    };
  }

  getStatus() {
    return { ...this._status };
  }

  _emitStatus() {
    this.emit('status', this.getStatus());
  }

  async connect() {
    // "Connect" in NesViz means: start listening for the emulator to connect to us.
    if (this._server && this._status.listening) {
      return;
    }

    // Clear transient errors before (re)binding.
    this._status.lastError = null;

    this._server = net.createServer((socket) => {
      // Only accept loopback connections.
      if (!isLoopbackAddress(socket.remoteAddress)) {
        try {
          socket.destroy();
        } catch {}
        return;
      }

      // Only allow one active client.
      if (this._socket && !this._socket.destroyed) {
        try {
          this._socket.destroy();
        } catch {}
      }

      this._socket = socket;
      socket.setNoDelay(true);

      this._status.connected = true;
      this._status.emulatorName = 'bwmesen'; // TODO: replace with handshake-provided name.

      // For bring-up, populate ROM info from whatever NesViz currently has loaded.
      // Later, this will be replaced/verified by the emulator's handshake.
      this._applyActiveRomSummary();
      this._emitStatus();

      // TEMP: Verbose raw logging for bringup; remove once protocol is stable/volume increases.
      socket.on('data', (buf) => {
        console.log('[TraceStreamer] recv', buf);
      });

      socket.on('close', () => {
        this._socket = null;
        this._status.connected = false;
        Object.assign(this._status, blankRomInfo());
        this._emitStatus();
      });

      socket.on('error', (err) => {
        // Don't spam: just record the latest error.
        this._status.lastError = err ? String(err.message || err) : 'Socket error';
        this._emitStatus();
      });
    });

    await new Promise((resolve) => {
      this._server.once('error', (err) => {
        this._status.lastError = err ? String(err.message || err) : 'Listen error';
        this._status.listening = false;
        this._emitStatus();
        try {
          this._server?.removeAllListeners();
          this._server?.close();
        } catch {}
        this._server = null;
        resolve();
      });

      // Use :: with ipv6Only=false so localhost works for both IPv4 + IPv6 on most platforms.
      this._server.listen({ port: TRACE_STREAMER_PORT, host: '::', ipv6Only: false }, () => {
        this._status.listening = true;
        this._emitStatus();
        resolve();
      });
    });
  }

  async disconnect() {
    // Disconnect means: drop the client (if any) and stop listening.
    if (this._socket && !this._socket.destroyed) {
      try {
        this._socket.destroy();
      } catch {}
    }
    this._socket = null;

    if (this._server) {
      const s = this._server;
      this._server = null;
      await new Promise((resolve) => {
        try {
          s.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    this._status.listening = false;
    this._status.connected = false;
    this._status.lastError = null;
    Object.assign(this._status, blankRomInfo());
    this._emitStatus();
  }

  _applyActiveRomSummary() {
    const rom = getActiveRomSummary();
    if (!rom) return;

    this._status.gameName = rom.filename || '';
    this._status.checksum = rom.romHash || '';

    const ines = rom.ines;
    if (ines) {
      this._status.mapper = typeof ines.mapperNumber === 'number' ? String(ines.mapperNumber) : '';
      this._status.prgRom = formatBytes(ines.prgSize);
      this._status.chrRom = formatBytes(ines.chrSize);
      this._status.mirroring = ines.mirroring || '';
      this._status.trainer = ines.hasTrainer ? 'Yes' : 'No';
      this._status.battery = ines.hasBattery ? 'Yes' : 'No';
      this._status.fourScreen = ines.fourScreen ? 'Yes' : 'No';
    }
  }
}

export const traceStreamerService = new TraceStreamerService();
export { TRACE_STREAMER_PORT };
