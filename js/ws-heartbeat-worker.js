/**
 * Classic worker: keepalive ticks for WsControl.
 * Runs off the main thread so Android Chrome touch/timer throttling
 * does not starve WebSocket heartbeats.
 */
let timerId = null;

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "start") {
    const intervalMs = Math.max(50, Number(data.intervalMs) || 200);
    if (timerId != null) {
      clearInterval(timerId);
    }
    timerId = setInterval(() => {
      self.postMessage({ type: "tick" });
    }, intervalMs);
    return;
  }
  if (data.type === "stop") {
    if (timerId != null) {
      clearInterval(timerId);
      timerId = null;
    }
  }
};
