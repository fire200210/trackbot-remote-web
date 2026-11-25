import { Joystick } from "./joystick.js";
import { BleProvisioner } from "./ble-provision.js";
import { WsControl } from "./ws-control.js";
import { axesToCmdVel } from "./protocol.js";
import { loadWifi, saveWifi } from "./storage.js";

const els = {
  panel: document.getElementById("connect-panel"),
  btnPanel: document.getElementById("btn-panel"),
  btnFullscreen: document.getElementById("btn-fullscreen"),
  statusBle: document.getElementById("status-ble"),
  statusIp: document.getElementById("status-ip"),
  statusWs: document.getElementById("status-ws"),
  wifiSsid: document.getElementById("wifi-ssid"),
  wifiPassword: document.getElementById("wifi-password"),
  btnBleConnect: document.getElementById("btn-ble-connect"),
  btnBleDisconnect: document.getElementById("btn-ble-disconnect"),
  btnWifiSend: document.getElementById("btn-wifi-send"),
  bleMsg: document.getElementById("ble-msg"),
  secureHint: document.getElementById("secure-hint"),
  wifiMsg: document.getElementById("wifi-msg"),
  manualIp: document.getElementById("manual-ip"),
  btnWs: document.getElementById("btn-ws"),
  btnWsDisconnect: document.getElementById("btn-ws-disconnect"),
  wsMsg: document.getElementById("ws-msg"),
  readoutThrottle: document.getElementById("readout-throttle"),
  readoutFine: document.getElementById("readout-fine"),
  readoutPacket: document.getElementById("readout-packet"),
  btnNav: document.getElementById("btn-nav"),
  statusNav: document.getElementById("status-nav"),
};

const state = {
  t: 0,
  fx: 0,
  fy: 0,
  ip: "",
  gotIpAfterBle: false,
  /** True while tab is hidden; keep WS up but force zero axes (Android notifies can flip visibility). */
  pageHidden: false,
  navPending: false,
};

const ble = new BleProvisioner();
const ws = new WsControl();

new Joystick(document.getElementById("stick-throttle"), {
  mode: "throttle",
  onChange: (v) => {
    state.t = v.t;
    updateReadouts();
    ws.kick(); /* touch-path send — timers alone are throttled on Android */
  },
});

new Joystick(document.getElementById("stick-fine"), {
  mode: "fine",
  onChange: (v) => {
    state.fx = v.x;
    state.fy = v.y;
    updateReadouts();
    ws.kick();
  },
});

/**
 * Single remote: while WS is up, block opening another link path on this page.
 * @param {boolean} linked
 */
function setLinkedUi(linked) {
  els.btnBleConnect.disabled = linked;
  els.btnWifiSend.disabled = linked;
  els.btnWs.disabled = linked;
}

ws.configure({
  getAxes: () =>
    state.pageHidden
      ? { t: 0, fx: 0, fy: 0 }
      : { t: state.t, fx: state.fx, fy: state.fy },
  onState: ({ connected, message, degraded, reconnecting, connecting }) => {
    if (connected && degraded) {
      setPill(els.statusWs, "WS: 不穩", "warn");
    } else if (reconnecting) {
      setPill(els.statusWs, "WS: 重連中", "warn");
    } else if (connecting) {
      setPill(els.statusWs, "WS: 連線中", "warn");
    } else if (connected) {
      setPill(els.statusWs, "WS: 已連", "ok");
    } else {
      setPill(els.statusWs, "WS: 未連", "");
    }
    els.wsMsg.textContent = connected ? `${message}（單控端）` : message;
    /* Lock while linked, reconnecting, or handshake-in-flight (avoids double connect). */
    setLinkedUi(connected || !!reconnecting || !!connecting);
    if (!connected) {
      state.navPending = false;
      syncNavUi(false);
    } else {
      syncNavUi(ws.navEnable);
    }
  },
});

/**
 * Fill IP from BLE (session only) + connect WS. No localStorage for IP.
 * @param {string} ip
 * @param {string} [msg]
 */
