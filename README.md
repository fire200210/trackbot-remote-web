# 履帶車手機遙控 Web（第一步）

Android Chrome 用的靜態遙控頁：雙虛擬搖桿、BLE 送 WiFi SSID+密碼、取得 ESP32 IP 後以 WebSocket 送控制封包。

## 需求

- 手機：**Android Chrome**（需 Web Bluetooth）
- 安全來源：`https://` 或 `http://localhost`（BLE 才會可用）
- 第二步 ESP32 固件需對齊下方 UUID / 埠號 / JSON

## 現階段怎麼測（先不要改 SoftAP / GitHub Pages）

阻礙是 **Web Bluetooth 需要安全來源**，不是缺「系統藍牙按鈕」。

### 建議：本機 HTTPS（手機可測 BLE）

在 `web/` 目錄：

```bash
cd web
npm.cmd install
npm.cmd start
```

終端機會印出例如 `https://192.168.0.180:5500`。  
- Cursor / 電腦瀏覽器若跳出 **Certificate Error（TrackBot Dev）**：按 **Trust Certificate**（自簽憑證，僅本機開發用）。
- 手機 **Android Chrome** 打開該網址 → 憑證警告選「繼續／進階」→ 連線面板應顯示 `安全來源: 是 · Web Bluetooth: 可用` → 再按「連線藍牙」。

若憑證日期異常（例如顯示 1970），刪除 `web/dev/.certs` 後再 `npm.cmd start`。

### 備案：HTTP + Chrome flags

```bash
cd web
npm.cmd run start:http
```

手機開 `http://電腦IP:5500`，到 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 加入該網址後 Relaunch。

### 聯調順序

1. 燒錄 ESP32，串口看到 `advertising as TrackBot-XXXX`
2. **每次連控：** 按「連線藍牙」→ ESP 推送／可讀 IP → 網頁自動填入並連 WS（**IP 不寫入本機**）
3. 首次配網：先填 SSID/密碼再連藍牙（有帳密會自動送出）→ 等 IP → 自動 WS  
4. ESP 已在 `Ready`（待機 BLE+WiFi）：連藍牙後數秒內取得 IP，直接自動 WS  
5. 關掉網頁／斷 WS → ESP `target_linked=0` → **BLE 再廣播**

WiFi 帳密可選存在瀏覽器 `localStorage`（僅方便重送配網）；**ESP IP 一律經藍牙取得，不持久化。**

電腦僅測 UI：`http://localhost:5500`（localhost 對 BLE 也算安全來源，但手機連不到 localhost）。

## 操作

| 控制 | 行為 |
|------|------|
| 左搖桿（方向） | 雙軸；中心為 0；鬆手回中；上為前進；左右控制自轉 `ω`（可 `v=0` 原地轉） |
| 右搖桿（速度） | 僅垂直；最下 = 停止 `t=0`；最上 = `t=1`；鬆手保持 |
| 連線藍牙 | 連上 `TrackBot-*` 後：若裝置已 Ready 則自動收 IP；否則自動送出已填／已存的 WiFi |
| 送出 WiFi 密碼 | 手動補送；成功後會記住帳密 |
| 手動連線 | 開發後備：手動填 `ws://IP:81/`（正常流程請用藍牙取 IP） |

## 協議契約（與 ESP32 對齊）

定義檔：[`js/protocol.js`](js/protocol.js)

### BLE

| 項目 | 值 |
|------|-----|
| 裝置名稱前綴 | `TrackBot` |
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` |
| WIFI_CONFIG（Write） | `0000fff1-0000-1000-8000-00805f9b34fb` |
| STATUS（Notify） | `0000fff2-0000-1000-8000-00805f9b34fb` |

**Write 內容（UTF-8 JSON）：**

```json
{"ssid":"MyAP","password":"secret"}
```

**Notify 內容：**

```json
{"state":"connecting","msg":"joining"}
{"state":"ok","ip":"192.168.1.50","msg":"ready"}
{"state":"fail","msg":"auth error"}
```

`state=ok` 且帶 `ip` 時，網頁會自動連 WebSocket。

### WebSocket

- URL：`ws://<ESP32_IP>:81/`
- 搖桿 `kick()` 直送動作幀；**Web Worker** 約每 **200ms** 觸發 heartbeat（對抗 Android Chrome 主線程 timer 限流；失敗時退回主線程 `setInterval`）
- **雙向存活**：ESP 對控制幀回 ack，並約每 500ms 週期 pong（皆限速 ~200ms）`{"a":1,"seq":N}`
- **網頁分級逾時**：約 **2s** 無 ack → UI「連線不穩」（不斷線）；約 **10s** → 關閉 socket；`bufferedAmount` 持續過高 ≥5s →「傳送壅塞」
- **Session 自動重連**：硬斷後用本次記憶體中的 IP 自動重連（backoff，最多 5 次），**不必重走藍牙**；按「斷開」／`pagehide` 不重連（IP 仍不寫 localStorage）
- ESP 雙層逾時：約 **1s** 無幀 → 馬達歸零（不斷線）；約 **15s** 無幀 → force unlink（先嘗試送 WS CLOSE）+ 重開 BLE
- 分頁 `hidden`：不斷 WS，只強制送零軸（避免 Android 通知列誤斷）；`pagehide`／`beforeunload` 才主動斷 WS

