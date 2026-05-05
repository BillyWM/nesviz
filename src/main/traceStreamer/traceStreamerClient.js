import net from 'node:net';

import { readLenString } from '../../shared/utils/byteUtils.js';
import { bufferToHex, fmtHex } from '../../shared/utils/numberUtils.js';
import { formatBytes } from '../../shared/utils/byteUtils.js';

const HOST = '127.0.0.1';
const START_PORT = 63783;
const PORT_ATTEMPTS = 10;

export const TraceMsgType = Object.freeze({
  Hello: 0x01,
  HelloAck: 0x02,
  Goodbye: 0x03,
  GoodbyeAck: 0x04,
  Info: 0x05,
  Sync: 0x06,
  Insn: 0x07
});

export const GoodbyeReason = Object.freeze({
  ClientRequest: 0,
  ServerShutdown: 1,
  ProtocolError: 2
});

export const SyncReason = Object.freeze({
  Initial: 0,
  LoadState: 1,
  Reset: 2
});

function encodeFrame(msgType, payload) {
  const payloadBuf = payload || Buffer.alloc(0);
  const header = Buffer.alloc(3);
  header.writeUInt8(msgType, 0);
  header.writeUInt16LE(payloadBuf.length, 1);
  return Buffer.concat([header, payloadBuf]);
}

function encodeHello() {
  const payload = Buffer.alloc(4);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(0, 2);
  return encodeFrame(TraceMsgType.Hello, payload);
}

function encodeGoodbye(reason) {
  const payload = Buffer.alloc(1);
  payload.writeUInt8(reason, 0);
  return encodeFrame(TraceMsgType.Goodbye, payload);
}

async function attemptConnect(port, timeoutMs = 250) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;

    const cleanup = () => {
      sock.removeListener('error', onError);
      sock.removeListener('connect', onConnect);
      sock.setTimeout(0);
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { sock.destroy(); } catch {}
      reject(err);
    };

    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(sock);
    };

    sock.once('error', onError);
    sock.once('connect', onConnect);
    sock.setTimeout(timeoutMs, () => {
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      onError(err);
    });

    sock.connect({ host: HOST, port });
  });
}

