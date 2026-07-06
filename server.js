// Kollaboratives Pixel-Canvas — retromania seminar
// Local development server. Serves /public and routes /api/* to the same
// handler modules that run as serverless functions on Vercel.
//
// Run:  node server.js
// Without Redis env vars the state lives in memory (persisted to canvas.json);
// on Vercel the same handlers use Upstash Redis. See README.md.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;

const API = {
  boot: require("./api/boot"),
  poll: require("./api/poll"),
  paint: require("./api/paint"),
  clear: require("./api/clear"),
  task: require("./api/task"),
  timer: require("./api/timer"),
  evaluate: require("./api/evaluate"),
  stats: require("./api/stats"),
  mute: require("./api/mute"),
  customref: require("./api/customref"),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  const m = /^\/api\/([a-z]+)$/.exec(url.pathname);
  if (m && API[m[1]]) {
    Promise.resolve(API[m[1]](req, res)).catch((e) => {
      console.error("API /" + m[1] + " failed:", e);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
    return;
  }

  // Static files from /public.
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(__dirname, "public", path.normalize(file));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg",
      ".svg": "image/svg+xml", ".ico": "image/x-icon",
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "localhost";
}

server.listen(PORT, () => {
  const ip = lanIP();
  console.log("\n  ╔══════════════════════════════════════════╗");
  console.log("  ║   Kollaboratives Pixel-Canvas läuft        ║");
  console.log("  ╚══════════════════════════════════════════╝\n");
  console.log("  Auf diesem Rechner:  http://localhost:" + PORT);
  console.log("  Phones (gleiches WLAN):  http://" + ip + ":" + PORT + "\n");
  console.log("  Admin-Ansicht:  http://localhost:" + PORT + "/?admin=<ADMIN_TOKEN>\n");
});
