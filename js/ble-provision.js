import { BLE, encodeWifiConfig, parseStatusNotify } from "./protocol.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

/**
 * Web Bluetooth WiFi provisioning client (Android Chrome).
 * Connect BLE first, then send WiFi credentials as a separate step.
 */
export class BleProvisioner {
  constructor() {
    this.device = null;
    this.server = null;
    this.configChar = null;
    this.statusChar = null;
    this._onStatus = null;
    this._onDisconnect = null;
    this._statusListener = null;
    /** @type {{ state: string, ip?: string, msg?: string } | null} */
    this._lastStatus = null;
  }

  static supported() {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  /**
   * @param {{ onStatus?: (s: { state: string, ip?: string, msg?: string }) => void, onDisconnect?: () => void }} handlers
   */
  setHandlers(handlers = {}) {
    this._onStatus = handlers.onStatus || null;
    this._onDisconnect = handlers.onDisconnect || null;
  }

  /**
   * @param {{ state: string, ip?: string, msg?: string }} status
   */
  _emitStatus(status) {
    this._lastStatus = status;
    this._onStatus?.(status);
  }

  /**
   * Only select device + connect GATT + subscribe STATUS. Does not send WiFi.
   */
  async connect() {
    if (!BleProvisioner.supported()) {
      throw new Error(
        "此瀏覽器不支援 Web Bluetooth。請用 Android Chrome，並以安全來源開啟（localhost / HTTPS，或 chrome://flags 將本頁網址設為 insecure origin treated as secure）",
      );
    }

    await this.disconnect();
    this._lastStatus = null;

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: BLE.deviceNamePrefix }],
      optionalServices: [BLE.service],
    });

    this.device.addEventListener("gattserverdisconnected", () => {
      this._cleanupRefs();
      this._onDisconnect?.();
    });

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(BLE.service);
    this.configChar = await service.getCharacteristic(BLE.wifiConfig);
    this.statusChar = await service.getCharacteristic(BLE.status);

    this._statusListener = (event) => {
      try {
        const raw = textDecoder.decode(event.target.value);
        const status = parseStatusNotify(raw);
        this._emitStatus(status);
      } catch (err) {
        this._emitStatus({
          state: "fail",
          msg: err instanceof Error ? err.message : String(err),
        });
      }
    };

    await this.statusChar.startNotifications();
    this.statusChar.addEventListener("characteristicvaluechanged", this._statusListener);
  }

  /**
   * Poll STATUS Read until ok+ip (Notify also updates _lastStatus).
   * @param {number} timeoutMs
   * @param {number} intervalMs
   * @returns {Promise<{ state: string, ip?: string, msg?: string } | null>}
   */
  async waitForReadyIp(timeoutMs = 4000, intervalMs = 300) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._lastStatus?.state === "ok" && this._lastStatus.ip) {
        return this._lastStatus;
      }
      if (this.statusChar) {
        try {
          const value = await this.statusChar.readValue();
          const raw = textDecoder.decode(value);
          const status = parseStatusNotify(raw);
          if (status.state === "ok" || status.state === "connecting" || status.state === "fail") {
            this._emitStatus(status);
          }
          if (status.state === "ok" && status.ip) {
            return status;
          }
        } catch {
          /* keep polling */
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (this._lastStatus?.state === "ok" && this._lastStatus.ip) {
      return this._lastStatus;
    }
    return null;
  }

  /**
   * Write WiFi SSID/password. Requires an active BLE connection.
   * @param {string} ssid
   * @param {string} password
   */
  async sendWifiConfig(ssid, password) {
    if (!this.connected || !this.configChar) {
      throw new Error("請先按「連線藍牙」");
    }
    if (!ssid) {
      throw new Error("請輸入 WiFi SSID");
    }
    const payload = encodeWifiConfig(ssid, password || "");
    await this.configChar.writeValue(textEncoder.encode(payload));
  }

  async disconnect() {
    try {
      if (this.statusChar && this._statusListener) {
        try {
          this.statusChar.removeEventListener("characteristicvaluechanged", this._statusListener);
          await this.statusChar.stopNotifications();
        } catch {
          /* ignore */
        }
      }
      if (this.device?.gatt?.connected) {
        this.device.gatt.disconnect();
      }
    } finally {
      this._statusListener = null;
      this._cleanupRefs();
      this.device = null;
    }
  }

  get connected() {
    return !!(this.device?.gatt?.connected);
  }

  get deviceName() {
    return this.device?.name || "";
  }

  _cleanupRefs() {
    this.server = null;
    this.configChar = null;
    this.statusChar = null;
  }
}
