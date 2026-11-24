/**
 * Shared protocol contract with ESP32 firmware (step 2).
 * Keep UUIDs / ports / JSON keys in sync on both sides.
 *
 * WebSocket:
 * - Phone -> ESP: {"v","w","seq"}  (v cm/s, w=ω rad/s)
 * - ESP -> Phone: {"a":1,"seq"} ack (echo) or periodic pong (rate-limited ~200ms)
 */

export const WS_PORT = 81;

/** Provisional max linear speed (cm/s); tune after field test. */
export const V_MAX_CM_S = 50;

/** Provisional max yaw rate (rad/s); tune after field test. */
export const OMEGA_MAX_RAD_S = 1.0;

/**
 * Inner |Rx| gate before yaw engages. 0 = linear ω from center
 * (joystick pointer deadzone already filters finger noise).
 */
export const STEER_GATE = 0;

/** |Ry| below this → no forward/back direction. */
export const DIR_DEADZONE = 0.15;

export const BLE = Object.freeze({
  /** Prefer matching by name filter; service UUID is required for GATT. */
  deviceNamePrefix: "TrackBot",
  service: "0000fff0-0000-1000-8000-00805f9b34fb",
  /** Write: {"ssid":"...","password":"..."} */
  wifiConfig: "0000fff1-0000-1000-8000-00805f9b34fb",
  /** Notify: {"state":"connecting|ok|fail","ip":"...","msg":"..."} */
  status: "0000fff2-0000-1000-8000-00805f9b34fb",
});

/**
 * @param {string} ssid
 * @param {string} password
 * @returns {string}
 */
export function encodeWifiConfig(ssid, password) {
  return JSON.stringify({ ssid, password });
}

/**
 * @param {string} text
 * @returns {{ state: string, ip?: string, msg?: string }}
 */
export function parseStatusNotify(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.state !== "string") {
    throw new Error("Invalid STATUS payload");
  }
  return data;
}

/**
 * Joystick axes → body cmd_vel (STM32 open-loop contract).
 * Ly=t speed; Ry → forward/back sign only; ω ∝ Rx (spin-in-place when v=0).
 * Rx=−fx (web right+ → doc left+).
 * @param {{ t: number, fx: number, fy: number }} axes
 * @returns {{ v: number, w: number }}
 */
export function axesToCmdVel({ t, fx, fy }) {
  const Ly = clamp(t, 0, 1);
  const Ry = clamp(fy, -1, 1);
  const Rx = -clamp(fx, -1, 1);
  const dir = Math.abs(Ry) < DIR_DEADZONE ? 0 : Ry > 0 ? 1 : -1;
  const v = V_MAX_CM_S * Ly * dir;
  const ax = Math.abs(Rx);
  const span = 1 - STEER_GATE;
  const w =
    ax <= STEER_GATE || span <= 0
      ? 0
      : OMEGA_MAX_RAD_S * Math.sign(Rx) * ((ax - STEER_GATE) / span);
  return { v, w };
}

/**
 * Control frame sent over WebSocket (joystick kick + ~200ms heartbeat).
 * @param {{ v: number, w: number, seq: number }} values
 * @returns {string}
 */
export function encodeControlFrame({ v, w, seq }) {
  return JSON.stringify({
    v: round3(Number(v) || 0),
    w: round3(Number(w) || 0),
    seq: seq | 0,
  });
}

/**
 * Parse ESP ack frame. Returns null on invalid payload (no throw).
 * @param {string} text
 * @returns {{ a: number, seq: number } | null}
 */
export function parseAckFrame(text) {
  try {
    const data = JSON.parse(text);
    if (!data || data.a !== 1) {
      return null;
    }
    return { a: 1, seq: Number(data.seq) || 0 };
  } catch {
    return null;
  }
}

/**
 * @param {string} ip
 * @returns {string}
 */
export function wsUrlForIp(ip) {
  const host = String(ip || "").trim();
  if (!host) {
    throw new Error("IP is empty");
  }
  return `ws://${host}:${WS_PORT}/`;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Number(n) || 0));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
