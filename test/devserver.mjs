// Lokal testserver: statiska filer + API med en minneslagring som efterliknar Netlify Blobs.
// Skickar inga riktiga mejl (utskick fångas och visas på /__mail).
// Användning: node test/devserver.mjs <projektmapp> [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2];
const PORT = Number(process.argv[3] || 8888);

class MemStore {
  constructor() { this.m = new Map(); }
  async get(key, opts = {}) {
    if (!this.m.has(key)) return null;
    const v = this.m.get(key);
    return opts.type === "json" ? JSON.parse(v) : v;
  }
  async setJSON(key, value, opts = {}) {
    if (opts.onlyIfNew && this.m.has(key)) return { modified: false };
    // liten fördröjning för att få fram kapplöpningar
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    if (opts.onlyIfNew && this.m.has(key)) return { modified: false };
    this.m.set(key, JSON.stringify(value));
    return { modified: true, etag: "x" };
  }
  async delete(key) { this.m.delete(key); }
  async list({ prefix = "" } = {}) {
    return { blobs: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: "x" })), directories: [] };
  }
}
globalThis.__HITTATID_TEST_STORE__ = new MemStore();
globalThis.__HITTATID_TEST_MAIL__ = [];

const { default: handler } = await import(path.join(ROOT, "netlify/functions/api.mjs"));
const { default: cleanup } = await import(path.join(ROOT, "netlify/functions/cleanup.mjs"));

// Samma säkerhetsrubriker som netlify.toml sätter i drift
const tomlText = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
const SEC_HEADERS = {};
for (const m of tomlText.matchAll(/^\s+([A-Za-z-]+) = "(.*)"$/gm)) if (/-/.test(m[1])) SEC_HEADERS[m[1]] = m[2];

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/__mail") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(globalThis.__HITTATID_TEST_MAIL__));
  }
  if (url.pathname === "/__cleanup") {
    const r = await cleanup();
    res.writeHead(200); return res.end(await r.text());
  }
  if (url.pathname === "/__store") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify([...globalThis.__HITTATID_TEST_STORE__.m.keys()]));
  }
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handler(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let p = path.join(ROOT, "public", decodeURIComponent(url.pathname));
  if (p.endsWith("/")) p = path.join(p, "index.html");
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end("404"); }
  res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream", ...SEC_HEADERS });
  fs.createReadStream(p).pipe(res);
}).listen(PORT, () => console.log("klar på", PORT));
