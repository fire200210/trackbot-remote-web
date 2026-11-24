const KEY_SSID = "trackbot.wifi.ssid";
const KEY_PASS = "trackbot.wifi.password";

/**
 * @returns {{ ssid: string, password: string }}
 */
export function loadWifi() {
  try {
    return {
      ssid: localStorage.getItem(KEY_SSID) || "",
      password: localStorage.getItem(KEY_PASS) || "",
    };
  } catch {
    return { ssid: "", password: "" };
  }
}

/**
 * @param {string} ssid
 * @param {string} password
 */
export function saveWifi(ssid, password) {
  try {
    if (ssid) {
      localStorage.setItem(KEY_SSID, ssid);
      localStorage.setItem(KEY_PASS, password || "");
    }
  } catch {
    /* ignore quota / private mode */
  }
}