async function applyEspIpAndConnect(ip, msg) {
  state.gotIpAfterBle = true;
  state.ip = ip;
  els.manualIp.value = ip;
  const ssid = els.wifiSsid.value.trim();
  if (ssid) {
    saveWifi(ssid, els.wifiPassword.value);
  }
  setPill(els.statusBle, "BLE: 已取得 IP", "ok");
  setPill(els.statusIp, `IP: ${ip}`, "ok");
  els.wifiMsg.textContent = msg || `已填入 IP ${ip}，正在連 WebSocket…`;
  els.bleMsg.textContent = `ESP32 IP: ${ip}`;
  try {
    await ws.connect(ip);
  } catch (err) {
    els.wifiMsg.textContent = err instanceof Error ? err.message : String(err);
  }
}

ble.setHandlers({
  onStatus: (status) => {
    if (status.state === "connecting") {
      setPill(els.statusBle, "BLE: 配網中", "warn");
      els.wifiMsg.textContent = status.msg || "WiFi 連線中…";
      return;
    }
    if (status.state === "ok" && status.ip) {
      void applyEspIpAndConnect(status.ip, status.msg);
      return;
    }
    if (status.state === "pairing") {
      return;
    }
    setPill(els.statusBle, "BLE: 配網失敗", "bad");
    els.wifiMsg.textContent = status.msg || "配網失敗";
  },
  onDisconnect: () => {
    setPill(els.statusBle, "BLE: 未連", "");
    els.bleMsg.textContent = "藍牙已斷開";
  },
});

els.btnPanel.addEventListener("click", () => {
  const open = els.panel.hidden;
  els.panel.hidden = !open;
  els.btnPanel.setAttribute("aria-expanded", open ? "true" : "false");
});

function fullscreenElement() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    null
  );
}

function syncFullscreenUi() {
  const on = !!fullscreenElement();
  document.getElementById("app")?.classList.toggle("is-fullscreen", on);
  if (els.btnFullscreen) {
    els.btnFullscreen.textContent = on ? "退出全螢幕" : "全螢幕";
  }
}

async function toggleFullscreen() {
  try {
    if (fullscreenElement()) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } else {
      const root = document.documentElement;
      if (root.requestFullscreen) {
        await root.requestFullscreen({ navigationUI: "hide" });
      } else if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
      } else {
        els.wsMsg.textContent = "此瀏覽器不支援全螢幕 API，可改用「加入主畫面」全螢幕開啟";
      }
    }
  } catch (err) {
    els.wsMsg.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    syncFullscreenUi();
  }
}

els.btnFullscreen?.addEventListener("click", () => {
  toggleFullscreen();
});
document.addEventListener("fullscreenchange", syncFullscreenUi);
document.addEventListener("webkitfullscreenchange", syncFullscreenUi);

els.btnBleConnect.addEventListener("click", async () => {
  els.bleMsg.textContent = "請選擇 TrackBot 裝置…";
  setPill(els.statusBle, "BLE: 選擇中", "warn");
  els.btnBleConnect.disabled = true;
  state.gotIpAfterBle = false;
  try {
    await ble.connect();
    const name = ble.deviceName || "TrackBot";
    setPill(els.statusBle, "BLE: 已連", "ok");
    els.bleMsg.textContent = `已連線 ${name}，等待 ESP 推送 IP…`;
    els.wifiMsg.textContent = "輪詢 STATUS（Notify / Read）…";

    let ready = await ble.waitForReadyIp(4000, 300);
    if (ready?.ip) {
      await applyEspIpAndConnect(ready.ip, "已從藍牙取得 IP");
      els.bleMsg.textContent = `已連線 ${name}；IP ${ready.ip} 已填入並連線`;
      return;
    }

    const ssid = els.wifiSsid.value.trim();
    const password = els.wifiPassword.value;
    if (!ssid) {
      els.bleMsg.textContent = `已連線 ${name}；尚未拿到 IP，請填 WiFi 後送出`;
      els.wifiMsg.textContent = "裝置可能還在配網模式，請輸入 SSID/密碼";
      return;
    }

    els.wifiMsg.textContent = "尚未拿到 IP，自動送出 WiFi…";
    await ble.sendWifiConfig(ssid, password);
    saveWifi(ssid, password);
    setPill(els.statusBle, "BLE: 配網中", "warn");
    els.bleMsg.textContent = `已連線 ${name}；已送 WiFi，等待 IP…`;

    ready = await ble.waitForReadyIp(15000, 400);
    if (ready?.ip) {
      await applyEspIpAndConnect(ready.ip, "配網成功，已填入 IP");
      els.bleMsg.textContent = `配網完成；IP ${ready.ip} 已填入並連線`;
    } else {
      els.wifiMsg.textContent = "逾時仍未取得 IP，請看串口或手動填 IP";
    }
  } catch (err) {
    setPill(els.statusBle, "BLE: 未連", "bad");
    els.bleMsg.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    els.btnBleConnect.disabled = false;
  }
});