手機 → ESP（網頁已將搖桿合成為車體 \(v,\omega\)）：

```json
{"v":32.5,"w":-0.1,"seq":123}
```

| 欄位 | 意義 |
|------|------|
| `v` | 線速度 cm/s（正＝前進） |
| `w` | 角速度 rad/s（ω；正＝左轉） |
| `seq` | 遞增序號 |

合成（暫定 `V_MAX_CM_S=50`、`OMEGA_MAX_RAD_S=1.0`、`STEER_GATE=0`）：右油門 \(t\) 為速度大小；左搖桿 \(R_y\) 只取進退符號、\(R_x=-fx\)；\(\omega \propto R_x\)（由中心線性到滿舵，搖桿死區濾抖動）。\(v=v_{\max} t \cdot \mathrm{dir}(R_y)\)；可 \(v=0,\,\omega\neq0\) 原地自轉。ESP 組 14-byte UART 幀轉 STM32（`main/uart/`，GPIO10 TX / GPIO9 RX）。

ESP → 手機（ack／週期 pong）：

```json
{"a":1,"seq":123}
```

## 檔案

```
web/
  index.html
  css/style.css
  js/main.js
  js/joystick.js
  js/ble-provision.js
  js/ws-control.js
  js/ws-heartbeat-worker.js
  js/protocol.js
  js/storage.js
  README.md
```

## 第二步（固件）

固件已實作於 `main/`（Tapo 式狀態機）：

```
main/
  main.c
  sm/          # app_sm 狀態機
  net/         # nvs_wifi, wifi_sta, ble_prov
  control/     # ws_control, control_stub（收 v/w → UART）
  uart/        # uart_cmd_vel（STM32 14-byte 幀，GPIO10 TX / GPIO9 RX）
  input/       # button_reset (GPIO42 → GND)
  protocol/    # protocol_contract.h（對齊本目錄 js/protocol.js）
```

摘要（待機／連線政策）：

- BLE 名稱：`TrackBot-XXXX`（MAC 後 2 bytes）
- 開機：有 NVS 帳密先連 WiFi（最多 15s）；失敗進 BLE 配網
- **無網頁 WS（待機）**：WiFi 已連時 **BLE 廣播保持開啟**（`target_linked=0`）+ `:81` 聆聽
- **連藍牙後**：ESP 在 STATUS 訂閱後 Notify／可 Read `ok`+IP → 網頁**當次**自動填「ESP32 IP」並 `ws.connect`（不寫 localStorage）
- **WS 連上**：`target_linked=1` → **關閉 BLE**
- **關掉網頁／斷 WS**：`target_linked=0` → **重開 BLE**；搖桿 stub 歸零
- **單控端**：ESP `WS_MAX_CLIENTS=1`，新握手踢舊連線；網頁 WS 已連時禁用藍牙／再連 WS；重連先等舊 close
- **雙層逾時**：約 1s 無幀 → `control_apply(0,0,…)` 停車（UART 送零速）；約 15s 無幀 → force unlink（可先送 CLOSE）+ BLE on
- **Ack／pong**：控制幀回 ack；watchdog 週期 pong（皆 ~200ms 限速）；網頁 soft 2s 不穩／hard 10s 斷線後可用 session IP 自動重連
- 長按 **GPIO42（接 GND）≥3 秒**：清 WiFi、回配網（不變）

除錯串口應見：`client up … count=1`、`kicking old WS`（第二台／重連搶控）、`client down … count=0`、`cmd timeout: motors zeroed`（短暫無幀）、`target unlinked -> BLE on`。

編譯請在你的 ESP-IDF IDE 對本 repo 執行；若首次配置，確認已啟用 NimBLE 與 `CONFIG_HTTPD_WS_SUPPORT`（見根目錄 `sdkconfig.defaults`）。
