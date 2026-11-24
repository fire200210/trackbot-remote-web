import { axesToCmdVel, encodeControlFrame, parseAckFrame, wsUrlForIp } from "./protocol.js";

const CLOSE_RX_TIMEOUT = 4001;
const CLOSE_BUFFER_STUCK = 4002;
const CLOSE_SEND_FAIL = 4003;

/**
 * WebSocket control channel to ESP32.
 * Single socket: always await prior close before opening a new one
 * (prevents ESP count=2 / ghost sessions).
 *
 * Heartbeat runs in a Web Worker (fallback: main-thread setInterval).
 * Link health is tiered: soft warn ~2s without ack (keep socket);
 * hard close ~10s then session-IP auto-reconnect (unless user disconnected).
 */
export class WsControl {
  constructor() {
    this.ws = null;
    this.seq = 0;
    this._timer = null;
    this._worker = null;
    this._getAxes = () => ({ t: 0, fx: 0, fy: 0 }); /* joystick axes; converted to v/w on send */
    this._onState = null;
    this._connectGen = 0;
    /** Keep-alive interval (ms). */
    this.heartbeatMs = 200;
    /** Soft: UI degraded, keep socket. */
    this.rxSoftMs = 2000;
    /** Hard: declare dead + close. */
    this.rxHardMs = 10000;
    /** Skip motion-only updates when outbound buffer is backed up. */
    this.maxBufferedBytes = 8192;
    /** bufferedAmount above max for this long → hard dead. */
    this.bufferStuckMs = 5000;
    /** WebSocket handshake must finish within this (Chrome has no short default). */
    this.openTimeoutMs = 4000;
    /**
     * After close, wait before next handshake so ESP can free the lwIP fd
     * (rapid connect/disconnect otherwise hits accept ENFILE).
     */
    this.postCloseGapMs = 400;
    /** Extra cooldown after user disconnect before allowing connect(). */
    this.disconnectCooldownMs = 500;
    this.autoReconnect = true;
    this.reconnectMax = 5;
    this._lastIp = "";
    this._userClosed = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._cooldownUntil = 0;
    this._degraded = false;
    this._lastSent = { v: NaN, w: NaN };
    this._lastSendAt = 0;
    this._lastRxAt = 0;
    this._bufferHighSince = 0;
  }

  /**
   * @param {{
   *   getAxes: () => { t: number, fx: number, fy: number },  // converted to v/w before send
   *   onState?: (s: { connected: boolean, message: string, degraded?: boolean, reconnecting?: boolean }) => void
   * }} opts
   */
  configure(opts) {
    this._getAxes = opts.getAxes;
    this._onState = opts.onState || null;
  }

  /**
   * User / BLE initiated connect: fresh retry budget.
   * @param {string} ip
   */
  connect(ip) {
    this._reconnectAttempt = 0;
    return this._connect(ip);
  }

  /**
   * @param {string} ip
   */
  async _connect(ip) {
    const host = String(ip || "").trim();
    if (!host) {
      throw new Error("IP is empty");
    }

    const gen = ++this._connectGen;
    this._userClosed = false;
    this._lastIp = host;
    this._cancelReconnect();

    const coolLeft = this._cooldownUntil - performance.now();
    if (coolLeft > 0) {
      this._emit(false, "等待裝置釋放連線…", { connecting: true });
      await sleep(coolLeft);
      if (gen !== this._connectGen) return;
    }

    await this._closeSocketOnly();
    if (gen !== this._connectGen) return;

    /* Let ESP finish CLOSE + free the socket slot before the next handshake. */
    await sleep(this.postCloseGapMs);
    if (gen !== this._connectGen) return;

    const url = wsUrlForIp(host);
    this._emit(false, `連線中 ${url}`, {
      reconnecting: this._reconnectAttempt > 0,
      connecting: true,
    });

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._emit(false, err instanceof Error ? err.message : String(err));
      this._scheduleReconnect();
      throw err;
    }