els.btnBleDisconnect.addEventListener("click", async () => {
  await ble.disconnect();
  setPill(els.statusBle, "BLE: 未連", "");
  els.bleMsg.textContent = "已斷開藍牙";
});

els.btnWifiSend.addEventListener("click", async () => {
  els.wifiMsg.textContent = "送出 WiFi 設定中…";
  els.btnWifiSend.disabled = true;
  try {
    const ssid = els.wifiSsid.value.trim();
    const password = els.wifiPassword.value;
    await ble.sendWifiConfig(ssid, password);
    saveWifi(ssid, password);
    els.wifiMsg.textContent = "已送出，等待 ESP32 回報 IP…";
    setPill(els.statusBle, "BLE: 配網中", "warn");
    const ready = await ble.waitForReadyIp(15000, 400);
    if (ready?.ip) {
      await applyEspIpAndConnect(ready.ip, "配網成功，已填入 IP");
    }
  } catch (err) {
    els.wifiMsg.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    els.btnWifiSend.disabled = false;
  }
});

els.btnWs.addEventListener("click", async () => {
  const ip = els.manualIp.value.trim();
  if (!ip) {
    els.wsMsg.textContent = "請輸入 ESP32 IP";
    return;
  }
  state.ip = ip;
  setPill(els.statusIp, `IP: ${ip}`, "ok");
  els.btnWs.disabled = true;
  try {
    await ws.connect(ip);
  } catch (err) {
    els.wsMsg.textContent = err instanceof Error ? err.message : String(err);
    setLinkedUi(false);
  }
});

els.btnWsDisconnect.addEventListener("click", async () => {
  els.btnWsDisconnect.disabled = true;
  try {
    await ws.disconnectAsync();
  } finally {
    els.btnWsDisconnect.disabled = false;
    setLinkedUi(false);
  }
});

/* Close WS only on real navigation/unload (not visibility — Android false-fires on notify shade). */
function closeWsOnLeave() {
  ws.disconnect();
}
window.addEventListener("pagehide", closeWsOnLeave);
window.addEventListener("beforeunload", closeWsOnLeave);

/* Hidden: keep WS, force zero axes so the robot stops without dropping the link. */
document.addEventListener("visibilitychange", () => {
  const hidden = document.visibilityState === "hidden";
  state.pageHidden = hidden;
  if (ws.connected) {
    ws.kick();
  }
});

function updateReadouts() {
  const axes = ws.navEnable
    ? { t: 0, fx: 0, fy: 0 }
    : { t: state.t, fx: state.fx, fy: state.fy };
  const cmd = axesToCmdVel(axes);
  els.readoutThrottle.textContent = `${Math.round(state.t * 100)}%`;
  els.readoutFine.textContent = `X ${fmt(state.fx)} · Y ${fmt(state.fy)}`;
  els.readoutPacket.textContent = `v=${fmt(cmd.v)} w=${fmt(cmd.w)}`;
}