export function createTraceStreamerClient({ onStatus } = {}) {
  let socket = null;
  let rxBuf = Buffer.alloc(0);
  let connecting = false;
  let awaitingGoodbyeAck = false;
  let goodbyeTimer = null;

  let state = {
    connected: false,
    connecting: false,
    host: HOST,
    port: null,
    lastError: null,

    // INFO
    hasGame: false,
    fileName: '',
    sha1: '',
    crc32: '',
    prgCrc32: '',
    prgChrCrc32: '',
    mapperId: '',
    submapperId: '',
    mirroring: '',
    prgRomSize: '',
    chrRomSize: '',
    workRamSize: '',
    saveRamSize: '',
    chrRamSize: '',
    saveChrRamSize: '',

    // SYNC (kept for debugging; not shown yet)
    lastSync: null
  };

  const emit = (patch) => {
    state = { ...state, ...patch };
    if (typeof onStatus === 'function') onStatus(state);
  };

  const clearGoodbyeTimer = () => {
    if (goodbyeTimer) {
      clearTimeout(goodbyeTimer);
      goodbyeTimer = null;
    }
  };

  const cleanupSocket = () => {
    clearGoodbyeTimer();
    awaitingGoodbyeAck = false;

    if (socket) {
      try { socket.removeAllListeners(); } catch {}
      try { socket.destroy(); } catch {}
      socket = null;
    }
    rxBuf = Buffer.alloc(0);
  };

  const setDisconnected = (err = null) => {
    cleanupSocket();
    emit({
      connected: false,
      connecting: false,
      port: null,
      lastError: err ? String(err.message || err) : null,

      // Clear ROM info when disconnected so the UI shows blanks (not stale values).
      hasGame: false,
      fileName: '',
      sha1: '',
      crc32: '',
      prgCrc32: '',
      prgChrCrc32: '',
      mapperId: '',
      submapperId: '',
      mirroring: '',
      prgRomSize: '',
      chrRomSize: '',
      workRamSize: '',
      saveRamSize: '',
      chrRamSize: '',
      saveChrRamSize: '',
      lastSync: null
    });
  };

  const send = (buf) => {
    if (!socket || socket.destroyed) return;
    try {
      socket.write(buf);
    } catch (err) {
      // best-effort
      console.warn('[TraceStreamer] Failed to write to socket:', err);
    }
  };

  const handleMessage = (msgType, payload) => {
    const isKnownType =
      msgType === TraceMsgType.HelloAck ||
      msgType === TraceMsgType.GoodbyeAck ||
      msgType === TraceMsgType.Info ||
      msgType === TraceMsgType.Sync ||
      msgType === TraceMsgType.Insn;

    // TEMP: verbose trace-streamer logging for bringup; remove once streaming is high-volume.
    // NOTE: INSN is high-volume, so we intentionally do not log it.
    // NOTE: Unknown msgTypes are ignored silently (payloadLen lets us skip safely).
    if (isKnownType && msgType !== TraceMsgType.Insn) {
      console.log('[TraceStreamer] RX', {
        msgType,
        payloadLen: payload.length,
        payloadHex: bufferToHex(payload)
      });
    }

    try {
      if (msgType === TraceMsgType.HelloAck) {
        if (payload.length < 4) throw new Error('HELLO_ACK payload too short');
        const major = payload.readUInt16LE(0);
        const minor = payload.readUInt16LE(2);

        // TEMP: verbose trace-streamer logging for bringup; remove once streaming is high-volume.
        console.log('[TraceStreamer] HELLO_ACK', { major, minor });

        if (major !== 1) {
          emit({ lastError: `Protocol major mismatch (expected 1, got ${major})` });
          disconnect();
        }
        return;
      }

      if (msgType === TraceMsgType.GoodbyeAck) {
        const reasonEcho = payload.length >= 1 ? payload.readUInt8(0) : null;

        // TEMP: verbose trace-streamer logging for bringup; remove once streaming is high-volume.
        console.log('[TraceStreamer] GOODBYE_ACK', { reasonEcho });

        awaitingGoodbyeAck = false;
        clearGoodbyeTimer();
        if (socket && !socket.destroyed) {
          try { socket.end(); } catch {}
        }
        return;
      }

      if (msgType === TraceMsgType.Info) {
        if (payload.length < 1) throw new Error('INFO payload too short');
        let off = 0;
        const hasGame = payload.readUInt8(off) === 1;
        off += 1;

        if (!hasGame) {
          emit({
            hasGame: false,
            fileName: '',
            sha1: '',
            crc32: '',
            prgCrc32: '',
            prgChrCrc32: '',
            mapperId: '',
            submapperId: '',
            mirroring: '',
            prgRomSize: '',
            chrRomSize: '',
            workRamSize: '',
            saveRamSize: '',
            chrRamSize: '',
            saveChrRamSize: ''
          });
          return;
        }

        const fileNameRead = readLenString(payload, off);
        off = fileNameRead.offset;

        const sha1Read = readLenString(payload, off);
        off = sha1Read.offset;

        if (off + 4 * 3 > payload.length) throw new Error('INFO payload too short for CRCs');
        const crc32 = payload.readUInt32LE(off); off += 4;
        const prgCrc32 = payload.readUInt32LE(off); off += 4;
        const prgChrCrc32 = payload.readUInt32LE(off); off += 4;

        if (off + 2 + 1 + 1 > payload.length) throw new Error('INFO payload too short for mapper/mirroring');
        const mapperId = payload.readUInt16LE(off); off += 2;
        const submapperId = payload.readUInt8(off); off += 1;
        const mirroring = payload.readUInt8(off); off += 1;

        // sizes (i32) x6
        const need = 4 * 6;
        if (off + need > payload.length) throw new Error('INFO payload too short for sizes');
        const prgRomSize = payload.readInt32LE(off); off += 4;
        const chrRomSize = payload.readInt32LE(off); off += 4;
        const workRamSize = payload.readInt32LE(off); off += 4;
        const saveRamSize = payload.readInt32LE(off); off += 4;
        const chrRamSize = payload.readInt32LE(off); off += 4;
        const saveChrRamSize = payload.readInt32LE(off); off += 4;

        emit({
          hasGame: true,
          fileName: fileNameRead.value,
          sha1: sha1Read.value,
          crc32: `0x${fmtHex(crc32, 8).toLowerCase()}`,
          prgCrc32: `0x${fmtHex(prgCrc32, 8).toLowerCase()}`,
          prgChrCrc32: `0x${fmtHex(prgChrCrc32, 8).toLowerCase()}`,
          mapperId: String(mapperId),
          submapperId: String(submapperId),
          mirroring: String(mirroring),
          prgRomSize: formatBytes(prgRomSize, { includeRaw: true, precision: 2, emptyOnInvalid: true }),
          chrRomSize: formatBytes(chrRomSize, { includeRaw: true, precision: 2, emptyOnInvalid: true }),
          workRamSize: formatBytes(workRamSize, { includeRaw: true, precision: 2, emptyOnInvalid: true }),
          saveRamSize: formatBytes(saveRamSize, { includeRaw: true, precision: 2, emptyOnInvalid: true }),
          chrRamSize: formatBytes(chrRamSize, { includeRaw: true, precision: 2, emptyOnInvalid: true }),
          saveChrRamSize: formatBytes(saveChrRamSize, { includeRaw: true, precision: 2, emptyOnInvalid: true })
        });
        return;
      }

      if (msgType === TraceMsgType.Sync) {
        // v1 SYNC payload is 17 bytes:
        // reason(1) + cpuCycle40(5) + scanline(2) + dot(2) + pc(2) + regs(A,X,Y,SP,PS)(5)
        if (payload.length < 1 + 5 + 2 + 2 + 2 + 5) throw new Error('SYNC payload too short');
        let off = 0;
        const reason = payload.readUInt8(off); off += 1;

        // 5-byte little-endian cpu cycle low40
        let cpuCycle40 = 0n;
        for (let i = 0; i < 5; i++) {
          cpuCycle40 |= BigInt(payload.readUInt8(off + i)) << (8n * BigInt(i));
        }
        off += 5;

        const ppuScanline = payload.readInt16LE(off); off += 2;
        const ppuDot = payload.readUInt16LE(off); off += 2;

        const pc = payload.readUInt16LE(off); off += 2;
        const a = payload.readUInt8(off); off += 1;
        const x = payload.readUInt8(off); off += 1;
        const y = payload.readUInt8(off); off += 1;
        const sp = payload.readUInt8(off); off += 1;
        const ps = payload.readUInt8(off); off += 1;

        const syncObj = {
          reason,
          cpuCycle40: cpuCycle40.toString(),
          ppuScanline,
          ppuDot,
          pc: '0x' + pc.toString(16).padStart(4, '0'),
          a: '0x' + a.toString(16).padStart(2, '0'),
          x: '0x' + x.toString(16).padStart(2, '0'),
          y: '0x' + y.toString(16).padStart(2, '0'),
          sp: '0x' + sp.toString(16).padStart(2, '0'),
          ps: '0x' + ps.toString(16).padStart(2, '0')
        };

        // TEMP: verbose trace-streamer logging for bringup; remove once streaming is high-volume.
        console.log('[TraceStreamer] SYNC', syncObj);

        emit({ lastSync: syncObj });
        return;
      }

      if (msgType === TraceMsgType.Insn) {
        // v1 INSN payload is 13 bytes:
        // cpuCycleDelta(2) + pc(2) + opcode(1) + op1(1) + op2(1) + regs(A,X,Y,SP,PS)(5)
        if (payload.length < 2 + 2 + 1 + 1 + 1 + 5) throw new Error('INSN payload too short');
        let off = 0;
        const cpuCycleDelta = payload.readUInt16LE(off); off += 2;
        const pc = payload.readUInt16LE(off); off += 2;
        const opcode = payload.readUInt8(off); off += 1;
        const op1 = payload.readUInt8(off); off += 1;
        const op2 = payload.readUInt8(off); off += 1;
        const a = payload.readUInt8(off); off += 1;
        const x = payload.readUInt8(off); off += 1;
        const y = payload.readUInt8(off); off += 1;
        const sp = payload.readUInt8(off); off += 1;
        const ps = payload.readUInt8(off); off += 1;

        // TODO: Hook this into the actual trace ingestion pipeline.
        // For now, we decode it and drop it on the floor.
        // (Do NOT add console logging here; INSN is extremely high-volume.)
        void cpuCycleDelta;
        void pc;
        void opcode;
        void op1;
        void op2;
        void a;
        void x;
        void y;
        void sp;
        void ps;
        return;
      }

      // Unknown message types are ignored; payloadLen lets us skip safely.
      return;
    } catch (err) {
      emit({ lastError: `Protocol decode error: ${String(err.message || err)}` });
      // Protocol errors should drop the connection for now.
      disconnect();
    }
  };

  const parseFrames = () => {
    while (rxBuf.length >= 3) {
      const msgType = rxBuf.readUInt8(0);
      const payloadLen = rxBuf.readUInt16LE(1);
      const total = 3 + payloadLen;
      if (rxBuf.length < total) return;
      const payload = payloadLen ? rxBuf.subarray(3, total) : Buffer.alloc(0);
      rxBuf = rxBuf.subarray(total);
      handleMessage(msgType, payload);
    }
  };

  const attachSocket = (sock, port) => {
    socket = sock;
    rxBuf = Buffer.alloc(0);
    awaitingGoodbyeAck = false;
    clearGoodbyeTimer();

    socket.on('data', (chunk) => {
      rxBuf = rxBuf.length ? Buffer.concat([rxBuf, chunk]) : chunk;
      parseFrames();
    });

    socket.on('error', (err) => {
      // If the socket errors, we'll also get close; keep the lastError for UI.
      emit({ lastError: String(err.message || err) });
    });

    socket.on('close', () => {
      setDisconnected(null);
    });

    emit({
      connected: true,
      connecting: false,
      port,
      lastError: null
    });

    send(encodeHello());
  };

  async function connect() {
    if (connecting || (socket && !socket.destroyed)) return { ok: true };

    connecting = true;
    emit({ connecting: true, lastError: null });

    let lastErr = null;
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const port = START_PORT + i;
      try {
        const sock = await attemptConnect(port);
        connecting = false;
        attachSocket(sock, port);
        return { ok: true, port };
      } catch (err) {
        lastErr = err;
        // Continue probing.
      }
    }

    connecting = false;
    emit({ connecting: false, lastError: lastErr ? String(lastErr.message || lastErr) : 'Failed to connect' });
    return { ok: false, error: lastErr ? String(lastErr.message || lastErr) : 'Failed to connect' };
  }

  function disconnect() {
    connecting = false;

    if (!socket || socket.destroyed) {
      setDisconnected(null);
      return { ok: true };
    }

    if (!awaitingGoodbyeAck) {
      awaitingGoodbyeAck = true;
      send(encodeGoodbye(GoodbyeReason.ClientRequest));

      clearGoodbyeTimer();
      // If the server doesn't ack, tear down anyway.
      goodbyeTimer = setTimeout(() => {
        try {
          if (socket && !socket.destroyed) socket.destroy();
        } catch {}
        setDisconnected(null);
      }, 500);
    }

    return { ok: true };
  }

  function getStatus() {
    return state;
  }

  return {
    connect,
    disconnect,
    getStatus
  };
}