    if (gen !== this._connectGen) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }

    this.ws = ws;
    this._lastSent = { v: NaN, w: NaN };
    this._lastSendAt = 0;
    this._lastRxAt = 0;
    this._bufferHighSince = 0;
    this._degraded = false;

    const openTimer = window.setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      console.warn(`[ws] open timeout after ${this.openTimeoutMs}ms`);
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this._emit(false, "連線逾時（握手）");
      this._scheduleReconnect();
    }, this.openTimeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      if (this.ws !== ws || this._userClosed) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      const now = performance.now();
      this._lastRxAt = now;
      this._bufferHighSince = 0;
      this._degraded = false;
      this._reconnectAttempt = 0;
      this._emit(true, `已連線 ${url}`);
      this._startLoop();
      this._sendFrame(true);
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      const text = typeof event.data === "string" ? event.data : "";
      if (parseAckFrame(text)) {
        this._lastRxAt = performance.now();
        if (this._degraded) {
          this._degraded = false;
          this._emit(true, `已連線 ${wsUrlForIp(this._lastIp)}`);
        }
      }
    });

    ws.addEventListener("close", (event) => {
      clearTimeout(openTimer);
      console.info(
        `[ws] close code=${event.code} reason=${event.reason || "-"} clean=${event.wasClean}`,
      );
      this._stopLoop();
      if (this.ws === ws) {
        this.ws = null;
        this._emit(false, "已斷線");
        this._scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      if (this.ws === ws) {
        this._emit(false, "WebSocket 錯誤");
      }
    });
  }

  /** Sync close for pagehide / beforeunload (cannot await). */
  disconnect() {
    void this.disconnectAsync();
  }

  /**
   * User-initiated close: disables auto-reconnect and cancels in-flight connect.
   */
  async disconnectAsync() {
    this._userClosed = true;
    this._connectGen++;
    this._cancelReconnect();
    this._reconnectAttempt = 0;
    await this._closeSocketOnly("已斷線");
    this._cooldownUntil = performance.now() + this.disconnectCooldownMs;
  }

  /**
   * Close socket without marking user intent (used before reconnect / connect).
   * @param {string} [message]
   */
  _closeSocketOnly(message = "已斷線") {
    this._stopLoop();
    if (!this.ws) {
      this._emit(false, message);
      return Promise.resolve();
    }

    const sock = this.ws;
    this.ws = null;
    this._emit(false, message);

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, 500);
      try {
        sock.addEventListener("close", finish, { once: true });
        sock.close(1000, "client disconnect");
      } catch {
        finish();
      }
    });
  }

  /**
   * Call from joystick move for low-latency motion frames.
   */
  kick() {
    this._sendFrame(false);
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  _cancelReconnect() {
    if (this._reconnectTimer != null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _scheduleReconnect() {
    if (!this.autoReconnect || this._userClosed || !this._lastIp) {
      return;
    }
    if (this._reconnectAttempt >= this.reconnectMax) {
      this._emit(false, "重連次數已用盡，請重新連藍牙或手動連線");
      return;
    }
    if (this._reconnectTimer != null) {
      return;
    }

    const attempt = this._reconnectAttempt;
    const delay = Math.min(4000, 500 * 2 ** attempt);
    this._emit(false, `重連中…（${attempt + 1}/${this.reconnectMax}）`, {
      reconnecting: true,
    });
    this._reconnectTimer = window.setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectAttempt = attempt + 1;
      void this._connect(this._lastIp).catch(() => {
        /* connect schedules further retries on failure paths */
      });
    }, delay);
  }

  _startLoop() {
    this._stopLoop();
    try {
      const worker = new Worker(new URL("./ws-heartbeat-worker.js", import.meta.url));
      worker.onmessage = (event) => {
        if (event.data?.type === "tick") {
          this._sendFrame(false);
        }
      };
      worker.onerror = () => {
        this._stopWorkerOnly();
        this._startFallbackTimer();
      };
      worker.postMessage({ type: "start", intervalMs: this.heartbeatMs });
      this._worker = worker;
    } catch {
      this._startFallbackTimer();
    }
  }

  _startFallbackTimer() {
    if (this._timer != null) return;
    this._timer = window.setInterval(() => this._sendFrame(false), this.heartbeatMs);
  }

  _stopWorkerOnly() {
    if (!this._worker) return;
    try {
      this._worker.postMessage({ type: "stop" });
    } catch {
      /* ignore */
    }
    try {
      this._worker.terminate();
    } catch {
      /* ignore */
    }
    this._worker = null;
  }

  _stopLoop() {
    this._stopWorkerOnly();
    if (this._timer != null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * @returns {boolean} true if socket still usable (soft degrade counts as alive)
   */
  _checkAlive() {
    if (!this.connected || !this.ws) return false;
    const now = performance.now();

    if (this._lastRxAt > 0) {
      const age = now - this._lastRxAt;
      if (age >= this.rxHardMs) {
        this._declareDead("連線逾時", CLOSE_RX_TIMEOUT, "rx timeout");
        return false;
      }
      if (age >= this.rxSoftMs && !this._degraded) {
        this._degraded = true;
        this._emit(true, "連線不穩", { degraded: true });
      }
    }

    const buffered = this.ws.bufferedAmount;
    if (buffered > this.maxBufferedBytes) {
      if (this._bufferHighSince === 0) {
        this._bufferHighSince = now;
      } else if (now - this._bufferHighSince >= this.bufferStuckMs) {
        this._declareDead("傳送壅塞", CLOSE_BUFFER_STUCK, "buffer stuck");
        return false;
      }
    } else {
      this._bufferHighSince = 0;
    }

    return true;
  }

  /**
   * @param {string} message
   * @param {number} code  4000-4999 app close code (logged by ESP)
   * @param {string} reason
   */
  _declareDead(message, code, reason) {
    console.warn(`[ws] declare dead: ${reason} (${code})`);
    this._stopLoop();
    const sock = this.ws;
    this.ws = null;
    this._degraded = false;
    const willRetry =
      this.autoReconnect && !this._userClosed && !!this._lastIp && this._reconnectAttempt < this.reconnectMax;
    this._emit(false, message, { reconnecting: willRetry });
    if (sock) {
      try {
        sock.close(code, reason);
      } catch {
        /* ignore */
      }
    }
    this._scheduleReconnect();
  }

  _cmdChanged(cmd) {
    const eps = 0.01;
    return (
      Math.abs(cmd.v - this._lastSent.v) > eps ||
      Math.abs(cmd.w - this._lastSent.w) > eps
    );
  }

  /**
   * @param {boolean} force  send even if unchanged / not due (open / explicit)
   */
  _sendFrame(force) {
    if (!this._checkAlive()) return;
    if (!this.connected || !this.ws) return;

    const axes = this._getAxes();
    const cmd = axesToCmdVel(axes);
    const now = performance.now();
    const dueHeartbeat = now - this._lastSendAt >= this.heartbeatMs;
    const changed = this._cmdChanged(cmd);
    if (!force && !changed && !dueHeartbeat) {
      return;
    }

    const buffered = this.ws.bufferedAmount;
    if (!force && changed && !dueHeartbeat && buffered > this.maxBufferedBytes) {
      return;
    }

    this.seq = (this.seq + 1) >>> 0;
    const frame = encodeControlFrame({
      v: cmd.v,
      w: cmd.w,
      seq: this.seq,
    });
    try {
      this.ws.send(frame);
      this._lastSent = { v: cmd.v, w: cmd.w };
      this._lastSendAt = now;
    } catch {
      this._declareDead("傳送失敗", CLOSE_SEND_FAIL, "send fail");
    }
  }

  /**
   * @param {boolean} connected
   * @param {string} message
   * @param {{ degraded?: boolean, reconnecting?: boolean, connecting?: boolean }} [extra]
   */
  _emit(connected, message, extra = {}) {
    this._onState?.({
      connected,
      message,
      degraded: !!extra.degraded,
      reconnecting: !!extra.reconnecting,
      connecting: !!extra.connecting,
    });
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