/**
 * @param {boolean} enabled
 * @param {"idle"|"pending"|"fail"} [mode]
 */
function syncNavUi(enabled, mode = "idle") {
  if (!els.btnNav || !els.statusNav) return;
  const pending = mode === "pending" || state.navPending;
  els.btnNav.disabled = !ws.connected || pending;
  els.btnNav.setAttribute("aria-pressed", enabled ? "true" : "false");
  els.btnNav.textContent = enabled ? "導航：開" : "導航：關";
  els.statusNav.classList.remove("ok", "warn", "bad");
  if (pending) {
    els.statusNav.textContent = "切換中…";
    els.statusNav.classList.add("warn");
  } else if (mode === "fail") {
    els.statusNav.textContent = "切換失敗，請重試";
    els.statusNav.classList.add("bad");
  } else if (enabled) {
    els.statusNav.textContent = "Orin 導航（搖桿暫停）";
    els.statusNav.classList.add("ok");
  } else {
    els.statusNav.textContent = "手動遙控";
  }
  updateReadouts();
}

els.btnNav?.addEventListener("click", async () => {
  if (!ws.connected || state.navPending) return;
  const next = !ws.navEnable;
  state.navPending = true;
  syncNavUi(ws.navEnable, "pending");
  const ok = await ws.setNavEnable(next);
  state.navPending = false;
  if (ok) {
    syncNavUi(ws.navEnable);
  } else {
    syncNavUi(ws.navEnable, "fail");
  }
});

function fmt(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Link-status dots (BLE/WS) keep short labels; detail goes to title.
 * IP element shows address text (strips optional "IP:" prefix).
 * @param {HTMLElement} el
 * @param {string} detail
 * @param {"" | "ok" | "warn" | "bad"} kind
 */
function setPill(el, detail, kind) {
  el.classList.remove("ok", "warn", "bad");
  if (kind) el.classList.add(kind);
  if (el === els.statusIp) {
    const raw = String(detail || "").replace(/^IP:\s*/i, "").trim();
    el.textContent = raw && raw !== "—" ? raw : "—";
    el.title = raw && raw !== "—" ? `IP: ${raw}` : "IP: —";
  } else {
    el.title = detail;
    el.setAttribute("aria-label", detail);
  }
}

function prefillsWifiFromStorage() {
  const wifi = loadWifi();
  if (wifi.ssid) {
    els.wifiSsid.value = wifi.ssid;
  }
  if (wifi.password) {
    els.wifiPassword.value = wifi.password;
  }
}

if (navigator.wakeLock) {
  const requestLock = async () => {
    try {
      await navigator.wakeLock.request("screen");
    } catch {
      /* ignore */
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestLock();
  });
  requestLock();
}

syncNavUi(false);

{
  const secure = window.isSecureContext;
  const hasBt = BleProvisioner.supported();
  if (els.secureHint) {
    els.secureHint.textContent = `安全來源: ${secure ? "是" : "否"} · Web Bluetooth: ${hasBt ? "可用" : "不可用"}`;
    els.secureHint.classList.toggle("bad-hint", !secure || !hasBt);
  }
  if (!hasBt) {
    els.bleMsg.textContent = secure
      ? "請改用 Android Chrome（此瀏覽器無 Web Bluetooth）。"
      : "目前不是安全來源。請改用 npm start 的 HTTPS，或 chrome://flags 將本頁設為 insecure origin treated as secure。";
    setPill(els.statusBle, "BLE: 不支援", "bad");
  } else {
    els.bleMsg.textContent =
      "請按「連線藍牙」取得 IP（不記在本機）；填入後自動 WS。關掉頁面／斷 WS 後 ESP 會再開 BLE。";
  }
}

prefillsWifiFromStorage();

document.body.addEventListener(
  "touchmove",
  (e) => {
    if (e.target.closest?.(".connect-panel")) return;
    e.preventDefault();
  },
  { passive: false },
);
