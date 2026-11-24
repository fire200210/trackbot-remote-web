/**
 * Local HTTPS static server for Web Bluetooth testing on Android Chrome.
 * Usage (from web/): npm install && npm start
 * Phone: https://<PC_LAN_IP>:5500  (accept cert warning once)
 */
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 5500);
const certDir = path.join(__dirname, ".certs");
const keyPath = path.join(certDir, "key.pem");
const certPath = path.join(certDir, "cert.pem");

function lanIps() {
  const out = ["localhost", "127.0.0.1"];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) {
        out.push(net.address);
      }
    }
  }
  return [...new Set(out)];
}

function ensureCert(force = false) {
  fs.mkdirSync(certDir, { recursive: true });
  if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  }

  const attrs = [{ name: "commonName", value: "TrackBot Dev" }];
  const ips = lanIps();
  const altNames = ips.map((v) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(v)
      ? { type: 7, ip: v }
      : { type: 2, value: v },
  );

  /* Explicit dates avoid broken 1970 epoch certs seen with some forge builds. */
  const notBeforeDate = new Date();
  notBeforeDate.setHours(notBeforeDate.getHours() - 1);

  const pems = selfsigned.generate(attrs, {
    days: 825,
    notBeforeDate,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "subjectAltName", altNames },
    ],
  });

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log("Generated new self-signed cert in", certDir);
  return { key: pems.private, cert: pems.cert };
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const forceRegen = process.argv.includes("--regen-cert");
const creds = ensureCert(forceRegen);
const ips = lanIps().filter((v) => v !== "localhost" && v !== "127.0.0.1");

https
  .createServer(creds, (req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath === "/") urlPath = "/index.html";
      const filePath = path.normalize(path.join(root, urlPath));
      if (!filePath.startsWith(root)) {
        send(res, 403, "Forbidden");
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        send(res, 404, "Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      send(res, 200, fs.readFileSync(filePath), mime[ext] || "application/octet-stream");
    } catch (err) {
      send(res, 500, String(err));
    }
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`HTTPS serving ${root}`);
    console.log(`  Local:   https://localhost:${port}`);
    for (const ip of ips) {
      console.log(`  Network: https://${ip}:${port}`);
    }
    console.log("On phone Chrome: open Network URL, accept cert warning, then use 連線藍牙.");
  });
