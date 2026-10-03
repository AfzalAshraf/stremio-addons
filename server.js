// Run Fast Combo on any computer / server with Node.js 18+:   node server.js
// Then open http://localhost:7000/<ACCESS_KEY>/configure  (control panel)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import addon from "./fastcombo.js";

const PORT = Number(process.env.PORT || 7000);
// Where to listen. 0.0.0.0 = every network card (default). Behind a proxy like Caddy/nginx on the
// same machine use HOST=127.0.0.1 so the addon is reachable only through the proxy (HTTPS).
const HOST = process.env.HOST || "0.0.0.0";
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.FC_DATA_FILE || path.join(here, "data", "kv.json");

/** Tiny stand-in for Cloudflare KV: keeps your addon list + "seen links" in data/kv.json.
 *  This gives "live sync": changes on the website apply without reinstalling the addon. */
function fileKV(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  let timer = null;
  const flush = () => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const now = Date.now();
      for (const [k, e] of Object.entries(data)) if (e.x && e.x < now) delete data[k];
      fs.writeFileSync(file + ".tmp", JSON.stringify(data));
      fs.renameSync(file + ".tmp", file);
    } catch (e) {
      console.error(`could not save ${file}: ${e.message}`);
    }
  };
  const later = () => { if (!timer) timer = setTimeout(flush, 400); };
  process.on("exit", () => { if (timer) { clearTimeout(timer); flush(); } });
  return {
    async get(k) {
      const e = data[k];
      if (!e) return null;
      if (e.x && e.x < Date.now()) { delete data[k]; later(); return null; }
      return e.v;
    },
    async put(k, v, o = {}) { data[k] = { v: String(v), x: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0 }; later(); },
    async delete(k) { delete data[k]; later(); },
  };
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0)); // → saves pending data

// No access key / password / secret set anywhere? Create random ones on the first start and keep them in
// data/secrets.json (next to the addon list), so a fresh copy works without editing any file.
const SECRETS_FILE = path.join(path.dirname(DATA_FILE), "secrets.json");
function randomText(n, group) {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let t = "";
  for (let i = 0; i < n; i++) t += abc[crypto.randomInt(abc.length)];
  return group ? t.match(new RegExp(`.{1,${group}}`, "g")).join("-") : t;
}
function ensureSecrets() {
  let src = "";
  try { src = fs.readFileSync(path.join(here, "fastcombo.js"), "utf8"); } catch {}
  const inFile = (name) => (new RegExp(`^\\s*${name}:\\s*"([^"]*)"`, "m").exec(src) || [])[1] || "";
  const want = [["FC_ACCESS_KEY", "ACCESS_KEY", () => randomText(12)], ["FC_ADMIN_PASSWORD", "ADMIN_PASSWORD", () => randomText(12, 4)], ["FC_SECRET", "SECRET", () => randomText(32)]];
  const missing = want.filter(([e, c]) => !process.env[e] && !inFile(c));
  if (!missing.length) return { values: {}, created: false };
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")); } catch {}
  let created = false;
  for (const [e, , make] of missing) if (!saved[e]) { saved[e] = make(); created = true; }
  if (created) {
    try {
      fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
      fs.writeFileSync(SECRETS_FILE, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
    } catch (e) {
      console.error(`could not save ${SECRETS_FILE} (${e.message}) — the password will change on every restart`);
    }
  }
  return { values: Object.fromEntries(missing.map(([e]) => [e, saved[e]])), created };
}
const secrets = ensureSecrets();

// A normal server has no Cloudflare limits → test more links in parallel, allow more addons.
const env = { FC_PROBE_CONCURRENCY: "16", FC_MAX_PROBES: "40", FC_MAX_ADDONS: "50", FC_PRIVATE_HOST: "stremioaddon.lan", ...secrets.values, ...process.env };
if (process.env.FC_NO_STORAGE !== "1") env.FC_KV = fileKV(DATA_FILE);

function readBody(req, max = 200_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new Error("request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

http
  .createServer(async (req, res) => {
    try {
      const fwdProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
      const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).split(",")[0].trim();
      const h = host.replace(/:\d+$/, "").toLowerCase();
      const isLocal = /^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /\.(lan|local|home|internal|arpa|localdomain)$/.test(h);
      const proto = fwdProto || (process.env.FORCE_HTTPS === "1" || !isLocal ? "https" : "http");
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && !["host", "connection", "content-length", "transfer-encoding"].includes(k)) headers.set(k, v);
      }
      const method = req.method === "HEAD" ? "GET" : req.method;
      const init = { method, headers };
      if (method !== "GET" && method !== "OPTIONS") init.body = await readBody(req);
      const request = new Request(`${proto}://${host}${req.url}`, init);
      const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };
      const t0 = Date.now();
      const response = await addon.fetch(request, env, ctx);
      const body = Buffer.from(await response.arrayBuffer());
      const out = Object.fromEntries(response.headers.entries());
      out["x-response-time"] = `${Date.now() - t0}ms`;
      res.writeHead(response.status, out);
      res.end(req.method === "HEAD" ? undefined : body);
      if (!req.url.includes("logo")) console.log(`${new Date().toISOString().slice(11, 19)} ${response.status} ${Date.now() - t0}ms ${req.method} ${req.url.slice(0, 110)}`);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error: " + e.message);
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`⚡ Fast Combo running on ${HOST === "0.0.0.0" ? "port " + PORT : HOST + ":" + PORT}` + (env.FC_KV ? ` · live sync on (${path.relative(here, DATA_FILE) || DATA_FILE})` : ""));
    const key = env.FC_ACCESS_KEY;
    if (!key) return; // set inside fastcombo.js
    const base = String(env.FC_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
    console.log(`  Control panel: ${base}/${key}/configure`);
    if (secrets.created && secrets.values.FC_ADMIN_PASSWORD) console.log(`  Password:      ${secrets.values.FC_ADMIN_PASSWORD}   (created now, saved in ${path.relative(here, SECRETS_FILE) || SECRETS_FILE})`);
    else if (secrets.values.FC_ADMIN_PASSWORD) console.log(`  Password:      see ${path.relative(here, SECRETS_FILE) || SECRETS_FILE}`);
  });
