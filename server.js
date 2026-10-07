// Web Tech Report — tiny zero-dependency server.
// Local dev server: serves the PWA and the same /api routes Vercel runs.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const { handleApi, SECURITY_HEADERS, MIME } = require("./lib/canvas");

function serveStatic(req, res, url) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/" || !path.extname(file)) file = path.join(PUBLIC, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); return res.end("Not found"); }
    const ext = path.extname(file);
    const cache = ext === ".png" || ext === ".svg" ? "public, max-age=604800" : "no-cache";
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache, ...SECURITY_HEADERS });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET") { res.writeHead(405); return res.end(); }
    if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (url.pathname.startsWith("/api/")) return handleApi(req, res);
    serveStatic(req, res, url);
  })
  .listen(PORT, () => console.log(`web-tech-report listening on :${PORT}`));
