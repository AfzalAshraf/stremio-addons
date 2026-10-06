/* ==========================================================================
   ⚡ FAST COMBO v2 — one Stremio addon: only working, fast 1080p / 4K streams
   --------------------------------------------------------------------------
   Control panel website: open  <your address>/<ACCESS_KEY>/configure
     • add / remove / switch off addons (each one is tested live before adding)
     • settings, "Try it" (see exactly what Stremio will get), live health page
   Every time you open a movie or episode it:
     1. asks all your addons at the same time (dead / slow addons are skipped)
     2. keeps only 1080p + 4K, removes CAM/TS, huge REMUX files,
        "download only" pages, ads and error cards
     3. removes duplicates (same file on many hosts → keeps the fastest host)
     4. live-tests the best links and hides the dead ones
     5. hides links that would expire before the movie ends
     6. sorts: working + fast-starting + small / efficient files first
     7. keeps results fresh: re-asks your addons in the background, and new
        links that appear later are marked 🆕

   Runs on: Cloudflare Workers (paste this whole file) or Node 18+ (server.js).
   Tested with Cloudflare's own runtime ("workerd") and Node 20 + 24.
   ========================================================================== */

// ======================== ✏️  YOUR SETTINGS (all optional) ==================
// Nothing here has to be filled in:
//  • Node.js, Docker and the VPS installer create a random ACCESS_KEY, ADMIN_PASSWORD and SECRET
//    for you on the first start.
//  • Cloudflare Workers: add the variables FC_ACCESS_KEY and FC_ADMIN_PASSWORD
//    (Worker → Settings → Variables and Secrets), so this file never contains passwords.
// Add your addons on the control panel website after installing.
const CONFIG = {
  ADDON_NAME: "⚡ Fast Combo",

  // Secret part of your addon link, so strangers can't use your addons. "" = FC_ACCESS_KEY / automatic.
  ACCESS_KEY: "",

  // Password for the control panel website. "" = FC_ADMIN_PASSWORD / automatic.
  ADMIN_PASSWORD: "",

  // Starting addons (optional; easier: add them on the control panel). Example:
  //   { name: "My addon", url: "https://example.com/manifest.json" },
  // Dead or slow ones are skipped automatically and retried later.
  UPSTREAMS: [],

  // Default preferences (you can also change them on the /configure page).
  DEFAULTS: {
    sort: "balanced", // "balanced" | "smallest" | "4kfirst" | "1080first"
    res: "2160,1080", // qualities to keep (add ",720" for slow internet)
    max1080: 8,       // max bitrate for 1080p in Mbps (8 ≈ 7 GB for a 2-hour movie)
    max4k: 20,        // max bitrate for 4K in Mbps   (20 ≈ 18 GB for a 2-hour movie)
    limit: 20,        // how many streams to show
    test: 1,          // 1 = live-test links and hide dead ones
    remux: 0,         // 1 = allow REMUX (very big files)
    hideDV: 0,        // 1 = hide Dolby-Vision-only files (purple/green on TVs without DV)
    hideAV1: 0,       // 1 = hide AV1 files (older devices can't play them)
    lang: "",         // preferred audio languages, e.g. "en,hi" (moved up, nothing hidden)
    newBadge: 1,      // 1 = mark links that appeared recently with 🆕
  },

  // Advanced
  LIVE_ID_PREFIXES: ["pp-live:"], // live-TV ids: no quality/size filter, only tested
  UPSTREAM_TIMEOUT_MS: 12000,     // give up on an addon after this long (first lookups can be slow)
  PROBE_TIMEOUT_MS: 3000,         // a link that needs longer than this to start = "slow"
  PROBE_BUDGET_MS: 3800,          // total time allowed for link testing per request
  MAX_PROBES: 20,                 // links tested per request (Cloudflare free plan: max 50 sub-requests incl. redirects)
  PROBE_CONCURRENCY: 6,           // parallel tests (Cloudflare allows 6 open connections at once)
  FRESH_SECONDS: 120,             // older results are shown instantly AND refreshed in the background
  CACHE_MINUTES: 15,              // results are kept at most this long
  NEW_HOURS: 24,                  // a link counts as 🆕 for this long after it first appeared
  MAX_ADDONS: 15,                 // max addons in the list (Cloudflare free plan; Node/VPS default: 50 via FC_MAX_ADDONS)
  MAX_STREAMS_PER_ADDON: 250,     // read at most this many streams from one addon
  AI_TEST_N: 3,                   // "AI finder": how many top candidates get a live test (kept low for Cloudflare's limits)
  // Encrypts your addon list inside links. "" = FC_SECRET / automatic (Node) / derived from the password.
  SECRET: "",
};
// ============================================================================
//                     ENGINE — no need to edit below this line
// ============================================================================

const VERSION = "2.1.0";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const RT = { ...CONFIG, DEFAULTS: { ...CONFIG.DEFAULTS } };
let envApplied = false;
let STARTED = 0;
// Cloudflare's free plan allows 50 sub-requests per request; Node has no such limit
const ON_CF = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/** Optional overrides from environment variables (FC_UPSTREAMS, FC_ACCESS_KEY, FC_MAX_PROBES …). */
function applyEnv(env) {
  if (envApplied) return;
  envApplied = true;
  if (!env || typeof env !== "object") return;
  for (const k of ["UPSTREAM_TIMEOUT_MS", "PROBE_TIMEOUT_MS", "PROBE_BUDGET_MS", "MAX_PROBES", "PROBE_CONCURRENCY", "CACHE_MINUTES", "FRESH_SECONDS", "NEW_HOURS", "MAX_ADDONS", "MAX_STREAMS_PER_ADDON", "AI_TEST_N"]) {
    const v = env["FC_" + k];
    if (v !== undefined && v !== "" && !isNaN(+v)) RT[k] = +v;
  }
  if (env.FC_ACCESS_KEY) RT.ACCESS_KEY = String(env.FC_ACCESS_KEY);
  if (env.FC_ADDON_NAME) RT.ADDON_NAME = String(env.FC_ADDON_NAME);
  if (env.FC_ADMIN_PASSWORD) RT.ADMIN_PASSWORD = String(env.FC_ADMIN_PASSWORD);
  if (env.FC_SECRET) RT.SECRET = String(env.FC_SECRET);
  // "AI finder" (opt-in): where to search for scrapers, and the optional LLM that makes the final pick.
  if (env.FC_AI_CATALOG) RT.AI_CATALOG = String(env.FC_AI_CATALOG);
  if (env.FC_LLM_API_KEY) RT.LLM_API_KEY = String(env.FC_LLM_API_KEY);
  if (env.FC_LLM_BASE_URL) RT.LLM_BASE_URL = String(env.FC_LLM_BASE_URL).replace(/\/+$/, "");
  if (env.FC_LLM_MODEL) RT.LLM_MODEL = String(env.FC_LLM_MODEL);
  // Address people/Stremio use to reach the addon (only needed behind a proxy/tunnel)
  if (env.FC_PUBLIC_URL) RT.PUBLIC_URL = String(env.FC_PUBLIC_URL).replace(/\/+$/, "");
  // Private address (or its ending) where "/" may open the settings page directly. Never your public address!
  if (env.FC_PRIVATE_HOST) RT.PRIVATE_HOST = String(env.FC_PRIVATE_HOST).toLowerCase().replace(/^\./, "");
  if (env.FC_UPSTREAMS) {
    const list = String(env.FC_UPSTREAMS).split(/[\s,]+/).filter((u) => /^https?:\/\//.test(u));
    if (list.length) RT.UPSTREAMS = list.map((url, i) => ({ name: `Addon ${i + 1}`, url }));
  }
}

// ------------------------------------------------------------------ http utils
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
};
function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}
function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
/** Control-panel API answers: same-site only (no CORS), never cached. */
function apiJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// --------------------------------------------------------------- small caches
class TTL {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.x < Date.now()) { this.m.delete(k); return undefined; }
    return e.v;
  }
  set(k, v, ms) {
    this.m.delete(k);
    this.m.set(k, { v, x: Date.now() + ms });
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
  }
  get size() { return this.m.size; }
}
const C = {
  streams: new TTL(400), up: new TTL(400), probe: new TTL(5000), manifest: new TTL(50),
  meta: new TTL(2000), catalog: new TTL(300), subs: new TTL(300), inflight: new Map(),
  profile: new TTL(60), tokens: new TTL(300), seen: new TTL(1500), ai: new TTL(30),
};
const recent = []; // last requests (for the status page)

/** Run fn once per key at a time (Stremio sometimes sends the same request twice). */
function once(key, fn) {
  if (C.inflight.has(key)) return C.inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => C.inflight.delete(key));
  C.inflight.set(key, p);
  return p;
}
function withTimeout(p, ms, fallback) {
  let t;
  return Promise.race([p, new Promise((r) => (t = setTimeout(() => r(fallback), ms)))]).finally(() => clearTimeout(t));
}
async function fetchJSON(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", ...(headers || {}) },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch {}
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    return { data, ms: Date.now() - t0 };
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`no answer after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Like fetchJSON, but if an addon answers with a server error (502/503…) or the connection drops,
 *  try once more right away — flaky addons often work on the second try. */
async function fetchJSONRetry(url, timeoutMs, headers) {
  const t0 = Date.now();
  try {
    return await fetchJSON(url, timeoutMs, headers);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const left = timeoutMs - (Date.now() - t0);
    if (/^no answer after/.test(msg) || !/HTTP 5\d\d|fetch failed|network|ECONN|socket|reset|terminated/i.test(msg) || left < 1500) throw e;
    await new Promise((r) => setTimeout(r, 250));
    const r = await fetchJSON(url, left - 250, headers);
    r.ms = Date.now() - t0;
    return r;
  }
}

// ---------------------------------------------------------- upstream health
const upHealth = new Map();
function health(up) {
  let h = upHealth.get(up.url);
  if (!h) {
    h = { name: up.name, ok: 0, fail: 0, consec: 0, avgMs: 0, lastMs: 0, pingMs: 0, lastErr: "", lastOkAt: 0, lastFailAt: 0, downUntil: 0, lastCount: null };
    upHealth.set(up.url, h);
  }
  return h;
}
function markOk(up, ms, count) {
  const h = health(up);
  h.ok++; h.consec = 0; h.lastOkAt = Date.now(); h.downUntil = 0;
  if (count === undefined) { h.pingMs = ms; return; } // manifest check (fast) — kept apart from stream times
  h.lastMs = ms; h.lastCount = count;
  h.avgMs = h.avgMs ? Math.round(h.avgMs * 0.7 + ms * 0.3) : ms;
}
function markFail(up, err) {
  const h = health(up);
  h.fail++; h.consec++; h.lastFailAt = Date.now();
  h.lastErr = String((err && err.message) || err).slice(0, 160);
  if (h.consec >= 3) h.downUntil = Date.now() + 5 * 60e3; // skip a dead addon for 5 minutes
}
const upBase = (up) => up.url.replace(/\/manifest\.json(\?.*)?$/i, "").replace(/\/+$/, "");

const goodManifest = new Map();
async function getManifest(up, fresh = false) {
  if (!fresh) {
    const hit = C.manifest.get(up.url);
    if (hit !== undefined) return hit;
  }
  return once("m:" + up.url, async () => {
    try {
      const { data, ms } = await fetchJSONRetry(up.url, 8000);
      if (!data || !data.id) throw new Error("not a Stremio addon");
      markOk(up, ms);
      C.manifest.set(up.url, data, 6 * 3600e3);
      goodManifest.set(up.url, data);
      return data;
    } catch (e) {
      markFail(up, e);
      const old = goodManifest.get(up.url) || null; // during a hiccup keep using the last good one
      C.manifest.set(up.url, old, 2 * 60e3);
      return old;
    }
  });
}
function supports(m, resource, type, id) {
  if (!m) return false;
  for (const r of m.resources || []) {
    const name = typeof r === "string" ? r : r && r.name;
    if (name !== resource) continue;
    const types = (typeof r === "object" && r.types) || m.types || [];
    const prefixes = (typeof r === "object" && r.idPrefixes) || m.idPrefixes;
    if (types.length && !types.includes(type)) continue;
    if (prefixes && prefixes.length && !prefixes.some((p) => id.startsWith(p))) continue;
    return true;
  }
  return false;
}

async function upstreamStreams(up, type, id, ua, ctx, opts = {}) {
  const h = health(up);
  if (h.downUntil > Date.now()) return { skipped: "down", streams: [] };
  const m = C.manifest.get(up.url);
  if (m && !supports(m, "stream", type, id)) return { skipped: "unsupported", streams: [] };
  if (m === undefined) { const p = getManifest(up); if (ctx && ctx.waitUntil) ctx.waitUntil(p); }
  const key = `${up.url}|${type}|${id}`;
  const hit = opts.fresh ? undefined : C.up.get(key);
  if (hit) return { streams: hit, cached: true };
  return once("s:" + key, async () => {
    const url = `${upBase(up)}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id).replace(/%3A/gi, ":")}.json`;
    try {
      const { data, ms } = await fetchJSONRetry(url, RT.UPSTREAM_TIMEOUT_MS, ua ? { "User-Agent": ua } : null);
      let streams = Array.isArray(data && data.streams) ? data.streams : [];
      markOk(up, ms, streams.length);
      if (streams.length > RT.MAX_STREAMS_PER_ADDON) streams = streams.slice(0, RT.MAX_STREAMS_PER_ADDON);
      C.up.set(key, streams, streams.length ? Math.min(RT.FRESH_SECONDS, RT.CACHE_MINUTES * 60) * 1000 : 60e3);
      return { streams, ms };
    } catch (e) {
      markFail(up, e);
      return { error: String(e.message || e), streams: [] };
    }
  });
}

// ------------------------------------------------- your addon list (profile)
// Addons + settings come from (newest wins):
//   • storage: Cloudflare KV binding "FC_KV" (or data/kv.json with server.js) → website changes apply instantly
//   • the install link itself (encrypted with SECRET) when there is no storage
//   • CONFIG above (starting point)
const enc = new TextEncoder(), dec = new TextDecoder();
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const addonId = (url) => fnv(String(url).toLowerCase()).padStart(7, "0").slice(-7);
/** Accepts …/manifest.json, stremio://… and …/configure links; returns a clean manifest URL or "". */
function cleanAddonUrl(raw) {
  let u = String(raw || "").trim().replace(/^stremio:\/\//i, "https://");
  if (!/^https?:\/\/[^/\s]+/i.test(u) || /\s/.test(u) || u.length > 2000) return "";
  try { new URL(u); } catch { return ""; }
  const m = /^([^?#]*)(\?[^#]*)?/.exec(u);
  let path = m[1].replace(/\/+$/, "").replace(/\/configure$/i, "");
  if (!/\/manifest\.json$/i.test(path)) path += "/manifest.json";
  return path + (m[2] || "");
}
function sanitizeAddons(list) {
  const out = [], seen = new Set();
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== "object") continue;
    const url = cleanAddonUrl(a.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      id: addonId(url),
      name: String(a.name || "Addon").replace(/\s+/g, " ").trim().slice(0, 40) || "Addon",
      url,
      on: a.on !== false && a.on !== 0,
      w: Math.max(-1, Math.min(1, Math.round(Number(a.w) || 0))), // priority: -1 low, 0 normal, 1 high
    });
    if (out.length >= RT.MAX_ADDONS) break;
  }
  return out;
}
function cleanSettings(o) {
  const S = normSettings(o || {}), out = {};
  for (const k of Object.keys(RT.DEFAULTS)) out[k] = S[k];
  return out;
}
function legacySettings(str) { // links made by v1 (settings only, not encrypted)
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const o = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

let AES = null;
async function aesKey() {
  if (!AES) {
    const raw = await crypto.subtle.digest("SHA-256", enc.encode("fastcombo|" + (RT.SECRET || "pw|" + RT.ADMIN_PASSWORD) + "|" + RT.ACCESS_KEY));
    AES = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  return AES;
}
function b64u(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(str) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
/** Encrypts the addon list + settings into a link-safe token "e.xxxx" (AES-GCM; only this server can read it). */
async function sealToken(obj) {
  let data = enc.encode(JSON.stringify(obj)), flag = 0;
  if (typeof CompressionStream !== "undefined") {
    try { data = await pipeBytes(data, new CompressionStream("deflate")); flag = 1; } catch {}
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), data));
  const all = new Uint8Array(13 + ct.length);
  all[0] = flag; all.set(iv, 1); all.set(ct, 13);
  return "e." + b64u(all);
}
async function openToken(token) {
  const hit = C.tokens.get(token);
  if (hit !== undefined) return hit;
  let out = null;
  try {
    const all = unb64u(token.slice(2));
    let data = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(1, 13) }, await aesKey(), all.slice(13)));
    if (all[0] === 1) data = await pipeBytes(data, new DecompressionStream("deflate"));
    out = JSON.parse(dec.decode(data));
  } catch { out = null; }
  C.tokens.set(token, out, 30 * 60e3);
  return out;
}

async function kvProfile(env) {
  if (!env || !env.FC_KV) return null;
  const hit = C.profile.get("kv");
  if (hit !== undefined) return hit;
  return once("kv:profile", async () => {
    let p = null;
    try { const t = await env.FC_KV.get("profile"); if (t) p = JSON.parse(t); } catch {}
    if (p && !Array.isArray(p.addons)) p = null;
    C.profile.set("kv", p, 20e3);
    return p;
  });
}
async function loadProfile(env, token) {
  const kv = await kvProfile(env);
  const memo = "P:" + (kv ? kv.updated || 1 : 0) + "|" + (token || "");
  const hit = C.profile.get(memo);
  if (hit) return hit;
  const P = { addons: sanitizeAddons(RT.UPSTREAMS), settings: { ...RT.DEFAULTS }, from: "built-in", updated: 0 };
  if (kv) { P.addons = sanitizeAddons(kv.addons); P.settings = { ...P.settings, ...(kv.settings || {}) }; P.from = "storage"; P.updated = kv.updated || 0; }
  if (token && token.startsWith("e.")) {
    const t = await openToken(token);
    if (!t) P.badToken = true;
    else if (!kv || (t.t || 0) > P.updated) { // the newer of storage / link wins
      if (Array.isArray(t.a)) P.addons = sanitizeAddons(t.a.map((x) => (Array.isArray(x) ? { name: x[0], url: x[1], on: x[2] !== 0, w: x[3] || 0 } : x)));
      if (t.s && typeof t.s === "object") P.settings = { ...RT.DEFAULTS, ...t.s };
      P.from = "link"; P.updated = t.t || 0;
    }
  } else if (token && !kv) {
    const o = legacySettings(token);
    if (o) P.settings = { ...P.settings, ...o };
  }
  P.S = normSettings(P.settings);
  P.ups = P.addons.filter((a) => a.on);
  P.hash = fnv(P.ups.map((a) => a.url + "~" + a.w).join("|"));
  C.profile.set(memo, P, 60e3);
  return P;
}
async function saveProfile(env, addons, settings) {
  const clean = { v: 2, updated: Date.now(), addons: sanitizeAddons(addons), settings: cleanSettings(settings) };
  if (env && env.FC_KV) {
    await env.FC_KV.put("profile", JSON.stringify(clean));
    C.profile.set("kv", clean, 20e3);
    return { ok: true, mode: "live", updated: clean.updated };
  }
  const s = {};
  for (const [k, v] of Object.entries(clean.settings)) if (v !== RT.DEFAULTS[k]) s[k] = v; // only changes → shorter link
  const token = await sealToken({ v: 2, t: clean.updated, a: clean.addons.map((a) => [a.name, a.url, a.on ? 1 : 0, a.w]), s });
  return { ok: true, mode: "link", token, updated: clean.updated };
}

// ------------------------------------------------- title info (Cinemeta)
function parseRuntime(r) {
  if (!r) return 0;
  const s = String(r);
  const h = /(\d+)\s*h/i.exec(s), m = /(\d+)\s*m/i.exec(s);
  const total = (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  return total || (/^\d+$/.test(s) ? +s : 0);
}
async function getMeta(type, id) {
  if (!id.startsWith("tt")) return {};
  const imdb = id.split(":")[0];
  const mtype = type === "series" || id.includes(":") ? "series" : "movie";
  const key = mtype + "/" + imdb;
  const hit = C.meta.get(key);
  if (hit !== undefined) return hit;
  return once("meta:" + key, async () => {
    try {
      const { data } = await fetchJSON(`https://v3-cinemeta.strem.io/meta/${mtype}/${imdb}.json`, 2500);
      const m = (data && data.meta) || {};
      const out = { name: m.name || "", year: String(m.releaseInfo || m.year || "").slice(0, 4), runtime: parseRuntime(m.runtime) };
      C.meta.set(key, out, 24 * 3600e3);
      return out;
    } catch {
      C.meta.set(key, {}, 10 * 60e3);
      return {};
    }
  });
}
function defaultRuntime(type, id) {
  const parts = id.split(":");
  if (/^(kitsu|mal|anilist|anidb):/.test(id)) return parts.length > 2 ? 24 : 100;
  return type === "series" || parts.length >= 3 ? 45 : 120;
}
function wantedEpisode(id) {
  const p = id.split(":");
  if (id.startsWith("tt") && p.length >= 3) return { season: +p[1], episode: +p[2], anime: false };
  if (/^(kitsu|mal|anilist|anidb):/.test(id) && p.length >= 3) return { season: null, episode: +p[p.length - 1], anime: true };
  return null;
}
function episodeMatches(c, w) {
  if (!w.anime && c.epS !== w.season) return false;
  return c.epE === w.episode || (c.epE2 !== null && w.episode >= c.epE && w.episode <= c.epE2);
}
function episodeTag(id) {
  const p = id.split(":");
  const pad = (n) => String(n).padStart(2, "0");
  if (id.startsWith("tt") && p.length >= 3) return `S${pad(p[1])}E${pad(p[2])}`;
  if (/^(kitsu|mal|anilist|anidb):/.test(id) && p.length >= 3) return `E${pad(p[p.length - 1])}`;
  return "";
}

// ------------------------------------------------------------ stream parsing
const B = "(?:^|[^a-z0-9])", E = "(?![a-z0-9])";
const rx = (s) => new RegExp(s, "i");
const RE = {
  res: rx(`${B}(2160|1440|1080|720|576|480|360)[pi]${E}`),
  uhd: rx(`${B}(4k|uhd)${E}`),
  padRes: /^(4k|uhd|2160p?|1440p?|1080p?|720p?|576p?|480p?)/i,
  junk: rx(`${B}(cam|camrip|hdcam|hqcam|hq-cam|ts|hdts|telesync|tc|hdtc|telecine|scr|screener|dvdscr|predvd|pre-dvd)${E}`),
  remux: rx(`${B}(remux|bdremux|bdmv|iso|m2ts|full[ .-]?disc|complete[ .-]?blu-?ray)${E}`),
  hevc: rx(`${B}(hevc|x\\.?265|h\\.?265)${E}`),
  av1: rx(`${B}av1${E}`),
  avc: rx(`${B}(avc|x\\.?264|h\\.?264)${E}`),
  dv: rx(`${B}(dv|dovi|dolby[ .-]?vision)${E}`),
  hdr10p: /hdr10(\+|plus)/i,
  hdr: rx(`${B}(hdr10\\+?|hdr|hlg)(?![a-z])`),
  bit10: /10[ .-]?bit/i,
  webdl: rx(`${B}web[ .-]?dl${E}`),
  webrip: rx(`${B}web[ .-]?rip${E}`),
  bluray: rx(`${B}(blu[ .-]?ray|bdrip|brrip|bd[ .-]?rip)${E}`),
  hdtv: rx(`${B}hdtv${E}`),
  hdrip: rx(`${B}hdrip${E}`),
  sizeTag: /(?:📦|💾)\s*([\d.,]+)\s*(TB|GB|MB|TiB|GiB|MiB)\b/i,
  sizeAny: /(?:^|[^\w.])(\d+(?:\.\d+)?)\s*(TB|GB|MB|TiB|GiB|MiB)\b/i,
  rate: /📊\s*([\d.]+)\s*(Mbps|Kbps)/i,
  seeders: /👤\s*(\d+)/,
  hostPath: /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)(?::\d+)?([^?#]*)/i,
  amzDate: /[?&]X-Amz-Date=(\d{8}T\d{6}Z)/,
  amzExp: /[?&]X-Amz-Expires=(\d+)/,
  psig: /[?&]psig=(\d{10})\./,
  expParam: /[?&](?:Expires|expires|exp)=(\d{10})(?:&|$)/,
  expiryHint: /[?&](?:X-Amz-Expires|psig|Expires|expires|exp)=/,
  hlsPad: /^(4k|\d{3,4}p?)hls/i,
  episode: /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,4})(?:[ ._-]?(?:e|-)(\d{1,4}))?(?![0-9])/i,
  flags: /[\u{1F1E6}-\u{1F1FF}]{2}|🌎|🌍/gu,
  notReady: /⏳|\buncached\b|\bnot ready\b|download only|\[(?:rd|ad|pm|tb|dl|ed|oc|pp)\s*download\]/i,
  debridName: /\[(?:rd|ad|pm|tb|dl|ed|oc|pp|tr)\+?\]|real-?debrid|alldebrid|premiumize|torbox|debrid-?link|offcloud|easydebrid/i,
  debridHost: /real-?debrid|alldebrid|premiumize|torbox|debrid-?link|offcloud|easydebrid|debrider/i,
};
const LANG_WORDS = [
  [rx(`${B}(hindi|hin)${E}`), "🇮🇳"], [rx(`${B}(english|eng)${E}`), "🇬🇧"], [rx(`${B}(tamil|telugu|malayalam|kannada)${E}`), "🇮🇳"],
  [rx(`${B}(arabic|ara)${E}`), "🇸🇦"], [rx(`${B}(french|fre|vff|truefrench)${E}`), "🇫🇷"], [rx(`${B}(spanish|spa|latino)${E}`), "🇪🇸"],
  [rx(`${B}(german|ger)${E}`), "🇩🇪"], [rx(`${B}(japanese|jpn|jap)${E}`), "🇯🇵"], [rx(`${B}(korean|kor)${E}`), "🇰🇷"],
  [rx(`${B}(multi|dual)${E}`), "🌎"],
];
// code: [label, flags used by addons, words found in file names]
const LANGS = {
  en: ["English", ["🇬🇧", "🇺🇸"], "english|eng"], hi: ["Hindi", ["🇮🇳"], "hindi|hin"], ta: ["Tamil", [], "tamil"],
  te: ["Telugu", [], "telugu"], ml: ["Malayalam", [], "malayalam"], kn: ["Kannada", [], "kannada"],
  bn: ["Bengali", [], "bengali|bangla"], ur: ["Urdu", ["🇵🇰"], "urdu"], ar: ["Arabic", ["🇸🇦", "🇦🇪", "🇪🇬"], "arabic|ara"],
  fa: ["Persian", ["🇮🇷"], "persian|farsi"], tr: ["Turkish", ["🇹🇷"], "turkish"], ru: ["Russian", ["🇷🇺"], "russian|rus"],
  fr: ["French", ["🇫🇷"], "french|fre|vff|truefrench"], es: ["Spanish", ["🇪🇸", "🇲🇽"], "spanish|spa|latino|castellano"],
  pt: ["Portuguese", ["🇵🇹", "🇧🇷"], "portuguese|dublado"], de: ["German", ["🇩🇪"], "german|ger|deutsch"],
  it: ["Italian", ["🇮🇹"], "italian|ita"], ja: ["Japanese", ["🇯🇵"], "japanese|jpn|jap"], ko: ["Korean", ["🇰🇷"], "korean|kor"],
  zh: ["Chinese", ["🇨🇳", "🇹🇼", "🇭🇰"], "chinese|chi|mandarin|cantonese"], multi: ["Multi-audio", ["🌎", "🌍"], "multi|dual"],
};
const LANG_RX = Object.fromEntries(Object.entries(LANGS).map(([k, v]) => [k, rx(`${B}(${v[2]})${E}`)]));
function langHit(c, set) { // cheap: flag in the description, or language word in the file name
  for (const code of set) {
    const L = LANGS[code];
    if (!L) continue;
    for (const f of L[1]) if (c.desc.includes(f)) return true;
    if (LANG_RX[code].test(c.fname)) return true;
  }
  return false;
}

function parseSize(str) {
  const m = RE.sizeTag.exec(str) || RE.sizeAny.exec(str);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(",", "."));
  const mult = { TB: 1e12, GB: 1e9, MB: 1e6, TIB: 2 ** 40, GIB: 2 ** 30, MIB: 2 ** 20 }[m[2].toUpperCase()] || 0;
  return Math.round(n * mult);
}
function resFromToken(t) {
  t = t.toLowerCase();
  if (t === "4k" || t === "uhd" || t.startsWith("2160")) return 2160;
  return parseInt(t, 10) || 0;
}
function detectRes(fname, pad, name, desc, url) {
  let m = RE.res.exec(fname);
  if (m) return +m[1];
  if (RE.uhd.test(fname)) return 2160;
  m = RE.padRes.exec(fname) || RE.padRes.exec(pad);
  if (m) return resFromToken(m[1]);
  m = RE.res.exec(desc) || RE.res.exec(name);
  if (m) return +m[1];
  if (RE.uhd.test(name)) return 2160;
  if (/\bFHD\b/.test(name)) return 1080;
  if (/\bQHD\b/.test(name)) return 1440;
  if (/\bHD\b/.test(name)) return 720;
  if (/\bSD\b/.test(name)) return 480;
  m = /[_/.-](2160|1080|720|480)p?[_/.-]/i.exec(url || "");
  return m ? +m[1] : 0;
}
function audioFromName(f) {
  const out = [];
  if (/atmos/i.test(f)) out.push("Atmos");
  if (/truehd/i.test(f)) out.push("TrueHD");
  else if (/dts[ .-]?(hd|x)/i.test(f)) out.push("DTS-HD");
  else if (/(?:^|[^a-z])dts(?![a-z])/i.test(f)) out.push("DTS");
  if (/ddp|dd\+|e-?ac-?3/i.test(f)) out.push("DD+");
  else if (/(?:^|[^a-z])(dd|ac-?3)(?![a-z+])/i.test(f)) out.push("DD");
  if (/(?:^|[^a-z])aac(?![a-z])/i.test(f)) out.push("AAC");
  if (/opus/i.test(f)) out.push("Opus");
  const ch = /(?:^|[^0-9])([257]\.[01])(?![0-9])/.exec(f);
  return out.join(" | ") + (ch ? (out.length ? " · " : "") + ch[1] : "");
}
function linkExpiry(u) {
  // reads the expiry time that file hosts put in signed links (no URL object → cheap)
  const ad = RE.amzDate.exec(u), ae = RE.amzExp.exec(u);
  if (ad && ae) {
    const d = ad[1];
    return Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15)) / 1000) + +ae[1];
  }
  const m = RE.psig.exec(u) || RE.expParam.exec(u);
  return m ? +m[1] : 0;
}
function hostKind(u) {
  const m = RE.hostPath.exec(u);
  if (!m) return "?";
  const h = m[1].toLowerCase(), p = m[2] || "/";
  if (h.endsWith(".r2.cloudflarestorage.com") || h.endsWith(".r2.dev")) return "r2";
  if (h.endsWith("googleusercontent.com") || h.endsWith("googlevideo.com")) return "google";
  if (h.endsWith(".herokuapp.com")) return "heroku";
  if (h === "pengu.uk") {
    const seg = p.split("/").filter(Boolean);
    return "pengu/" + (seg[0] === "direct" ? seg[1] || "" : seg[0] || "");
  }
  if (/(^|\.)hubcloud\.[a-z]+$/.test(h)) return h.split(".")[0] + ".hubcloud";
  return h.replace(/^www\./, "");
}
const HOST_LABEL = { r2: "Cloudflare R2", google: "Google", heroku: "Heroku", "pixeldrain.dev": "Pixeldrain", "pixeldrain.com": "Pixeldrain", p2p: "P2P", "sacdn.hakunaymatata.com": "MovieBox CDN", "hcdn3.hakunaymatata.com": "MovieBox CDN" };
function hostLabel(kind) {
  if (HOST_LABEL[kind]) return HOST_LABEL[kind];
  if (kind.startsWith("pengu/")) return "Pengu " + kind.slice(6);
  const parts = kind.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : kind;
}
// Priors from real tests (1 Oct 2026). Live test results quickly override these.
const HOST_PRIOR = { r2: 3, google: 3, "pixeldrain.dev": 1, "pixeldrain.com": 1, heroku: -1, "gpdl.hubcloud": -8, "gpdl2.hubcloud": -8, "pixel.hubcloud": -8, "pengu/gdflix": -6, "pengu/hubcloud": -1 };

/** Pass 3 (only for the ≤20 streams that are shown): display details. */
function enrichDisplay(c) {
  if (c._disp) return c;
  c._disp = true;
  let aLine = "", langLine = "", srcTag = "", first = "";
  for (const raw of c.desc.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (!first) first = l;
    if (!aLine && (l.startsWith("🎧") || l.startsWith("🔊"))) aLine = l;
    if (!langLine && l.includes("🗣️")) langLine = l;
    if (l.includes("🔍")) srcTag = l.slice(l.lastIndexOf("🔍") + 2).trim();
  }
  c.audio = aLine
    ? aLine.replace(/^🎧\s*/, "").split("🗣️")[0].replace(/🔊/g, "·").replace(/\s+/g, " ").trim().replace(/^·\s*/, "")
    : audioFromName(c.fname);
  c.langs = [...new Set((langLine.split("🗣️")[1] || "").match(RE.flags) || [])];
  if (!c.langs.length) c.langs = [...new Set(LANG_WORDS.filter(([r]) => r.test(c.fname)).map(([, f]) => f))];
  c.srcTag = srcTag;
  c.aioTitle = first.startsWith("🎬") ? first.replace(/^🎬\s*/, "") : "";
  return c;
}

/** Pass 1 (cheap, every stream): only what the filters need. */
function parseQuick(s, upName, ctx, w = 0) {
  if (!s || typeof s !== "object") return null;
  if (s.streamData && s.streamData.type === "error") return null;
  const url = typeof s.url === "string" && (s.url.startsWith("https://") || s.url.startsWith("http://")) ? s.url : "";
  const isTorrent = !url && typeof s.infoHash === "string" && s.infoHash.length >= 32;
  if (!url && !isTorrent) return null; // ads, donation / discord cards, errors, YouTube …
  const bh = s.behaviorHints || {};
  const fn = String(bh.filename || "");
  const sep = fn.indexOf("|^|");
  const fname = (sep >= 0 ? fn.slice(0, sep) : fn).trim();
  const pad = sep >= 0 ? fn.slice(sep + 3).trim() : "";
  const name = String(s.name || "");
  const desc = String(s.description || s.title || "");
  const qi = desc.indexOf("🎥");
  const qe = qi >= 0 ? desc.indexOf("\n", qi) : -1;
  const qLine = qi >= 0 ? desc.slice(qi, qe >= 0 ? qe : desc.length).trim() : "";
  const tags = fname + " " + qLine;
  // all fields declared up-front → one stable object shape (much faster in V8 / Cloudflare)
  const c = {
    s, url, isTorrent, upName, w, fname, pad, name, desc, bh, qLine, tags,
    res: 0, notReady: false, junk: false, remux: false, size: 0, bitrate: 0, brEst: false, expMin: null, expSoon: false,
    codec: "", dv: false, hdr10p: false, hdr: false, dvOnly: false, bit10: false, source: "", playlist: false, adaptive: false,
    audio: "", langs: null, srcTag: "", seeders: null, isDebrid: false, kind: "", headers: null, aioTitle: "",
    epS: null, epE: null, epE2: null, probe: null, status: "", _disp: false,
  };
  c.res = detectRes(fname, pad, name, desc, url);
  c.notReady = RE.notReady.test(name) || RE.notReady.test(desc);
  c.junk = RE.junk.test(tags);
  c.remux = RE.remux.test(tags);
  c.size = Number(bh.videoSize) > 0 ? Number(bh.videoSize) : parseSize(desc);
  const rm = RE.rate.exec(desc);
  if (rm) { c.bitrate = parseFloat(rm[1]) / (rm[2].toLowerCase() === "kbps" ? 1000 : 1); c.brEst = false; }
  else if (c.size && ctx.runtime) { c.bitrate = (c.size * 8) / (ctx.runtime * 60) / 1e6; c.brEst = true; }
  else c.bitrate = 0;
  c.expMin = null;
  if (url && RE.expiryHint.test(url)) {
    const ex = linkExpiry(url);
    if (ex) c.expMin = Math.round((ex * 1000 - ctx.now) / 60000);
  }
  c.expSoon = c.expMin !== null && c.expMin < ctx.runtime + 15;
  return c;
}

/** Pass 2 (only for streams that survived the filters): everything else. */
function enrich(c, ctx) {
  const { fname, pad, name, desc, url, bh, tags, qLine } = c;
  const all = tags + " " + desc;
  c.codec = RE.hevc.test(all) ? "HEVC" : RE.av1.test(all) ? "AV1" : RE.avc.test(all) ? "AVC" : "";
  c.dv = RE.dv.test(tags);
  c.hdr10p = RE.hdr10p.test(tags);
  c.hdr = c.hdr10p || RE.hdr.test(tags);
  c.dvOnly = c.dv && !c.hdr;
  c.bit10 = RE.bit10.test(tags);
  const q = qLine.replace(/^🎥\s*/, "").split(/📺|🎞️/)[0].trim();
  c.source = q || (c.remux ? "REMUX" : RE.bluray.test(fname) ? "BluRay" : RE.webdl.test(fname) ? "WEB-DL" : RE.webrip.test(fname) ? "WEBRip" : RE.hdtv.test(fname) ? "HDTV" : RE.hdrip.test(fname) ? "HDRip" : "");
  const qm = url.indexOf("?");
  const path = url ? (qm >= 0 ? url.slice(0, qm) : url).toLowerCase() : "";
  c.playlist = path.endsWith(".m3u8") || path.endsWith(".mpd");
  c.adaptive = c.playlist || RE.hlsPad.test(fname) || RE.hlsPad.test(pad);
  if (c.isTorrent) { const sm = RE.seeders.exec(desc) || RE.seeders.exec(name); c.seeders = sm ? +sm[1] : null; }
  c.kind = c.isTorrent ? "p2p" : hostKind(url);
  c.isDebrid = !!url && (RE.debridHost.test(c.kind) || url.includes("/resolve/") || url.includes("/playback/") || RE.debridName.test(name));
  c.headers = (bh.proxyHeaders && bh.proxyHeaders.request) || {};
  const em = RE.episode.exec(fname);
  c.epS = em ? +em[1] : null;
  c.epE = em ? +em[2] : null;
  c.epE2 = em && em[3] ? +em[3] : null;
  return c;
}

function filterReason(c, S, ctx) {
  if (c.notReady) return "not ready / download-only page";
  if (c.expMin !== null && c.expMin < 10) return "link already expired";
  if (ctx.live) return "";
  if (c.junk) return "CAM / TS (cinema recording)";
  const bucket = c.res >= 2160 ? "2160" : c.res >= 1080 ? "1080" : c.res >= 720 ? "720" : "";
  if (!bucket) return c.res ? "below 720p" : "unknown quality";
  if (!S.resSet.has(bucket)) return `${bucket === "2160" ? "4K" : bucket + "p"} not wanted`;
  if (c.remux && !S.remux) return "REMUX (huge file)";
  const cap = bucket === "2160" ? S.max4k : bucket === "1080" ? S.max1080 : 4;
  if (cap && c.bitrate && c.bitrate > cap) return "too big for fast streaming";
  return "";
}
/** Keys that identify the same file: exact byte size (if it looks real) and/or normalised file name. */
function dedupeKeys(c) {
  if (c.isTorrent) return ["ih:" + c.s.infoHash.toLowerCase() + ":" + (c.s.fileIdx ?? "")];
  const keys = [];
  const exact = Number((c.s.behaviorHints || {}).videoSize);
  // real sizes are never exact multiples of 1 MiB / 1 MB (2147483648 = placeholder used by some sites)
  if (exact > 2e8 && exact % 1048576 !== 0 && exact % 1e6 !== 0) keys.push("sz:" + exact);
  const f = c.fname;
  if (f && /[ ._]/.test(f) && f.length >= 12) {
    const base = f.toLowerCase()
      .replace(/\.(mkv|mp4|avi|ts|m2ts|webm|mov)$/, "")
      .replace(/^(gdflix|hubcloud|filepress|gofile)[ ._-]+/, "")
      .replace(/[^a-z0-9]+/g, "");
    keys.push("fn:" + base + "|" + (c.size ? Math.round(c.size / 5e6) : "?"));
  }
  if (!keys.length) keys.push("u:" + c.url); // nothing reliable → keep separate
  return keys;
}

// ------------------------------------------------------------- link testing
const kinds = new Map();
function kindStat(k) {
  let s = kinds.get(k);
  if (!s || Date.now() - s.t > 30 * 60e3) { s = { ok: 0, fail: 0, slow: 0, ms: 0, t: Date.now() }; kinds.set(k, s); }
  return s;
}
function learn(k, r) {
  const s = kindStat(k);
  s.t = Date.now();
  if (r.ok) { s.ok++; s.ms += r.ttfb; } else if (r.timeout) s.slow++; else s.fail++;
  if (s.ok + s.fail + s.slow > 60) { s.ok /= 2; s.fail /= 2; s.slow /= 2; s.ms /= 2; } // keep it recent
}
function kindBad(k) {
  const s = kinds.get(k);
  if (!s || Date.now() - s.t > 30 * 60e3) return false;
  const n = s.ok + s.fail + s.slow; // a link that hangs is as useless as a dead one
  return (s.fail + s.slow >= 4 && s.ok === 0) || (n >= 6 && s.ok / n < 0.15);
}
function kindSlow(k) {
  const s = kinds.get(k);
  return !!s && Date.now() - s.t < 30 * 60e3 && s.ok === 0 && s.slow >= 5;
}
function kindBonus(k) {
  const s = kinds.get(k);
  if (!s || Date.now() - s.t > 30 * 60e3) return 0;
  const n = s.ok + s.fail + s.slow;
  return n < 3 ? 0 : Math.round((s.ok / n - 0.5) * 10);
}
const variantPrior = (v) => (HOST_PRIOR[v.kind] || 0) + kindBonus(v.kind) + (v.expSoon ? -35 : 0) + (v.adaptive ? 1 : 0) + v.w * 6;

/** Reads only the first bytes of a response (never downloads a whole file). */
async function readHead(res, max) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  try {
    while (n < max) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  const buf = new Uint8Array(Math.min(n, max));
  let o = 0;
  for (const p of parts) { if (o >= buf.length) break; const take = p.subarray(0, buf.length - o); buf.set(take, o); o += take.length; }
  return new TextDecoder().decode(buf);
}
async function probe(v, timeoutMs) {
  const hit = C.probe.get(v.url);
  if (hit) return { ...hit, cached: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  let r;
  try {
    const headers = { "User-Agent": UA, Accept: "*/*", ...v.headers };
    if (!v.playlist) headers.Range = "bytes=0-1";
    const res = await fetch(v.url, { headers, redirect: "follow", signal: ctrl.signal });
    const ttfb = Date.now() - t0;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    let ok = res.status === 200 || res.status === 206;
    let reason = ok ? "" : `HTTP ${res.status}`;
    if (ok && (v.playlist || /mpegurl|dash\+xml/.test(ct))) {
      const txt = await readHead(res, 8192);
      if (!/#EXTM3U|<MPD/i.test(txt)) { ok = false; reason = "broken playlist"; }
    } else {
      if (ok && ct.includes("text/html")) { ok = false; reason = "web page, not a video"; }
      if (ok) {
        const cr = res.headers.get("content-range") || "";
        const total = +(cr.split("/")[1] || 0) || +(res.headers.get("content-length") || 0);
        if (total && total < 500e3 && !ct.startsWith("video/")) { ok = false; reason = "file too small"; }
      }
      try { await res.body?.cancel(); } catch {}
    }
    r = { ok, ttfb, status: res.status, reason };
  } catch {
    const to = ctrl.signal.aborted;
    r = { ok: false, ttfb: Date.now() - t0, status: 0, reason: to ? "too slow to start" : "connection failed", timeout: to };
  } finally {
    clearTimeout(timer);
  }
  if (!r.timeout || timeoutMs >= RT.PROBE_TIMEOUT_MS) C.probe.set(v.url, r, r.ok ? 20 * 60e3 : r.timeout ? 5 * 60e3 : 10 * 60e3);
  return r;
}
/** Order in which files are tested: roughly the order they will be shown in. */
function testOrder(G, S) {
  const k = G.filter((g) => g.info.res >= 2160), h = G.filter((g) => g.info.res < 2160);
  if (S.sort === "smallest") return [...G].sort((a, b) => (a.info.bitrate || 99) - (b.info.bitrate || 99));
  if (S.sort === "4kfirst") return k.concat(h);
  if (S.sort === "1080first") return h.concat(k);
  const out = [];
  for (let i = 0; out.length < G.length; i++) { if (i < k.length) out.push(k[i]); if (i < h.length) out.push(h[i]); }
  return out;
}
/**
 * Link testing. Best files first, one link per file (fastest-looking host first); a file's
 * next link is only tried if the first fails. Stops when enough files are verified.
 * Built for Cloudflare's limits: max 6 open connections and 50 sub-requests per request.
 */
async function testLinks(G, S, maxProbes = RT.MAX_PROBES) {
  const deadline = Date.now() + RT.PROBE_BUDGET_MS;
  const want = (S.limit || 20) + 4;
  let good = 0, probes = 0;
  const queue = [];
  for (const g of testOrder(G, S)) {
    g.todo = [];
    let ok = false;
    for (const v of g.variants) { // already sorted best host first
      if (v.isTorrent) continue; // can't be tested
      if (v.isDebrid) { ok = true; continue; } // debrid links start instantly
      const hit = C.probe.get(v.url);
      if (hit) { v.probe = { ...hit, cached: true }; if (hit.ok) ok = true; continue; }
      g.todo.push(v);
    }
    if (ok) good++;
    else if (g.todo.length) queue.push(g);
  }
  // files whose best link is on an unreliable host go to the end of the queue (stable sort keeps the order otherwise)
  const weak = (g) => (variantPrior(g.todo[0]) <= -4 || kindBad(g.todo[0].kind) ? 1 : 0);
  queue.sort((a, b) => weak(a) - weak(b));
  const worker = async () => {
    while (good < want && probes < maxProbes && queue.length) {
      const left = deadline - Date.now();
      if (left < 400) return;
      const g = queue.shift();
      const v = g.todo.shift();
      if (kindBad(v.kind)) v.probe = { ok: false, reason: "host failing right now", inferred: true };
      else if (kindSlow(v.kind)) v.probe = { ok: false, timeout: true, reason: "host slow right now", inferred: true };
      else {
        probes++;
        v.probe = await probe(v, Math.min(RT.PROBE_TIMEOUT_MS, left));
        if (!v.probe.cached) learn(v.kind, v.probe);
      }
      if (v.probe.ok) good++;
      else if (g.todo.length && (g.tries = (g.tries || 0) + 1) < 3) queue.unshift(g); // try this file's next host now
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, RT.PROBE_CONCURRENCY) }, worker));
  return probes;
}

// ------------------------------------------------------------------ ranking
/** Picture quality minus buffering risk. Bigger bitrate = more risk, and risk grows fast above 12 Mbps. */
function contentScore(c, S, ctx) {
  if (ctx.live) return 50 + (c.res >= 1080 ? 5 : 0);
  const r = c.res;
  let q = r >= 2160 ? 30 : r >= 1080 ? 22 : 12;
  if (c.codec === "HEVC" || c.codec === "AV1") q += 3; // same quality in a smaller file
  const sl = c.source.toLowerCase();
  if (/web-?dl|blu/.test(sl)) q += 3; else if (/webrip/.test(sl)) q += 1; else if (/hdrip|hdtv/.test(sl)) q -= 2;
  if (c.dvOnly) q -= 3;
  const br = c.bitrate || (c.adaptive ? 3 : r >= 2160 ? 12 : r >= 1080 ? 4 : 2); // unknown size → typical value
  if (r >= 2160 && br < 3) q -= 6; else if (r >= 1080 && r < 2160 && br < 1.2) q -= 4; // suspiciously tiny
  const risk = 0.8 * br + Math.max(0, br - 12) * 0.7;
  return 40 + q - risk;
}
function healthScore(v) {
  switch (v.status) {
    case "ok": { const t = v.probe.ttfb; return 20 + (t < 1000 ? 8 : t < 2000 ? 5 : 2); }
    case "instant": return 26;
    case "p2p": { const n = v.seeders; return n == null ? 0 : n >= 100 ? 14 : n >= 30 ? 10 : n >= 10 ? 5 : n >= 3 ? 0 : -15; }
    case "slow": return -15;
    default: return 0;
  }
}
function chooseVariant(g, S, force) {
  let best = null, bestScore = -Infinity;
  for (const v of g.variants) {
    let st;
    if (v.isTorrent) st = "p2p";
    else if (v.isDebrid) st = "instant";
    else if (!S.test || force) st = "unknown";
    else if (v.probe) st = v.probe.ok ? "ok" : v.probe.timeout ? "slow" : "dead";
    else st = kindBad(v.kind) ? "dead" : "unknown";
    v.status = st;
    if (st === "dead") continue;
    const sc = healthScore(v) + variantPrior(v);
    if (sc > bestScore) { bestScore = sc; best = v; }
  }
  return best;
}
const tier = (st) => (st === "ok" || st === "instant" ? 0 : st === "unknown" || st === "p2p" ? 1 : 2);
function sortFinal(list, S) {
  const br = (g) => g.info.bitrate || 999;
  const is4k = (g) => (g.info.res >= 2160 ? 1 : 0);
  if (S.sort === "smallest") list.sort((a, b) => tier(a.pick.status) - tier(b.pick.status) || br(a) - br(b) || b.total - a.total);
  else if (S.sort === "4kfirst") list.sort((a, b) => is4k(b) - is4k(a) || b.total - a.total);
  else if (S.sort === "1080first") list.sort((a, b) => is4k(a) - is4k(b) || b.total - a.total);
  else {
    list.sort((a, b) => b.total - a.total);
    if (!S.resSet.has("2160") || S.resSet.size < 2) return;
    // Balanced: among tested-working streams, never more than 2 of the same quality in a row
    const good = list.filter((g) => tier(g.pick.status) === 0), rest = list.filter((g) => tier(g.pick.status) !== 0);
    const k = good.filter((g) => is4k(g)), h = good.filter((g) => !is4k(g));
    const mixed = [];
    let last = null, run = 0;
    while (k.length || h.length) {
      let from = !k.length ? h : !h.length ? k : k[0].total >= h[0].total ? k : h;
      if (from === last && run >= 2 && (from === k ? h : k).length) from = from === k ? h : k;
      mixed.push(from.shift());
      if (from === last) run++; else { last = from; run = 1; }
    }
    list.splice(0, list.length, ...mixed, ...rest);
  }
}

// ------------------------------------------------------------- formatting
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(b >= 1e10 ? 1 : 2) + " GB" : Math.round(b / 1e6) + " MB");
const fmtRate = (r) => (r >= 10 ? r.toFixed(0) : r.toFixed(1));
function titleText(info, ctx) {
  const ep = episodeTag(ctx.id);
  let t = "";
  if (ctx.meta && ctx.meta.name) t = ctx.meta.name + (ctx.meta.year && !ep ? ` (${ctx.meta.year})` : "");
  else if (ctx.fallbackTitle) return ctx.fallbackTitle;
  else if (info.aioTitle && !/\|\^\||mbps/i.test(info.aioTitle)) return info.aioTitle;
  else if (info.fname && /[ .]/.test(info.fname)) t = info.fname.replace(/\.(mkv|mp4|avi)$/i, "").replace(/[._]+/g, " ").split(/\b(?:2160p|1080p|720p|4k)\b/i)[0].trim();
  return [t, ep].filter(Boolean).join(" · ");
}
function formatStream(g, ctx) {
  enrichDisplay(g.pick);
  if (g.info !== g.pick) enrichDisplay(g.info);
  const v = g.pick, info = g.info;
  const out = {};
  if (v.isTorrent) {
    out.infoHash = v.s.infoHash;
    if (v.s.fileIdx !== undefined) out.fileIdx = v.s.fileIdx;
    if (v.s.sources) out.sources = v.s.sources;
  } else out.url = v.url;

  const resLabel = ctx.live ? "LIVE" : info.res >= 2160 ? "4K" : info.res ? info.res + "p" : "";
  const fast = v.status === "ok" && v.probe.ttfb < 1500;
  let badge = { ok: fast ? "⚡" : "✅", instant: "⚡", p2p: "🧲", slow: "🐢" }[v.status] || "❔";
  if (v.expSoon) badge = "⏳";
  out.name = `${badge} ${resLabel}` + (info.size && !ctx.live ? "\n" + fmtSize(info.size) : "") + (g.isNew ? "\n🆕 NEW" : "");

  const L = [];
  if (g.isNew) L.push("🆕 New link · appeared " + (g.newMin < 2 ? "just now" : g.newMin < 90 ? g.newMin + " min ago" : Math.round(g.newMin / 60) + " h ago"));
  const title = titleText(info, ctx);
  if (title) L.push("🎬 " + title);
  const vid = [];
  if (info.size) vid.push("📦 " + fmtSize(info.size));
  if (info.bitrate) vid.push(`📊 ${info.brEst ? "~" : ""}${fmtRate(info.bitrate)} Mbps`);
  const codec = [info.codec, info.bit10 ? "10bit" : ""].filter(Boolean).join(" ");
  if (codec) vid.push("🎞️ " + codec);
  const hdr = [info.dv ? "DV" : "", info.hdr10p ? "HDR10+" : info.hdr ? "HDR" : ""].filter(Boolean).join(" ");
  if (hdr) vid.push("✨ " + hdr);
  if (info.adaptive) vid.push("📶 Adaptive");
  if (vid.length) L.push(vid.join(" · "));
  const au = [];
  if (info.source) au.push("🎥 " + info.source);
  if (info.audio) au.push("🎧 " + info.audio);
  if (info.langs.length) au.push("🗣️ " + info.langs.join(" "));
  if (au.length) L.push(au.join(" · "));
  let hl;
  if (v.status === "ok") hl = `${fast ? "⚡" : "✅"} Tested OK · starts in ${(v.probe.ttfb / 1000).toFixed(1)}s`;
  else if (v.status === "instant") hl = "⚡ Instant (cached on debrid)";
  else if (v.status === "p2p") hl = "🧲 Torrent" + (v.seeders != null ? ` · 👤 ${v.seeders} seeders` : "");
  else if (v.status === "slow") hl = `🐢 Slow to start (over ${Math.round(RT.PROBE_TIMEOUT_MS / 1000)}s)`;
  else hl = "❔ Not tested";
  hl += ` · 🌐 ${hostLabel(v.kind)} · 🔍 ${v.srcTag || v.upName}`;
  L.push(hl);
  if (v.expSoon) L.push(`⏳ Link expires in ${v.expMin} min — may stop before the end`);
  const fn = info.fname && /[ ._]/.test(info.fname) && info.fname.length >= 12 ? info.fname : "";
  if (fn) L.push("📄 " + (fn.length > 64 ? fn.slice(0, 63) + "…" : fn));
  out.description = L.join("\n");

  const bh = { ...(v.s.behaviorHints || {}) };
  if (!bh.bingeGroup) bh.bingeGroup = `fastcombo|${resLabel}|${info.source || ""}`;
  out.behaviorHints = bh;
  if (v.s.subtitles) out.subtitles = v.s.subtitles;
  return out;
}

// ------------------------------------------------------------ main pipeline
async function computeStreams(type, id, P, ua, ctx, env, opts = {}) {
  const t0 = Date.now();
  const S = P.S;
  const live = type === "tv" || type === "channel" || RT.LIVE_ID_PREFIXES.some((p) => id.startsWith(p));
  const metaP = live ? Promise.resolve({}) : getMeta(type, id).catch(() => ({}));
  const ups = P.ups;
  const seenKey = "seen:" + type + ":" + id;
  const seenP = S.newBadge && !live ? loadSeen(env, seenKey) : null;
  const results = await Promise.all(ups.map((up) => upstreamStreams(up, type, id, ua, ctx, opts)));
  const meta = (await withTimeout(metaP, 500, {})) || {};
  const runtime = meta.runtime || defaultRuntime(type, id);
  const X = { live, runtime, now: Date.now(), meta, id, type };

  const dropped = {};
  const drop = (why) => (dropped[why] = (dropped[why] || 0) + 1);
  let total = 0;
  const groups = new Map();
  const parsed = [];
  results.forEach((r, i) => {
    for (const s of r.streams || []) {
      total++;
      const c = parseQuick(s, ups[i].name, X, ups[i].w || 0);
      if (!c) { drop("ads / info / error cards"); continue; }
      const why = filterReason(c, S, X);
      if (why) { drop(why); continue; }
      enrich(c, X);
      if (S.hideAV1 && c.codec === "AV1") { drop("AV1 hidden"); continue; }
      if (S.hideDV && c.dvOnly) { drop("Dolby Vision only"); continue; }
      parsed.push(c);
    }
  });
  // Wrong-episode check (some sources send other episodes). For anime, numbering can differ
  // between sources, so only filter if at least one file has exactly the wanted number.
  X.fallbackTitle = "";
  const want = live ? null : wantedEpisode(id);
  const strict = want && (!want.anime || parsed.some((c) => c.epE !== null && episodeMatches(c, want)));
  for (const c of parsed) {
    if (strict && c.epE !== null && !episodeMatches(c, want)) { drop("wrong episode"); continue; }
    if (!X.fallbackTitle) { // one consistent title for all streams (from the first file that passed)
      const d = c.desc.trimStart();
      if (d.startsWith("🎬")) {
        const t = d.slice(2, (d.indexOf("\n") + 1 || d.length + 1) - 1).trim();
        if (t && !/\|\^\||mbps/i.test(t)) X.fallbackTitle = t;
      }
    }
    // union-find style merge: any shared key = same file
    let g = null;
    const keys = dedupeKeys(c);
    for (const k of keys) {
      const h = groups.get(k);
      if (h && h !== g) {
        if (!g) g = h;
        else { for (const v of h.variants) g.variants.push(v); for (const hk of h.keys) { g.keys.add(hk); groups.set(hk, g); } }
      }
    }
    if (!g) g = { variants: [], keys: new Set() };
    g.variants.push(c);
    for (const k of keys) { g.keys.add(k); groups.set(k, g); }
  }
  const G = [...new Set(groups.values())];
  let dupes = 0;
  for (const g of G) {
    dupes += g.variants.length - 1;
    g.info = g.variants.find((v) => v.size) || g.variants[0];
    g.content = contentScore(g.info, S, X);
    g.lang = !!S.langSet && langHit(g.info, S.langSet); // preferred audio language → moved up
    if (g.lang) g.content += 8;
    g.variants.sort((a, b) => variantPrior(b) - variantPrior(a));
  }
  if (dupes) dropped["duplicates (same file, other host)"] = dupes;
  G.sort((a, b) => b.content - a.content);

  let probes = 0;
  // stay under Cloudflare's 50 sub-requests (each addon + redirects of tested links count)
  const maxProbes = ON_CF ? Math.max(4, Math.min(RT.MAX_PROBES, Math.floor((48 - 2 * ups.length) / 2))) : RT.MAX_PROBES;
  if (S.test && G.length) probes = await testLinks(G, S, maxProbes);

  let final = [];
  let dead = 0;
  for (const g of G) {
    const pick = chooseVariant(g, S, false);
    if (!pick) { dead++; continue; }
    g.pick = pick;
    g.total = g.content + healthScore(pick) + variantPrior(pick);
    final.push(g);
  }
  if (dead) dropped["dead links (tested)"] = dead;
  if (!final.length && G.length) {
    // safety net: never return nothing because of testing problems
    for (const g of G) { g.pick = chooseVariant(g, S, true); g.total = g.content; final.push(g); }
  }
  let newCount = 0;
  if (seenP) {
    markNew(G, await seenP, env, seenKey, ctx); // every file the addons sent, not only the tested ones
    for (const g of final) if (g.isNew) g.total += 5;
  }
  sortFinal(final, S);
  let shown = final.slice(0, S.limit);
  if (seenP && final.length > S.limit) {
    // a brand-new link must never be hidden just because it ranks below your limit → keep up to 2 visible
    const extra = final.slice(S.limit).filter((g) => g.isNew).slice(0, 2);
    if (extra.length) shown = shown.slice(0, S.limit - extra.length).concat(extra);
  }
  newCount = shown.filter((g) => g.isNew).length;
  if (final.length > shown.length) dropped[`over your limit of ${S.limit}`] = final.length - shown.length;
  const streams = shown.map((g) => formatStream(g, X));

  const report = {
    at: Date.now(), type, id, title: titleText(G[0] ? G[0].info : { lines: [] }, X) || (X.meta && X.meta.name) || id,
    total, shown: streams.length, probes, dropped, ms: Date.now() - t0, newCount, fresh: !!opts.fresh,
    tested: shown.filter((g) => g.pick.status === "ok").length,
    ups: results.map((r, i) => ({ name: ups[i].name, n: (r.streams || []).length, ms: r.ms, err: r.error, skipped: r.skipped, cached: !!r.cached })),
  };
  recent.unshift(report);
  if (recent.length > 20) recent.pop();
  // don't remember an empty answer if an addon timed out — the next try is usually fast
  return { streams, report, _retry: !streams.length && results.some((r) => r.error) };
}

// ------------------------------------------------------------- 🆕 new links
// For every title we remember which files we have already shown. A file that shows up
// later (an addon found a new release / new host) is marked 🆕 for NEW_HOURS.
// The first looks at a title only build the baseline (addons' answers vary a bit at first).
function stableKeys(g) { // every identity of a file (exact size, file name, torrent hash) — signed URLs change, so not those
  const out = [];
  for (const k of g.keys) if (k.startsWith("sz:") || k.startsWith("fn:") || k.startsWith("ih:")) out.push("h" + fnv(k));
  return out;
}
async function loadSeen(env, key) {
  const hit = C.seen.get(key);
  if (hit !== undefined) return hit;
  let v = null;
  if (env && env.FC_KV) {
    try { const t = await withTimeout(env.FC_KV.get(key), 1500, null); if (t) v = JSON.parse(t); } catch {}
  }
  return v;
}
function markNew(G, seen, env, key, ctx) {
  const now = Math.floor(Date.now() / 60000);
  const rec = seen && seen.k ? seen : { t: now, n: 0, k: {}, nw: {} };
  if (!rec.nw) rec.nw = {};
  // the first 3 looks / 30 minutes only learn what's normal (addons' answers vary a little between calls)
  const learning = rec.n < 3 || now - rec.t < 30;
  let changed = rec.n < 4;
  for (const g of G) {
    const ks = stableKeys(g);
    if (!ks.length) continue;
    let at;
    for (const k of ks) if (rec.nw[k] !== undefined && (at === undefined || rec.nw[k] < at)) at = rec.nw[k];
    if (at === undefined && !learning && !ks.some((k) => rec.k[k])) at = now; // never seen before → new
    for (const k of ks) {
      if (!rec.k[k]) { rec.k[k] = 1; changed = true; }
      if (at !== undefined && rec.nw[k] === undefined) { rec.nw[k] = at; changed = true; }
    }
    if (at !== undefined && now - at < RT.NEW_HOURS * 60) { g.isNew = true; g.newMin = now - at; }
  }
  for (const k in rec.nw) if (now - rec.nw[k] >= RT.NEW_HOURS * 60) { delete rec.nw[k]; changed = true; }
  const all = Object.keys(rec.k);
  if (all.length > 1200) for (const k of all.slice(0, all.length - 1200)) delete rec.k[k];
  rec.n++;
  C.seen.set(key, rec, 6 * 3600e3);
  if (changed && env && env.FC_KV) {
    const p = Promise.resolve().then(() => env.FC_KV.put(key, JSON.stringify(rec), { expirationTtl: 30 * 86400 })).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  }
}

async function streamHandler(type, id, P, ua, ctx, env, opts = {}) {
  const key = `${P.hash}|${P.S.key}|${type}|${id}`;
  const run = (fresh, prev) => once("st:" + key, async () => {
    const r = await computeStreams(type, id, P, ua, ctx, env, { fresh });
    if (prev && prev.exp > Date.now() && r.streams.length < Math.ceil(prev.out.streams.length * 0.6)) {
      // a background refresh must never make things worse (e.g. an addon was rate-limited this time):
      // keep the previous list until it expires, try again later
      prev.at = Date.now();
      return prev;
    }
    const ttl = r.streams.length ? RT.CACHE_MINUTES * 60e3 : 30e3;
    const entry = { at: Date.now(), exp: Date.now() + ttl, out: { streams: r.streams }, report: r.report };
    if (!r._retry) C.streams.set(key, entry, ttl);
    return entry;
  });
  if (!opts.fresh) {
    const hit = C.streams.get(key);
    if (hit) {
      // answer instantly; if the result is a bit old, ask the addons again in the background
      if (Date.now() - hit.at > RT.FRESH_SECONDS * 1000 && !C.inflight.has("st:" + key)) {
        const p = run(true, hit).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(p);
      }
      return { ...hit, cached: true };
    }
  }
  return run(!!opts.fresh, null);
}

// --------------------------------------------- pass-through: catalogs, meta, subs
function catalogTarget(P, idRaw) {
  let m = /^fc\.([0-9a-z]{7})\.(.+)$/.exec(idRaw);
  if (m) { const up = P.ups.find((a) => a.id === m[1]); return up ? [up, m[2]] : null; }
  m = /^fc(\d+)_(.+)$/.exec(idRaw); // catalogs of links installed with v1
  if (m) { const up = P.ups[+m[1]]; return up ? [up, m[2]] : null; }
  return null;
}
async function catalogHandler(type, idRaw, extraRaw, P) {
  const t = catalogTarget(P, idRaw);
  if (!t) return { metas: [] };
  const [up, cid] = t;
  const url = `${upBase(up)}/catalog/${encodeURIComponent(type)}/${cid}${extraRaw ? "/" + extraRaw : ""}.json`;
  const hit = C.catalog.get(url);
  if (hit) return hit;
  try {
    const { data } = await fetchJSON(url, RT.UPSTREAM_TIMEOUT_MS);
    const out = data && Array.isArray(data.metas) ? data : { metas: [] };
    C.catalog.set(url, out, 30 * 60e3);
    return out;
  } catch { return { metas: [] }; }
}
async function metaHandler(type, id, idRaw, P) {
  const ms = await Promise.all(P.ups.map((up) => getManifest(up)));
  for (let i = 0; i < ms.length; i++) {
    if (!supports(ms[i], "meta", type, id)) continue;
    try {
      const { data } = await fetchJSON(`${upBase(P.ups[i])}/meta/${encodeURIComponent(type)}/${idRaw}.json`, RT.UPSTREAM_TIMEOUT_MS);
      if (data && data.meta) return data;
    } catch {}
  }
  return { meta: null };
}
async function subtitlesHandler(type, id, idRaw, extraRaw, P) {
  const key = `${P.hash}|${type}|${idRaw}|${extraRaw}`;
  const hit = C.subs.get(key);
  if (hit) return hit;
  const ms = await Promise.all(P.ups.map((up) => getManifest(up)));
  const lists = await Promise.all(ms.map(async (m, i) => {
    if (!supports(m, "subtitles", type, id)) return [];
    try {
      const { data } = await fetchJSON(`${upBase(P.ups[i])}/subtitles/${encodeURIComponent(type)}/${idRaw}${extraRaw ? "/" + extraRaw : ""}.json`, 6000);
      return (data && data.subtitles) || [];
    } catch { return []; }
  }));
  const seen = new Set();
  const subtitles = lists.flat().filter((s) => s && s.url && !seen.has(s.url) && seen.add(s.url));
  const out = { subtitles };
  C.subs.set(key, out, 60 * 60e3);
  return out;
}

// ---------------------------------------------------------------- manifest
async function buildManifest(origin, P) {
  const ms = await Promise.all(P.ups.map((up) => withTimeout(getManifest(up), 8000, null)));
  const types = new Set(["movie", "series"]);
  // Streams: every id of these types, so addons you add on the website work without reinstalling
  const streamTypes = new Set(["movie", "series", "anime", "tv", "channel", "events", "other"]);
  const R = { subtitles: [new Set(), new Set(), false], meta: [new Set(), new Set(), false] };
  const catalogs = [];
  ms.forEach((m, i) => {
    if (!m) return;
    (m.types || []).forEach((t) => types.add(t));
    for (const r of m.resources || []) {
      const name = typeof r === "string" ? r : r && r.name;
      const rt = (typeof r === "object" && r.types) || m.types || [];
      if (name === "stream") { rt.forEach((t) => typeof t === "string" && streamTypes.add(t)); continue; }
      if (!R[name]) continue;
      const rp = (typeof r === "object" && r.idPrefixes) || m.idPrefixes;
      rt.forEach((t) => R[name][0].add(t));
      if (rp && rp.length) rp.forEach((p) => R[name][1].add(p));
      else R[name][2] = true; // accepts any id
    }
    for (const c of m.catalogs || []) catalogs.push({ ...c, id: `fc.${P.ups[i].id}.${c.id}` });
  });
  streamTypes.forEach((t) => types.add(t));
  const res = (name) => ({ name, types: [...R[name][0]], ...(R[name][2] ? {} : { idPrefixes: [...R[name][1]] }) });
  const resources = [{ name: "stream", types: [...streamTypes] }];
  if (R.subtitles[0].size) resources.push(res("subtitles"));
  if (R.meta[0].size) resources.push(res("meta"));
  if (catalogs.length) resources.push("catalog");
  return {
    id: "community.fastcombo." + RT.ACCESS_KEY.toLowerCase().replace(/[^a-z0-9]/g, ""),
    version: VERSION,
    name: RT.ADDON_NAME,
    description:
      "Your addons in one" + (P.ups.length ? " (" + P.ups.map((a) => a.name).join(", ") + ")" : "") +
      ": only working, fast-starting 1080p & 4K streams, small efficient files first. Dead links, duplicates, CAM/TS, huge REMUX files and ads are removed; new links are marked 🆕.",
    logo: origin + "/logo.png",
    types: [...types],
    catalogs,
    resources,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

// ---------------------------------------------------------------- settings
const SORTS = ["balanced", "smallest", "4kfirst", "1080first"];
function normSettings(o) {
  const d = RT.DEFAULTS;
  const pick = (k) => (o && o[k] !== undefined ? o[k] : d[k]);
  const num = (k, lo, hi) => { const v = Number(pick(k)); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d[k]; };
  const resList = String(pick("res")).split(",").map((x) => x.trim()).filter((x) => ["2160", "1080", "720"].includes(x));
  const S = {
    sort: SORTS.includes(pick("sort")) ? pick("sort") : "balanced",
    res: (resList.length ? resList : ["2160", "1080"]).join(","),
    max1080: num("max1080", 0, 100),
    max4k: num("max4k", 0, 200),
    limit: Math.round(num("limit", 1, 100)),
    test: pick("test") ? 1 : 0,
    remux: pick("remux") ? 1 : 0,
    hideDV: pick("hideDV") ? 1 : 0,
    hideAV1: pick("hideAV1") ? 1 : 0,
    lang: [...new Set(String(pick("lang") || "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => LANGS[x]))].slice(0, 6).join(","),
    newBadge: pick("newBadge") ? 1 : 0,
  };
  S.resSet = new Set(S.res.split(","));
  S.langSet = S.lang ? new Set(S.lang.split(",")) : null;
  S.key = [S.sort, S.res, S.max1080, S.max4k, S.limit, S.test, S.remux, S.hideDV, S.hideAV1, S.lang, S.newBadge].join("|");
  return S;
}
// ------------------------------------------------------------------- pages
const LOGO_B64 = "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH6goGCiMKRzvOkAAAgABJREFUeNqM/Xm4relRH4ZW1futtccz9NwaWtCaGkmWkISMQAyGi4TMbMCOk+v4xjjPk/gSYyexE08iQDAhJJjReMTGJh6wgyEYPGA7GGNsjEGMAoSQBEJTS+pWd58+5+y91/q+qvtH1a+qvn2O8tzzgPqcvdf6hvet4Ve/Gl4+Oj4xIjIiJiYmIv9X/DFjZo6fGLUPcHyK67P+77gUfsJGxGxs9XVrFyEyIxrE5n9jYiLtl13dmJjI/FHNrP+MyIyY+2c/xh9mNjP/3/b1y+9B/epx1Xz+S3eJCzHW0d/80loSMZn5h/yKTP0m3C5rfgFePdidf/6fXxYLTERsbGztNoSlNmK8m931cv6T2pLVNdafs/ppE4H2hf5+DEkxyFn8fLVque9NjGKhjIhLBtjIGM9Rouj/MTau27PFHhmbkAnlv4nMjIzYLFaFuHafmIg5/sd/v1ou/2luawiXSa0MtqOJmGGf481yDeoBUurxbly60q7hN2a+u0ww57a43BvWPF6vviTxgvFDy6fhWOJYhpJ+87XG/tcmWn2WidhqP5nlLvKK2116osvLnSIbC1CPi51hYiapT8dV6+IpnWy+pau1Ysgvt1u2D1j+grHibPin4UXjP0ah864HvoqcusBsbs+I3IKZQfy4iQ1TGNHLusdMzAwdsxBsf9t8OmPL3bGSRhPx+0iucjwxQxZWq+5vyXFTLHkKRTyY+vMyWSwG0ep9rK2mqy120T8hsEbGHIvIrpOwq0bM1i0Ox5qxa2/tmFl9J2xBPDKcDyQBch7WBda3Nnpt+S0vQk3voTmWf+XYNUhCW9z6bkpMPHMqdtoSvCdDGpSZjOvGRMZsTIZVM98IMt/7fAbLpVgpnlmqN+M9Oc0ibNsKJHA+WrcT/l8LO6dNXS3kn9hgy43wbG6h2SzVr8yf3dUTGtQDaxM/sXTDZGq+CGG72a9PwDTMNjbTVpg0xbusgTEMB547tr3kqxv8uxiLy/7B7vwxjHCasvbm7DvZBMbvLCHoTWb6h6DztL5gKXHzJ3e6sfXTpbyyW0q+dNeSYm6XwwOkRyprmUJk6+dsd+Z2A64rtnciIpKOmErJwoauL+jSQSxQmZIbY6hVN+q5eOlcAO4snyFWtjxLAq56sVqK0Cz/AawSJ8rL1YtXKIFvcDKenbmtaTxdQ0LNS1M6hviKwUgZmfgTjc1mu3LulDaG23L3LcJmWz3SZdBhuZqwpl08mwO/dMu0kbUypXG80rVQ6b7TK4G+mwdn6hrlV8iVS0NmK3yDK4aBY4OVICxmu/7KGBSOoFpM5sIKK5ybNumSfWlykHb20m8bGLlknnFBbgLao6RCUFY/MuuXDtB4Wf+6hhusZreHIeyFKrqgsjGzC3oEAox9ubT4/VnxkGXB2/qk/4Fep/EuGcWOAxmxGQutVtwfyNwX5euUQWH2cAIQPJF584xmxgGJS62sQUO7BHepA9TQ/8si6D66rz+zJZoD9MYzlCdOIwRcADGywFRY8Fquhu0Q/6e/z1Ui6zLb5REPyxGXZ0TFvst9qVKpYdtyr+yuApdYCWsBQ8yULEIXpCZ53Gw/XXrgfp9VmIL4tJ4u433H7VAXhsyvNyGW2lY3hR9gQNqEkBFABNxoDmYl8Oy7t7KHHK+ZEU2PCCjFkZgSh8Wzjc1mGzfJULLgLd+xC6mCEXWzrZazL3161W79IQsrzc31ZW7fsDv2pDscS4OW0hPiWhjAMR8sPzA9IpHmpfOR8L6AKvh6rCqepmAn1/WxuhWPA1/kJxrbwPFQcGe5FqEniZ1WkpB7EDtl7S27wQioU94Oq8qXtqRWEHcyJlkDkrVfuoQ1oQJ3+K3uDNcPt0IDyZmVCl76Qu1HvFfZXaa+LitEUUoHr49l5dR5I5axhQIk/IKTtNWdc2uCrnJJS5moh67oqGES7uatm40ws1zEVmp0gxe4QAgQXr1Mb+A6+NISz9rJlag1jan1WwnGChAnnOtMF3OFSNCAkLxyDQwvxM3EpGyl5iUFlmRVeCdu6Cu/V5CxrWl/Yha29rr9z13isDtkDW6Q06y2XzchR3RUOln/S1hxM25ycFn1MrCqGKqpSZdxa9JQ10FAALFt77hWDSxIjymZiKXhlCZyGfknVmGC9zNETmYZiTcTFDvdH9QCCsSVQ9aBWeG3rf3ejM3VBNZ6FfCHqbIUFEAhNiuix8kFrI0BJ/mPgxcrKjXvnhCx0ICl7UlH2nxyeO22rgyj4bsIjwt4FG/oixgsS4X1yZqVnwu0kRdxOOmvWviw9rZWroQm/ikBjKRkoxsS/0s8YVqlWAAmYgPA5LqX2Rr8ECxou2Qxo0na4uqx18VGr/zwijwmTlkMq+crVPvhVib5MbcUzezlphmZmdHYbA5arFZ5C85XDq+fARYnpOJ+2fZv+NAyKanvq01JcqC/eudtLnt+W/+l1owRnHDdqfnqSw4y1H21yh2Z5S16OJg+zKy5ATid5vAT6lyGY/G/dacmtEmDrdwUXTag4XKsmX+6FDDlNyPag3tceb3O8NpqafJtyvVYLmaC27yjAV3kTS4TA30nm5tdJx9AKfFa/Wn1eVDMBUvTxKwkHAROuinDvdgaw+EGZ/JcIPfQtJBdbp6luXQdoKaId+K/jhnqj604cUIit0ktNAm7asER2EpWKkAshTW7vKUI3/pP6t657C0XjC2pYLssd30LZrzFKpcxMK+etgOjIg8M8mKrGBFvUzixLV1nLvMdm4itbXAIb6xj/hrfSdJyBbnzIkEeEUivO/6Ee8LzpoEArXPp41Y4mZHWYK53d2mz2q3GxLq5Tpkru9/eAz+8I+TA+ueWJPzwX07wSC3FTM3R+xchu35jKz64kg6r164A1VI+mnenO9+NXD/jieHH8gZduWJxQO4ZdZSai2BrWc/HMwYtUDe2lrxJuefcGa6LrDSseMngr8p9pitu74Po2brgrpHLigStNcxbpD7g901Dbf1chFoDR4rOzZXLLFqE0l5WMUGDZ7CDbfVd5sv0MgecaJKYJqOZwno1S1IildAzYL0aoxllTnNYGBg3CbtmMOIrh9ZE8i6m1MhYXCZC4JsAXzbCrdKCrUUS+UL4HXH+t8ntncuBt0s5MKvX6EhmZUfSfFDlEFO9DNniJsSUCAdaFnQoBfiOwH9NvfLqb7x+gMRQyUtjubkeOC1wvEQWl/RNpIJtuashi5EVaVnSXKtmyfN7BJlOxB62xTgjupVm1aJA+otlJ9iJygCXRWg/iMxzs2GXsVUjJPwpYWRcL4GtClF1scd79NfNLDFeKx+rGO9c21ZfkXmKeD5oskrdwLqiFnbKfcnQtkEQDzHTkBoR2HnXEqsAtu1XZURy+yzRr1VOCrfLbWqRIudCx8I2aqz5m0vvhnXKfTVKANXFOULu/E4FH7Gi9QzBIqzwiLX1QIwXgVNS901PM96wlL0SMpgqXq3WZVNSkpxvvMZLdMeCN2/ZDD7CSZQV5NZAxd2lxx7CDHMGDxV+560vgSiz1O8MXNcbBvGm0nfw54h+jEBjZGBiwSeUq2lReND/ZZXwqTFNB2USunoXKVlqvNJz3IW5DFmIJQRkZTnW8tHkOO/L/blLBFZ7V49WvG7eGfvbItGVWcezpv+t0HN1/XVkye29UsWYLhmvkmhLqQJDiXqzzK9X3r0XAcVN/L8IE2I1G7+aENHaWhRBy7kBDQu0NTCqJQPVSXBGjXZti5/wKL/bKrhA6hjzSvzSx3CqVNvkHs/1P3znP3q6wHmgqtQqp9Es8eo/xneFI9h2SWIShodq+dKDx8uUbwAnHSltqB9D/oC4YKLbBqVgGLxzWmWrVAXZpQcOo9PEPbyL1R4mLDJeWxHofYsrsNct3xBXZkD5RjbDbMDqWK0HxxtlUSVKE6mtaRrCEJ4Un3JILUFDbrEquL5sVvvawHhat2st/sfHGE9ZMo1ERrn0WM0wIpV56KWCbPVaWX3WfEzj3wCt2xusTDHDlkPCmPO+mbyhujRiqHh4ys8yryUmHyCgMeH9UvGBcMZmsy11gHuv/Q2WL81AWgtY60YGlbUqoFoyVaLUBRsvCWSX8dNlE9aj/SaYYQPu8DUtluCOH/AnVOASnk77lSAp1hau+i5vdMk0pJDWa8FimJVqwPYzZ40HVaasXZyijr/xWXiRpmnlw/AUaADofmMdOeRe4cuuHFWCa3de+tJdmpvgJlhUVhMiFLaL+3NcMjwNsaxv2FejvpkqCecEDa89ZuC3SuPUY0fsJ/n5+Chi82Z0OjlFkX9xZJvGuK7SCvURINRPcLkGyXMZw3gzQHX9HDISgV3/HfYHDBoDE+VbZFyJR6/9s1SltCLtGf3DiLRXau7aY9wsOV2iICydatrmXEKOTcsykkYbc6dFzcpkWSpM1hRZUwaDKyK4xuQ6Sijpjj/1sJZ2L7W3K13LXRUH0YOPCuIIBBTQeriIXgsWd7V4m8SNq3WmKj7FDeEnW9uMwQHhP0xdPCzr/7FqGXKSEdlUn+akr7Jdp+iFfk3YCwIduiKxsl6ht4DF1rbYt2GE9Fd1jfw34MjKCmBlVvDVxcdq1VZtB1AI/D8ZyNwABZVVvaRalKoUC1Klt77+zf/W7nK7X15uFU5TNKURp+Jkthfii69Ye4Ye7PY7YpUgqM7QlD27A12v2iZKmuDxUxOSg+ouuL1yvlvqQRYcrAsE1uuKMHgNjtYruSL1QUJAT1aoqyl3CkO7M3csuvr6mLIWKG+0ckTd5PZLXvoOcatusGZ2KL1O9yNdlgn9I63uudEed94KV4W/yGa/Qg98t4fEl2HbaotXknBZUBqqtDKpkIzamzWwy4fMqDZ/BOBxBz22Xpq7wFq++3s1wYGMovUHcfLdv9XM0br9p9LIdPc74jfGUT+eX4A5/xjPGRbLwEZQ4EyuZbzrSuKBVz9ABEqrvcuFxcXrN+3RYyml7XI8SK/Jzx4mpHLWUDRvbM0ewG1bXRBYuP6/jFL6kCKd2GhVgLVai6yjsyDFMl1N1OgoXhmfvqCoWmsJozskuL9b+f3u2O3yU7Ud6K6PO1VHVRG9Tnm126W9NW6OPl2/3bEu+B6CTzNAp64Zd67mags5yc4sqQ7G93Lg0B/Ussg2fpmY0uwu943YMFiPqh9agylaeQ5qoTqIBiSEsbLlddfP21Z5vf7BuBgxj+1mSxn1tggQEhp838orYx2aLjGHXuM7DY6t6Zi77QU001Bl3eW1WQWmO96ttGpdxnB3D0D1anntyyTQeqfTUjJnp3Rzaa199o5vceJybnDtY6bcCj/HInJ/j3Qjl9+L23eK5qBYzdUK3mUxLrm4HlSvueH1t0JMeSUCiAU+VtScN0K8UZ/FU/DlXegvzn0dL5H6+HDZ1wwkk1pp6XLOvQALxO0pI5vRy+7C7QPlr58RpGJ2BnWnvyo1sRQngvBk+F7fyg3hS1+8ywa2vFK1of0/fIvXXQHIYRCvgEKLlJElSlI3fC5IjUu56s49YV254F2ty12/ZcmGWsEX5ru8+6VXM7BJjMq0pEAubcHqIgk2se21K/WIcElruS72IoxfI3H8A/hyA72p4vnNJPfu0n8IK0WNxUkLBAYsu05WX0yrjRs1L0yZXyEympo4RG1NltZWcBZWE3Ex9GIVUmRQSc0Tcf8Q8u0tvsZfqtQLwmVW4C3bO1ax1UoBqTuF/EmDa6tYtc9DqSx+XRCCH09rvb4lSZFsjVovRXuM+HSLFVBDTlZuMmXLiLxftiyvASGu1xr38XdJjQyuJQvBEZKuloVT8NuNjWsZUKi9WsiVPNcvajlzm/Cw+czl1THtoaXYW6J3bVCr1Yqy2hkYh6AZeF98pi2cRxiJTEuLY0/wBu4BgjCGrLdqak6EnDYqM5AZNyVNBhyafXoFz7m9S8lmc3qN22iJpF5iwFXORVXOyPWNS7gcV0hjXzvntrKIcrtTn2Cn1uVJhSa7syuNLkiQf5o3X8GKFIJcXi6hrHs3TLOOMtpl84IQkSpVW4PPxg/3tjwiaiWS3H7UsW6lRPsHuTa0mxA8VZNMNGMhWGlxcMkGbDtcChYgQQvVdKDLhr/cQwrWneHdpS9FENziq67Ml6WqoBAVg2npHoI497lTJaocEadx09fSYVzf1nvQI+HU22QJYXrXARNcX64Ip4Ig1AoTFNerbewYMJ7HyuC00MAysZaJrdjXJhdr0g0LR1TSsHJixqv3ri+3WLsFVS4QwMVoBm43LyxyCc40U7jGzg3oNqHnZjVwf1idtJhRClXRA/xKenx8pMlq2az2up0a6FmW2D5ebTdfRnbQLlprfaCdlb+rFyFZ5SbgvYrXueTq8keW4Hhd2JYRZgb6cbV0y20ZuwyEDJm1z+cHAKsSBJZIIg+WiZmsEOXUNb68OqXYcEkQTHA0yalgFRs/U8Y57omO/3W6osxQfL7mZhUAC6oyW6qg4VbhZDpbo/71ngZrtj63aG0dLEQQNvaS8DSlzGSEUc95rNfjDtGorTSCmafg6CpubS6sv1H0HkCA0C531ydkzmV2icLTcMKhTkut0tQWl0YwbMQ0+Q3DbgSSt0oLWiDERrlkA0R735ITruDBGtZMU2KXPG9epTt7WJl1vTGlISwo1RM3IZFwn9aNUl/6wBuGepvI/qwrppp2JopHsJKNHBlqrl8gDFxtxKpdp5YR+Lvwy/p9Ld8Q5gYltm3lqniE2us1mwfVqtCjC3Bu4yVHGjwo30UUV3vBK8Hg9WUL3NIlx+RzM7LIIEhXK8C+QnutBocKtVbQmaUw1vcNoprqAeffVoylKaLfIVBE24QAXIXD2ls1EV45AroEie/KC+f1m2hmre5KYu7ytUvUKppmQ6gxH6NWMWCPeZllRV2lkW3Cx6WdbuIGWbnESPZv2XpF25c5PVIu8toYNx+LvY88NbxWivAKH5T5r2bABF1svILtuWJYmwqdrV+TuUPgyw9G5TJbAjt3fr1+Pf5MkcgNjj3pgOsSaEcvQViWlu5khCGQdHy4rT6XdPSVJTIzof6L5p3WIAURLwp21vA9bgJj40QSU47rMFtt1motywJZ1KJzCmm7wxoPd8nuFYdpqS9vQkkFl+o03IshF3cR/wocKsZP4H0X8g5+d+UanW5laM7lPsha+qbzFVS00upmv3n1xY/9OLkFxGshxBbzCk56QIi6qUvkTBqsbGNfa5bdYZgu/ym5yWuUB+gbu96CO2Ev80ooVgLWIhduMhJAqLZfiH0sCnjVXgoHy8PYFqS7u9R29JPfxtMFlE7ndenNyvVbGY+gAppVS5/ZxSO/yJmHS+Bul61zxxeXbdrdtyatwuW9WP/I7r5ZdxPAj/Gx9OcfU3I/xjUb4P//63Z3eanGdn+Mb3DtEXWXUyYwwsAOTYhKUutSraFw9Z8+camAYAC7Uip8PraXy+rjKe5yxx5GQ3gc3qeqG/PR8SlXRX0Z0VyejE4iEr1zIbGaBB1mS2Witrxr90tZ/uCIvwo+89cfY2/BM3XRafcBAdyocmr/ykq/FIvUwcKcl1+wnBuxVOciQoh06fhp4/HWSlXwpDs04zuEvK8/vphLz+tVvSTAl66ED2SGIEWSuhNYtfI2iHMpIAVGa9Jey2nl6y+lp7Ch9TwZGqIcri36umsoO+IvAXwsRS+HWMkCtgOuoKXgwSTyFHcNKWikvmWyp+WE4yUTlq0WOs2FNeFaiz9UxyC6PdRqdQz1bvUyIQ4eLVX0w8zCzCLkfyPM2mIiEiSDBDLOPuJCONCkONJVM2IWNRNhU/OLrGvyqmKLjc3Ub69kwmKqfmVh8fQCBh2zKggpZlNFDKWweHd4GTZBITUFoApkSWQY4gExMhNmrY50UltEJrOlskfEpsoC42LKgQXUjFjIzFgkNluNhc1M1YTjNQ341ExVzYzU1MhUzS9C1XLPTYPKZlJ5fKsg07ICtLyRBeBOTN/T8fBYVt8C2WqX9NrQEpG/uNOqmREfH58W5rBAr83ud+29wxI1E9P80GWZTvuAyzSuFL9mAveFdsWyyfHKpUoiPMYQERYZItR9Y1vI8HlpplRZBjObKbOo6ZBBpoSTMrgtjrAQmZoxk4ioqrCwMDGbautdV+Hh0wVC4GM+UUgqjgGwoM7i7iwkGraiBTuRJbfcAjWFAvTq8tSVRp96+KnGcZiFMYmRIk4kVQPA1/CCFRmZ+jAn7LCqZsxhZKZqRCLDTPPOhKdSXeZFdVlCOUoNqGi2tGGNiCr5zMRvukaGIDW7jfrftYRgddZZGEuTf2dIHorl9zk6OUXYAyNiSF9Alps5LwzX+NSuCAXP8WSF0laddWXxIMBJRxLKpQAl/DCLgT9u4RVVLKqxpCJipkbsRlGEiMQFjvBqzGJkkkY0s4/5UOYWkVPZwgFVxqTDKWKWNA0IQAwZaLgfUmI2JWZSIjYaY6iLZLNTGDnmsaFcjlgw/QgxtoXEi/OJbLYYXFw9FQBOSAmL6YJ4qiQlIUh4SDJiMVOKTvmWOe4QNVbGWNjUyGhe5mVZlnkJIcrKlbuGKwY5CjWoWrOUs0ZYwD7QGqR1C1umhCl7ttoqNmWMW9Zw3BTDlUamQLcgktfI9A4Fi//rVQNWAQ9d/gLDAWU5Rc9DGbHwtJkOttuxmaYx/IeKJ4nnlVBedmI3cFBOj+1Ro4cQZKbM7Xct+MJSkE+NwR6wxGvB7fYSEVMHYESS1h6eZBWetK9V/a2mOcU69UoSaAWJYFmqd5Qgt2xmIkK5gkSkGaGltsfmuIvq04JCA83UNTXrKczfIqszxCwNqAHnQkKZp81mGkNETFU1gCLxXUVlVUrYIHV9vpNMDERySfQuR1ApOZdvt1YZTgVojPTaX6wS6Yy0JaSWVs/W71QuwJeMkaUqlbjLH8tcFnlidYhsttvtZpqmATmIW0jssglLE2IJV8skOAiMuewXixBl5XsGgGXMfBnS6qfK1ptA3PIFw7mIS3/MTGK8D4okjUxCqrikhchI4jlbfhaRFA+8sXWU5FIY7kWEiR3qCOAWSALEMIi4qvAm1BhZxNDXtNlpLCh7JddiVF/0ObztPkxEJDTGmDYbEcQPsVQpSK1yu5tthg28446xLg1D1HchmKt8dS8JWmtL0zr0A6wyC/0SzBVqtEe9U5svf6mVA8bz9cKnS1+u/6ua5O1ms91uRQB0OAJVzoY7Mpe7Ymtd0FgyXhU3V2VrAog3uMJGip4kQ2MkdoKE2592FRfBhhvAo8A6OM7Hsii2XcSIREJksxKCuZI7oI45zzIT9z0UMT7OJIvndFkXDsQfk1nBFgJOQt4lDLYgBcJkIsHbecjR082dY0PRQHAMlska4AwgBzY1tYWYx5BpmlhYF0X3aCJjbvFPt7SXRKOZe1vrCwDJXb/Llz5uJfjdgYzNZnup4vzydaK8HLU43C5zCdG75246Al9sd1539SeASnxyjHF4sJUh4TIY2KhAVeNjzLKtzUlKdqIymQ3/noCkcPxTWA4C7M5DmCV0honVNOFDWHruIMUXWciLCs1dRyutBaBlzGKuvs/2xiiop7hOK7AEiVW7gbP92MjER/lzhWPxSBFRxdp62aKwUK4nLH5enI2tBDSkc9VNmHGHe1XVeE9zb9wvZuyLD6bP1UDVVBdA1Vx96OnHkGOsRATsDOtSfok/tmStOLzL+uR/GdO0vXRX7vf1EA0SsOJKVhvTLHOdAIKZwXe+UP4Fhirx8Haz3UwbogIG7nnC9oggA+nwIb2ex40S6uh/Z8NFQOAX+oYZIxsiVHMGlDise2pFwy0QL2JU8gLRs7CwOXo2t6+u1gLJz2RnXprVLNEWRQzBqHCJjM1gUQJ4bLXTwmwRC8HEMTppEIRQcrvBPsVWRbSghlCCSSQ5uxR7zlrmeEjUJXX34J7Hcg+YGWW4vq0cTmyaJmFZloV6gJPizXeGiA2McbKDlS69hGb612B869/rayfxyWOz3fLqbiWa+Xiri1+G/NyjGS7bTIU5je6upN0Km7HIweHBYCEmNW0TWwiBqRsVFSkDTNCCEKG0V3AaZsQkMa8RjrtsehoDNmbhLEshdgaEWTiKvCWDU2I20jRc8CopohEfRigCJxJ/j0P+LDQ0uHnY/hr+IVbxBNoaALqQQnQPIYbIPsgfLCpz8UsA9x5kSYKkiBB66R5pXDsPB0YIVbGNpbXD+92J3ZnVVIidRyajMaYxJtUleCrOvV1LyIrwzd2C5+2FDZf0pKQzxLDPGy6Y3749NtuDCgl7yJeojMEy4w0RxZU1WpeMdC+Q0thRHlATBMpUZUzbzYbTbIWLFzcwSHK5+A5OY5NgqOkqGkBrfcMZIUMNDpPE3XQZ18DPeGxhSAHzyDyFb4B/d7W0kBMi8swbG0rfhAkIxGJElJgtHHcRhP15EXcjw0iNyPE6kkHxJSN1P1sKVrKUqMUDj+p/cHgIqa6QyXOCOfGEV02EEUhAh9BGGZ/BovvTwaMlER46Fp8yERljo2qmS9iU1kbcN7LAUiHfdDJlYisQSETVFemyzaWq+2ViorHdHLT35NV+JlJLib0jQuAOjlskGq6WPsaf7KhgUrVpmg62G7x2PICQqCqXlSodl6zLGAxX70+nkC3/uHoUm0SBRDRj3ByuRwqSNAbULy0ImA5oMrPb8qBJ4/UB44opciVkFiZn/D2VFifXeoyRhFSsBmcaLMRYhcVzyRmxZPAFRtKTBiQiZJo5iWR0iVJbJOsUK6CvQyOqYDkTiwi9WrIVv6Um2lANZNBqo3FxzX0yMhvTMCPfX+rVnGn44WexVuVfS0TuBBb+/HZJTq2keu04zNjnAkEcPwZUSS0ozbAMQ9Ji2urxc+DjGv8w3IX/TM3GGNvNpgiUpJeDLSlhSAsEE2FCTMiVZoRk4asjamgrxT1ky7RxyxUxblqOgqnyXOV6y93Hf4JuWtuCjEqJiCQ9NIBKiLiNzD3hvUB1Wxxb7+9lRK5JIVptn3MvLAOPQFwJ+Vr4yBQZXRYWU0Pij9daAJMTMYxw7rNbFws3y6B1uhg2IMJRJ1I3YCKapo2ZLstSbpNXr9MUybjLZ1r/y+3wHD+E5eYu/1TNmF3OPU1jPW2wDsohCKuinjhNta1Sp8uIyuUmPkQcgmDaiMxsDNluN5rFkJq1ejW9ITYvs1p+/ejg17xwMKS9dqswe66Hh6lNnyKrDkhLiPQsf62pDAl7zJDewJ29JsclD/gcPrBn7z1EUEVwbEKsGu+KQEIapDQizbIpCt7fAZJgB4K28kxw7ojbFORJGNEyR/mOMRmpGnGUP6XkduZfIgTxwiFFrGAiSL8gC+BmSWQw176RiK+shTGMQIuIVHW73U7TpKYhn2mlKzF9pzGv0tEVVLe1GNY/mmFPh2L4NUdRGKfxCCWF1GRDfvw+y/TrYUsAy1gYoB2YKt+QFUNqJkO2m23azNXKI0HPbjlVw1OjaSDC0xCjWL8GSalhuczDeeYoCmaINFlthNcBgWLIgZnLmadNS+HDpSuZ19WgWsDITOMrxFA1v4Uf7K5JeJhlr2BlGNIlEeLueC2PVRS6p8DnzfOilsUoM7N4VlTdl/0WpiGcYkDoq4MIhA8PLQrnmHczRBdpNzEzO7oK8XPzcLrX4wftlyWNm2kzRDSpevLpS+tgpm9liV4WD+WY1qYP1N+tLCJlQIOf5lwgAI1q5k3YlOg0f9+frCtVd1rNsyUliP1yn7vdbGCociIW6HCXbASOgAH5ybpV5SXa7Ve2vP/OYzQRYmMnSilwauYcPGJOT11v458RpggYyMsuPO2AMIEAMdzuGepJg3KlKFCDUyNGqRK3ICtKgZwqAeBxdRJ3K56sSNmvJF/oSOUboEQtPkd+jbJvCWwLSwF+1NERedGVaSv/7xMcapU5sBxTZRUCBOBX8IKJ/8hkDFOF4+3IJ+1B7mAeMw0xNNTDpem+JJm5wQDkOa7Bl6VXqiBEKTfaTGv2CK07swBVUz84FbXq5Ev6689m2mQKxM0UG2vKdDyQGWnEbcFjilHymODuq9oqfVw+BiTL5VMNrd6OBPINnWlhIq+EicuIVMBlZMSR/fEEmZmi1Ac7EQDBUv+IWFUpcsxQHBfrFGEjIoXNUiKNkg3AAkfsUYNtqqTrjW/t9lBctF+uqoHRDRLVcsJCnlmj4AaAcRwBBu3mN/YP+yVVkfxWt/QtG0GBK4SzK9oXVtMqZWiU/NU0TVSSdUnoC8CAjHQk14B2SWS39pCtIq9WvTPGbBzFcPlRSm65X7OlKPCp9Z9mMI3SPSLRmSIZBIvZZrMZQ7LujjhljRvVi2AIZiYRGact5yrJiQqkdFWgt8FjQFiSEWdvBqCGo/ye0gJ3hvMhfDITHslJhOGx5ii8SqPWUITM03TIzJGTj91BgWuxvEG8veAoN3aAUICizI3E2RIE7p+NVEQAaALWiFNk6N0rOgcTPESYmTVEQNY7HhZQSLLVMLcYQDEKDWNnjRy79fH1Rs7uktexEvEYg4h1WUCrpT+k/AtygKuTBBmRc2tzSmu4ChPWOKiEuyBQGuzL2B6U5irH1a6NrciNY0qCAixmEk1mNkSmzaYlWdpDmbHzHsQu4y5PQESJUDifK/0QM4Exd76ZNYrhiJk1PlPOoyQlS5+pZa6hL6mELFIoOuqNYyG8eQBqErpcFRGtfy1ypEzFXoecGcgrV5a4lL+LlWIYnAcJl+nn5ClLL0pwV4bYqlfPr+xONXXdi4iF8/2N4onVL8rcOsxhUFIWojSd8XDi6zsCW/kuaWP+QWoPGd5OcAeiLSVPuxNMdQe4kC/oAQK/pk8lrvl3cwVIEi3sdsRkFDx4C/dh7NdKCnMPKw+RTnVMGTdi2m42RERCiY9hyByPKrQlUWq8MhyGBfhD1SfqYri4wQoQmg+N+Id91QPUcM3H9vKVHkhQEhHA0f71MST2kYjYQXKS67REy1WY7wzJkwerXcMuVgtGRV7cyvVW+buG5mGWGeobp8CShFhbmseimLOmh/DKZixSuWx8zJ+5zs0LFMIN9GZMkQuG0IXJSCMZaME3NGKhk5ShakNkmZc7ggDYODjXiIIa7ljHn7CB6dYaqC5jCy0ZUz8iqVAQVe4Z8VWL1C4B+qyTS2/K67eonZ3GJNMglKNBc6CzKPCkqO9taCPlOescE12htDFZF2qvnfg0aE3Od2XiIVl0ZGifsvouKoiySSDeXx0Zw+nWVgajlPYTZt+LQMPSW0TP5WrKchd3GdcTajysUe4p2veQicRKxlxVA/yjtvXNZHH+1jyhlzLjOh9dNvWt5hehu8gesPssR36FSAksQKoqqJCMlArCEASbPGnQAEa9QMX8l37XHUqaaH+XUGJOAae+HpHKDJgSjagwR9lIU6NoOv2CfHhRUJY/R3yXextywDzGyMIz56gNZK9HM5LBBsaRW449Dg6OlCHQxZsyOOrQWwFiQXTrGxzP7O2sTohGNxO1GANkXkheengKCBu1alk6jaJpZJDRSBe2Uyjmz5gZgUFHTQRlsq92B9Vsprp0OMvYsVzCpBSdecHbA36GeaycWeQ7iISrbMGD/yoBdAeLLuGYn+l380Juf3yAMfJTrKDYSTkwuTXz2xEhoo/YACy24zn/7TRGBAncA9EVrMeztIi5NMLlrL4QCtGmRtVXychsbKaDCjBSR5KHxaF+aeygiEmJtQvWs8GqUxLhpEbTNHlfqcff2WIpAqBvTaRBl62gH4uZiRe3wa9EpifYd+CVYrGInD4cAqUEAEAHSfdYzExcuGWNOYIRQ11+oZDaBF9HYRRKs6l/XoCpAyslMYg7+IpJEJCcVdlkSXUWVQYbnMC17z9q111ThaKIEBFR7VQ9AZW1r8K4hN+r+lAL2U0yNB2sgZsw3L4MY8oOwWkYXiE+pGYikh2wa3nPJypqz1+5OZiKBYFa1xFve4L0AGOz3YakXwK/FU/dAeqbtpWK9lsV4I3/MSMR3mwm3wYQ0KxmKOf0KyjSpxb4PiFNuAugJdAFElWTwBJEwoNYM4JjzOey7GJscA47F9JKYca070EyUmivEcrpA4Hixc0/o2syOwEEpWNxp1DpNvs9dBx8dKHchS10Rsp5p/RnixcHhdy7vQqVc10WHQ/IwSXkISpjnphtVDUGI3UY2BaRUNDIHh4Z1JS8OvVyCrdzC1D6xG7w3GHkVKNk2tbf45oX0C3Wao/WothyemE/SnR9G7InGCiDcRpS/c+6X79DL6IUKEQBCadyASJQGWPE7JKkYoJUKNjT/zdSY4FBhJByAShvT5EcWP42QxhJuecebXKpJolgpZkEsSA6/Wq9RKTmGGVM4e2IZiRibOQzQhCetUjPoMlsql1do3EkQm0JKbSMgEp4GmFlRJzApF6VAvCgJYia7oWkdQFgIU7zgV2k9MKZInAJH0JUtUhYiDKUHO9S3YBEkc6DdKURkJgKk5Sjr7WFMSGy6Kyo4HJlt8vSZtUir8WHKp7lrov4b/GGLudJJ7j0cEPuFQmk3Jbfz++gbcWKL8q7uCiJBA6M6itmdoCOgoS8WJgti/5r4BlDYEdEHFPKPeYU4SxNATrDd/x/ig0QIONQXyFTjdVifzbcPV2fERGpKhYtbDuxhBEVMlO2kK/IsPWliMiDIw7Ji/YqJAhLtoU6eUIuMI67NC8olSPkrMXwa4ka5k0QY6VTYiKQ84X1l8LO5X8cm6BEB002HOsVQA3lQ/6eWhYbztPrPQ2ODw30hlaKlEdFdBmBkoxRWpEKX77bnyvp3Lv+yWm7vgmanAkbcTsDZmw2Bz22h1xETWndj2HKEw+vXFA+ZwtL3VdF+bFM0/DNz+ZESIMQaL7wUo6YWwDil/MyAC8AdmcCxoYUnEY+r2WzlURppD9iiUBrFqm3Z2IRFrZ+daKsdQt0xjlfqO0j0FkRmGl5W6kFAX4xM8U4CGokT0OcFQfBeYlHqwwON/UTkVpJX72TRksDZciEznI44AT31t+FRQZRa9uHUUd0jzYdKGTRFJQxAQORccyFwYUwgIP7Fvi/hFmjXHWFNUCS5ZJn1vOy9BOlyrSfBNQPZfSIcWw2B+uPucxnWNenO9yhZh3XJY4LKcSkIyfOp8E88hqc5IwxerjjbdC4RYmqQZjWpoE9qSjFM19kJEMMXeJMufYD3HZYQeSRi18t32VaMQUCaormGApWx0kPEAEQ34ZeLlsUX+4w2RZZhcbJtHA6Q/PUImFxJSd/zcyzW9BKkBBLcaPYRUdZjeotQqyKgiD9aaoToEepA7NwjHuJSDx7FlDNwGWtY7c6U4V1s2TJOkULgQkViuC4tRYgsK6oHLCnQuxLClBFD5cjkQpro00p1yvJ3op/wmHULqZypVqGcoS8UgEobqsyWHp1Re0tpRX2wgFUfjNprL4ySdJFEUV4KW/UzzTCmsmithjlM1kSE0kcCSClcJBMTKTqabWS6BWF4aOtXAANwUkYq5IzCXzV6jWsElxR9Abr1/p2mXJwiHOyhvpnuC3VxUhTOL29UMOeegWPemYucFEGEtj14oILunZyBpEyWMzAVESoQXU34kFMyE6KQ6xJKrABnfhcLUXvZfe6Yd9Ad3KVVfjDedl3xXotD3sJ+DQfDAnNaN6MjLUpiZXKxXIItRaCQN+Woo4nxBIl1g9Iy0FAR+xkVMtKqIEPPyjmNiy2n7BNUYdsqgF+LeQzGnmJyNv23CA51cApQ2V6gx6Ak3XJCFdhBUylhfqGgmBmagWJLDzYh1AJJZnu35IRHeUQgEgLeEQT4U3TN4TkYfYgP8QymIXUzJRFPF1KRqxEWSnd20zQV4Hm5qg2A9Bw8xHzKTwoMdMm1zD1FKXWhOpnlJiH7UPDEEylsHdmUrYCMzfYFVqsfq8orEi7yyI5MqK5FmtfpajYkxw7liKTSlwOGUnpZO1blLBSCixdamxexFB17+I5tpttweMGfjIF1AvoyvQDIqXGUXMh4Z+BxScRp9Uk4IriDpUxQz87o3o4Y9DU5w60Q4Klh9C+qKgA6u6F1t6SfegfyDzcPT4hAaeNSIQHSjhJRAZPlK3A2FJDsM54iYqDOPotDTVAkltvFgtSWxfKEigoyIViqMxSuyECxKQIKLljCgo+16f/YpdghsHVcjQBMHER8LCPhipx6CNHns9MLrWWYI8YNVFWcXAa7qAGOP0/OJVLZJeLb966kovN3GeUVcxteYZ4s6Ymq2rwlnkmoiiF4Px3C96IUQnVYFftVcO+XE+WmsCUOWuRISPIrcwPST1RzBuPUgQPdhOcQ51iTxvd5aShWyl15lUEcbsAjkd1QPJ9EU9SJoWyprzYWeFBzEq7i+XWPO+WeZnneVl2s50tthtjisZ8Zk9cNECHeqGso8EYFWry2fg9Xim2UY4EjafLsS7opUpeg6lfUDKCsf5yGb6XKUwCMCAqk3cXJOfDa5CBQMsguCCDs94dojFAu2DdM5le/LnXmUZtOvUVqKS4GJlXzraGySSSMsohariO8im4P5QrRtMduySqNFHGJJZWHTlOBCoGCiuNC6xS6Pa6yKJwnsGbccCX4Klzb3KwKwq+jByRU0v/hLsyxymCccuMY5AsnY2mHVEiEhZNE6HqY6uyFbw/sb+vhjqNi+Wm2Hjg9He84N7PuPf40ePpPuaxm2/dOH//h27+wuPP/vyNi/ezyHYcYwYxRyqCAZcDxIp3HxqRoEeMOAbFEXHc0oxpRJILtlNtcelJcGwEkAbPqOadA6S6JHXEMmJ6OYosomjH++WNiG1ZqooMIg3CGVKcsL50N6wUr8whE6lzWVpLatFAkO1yzGKsaTct9yWDBma1xVMEYaJw1yZdqXfJYLTi8EbK1NXbb6yZ0uTXpnrkumyylHBA5aRgJsB7tME/jLeBNidiFDZN3WSl3vadQxow8MyUSYxtGBuRkklpbvl/vJFS5WUDrgu4xNaEmRyaxfQQn4qe+uJwUMa8zBfnTz3n9Hd+2gv/+xc++MajzYmpY2kmMmGamW7s3veuD/+LX/zg3/3gjZ85mI6ncWimTAZ9A8TyVhjTyrOGWQzm1zwLHgHDkmKFzR8IVbHnwZ9ohmfxIlHLRmqmMTTJhUeMFu8pVVX2QRuRIsi5YyFEiO4C+S6mAJV5PkAxqUw5Pz14KFINug6AflEfLsSqGuFcnjYQ4WSrr1hQfcbgV4kAuRAFh6VBDIFHb7jcbTOnPENdrH0IwQuEl4+Pr6TmxM0KdHZp47Uu5uXStVxWNYOr3m62ppjaRwXSc2an875GJDLUFhxgjeEzsfoCR+KgyTdSajlc8tQyle1lCBa53jjIIbhtFO57+kg8hLX5Yr9/w8f/969/5L89mE7niMZzq9zaj4lpM/j27sbPf+Bv/sx7/9Lt+fGTw+uO69QWUxUfXwfzDIujxtE5EHYmyx4ZHJElKQnQQRntuSaosCiZqY64S1hriuJjWO5k2ZlcCckwWzWsPGdzHJUpSO7SmrHN6FV84md6i+zFzIJtny5aMAnOzoyIFJO6fA5pilPYWZBX5pCMiOb9HhLWzCu4nKZDtBbCfLREKsHfZpyRX2s9wXDLqJ/x5btjrsga7TTzXy6o34s9n5IkdJZAwZpn9YEZZsSuaoCh+nHKi89YxdArwqA1Iqx+GlGgT44mj5g8iOZd4URoDrF03uvnvexbX/+Cr5qX4TX9wuI5r8jUepm72cV+Edp8/PU3vPjB3322e/IjN9/OYkMmUBIBMCKv62SUlwlg/RFjBfbgy3uZGBUUFjVjAOMYDHxl9GDCRXzUYZUaoK6OrMWvEE3Y0xriwoXFyBTsUfCzlkS+RNTfGokaagq590N3kGEPvtxUSseL5WFjpzacctMFnWUrS5xU+SXzz6vPdFmF4HKtrv8rGmIQ+oBa6KzSJZvfo4wealj/ezCNXiMjY+Ckovham4qDnI6hUykShhLsHkW7SQ3AdfvKbte550H9zUa9Y2O6GamxlCDEJkbEY4zz3c3PevHXfvLz/+uzi70MdrmH9DTKLfyOEPNel5Pp/t/xvC++//QTPnjjV27u3r+ZDgikgxXrQhX3umeyIhYo3lUT3iOVbEyjtUqw2RJYLp5Diu714LHVD/uHvc0l43GYFF11LrX5p0g/oHOfzKJC0z8pxDHgusA06Ck8GkpbA68wSwRCQd0GqHZBEwLdBtyQe0IRliHdvuo5Sjqj/iQRUf/bihLu+oeJzAdjUSKO1e+bqHMRV6VraUkQrPSAJHZ7sODUBsm7Csi5FpULYny/kzSZ5rIBIF6QTE0CE2wLt+XJXQkMQt5C1owlM/GQcbHcfPF9n/+mx77pYmdjwtDlYiBrUSubyiwixjYv9txrL/uEh7/oYnf+vqffqnQhvK20F1PU0xd+tEYu++PGkENhJomR1JmgCBQDV5UDKRC8pv9FXsahNuBsNKfDtBWWjxdrZFsPsdwc58LGz5FODrJLErwFUZXg1mKZQfXjzYmlcmG4cRsCW6pDJCyLaTQq+I3LlNRDrzFQiEzFDiWpJW5dysc2aNCkWgu6JGGF+6a37PAUGxl+q6ib+IJITk1DDyJHAjBy7M0vEdj0plpV91ixipWpSN63W1xjRt6NQfVlEJfRHhmJDONlstMvfNVfPNk8Z/GRVcl9GUlzXfFaXGyxo4CLWTd8+tIHP/eBK6964tl3fPTmO6exEZ4IFRPhECvd6cxCJr9L4KLEuAC8UHJBRESS3UlRAx1Xg63NRJWRkI9A8qUIWJ4QuF2TUJNR51XralKPCzfCYv9w7JuhRh2NmU50JuxPY5zMdqG1kmHDLKCs56OIChSeMZlPpqplWqGaSkbBuDQZbcaZsHDEZDymzUEhnlSNtM+t3KPcAWxna6Ch/kIMNoGMxjQNR/kAATAWCvYirEjEZMywYUyMyWTJplecwWk+MtBHP3R8wgsTQPDmkwouYCIiIhfzzdc89w9+0gv+4PnFMrhNx82JEkzIqWYXc3orfy1ZzHb75YGjl3zCg79njM37nv65vd3cjEMglrAfcVnOmdPIG+RrkkS3DUQoe9NyXxiwkCFP4A9QWmfhwqwJBBFlA3U6wE6L5yoZdC4hmdniZnjdfQvAg63JaISwDaUegTnXUBx6yAQmXNjP9jOzMdhU1ZSSOLC69KUUQLWCcydzwscV4ERCHd+SsZkOMsCFVng6fSXT7Q8ehFMfLn8IzsLfS9JFpiEF3BuIzwQrKGmP6vrI8jBSW9yqzeJJYPy4ywoGJ2ZhHjZjZY6HHrzxZV9/PD1v0UwShPs0hmVKT7LSPqDxuI3sdc908OL7P/sF933G02e//dTtdw0RkSnPDWBOLA4fY1QBThlOhSGgNPnM7ON+Fy+JC/sewLmZc1+sYbZUKOpjVuGARNhLPyTP2ISlJyfaiCKvAdeB5zHQccBOBtlEOonydKa0weVDg+sOfe8/jBxO1i/Gg2vVUHEpG+h4KoqMktWNtQ0PgeGZljAy6VfiGI+esJ3aRnD6Ae6/KhAG6b+jSpTTB/ha9z4pD6RiR4K0Sb+RxjJFLm+Z8KhTQ/FLaR2MlutjiDQSSltQMQgJiUj28+2Hrrz6U174J/b7US+6CoYS9YGHS/Rl5OYpLBAZkxjTTvXa0SMvf/6XHR099IGnf+F8/8Q0HUb4qWmCIomDobSWBTL51FGAJAnxCHP9XZshTUTG2heNoZFhh8L9BHKhHHHns4MA1oOKc8KNxTvjsI1MRKoLTkpV8iZsIvTewB1ZTprwffWjZl12e2FESpxfwFsyRECW4NXMFuPVZnSwsRpKsEZVeZ9c6nXQDIfgNGgFSpc3HmHMJaRzh8kvFfIH93sb0RgjznGDdPpnnBqDoc+yhYwEKP1+LCTu0PI1fimpNy5LuQI98L+CzHbswxA539/+pEf+8KP3fOZ+nr3xpOldmCq9pAr4E45CSDkaFyxK6WQ2nU0eeeCTXvjw77559pEPPfWLRCq8IfZoPx4vBldFQRGF7FP1xSbFQvWSIA7zULyCqILUC/LH8bJGPm2SS3oKgLk4Y36KAL9H2sQTl/7YgUVCdRFSpX/OjXJ0l0VK2MPqLMzV89RYgCvO/W6AUbWNj3b8WO9rMIsBSukOEQ/72YqP0W8Uv448QD3ppSsEGZLYv+vBHX9Q45Cax6XNkBmz4i/ARpRIt9owBmbQyJ6m+1nn4wxtNoJZP+loLatNiCgjubBLTGysEx1+1ku+9lAehqHKy/bNasmI9ieMN5YpE/1GRiI2+Hy/HE33PfbcL75y9OiHnv6lm+cf2IwDHGcvmSsEbQpMpIaC00TjCYEN3I54GJUPkCkYTsKQ27ZxwmNUNeNXkQQOUtq7tDmqsrMOIJGeVCYB9Wgpmj4tOBK9UoOGuDSknHzSR9TjClTRlUdZ1C7JWyXfmO+Q2f6R5Eyq7gNCnNogY6qGmLtdKF/gsorc9a5wwfVLG2NKerhcjAyrcxEZ82MsIut4RExfY98RynbRgrzgzFlAcxaecgiUGNc31oeyxBiTi/2zj1x//Se/4L+dFxa+XDQ1PLVfeJATKRC61pJGVHxXmWwAfbDsVXczPXjlVS96zpfs9OaHn/pF4v00HZnPZYFvC8njcAPdokSFgJ9DXPAG6xApW5jH8r4Mqc22rNUQXQ5i2isXKg8D3cZ4utwRjAxGhFd7rNFTKsF2OcoKJwaJw6kLIbtZx50hW+x4+guN3jMvd82+wIaAko9YUaFUjCbnR3JjL8MgRh4g8DMA80olqn7vDl3MHUwxYwRMrtA8hucBjGKQhlb5Ql6HW8MGnvMO5Odrp3AqzDxyCp6ZsoxY5ZSeqMkhy/AhKlKMiGSM/XzrdS/4rz/u+hv2uuTs//4UtaSWo1JqKWIWQ2ufI3ZKH6wRkxEr007307j6wud8wQP3feJHn/31Z2//9hiTyIbyiBSDlFMKGfrloxeXk4N104XZI5ygoYcrsfyxL5n8g/m0NJ/g3U0RaWDwRD8kvLyoCXF0q0CWfdKR61hQHsBS8dCGHcwWEGAmjuohN0ug4LIFxdQbRZrwXqa2uGkFtdXrmur4OymYFi+xe4B1/NQuzMWl8h1Khr805WpiHP+axiBk4qPg2U+Py8cOzIKcbp6h65oRbTaKOTltFZiIlCVSoBx9IelhcR5efgUH7sa227wZVz/rxV93ND2g1QJPRN6p26KKbhR8+YVyoq5JaL0yqUD6o8uJlI2Gscgittfl/nte+tijv2dMJx988ud2+2emcQCFTANZzEgWrlGllhN5+x+0DeSK5cEwRBKH56WwhCOEw8UIAhHg9vhQHPOhq7CRRSzGAniI4oO0NLK5hj4xNYmyuCzr9+ZsAaOe+Tvg+IK1WZYchpuNdLGU8bT+iSWaDDaKc8XqJ+F02fb7b8c0HaAw/A6ED1KxpS7uMI5pg4rWsv7LMQa4RzyQ41SK6UDgLsPxNWPvTA6sGjjpXJxaRF9oNu8JCOvMVD0A+T5+OCnZkGk/337B9Te87gVftSwkXJcqhYcjKql0aUvzx1GqSkQqZBKgwxgUEcd8ZWM2IZlor3vjw0ce/oyH73/9k8+886NP//oYg3mKNc59aLtVI9VlID8Vb2PxP8UYYEBE7p/jI01CF0UQOPmFiNhLryM0y3wLHHk4I7CTTNV8l+X5rcGSyMu2DTatyh9KVLlgeidvkRIp+8yy6ML1hWyGjkgkpR3aUIqC2DXTxxVdttWhsdluialmHd+B7S+hkfqUNY1EbW5DMNg/DMdbfRbGnfvj4EHBjiZfzmVPaqRF6Z2XyEHX1TOsuFGStiENfrUhMs8Xn/xxf/QF1163w3GFmSUtjfG4PGs4iGigw44h6PEB1pB7NiITIzYarC5zYiTmlNFi+7PdfHL86Esf/U9Przz8xFNvm/c3IVsJ722E4W+LbqxZ6ZDakvxPTNYyKpnzTAgxSQ7kz1ClJrKhvDY7cZ0qAG1nMVwJzWKGq6DBP2SSRfAYvvrkWUqNkavouSFGf7j3xEnGJS7ZMQ8CbJYuGL2R4Q+Ab8nhqkfmboxOGc0KgV1DplKj5gYbEVldZ8BSwHI9ysYTR3wFDg5VswiCUSjP4HiybtI1In4rOXLGEOMQxuYY+VglKvunecSnsYj4CRfWHtpL2lMEBg+1/cnm4Rfe/7n7PDKsQ0esRqyeUVk7ODhjUuiAxwNxGlC8lhFHO7aZKSsbKS9DNsdH293+9uNP/McnnvrlZf7olZPnn599WGTT8kfC7JA8JjxTVNovwoKg0IzbsxLh0CVGH4ZTXVHV7DI0hC0roEM7JJgeIJyc15BuDq2MzFHKnoxGFB0h2wt2M/9jxuKglrN1zsgbaAJhq3XbFRORw22XmJV1SsXgVPdGnueOcXdJYRnQJLKOdCfOZLVli1xcATYIZb2XgquMqNaYp/5jxFErgg2KLnVjnByY0YcXqyXeCfYnJ/gb+2nBFvsWrhI9XL4GPqwpmnQL7DKwQpYEk+2Xs5c88IX3nD56caahcGs3V0UC5W7ibCPXeG34x2JiGmJYdtVkY9Jol+K96cHmUOWpX33nP3rne37go0+/7fziKdXdhJaaOKfVbPGDZxh57CK8vMcgwAisvwpJzstCblgil2wZWhj5aXzCblNbMs+wzmGVIT/gl2Ab3PxpzCiIICEJhsUUCBZPG6Yta8AhqAk3LRwyM/uxwcRiyxxDds3Kw3VCohmrZpbdtKeycKW2Cgeb1ffDhEy9I6IsPC5atEMz8y3ysIQ7BmuIsMDCfhgQdQuXzZiyzJUwfiYeWSGzGtuMVcIzSS+TsnAUqxl8pktOGHfLrNFBYiYkQjZPL33OF/iwP6IBjAiFbIA20jGl4paG36y8gSMJ0JY+/jdlxhbl7Xb72x/8kV/4tW/86DO/PG2mzTg8ObruozBUlzrLXgbZkjrsTw+qBDjY66IdqLD4Cqv6ZHlkmVRBJ7sWUHQELWnCqZFbWcKTlDG8u9Nu7lBUPeVS5T3u8cLhVtbCVgVxBShDHXISaZpRIxExNaS9jLQ1BXEKqTGSpoXvs9MZ/2MVDifF4ndungTB0ATZqpwxtbfrKKpFHekpCEyTrVKs2VcUWW5u410D41Z6D0OW8KTO+mRcDbCGyNLCq2B3W1QU5ew4k6LyYNB8n7+ykF4/fOQF9376PBMLDsEusqSWyN9NczGZLJWBXbu97z0MprsyZQiqB8Em01je+qtf94tv/9ZpksPDK75qSgsR2RIOMhrFdclKcaOapBb2XzWO5Ivzb4iMFpuRE7YWa3JC0CC10pgzixDpElvGVcmMnqx0v4F8LLryMrTkzD7gWZdg5XDQbdpKXDJGpxJjrpgh9qwQOuoq3BK0yjosP18Sv9az1rzBKk8MDhT7mRRHGIKpWeuEWtb/tfIYbahiC3hT1usrZTF9XZCCRSSTEpmnGlEGadw+0JSwxYhEyBArx8S9cFjweIguAtR6y4VjctnPt55//6dcOXro9m0tlqlMbGskAqdJSCsl40lMamE4EiN7Ki4UVYzZeJLNNP/YT/2xX3vn3zw9vVdoLMsSxDkxEccoO9JI6OGhiVSSEFNjjnPV03YgyjfBuJ4VNojND3yCEBZ2RI29WzekH6YnXrz37hGwK0MMzJPvgZsprDAj5jZFYXZ4yLD7rj6CdsdgApUoTxbLW0NhYcOR3Yu3KBnjLrb12rySQKD0YkvrTWnyx697FrpKzgBxk+WNGx4q99YWroEIxMN13notl69kietah0B+G6c/tcDBJpbHW4aD1zxA0vK7hLw8s1DQ6sSqM73owTfSEqpkaX7xJ49jT5YqTwl2zid4CqForZfQDUXC1c2ZynJ8JP/urV/zjt/629euPrgsi/HCTKbKMph51nO1PROreX+/MZvIdsjWaPgBGT7hAVViER/5OAnB3mCho/0rY99Q7aAMiNm5JTOv2pdMSYEVMiLG2IdowPRgW4yNEH+zd5+Gc40wFlAAY8sKz4bpyqfRnBrE3Hw9utC4KosMJ3YGxkqF46R/uUke4fvJw2R1KUHHER+ExNJksN2pZV1vLnkSWBBOrSL/S4Y2pSQe+lv+EN4C+GfVFlhEbcXX8Lbk+sMk0ajBqJsvoJPhsjXrkDyZObHHTGbzcnF68NznX/uM/S6yqdbey1qE6bLksayvgeZRQBEGxLirpERDQ1xJbD4+3rz9t/6PX/q1v3x6dJ/qwhjcKDLt5zMiuXry2OnpK6+cvHTaXCejZbl9++L9N27+0q1bv77bf2TIJOOQjFgXl2YtUsI8oVFVUtRxZaCOdaAY4kcySJFyxtdikoBatEqbYqZWDlaI7scIreFa3aAxG9cQmkRbXsqFR7C6AhH5FGtgdke5gkPAwWnB8196kbBxiHS5DHHGqJziD3DQYuHQCGKTaR061J8WohQHdMkDxPdaTXioZ3tir35TzRN1DJew9XD63lhdNd4URKdm7ttHCTmajLLeMoKu33HwjoICiikSzCxjt3vmxfd/2pXNc/b7xU1gowfiPVAMQO4cjEkpmiQC8WcaiVmbQ1R2W01qSmPz1LPv/g9v/YbNZqN+Rjy2/uLiqaunn/iiR77qofs+e7O5Z7EDXeLVZJrVbt88f/dHnvwXH3j8B2/ceNuQMY1jRxw5FotZ1NMXkVEsIQAlmZhSjBbxfJgfmLaoi7tGHxKIguw6MnP/E8ssUTuYdgIWTw1nhJtxnK/sUxQ9++slpVHQhecJhkcVsMrQAKqOA0s80nb2NKqHEwyTXJbzTjjEJZz5Q2FCNtHIyCZatU9S8wFdG3IGQQp2MZ2ppWsSZcWkYBqzj4wKJ+da7o2w1q5r/WHwKiAEwo2JUAIjTJDOFUNw4TS6wN44J2mbF9z3uVwAlZKA6rAnKD02IwpiQsyMLbAIpB96GqLvQTDRbLSZ6Off+m23b//28fF9y7x3/DuYz86ffviB3/fyj/9fNpuH9vPteb4gusjoghYimQ4OXvbIC1718PP+8w995Iff+56/ffPG27bTRqYjPyib0DwVZtC4zSqEQ7cM2AIAWR4dyRRpKUYyKyyNm0k/72OA5PePpxw1W8NcZ8TkdjEjf4/wIBjexgIRcUNZcXYgcxTJ+GuJZBhQsQCVqW+USg8uGw7xDCnYfxCWllDRI5yYClHQvESutALPn73GkEfwpz3AKi0hIqJpjNyZjOIN9oaZ/LCwaFUJjyzkQ+N8AFNgXyaK/nKhjMBQ5UYRnuFQoirsiCeONNzu6OB5r3/0q0/HVcWHCrr4X6TwDzGpMAtZRcNsXvXAaTbNhInZyR9lMjaZpiee+fmf/YU/N40pS5KEeLc/+7jn/uFXvOhblvlQ7aYQ6oq8pGkMEiaxhedlOSc5unbvpzzvBV9yeu3RGzfedX7rfdO0EdmozjiuBvAhXV/YSmxdFbJIEySz/GFyCitzw81Tp9kPu4I99PWMo88ILFGD7DV+Jr6beQNB4KlR0G0x3iunURAjWV0hVacgm7W0kswKNpoTaKrSbET+1/uCMnaGr+GclZh4Gu8dyrLGS1w3hkkNAYzDUoI2UXfkRZQR+wxAcxBAcSiDwZXH+CeNXB0qMS0OJiK/AvCiJKntFDpwfHgCUds/eM9nXTt8vrNSDNijAO4mpEzKZuJ8f9iEhchP9nPd0Pgnvoi/ePHPwsYT/ca7v3fef1RkMlUyExqLnt1/76e/6qVfo7qw7IQ3dQAjEw1T0cBXLDINHrZfnlU6eu6j/+Wnfs4PPfryP75f+OLiGeEBq2RCg0xaGsvnwy2qxf0HxqtC3ZyoFUwmIlLfFka4LWE1MN2RqEYYh22KKCyMeoaT/kMvUDcIb05uDQeiaoTTsUJJUtpXRCJKCTosTwzCiBIbiCmhR3qiu4imF0Y+VjsBiCG4hV1nisjQCADEmbFk/vnyXZPwhz5kZLTkC1Fn0nLt3NboArYHL8o+9bYtgTGxRJURSjcNjw1O0Nj1z5AoICU6eN49X7D1On6HCdHI0jh+lPSQsDIpUVZjQT2C+Hc9MWFlUzZlVbFFTDab3fzhD3zgX0ybYzVwfDYzXXnFi/806ZHQXgZITo8ph9Om7gmMhGwwDZJpokHnFzeWce9LX/MNr/l/fd+VBz7l/PzpZd4RicSymLC4TwhMGJwkyu4jb2VrEgZ1KkHy5yY7s+M/MDNA1giA+igWI5y3ABvskbSaWRYFhfmKOyzGcJ3hlIKWgcPGE5EPnihoxylYTI2EjYCnSrM64O/2OP7FaSgIkMI3gVA+k0FzRv5tcF5qRRPxfi8kblsOwzyK7VApw/sQvWDBVeGO07JYHF1h6nGV4SFx5qhRZsxgRWoMUaRjgdf14srhi597/VPd3Bn4TU91Oeh3UTZmFVoY4p7cTjP5Hhwb0+KuRmI+6MI2HdITT//7s/P3T9NBQAuW84tnH7z/868cvW63uxUT5jiglImPvSUa5HeniUmIREiYRHia1JZb589eeeAzX/u53/+ST/7zKld2u2dZBokEpldnHZFv8fqoACviZ3vBGGiGi1lUDBjpXrqlTFnBz+SJDJazvTGvV8Lpgqv1oro4DxygRcF45mEaElFEyhFcClwIRIaDLidu8AwWu8GJNI/NVzRdh5kOx+fNDKklrXYUuhLYP/p6ynzTx/rDK/3ouoFovjlfTV4Kkk9GlhMpEp+Dfw09NFX37XWenfPkcAHql0NZMBORKhPPy8Vz7vnc44P7iWeSrLVoYi1mzMq8iC1WQu9RgQLhRLmbkAo7ylKxhdldgTGPDf32e/8p2VJ1qTqLHD/vgd+3uyAlVsCMYHbYeJiKLUwszMM9HDsMoZjHxjJN83J71u3Hvfq//5Qv/ZH7Hv3ii4szmy/GmBa3unEoDqHBIM6bwZkxpm6b64Qbs2hvj0FAOP43m1sBAFqe0AKrIL6IUBxVx5nPKosXTbgxR9FWBHj2A0XizOLIPEgbJmYT+J5Gjv4/H5KHp1lVxAforeRtnBCDIN7ZHhS19IQZyjDuHkvA6pRb4Dv+FtytgODH2SrEjCpF8/cnJHE8DU9kRIIMRjTSWFcPjmSirhQY8bFXV9pe6Pjhez+HjIRZrVD74vZGUMDjtmCEfwjDL4A9BBfhqyumQiaibAvrYjo207O3P/iB9//kZnOAhZV5Prt68sqTo0+8mM/VhgFqG9PCvJgtZiRDhG2Qub3mkEcTMyETNmEZQqIXu1vb6y/7pM//3le9+a9Mpy84v/1RcZRoWZFN5J1F6CFq3Pjiyh0ox90bcIEaej1V1RZFQFVXzbPdszOhHSjAxEpKRKrOJZWtJgR2CFxJ40inIFOazwl2qPjLDBBWcaDDkxWo7+FypxAzakBykDJ6ltIPC3NvzWOwtQ7Au9j1/t+sFir/Q+SMG8E6ODB1QSImFyutz8ZzKDnsybUGCou0I9JQoNagpCu1JA/UTG0xmpeLK4cvunbyaltmIvEqHRWXbNIe3eIddG37lR3rkwm32JeV2Us+zViNZEMfeP+P37r1fuEtaZhyIr3/3s8RuWY2q/nFTdkWmLx5pv1+WYjIiSBmHmyDVYzEzLvePOQYTNNYlt3t3Xz/S/+T1/2+H3n4lV9xfn5rf/4syzDCGTQWYXCsaZxwxkRCienVcEJWJdB0WRxNxXRUXk1RcGftWxn+xGKXvKBDEMtx2nnnIwy+2x0S0A7hWMQGmQ0lSSX8adk6vQrQDuVK+tPqwLJA9KnGPVNISZKnfCIWbVY9LpTFjT0MWLfngZtEVVouafoeJhxATUzUDqzwhA2GxK5yAojMRyJaio+F+8zjuojNGSEmHOoYDLSwLPPFg9c/W/gesjmozA7uBZ7dQQ5E3z2Dcfstl/Sb0CKkcQwM2SATmRd6z2/+MNs+FkiE2Lab+x+6/42qM+MVqfgDNSFiVrPdxbzfLSTEk5qQiXokwMwkRINsCA9iIRpMg25f3FoOH3zszd/5yi//u4cP/I6zm0+azkMmkSEsEsd1BXKPyW4hOitJ6PXC4HkkYsu0x65HEAKEE0zEuizhbEvCUEIa7yio6kN3MgqQvFYCJGY1O3oUfDeEESoZweYalMS3s1Q0mJZSnjXfS2QmCDkyLWRALJ5wT7a5upPMc4/edGuInxGOtpg7FBrgLa6L2FdVkaMJMxEHrVkz5Tn/IwaZAC0Ku2qZH8WcHpZZNBiMoF88Lhhy+px7PneZabhRNxT0l+F36GdKphJ1cypkFEDfhA1OQIWUWSmLgkRFFjKS8cyN3/jg+39ijEO1xRd0Wc7uuf7J166/wujccaQSLUgIqYfDjvVF9ns9u73MC/FELGIiJmSDnBdyBBlPIsTTINtfXJzf8+Iv+qT/zz979LPfsvB2d/6sjCFjKCmn7Bqp2qJ5cB5HB0MD+FmqEDRQWGLKg3d0cX4pJ+jD6UvGBgUWwtsr+AnNsqL4SRq+qnQjhYd3bQsHw5Z0EeFMiR5qFFEELgtKXoQQjHuA7mJhJKnMgP5FrDYtXukfOBrcknrOwO/GTcUapQRayQiZrwhVUk4pfDh8qvoIURY3m3FcJFMsaDDNEaEZCxl2PeqpmMaY5uXsyslj109fq8s5My9JmQ5SIWfpA455LEtkZEtAI6PMD0jMcTbmhYNwcXRubEYqG/rwB//1xfmHmDceq3tq9TkPvmnwkcjCwsa8oDA10yKKPSHhRenWzeXmLV2EZZCJ2XD3wjbMBvvzRLgqwpMs+1vLOHnRm77m9f/lj1x/6ZvObj2j805kWrHn4cqJE14GXGgWNIl6itQhQj+nskDcArHnXGucOA9BWVV/kekCyxw/Uy32J0IDLgMctwMsDkMMgIw0ZTf/eBxPOa6TCZw3asFDPl8MKIaxD9fcSpdrtEutWKlDZ2kTd+WaBr2Ggi0cicrmZHFcL9ofWYnEeWXUwTMLDiaHGwEZYfBR5VmNQf8E/e/n6ZqR6vyce968me4h2jsCVjEbtHjiccSiJftJcA5OQyi3alDhhVG1IgiOIx4YyvSB9/2o4EB5NVt0P8l9169+6n5/xkNIGIdFmeLgbGxneGwTo0EXu+XGM/uLWWUjPDgwjBgJqVgE0mI0jAbRZojo+fnZ0fNe8zu/4vte8eXfQQf3Xdx8SmSg5oyIaAwhsiUKm8ji6IvAd1EHAX7F3CkHd8konLbkktIAG5o54zowxQGawmaigC08EPdcqhZXwy4D6APHT5PajFrPrPULKcrat8b3FOe/ChVX9iCPaXe5jk2wXI/Su/ICVQ/i0sn53nUXa4onqffR6mDIlIP78uXDeQ+hpIaojbQ0zk2+hg/FGAYOLxzWyVBkETdcJrn6nPve2KJ9powWJEJSp/a92cX/GYGvVEuAsuefTZkXzxPH/ChTtrEdZzff8eSH37rZnoQKmu33Z8cnj56evBTn6MJrOgc6WMXDaFuYXP3MD5YQUaJnbszPPL2f1cYmXs+EaBiLeQTiR2qyMA2ZpmneX9za2XM/7Q9/8lf90/tf/eW3bnx02Z2NsTEz7+RizwjAelTJAyG9FwwN6PL4uQttAgeX2SpbCMvoGxpDZoA4LK11kivWERNV7yQxkWWlarO6yTBa4trut9x6Nda8fXNVmtnJFr/e2GwOIjvhsXuDR2mWEhP1uKZHH5fpUVTMElWBSkf2FPWzHpbUGb1kGjEfKtQRO0VagDkhE3QmWv0IE5kMVS/MZCxD9fz68Se+7OP/hC1kZkfbsd2MGSRFGmBFfRuKPaOzMaxPgB+zfIiIxtlLJBbSg0N5z7u+7/3v/sHN9th7Mo2YZeznZ3bLjXvveeUY9+32F8TO6jINz/2qBxvEYhz9Bc41mZCx7Bc7O1cS2hwNnljJgiT1CHsQDQ8h8i+82+3o9P6HPun3HD/44mfe94tnT75vsz3kOLLYUDQAI+6IM8Y+r0tr0OGIjTMyi3mmBN4kzKz58bYotkMhIXIH/q+aykTELPWBCFqpkA0kBppadEuF2YinQQ1lwU6TRHD5fCn8xTXGtN2ydVFG9Vi8Ysc/nAEA4SgQbvpw6dqpDLT6IK0eklHy585CxKnDfjkuZFogcs3yRosk+iSxXizMvNvdevHzvuJ5979xt78gooODsTkYmpGOBCGnqOzn4Ii8xI1Q+pZQJ7KPXnkXrWGsLDyEf/lnv+Hs9nuGbBUcH7MIz08+9ZOPP/FvNgfXj45foTYW2/EQ89GKUuF1lB4Jk0im53iwEd8+Xy52Oh3w5jDidR7Eg02YRnST2zAe7iLEbJ4XPX3hax563e8l0mfe83M0X4ztYdq+FVcN4UGhj0lte5/0ka6/YlCYeAwNTSCB61JMyc2sKlFNPCdIRvj3cOd+TA70j7HPhaz7k6/ELa0xvEjFmV3s81syNtttIX78PAW/NdrAGzSBTG+TKlj3jw+Y8NCKLGIGYCsuzxos80lmVsLtbHL+EwWzRTfVuEnUKCKj7GPZTYgWtsNPfOFXb6bnm85mvDmQw4MJGZ/IA9igrAhaAvNEaadrvCIbGVrhYav3o4uZLLLZPPvMr7z9rf/7GENVc2K7CBvxGIcX5+//wAd+6Hz3W9fvedXh8fNn2ystEP3ebuYuxRT3UiTF9gvfvKVmdnA8ZCNGZIPIjzITo8HsTmNQeoN5t9OD0wdf+7vvfcmn3fjgO2598B3TdEAYOwN+kzPZb3B+hSbyGJoIyQgJW8ZICB+pjV3JzFQWR0Iy/Ipc/qEuYjhSqVWIuj+q2iNK0jwL36oLIrPDlkJsK62g8trAYv7rGI8Oo89gCVKqQnZTTCHyxR6lBnaVRHYxli3dHHGM7AsLgtY3z9pTM/6MkdnJ58CdNv1LpsCtS8N/TCIs+/nm/aevf9kj/91+VmZayLYbOdwONTIhHcHtIHYLiw5IjERY0ETxaMidhR9g5oVtOhi/+evf+4H3/Mh2e+yLG9OpglDUIdtpjGee+bknn/yX08HhtXteaXI46wULaay983BsYupjtsSs0g7e/cJnF3R2vkwHcnDCEQAMImEalcHwcXQqzENM9GJets994QNv+L18ePr0O37Kzm6Mg0OfJSNNqqrUmWD/mMgy99twblqwpi1w8q4S/rwUxVaxGuIcHUVNl6wMOy7vRJ/kdpcJ5BK2LEqG7FZOoKGDtNo9mGh+h4kM5wPEIIeWW4D0XwL4Xcu6bnfRpUbAShxUKCCDIuiGFpFF710v2WhgFUUZGY5nfXnqnOS41VhYCRDJvNvdetnz/uhD1z59bxdOeY2JD4+mgvU5AjZBCMWAk4BG1MoSsyBUMFdAPKc7WPZv++mv2916v4xt6K21pcZqTdORLs986PF/duPGL59efeHB8aOzqtFMPKBUbN4zNfwWrmbicMtYeeJ5pmdvLvvFjk7HtGUNHSCNhDEbR/bAC5ZsyG6ZL3hz5RM/4+rveOPtx9998z1vExHZbM1nFVMh/VB+QtlhwwSEsXDBfSM+GDyy4NZCqdChSr5yMeeHcWoTU0bHsKRRGCeEsi/N+rEVQEuRTuwE8x01Pr1CiJvkXo5a/c/YbrbwcKB8Kya9fBX4hYxGIjBdhR/cxyVTmHAy4zgVhgjlKYmH4jMJ3SxOiYRrQSm7oNpq5fEwKqHUi8hEZLHdZtzz2hd97RgPms3hPYYdnkwV+3pOQFgFqIBZBT1VfHkSqGZ1LCw0sY3teObJt779Z795M22iarWZU9/7mJdvJjJNY3Prxq98+AP/WO3mlXtfJZv7Zr3wfIJ6anlQSzkLIm/yGj4TojFun9nNW8s44KNTMaGFQg28P8w8xcGmwiqsQ5TtfLfjBx+57zN+38H9z7v1nl+an3582h4zi9nSKs1ge3klKJSlphyePTKlUWdKDfo01TGE0jW+16+OIQnhWnhd2UsA7aEe3dRmkJ0BakMma2MdlD/8xV3iVB7TZttKGvr70qVvgDsIqV93GqRr4vbobrAF9FUZ+YTv0kJWwDMvxa8osmM6dHCjnZIoTxCLKp4a4zr2y63nXv+slz//j+7nvaupkhHb4clEwi76KmSSATGj/gdVcRKRgI2EPUYhVcGEmOn2aLz7bX/jI+/5l9PmGEaokjy5M1mPZWYsB0S7pz/yY08/+W+PTh8+vecVs/FCe8pZ01Gc5xZCPD8QWVHvBJ54IXn2hp7v9eBYtoesZEpiwjpIhRaikH4hJVqG2ZBl2e2Ij3/H6+/71C9bdrfO3vULvOxlc7CgyIcSIWePHky7u9sm/dzSP52XwMsW/MfQj+CDQDGlRS3Ojzwe0LZyTc6a4VvzOgXa8qOZOcg5Ufl9K2nGCTFpOVOn8k9jZLmpGaxyu3b3/PkVPwrFkUnGLoxbFZiP8138TLGWzwj/JIyC6HhNR4pSn8rYJMiXMS8Xr3j+H7v/6u/cLTsWUfJmKD04GTx4QXzJmPuAeCBGX3kuTJloWIW8TCgFxVvKYNn96n/487vzx1kmBpiOQl8yNo4TEgjRFczHZnsyX7zvI+//kd3uw1fufQUfPrRfLljUMQ9MPhOZeaiAdDUJm9eKjnF2bs/cWEzo8GTiITPb4tm6wTZEUbDkaWwTocH7/W45uX7Pp33R0Qtf+ey7f3H/+HvGdusnWueTO4jPpkViruPAONyugLkJqcA0NyKKmfWYWllJUohXFpoyRcQL4S3Chp0O6oaW13pWQXC6Due/u+Wu0iUIdBmlsd1sIVkE2ef+mbo5lwre4Rq66hNiAFfqPHjiLnRAqKLhp+hSymYAkUuvkgYF85zNRLh53VTy/eG4/5Ne/LXC96KClInI1KZjli1r6FIUxnkro1GynBwVcghSfQ2Dk/FFFVrIpoPx1Id/5p0//+3TNFUFr79MVHyQZQsJmmINeVWRAxG78cS/ffL9/2xsDo/v+USVg2W5oCHG/n9kYgpONqareo2QsJLzpPLMDb19e9kcyTjxMo141IVpkSjbVmEbbEI6iZJe7HW88GVXf9eXm9mtX/lpO789Do800WSAE2mEQ+E6mKz2T7xdGvUInMhPEsiPrASHI59TiBlKUpggTaGtRSzLN4PBuoxwWj625Qhwg/j02Gy2uAyjxtguPeilPwwAvfIIMMOcyxB1rlTrycmj1uM1Qt8YJwcnogxqkyNJl0qfflkk4gtiqAcTs+znW8+7780ve+S/2s17YjGc1q5GNNH2ePLRpMrmaDv6NSUqbUwC4gdQ9dbHgD01A2JRle34rbf9jSff+6/G5oQo++eYOJgtshiqYMmNJXjFlMwxDufdE0++9x+f3/jF4+sv21594UKzkkZCANBfidz2OysVDTrMJiZDLnZ84+llUdueTnzAs5IKLWIqEQl47cYyyITdP5zv9+cHxwdvePPxJ37m/r2/vnvP26ftAU/bLN6vLBinLYMhi9LQVYK4/bdlfmjVME857DMZ7rwowlBQrcCzl74fgoOU3l1ktZJXeIxYem6wg4jGtNlQALJMmnXDnipW/2cfWzeQsO3a7LeNQgdro7Ii9icTP52B8hjHNf6hfnyVhb/0Q5i96hP4qSUieL+/+MQX/vEHrrxmXjBlmZC5YdueTkQx138hhylxe6SEvTOJmFWjHyWeC2JHSmZj0uXs13/qa/bnHxHZGKnzXeWyrPUWWaGjiJKDHCFdFpFpmg7Onvrlp9/3w2PQlYdfS9vTZbmwQe6Xokk/SkFd+pmIVcg7HFiIRc5u0u1nFz6kcAVii6uul/RBk70TyAYb6W43L4+88ORNv39zz30Xv/5zduNpOTiAQcSgEbNM45A3Ylt0sqCAwlJUsu8EcL+geggAolZDTxY+VHO6u4I0CNS5+aSk7ghXV3UHHZBzmVcSMo5SiFXzDTiahn24/NBl5wAcg1/0BhqmKFYpusqzm3E0dM3FLSkBydA0uRWtco5ELFVlrnIjLz1X2h1N97/uJV875N46sAgrsOiyORk8WKPowHiwSpQ89NQvMakwjXgBYzLRKqIW5e309OM/9e6f+3bnEqQ8WJg1n4SQ5o393QVrESP2M3iyaXsidnHjA//y2Y/89NG1F2zveele1WzvsVEooXBxpl5T64vuYxwm1kXOntJ50emUacsLEbGbfNPhbQySeQwdbMI673djml7/6Vc+44vnpz+0e8cvsKkcHESNujc8YKs8sOkMhYMlwyEACPfVg2lIn5NM0gnWlbGND2muVMsyNdIFFQmZNmoCWf6h2Mq4LOBGDvchtjwmtWOY9kicUtqQfTVQdr9X5GyqivP/Pj0GoeGltpyVo2EkEBCKGBOpClph4D4r5Yg0NzwFubKMebn5yH1vetkL/uv9vGRxdkSuTKZkWx7HotYyXBlPSQwMcNRRncEMDWELpoh0HExP/va/+tA7f0imQxysYrQyAZzMFcQnB7ClifRkCHZNpjEd7J9951Pv+sH57IPH97+Sjx5adMfi0D/0NlqLHF6y2RBXP9dnHrS7TefPqm15nIoOMzYbbMQLB9mlYou/yPA2fNvvlv39Dxy/6Uu3L3jJxdt/QT/8genwyJCuyeIcYh4x47YwOsGxZR2RJ8X6CaCxfagRbYHhyqZKTiIBNVNiTYCPK7VZO4FEbXmmXLmAwB5ZR5SJsAymyxshbmCqx+emXxU6rD1CPVTBw0sGA79CRNudZKW4W5lDAcyivRjYymFRMEjEzMu8f82L/sT9V189a3SmRwUqSsDmRTenk0s/mr+y4o1cjKIczXETEw1COzyrxIhvmaazG7/9wXf8wLTdYhw77AHiNIQsBDQIT4TBB9UPhQUgMx4HQvPND/7bG+/5p9vDk6MHXz2PrdoeCS9CUYYZu/YIOXWE5kmemJQvbtiyW/iU+VCMSMV0sI5o/1d0IQe4mliX+Xw2fuUnHr3xy2iZz3/xp+z8nA8OiQytkj57jHEutyHiQRhcpXJhqJzdrO6cZrWNrINyg+XEElE4HrtDTbpCpNxYCuUKN13yA1yL7SfFB3QJXrJtQ/s+xwUsd7j7nhb59EeMJC/chkVTiy8Nm5FQd2ycYpNisT6igLKksOKYRkN7gaHa7vTgkU957H8muuo1FosP94xKIlPmea9yyJujsUTaDF2RHAZecdSQJ5VKQwTNPWwmtJgcXX34I7/5o/OtD2y2p+rNrsLEwiw+jZllIFRkFhEZJKOhFu9eFPEeXErrp2a02ZzoxRPP/tYP75/59dOHXinXnrtbFvLgmMznNJpAKl17h9Gw0JCJZOLlgvc3TIfxKesgJdRg+2sC+0GviIR257uzkyv8OZ938IrXzb/+c7v3/pZMW54mJmJLWi/AhMSh34qpfuDz3fL7aLMGMJg4jqBsIq15ql6zhbm1yYavIuG01YmAI53bUHmalYpeGWCE2Sxo0EqxxZXvAGl5nRTYlnHO+6/6ETLdUNfJRFlg/cTl5QVWGMrTMUjLc7kKRy1mRKQxtIYHsw2ZLvY3X/jgF7/8kf/8Yl4i30xgD5kULOxedXt1GGp70NrplckxV8snMoSWeZkaATozkfDCyzg8vf7wyz/07n9z/sxvL/vzZTnX+cKWC50vbH+uy8U8n8U/l53uL3R/rvP5sru97M91PtP5QvdntOxtmcc0ydioLcTAF6RjbKeDw/2Tv3Tj3T88hhw99CrdnC7LzmGVZrctZ1UcmtRGkFq0EWLa36T5zOiA6Yij7VOs+0AfbRSNb2OY6cXFcvGSxw4+7/dtReZf/Tm7dXNzdGLBjYUQCJg6MxURH9se7L6AfFinldNyWp3Z4geVZCUKnAhAM1KvVWOz0h6gY4xD4xYB5LOmSFZFhhHz8fFp5pzDMd/ZPFNufZ2VtnwKu6S6jhyApygFsSP+LHOyBqUMZh0GgtV0sHhzV2eUCYdohYb4WfLCFxe3v/CT/v6jD33p7d2sLGa2GC1Ei/kQK5+NRjtdDh+aDq5Ni5KKRQEP0+LxFQrRQtcj+aXUZ2MRGbOSbY+ms2d+872/8HduPPErIhPLRDxxFFP4asQwNGPCVFoH077bwkLzsx+6+OAvLzc/NB2e6rK0LXaSS3Q5n3fn2+d86vVP/erpkTfu9rMtFzwNYp9cnSPlHMJ5xUQgHGKKDrhh8iDzg0wT+QSsmOySfo9IkfY2JlvmZRrbK9vjt/388s1/ev6pH5tOrpkpow2DKJJlLX7EzmPtiufMPBo6uMOrk7FwHK8aOSTQKbYWRMzxhEFfl12ko6ihvyhyywhlTcry8fFphGpArKsGiG6NcZcqd0jqpjBJf2DLGbWohYDedYTGzBQJPzAmwMGomMDdIhyLQWWpaT6OmI15zMvF1cOP/88+/SeM7ptVlXghW4jUzKUff2e1ZZn09JFDGjH9DKGCGhk5T0Io0oxGZotaCTAjUQ1qSpshG8kDt62XUl+aQEH1WwfS3s2sy3L+0Xc//q++6amf/jvboxNfK8kcalRN2XLxrPHRySv/8JVP/pN2+tz9xRkLsQzMVxRipSEqZINYSIVomKHKg4RnUzum8fDga2xkyh4Kqyt8TIhBqUi4O1O6dnhdd/IXvu78u79lc3ysaqaLZU4zDaUmzgj5UZRJRLtMHVriV9ciSmPsAQkspzlt2pwIRHyd5IINXEejkDp3IATbvqaMxuRBcCjIXSPaiOfTE/SBdA1aNaYG325BL6HGYhW6Q+B7BjH9EGBZUkjOD5gRU3RhJ1fG7Ifm7fbPvvy5/8knPPf3nu8WEsGJpSV2Fg3QREzzTLPZwdWBWst4UJ85QVH0n4FBnFXjRfwIkVk9LNZlnvemtCw6L8t+XuZl2S/LXpf9vOyXZdYZf5/nedmrzsuyzDrPy37R3Wx7teXkgXte8yXLrSdvvfMnN0cnSYQEDW0LGfN0IGLn7/23Z+/+0YPjew4ffqXK1nTP3hrGRiI62CYfo0KOiEJvhY2NJmZjvamqxidswxFRZMpMSEf06WMUBdOGabZzlvGmNx4fnJz92D+hMRAB5y5zF0dO+4coF4aSC9CHsQtUbKY+B6+CYNh3I2LMoWZqkoTQNFFBSnxGDF0g61OQ5rHZbEu56pYVWRe1mdnkNfODV4aBxnNF6hdYxrKvgFEq42/FUA9uOg6Wh+MggEzI1+dy9mW+jzAvs73hsbdcP3rpTtUniFrMfnPRNkUobEQ0ZH++8IbleMR8RXS4Bz0qZDllmpyFlJyclW1iSkZDeHiHF5sQDw7hY+YYbeIYnb0ah1g8pUWTc/lmbKb7vcr1x17/7K/8c332IzJtgoC3OF4OUiVje0znH7n5jh9anvy1o4dfxvc+dzY1WniIDonegAEiy03tqBpp2hBPrBc2n5udsG1S1SPOiRVAyTexkAwy2p0v9Bmftn3mxvlP/Ws5PLRlYc9+VFosj2+BzCCny1mED16oyRFDhFvXJEqEyzSmBKeINjN9xw9X6D9JmtQfty1jsz2AjBcIb+qQEp7KxPWI7R4Zl+cHcLnex8jpT5LuxM1QH4s6CVR9JuISjBAD8wCFEBn+vVkv7j15yRte8jWqhxqlsD64yuXVILLou2Vi5otby3QsciCmplEAF0RakkKOCpKQqPYxl36RvGBkDCh6u3z+nAlrzBcSlJpyUk9EhsGjYrZsr13df+Sdt9/5k7I9jEnLtfGZRTWTaYxp98Gfv/lr/2ii+fD5r9HDU7VZJqEco+KBuxvyEVrNI3gtntiUlzPj02GbGAIQQY7AzUuYK+y57c+W7Sd/pvz0jy+//S7eHmWWC/m4Vuji1nlVhhZCJXk0QUJ5yJepxuFldSQy2LFiy4uuafxM3tZopRBJoOAWTecE86+gc/Unu4mBGAjerDE9kc0n4IwWAVPidGSeazoQygCzbDhn5XqdM2coEgENMRuQf8gZjhg3P1tg8DTP548+8DknB9eV5nI12AiCwXatZESxbHzzAxfzXm1iDRaIlGwRWtgWH4vipQcsPsLWfCCuH4EmgqESrD7Gxz8vZMyLz1hn89aCyKOxGaTQ2KIkW4bPe1sGydWHTNWnYxMRxll1c2lsaqZ8dHXMzz71L//0k3/n8+V9P3F8/ZC2YjwHE8pGojTEBhkbDaLJog3IGw82RgstT6hF8ZwpRcEcMSNFmFtqZETLfPPkePqqr27Hv4F9MbM4/jmjQesCE40SeaRD1huU4Cia/6qcIa1tDzAzO9A/1tMAhVN4hewTifk9peijVb1+muFUtIhiMHmHMveKcKXpXUp//idGrPjzKlInrZMCMUwyH5yFNIy11/y9HwTt94pxuUrzZhy/+OHPN/XAElNTMvgINQockqDfhJc933jfxbIQT2zEKqYj5pQE105kTAtplAk5iPJKtQyUMTNCxaKbMYqryyGAZIxRKC79MaIUA9ZJaH/ziVhoTiRNCPiRyvSF1YV4sz25b37/f3zi//jSm//sfzqyG+PK0UIWJdDiwyaIBpHfYsS4FxtkRLRhu7Dlptnw8BezW4aLvsSOp5iNyW5d7N/wxoNP+xy6fZOnKRQhyAledKE83rtKiRR5qjh5KTPLSOVAKbyPNOdGpfGCI09BBoe+NsnN96QL6kJZRWFMlId2J3gv94VQpdE91aTTxT/CSqTIqhgiy1ebR2kdljlXhnCQCWM6YnZUYegJZmqlNlsLm5mJWWbd3X/lFc+/79P2M7EIIXgNTaZg+jmiEX919geWiW1Hz773bJmNtnXylxGrI3hPFKAKyNNPcVJGhJhqfpZNJEC5zozpn/G/U3AsTist6L9ZyGYRvbg4+82fkelAKAZFVLxnmHju5hNHjKrO09H1zaAbP/5NH/rLn2dv+xE5PNgzxqVEPJAlrmRiy2AVj5KYBtstP36WDXWFuG2X/Rw3Y+cn03jzl7NFf7efPhZogiInW7Qd4QisqPpns0VwSGuTV/+AFgBORx3ytJLwkuoGyg0aFWrLmPsCarYCAwtYQraWZuaG/pPAJfybw2OsSadqFW2lgIX8/J6q/YjMMAFmUSuqdU0vpFqaL8rbE85NiBZGjFfjZd699OE3nx6eGC/pRqOADIN0outIijiIAJGIB9sF3/its92zO95w4HgiI02ArkIz2+I5YG7Fc8EheobVVGgW80HqUTfKCgo1pqs7PpmFM/+6MC208PHmxi/847N3/hRvjwyTSBwWRoZEi1C33BcmskXNpoOry+O//OG/+nvmf/61m+1W2celUITFEv+7DPa6CROO0Yuz0oyzHaWxJVwmj3I/huie7DWfSleu2jITM05rqPMHiGp/w3raAibSyNiWxZJ9jp5vSzzDoDa7uEOowCatKtEIcXNu9CpeCBh3R2qh9yRmtZql1pQVwO1qlFjmsLg4qOYu8psVdCDBF4ee+4FLmd2NkWBe0dXqoo1I/dwkRBwVxJCqGZEQ61auPPbcz5+X2j4C/Zu2KDoTyBvPi86Nsx8H8yw3f+vi7EMXNByooPhZ2NMIgfUjotAigny0hPedUMwYpRqmy+s57B71+uKbCi9iyjMdHMpT7/3w979F4t002TLH2aZW5iWcaZwmaKZGqrrnzeH26PTGP/n68c4fHScb48UPnlFBafTkE41ZWRavD/Wm9tkcOMa8P6uQrcy//0uEFto//Dy+936b5xhAaTGSr6K8AhRhkdRhEjOxaIMaiejQJpaJQm6yE8xbIR1AMx8wmXvda6G5qVCyOPU6Xs/UJ2y1GD7TwhghFj8MZcmII53Q2lpnRMBIfaQ8x8GGmMFglgGWhQZ2JwUXUScFV+RtkVDazbefc/3Vz73ndft9HIAe64xvQNYN0TChoAvLHBaRmMfZB+eb7z6z84W3wiJqpBT5GKU8OVhJODp3w/D7qlg7PSCAOEXcjKQY0AhF769DIznc0ke+70/MH3qHHBxSRJOZTI8wzIiV1eDWySMlT1IoqZots8k0sezf8X9vDsgGbHxw/GaClrSRc43MvHdnEA7naLmnzrLkHivZ9kAPD3WZ45hhxKOtlLF2MHF4OH7TcMRxkF6WmBE0IRUEMgD5SL8BPrPiaIPVS8Pb0BGvmi3xHkLktF3C+qyYaw+QaNptTcwVbI4J8y5LyyyNgOUNAaYEcW2672CpIj4O3B6wCkNP8FgcXqJ7v4vd7sUPvWnLG9MZ+khMKIbhyy7T9yd0MeJlj+PIhHgj80268a6zs/ffVjXbeI9BTQTKszMicoljxWxBdY2W9LPhUK6YCsw5e9R8MBEJqdnB1YObP/Zdz/7sPzq4em8d/5QiDhGLxjhD4SeFGrsFZLCWZmqbbbBSEQaQSvA/xOYzRjFKiNXHKq6YFiCKy3A31tDMbJmd+MlBUurncmA6ru+9xM76KUkxhpEU54sVItEMS8NXM1xEiGOeUW5lFarZowtkyhZ0xGBXS6uYiKaV7nSZzyAbJCeti90vfyG+1MuVEu7VZ5QYlflMraICaJPNlrQflhyAD93LIKhVkTDRorvD6fRFD755vwsXVo6z6LOGLqFazSUaMcfxD/5UExHJ+ePzxVPPbh8+mO4/sOFjX80tt6GV3nCuTFgmnD5mTF6Y4OOgY9JoZCGimNTnYKsu48rR+a/86w/9o685OL6iqn11c4qtizVnOhJhgbtTjlMimWTo7pZOB9Orv+B8Jh51zo2XCZGxDlomVFMH5a80DeprEiUIdnmT8+9nZ3bzVitQpGp1wNZwVfZzvgfVYIjgBnNrzIw0CUlCPF0UcGNWDPYP/1NLtpLPhDMBVdhQ6hjWFdUIJS41pgy+h4naQ91hDtrKWPNIyCG0HASWK4t3uwPkBLiE2f+9ConbjcyAf3jazefPv/5JD1159cXeJFN6vNIr5KM9jgKzguYvDco8EkCWeHA7aC/nv7W7/WvP2o09b53z8FKIOjHAmEk0hlKRKSvKSCNsUOTOIg8tMXKdhI3UDg/5yd/+0N/8yo2eEw8r8pBsQTVdOBKk2XIcOTTES6JlDD27sfDB1T/0nbsXfaruzlTEhG2wD0uMoSnDIvc82MTYSc8t5RbDzDVvUGCaSZUm2r7/N+mZJ2mzCbqTNE7KyJBWFSBAYUu1Z3+t1Lgh+rB+l3BN7Ft+njKEu2yQaS2gVuFp3C9fhclogolGhA1DmRAelL2/0wpIlZCvntVSVQkMQJh7P9LZuwLSj/m6kMSJv+F0AH0zyIklQAqdiWn4L1X1sed8wVbG3mb1vhWGzYQ7SEBaNXSMQBKXLjTKScYyMfMgu2Vnb7+9ef52vOBIoyDYiGkBTrAYE63GrCRgS0lFjLLYIYvhzIjJo1KTo7F86Hv/2O7xtx9evU+XOXbGhrq9J+cZmZiESOM8wIIlsYwivD/fnS8Hr/uya1/ypy5e8Bo9P+cxlIMARW7bbCL1xtLBNhD9bYkmLthyCQtdUga1sSH6uZ+ys9vj6jWbvb6VvcMD9YsQpJwGa02HwqIyllziJDh/SLWYV5eSXWLZ6o9RQ5S2Nz8dhCVH0Wk8f38huP0JE0EJfrbCrqZrafzXwk8p3X5WUi4bG9VZN6EMFbuSZA0cZvnDxnB7+gyzM6XB2W+CUwrZxE4O7nvxQ2/eKxyd5/Mzf56N6gFTCeDfDYhyLSjj0KPM+KGIcWJR3v/WTvc2XnIcpwT4mrEZDfNWnKqU7uPXI+x2V0PGxBE1LstycO342R/88zff+kPbK9d13qfT55hOFMcJKkiO6K4SMfyIRXTZz88+PZ7/iqu/56u3n/bl5zb0/JwHL2I0ODCb+6spzobOQ9BiCNmJhIGDdS4svPLq3iYxDp69WP7p9zOLLdHTnNXLIP8cMEfDgIM96iAWOMt1I2F+YWMAKi7ZTtG8JPFdIDtFiWTxJa1uxdoTDD3gJCWxgy8wLHgrE8pQG39zWFZgsEgzLuYOmgI6NlgTfyk1QCYr+piMETCxH3cqZGYYNcMiu/3Nlz74u59zz6vOzkyYlRLdQPIoO5iC5jIEByREJsZ+nkxm4P13Dt3ZzFSie39sxvL+nYrJS491yepRMdacrh6nvIIF8g8s/kCkRD51nY1ZdZ6uHs+/+KMf+b++cXNyxXSJ8m9QPFjOwIEagxgjjEHenOdbz5gcHL3pjx588Z/V+59z++zMeE/TZKI0UOXq+eboDYgyJI6yZ7JjpqM4Naz2OV27SdY6EJHN+3HtaPMDf/f2z/27cXwKS2w9tx81lNyFq5w7FW5jDAwtugcfA54u4hMrkpIaHgDrBPtQtjsr9Q3uhrohNyKeIriMkzGyATjBwaomo/ilgE1ct1l/pCJxjdXzJVIX6egFCkpLiNQAmTr15gFJGHv1c/LAiRmLz0ajl7/gizYbOr9YzCSPbOklf/A+wWByblbHbpj54RSdskR5UqbOfYLLduh793pywY8c6V4pDpQ3P/vI6wH8VeL8vMyXERJPgWoWOzySJ3/7/X/7jw9amA/8DEmKE9Xdc4cjNSJhXjIVb0SeWF12+7Nb25d82tGX/8/68s8+38186zZvhjGpaBymhPo2HSgDEFLvYRxkZrRlvia1EN2sJg42rOKy0MHRyeOPX3zb1zAHfjI0xCBghAkrgQWZRUQBdhnQNxFMs+zW9m1t3qusLrE4qsogfbaSR4TgBCW28m5sxFPGHXAd8Tmup8GPG0GQC3Opvh+/rlbeyIwTGeZ9EtWgVDfFjmsHs8ZKu5l3D+iLGwddYap8yOuiu+249si9nzwvJH78Fo4HTC0AbgbBixKsWIhgE6JCQo2U8wi5jIHIAqMyGYmIvvtcHtjYYcyVMGYL7Qp0hUyZ/9AcaaCelMhsGeNoWj7yvf+tfug3xsk1WpYw7lX5gykRhrr7NKA8iGy+9bTc93HXf+//Oj79D50fnOitM9mQTcMJWY3hWSBevTiUKA/ijpD0iOn6MElTUCauDERu8rLQkJNJl6/5Y/N73rU5vWrLkrUtbssVfd5wuegyMU2jppYoN1F8YmROq2p+kE6rGDY8SppXhqlDTJC7lv6LU30hoK19xcghUHNwaciT80yfWFIB2LbWzvbFCifgbEL9hYIK6F9zH6QwExxPiRq9OH/cHT9qOsyYZZ53283VQ3lAl+BNk/phDOOm5heDTuW+VAZnGhG2pdHKWMGPUmSgOiE+p+V95/YJJzpHrZ6SRrsJmVJa/Vh29RobVvdCC+nBlcOb3/8/3/yZHzy8eq/qkk12qA3wldDIyqIbwox5DL24NSsdv+EPnXzJW+aHHz07u+CL27wZOpyHNRXWEbUzFkNCmVhNxMRIiE1NyE6HXUnMwyX9WjIJw0G0LHS4OdmY/NmvPP/n/6dLP3g1zm2UBtHJLJtiI0JGtwCsWxZNkFSlTG7aGuN3QpB6X6GV9uQjtwC0fAv39FQozVQsW+hLaGRafL9whsf5dneT/vQ4sFwV+oPKN2BYS8iVopjMRtZiKPupClA485PeYjq0EvG8XCx27j4Mk2dhT4jEaAlAFzivL0uuXNTKMZFoDXeDLy1fjmMveAx+fLYXqm6CyrZQdhxpgfXGLNvQcmM2W6Yrh/u3/vATP/iN2+OryzznI8HOWJSkUES/ASRk0LLf33hm84LX3vslXyuv+cLzRe3mbZlEh0R7e1SbGoA+qj79xCchYVYzPWS6JrbFqWGXY8lm6pgjzL1+cPrkk/qW/+b8n/yDzel1W2ZYfWnlMVavQeGwpQWj2iype3tukul3RGwf/UsUjWAN8SSX3Uo1C/dUR5dxoZ3QoAZSXEptSgBgGbf0j3SpTOp5XSp1+c+aQGOK5nXj6DSMskOu6xgRk1Lhd6XwypKaho5Sw8BhIjKR6Xx/46O3f+WBqy8632sfsyeRjcJR4JztbUY+EhT2SKEDLgsqqM1oQ8AjA+UmzUgm5jPjp/b2vC3tLVG+4VRJx0QJitK0GCkdHo4n3v343/iq4bqhGgRnNxyrlQz11dvP0MmDV7/kf9h+zlftT+/Zn5/7xIec3GhRWc0gecSLIJDuYCbVwXZV6ESMrc4wbVKSkh/WbFY6nA4PxsGP/9juG/47/fVfmq5co2UxeNaV1SIorpWJseh1ZIBzjnCrsrmhORGDrpOIAABjbElEQVSoQfujoIXSgIGhpOqMicewjymIwS/GwzQDjjr7CZnaKjullizrRW5cytMh8h23DDWpGvZUyRj8aOT5gNQSYTEzYwXYlEColQdVI2YRiuEzsXrMTKL/7jf+xkuf84ViY297HsNvWim1QrVBSsVa+FDQgHNqsPFhbpk1yVYhUkcNBI6VmISfXuj5DE7JvBSUiAxd9km4EgaSLcLHY/fEd3+VPvGecXLdljkUOwZcsKVJxksTD53Plnk+fs2Xn37R1+ojLz+/2NH5bRpDR5YVMQktfk6e1yaJVZoPG6WnQlfFNkSqCPQ6P9hYHPNOAx7XD47f89v0nV9/9gPfS7qMk2s2L7l1ipKejFstTSaEGEeXU6wC4+3CqIY7b3maplDZkZIxWygWNV9fbovXf007wnTJpsBXEfkheQRpQpwMyjDbbpoY8/pK8U/cnm39aywnEcWAeaoZTob8rMRaAVTGOlj6YeYs5vEKrqgYoc10+PjTb7vYn33Ccz/nYLuxwT5nikV4iAzJf5IMGoPHRDLhfzc2DZONjYnHRnnMugCBxLNrfwVEfEw0FtYDnZ97sHgRqAs9GnBJhq3odiKhmfTo6vbG3/tzz/7rv7W9dq/p3DuVmDB9mcV5dZZhpvOtG3LPx13/fd969CVfuzt5cD4/p0E2hqHOx6XfZ7wRM0fXi+d9wfwckN0ndhWNiGW88BdsPrmCL0anB0dsh//we3Z/8r/Y/fSPTwdHsj0wXchiFmt2seL0l6RLC89wSUXQnZGOQ2EWqn5B9sNRJ8SQCuQICfyaoEV1R+KmAlbiunZslFYd4cvR8Wn8qJQyQ+IE7i3kLvUqEM+Fk0v6Xa2XJQbt+PSTSAhRjjZZDRZIr4bwPmgtP2bGOhzzhtGIr+hif/aihz7ntY/+wQeuv5z4QI2UaGFWNm9rnElnIiVSEWXbkyrZQraYzuaTqMg2V7dXHpnpYHdxi0yUbHHbpBxcjhoTDSNWk73tr9ntT7+ycBWDBRbiOGUMYQARs+o8rh7av/sHH/y2P7A9OY14PvTc3N6LSHJcTLw/e9bG9vQNX3Hy5j99cd8jy/kFD7MhNsyYbaDOVGqum1Of6ucHMxvZMpldE7rCJuv15YbbU0SYaF5sM7an0+HP/szyLV+9+4kflWnr1alNDvoueayX5/SUHQ83YMTMntVuc3LS5icpkkQqTDazmQ3B2VVVpVlg8Q4pTx2w/JY134ZQGUPsiV0B0v+GNW/XLSYU7qHfEjF+Ajk8WbqwxYxUUY5v6kc+RIoqOBVLxiYTGy3VD3cKD8URBuTiEpHwOJ9v6ayH2yvCI96dWP3sd2E1BSGBYIDI1MjUMKdPpqOTe1/5yKv/1OH9n3VxcZuIVIFd1MSIzUSNjMVI9jZf0VufeToH22NBMvqVw5bz4pWYusjhwfTBX/nA13wOnT89Noee9mpvHfUMRCrToP1ud3F++MLPuPJFX2OPffZut5jteBoqODxvEOURl8IqxlCDmIfloc4x671iB0Sd2DUqPoVSA5nUyIyvbk8++hT/tW8+/1vfIbdv8skVMjNVYW7QphOJSZuCj2msqM8ThcFmpuj9Kw8bfAY3Vh00DFADl8RleNzuWREp1UM00eEmuJTAA8wOHx2f9oC50n8dZLU6NDCG0LKuC7SyKDHAZ9EC4T6mxIAFLeIhjwHSDWaRY4Dy+jdUDjFAEsNExDw8amuxfybcvJMw8l+eCPBnVzUnJ5hJRJb5nKfrj73xH27u+2zd3TQbBjKLjVgputuNxt72V+zWZ57MwuQoCFZswblNXjNHZMuQEzv70Ne/+fzt/346uSpkpkYCm4x19E6G5fwZuf5xV9/0Pxx+6ldcTMfz7owG22AdkeLWYTSImRZmnVoZn2e4xIxo2ZLdI3alFfA6J4oEHQw+eBs1OpwOJzn40f9r9xfeMv/Gr8jhkUwbW5SRxFzxh1Ej0o1v1mWiqQMFmO7smp/hpPK67e6QPgMiGdIkmVKVUtJBfdYblZ+j9VOXtc7HoAlALI1pI1Gtc+nU7DpZ18SVvq3+WV6HSUnNj4p1opGkxaCOK7PRMr1hg4bB/VaYaDX82hd8cbIwYywmQubI4swqz7OYZp6emcgXgYyIN9vr+4uPPv5r3/3o7/pdF10+0jB5n4Yb7g1m5YofDUlGOTGFQ1GI1Jaj480zf+MtZ2//99sr13Q/K+gwPIO3+7DubqnS8Wv/wNUv+Bp7+CVnt3dkZzyJd9IElzqCLUMrPTHX+RdMpkR6jfUesS3RktvCUb7U4jnwkUrC4/r25B3vXL7lLbf/6f9JzNPpVVvUFoWZy/rESGlxQhcP6gr9ONeZzTD51S7fUQawqplLJcpItrJg3Gxwmt5uklNA16guStQAK7rLgiubwHxaThbN4gsQg0xd26AvWcoP4YFX6epmZLoQRZUg3kOIhnNwZooEKKrQGotWBGiCsMoy8Cp+MA6uFQOnuXCFU7FpmqouHUrPkXZUVdqzbHbPvsuWZ1kOF/UZnSZRxuEsEomxmS3HbBvy/gUlI7BAhAY0ZTKdN9eOzv/l33zmn3zX4ZXryzIn5ACMYxnDlt1yfmt63qvve/NXj1d/yW4hu3nbNiOGHLJPfWON/maz4TPbiIQWCcSlZnrMeu+wYyI2WohQB9UIi4ZiHPNcOTjanU/f/dcu/tI36Ec+OI5PiVjnGbBbKnKoAhuGg3cxUeq7HqLmHl/L/STViIRjSQvQVcMT6AJp8t4C9rp5IqbM5ZYGZF9mOQaDfQ3dm5BgSi1qLoW7YhOCg05uAu9X4GFr81I1mDiT2l8sRukrjgNxi1JTBIIuYCx75bAAlbKMxNRIfLpw1FBQTHNzzZHkkiOJwMU0og4qqDj/6kzjkGSjizHHWXqBZNG+ymRKulyZ5ol8pJwSOsuiy8SfdZHTI/6Nn33ib/2p6fCgx08hPiwkMp8/w0f3X/u8//H4M/+b3fF95+dnJGSbyaJqn20IeeckBt/GeTY564psGabXh14Xm3q2s/3lUiXvvNDBtD2cDn/yx+fv+Nrzn/43cnA0rlyneW8GhxmGCLZCaqyBkeHEMHOgL0D6FuMN0koCRhQv3up1bLUiQDiXvEG3/oyIM/KpkQZotcglkAQYHUiYIT5B4RDTBEmNsDAtulcANH/Q+pZbCLVChcFSNZWHY6DG4MD1cyAfzAOg1nFWlQF9GXISd/M7kfCyxXu6UoUY1Y2E/gz3MwuZRwvABeAIIuDiZbaDe191IadqzwhPRUdrznhiM7JByz3DGndYcwgllNA2m8NbH/3wX/ojdPspOr6iy8KccJiNRXdnOu9PXvXF13/319Ijrzm72NPFbR5jGRTSL0QjOgfAq5oOUa/zwZnsywkv9w47YjKjpdx94yxa1KtKRnLt8Pj97+Pv/PNn3/89PM9ycpXMaN43m5zWz5pR9v+qJRFHFioYFkeztSpxe5YSQEOA1SEgqIwIPxY2c1WHmbEnEraWV7sj+ux6Fb+r+hyQVPHsE2NH4StCP+CxelEIpaxc/mOpWuH5AP79eHHUsjDUM+MqBauMqlEhyXppltA2M/OMu/uCVjDiCZbsmISzQ1pjvbgOkjk5Kw2CVSlyFESmLHz63M9aNEgiBAqZqXHnQ3pE+3smr9axHKHltQ7ExLYQHR+PZ779T56/662b02u0zP4+RCQ8zHR368bm/hfe+7lv2bzu/72n7XLrNk3sEzydxATuj5QkRw9xDHrxyrNla8s9oleYpsjPrfjNFWNJZEaqdLw9It3+wN87/5a3zO/9zXF0LNsDH1dFJOiksITgTXXcA7urY23ju4u9YDhtMJYezJqYeaNQp6BQ7dgjAByc6Z49/RhHbgTVcymntS1dDVZcaMyXCdGDW3KpnQiwLnECZ4rbGg3TcM2lYDe1YsXWhHyCia2i1yy/5PUSSxx3EQ8cPqsVs0o4ZqtTxfs+dU12E+IcqCkO3k5liAWo1jMsPS/LxcE9jx089KnLciYiqHXMhzcWYyVadP8cmU/EFvXROioheUpMQqq6uX548SN/+el/9T3b0yukfiUlYx4TzRfzfr7+6X/k9HPfsr/2vN3ZOfO5TSNytwP5BC/39nKGGinn8zptYVqu8HJd7CALBbAXIZCZxDNio0VpM6Z7D47f9vblf/+zt/7F/8XTGMcnrOZcGFxnGBqBXw+CtCoxjVnM2TNEyM0Umo1orkBdoaIYngLLtqq1KHJ0VMxVpu/lBHEiIqdPC/ufVnzNwqzVYK24cPQt7CAi4imzr+UDwqoWBZr9bHf904imwj+h2W1LDPPMjZgUB0ZUWQdAU4bcxb3626s54HDOwbwlmFhYAZtcnqvSiITYPLnkQU+hxlwPiouSGk1Dd7trH/9F4/S5u1tPM00wFJJJF3dSxrR//maZyBvMXUvUW//EzBY+PZS3//SH/vaf2RwekZKZMgsbsYz5/CZfee7D/9m3yqu+7OJittte1IBZuZHZNRJj8SmLxO5hBquE55qPab4udgyHPHJyRpqzlASf72989fD49u3xbd+y++vfrB/9yHRyVU1ZteLDNF3c4C6KF7F3ir0MSyPhmsOIocjNjCSLIEKMGscexeLA3RAZQhk8RXVWTxo0RohQrUM9WE1cDEGuoJSLDrS+Nt4HGm/fVIPXyAewJeBF/mr9+4T9rWwuPHJ0PoYRJcS49cCXFCxBoBLlLMnwz6jhjK7FTDpC0VH/hNRjxsptc32pI3QzVWJjGWSLjCvXX/R5YeQcAarheV0BhWbd30u752xs8YkjOBzPU2Wmut0c33ziie/8I3Jxkw5OTMOr8Zh2t54+eOS19/+B79WHXrG7fcaDaRoqrKLeMBBDXHKM4QCbNLEKMekiPF8TvcrmRU/CNIDRUdCL//WeidkOtocb3v7oP959x9fv3vaz4/BQTq+xLpINLGgBTcOZRpNFyixVpMZtzbPCM1wNIiqfa5jVK8n8Yn/S32RlW7ZEoKBk1RKJiA7hAHrUs0mOKrbMFDCwX1OiBsDI+wGa1Bat7rA3Cl0JBWTws3WMTGPWUOBDeLLWSgw5JGOixaUmlxBDrwLTMPTVnWJ0nDJnDgeoKL4t4B1SpbRq/pP3as2+lI1opqosPvCEdD7b3vPqw/tfe76/kDFIK0VlomQkasSsprsXbZcjtp2SOM5g9YYwooXp8HDc+M4/vvvNX9icXjed3baITPtbTx+84PUPfMU/3J2+YLl1i6dNHE8kaszczqhDdSeayHzMr+l8LPO1YUdYheGFGdYMaUk/LYsxyfWjk3e9S7/lq2/9yPcJ83R6VVV5mVOt3VhEZQE368Zsaq22B33Vq4L3tGEp2IyTsKPfD64DJTX4sICa0DjwkpKQzCKb0kPqf1Zd7ll+muSMy9tdEEtjihA98wQ738tY8VLrVBsu0fFV6UxW6TRf4D6TKWqJQzgJqBEJZS4KqM3DiDi/TwAK00PsYujtwmWfcfKgV2X1PGMEEgITRczsShL0KxkRLfv56qNvpsNrtntWeBiTsSojOeLasNfdvbT7uK3OZpijo2JMpMKLztvrx/t/9K03fvzvbY5Ol3nPaCCYz24cPPJJD3zF918cP892t23axGggwcBqZoshbQG0DWehEtMy2f6KLKdCE8os3fbHpitClfTKyle2R7uL6Xv+0tl3fv3yxOPT4TGL6LwPYXVCxZK/0BBarugKMD1ahTIJ2XO4CRYqNIUUrcTWd0Cti5DZwlEBmJjLr6RkaDMoVq+9XLtZFTZwKkHZ+QRdkPFqi/HfTkmKhqe6/E0ilB/Xz1dgqyvB6ou4EBxM8z/AhVrZeACnvL463Y5D5WF0tDBp8E0WTFzSqIxW0/CWyigyDL9LrGysKEp0h61Kcnj149+0W8iEbfEMhVcq1QSahfT8Ew53B8x7HweN+MILfq4e8y/9xJPf8+fG9iAIQTUeY9mfjfte9OAf/PvnJ8/X/W0aE7Ef2u6UitAgdXUSphEDnE2IiZZB+2PaXxm29b4A8cPwaCgFL4L+Zt/ERelgOrgyHf7Hty7f9GfO/v2/pGmzOTm1ZbFlKSBLTJQ9uZhIENvSNjvEJWNdTVhSO1k60UYZhDhhOocLnSTQ8dEndZkiM4i8i8aKk6xEALAJQAoEjGEgOyPUwGC3hpUqM88DZLogyaF0b8U4lq0u8WvBdmOZMgiDZ87iEFh2NUxGCTEGRwQPLK3VB36jWHgXdV074RabYHRUqFUKeUzti+9XFGzEIvPu5skDr90+8Jrd/oJYNNbEnRKRmQnzue2eJ7vnb2iv0YZCkH5TOzg8fvrxJ77j/8vLOW9PzBavwNBlZ5vjB/+z7z6/9yV6foumyVh1cJx0HeeZBsUdRzWK8WBi22/p4qroAdEw92HEGhQ5M/qFOCbTqRqxXDs4efJJ/ta/cP69f9Fu3RynV00XWrRvBAOhwGCDmY5LhSAqsM4KD4AsRB6bSOBakwcMAOsBXHGKqPAxZpJM53J8KxmRavjLEZhUlG4XPtjL7vviKRsnQKh8gXak1zKMR2fA8OSLE5HjjCNk81YYKnFPOcFyg6ly2oAlEbEIdBOcgF8hWtcxE87yI1kiHhvRybfocKF6epiRTJJYMHsEh2tE9dsoM1ro+OPfuGyv2rLPErty6OwncCwXLztYMA56oTx5jhaRwy09811/bH7vr05HVwP1CRHL/vzs/s//env0M+fzWzSJsi5+Ih3MvLPFcYa7GDGJkA47P+Hza6zbyAb4KE/3AF4RROH4jcxoUTrcHh2M03/4d/Zf+obbf/kbRU1OTm1Z+gi1XsGC0i/YeQSeBo7Bf0Ea2QiXVE1FAGnPEbYiqvNPle2GnHuZXkuIxupHMx6ObgsXUIdmNckOQUBwTUBy9YJpEOurHMlii9igB8IxF6i9bQlvahrwdzgNxJEt6DQ//33VGIT7GBH7WZncJIpRUupl9nF8vFE0gMNh+DMDh5f6aZhDQJr8mTsHlAShKs4zKgxnjkNPoj2EmWyW6eDKo5+3n8kreViFZMH55UTENi/nj00X9w/bqwUfHwmJRXV7/XD3f3zjzZ/8Pw9OrqkX/JART/PtG9c/5Q9tPvWPnt86kyHKOL3LLan4GRaYzyzKQsZ2fsD7Y9atZ8SM2P8CVi0SZNh6XWjwdOXw+G2/NP+Ft9z8sR+WMabjK0uwnIXcySgqyUHmRcOT9yvX2JQgNnH4XaueilHFcSl3I85Hlx2yKiFo+MUIuZ11WWkTW3S9ErzvJfsPErvR5AVJKkZoILzgT9XmrevVpjVL2ApSQ065xZNVTJqG3x9FGOluSoS+CsP9dxIqaPUj7xuhAOQh0P2bhiqqhtxcDvpaVERtCzMbVMZCVOJ4MlqP7oisO4vNt44efN304Gt389lg9vS1Ww5homGyo91Vunhsu6hmp1XEHTaPa4fy0//8yb/zdZvDIzPvwjeRaX9+4/CRT7r2RX/h1m7PEo5fEfXFQGYkv4iNhfYTXRzKcsRh7wf+4ojOyx9EsNFKRnxte3zz9vjObzn7a98033hqOjhiEV3myhRSkNBJagVZx2lmugRAyrj5Zt/vaipgI42jOlyoxcyjKsEyl4gj3YmDLtVMJH1FkY+hmMkk5icgjentgP4joZOFPgEJqlXLKF8Uv1yJP9FkwGCQu6KggoIJI8pg2krhEN1QFXusiNZiqeoXbOVn2iK0aIiwrlRBB0fUtDZXolrV6ohyGZmU8FcVGhGxsFqm3xyGGhMts1150efR4VW59azxICGLyh8Jf8DLxSs2ywnb3rl5RmfbwkeHhx/6rY9821cyzSRHpGZkIsOWvRzde9/v/ytn23t5f9Nk6CAdEXKbsB/rG2XMYovYbssXh0ybRvJ4Djsm/AiJhSswomWmo3F4Mg5/4t9e/G9/Zvfz/4422+nohJaF/Gg9BatmuURVR4k691hvzxUR/uFbbqYinBuQe54zbpPnRv1cKAln3IgEU8grky87AZJeFtxCTIFzQ2oTAZfs5wdbJQ/s6p0WuCc4cA0yowkkQoGWTExwSydQ0yoAG4ScBHapgpT2jYqe0tlkCXa48bQ8FdiEjKqD09i/oBwyBx5N9B5O5e7BXyOqKU8aXt4PaGHLSo2FD64cv+jz935UsBEtzFH8zCbGF8vuObx7dNIlGihiygCbiRzz/sa3/zf64d+cTq4u8555+FvM+4sHv+w79Xmv09s3aTMWJpMRSzbYhJhNxViMBl1MdLFl3QpsvNXJBsIBhMQi3aYLMcs925MPfoi/4X+59X1/nXYX0+k1XWZTpWw2YNYYKxKrw5LV5hEXsYdFLbZEfWVEhBpUVtBzEjNgCfX8KVhsrFzb3vYreAm21h7GSGSmQMbkCGjYCtK36VhR1Ibq58wzUHNiqz+JfkwIh24oMk8Oh9NIpytKp1SlNZadVKEYlDY2NatBqdKCChRSd6V+p9YeNKslKKMDD1AwLhQXsqTfBD+PBJ1xdyaicE7+il7/jnqgUHrR/dnp816/ffgTbbltA+EgMeq4aN7Yxcsn9arp4GpYmVR1e2Vz8T1/9uZ//KfTyRVdZhIhVhpjvv3stU//yul3/pe727dkDCOU73Mc10UjKueWiW5v6WzLuuHgNxmCLkBBrgaTsRgtCx9vjzd2+rf/6u5LX3/rb3+HCMnR8TLPLbZ0eqrMNIsD2ZrfH04ASbTE0iLJKJDPF/DzHSNSzlg5i7wSIVC52zbuk7tguGPPMsUSmshL1pNRHJOXOMBW1rVRigyPg4qAZvZTnSL6jp9yNQDzlGKNgpA05BV6W4oUSK4UH1w33VoSkCV0BUXccmhTalTlxILDsVDmKxBbFfcas0YiM1N5MpduQbMBUZxIga4OM/LjA9jicK6I8pSuPvaFtjnki2ciNe7TQ52unpfdS6b9A059Zre76jLL9WP6v7/v6X/wzdPh0TzPPsuFxrSc3zh64Ruufv433L7Y8eBleOOYGBtn9zorDTqf7GIjNnlKC8be87sOfgYXHDKzjUxXDk/e+tb9//o/PvsffmyMaRyfkJmf2N5QPIQiDbJGMieP5kQaHmwEhCwmWRVeiL42IgpmE77U/6tlrCP3Gybf2z9ICy2QFwtWF2uIcEAxdUIaosBqSmZjAJWVaCaAgESl2K4jWLxCIJsg/xhBNpGRTcX7wDTkaRWZVsDVK9hv9RkIoQwhOJQp/s3F6SRu6/1tGWeton7xbBanccA40eryD1qpYiLDNKFswAB1J1aPCOQrbmx1N47vO37J586LkgzSGOsZpNhM+1O+eOl2UWVU6RCR2WKnx4fv/qUnv+OPkgigA7Gw7s/4+MF7/5O/cra5yrvbccqqHwkqrB7Rii2DzjY0x7kVXfTxf5LSb17XyfdsT555lr/522599/+ut54dB4fMTPNiXKuMrQ+cYmTeBon6xgri0pY5R0dm5Hyn+gImCvJF01QD1O8gfkV+GD3+FjRQ1KJ2ulCqbQtCwQ4JPCMXEXWATyquE3xJmfuUnSr+XlEnPvUshK1XwAHmYx0SjiQLjAhkDecNkpoOEj/pCoQ3A9MQ/qdSchxOS818zkYcD8AwBggSECLHmSPZEMbVlBFrHV/l1CxcJmsYXGuVuYZQ+9WEWXe70xd8yub+x3Q+94OvQTIbMS2qu8e2+2MmIx0IfFltszmab974lj+y3HhybA8sDn0yI1r2+/u+6Jvmh1+pF7dNxJzyJ6NB0c477HyymxPPzoE6rTkQ6brtFwvpZyXd0aEcXN9e/b9/dPn9n3X27f+T7PfT8RUyq+aR9QI2R+6AUYlNvai5vHsMaMDM9ZCmiJkL0riSiEU7tGMYRxXuobVwTDN9VuA0bc56nKFDFqS+4g0izmZu4gRhAixvv8BHkauH0c/YtaTYkskKsfDnnUJHq/Aen21xRZlTEEDts3i49p3elulYJEQ0hTTmWhFRayhFIWEWzyUfF/V9AbOyYyHtHtoy8NuyB25cGv+H5H/kxszoymNftAwhWogngB9SMb6g3UOy+7ihs0VKcnitPx1fnS6+9atv/8pPbQ6PbNEAq9O0u3Xzns/8yumT/9D57XOeJmWD2sShdHuh84mWoP8Vop+awCSZ8CIypcHTteOj33q3ftfX3/qhv0Om0+kVm2dd9p5OdDHMokXsPMeLl60rG0Gg91we8Ps0CyFFIeJg7QIlJRcYew0CgtDkFNX+6AvDyGE33IajPYIeyiobSLUqyvMTc1yG9ZmZDUu2gh2pOCs0SLnzobxwHqBBASlK4gtyI0ftfi4s6zrajhco7qv5jsxWJGBaZRZCSPN54fE8a4h6OEpmqAW8lOsNj1WhPGdkF2SEIegx4DI2Mp3Px+mDJy95435vkc8X1GCpLNOyf9l2Cf8sfrqo2n577xH9i+979vu/4+DoSBd1OkhZ5ls3T170aaef/423z2cZ3iUTOWMv9TkX2k1JcSoNC0ZfWnDstp+NbKFrh8fz+fTd33b2175pefLxcXjEIrrfQ17LEAbMM+MomTBTJRYyEvNzzSJvUcEkNzMReCjlRSKiCgiFyv0OZ1uVoosuGBr/KSOs5HBH3vyV9AWeH3a3XwqJKSuQ1mWNskUlRCsr3Ff0UUYAIeE4LykGWOMbmAgSEsgpWqVBmXbriKpqhLKNJfNuVc8ZtonhcpjTRLGjfCIDm2kYC2yQ9gpwObYDjaJsaqgm6jFHOAksU2FHS0LawAqJLLv5+ks+he99kd46i+Q/q1cm2YXuXjT294vuPWx1pVn49Gjzm7/2kW//72Qj5uXyuhDLsr+YTu+/5/f/lbPpKs9nNgZO5iIT3gldiGGwD+gdBvoXoeGYx9tIlI42m2vbo5/5qflb/vTNn/0JHtN0dKK60LL4StXEs5AYP1yRY5xy7khZx6riL0RQMa2bZ5XI2cOPN9BuheVN0HoE4t4zNFVAAk1p9HoNS0ExQQTfzKA6Ml7Ar2LgQMpWwxQgZJIRJCCRXJcAG2nYE8OUtJjZlNqYUleWGzeslCG38Dr/kj/M+GjtIZJA8xJzSl0sHAPuAEFVFkIwM+sqwo72gIJblgGTb3+YmOjxXfsqxYRKAMaTl37uBRGR4qiw8E/zNdu9eDub8SCSaIqxjVyZz57+pq+0Jx+X41NTJSI/SdsWvfdLv/niod9ht2/xNEU1v9B+0NmgOesXIrFlTfTznxTB7vXDk6c+wn/lW2//3e+ks5vj6JhUTWeQBOLrI7CFKLNnTNPL8f4MqM+eAbDg5IiYYip1mBb2clB15ElxuFSvaGFinF0HXJUEXQ9so9qtgSMK5l4gLsFioBcBLozhLsBNlTMomAbuCpC673ChdejfqianPhTsCBkRT81YN9yVb0IAjy1jlWY5ZRBZvARCtrqfvwqnh3I+vQw0gVlt+onnanRWOTdDQriF5Mba6muDg+N8MT9+I07YZjKy+WI6vmf7ojfNe2+hZCKywaykpPuXbuyEeG8qYTdns4Ojzdlf+OPnv/Dj4+TYliUMzdgst56953d9pfzO/+Li1u0xxAbTMGU6G7RjVuaw7qzktZOR0sLPB5Eo0ULHBwcb3v7I399911v273v3ODjg42ObNQQj0oKIcLNCBIc7MS2AKWQe/jBJLKB23Exxxnaazyqozu26VBbqvfiagCMCAmOiLMqCWeMoyEpDlbx7FtwDUQR25tQo+OqAAjUfH9sN6bZUCbA8a2oxTXThvIzHWygwVaVEXTv1zK1x9a63BEIBwHoC6NGlOD3ryw3FWHg8ylZdf3ptbfJuvTLIjmK5xjcgP9+qL8wP2MosPUhmFKUnZiQWXZYrH/8Gufcl8/l5UyzjmfYP8P55wxaVEbVKiy5yz9H4gb/80R/4y+PokOZAGjym5ezZ05d+1skXfdPts/0YTENIaMd0JrSPYBe2XwCBGLktNhpGttA0pnuOj37jV+e/+Gdv/ZsfYpHp6NgWtVmxkLq2ZFBjNyHhNgUHvRmauFCAZiZhsZFVYfP5LcJWGUh3hu1fxkic9txAxwZBY+SEm6r2wj5xDX5I21+UESLIOkSAnJpNIbFMTq7ffnVROCbLrpB45lYXZJRqF56GuPIAaaATOFSCAVCupYhzLYoD6v+M8pMW3sZgi9DF2g0LBjEatZpCmbC4JzYQQqFjCZs0go4160TREIxnSLU1IpFw9ER0/IrfMw9mXowmn5bDRsuku5dulsl4ZhvERLrMeuXo5G3/4env+B9YhBYN/ydi8+1xz8fd9wf+yvnmVPSMhiyDzsR2QirEwiYA90xFd7JXuRENJTO65+h4f1P+6v92/ne/db7x0XFwwMS2zE5qpMnPxRTvh4O5tqpDdH0IZwf6oCIiAIykV/qEJwJoolZlk9g/LTeAlcuRKiqixfJEEfh6hk0qwIRrWl09AX6jouL/OceoJG+VDg7eAO3nBsGiavTMz1Z8Uh8OwZyyHLZ8R+eQzAW3voFjFpPeb9FRM/y+jjAlSdFUUFQym14zMrztITo+bBcvY1T7xZxrHJgsY574iYQpZGa25WJ7z/O2n/BG3c+ehPdTUeli2b1YdvcIzRYnCxnpwcHJrY/e+sb/ajm/NR0cmc5RgcfzYvLQf/rt80OP0c0z3siF0BnT7HLvR4ZFaQPSW2H73TjPdLDZnk4Hb/3X++/6U+e/+jOymTbHR7pf3DwzqweBGuA7rRs0OKh5Ad2V0sTWrKEvtSbCDIxSYDWbJSIYRdW98xPgD3oGKIJVRCCxoZ23AJQIKOMJIO5ohTMwDXVK48st4CvD7oY3Ep0loGlwE+6gYCOlpPp+gDo4Tn0zmvyTifsysVbPh+AWhjy+UV6wRdFlhaGefckpy5FKdzMaIoRPaXKY8tuXXD/6h1uCuYBe1Viw1Mt7hEdqNEREL+zkZW8e9378/MwtyabL2fZX6Pzjt6oqgzWe2q6cysXX/cnzd/3ydHDgXYWmRhPNZxf3feFb5BO/5OLGGW3kjO2M2aJlka04fo36NrdoYk75y/Wjo8ffQ9/5jWf/5Hts2Y2jY7LAPKZGokmYVOjn66eh5hIrsMQehfQ1VgE9pyFVrZgRpZdVZpWuwTVFoRSJGFZk3aorWNlD8DTqKzqmGS78lduvG5ENQxzqGrUqQZ8gm3HZ0MZfVm0GgVNSRXCHQNLpV4im8i6oaeZ6rBZTtTjmDotc75WQjkrTV+6bwSdcVi5Gixk350BMeXwWIFApsiVDmv+BObOVWlQ2OQithZmuvvJLNEp4Q8jUdPeSzXxEtHdTzbMuR/dv7e/9xWd/5Humw0ObZ2JmUxqb+fz89LHPOnzznzu7PS8bORdeoHmaKS0G2zS8mJmi5ObK4eHYbX7or5/9ra/VJz8gm60cHNmy909LxoDpMxlEYZIIEXbGW/pgKR+qR5CGNJswplWEA69tOSwjGRoy4b67aRDx3VZpHgvuM+DXFQoVCDovZYTMFyLQbisRx9vq8YDgIVzg/4ozSv4Dj38pUEgtTSoL/xMGl3lqLEti5aZLyFslllyVcFf8UTFAoZNOB1m9guWjZ/4ZSDb6d/XOWqNcYFC7zcOAp4DWa56yCL6oayOz7i62Dz62fdGnX+x3PNiMaTba28VDsnvOpLORiAmxzZt7D6af/8knvuNPj+3GpzgqGclYduebKw8c//7vesYOFzvfD4mhKGzq/Kaj/GI/kdvabqZrm8N3/Nzy1//MrZ/9FyQih0e0LLbMaX6Moikcmlkmtckue60fETKVOcOGOyq1mEgPz5jpFEomnajsWnjq7DZiBIf4XINJJWbd9kJ6mp2K8onQC05pgCS2emQuQwZiqmuKlRWsRBvqUanpSkYJFVe3JUS0SeSlEO0PY4kIgetKg9KSN8RjIH/6VfphxK5FPoUJnV9MK/PcldOw6pm7b86IuKQ/5YWT82XUi/fqDuvu0YhZlY4feyOd3qtP3xIZspgy7w9o9+LNLMpmfqKMHW5PP/rhZ77hK+niFh0ek87MNEhUVYyu/qffefPBl+/Pb9tGlEDJcHI+gP5e0+aD+q8eH936KP3Vbz7/x9+13L4xHR6YGsX4eOearaH5lAItSwP0EruZqaeokI3Cp9ZOW4mnFfOYdS9ZfxUXwQQUSGn8F5C/WZImm9oVzioy5BLZphAZyTrWwb8yomwxfVZIQgJAvJaeJMAr6QTeQySSaD01LW9pPIHcqdCdm3wDJ2KB1omF5hk56YF6qK5UhMGI+btGCQQzR5Hl8nmRmHjYvH4giIxkuuZhcQWlpa04oj0JmS7CdPqqL9gtFL0gQrSz3Qtkf51siVEls8jpxm7+2f9q985fno6PdVmiHGmIXlxc+8KvvnjN79/fus2bOGsyws6RVA/CXy9EONput7T99z+4+96v3r/nV2SzGYeHpknyxitqTYbCw3YUnTS9VWkshK5b4N5kCGvon+L2b7TPUV6VUMq5tsRMqZcEFqmMuJkfbONsD69sDdWUJ1rthaHYGONTmHzsRjxOZ/Vya9HDYmU119gG/+aVDpWWVJlRg4Ne/t4t/CrctYQ766zaCgNV5V1yTWXhrSoLNY9HBenpSphhN1w8GWlb/6QpCG08qUdmIpjwR0JE6glOSlojLx4ysOx2hw+9ZHzcp+x2S6z4YvNVu3h0k6mlRZftvUfyV7/u1r/5oXGw1XkfF5Cx3D47fu2Xyed/zfnZTibRjEi5U/4UfzclkXFte/jeX9O/+3W3/s0/ZKZxcEBmtCxt/2LdWwnnevcb3UXoqjIyIdGm5jC15UOgBhyVm8TxvMidNXKfa4243bgQPSc2DltARqbCozEQAY7UD4yMbUoP094koXiAZRREwCZ2E1l2vzG+CQIQjmT4zhHuFpYKJgjtOtaW3Ush/n99fUusrVtW1hj/v9ba555TVBVEEHxBESI+iCEaSYgh9iSGDthVExs2pKE2fDQ1EQNKlI7GhPgMNDVREjDRBqgYG8ZIw6iEmEjQYPkgVFFV9557zl7/sDHH9xj/2pcNde7ea/2POcfzG485p/kJSDxbluAM1Qg0DYx7INgoRA3MJ3cfClo+onsiAuiysGtbKNVhGIuapRoL5LuI/hEMC9T2H4c50W2viFe/+7ufP/XV9aW3kZlxHFUfffP+/EHkc9QW9/s9vvqDVz/7z7/wo38l9y3ux+oGy2073n10/Ybf8eaP/u0v1b5tz/ctsFdzIM8D0V+pnk+/evX80eWf/MhH//gH77/2K/v1lhlr8Uob8upCh079QxjQEXRF90qZG2wRYZDPo8Y0TxlErBcpHmRk5cuDp9MuETpMcFLhXIvbwa38MrqrJPe1nYkSjc2sUl6SsqEFhtauQ+E9vdDj7o6G0PFuFlxuLChxfAUzBW6xzXFkRLEQZhCIxgMxTIxhmEoClSbdQ6cy1avD+iXSGMhcIJDSRs3qX1EiYeXtQ70l1LXlOrfE0tSkMQFmVciTgfMpj+eMeP1tf/j9sQD3lu/z7dfFx1+/51F5yTyq3nzw6f/1ix/+4PdXHdt2gUuKuB/HPV5/31/9yme/4fjSx3XZq7MoK+dzlw5ExKvr5c3+9PP/4f4P/uKH/+ln4rJfXj3FUTwStC0jDgw3Y1WoFBxoDhHciKhYJadNm94r5FU1B0EhoHi07QeUj45YlI5ZpGqOuE9RwErwwKCYIdpKlbDOGVh2GhxX2rq+5GqZNpZtWy3u9OpSTfm1WO8hbTMAl9dOW5iSW2Xg6RfYiYCFYTsSPpIZbs/CddGgpsO14V9OHuKgdim4UUKuPe8BmHPwPBBk0ESL5pxplQaQHEb0KTc95S2Pd++ffuO3xDd+5/HueRWYnq/10Tfvx2oCzTgu26ev93d//U9//Plf2m7XuGM0mff371//1m97/61/6O2Xn7d9v6/dPBczl73PI+oe23X79KsPvvD5+vEf/vhf/t366Mv56raOFMCQltar/xEbWRM/NOkZHSUbDIo2JSFYYcdT91QbcR5r6dFhWdMRLNr6AFjtpBpUZMS982nMpRTrQEAjGTxOqbay7W2iaN0aTivP0SLIJB7Psus0cXCRFKESRHRRhsFAUc+QRyfko0kgLhm+B1kghfYpQkDyGvZ4Xjrg5hjwZ7hLAzhpIvuKsxL9lAfiSshEW6dewYXDjQ7Y8tDJ00WMhf+7oSIpZK6N3fISFfHq93xPfNVX5699lLkfz8eHn9vefXbL91V7Hsfx5muu9bd+4KN/85OXV6+O5/cxo6PYb/n06vg46nhf26UHsUXEc0TF5bq9eX17+6v7T/7ou3/2N5//3//Yn27x6imPO1IDS75Yik+gGvWzo3zR7ftxHkE7NDVfsdFqZZEOycZG92ygfuV5DjbHwM6vfVqH876jm80wMntC1RskzDX33AET0W/KVLWSloouoMEG6pit9RBXCJyST7+iaGn2NWR72jR7rsv36+2WCEgh1NI+TwqFPuV/qFoe4CSzShFx1J2pYCkjUgSMhqL6DD1yax2aCzmZtMtePH0CmVqwz3ZnL41UZdVn/sgPHZ/93Pb8HPd89zq+8jsvx1a5b1X329c8Pf30T33xB75/u10ChVAmM3Lfnr/wy7frB5dv/QP3V0/HtsVlj6ctPtjizfX66vb0xf95+9f/8P73/szbn/mxevul7XaLqjwOJfgCzU7BmBOtPmnUtcwJKAVCLDvPnSPIiOT30U00hWsWwRYy3VLN6t1CFygiNV2HqdPxp6RyxGbM9qEXOFqsH4Dn7FiKdKXTXzSSlLn1qG3b9z1cIu13/n3+PU9PtDfodZDAD958Sq1iKQsTgGVjfaM9YKhmcwlrGuEfq+r5+eOD+SN0eU94ZrEODEEUlmi9PHozCBqNiTqz3dvWIGvbjo/fvfqmb//MX/i3x7vrVnV8fHzpd+0f/6Y9n4+Iyje3z/zvX/ziH/+Dx//5pbw91fGMlYaJo4cjYzvevbv+9u+6fecfu3/u97//7NdF1vUr/zd/+b8eP/+vnn/up55/5ZcrYrteVi8BkZ4G+MIKJ12jr5QAOMmHBBEkP10Ddw48U2wOYVLjoJ0X8NS6kRbPcr3tMK0OVM4p0FBaOjUuOhtmaQEtpYJsrAQyxWfF2pYpK7f9ernJLnTEmxZioGSR9voTQOp5bOssh6LLyIjVDSqxDL5EuKrEDtdqZyPxJyvGIEMHfEePFLZKy3tlZT1uQBOvcba43K5x2trsAK75CDY62HCSorJte0S8/n3fmx+8qY8/jOf946+Nd1+/x/MRGfdt+6rj3Yd/+U/dP/9L26tXdX/WZJPLk6qi8np99ws/++4XfnZ/eh1Pb6Lq3bu38fFXKiq2yKfriuaB10BODIyG0TNpRB2nnkQKEGh7IC/0ggkK8FHhadenCqqijDbbGSoc9LSxW4ceAazTxONtyglC0lA/MufBPBa563EK25GzK/em3qgRDM1nxKOut+JU++WlJQ14nBLrMAkKbVtHLkwSEou7+jJ7+YLepn2gJEbA8AzT3Q2t9LimTYnQbn11IIpAyEBqIj4JZFAg4IBusnPsBWUdo57fba/evPn273n3Pvbc7pf7R5+7Vt63OO51vPr06/prf+7Df/cv9qfbcX8fmXnQviXLimuU29NTVNX9bX35w4jI/ZIfPK2zkeL5iE3crTiULsjhzzxLvZbdAtwgUYT4UbLJdWwIFFWywentsrt4NNd0qLEskDvuxJKkcnVinRrZj3I30qar9wir2iKPxA5+Hoq2g0AWL2GY/NyqJRVmDnrwVg1XcI+JpSX8RnefSRttCPFeP4wt0vB0G/QUoB3BesrZuqk/e2XJMfsmahbhsgMvj73t1irwU8ixoHvr9coSF8fOvATaxNWT2pZXCfDI3O7v76++6fduv+Xb6/37POLtb96ePxt5P6ru18++fvqnP/blf/Qj2+VSz89Rawv+toeicECq7s9RR8SW+zX3a0TV83MdR8SR2+gcZ0BevScdUe8EwjRwiFp7ih0Xhe6oqqMyKrdCUq24YLT0Pz02cAwIOKXgwZNCaHqupOPFGzOokJFH96gugHsG8cXBcMQxNB0PjI7sQAAT8B6osKCnX+QJXpTCoA1nnHUGnGhMAsm6ST4srw/1TFTMNULml4cd5yIZ9aZp/usYYCur47EYj949AqRenhU4wDbCF3YBTcXKrKtQ3xoYyC/1ItisiNu3fMfz7RLH+/efqrffeImqqHu9ef3mP//cl3/oz0b2RtLy5JQOZ0B7AmZAOguOTdGgr6bh4mPw2qopESPV0XMnJKLQeFdXWp2+aFo9gq1Cd1HxILqKSM8brVuTj3fjtaGalf26oOXGgNGuAvizsSUbU4PQZYVUay3cLp9qk2kbIFvWjbRakXqhHqEwxHWMREAU6+2bNRgaW0K9u4I3ImjWsUevW9GBtAlo8q5TAakQCpFYqGlmCTBJGwrO2O4qnYvXuQX69t5SotmDKmp7kmYtsHvT47i8fn9E3Y+337gfbzKrjtv1Ux/+6od/6U8+/9oX8nqNexnRcODnQQoIfMA34fMDVGX+qVjAcnhfzjIQt/IATddqCRwD1UJM/6PAAOgck00UDCzWNnMEsFS4sT0p26rWeAfs7mIRwls1FkJ/peuA5Pq3T2NwK07zsSQwcZsLsGaLXKTkAfsM9cQiBzIiRSPKG+ptLc28mIH6JtPcA+Au2aoqZwzFgIIWlay4qsIe3cYipZf93w3cbzlhC5SI1VNZHb+WOaC16FA9fUaKV2Cf0f4UERHv//u/v7yPt5/J919b+f752Lc3n7kdP/zn3/6X/7hdb12o4uir+/Lga6V8arNrk7l64U5gsRgUAssrlhDGgIHS7I5OnIDvJ9fQ1q9aVkorjAJQPxQDdIAIxjDhsQL0DRa3VbdqcNno2O4RsSemWJCF0rwOMqjxvajKOcjJ5IrkagTpeqnnrwpUzPCwwDABkxXLsJbNQUNWImANZL9db8X71QubfQ2Qe3d7Ap4ipEk8SykPm2MbsftxTwgWeD9hlKbDfElTCLmB9jEoWCabYvnyE/UirB4YtW3b8+f/2/U3/Lb8vu94+5ktb/tXffqy/52/8cW//8Pb5VLHfQOmkoMvSAowuQBGl6+gHmACBimlnIySrub8an25iUCTJkGjEr1GC42XK+uPwCkiIvuQSRV6mYbJmXErogu+KZRJc6/PLdQbk/CUGERfekpaPA8nP6mQEWsPY1i+7EPVGeqRe5f9wo08rNplqaVThx36guiGtZI4cOdcQZ6vX38qJJwz38P4HRGDCtoYjCU2+k/i8EXGo47379+uNUGJUx3NGBTi2yb4BrmVNBbIzEAtEaswmnG7IqzqU9iyjtpvr7/3T9y+67sjjo9/+ic+/Ikf3y674AU3v/Q0nCeYTi9SVi24QAOVT1wcGD3bEdn5b1INl7idYm43JxXoZ1sSdyyoAaJXlM13bZKF3ZiUUwiIvmYKlZVs+dD8xwIXe8qgRq3eniNe/rHawvmpcCVKdWXebq9SelEmopBE67pUAAhTrKVinTVUZMd+oqUASk9ZI/gA/uo2O2NFm8go+Am5vnv/Ng6aI5JuVPRJRMQ61CWt/oEuO28kkO1E1VpDBSE+yqjjfj8oRfv1EhV13GPbGjdPxpyGeRJ6U+VJiOqiqJKwdjttxsE92Mn/06vpQyPzQd7m/Csi69GnggiWF4V1wdZhIf2CqvpoalTNzhJb6sUp4IojRi/waPKEPdGOoRUPPz3Mbdtu1yfwkJLBBfpl5MHk3d9B4Y4ZwU5a53693ihWtOaDG3Q/gwGDFgSKBFfWi5B1P461R9Mq0ifhgNsDAq2A95Lbm1ZGozrbKXYHeESYTE5nZOZ+qW3LfdsuO9cQGmFWlGKCZ5UiYUBXE5xs30DMKq9GGlWstfFRCU5Yt8OjlAOZwCdURM5xCMw8SCl6i8hG9F8iupXLS3tWyKNLhxGcdFtosJnCxDxJN3OPJjNpwKdZHYYcDCBu27ZvF0fU1Bq+bO6pb3JaU1IpGGfgvfWBbf1lOXo0+hb6MwIY7vSS4V7Vj9XfdarpANvaIjRyByzrURzGWjtrDa88wgkXaBzro8rYMhfIfyNoya3l4Diyqo573e+Be5vAFdxaykCiChxHh5llI8s+ZKcjv4M5TckN4igLKoP6yDwXG6bMXpb4fKiaEtUHzlFjGxSLboU8wuqqzlzbzAOKqbmN9pVItokayIcbnLQLYgUGEUM/SO1Fnu2syhYZMmU0aFWyAJW5SW7ZzsQQrULRR1IiWj7VZcZvKn0QmE5tDBNdgh+VF+R0uzPcO5PFPY/egCIqYtv28VCLI0c+nB0aqtQgQUITFumv5Rtt/KSDOOu1s5WyWdUJoHSAt1ZLmIzl44EYpO7VNTk5dTsmxTKFyI0hW9zf8/CKFSIxmaJAqjjV3keiT+yjKbeL3VoHcCZcD5teVCDLPEZc19kktbsFUrjZ0mELAkb8hlQYArShQzZK2JPecLQz33yy+aYMPKYicts2PFbOvCj5scYNWj78WPhUwzNCCxEZBByQ55c8CrC4p4YeGfZuAW8DXDjFKDri2zMVqUqopF7WLI7ndRnLBY0WVEEbyMwnanowzAlDaPCDcaoQcUCRmGScoVCC7bH2wWmBNAnLIFjqsfDB7DGjhrUSdV6rj0Wp6JW1oB4HSBeD+SYljjONyMJiAjzYDq9WU3lT4Cjm21uKyuJGWEL4FrPPMyqKMk9tpTgqCMWaYEwEWvfZPoh9w5bZ7cBmQZDvG9aZIiKvlwAzPBIt8RLINPHHxoFj0xak/iaQjfMfKMQm3BIPkCt8TAHK2LYN71ZEx5JTJWsrwAZtBJA938zXJlJ6mD5xH8xKkfKMnM3ByV9ULRExAYcc02LFOi8SL1vEzZBvgseqdewNy18ygAejz5I44vWG62t5g8L+zIWSk7n1VJF1Hd54DO+Okcjem9ABKEBNPW8CQXLv3HzYrLjZ6PagGvc8WjmXL9jQXswdeQ3HRKzCH98vManQypPcNtVeIMPl4Aw+A9EZrKd4s0xyr1rC/UhgA3BskmZl0+HjY7VGCcO6IZK1kKnqGWm+uG/b9pJvd33q0cn7eRsCuyBOBUMvjakSYuVM2Z7D9ViGy2veRwEKAatskag1kOS6E48G/EBYOC4xUdpkzNmYoPr/ovMKJA6UwFSBwZPXiUZBWxgR1Ydsi5wTCzAVvb6iv+JsVGcagko9KBQrW/Q3FL82iUOx+N/72Be0shrKh8cn8Ml6CR5j7aQVte8X0sHcDyB+YPGHR0JhgbjiWO6Ul04ZMmpLSUalWwEwElbRgEjG3CxYx7R4BBd2LPy27du2IW/DYhHBDGXIYgNaNsNvYYUc7w0o+r06LemB5ZXt5DQAL9JPrMGJ6iTXFmG5BtU8STjR/4Tr5ILwJW0McvWssx2kwAFsDn/C9qlkVQnuEsj+aJQH17QkAM9u7D3yHx6pRNeHupaKsfZ0tL1SYdfd5tmJmNTCrox2qN0QLtEBlSKG8Dg4tca8bVtu+8IRwkXUf6gAScEPbCBjTOQtTvGjcMdKgzLu65GhqiyeFV19Yt2yTCt8DAeidAYKEplRda87j8EkGM2lzCmIgGZmhGoqaaq2Z9keDKWqN2Dr61q6VYNNcz+kPJ0YgmbUjqRIin2FkYDkkn8ab2nFpRQpqMFopy+WY2RZT8SdYtQcKOUJgIzMG8uCFHGBvbJ3Jmvt2LDKokBkSI5BTpiQrVlJpOp2vSMhvy1ksjOyT2/QJhKCWpaLyoi6XC69ECxFRnl5/Soq6V1nO0RyM9nnjF91ALW+D9bIFNTj007KdYoVIHKcWkbmdj/umDaCZTMcbeMCW03aEwcnhT/FR0sQWWb6FLEgP316dlLwWvZo+9qA97IIDCPhgeU1EM328GpSw/pjcS+94CRd/4JTITKZgeb3rPlITZIia/CMAqX4oCmgydLtqhoQWo6+4hJi06KFGC/luKDz3PkPZx6ShXD0mdmVljXo4lvb010vT+Rvmn7lMB4wAyeYMH5obXP8KV7HZkAA5oWJqhSKe4lP9qwkTrSXo9MK7SLbZbs42SzZ2jmN6kCHhghQXCo/xZMPKayB6lRPVsxW0kXr40Qm28qjUyTlXKbUji4xNXb6uGDivaMVtq+kWUiFec2GLDQIuTJCEbEOkObbqw4zhfrpFdVAicLGFmNKmphstBblSLToOJQGObqfooAdLH/PB7YfKjbi5oQrFEUmKqCxVpLc90uiZedkHxGrQbWzsBvklMmpAWksAimSLopZICWvuuumyEotFcgX1czchxBbUCAorbVfru0oEcfgzTUCNjCYMgmnX2gHUtwWklnmBUGXNRvkq6KiNo1tmdh+NdYD0biUZU/KJlUmfI1Zh7JAOxfGB8oWYp3LBRTWdMQYW7BDnnYVBcit1cjBdAYPPwaD4I26ZQAWim2pzY67hcRIgbZuWyqUobT9AW0w7ZGpT+iWduknoupVZIGQpMm4UQ0iIi/7VXJWQ7hhZReKGi1Tn4RJTp27QUvVCH1DI6GbC0FEDQNCHCRbQE8UgAwffvppJHTZrz2mCpx1AGvBsJZJX7fEwvrtlvjnBvfNsTbiwT/HaYVCnZ4pMLPqvGjN47rYwjK+SroK3lAA3dhQp7PnRFwB1CerIFni/DrZrSqYoptmId3XyBOcjVLBCTUv1zHJCiX7zbnZSqZYNEAjPQZrga75tGJk90DQ6EpVsBNCGdppOjbBK7Gu6nq55mbTIS4uy1N419OjuZ8SA4oz32VUjcio/XK7BcJ2trtSjNQWmfynRXOpNIrOjtJNHw1xrjh42/bjuKtPQSNRy035gwxtKp5wEx9Egx1I2oD0cgiOQ2+zX4lYQIDAQitC6cQaUjLHe2thR6w9gM5sxuL9qSr26rFhWcrYl5st21g9o6qC9emL4rqbg6A5q1yDt9mETS/ocJwr1siWmjVotQ2MspIQlh8R3yhQCwOyb219gWVgse15vb4KE7jZwQNSaygvoR232aevTYhwe+23tWElgvspcoMW/QsO2GgekqSpoMumPp7XoUDu9/tzos8kTJxIaejLgF4gmRfd08bHz1OyiOGV+PBgPdYj21+k5sqEH9UkQ59AoVDPJTNS955pP3AsNNkERtOMXp8RXK7drlbut0O29Kmo2FwyV8jVF/Hng3R0ZD6lp9Cp52IAe6Id4DBbmoK0yLFMRuC2AeBdbKMib7cnHKJolm6k7mQ89DrZ3hzmXRQVIU7aHzZD9UVOyeLXFIOFu715BKMT4VokajyvP9q27XK5HeSEAgY5X8yFogbxY8tYS6J3DGCS6lcDY4rdj5RgS/WtJMTGyMQw+3TyqstyvV/CcvZwKQnW6d2CgJBoLWFcIVxTCig1VILgkWmKGTaEcgmBlo8Js1lswiLZBz7kZETg4XoztoQdoHClEsKtv1nWtrh6BIVSkau1EHvClsPAdmVFXC/Xbdsd8mf37J/FkJX6AAqRADcHMQzNl6J/kBHru/1yvSEygCbL1xA6yL14VMZPXKkQznkKPZx6FbXve1Qcxx12Ho+yXKIjfqGOYWXc5ayC6wsxka7sv21YAh4VXPIAfiP7ycrGEJa0cwIxbRi95snhFlVGUv4Tt3iSbuvlFNNQUc5UL2AU3KehlXBTUklMLzBu6fwZQJzehX4JRCVuRJiL62BgbYeeQ/zO+HOkEUSmqox9v1yvN+vJzhMgCX460bK+BXbwUHTS8FST7N+6EDayi/ynfXDXrGhJgYFqUNQmmWkOFfqENGvfsu97HccR2LoVmcSpWQwicsRjjrHcv7n3ovM80kk4NDW6BreWaC0WslnVwXCwlZ4CrD4CWQOae5eSFZXiwUB9FNWy9ymwzcGwfgXTmD6LBpfZcMMYaTEITDJvd8PlRjYTJzk38/z4WmWNAyyjEooz+l5zHKwlsRa623K73V5lKLY1/ZHfKI2GQQ0K3AZcJSqKKZEUq6zwEDsydJYO6CItLTbLrt3Rlou2NF6aJBoFXbyw2pl4MTXQuN6e1iqt8A6y0HrLRL74AJWl+jmked2sVI5lyApbludECtyYwMTIKMOipoSa2Sr3rzDhxV1YsA0PuoPOOofkCsphcBxHnS8tBeqdgwpklpSPS24sgKoWha8QolSKuXSx2VmtTXIcgZ4jIxh7nYnqjc+Ei0jcs9WACd8iAgnU+tkUeGTk7fqUTk8TL4yhqLxpfWqnLJnkFipbLhcor7qgFrZFSaXEXvS8ol169isgrhWae9O/vRs3MNfDYHYqM5+urxZSpDXN1fsJeAonU2g1RYSQEEUwpMZ6XRJG5UgGl0N4C0E15d7dCOiPBOEqSqw/CT1LSp/hLb80KEEpKb0I2WA2yVKtvQdSfWuFocLy4qo1oW1gTuiPUlIaVWEVROfD+zq08qKZjBn0lNKCaPgTVVMvFHY3PFermNy1ipgHut1eZW5domaJ9hH4k4Et3B2s4VOBSID92YCup1hwlxlRDYEsmprI0GZgjllxBwGIXr88E7yPhz4W4EBkc9v2y3EcUdULiOr0ag/zMbnWCBGFGGR0SRB+zGcYAmbBkWlT2qcC5pGfP/lwp5NjMnppy+N5NOfwA8fwYmYhKAvdV5AQDl4dJytvtT7A1tmpr2no2Ciix/VbiaBh7YvXFa1SumUK0byd0SCK2fT08WcXIm63VzhhyUMky0eJlwUjwLkn0JX0CcQ9GfGsiG0LCYxpZa8JduZ84k9S/Ix8KRVgnW0hNFk7nQpg0LRTYbVt275fj7ovh7i4mDlHivVljkqMg5i0YQ6BYYOHMBfZ7srOkwPMQbv8qB2MyBlPPNdUHrTiwU4wMBGGDWh+OmWkbyYBI0Pbx9fmGIE7TWJKEtG7yIfCUiNSkyU7U6RMn6nC7YE/+Ct6nvxODiS2bXuS9ONFtGbuEt2nncg7/pt6c0NSk2pKY51VazXD0YDGqUA1OUkKOP2UeUiJm9OKyZFH7cLGqZn7fq1jrZ0f/OQiVoq8W0vGDHO28eLveCWNnsEcMxo0I8biyi0r1jnUM0CdL5DJZBu9CaG7wuJv3IMfSQfu1pDWMaaRFWO6IXWeSZKh0boxJQNPpOBqNWQDJsB1Wr4Ej096exru6cr10v1yud1uC/lQv2qIF00qfENLmOdXLJhoUngUkQ+vlu204WXv9wXHJNUbz/DVTw5TMKzxumIKdHxh0ss/aMorom63V9fLExEQlpCCnUYT467LnsE8+KZzFGqDWDdYOeaBZJa/CmyYx6WIDLi1JAyvFBHLRzZAEFu+9a6KjprwydoiUUFg35Lsmw9rW+dzBrPp0qJPOQiMFt1zQbzGnCaFONHZ0Fbi6DSIi75oCFOuqHn+rHDwcr1er084N9qQYAaQTeKhSXqKkNUeNQE4OCTnoQGEdEHJjDjShWW/XG+Wrgtzb2dhiKFtYqOJluxPQm+QOjThHbeErTbJfd/3ba+jqu6W0bOajBneGsXIJotB05BQ5smHjQHo+vmpG2w8CgSyDL8+WrwwxS+crBGG+o3rLh32Xt4ArnJiFbF8kY/Q7E2eUTgeVzjkAEkKW3fmTLUzFgL9LnoRGIZHgTYP9aqzzK2WjX2/3V5d9ksymCfdDNo6eLBkgJ7Maz3hkSfWuj5ozUyYovT1+63rAC2qOd4nb8EWk2SN/hFg1CAVtRAQps5jbPZBZlbP07Zt+yW3PA5sM4mBtfhtaapkYT6CChVEBCcF+FljOkmKJy0CMgN/5w8DqXIwDM5RxaJ0ohCzxcN3GaHFOw88BNNLrBfPA8gFehAOGtcky1dQjXwBgVTTJtgKRvRek4tntWWOqZL9jxNiRbadul6frtfbxrMAk6sqztiEQ32UFHBNC450F6zSiNYaWyD+TRpbCYhtjWh4sZxHvs/fuPKs9S0qCX4uS8MU+zkISFk55YCLVD2q7s/v7/fnisPi/wjw+DwEJEV9EUXLjxfFWw3aGGplGWyauDoegG9sOuWRluXRfC3imCjNJmWnorbsc8QwzKqpnGxqnZ+jLRmqZUszs+UOvwuFBbQNA7Ulpo/MDFMhey3UFa0Y7r2MDYsl22W/XPZLblv5JPzOvqmbJ+rlgdh78JwgCnvJseOL0xhPybjcr7db9+6cYAIM4Kggu5OyawVCU33gznmS2gbTQL5q4VNtcxyKjPd938OrKwYwOOIMrfx3hPDg39tQ4J82RcTclr6diW2M8myjO5t0wkw2Rh/AAz95ZXSaLOO00Wyhbd6zKQYuzMNmVBVW39Ou0/PQfQaNJXazO6+inqoHYYB6bitHJ4+V80YSf9tyv1yut1eX/eLDtRAUftje/mKYPWRM3gGV0fyEK00XukqiXi0RY7/cnpD6Y5tqcJE+kxji6K/3QxxgcBwRRhkPgsOYHZyZwb0CkQPY9u2y75fcLkmzEwR2IqYBN7jrjMRhj8SADjGHT7dcDTcBJ3rjmIW/GaGJOtPLmcHOCEJXzzT2J+ZGtKxRyQ6/NvzpOY2TqMhXTd00kyERIrFFmRmQKPtskCyHf6nm8Ja55WW/XK63y/W2Q/Rt5KcHxVTQRwFLG7ukhpj1RBJZrxYfHjR6WtZYBMH5wZtPRawmZ3goLGQvuZDF61N+rM6/mPeTz49ePYSHyAyJlb6PyQQ2rF8iaV7HcRxHRd3vx9FlV5VHPMNIaC349lKLmTtH1V2HECM7WFSPxh5Ke+Ixkp2H7orkAhxfxtcIBPwVH5qkI9KsyQHW+EofBFNO3n6JCm/TkLrh21nA8nmSJLVOyYtoolRkrtXu27ZlbtvWm6BFaOj62dSR1G4YF53jaGEpku+05UgobfuI4M7wHMuOCylKrkPN16/fdIK7CWcCE3aCNwZwnhOHyd0CemSPySSbzeCXcIleQTzt9zFh3ZNaiHmtO8SeNI2ieWc5VJ3MFiqTykfOsY6gyf8FEzx+OUc58114sLmxVQUr9yz2Mq0DCCP9yX68MKx5gTyRjMm8bA57UkpR44bAf7mabeGtbf1iZDs/z0jlpMs+GJ0yTEk+3QsjRgHptsHHt2ARn5X+DwUZRlmuyo3Ky1Bm5MjA15b/l0Be8oXNv145Ohyp3hjzOfmoSIMHlAGmDaIWoIFmFWHzlllVlyllFWwc4icu3HrblKkRMxi+93rc+TsXyUcnUzrh3r+QY5HTffipSSn+KVPco3qQhpeEcDLwpOqnq1OPEdYxcdTT1ppTGfJzCpT0zY7MV32z0IZEp4K0wEMCQ2OsJmiPqBp2yNE5I6uwAzy3ypdTYfYqP3j9VUHFIptbJjXdGirklDQgbnEqUOGDH0jXodMitBqAcBxtZvcCD4R/PRQuzP/KXytjMgVAkgoql0nXSWzKwlTauolDwYp8FDZ/QwYhRcUprzG07EEHzahM2PUJU7NFscXV4C8kXVPupk7gHhL8AhfBFQ7fTOSA/kJZhECBv30YBjtaFLQqXwrDJI9hkyz5yxTBHowSBpqRtV+vt2y/RmAWXlSig7JIaARZCaxq8ZX5spyvPQ/DpXukFMbvFMhanti/RDCkiFU2xWKnCJqM0EgHxMLLspVYJSkzf8uQMUbFWX017IECJypOxGzd4ZSYUhGjUpNCO22angA/uNhPJczQuv2UMJtETlRkmScWZY2U+j9fi8gvKQbgYVI4IEFhTOLDx4D4yPSmOkmbxhM0/zaYlRCizEKmOxTOKB4snT6iyA9ef8rHMOGSxadyMzh//gXANm0RbA4+c3FyC6TUOp1ZMfvN17dlMAk2VEtQ6dJcYCjnY5HcecxmYJAbP+U3H33gmLK3HsfLN05alY1mkD6Go5rXZ2DDZ/vJoch5HgFnSAT98Gz5iNPH0wqNhMEDzmrfO8oorC49/gDJu5tQ6F0GOR+JhtqHohgDzhASSWnkofhdEhNVftwZJ+A8LNM72wqk9/AQ3phTSBuYhADwxZo4zHU2JijmHao5k9huBCOgz+VEgscR2XOL+yYNrVGatamWnBs2V5aLW90FnFyOWdpzlunTk1wkYO5ysMC3zBvDocyk3qqesTjtOTPcGBw5xjqNrCxk36TfE3vEjommmfG06n6bUPRnJVYDkRshoRffjWOkjh5OdMOzBk7wFwLd39kbrdXYYJgyMrG2Q7PsTq82roh1zFrVSfllABO7u3RnWoXDj+njytQmsSZm5Kons81ERKjBCxdWjHeFtlzi7xVE9muk7I/30emj9b+DQpOj2eu028bpXXyOdEPgwFv1lNdnxs1u42hoLlkkJPEquJm9iWTSXLA8qeIHgx1ssXbGmq5R5SVsoGcfgRnEsS9fp9kOy9cU7Kzy81isRC0EbbQolNIsYN1VmhlkewSM0KzbYmxZjcF1zZgYpGe2JGnzEUREn3JDMtgZ1maWpVsuueONJqPaXqxce/3ilxw0BaYKm4U8yAAHPw01mZdYsAVpNkN+ghUNz0b+MXWDz+h8j5ndmgHl7CXPEyML+1NPrEMswa6ehIlt8lRiFSCGViev4ds5ZXrjSM7R96PREzMaZ4IdQEAUjn+Zsjl5wVJgPfCfVyZl3vEtXDM25tP5EI85E9oOPH+wJDPSfMs0xK01m0hVIB8u2fwrbRwcrWrcNw8vqQfpJ1OX0yi2FEhOz/DSqGdWpzEh2ymgHi1lQD3rMosszAVGSG6cJv3fRMd3ZnCDARcCwUcIh7fZn3gMcYEQ0NPL2LVFw1fYR+vE0WFuYYGQUGcfRtAzQ8kHp2XFgvdJsE+zONlBfsnOOZunQjcUIw379lgrsnL2K9UZ8ZwCo5Z8+cq2njmFuH9nbbdVcX2mZZ40gnn+f3G3KByMS7DQTQCKYiarOuuUnIHbGKCrdTjSgAw+8rNICigKycIIwvWpDSapk3oKrrJhE5oEJZ1iAMlay2utyBzSejm/BhXGQmsiWU35vYgFqY2cULgHsNjXWeY2l4lcSen1+uOIsmeZEaa717ZSMNnEPRxBdZ1mqpvJ9OnxoqpBIcHdQUdMjWyswdCJQYuOAyaV0oQKbZtOMwDmGJG9xuJksUVCNUyggwVDXMSHLoT79XJjeCMA0CzFuju2yw1x8nZ/e6zCO5j1h14SR8MZJxmlIidCZLNlMFG6YUAbR7aj6lGoVBt2AB9LMc/JxmuREfqQ5tY3eqOXGErPBpfwgAkMFCOojTMZPA2jxwxZgsls1h4xDHOQ07rjSbKRsknka56pA4Tp82hKGmz2yAuxiFaAnEA9EP9QE2E56orJaaJORbHs/kAzwfMt6xPXCc1Pxnc9ab/ebkMEpQYkUfc+qQXBAOWQJKFUAQtOyXjgy0YsFSA9HCJClyr1kHAZxmoZbdG1LIvokLJ1bbiZhB82CzfKlZ7zkhzCCV0M7p74TMUe/XDjGsuQmYil8YNUwfcp8eUPchX4/xOpioOIHPcp329Ru2f6bWBD3E76nA/XqQzbF+n0WePP0LSQ33NSpj8cs3c2D2WK00hLj14knPsC5QgxaGz4/zO0qvne6oCc4aG1ELtR7JK3YmTe0W0VlpmJE7FZQYVmVDcr1kgYZA/WpDp71iR02Q0mC0ygIb8xMjSJ7QjkY4YgZKiAjc4SfV8atFWewN/OspmXpjur02uiIElI7z0wuj/1cFCxbElOz+vLsjsXHxA8jEFC7kRdWC0YasZFfn+wG7kA5j7hB2QfFzRMhlMCwx5jPdhP426K52lHukZV5X69POlNUnj2iUFow22brNSDmvHlaRjGwrMRnJmZoOlXgo8a5lvSAG8pDSzbhv/lmHfGmdQon+PiUe7xOrMBzCHmC3AYwlKn+ZBdd+9WvOH3Fsrbe0B8b6sFjBEBRJAxQpVaH9YptNjl+fP+fblmEj/0y+jikslIEeNUCOe9w3yLPN73Niy33POpmVx+X51s4YYpsHvhmVdj5BbSdfrj0lkbxtzZWaJqK20dKlpkZNB4KvoJfDlaidmclq6jeqJWD7cazscNMp8SUpCYVMrwZMZa1tnjxI7mk5V9bC3iOzqIpi6necbZZ3QyyoSOmI42BClMmDG9bL8MB3dsSOxkxZWPNV6yGCeqNeZEwDlShjZUdDUyVlAD1aSNiZDxylGBqFjjHiv5Sw24LGfcMggHiq0/xiL51vWCLZ52P2J8UN3eTNSYvSZ4QN3HARiKgQI4JIRhIe7SWaw9S9r1F2r47hGMmTTzJ3Q7bgxA4ZwqEIgknRKglT2X1ndpxFhUrxuHMcdq1PUfC/8+waHTV56qh2UowsaoGNY8uledzJ9zt393NItBvfV0E5enez3QcAx9sjnHp+e7DA61joy8jPufwTKyCSzOyfQXmObUYXrgYSQvioimosC2q4hEbhtSRMxKDenGi0sv4gaI+CkZrpXQwGqAtDTv6Lbg0FT6A7BxD/xJQhVRtjahZ4RK9eLIC6tc5YFmloZurk+JHci5L7eBJNmOgKpeslpB2BtdFehgLYk/P+EeJIVS7gGuBqZyZJsKGxU2UsCn688a6zsexjfokWq/Tfv9HAwIcrUvQlpdIjd7Td1fG5CACpSFsS8SxR6B+XGi+QkygtXpCQpx6KeldPvteuPSUH8ZGV+GwKRtrqrJ2tcJmA2olJ8oziADQQTN/4ukKAhCDfzubuwTjBYyzqehuXUY9lQzBFENmI/EWb4wTppUvtAB4idzrs2TIi2bxDCjNisaVWRbHmb/ctHX2DU46o1CL8yMjHCLbgB+jA9vX1N7sPIn8j3SBZM7NeadnjXeOL9ZYL/FxnOVFZX7ZW2LMlidxnVS+yWhsjZ2CL+DFi9ifQKzQW+XRMjBC1RvgqDt2zJ0kO1Hz8uc0YylRdk0HTrdrypz91eMEhvGeVrWMCmXit5eEuwx2bIwH2M0g/syFR0sARamXClRRp0ekiGS5ah5++vqhVdbJFqaU1Ikc4ztdG+eCjIer08fwIhUVT+8REsqf13KGJQ4Ld5m9RGVYHwDgrThfxSnNKJqMwYFOKqasQ/A0t5UrYk7k+6NTHyURPCs9zRYJGJezFxeMJsBvCfdUlocFC4fygMlV7Z2HazJhZ4Wq02itY5EBk/LheSVPPAjTf0XxC+VzPkA2X0ClqfMZeJ0Pt/ytGSgp3QSOtpuzquZKsJlS/qeNuMZLzb75I/zPDg8q7rfpdFTlDXcyUKpItGiCIFKAc+Q+5sib9/FmG2Lhu0JEto0PbvlE+siG9wyRug4cfVpe2q8m5iTC3LYNwRpDPuo0OWgTcXT5LX978ThTZyUGnhkD/mnCgXRKUTVZaBP2ERSHBkvPmXQbMJ72cTRIiTzJWQ15KcQq3xCM34gkCiGRaajQ8b8o7bfXODgTAFcI2QXcFF/Et8rTpKEjGDWZWj7K7vFoCHMR/KMZ5t+FuJBm36fGVHgFlxFU7F4I6XfKUG84ecct8GBF4aGBWA8cqWgSmVFbJ4jAgk628fPNxGpRa3lDtknUsxeF9aSPRp4omqIsuSGQ1ZxJ/2BxfcT8AaLe0IPBcwH++doYvkkuITUHHyfFQwwcTR3Idh0OX+QyKDaWUNrFrZB6+/FnqAVJm2NnQIpEB7vsMNYUTo2bTEEVVM12D9mFkoug+eQIzL1lRCnVAAESOik0OkECwBOqexXTP0WpJwERFlP06hxvjIHnUrWBtg/GzUf/AlUGF09LftRGXFpGsACJPU3+R5NntAbjcReQeC7GnJoJTKX7xEQSMuJVHkmV8E+pyoP1umWY1JEktT9Am5mhhSueXqkYLnJ6WRyPWuyUmHDxg6T5XnDNgBoiwsgboQhy3KKPlVJRePytzDDa/kCXyZPYzJLxAoyKt3JcCyufMtcoG9PS3JFFd7YGT513iX0nBy3JL/52IJilM+7V0ORViOoVCpRUX/TjjukAAw7hcyUFpNdfckWDcPQi5ru2B5/krFBUSPxr62+0kkuMcwndT1kpCB2TPHN2cIZ5eCncdX9h/lBU8wTSnQ/bHI3jpsY4GbUI9JebuP13UAe0zfriCn5VSxZktJ4AMJnCkic2RkuuSG71GCUBs6XCcHWyJmGJDvDWMS1C7LTiVDISQDGo3Oh18zA3s6GBkLcHrEYuhbaaEg0i1MGQWdKfxv1dlBjiwm2zZr00/UnsnlRcZGNZ9fm+mUeWRWSrLbNxmXjUwJDJcBOVyGTw5pyLNgc5nKB48RvmhRfedvBJtMmKAAg8ISOWR9deISYJo8B6wabZejLZIX2nH4EE+kxn1fH54gIUI6l3QMems4EqNWQGQcoXOIAQc63PWkKH8Pz1TQF9qMpjmM0hGlgdW3ZNb0NR6gSuaTUp2PmL7X2w57d33gYYH7eIkwirNAuftBErSoSwXiNi0dE4DCd2W8QkXOtFHEdHC7JL5t5Rl3qTntx+YXqlMoTCBYD1FHsp5z1E7AdUdFcSrBlUFP3mMMU3B9+gxKTY6jQH8OyNJBDCTRUZj+7TlQI4tfNDHo5HR+vvCT5UOXQ/yTHCP2RcROnG0VEoa+9iUr6UElQ0Xc1fMCc6SIcWAAVbfvRZ6ZOER+v5wDyrIyFGwwUWzMBe2ICyhIWW0TkuLMlne6sHWR1/iNhrY7gCnGTOGBoF5EeJJ02U3sqvbrAtlA4ugj7yI2Sd0qEuOa1DOSghv7Q13Rrj+GCcw96MPZw+yqgzB6qApXLVssUZ8u0Nzppk5Hu7MhhQ6mIpyBI/isjhrjZqIv7XwxVrYdlVuTv8res/ALmateFKpOhGuTCzSpt2FBmIFGGoJXhNfunrtEerMeIvomHMSsf1sA+FC2ksloykKLiEAAHPVSZtJJHe6dlLTbeQQTvbdoZ3IXAQapAvJvvyZbiKvc04xnz2uz4Q2FcA9GlrqMrwqC7D4AZaFmD8Kq+XmeIhYCMzDjVGRWQqOvT2tcoBWhVc26ZIcKKoqAsJ/hxYrQgEAxpn87M9Z+WNmZYxeeNN3u0jyF7tc8gpG250Sqd0ckxLQ10eKb2cFl4O2XJ8LAXNpHw53unfPc7Ry+GdI/RfMH0t1sFFHLKD2ksYCyLvTxFn4mz/yrZvY5MvUUvYwRRME0F68xtBlRCJzZHnwptKv+tgZcz1KEBL83l8YYTRkBX3E8cQhZ4rqVO4LeF0MlzVLgkmjKxCbsNOQM+VVTos6IJQiAxt7KVKSwTXz7Ifrr+U9hrFUzGYUxhw5HBIK+ojLy0pAgU4jbbhTwlII2tszWhkvQnHRNkiUFkBV0ppojZsVUzo6yu2/SAdbF4vc5Oik19ZtfWmhOYgw7uSuFmMqc0zlfs9H0TeIMHUcmodbc3omKdhSYvuPSF6tnCCh+o4FVt3UDP4EO/83ykjzb3kiYIsiCExZoV6hgXzbFIYFIq25HEMSyYtRo0rZoXBhWwBRv9Z+G/o7OfD7NoQYuesMbfW2wyrG5a2MvCQQ5tR/LosAz67yaGlDkpfWyYbuMWFdLLJg9LPqYYCTxFoAx8hFeiC7F8YZA8JBotM8K0NZAHgf9gErrQs9FvIQKDbhjubIuEAS+xKyvuDHti/jtpKUOSyXzpBd6fSYNSqwH9tIlpK08nlIGiYSRwCE0/kuNBGz6aXXByDPEk9X0swteYmUFXWUKJfoYkNsMRrEH8oUUdgsEfpEm9p6nOzeEQluIg0PlNQewTLRz/tyYAjEAAEpXOGv6eVs8oLouuFTHCGDbaXNWslXQNH0NpauRXGuH1MLOhzAp6dlBmuZCBxFqfDiQKAqkQmckZP6NKawANZhUUL5BVCohP6A8H+yo1LcSg0FnEMXowCbcIuF9vTwaNiWcTW6nLaDHZmHBKpIPJiFPVHHG0eR+Qxs+4kzFpDQk9BMnUxPs7g4ZKBLMBSTu45gyrWWOE9Ibks5AzmocglRaDTEtlX0BjR2v3nFQEHHJSomU7yVh+DxqcZb4tzrgKEkmCPvIDxKfCS1DFjR5ju/CqORXvZSU75H0ocek0IDoI2GGLUIsvnRTVYMA8Y0OidmM4gSaTshmWc8AbIbN67Xrr69efYl2t1c91XfbDPKTYCw8gq20+oVwA/BJ+ZYZxmZiiXaszRU4fzIf7iN2KWC9yyYa43zrfHS6Z5j/cJr6cUAda5dPHmF4gySBaPD4Qfkur1s4dCZhriTmPTzsjtfH1i1PpO8Z1GoJ+h7h8EqfPwuEv+3WKEiIQmglIDEzWGO9iGDG5Pkf54vz/P8ZMB+nzuk8CAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTEwLTA2VDEwOjI1OjQ1KzAwOjAwvaPcfgAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMC0wNlQxMDoyNTo0NSswMDowMMz+ZMIAAAAASUVORK5CYII=";
let LOGO_BYTES = null;
function logo() {
  if (!LOGO_BYTES) {
    const bin = atob(LOGO_B64);
    LOGO_BYTES = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) LOGO_BYTES[i] = bin.charCodeAt(i);
  }
  return new Response(LOGO_BYTES, { headers: { ...CORS, "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
}
const PAGE_CSS = `:root{--bg:#000;--card:rgba(28,28,30,0.72);--line:rgba(255,255,255,0.08);--txt:#f5f5f7;--mut:rgba(235,235,245,0.6);--pri:#7C6CFF}
*{box-sizing:border-box}html{background:var(--bg);-webkit-font-smoothing:antialiased}
body{margin:0;min-height:100vh;background:radial-gradient(600px 400px at 20% 10%,rgba(124,108,255,0.08),transparent 60%),radial-gradient(500px 350px at 80% 20%,rgba(61,139,253,0.06),transparent 60%),var(--bg);color:var(--txt);font:15px/1.5 'Inter',system-ui,-apple-system,'SF Pro Display','Segoe UI',Roboto,sans-serif}
.w{max-width:680px;margin:0 auto;padding:28px 18px 64px}.hd{display:flex;gap:16px;align-items:center}.hd img{width:60px;height:60px;border-radius:16px;box-shadow:0 4px 20px rgba(124,108,255,0.25)}
h1{font-size:22px;margin:0;font-weight:700;letter-spacing:-0.02em}.sub{color:var(--mut);margin:3px 0 0;font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px;margin-top:18px;backdrop-filter:blur(20px)}
.card h2{font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:0 0 12px;font-weight:600}
.opt{display:flex;gap:14px;align-items:flex-start;padding:12px 14px;border-radius:14px;cursor:pointer;border:1px solid var(--line);transition:border-color .2s}.opt:hover{border-color:rgba(255,255,255,0.15)}
.opt input{margin-top:3px;accent-color:var(--pri);transform:scale(1.15)}.opt b{display:block;font-size:14.5px}.opt span{color:var(--mut);font-size:13px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
select{width:100%;background:rgba(58,58,60,0.45);color:var(--txt);border:1px solid var(--line);border-radius:12px;padding:11px 13px;font-size:14px}
.lbl{font-size:13px;color:var(--mut);margin:0 0 8px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.btn{display:block;text-align:center;padding:14px;border-radius:14px;font-weight:700;text-decoration:none;margin-top:10px;border:0;width:100%;font-size:15px;cursor:pointer;transition:transform .15s,filter .15s}
.btn:active{transform:scale(0.98)}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}@media (max-width:560px){table{font-size:13px}}
.b1{background:linear-gradient(135deg,#7C6CFF,#3D8BFD,#00D4FF);color:#fff;box-shadow:0 4px 16px rgba(124,108,255,0.3)}.b2{background:rgba(44,44,46,0.65);color:var(--txt);border:1px solid var(--line)}
.link{margin-top:12px;background:rgba(0,0,0,0.4);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:#A0AEFF}
.foot{color:var(--mut);font-size:12px;margin-top:16px}.foot a{color:#A0AEFF}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.pill{display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:99px;font-size:12px;font-weight:600}.g{background:rgba(48,209,88,0.12);color:#5BF58E;border:1px solid rgba(48,209,88,0.3)}.r{background:rgba(255,69,58,0.1);color:#FF6961;border:1px solid rgba(255,69,58,0.3)}.y{background:rgba(255,214,10,0.1);color:#FFD60A;border:1px solid rgba(255,214,10,0.25)}.n{background:rgba(255,255,255,0.06);color:rgba(235,235,245,0.6);border:1px solid rgba(255,255,255,0.08)}`;

function randomText(n, group) {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = crypto.getRandomValues(new Uint8Array(n));
  let t = "";
  for (let i = 0; i < n; i++) t += abc[b[i] % abc.length];
  return group ? t.match(new RegExp(`.{1,${group}}`, "g")).join("-") : t;
}
// Shown while no access key / password is set (only possible on Cloudflare: Node creates them). Reveals nothing.
function setupPage() {
  const box = "background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-top:14px";
  const code = (t) => `<code style="background:#0b0f1e;border:1px solid var(--line);border-radius:6px;padding:3px 7px;word-break:break-all;font-size:15px">${t}</code>`;
  const btn = (t) => `<button data-copy="${t}" style="margin-left:6px;background:var(--pri);color:#fff;border:0;border-radius:8px;padding:5px 10px;font:inherit;font-size:13px;cursor:pointer">Copy</button>`;
  const item = (name, value, type) => `<div style="${box}"><div style="color:var(--mut);font-size:13px">Variable name</div><div style="margin:3px 0 9px">${code(name)}${btn(name)}</div><div style="color:var(--mut);font-size:13px">Value (made just now, or type your own)</div><div style="margin:3px 0 9px">${code(value)}${btn(value)}</div><div style="color:var(--mut);font-size:13px">Type: <b style="color:var(--txt)">${type}</b></div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fast Combo · Setup</title><meta name="theme-color" content="#000"><style>${PAGE_CSS} li{margin:8px 0;line-height:1.6}</style></head>
<body><div class="w"><div class="hd"><img src="/logo.png" alt=""><div><h1>Fast Combo</h1><p class="sub">One step left — this copy has no access key and password yet.</p></div></div>
<div style="${box}"><b>1.</b> In Cloudflare open this Worker → <b>Settings</b> → <b>Variables and Secrets</b> → <b>+ Add</b>, and add these two (copy each box):</div>
${item("FC_ACCESS_KEY", randomText(12), "Secret")}${item("FC_ADMIN_PASSWORD", randomText(12, 4), "Secret")}
<div style="${box}"><b>2.</b> Press <b>Deploy</b>. <b>Save the password</b> somewhere safe.<br><b>3.</b> Open ${code("/YOUR-ACCESS-KEY/configure")} on this address (example: <span style="word-break:break-all">this-address/<b>abc123…</b>/configure</span>) and log in with the password.</div>
<div style="${box}"><b>Optional: live sync</b> (changes reach Stremio without reinstalling)<ol style="padding-left:20px;margin:6px 0 0"><li>This Worker → <b>Bindings</b> → <b>Add binding</b> → <b>KV namespace</b> (not D1 database).</li><li>Variable name ${code("FC_KV")}${btn("FC_KV")} (any name works). KV namespace: pick ${code("fastcombo")}, or type it and choose the one marked <b>new</b>.</li><li>Click <b>Add binding</b>: it goes live at once, no separate Deploy. Ignore any example code and the "Update your Wrangler configuration" message.</li></ol></div>
<p class="sub" style="margin-top:14px">On Node.js, Docker or a VPS you won't see this page: the key and password are created on the first start.</p>
</div><script>document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;var t=b.getAttribute("data-copy"),done=function(){b.textContent="Copied ✓";setTimeout(function(){b.textContent="Copy"},1500)};if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(t).then(done,function(){prompt("Copy this:",t)});else prompt("Copy this:",t)});</script></body></html>`;
}
function landingPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fast Combo</title><meta name="theme-color" content="#000"><style>${PAGE_CSS}</style></head>
<body><div class="w"><div class="hd"><img src="/logo.png" alt=""><div><h1>Fast Combo</h1><p class="sub">This Stremio addon server is running. Open your private link to install it or manage your addons.</p></div></div></div></body></html>`;
}

// ---------------------------------------------------------- control panel API

// Update endpoint — triggers a self-update (git pull + restart)
async function handleUpdate(req, env, token, key) {
  try {
    const platform = detectPlatform();
    const log = [];
    
    log.push(`Detected platform: ${platform}`);
    
    if (platform === 'vps') {
      log.push('Running install.sh --update...');
      const result = await execAsync('bash /opt/fastcombo/install.sh --update', { timeout: 120000 });
      log.push(result.stdout || '');
      if (result.stderr) log.push(result.stderr);
    } else if (platform === 'docker') {
      log.push('Pulling latest code...');
      await execAsync('git pull origin main', { timeout: 30000 });
      log.push('Building new image...');
      await execAsync('docker build -t fast-combo .', { timeout: 120000 });
      log.push('Restarting container...');
      await execAsync('docker rm -f fastcombo; docker run -d --name fastcombo --restart unless-stopped -p 7000:7000 -v fastcombo-data:/app/data fast-combo', { timeout: 30000 });
    } else {
      // Node.js
      log.push('Pulling latest code...');
      await execAsync('git pull origin main', { timeout: 30000 });
      log.push('Installing dependencies...');
      await execAsync('npm install', { timeout: 60000 });
      log.push('Restarting server...');
      
      // Graceful restart
      log.push('Update complete! Server will restart in 5 seconds...');
      setTimeout(() => {
        process.exit(0);
      }, 5000);
    }
    
    return jsonResponse({ ok: true, message: 'Update successful! Server restarting...', log: log.join('\n') });
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message }, 500);
  }
}

function detectPlatform() {
  if (typeof process !== 'undefined' && process.env?.FC_RUNNING_IN_DOCKER === '1') return 'docker';
  if (typeof process !== 'undefined' && process.env?.FC_RUNNING_ON_VPS === '1') return 'vps';
  return 'node';
}

function execAsync(cmd, opts = {}) {
  const { exec } = require('child_process');
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: opts.timeout || 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Command failed: ${error.message}\n${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function safeEqual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isAdmin(request) {
  const k = safeDecode(request.headers.get("x-admin-key") || "");
  if (k && RT.ADMIN_PASSWORD && safeEqual(k, RT.ADMIN_PASSWORD)) return true;
  await sleep(600); // slows down password guessing
  return false;
}
async function readBody(request) {
  try { const t = await request.text(); return t.length > 60000 ? null : JSON.parse(t); } catch { return null; }
}

async function profileView(env, P) {
  // Only fetch a manifest for addons that are switched on; for the off ones use whatever is
  // already cached (no network), so the panel doesn't ping addons you've disabled.
  const ms = await Promise.all(P.addons.map((a) => (a.on ? withTimeout(getManifest(a), 5000, null) : Promise.resolve(C.manifest.get(a.url)))));
  return {
    ok: true, version: VERSION, storage: !!(env && env.FC_KV), from: P.from, badToken: !!P.badToken,
    addons: P.addons.map((a, i) => ({ ...a, logo: (ms[i] && typeof ms[i].logo === "string" && ms[i].logo) || "", version: (ms[i] && String(ms[i].version || "")) || "" })),
    settings: cleanSettings(P.settings), defaults: { ...RT.DEFAULTS }, maxAddons: RT.MAX_ADDONS,
  };
}

const SAMPLES = [
  ["movie", "tt1375666", "Inception"], ["series", "tt0903747:1:1", "Breaking Bad S01E01"],
  ["series", "kitsu:7442:1", "Attack on Titan E01"], ["anime", "kitsu:7442:1", "Attack on Titan E01"],
];
/** Opens an addon link, checks it is a Stremio addon, runs a test search and tries a few links. */
async function inspectAddon(raw, P) {
  const url = cleanAddonUrl(raw);
  if (!url) return { ok: false, error: "Paste the full addon link. It usually ends with /manifest.json (stremio:// links work too)." };
  const t0 = Date.now();
  let m;
  try { m = (await fetchJSONRetry(url, 10000)).data; }
  catch (e) { return { ok: false, url, error: `Couldn't open it (${e.message}). Check the link, or the addon may be down right now — try again in a minute.` }; }
  const manifestMs = Date.now() - t0;
  if (!m || typeof m !== "object" || !m.id || !Array.isArray(m.resources)) return { ok: false, url, error: "The link opens, but it isn't a Stremio addon (no manifest found)." };
  if (String(m.id).startsWith("community.fastcombo.")) return { ok: false, url, error: "That's a Fast Combo link. Add the original addons instead." };
  C.manifest.set(url, m, 6 * 3600e3);
  goodManifest.set(url, m);
  const name = String(m.name || "Addon").replace(/\s+/g, " ").trim().slice(0, 40) || "Addon";
  const resources = [...new Set(m.resources.map((r) => (typeof r === "string" ? r : r && r.name)).filter((x) => typeof x === "string"))];
  const aid = addonId(url);
  const warnings = [];
  if (m.behaviorHints && m.behaviorHints.configurationRequired) warnings.push("This addon must be set up on its own website first. Configure it there, then paste the link it gives you.");
  if (!resources.includes("stream")) warnings.push("It has no streams (only " + (resources.join(", ") || "nothing") + "). Its catalogs and subtitles are still passed through.");
  const twins = P.addons.filter((a) => a.id !== aid && (C.manifest.get(a.url) || {}).id === m.id).map((a) => a.name);
  if (twins.length) warnings.push(`You already have ${twins.join(", ")}: the same addon with a different setup. Duplicate files are merged, but it doubles the work.`);
  let sample = null;
  const pick = SAMPLES.find(([t, id]) => supports(m, "stream", t, id));
  if (pick) {
    const [type, sid, label] = pick;
    const t1 = Date.now();
    try {
      const { data } = await fetchJSONRetry(`${upBase({ url })}/stream/${type}/${sid}.json`, 15000);
      const list = Array.isArray(data && data.streams) ? data.streams.slice(0, RT.MAX_STREAMS_PER_ADDON) : [];
      sample = { label, ms: Date.now() - t1, total: list.length, hd: 0, uhd: 0, p2p: 0, direct: 0, linksOk: 0, linksTested: 0, linksMs: 0 };
      const X = { live: false, runtime: defaultRuntime(type, sid), now: Date.now(), meta: {}, id: sid, type };
      const cands = [];
      for (const st of list) {
        const c = parseQuick(st, name, X);
        if (!c) continue;
        if (c.isTorrent) sample.p2p++; else sample.direct++;
        if (c.junk) continue;
        if (c.res >= 2160) sample.uhd++; else if (c.res >= 1080) sample.hd++;
        if (!c.isTorrent && c.res >= 1080 && !c.notReady && cands.length < 3) cands.push(enrich(c, X));
      }
      const tested = await Promise.all(cands.filter((c) => !c.isDebrid).map((c) => probe(c, 4000).catch(() => ({ ok: false }))));
      sample.linksTested = tested.length;
      sample.linksOk = tested.filter((r) => r.ok).length;
      const fast = tested.filter((r) => r.ok).map((r) => r.ttfb);
      sample.linksMs = fast.length ? Math.min(...fast) : 0;
      if (sample.p2p && !sample.direct) warnings.push("Its streams are torrents (P2P). They play in Stremio but usually start slower than direct links.");
      if (!list.length) warnings.push(`It answered, but found no streams for ${label}. It may need configuring, or it covers other content.`);
    } catch (e) {
      sample = { label, ms: Date.now() - t1, error: String(e.message || e) };
      warnings.push(`The test search (${label}) failed: ${sample.error}`);
    }
  } else if ((m.types || []).includes("tv")) warnings.push("Live TV addon: its channels are passed through as they are (no quality filter).");
  return {
    ok: true, url, aid, mid: String(m.id), name, version: String(m.version || ""), description: String(m.description || "").slice(0, 300),
    logo: typeof m.logo === "string" ? m.logo : "", types: (m.types || []).filter((t) => typeof t === "string").slice(0, 8),
    resources, catalogs: (m.catalogs || []).length, manifestMs, sample, warnings,
  };
}

async function healthView(env, P, ping) {
  if (ping) await Promise.all(P.ups.map((a) => withTimeout(getManifest(a, true), 9000, null)));
  const now = Date.now();
  const addons = P.addons.map((a) => {
    const h = upHealth.get(a.url), m = C.manifest.get(a.url);
    let status = "unknown";
    if (!a.on) status = "off";
    else if (h) {
      if (h.downUntil > now || (h.consec && !h.lastOkAt)) status = "down";
      else if (h.consec) status = "failing";
      else if (h.avgMs > 6000) status = "slow";
      else if (h.ok) status = "working";
    }
    return {
      id: a.id, name: a.name, on: a.on, logo: (m && typeof m.logo === "string" && m.logo) || "", status,
      avgMs: h ? h.avgMs : 0, lastMs: h ? h.lastMs : 0, pingMs: h ? h.pingMs : 0, ok: h ? h.ok : 0, fail: h ? h.fail : 0,
      lastErr: h && h.consec ? h.lastErr : "", lastCount: h ? h.lastCount : null, lastOkAt: h ? h.lastOkAt : 0,
      pausedMin: h && h.downUntil > now ? Math.ceil((h.downUntil - now) / 60000) : 0,
    };
  });
  const hosts = [...kinds.entries()].filter(([, st]) => now - st.t < 30 * 60e3).map(([k, st]) => {
    const n = st.ok + st.fail + st.slow;
    const status = kindBad(k) || (st.ok === 0 && st.fail > 0) ? "failing" : st.ok === 0 && st.slow > 0 ? "slow" : st.ok / Math.max(1, n) >= 0.7 ? "good" : "mixed";
    return { host: hostLabel(k), status, ok: Math.round(st.ok), fail: Math.round(st.fail), slow: Math.round(st.slow), avgMs: st.ok ? Math.round(st.ms / st.ok) : 0 };
  }).sort((a, b) => b.ok + b.fail + b.slow - (a.ok + a.fail + a.slow));
  return {
    ok: true, version: VERSION, storage: !!(env && env.FC_KV), now, upSince: STARTED || now, fresh: RT.FRESH_SECONDS,
    addons, hosts, recent: recent.slice(0, 20), cache: { titles: C.streams.size, links: C.probe.size },
  };
}

async function searchTitles(q) {
  q = String(q || "").trim().slice(0, 80);
  if (!q) return { ok: true, metas: [] };
  const key = "search:" + q.toLowerCase();
  const hit = C.catalog.get(key);
  if (hit) return hit;
  const lists = await Promise.all(["movie", "series"].map(async (t) => {
    try {
      const { data } = await fetchJSON(`https://v3-cinemeta.strem.io/catalog/${t}/top/search=${encodeURIComponent(q)}.json`, 7000);
      return ((data && data.metas) || []).slice(0, 10).map((m) => ({
        id: m.imdb_id || m.id, type: t, name: String(m.name || ""), year: String(m.releaseInfo || m.year || "").slice(0, 9), poster: typeof m.poster === "string" ? m.poster : "",
      })).filter((m) => /^tt\d+$/.test(m.id || ""));
    } catch { return []; }
  }));
  const metas = [];
  for (let i = 0; i < 10; i++) for (const l of lists) if (l[i]) metas.push(l[i]);
  const out = { ok: true, metas: metas.slice(0, 16) };
  C.catalog.set(key, out, 3600e3);
  return out;
}
/** Looks up an IMDb id on Cinemeta: movie or series, name, poster and the episode list. */
async function titleInfo(id) {
  if (!/^tt\d{5,10}$/.test(id)) return { ok: false, error: "That doesn't look like an IMDb id (like tt1375666)." };
  const key = "title:" + id;
  const hit = C.meta.get(key);
  if (hit) return hit;
  let out = { ok: false, error: "Title not found on Cinemeta." };
  for (const t of ["series", "movie"]) { // Cinemeta answers only for the right type
    try {
      const { data } = await fetchJSON(`https://v3-cinemeta.strem.io/meta/${t}/${id}.json`, 7000);
      const m = data && data.meta;
      if (!m || !m.name) continue;
      const eps = t !== "series" ? [] : (m.videos || []).filter((v) => v.season > 0 && v.episode > 0)
        .map((v) => [+v.season, +v.episode, String(v.name || v.title || "").slice(0, 60)])
        .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      out = { ok: true, id, type: t, name: String(m.name), year: String(m.releaseInfo || m.year || "").slice(0, 9), poster: typeof m.poster === "string" ? m.poster : "", eps };
      break;
    } catch {}
  }
  C.meta.set(key, out, out.ok ? 6 * 3600e3 : 10 * 60e3);
  return out;
}

// --------------------------------------------- 🤖 AI addon finder (opt-in)
// Searches Stremio's public community catalog, ranks candidates by installs, live-tests the top
// ones (real 1080p / 4K + working links) and, if FC_LLM_API_KEY is set, lets a small LLM make the
// final pick with a one-line reason. Nothing is added automatically: the panel shows a ranked
// shortlist and you press "Add". Off by default until you open the tab and press the button.
const AI_CATALOG_DEFAULT = "https://api.strem.io/addons/";
const aiCatalogUrl = () => RT.AI_CATALOG || AI_CATALOG_DEFAULT;

async function fetchAiCatalog() {
  const hit = C.ai.get("cat");
  if (hit) return hit;
  let data;
  try { ({ data } = await fetchJSON(aiCatalogUrl(), 12000)); }
  catch { throw new Error("couldn't reach the community catalog (" + aiCatalogUrl() + ") — check your internet connection and try again in a moment"); }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.addons) ? data.addons : null;
  if (!list) throw new Error("the community catalog (" + aiCatalogUrl() + ") didn't answer with a list");
  C.ai.set("cat", list, 5 * 60e3);
  return list;
}
const aiRatingOf = (r) => (typeof r === "number" ? r : r && typeof r === "object" ? Number(r.average ?? r.score ?? r.rating) || 0 : 0);
const aiDownloadsOf = (d) => { const n = Number(d); return isFinite(n) ? Math.max(0, n) : 0; };

/** Deterministic "small AI" score from the catalog's public stats plus the search query. */
function aiScoreCatalog(item, q) {
  let s = 0;
  const why = [];
  const dl = aiDownloadsOf(item.downloads);
  if (dl) { s += Math.min(45, Math.round(Math.sqrt(dl) / 4)); why.push((dl >= 1000 ? Math.round(dl / 1000) + "k" : dl) + " installs"); }
  const rt = aiRatingOf(item.rating);
  if (rt) { s += Math.min(20, Math.round(rt * 4)); why.push(rt.toFixed(1) + "★"); }
  const text = (String(item.name || "") + " " + String(item.description || "") + " " + String(item.id || "")).toLowerCase();
  const res = Array.isArray(item.resources) ? item.resources : [];
  if (res.some((r) => (typeof r === "string" ? r : r && r.name) === "stream")) s += 8; // it actually provides streams
  if (q) {
    const words = q.split(/[\s,]+/).filter(Boolean);
    const hit = words.filter((w) => text.includes(w.toLowerCase()));
    if (hit.length) { s += 25 + hit.length * 10; why.push("matches " + hit.join(", ")); }
    else s -= 40; // asked for something it doesn't mention
  }
  return { s, why, match: q ? !!why.some((w) => w.startsWith("matches")) : true };
}

/** Re-score once we have a live test (from inspectAddon): 4K/1080p found + links that start. */
function aiScoreLive(base, live) {
  let s = base.s;
  const why = [...base.why];
  const uhd = live.uhd || 0, hd = live.hd || 0;
  if (uhd) { s += 14; why.push(uhd + " in 4K"); }
  if (hd) { s += 8; why.push(hd + " in 1080p"); }
  if (!uhd && !hd) s -= 15;
  if (live.linksTested) { s += Math.round((live.linksOk / live.linksTested) * 15); why.push(live.linksOk + "/" + live.linksTested + " links start"); }
  if (live.direct && !live.p2p) s += 4;
  if (live.ms > 9000) s -= 6;
  return { s, why };
}

/** Optional: let a small LLM (any OpenAI-compatible endpoint) make the final pick. */
async function aiAskLlm(cands) {
  if (!RT.LLM_API_KEY) return null;
  const base = RT.LLM_BASE_URL || "https://api.openai.com/v1";
  const model = RT.LLM_MODEL || "gpt-4o-mini";
  const rows = cands.map((c) =>
    c._i + ". " + c.name + " — installs:" + (c.downloads || 0) + " rating:" + (c.rating || 0) +
    (c.live && !c.live.error ? " 4k:" + (c.live.uhd || 0) + " 1080p:" + (c.live.hd || 0) + " links " + (c.live.linksOk || 0) + "/" + (c.live.linksTested || 0)
      : c.live && c.live.error ? " test-failed" : " not-tested") +
    (c.description ? " — " + String(c.description).slice(0, 120) : "")
  ).join("\n");
  const prompt =
    "You are choosing which Stremio scraper addons to recommend, to give working 1080p/4K streams. " +
    "The list below is sorted by popularity only. Return ONLY a JSON object, no other text: " +
    "{\"add\":[indices of the best ones, at most 3, best first],\"order\":[all indices best-first],\"reason\":{\"<index>\":\"one short reason\"}}\n\n" + rows;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + RT.LLM_API_KEY },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    let txt = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").trim();
    txt = txt.replace(/^```(?:json)?/i, "").replace(/```/g, "").trim();
    const m = txt.indexOf("{"), e = txt.lastIndexOf("}");
    if (m < 0 || e < m) return null;
    const o = JSON.parse(txt.slice(m, e + 1));
    const idx = (a) => (Array.isArray(a) ? a.filter((x) => Number.isInteger(x) && x >= 0 && x < cands.length) : []);
    const reason = {};
    for (const c of cands) {
      const v = o.reason && o.reason[c._i];
      if (typeof v === "string" && v.trim()) reason[c._i] = v.trim().slice(0, 160);
    }
    return { model, add: idx(o.add).slice(0, 3), order: idx(o.order), reason };
  } catch { return null; }
}

async function aiFind(P, q, doTest) {
  q = String(q || "").trim().slice(0, 80);
  const list = await fetchAiCatalog();
  const haveUrl = new Set(P.addons.map((a) => a.url));
  const haveId = new Set(P.addons.map((a) => a.id));
  const cands = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (String(item.id || "").startsWith("community.fastcombo.")) continue; // skip Fast Combo itself
    const link = cleanAddonUrl(item.link);
    if (!link || haveUrl.has(link) || haveId.has(addonId(link))) continue;
    const sc = aiScoreCatalog(item, q);
    if (!sc.match) continue; // the query didn't match anything about it
    cands.push({
      url: link, aid: addonId(link),
      name: String(item.name || "Addon").replace(/\s+/g, " ").trim().slice(0, 40) || "Addon",
      downloads: aiDownloadsOf(item.downloads), rating: aiRatingOf(item.rating) || null,
      logo: typeof item.logo === "string" ? item.logo : "",
      description: String(item.description || "").slice(0, 200),
      version: String(item.version || ""),
      score: sc.s, why: sc.why,
    });
  }
  cands.sort((a, b) => b.score - a.score);
  const total = cands.length;
  let top = cands.slice(0, 12);
  top.forEach((c, i) => (c._i = i));
  if (doTest && top.length) {
    const N = Math.max(1, Math.min(Math.round(RT.AI_TEST_N || 3), top.length));
    await Promise.all(top.slice(0, N).map(async (c) => {
      const r = await inspectAddon(c.url, P).catch(() => null);
      if (r && r.ok && r.sample && !r.sample.error) { c.live = r.sample; const l = aiScoreLive({ s: c.score, why: c.why }, r.sample); c.score = l.s; c.why = l.why; }
      else c.live = { error: (r && r.error) || "couldn't test it right now" };
    }));
    top.sort((a, b) => b.score - a.score);
    top.forEach((c, i) => (c._i = i)); // renumber: _i is the order actually shown
  }
  let engine = "auto", llm = null;
  if (RT.LLM_API_KEY) {
    llm = await aiAskLlm(top.slice(0, 8));
    if (llm && llm.order && llm.order.length) {
      const byIdx = new Map(top.map((c) => [c._i, c]));
      const rank = llm.order.map((i) => byIdx.get(i)).filter(Boolean);
      top = rank.concat(top.filter((c) => !rank.includes(c)));
      for (const c of top) if (llm.reason[c._i]) c.reason = llm.reason[c._i];
      engine = "llm";
    } else engine = "auto"; // LLM didn't return usable data → keep the auto score
  }
  top = top.slice(0, 12);
  const candidates = top.map((c) => ({
    url: c.url, aid: c.aid, name: c.name, downloads: c.downloads, rating: c.rating,
    logo: c.logo, description: c.description, version: c.version, score: c.score, why: c.why,
    reason: c.reason || "", tested: !!c.live,
    live: c.live ? { hd: c.live.hd || 0, uhd: c.live.uhd || 0, p2p: c.live.p2p || 0, direct: c.live.direct || 0, linksOk: c.live.linksOk || 0, linksTested: c.live.linksTested || 0, linksMs: c.live.linksMs || 0, ms: c.live.ms || 0, error: c.live.error || "" } : null,
  }));
  const suggested = llm && llm.add && llm.add.length
    ? llm.add.map((i) => top.find((c) => c._i === i)).filter(Boolean).slice(0, 3).map((c) => c.url)
    : candidates.length ? [candidates[0].url] : [];
  return { ok: true, source: aiCatalogUrl(), engine, llm: llm ? { model: llm.model } : null, count: total, tested: !!doTest, best: candidates[0] || null, suggested, candidates };
}

async function apiHandler(request, env, ctx, P, parts) {
  if (!(await isAdmin(request))) return apiJson({ ok: false, error: "login" }, 401);
  const url = new URL(request.url);
  const name = parts[0];
  try {
    if (name === "profile") {
      if (request.method !== "POST") return apiJson(await profileView(env, P));
      const body = await readBody(request);
      if (!body || typeof body !== "object") return apiJson({ ok: false, error: "Bad request" }, 400);
      return apiJson(await saveProfile(env, body.addons, body.settings));
    }
    if (name === "inspect") {
      const body = await readBody(request);
      return apiJson(await inspectAddon(body && body.url, P));
    }
    if (name === "health") return apiJson(await healthView(env, P, url.searchParams.get("ping") === "1"));
    if (name === "search") return apiJson(await searchTitles(url.searchParams.get("q")));
    if (name === "title" || name === "episodes") return apiJson(await titleInfo(url.searchParams.get("id") || ""));
    if (name === "try") {
      const type = safeDecode(parts[1] || ""), id = safeDecode(parts[2] || "");
      if (!type || !id) return apiJson({ ok: false, error: "missing id" }, 400);
      const r = await streamHandler(type, id, P, request.headers.get("user-agent") || "", ctx, env, { fresh: url.searchParams.get("fresh") === "1" });
      return apiJson({ ok: true, streams: r.out.streams, report: r.report || null, cached: !!r.cached, age: Math.round((Date.now() - r.at) / 1000) });
    }
    if (name === "ai") {
      const q = String(url.searchParams.get("q") || "");
      const doTest = url.searchParams.get("test") === "1";
      return apiJson(await aiFind(P, q, doTest));
    }
    if (name === "update") {
      if (request.method !== "POST") return apiJson({ ok: false, error: "use POST" }, 405);
      return apiJson(await handleUpdate(request, env, token, key));
    }
    return apiJson({ ok: false, error: "not found" }, 404);
  } catch (e) {
    return apiJson({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}

// ==UI-START== control panel website (generated from ui/app.html by tools/embed_ui.py — edit that file)
const APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#000000">
<title>Fast Combo · Control Panel</title>
<link rel="icon" href="/logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
/* ===== APPLE-INSPIRED DESIGN SYSTEM ===== */
:root {
  --bg: #000000;
  --bg-secondary: #0a0a0a;
  --bg-tertiary: #111111;
  --bg-card: rgba(28, 28, 30, 0.72);
  --bg-card-hover: rgba(38, 38, 40, 0.8);
  --bg-elevated: rgba(44, 44, 46, 0.65);
  --bg-input: rgba(58, 58, 60, 0.45);
  --surface-glass: rgba(255, 255, 255, 0.04);
  --surface-glass-hover: rgba(255, 255, 255, 0.07);
  --border: rgba(255, 255, 255, 0.08);
  --border-hover: rgba(255, 255, 255, 0.15);
  --border-active: rgba(124, 108, 255, 0.5);
  --text-primary: #f5f5f7;
  --text-secondary: rgba(235, 235, 245, 0.6);
  --text-tertiary: rgba(235, 235, 245, 0.4);
  --text-placeholder: rgba(235, 235, 245, 0.3);
  --accent: #7C6CFF;
  --accent-2: #3D8BFD;
  --accent-gradient: linear-gradient(135deg, #7C6CFF, #3D8BFD, #00D4FF);
  --accent-gradient-subtle: linear-gradient(135deg, rgba(124,108,255,0.15), rgba(61,139,253,0.15));
  --green: #30D158;
  --green-bg: rgba(48, 209, 88, 0.12);
  --green-border: rgba(48, 209, 88, 0.3);
  --yellow: #FFD60A;
  --yellow-bg: rgba(255, 214, 10, 0.1);
  --yellow-border: rgba(255, 214, 10, 0.25);
  --red: #FF453A;
  --red-bg: rgba(255, 69, 58, 0.1);
  --red-border: rgba(255, 69, 58, 0.3);
  --blue: #0A84FF;
  --blue-bg: rgba(10, 132, 255, 0.12);
  --blue-border: rgba(10, 132, 255, 0.3);
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --radius-xl: 28px;
  --shadow-sm: 0 2px 8px rgba(0,0,0,0.3);
  --shadow-md: 0 8px 30px rgba(0,0,0,0.4);
  --shadow-lg: 0 20px 60px rgba(0,0,0,0.5);
  --shadow-glow: 0 0 40px rgba(124,108,255,0.15);
  --transition-fast: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-normal: 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-slow: 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  --font: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
*::before, *::after { box-sizing: border-box; }

html {
  background: var(--bg);
  -webkit-text-size-adjust: 100%;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  font-family: var(--font);
  color: var(--text-primary);
  line-height: 1.5;
  min-height: 100vh;
  overflow-x: hidden;
  background: var(--bg);
}

/* Ambient background effects */
body::before {
  content: '';
  position: fixed;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: 
    radial-gradient(ellipse 600px 400px at 20% 10%, rgba(124,108,255,0.08), transparent 60%),
    radial-gradient(ellipse 500px 350px at 80% 20%, rgba(61,139,253,0.06), transparent 60%),
    radial-gradient(ellipse 400px 300px at 50% 80%, rgba(0,212,255,0.04), transparent 60%);
  pointer-events: none;
  z-index: 0;
  animation: ambientShift 20s ease-in-out infinite alternate;
}

@keyframes ambientShift {
  0% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(-2%, 1%) scale(1.02); }
  100% { transform: translate(1%, -1%) scale(0.98); }
}

a { color: var(--accent); text-decoration: none; transition: color var(--transition-fast); }
a:hover { color: var(--accent-2); }

button, input, select { font-family: inherit; color: inherit; }

.hidden { display: none !important; }

/* ===== LAYOUT ===== */
.wrap {
  position: relative;
  z-index: 1;
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 20px 140px;
}

/* ===== HEADER ===== */
.top {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 0 32px;
}

.top .logo {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(124,108,255,0.25), 0 0 0 1px rgba(255,255,255,0.05);
  flex: none;
  transition: transform var(--transition-normal), box-shadow var(--transition-normal);
}

.top .logo:hover {
  transform: scale(1.05);
  box-shadow: 0 8px 30px rgba(124,108,255,0.35), 0 0 0 1px rgba(255,255,255,0.1);
}

.top h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 10px;
}

.top p {
  margin: 3px 0 0;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 400;
}

.top .right { margin-left: auto; }

.ver {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-gradient-subtle);
  border: 1px solid rgba(124,108,255,0.2);
  padding: 2px 8px;
  border-radius: 100px;
  letter-spacing: 0.02em;
}

/* ===== PILLS / BADGES ===== */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 100px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid transparent;
  letter-spacing: 0.01em;
}

.pill.g { background: var(--green-bg); color: #5BF58E; border-color: var(--green-border); }
.pill.y { background: var(--yellow-bg); color: #FFD60A; border-color: var(--yellow-border); }
.pill.r { background: var(--red-bg); color: #FF6961; border-color: var(--red-border); }
.pill.b { background: var(--blue-bg); color: #64B5FF; border-color: var(--blue-border); }
.pill.n { background: rgba(255,255,255,0.06); color: var(--text-secondary); border-color: var(--border); }

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

.pill.g .dot { animation: pulse 2s infinite; }

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(95,240,163,0.6); }
  70% { box-shadow: 0 0 0 6px rgba(95,240,163,0); }
  100% { box-shadow: 0 0 0 0 rgba(95,240,163,0); }
}

/* ===== TABS ===== */
.tabs {
  display: flex;
  gap: 2px;
  padding: 4px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  position: sticky;
  top: 12px;
  z-index: 20;
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  overflow-x: auto;
  scrollbar-width: none;
  box-shadow: var(--shadow-md);
}

.tabs::-webkit-scrollbar { display: none; }

.tabs button {
  flex: 1 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  background: none;
  color: var(--text-secondary);
  padding: 10px 16px;
  border-radius: var(--radius-md);
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--transition-normal);
  position: relative;
}

.tabs button:hover {
  color: var(--text-primary);
  background: var(--surface-glass-hover);
}

.tabs button.on {
  color: #fff;
  background: var(--accent-gradient);
  box-shadow: 0 4px 16px rgba(124,108,255,0.3), inset 0 1px 0 rgba(255,255,255,0.1);
}

.tabs button .ti {
  font-size: 16px;
  display: inline-flex;
}

/* ===== CARDS ===== */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 24px;
  margin: 20px 0;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--transition-normal), box-shadow var(--transition-normal);
}

.card:hover {
  border-color: var(--border-hover);
}

.card h2 {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.lead {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: 18px;
  font-weight: 400;
}

.card-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.card-h h2 { margin: 0; }

.mut { color: var(--text-secondary); }
.small { font-size: 13px; }
.center { text-align: center; }

/* ===== FORMS ===== */
.row { display: flex; gap: 10px; align-items: center; }

.field {
  flex: 1;
  min-width: 0;
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  outline: none;
  font-size: 15px;
  font-weight: 400;
  transition: all var(--transition-normal);
  color: var(--text-primary);
}

.field::placeholder { color: var(--text-placeholder); }

.field:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(124,108,255,0.15), 0 0 20px rgba(124,108,255,0.08);
  background: rgba(58, 58, 60, 0.6);
}

/* ===== BUTTONS ===== */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--border-hover);
  background: var(--bg-elevated);
  color: var(--text-primary);
  padding: 12px 20px;
  border-radius: var(--radius-md);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
  transition: all var(--transition-fast);
  position: relative;
  overflow: hidden;
}

.btn:hover {
  background: var(--surface-glass-hover);
  border-color: rgba(255,255,255,0.2);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

.btn:active { transform: translateY(0) scale(0.98); }

.btn:disabled { opacity: 0.4; cursor: default; transform: none; box-shadow: none; filter: none; }

.btn.pri {
  border: 0;
  background: var(--accent-gradient);
  color: #fff;
  box-shadow: 0 4px 16px rgba(124,108,255,0.3), inset 0 1px 0 rgba(255,255,255,0.15);
}

.btn.pri:hover {
  box-shadow: 0 6px 24px rgba(124,108,255,0.4), inset 0 1px 0 rgba(255,255,255,0.2);
  filter: brightness(1.08);
}

.btn.ok {
  border: 0;
  background: linear-gradient(135deg, #30D158, #0EA83C);
  color: #fff;
  box-shadow: 0 4px 16px rgba(48,209,88,0.25);
}

.btn.ok:hover {
  box-shadow: 0 6px 24px rgba(48,209,88,0.35);
  filter: brightness(1.08);
}

.btn.ghost {
  background: transparent;
  border-color: var(--border);
}

.btn.ghost:hover { background: var(--surface-glass); }

.btn.sm { padding: 8px 14px; font-size: 13px; border-radius: var(--radius-sm); }

.btn.danger {
  color: #FF6961;
  border-color: var(--red-border);
  background: var(--red-bg);
}

.btn.danger:hover {
  background: rgba(255, 69, 58, 0.18);
  border-color: rgba(255, 69, 58, 0.5);
}

.ib {
  width: 36px;
  height: 36px;
  display: inline-grid;
  place-items: center;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  flex: none;
  transition: all var(--transition-fast);
}

.ib:hover { color: var(--text-primary); border-color: var(--accent); background: var(--surface-glass-hover); }
.ib:disabled { opacity: 0.25; cursor: default; }

.hint { color: var(--text-tertiary); font-size: 12.5px; margin: 12px 4px 0; }

/* ===== ADDON CARDS ===== */
.addon {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-glass);
  margin-top: 12px;
  transition: all var(--transition-normal);
}

.addon:hover {
  border-color: var(--border-hover);
  background: var(--bg-card-hover);
  box-shadow: var(--shadow-sm);
}

.addon.off { opacity: 0.5; }

.alogo {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  object-fit: cover;
  background: var(--bg-input);
  flex: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}

.ainfo { flex: 1; min-width: 200px; }

.aname {
  font-weight: 700;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.aurl {
  color: var(--text-tertiary);
  font: 12px var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 3px;
  max-width: 520px;
}

.astats {
  color: var(--text-secondary);
  font-size: 12.5px;
  margin-top: 5px;
  display: flex;
  gap: 4px 16px;
  flex-wrap: wrap;
}

.aerr { color: #FF6961; font-size: 12.5px; margin-top: 5px; }

.actl { display: flex; gap: 8px; align-items: center; flex: none; }

.amore {
  flex-basis: 100%;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.sel {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color var(--transition-fast);
}

.sel:hover { border-color: var(--border-hover); }

/* ===== SWITCH TOGGLE ===== */
.switch { position: relative; width: 46px; height: 28px; flex: none; display: inline-block; }
.switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.switch span {
  position: absolute;
  inset: 0;
  background: rgba(120, 120, 128, 0.32);
  border-radius: 99px;
  cursor: pointer;
  transition: background var(--transition-normal);
}
.switch span:before {
  content: "";
  position: absolute;
  width: 22px;
  height: 22px;
  left: 3px;
  top: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform var(--transition-normal);
  box-shadow: 0 2px 6px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
}
.switch input:checked + span { background: var(--green); }
.switch input:checked + span:before { transform: translateX(18px); }
.switch input:focus-visible + span { box-shadow: 0 0 0 3px rgba(124,108,255,0.5); }

/* ===== EMPTY STATE ===== */
.empty {
  padding: 40px 24px;
  text-align: center;
  color: var(--text-secondary);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  margin-top: 14px;
  font-size: 14px;
}

/* ===== PREVIEW / INSPECT ===== */
.preview {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 20px;
  background: var(--surface-glass);
  backdrop-filter: blur(20px);
  animation: slideUp 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

.pv-h { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.pv-h img {
  width: 60px;
  height: 60px;
  border-radius: 16px;
  object-fit: cover;
  background: var(--bg-input);
  flex: none;
  box-shadow: var(--shadow-sm);
}
.pv-h h3 { font-size: 18px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.pv-desc {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 6px 0 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.chip {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 100px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-weight: 500;
}
.chip.on {
  background: var(--accent-gradient-subtle);
  border-color: rgba(124,108,255,0.4);
  color: #fff;
}

/* ===== KEY-VALUE STATS ===== */
.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.kv div {
  background: var(--surface-glass);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  transition: border-color var(--transition-fast);
}

.kv div:hover { border-color: var(--border-hover); }

.kv b {
  display: block;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: var(--accent-gradient);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.kv span { color: var(--text-secondary); font-size: 12px; font-weight: 500; }

/* ===== ALERT BOXES ===== */
.warn, .err, .okbox {
  margin-top: 14px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
}

.warn { background: var(--yellow-bg); border: 1px solid var(--yellow-border); color: #FFE066; }
.err { background: var(--red-bg); border: 1px solid var(--red-border); color: #FF8A82; }
.okbox { background: var(--green-bg); border: 1px solid var(--green-border); color: #7BF0A8; }

/* ===== LOADING ===== */
.loading { display: flex; align-items: center; gap: 14px; color: var(--text-secondary); margin-top: 16px; }

.spin {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2.5px solid rgba(255,255,255,0.1);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
  flex: none;
  display: inline-block;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* ===== SETTINGS ===== */
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }

.opt {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--surface-glass);
  transition: all var(--transition-fast);
}

.opt:hover { border-color: var(--border-hover); background: var(--bg-card-hover); }

.opt.on {
  border-color: var(--border-active);
  background: var(--accent-gradient-subtle);
  box-shadow: inset 0 0 0 1px rgba(124,108,255,0.1);
}

.opt input { margin-top: 4px; accent-color: var(--accent); transform: scale(1.2); }
.opt b { display: block; font-size: 14.5px; font-weight: 600; }
.opt span { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }

.lbl { display: block; font-size: 13px; color: var(--text-secondary); margin: 0 0 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.select {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color var(--transition-fast);
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 14px center;
  padding-right: 36px;
}

.select:hover { border-color: var(--border-hover); }
.select:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px rgba(124,108,255,0.15); }

/* ===== TOGGLE ROWS ===== */
.tg {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 2px;
  border-top: 1px solid var(--border);
}
.tg:first-of-type { border-top: 0; }
.tg b { display: block; font-size: 15px; font-weight: 600; }
.tg span { color: var(--text-secondary); font-size: 13px; }

/* ===== LANGUAGE SELECTORS ===== */
.langs { display: flex; flex-wrap: wrap; gap: 8px; }
.langs button {
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border-radius: 100px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.langs button:hover { border-color: var(--border-hover); color: var(--text-primary); }
.langs button.on {
  background: var(--accent-gradient);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 2px 10px rgba(124,108,255,0.3);
}

/* ===== SEARCH RESULTS TILES ===== */
.results {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.tile {
  background: var(--surface-glass);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: pointer;
  transition: all var(--transition-normal);
  text-align: left;
  padding: 0;
  color: var(--text-primary);
}

.tile:hover { transform: translateY(-3px); border-color: var(--border-hover); box-shadow: var(--shadow-md); }
.tile.sel { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(124,108,255,0.3), var(--shadow-md); }

.tile .ph {
  aspect-ratio: 2/3;
  background: var(--bg-input);
  display: grid;
  place-items: center;
  color: var(--text-tertiary);
  font-size: 28px;
  position: relative;
  overflow: hidden;
}

.tile .ph img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.tile .tt { padding: 10px 12px 12px; font-size: 13px; line-height: 1.3; }
.tile .tt b { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile .tt span { color: var(--text-tertiary); font-size: 12px; }

/* ===== PICKED TITLE ===== */
.picked {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-glass);
  animation: slideUp 0.3s ease;
}

.picked img {
  width: 48px;
  height: 72px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  box-shadow: var(--shadow-sm);
}

/* ===== STREAM CARDS ===== */
.stream {
  display: grid;
  grid-template-columns: 120px 1fr auto;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-glass);
  margin-top: 12px;
  align-items: start;
  transition: all var(--transition-fast);
}

.stream:hover { border-color: var(--border-hover); background: var(--bg-card-hover); }

.stream.new {
  border-color: var(--green-border);
  box-shadow: inset 3px 0 0 var(--green);
}

.sname { white-space: pre-line; font-weight: 800; font-size: 15px; line-height: 1.4; }
.sdesc { white-space: pre-line; font-size: 13px; color: var(--text-secondary); line-height: 1.6; min-width: 0; overflow-wrap: anywhere; }
.sum { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }

/* ===== BARS ===== */
.bars { margin-top: 12px; display: grid; gap: 8px; }
.bar {
  display: grid;
  grid-template-columns: minmax(120px, 260px) 1fr 40px;
  gap: 12px;
  align-items: center;
  font-size: 13px;
  color: var(--text-secondary);
}
.bar i { display: block; height: 6px; border-radius: 99px; background: var(--accent-gradient); }
.bar b { text-align: right; color: var(--text-primary); font-weight: 600; }

/* ===== TABLES ===== */
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--text-tertiary); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; }
td.sub { color: var(--text-tertiary); font-size: 12px; }
.tw { overflow-x: auto; -webkit-overflow-scrolling: touch; }

/* ===== STAT TILES ===== */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-top: 8px; }

.stat {
  background: var(--surface-glass);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 18px;
  transition: all var(--transition-fast);
}

.stat:hover { border-color: var(--border-hover); background: var(--bg-card-hover); }

.stat b {
  display: block;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: var(--accent-gradient);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.stat span { color: var(--text-secondary); font-size: 13px; font-weight: 500; }

/* ===== LINK BOX ===== */
.linkbox {
  background: rgba(0,0,0,0.4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  font: 13px var(--font-mono);
  word-break: break-all;
  color: #A0AEFF;
}

/* ===== BUTTON GROUPS ===== */
.btns { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }

/* ===== STEPS ===== */
.steps { margin: 10px 0 0; padding-left: 22px; color: var(--text-secondary); font-size: 14px; line-height: 1.6; }
.steps li { margin: 8px 0; }

code {
  font: 13px var(--font-mono);
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: 6px;
}

details summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 14px;
  margin-top: 14px;
  font-weight: 600;
  transition: color var(--transition-fast);
}
details summary:hover { color: var(--text-primary); }

/* ===== SAVE BAR ===== */
.savebar {
  position: fixed;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 10px 10px 20px;
  background: rgba(28, 28, 30, 0.95);
  border: 1px solid var(--border-active);
  border-radius: var(--radius-xl);
  box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 40px rgba(124,108,255,0.1);
  z-index: 40;
  max-width: calc(100% - 28px);
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  animation: slideUp 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.savebar span { font-weight: 600; font-size: 14px; margin-right: 8px; white-space: nowrap; }

/* ===== TOAST ===== */
.toast {
  position: fixed;
  left: 50%;
  top: 20px;
  transform: translateX(-50%) translateY(-20px);
  opacity: 0;
  pointer-events: none;
  background: rgba(28, 28, 30, 0.95);
  border: 1px solid var(--border);
  padding: 12px 20px;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: 60;
  transition: opacity var(--transition-normal), transform var(--transition-normal);
  font-weight: 600;
  font-size: 14px;
  max-width: calc(100% - 28px);
  backdrop-filter: blur(40px);
  -webkit-backdrop-filter: blur(40px);
}

.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.ok { border-color: var(--green-border); }
.toast.bad { border-color: var(--red-border); }

/* ===== LOGIN ===== */
.narrow { max-width: 400px; margin: 60px auto; }

.login-logo {
  display: block;
  width: 80px;
  height: 80px;
  border-radius: 22px;
  margin: 0 auto 20px;
  box-shadow: 0 12px 40px rgba(124,108,255,0.35), 0 0 0 1px rgba(255,255,255,0.05);
}

.foot {
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: center;
  margin-top: 40px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}

/* ===== RESPONSIVE ===== */
@media (max-width: 560px) {
  .tabs { gap: 2px; padding: 3px; }
  .tabs button { flex: 1 1 0; flex-direction: column; gap: 2px; padding: 8px 4px; font-size: 11px; line-height: 1.2; }
  .tabs .ti { font-size: 18px; }
  .top .ver { display: none; }
  .top h1 { white-space: nowrap; font-size: 20px; }
  .wrap { padding-left: 14px; padding-right: 14px; }
  .tiles, .kv { grid-template-columns: 1fr 1fr; }
  .stat b, .kv b { font-size: 20px; }
  .card { padding: 18px; border-radius: var(--radius-lg); }
}

@media (max-width: 720px) {
  .grid2 { grid-template-columns: 1fr; }
  .actl { width: 100%; justify-content: flex-end; }
  .stream { grid-template-columns: 1fr; }
  .top h1 { font-size: 20px; }
  .top p { display: none; }
  .bar { grid-template-columns: 110px 1fr 30px; }
  .savebar span { display: none; }
}

/* ===== SCROLLBAR ===== */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

/* ===== SELECTION ===== */
::selection { background: rgba(124,108,255,0.3); color: #fff; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <img class="logo" src="/logo.png" alt="">
    <div><h1>Fast Combo <span class="ver" id="ver"></span></h1><p>Your addons in one — only working, fast 1080p &amp; 4K streams</p></div>
    <div class="right"><span id="live" class="pill n"><span class="dot"></span>Connecting…</span></div>
  </header>

  <section id="login" class="card narrow center hidden">
    <img class="login-logo" src="/logo.png" alt="">
    <h2 style="justify-content:center">Control Panel</h2>
    <p class="lead">Enter your admin password to manage your addons.</p>
    <form id="loginForm">
      <input id="pass" class="field" type="password" placeholder="Admin password" autocomplete="current-password">
      <label class="row small mut" style="justify-content:center;margin:14px 0;gap:8px"><input type="checkbox" id="remember" checked> Remember on this device</label>
      <button class="btn pri" type="submit" style="width:100%">Unlock</button>
    </form>
    <div id="loginErr" class="err hidden"></div>
  </section>

  <main id="app" class="hidden">
    <nav class="tabs" id="tabs">
      <button type="button" data-tab="addons"><span class="ti">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
      </span>Addons</button>
      <button type="button" data-tab="ai"><span class="ti">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      </span>AI Best</button>
      <button type="button" data-tab="settings"><span class="ti">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
      </span>Settings</button>
      <button type="button" data-tab="try"><span class="ti">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      </span>Try It</button>
      <button type="button" data-tab="health"><span class="ti">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
      </span>Health</button>
      <button type="button" data-tab="install"><span class="ti">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </span>Install</button>
    </nav>

    <section data-pane="addons">
      <div class="card">
        <h2>Add an Addon</h2>
        <p class="lead">Paste the install link of a Stremio addon you use. It is tested live before it is added.</p>
        <form id="addForm" class="row">
          <input id="addUrl" class="field" placeholder="https://…/manifest.json  or  stremio://…" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="btn pri" id="addBtn" type="submit">Check</button>
        </form>
        <div id="inspect"></div>
      </div>
      <div class="card">
        <div class="card-h"><h2>Your Addons</h2><span class="mut small" id="addonCount"></span></div>
        <p class="lead">All switched-on addons are asked at the same time. Dead or slow ones are skipped automatically and retried later. <b>Priority</b> decides which addon's link wins when two have the same file.</p>
        <div id="addonList"></div>
      </div>
    </section>

    <section data-pane="ai" class="hidden">
      <div class="card">
        <h2>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="url(#grad1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#7C6CFF"/><stop offset="100%" style="stop-color:#00D4FF"/></linearGradient></defs><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          AI: Find the Best Addon
        </h2>
        <p class="lead">Searches Stremio's public community catalog for scrapers and ranks them by installs — answers in about a second. Tick <b>live-test</b> to also verify the top ones have real 1080p / 4K + working links (more accurate, ~10-25s). <b>Nothing is added until you press Add.</b></p>
        <form id="aiForm" class="row" style="align-items:flex-end">
          <div style="flex:1;min-width:0"><label class="lbl">What do you want?</label><input id="aiQ" class="field" placeholder="e.g. 4k, anime, torbox, subtitles — or leave empty for the best overall" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
          <button class="btn pri" id="aiBtn" type="submit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            Find Best
          </button>
        </form>
        <label class="row small mut" style="gap:8px;margin-top:14px"><input type="checkbox" id="aiTest"> Live-test the top candidates for accuracy (off by default — adds ~10-25s)</label>
        <div id="aiOut"></div>
      </div>
    </section>

    <section data-pane="settings" class="hidden"><div id="settingsBody"></div></section>

    <section data-pane="try" class="hidden">
      <div class="card">
        <h2>Try It</h2>
        <p class="lead">See exactly what Stremio will get for any movie or episode, and why other streams were removed.</p>
        <form id="searchForm" class="row">
          <input id="q" class="field" placeholder="Search a movie or series… (or paste an ID like tt1375666)" autocomplete="off">
          <button class="btn pri" type="submit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            Search
          </button>
        </form>
        <div id="results"></div>
        <div id="picked"></div>
      </div>
      <div id="tryOut"></div>
    </section>

    <section data-pane="health" class="hidden">
      <div class="card">
        <div class="card-h"><h2>Live Health</h2><div class="row"><label class="row small mut" style="gap:6px"><input type="checkbox" id="autoH" checked> Auto-refresh</label><button type="button" class="btn sm" id="pingBtn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          Check Now
        </button></div></div>
        <div class="tiles" id="hTiles"></div>
        <p class="hint" id="hNote"></p>
      </div>
      <div class="card">
        <h2>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="url(#grad3)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="grad3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#7C6CFF"/><stop offset="100%" style="stop-color:#00D4FF"/></linearGradient></defs><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
          Update Fast Combo
        </h2>
        <p class="lead">Pull the latest code from GitHub and restart the server. Your addons and settings stay intact.</p>
        <div id="updateOut"></div>
        <button type="button" class="btn pri" id="updateBtn" style="width:100%;padding:14px;font-size:15px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-6.219-8.56"/><polyline points="21 3 21 9 15 9"/></svg>
          Check for Updates
        </button>
      </div>
      <div class="card"><h2>Addons</h2><div class="tw" id="hAddons"></div></div>
      <div class="card"><h2>File Hosts</h2><p class="lead">From live link tests in the last 30 minutes. Failing hosts are skipped automatically.</p><div class="tw" id="hHosts"></div></div>
      <div class="card"><h2>Recent Requests</h2><div class="tw" id="hRecent"></div></div>
    </section>

    <section data-pane="install" class="hidden">
      <div class="card">
        <h2>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="url(#grad2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="grad2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#7C6CFF"/><stop offset="100%" style="stop-color:#00D4FF"/></linearGradient></defs><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Install in Stremio
        </h2>
        <div id="installNote" class="okbox hidden">Your addon list is inside this new link. Remove the old Fast Combo in Stremio, then install this one.</div>
        <div class="linkbox" id="instLink" style="margin-top:14px"></div>
        <div class="btns">
          <a class="btn pri" id="instApp" href="#">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
            Install in Stremio
          </a>
          <a class="btn" id="instWeb" href="#" target="_blank" rel="noopener">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
            Stremio Web
          </a>
          <button type="button" class="btn" id="instCopy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Copy Link
          </button>
        </div>
        <p class="hint">Keep this link private — it uses your addons.</p>
      </div>
      <div class="card" id="modeCard"></div>
    </section>
    <p class="foot">Fast Combo <span id="ver2"></span> — uses only the addons you add — <a href="#health">health</a></p>
  </main>

  <div id="saveBar" class="savebar hidden"><span>Unsaved changes</span><button type="button" class="btn ghost sm" id="undoBtn">Undo</button><button type="button" class="btn pri sm" id="saveBtn">Save Changes</button></div>
  <div id="toast" class="toast"></div>
</div>
<script>
(function () {
'use strict';
var B = __BOOT__;
var LS = 'fc_admin_' + B.key;
var PASS = B.auto || '';
try { if (!PASS) PASS = localStorage.getItem(LS) || ''; } catch (e) {}
var S = { prof: null, saved: '', meta: {}, health: null, token: B.token || '', storage: !!B.storage, tab: 'addons', inspect: null, found: [], pick: null, eps: null, streams: [], hTimer: 0, started: false };

function $(q, r) { return (r || document).querySelector(q); }
function $$(q, r) { return Array.prototype.slice.call((r || document).querySelectorAll(q)); }
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmtMs(ms) { if (ms == null || ms === '' || isNaN(ms)) return '\u2014'; ms = +ms; return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 9950 ? 1 : 0) + ' s'; }
function ago(t) { if (!t) return '\u2014'; var s = Math.max(0, Math.round((Date.now() - t) / 1000)); if (s < 45) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; }
function dur(ms) { var m = Math.round(ms / 60000); if (m < 60) return m + ' min'; if (m < 2880) return Math.round(m / 60) + ' h'; return Math.round(m / 1440) + ' days'; }
function shortUrl(u) { try { var x = new URL(u), p = x.pathname; if (p.length > 42) p = p.slice(0, 16) + '\u2026' + p.slice(-22); return x.host + p; } catch (e) { return u; } }
function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
function onCount() { return S.prof ? S.prof.addons.filter(function (a) { return a.on; }).length : 0; }
function toast(msg, kind) { var t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + (kind || ''); clearTimeout(toast.t); toast.t = setTimeout(function () { t.className = 'toast ' + (kind || ''); }, 3800); }
function copy(text, label) {
  var done = function () { toast('\u{1F4CB} ' + (label || 'Copied')); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this:', text); });
  else window.prompt('Copy this:', text);
}

/* ---------- server ---------- */
function apiUrl(p) { return location.origin + '/' + B.key + (S.token ? '/' + S.token : '') + '/api/' + p; }
function api(p, body) {
  var o = { method: body ? 'POST' : 'GET', headers: { 'x-admin-key': encodeURIComponent(PASS) }, cache: 'no-store' };
  if (body) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
  return fetch(apiUrl(p), o).then(function (r) {
    if (r.status === 401) {
      try { localStorage.removeItem(LS); } catch (e) {}
      showLogin(PASS ? 'Wrong password, try again.' : '');
      var err = new Error('login'); err.login = true; throw err;
    }
    return r.json().catch(function () { return { ok: false, error: 'Server error (HTTP ' + r.status + ')' }; });
  }, function () { throw new Error('Cannot reach the server. Check your internet connection.'); });
}

/* ---------- login ---------- */
function showLogin(msg) {
  $('#app').classList.add('hidden'); $('#saveBar').classList.add('hidden');
  $('#login').classList.remove('hidden');
  var e = $('#loginErr'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg);
  setTimeout(function () { $('#pass').focus(); }, 30);
}
$('#loginForm').addEventListener('submit', function (ev) {
  ev.preventDefault();
  PASS = $('#pass').value.trim(); if (!PASS) return;
  try { if ($('#remember').checked) localStorage.setItem(LS, PASS); else localStorage.removeItem(LS); } catch (e) {}
  load();
});
function load() {
  return api('profile').then(function (p) {
    if (!p.ok) throw new Error(p.error || 'Could not load your addons');
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    setProfile(p);
    if (p.badToken) toast('\u26A0\uFE0F This link could not be read (old or changed secret) \u2014 showing saved setup', 'bad');
    if (!S.started) {
      S.started = true;
      showTab((location.hash || '').slice(1) || B.tab || 'addons');
      refreshHealth(false);
      setInterval(function () { if (!document.hidden) refreshHealth(false); }, 30000);
    }
  }).catch(function (e) { if (!e.login) showLogin(e.message); });
}

/* ---------- profile state ---------- */
function setProfile(p) {
  S.prof = { addons: p.addons.map(function (a) { return { id: a.id, name: a.name, url: a.url, on: !!a.on, w: a.w || 0 }; }), settings: Object.assign({}, p.settings) };
  p.addons.forEach(function (a) { S.meta[a.id] = { logo: a.logo || '', version: a.version || '' }; });
  S.storage = !!p.storage;
  S.saved = snap();
  $('#ver').textContent = 'v' + p.version; $('#ver2').textContent = 'v' + p.version;
  renderAddons(); renderSettings(); renderInstall(); markDirty();
}
function snap() { return JSON.stringify(S.prof); }
function dirty() { return !!S.prof && snap() !== S.saved; }
function markDirty() { $('#saveBar').classList.toggle('hidden', !dirty()); }
window.addEventListener('beforeunload', function (e) { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- tabs ---------- */
$('#tabs').addEventListener('click', function (e) { var b = e.target.closest('button[data-tab]'); if (b) showTab(b.getAttribute('data-tab')); });
window.addEventListener('hashchange', function () { var t = location.hash.slice(1); if (t && t !== S.tab && S.started) showTab(t); });
function showTab(t) {
  if (!$('[data-pane="' + t + '"]')) t = 'addons';
  S.tab = t;
  $$('#tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === t); });
  $$('[data-pane]').forEach(function (p) { p.classList.toggle('hidden', p.getAttribute('data-pane') !== t); });
  if (location.hash !== '#' + t) { try { history.replaceState(null, '', '#' + t); } catch (e) {} }
  clearInterval(S.hTimer);
  if (t === 'health') { renderHealth(); refreshHealth(false); S.hTimer = setInterval(function () { if (!document.hidden && $('#autoH').checked) refreshHealth(false); }, 15000); }
  if (t === 'install') renderInstall();
}

/* ---------- addons ---------- */
function healthOf(id) { var L = S.health && S.health.addons; if (!L) return null; for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i]; return null; }
var AST = { working: ['g', 'Working'], slow: ['y', 'Slow'], failing: ['y', 'Last try failed'], down: ['r', 'Down \u00B7 paused'], unknown: ['n', 'Ready'], off: ['n', 'Off'] };
function statusOf(a) { if (!a.on) return AST.off; var h = healthOf(a.id); return h ? (AST[h.status] || ['n', h.status]) : ['b', 'Not saved yet']; }
function renderAddons() {
  var L = S.prof.addons, el = $('#addonList');
  $('#addonCount').textContent = onCount() + ' on \u00B7 ' + L.length + ' of ' + B.maxAddons;
  if (!L.length) { el.innerHTML = '<div class="empty">No addons yet. Paste an addon link above to add your first one.</div>'; return; }
  el.innerHTML = L.map(function (a, i) {
    var m = S.meta[a.id] || {}, h = healthOf(a.id), st = statusOf(a), bits = [];
    if (h && h.avgMs) bits.push('\u23F1 ' + fmtMs(h.avgMs) + ' avg answer');
    if (h && h.lastCount != null) bits.push('\u{1F4E6} ' + h.lastCount + ' streams last time');
    if (h && (h.ok || h.fail)) bits.push('\u2705 ' + h.ok + ' \u00B7 \u274C ' + h.fail);
    if (m.version) bits.push('v' + esc(m.version));
    return '<div class="addon' + (a.on ? '' : ' off') + '" data-i="' + i + '">' +
      '<img class="alogo" alt="" src="' + esc(m.logo || '/logo.png') + '" onerror="this.onerror=null;this.src=\'/logo.png\'">' +
      '<div class="ainfo"><div class="aname"><span>' + esc(a.name) + '</span><span class="pill ' + st[0] + '"><span class="dot"></span>' + st[1] + '</span>' +
      (a.w > 0 ? '<span class="pill b">\u25B2 High priority</span>' : a.w < 0 ? '<span class="pill n">\u25BC Low priority</span>' : '') + '</div>' +
      '<div class="aurl" title="' + esc(a.url) + '">' + esc(shortUrl(a.url)) + '</div>' +
      (bits.length ? '<div class="astats">' + bits.map(function (b) { return '<span>' + b + '</span>'; }).join('') + '</div>' : '') +
      (h && h.lastErr ? '<div class="aerr">\u26A0 ' + esc(h.lastErr) + '</div>' : '') + '</div>' +
      '<div class="actl">' +
      '<select class="sel" data-act="w" title="Priority"><option value="1"' + (a.w > 0 ? ' selected' : '') + '>High</option><option value="0"' + (!a.w ? ' selected' : '') + '>Normal</option><option value="-1"' + (a.w < 0 ? ' selected' : '') + '>Low</option></select>' +
      '<label class="switch" title="Switch on / off"><input type="checkbox" data-act="on"' + (a.on ? ' checked' : '') + '><span></span></label>' +
      '<button type="button" class="ib" data-act="up" title="Move up"' + (i ? '' : ' disabled') + '>\u25B2</button>' +
      '<button type="button" class="ib" data-act="down" title="Move down"' + (i < L.length - 1 ? '' : ' disabled') + '>\u25BC</button>' +
      '<button type="button" class="ib" data-act="more" title="More">\u22EF</button></div>' +
      '<div class="amore hidden"><button type="button" class="btn sm" data-act="ren">\u270F\uFE0F Rename</button><button type="button" class="btn sm" data-act="copy">\u{1F4CB} Copy addon link</button><button type="button" class="btn sm" data-act="recheck">\u{1F501} Test again</button><button type="button" class="btn sm danger" data-act="del">\u{1F5D1} Remove</button></div>' +
      '</div>';
  }).join('');
}
$('#addonList').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-act]'); if (!b) return;
  var row = b.closest('.addon'), i = +row.getAttribute('data-i'), L = S.prof.addons, a = L[i], act = b.getAttribute('data-act'), t;
  if (act === 'more') { row.querySelector('.amore').classList.toggle('hidden'); return; }
  if (act === 'copy') { copy(a.url, 'Addon link copied'); return; }
  if (act === 'recheck') { $('#addUrl').value = a.url; window.scrollTo({ top: 0, behavior: 'smooth' }); inspect(a.url); return; }
  if (act === 'up' && i > 0) { t = L[i - 1]; L[i - 1] = a; L[i] = t; }
  else if (act === 'down' && i < L.length - 1) { t = L[i + 1]; L[i + 1] = a; L[i] = t; }
  else if (act === 'ren') { var n = window.prompt('Name for this addon:', a.name); if (n == null) return; n = n.trim().slice(0, 40); if (!n) return; a.name = n; }
  else if (act === 'del') { if (!window.confirm('Remove \u201C' + a.name + '\u201D from Fast Combo?')) return; L.splice(i, 1); }
  else return;
  renderAddons(); markDirty();
});
$('#addonList').addEventListener('change', function (e) {
  var el = e.target, act = el.getAttribute('data-act'); if (!act) return;
  var a = S.prof.addons[+el.closest('.addon').getAttribute('data-i')];
  if (act === 'on') a.on = el.checked; else if (act === 'w') a.w = +el.value;
  renderAddons(); markDirty();
});

/* ---------- add / inspect ---------- */
$('#addForm').addEventListener('submit', function (e) { e.preventDefault(); var u = $('#addUrl').value.trim(); if (!u) { $('#addUrl').focus(); return; } inspect(u); });
function inspect(url) {
  var btn = $('#addBtn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  $('#inspect').innerHTML = '<div class="loading"><div class="spin"></div><div>Testing it live: opening the addon, running a test search and checking a few links\u2026 <span style="color:var(--text-tertiary)">(up to 25 s)</span></div></div>';
  api('inspect', { url: url }).then(renderInspect).catch(function (e) { if (!e.login) $('#inspect').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; })
    .then(function () { btn.disabled = false; btn.textContent = 'Check'; });
}
function verdict(r) {
  var s = r.sample;
  if (!s) return (r.resources || []).indexOf('stream') < 0 ? ['y', 'Online \u00B7 no streams'] : ['g', 'Online'];
  if (s.error) return ['r', 'Online, but the test search failed'];
  if (!s.total) return ['y', 'Online, but found nothing in the test'];
  if (!(s.hd + s.uhd)) return ['y', 'Works, but no 1080p / 4K in the test'];
  if (s.linksTested && !s.linksOk) return ['y', 'Works, but its test links didn\'t start'];
  if (s.ms > 9000) return ['y', 'Works, but slow (' + fmtMs(s.ms) + ')'];
  return ['g', 'Works \u00B7 has 1080p / 4K'];
}
function renderInspect(r) {
  S.inspect = r;
  var box = $('#inspect');
  if (!r.ok) { box.innerHTML = '<div class="err">\u274C ' + esc(r.error) + '</div>'; return; }
  var already = S.prof.addons.some(function (a) { return a.id === r.aid; });
  var full = !already && S.prof.addons.length >= B.maxAddons;
  var v = verdict(r), s = r.sample, tiles = ['<div><b>' + fmtMs(r.manifestMs) + '</b><span>to open the addon</span></div>'];
  if (s && !s.error) {
    tiles.push('<div><b>' + s.total + '</b><span>streams for ' + esc(s.label) + ' \u00B7 ' + fmtMs(s.ms) + '</span></div>');
    tiles.push('<div><b>' + s.uhd + ' \u00B7 ' + s.hd + '</b><span>in 4K \u00B7 in 1080p</span></div>');
    if (s.linksTested) tiles.push('<div><b>' + s.linksOk + ' / ' + s.linksTested + '</b><span>test links started' + (s.linksMs ? ' \u00B7 fastest ' + fmtMs(s.linksMs) : '') + '</span></div>');
    else if (s.p2p) tiles.push('<div><b>' + s.p2p + '</b><span>torrent streams</span></div>');
  }
  var chips = (r.types || []).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') +
    (r.resources || []).map(function (t) { return '<span class="chip on">' + esc(t) + '</span>'; }).join('') +
    (r.catalogs ? '<span class="chip">' + plural(r.catalogs, 'catalog') + '</span>' : '');
  var warns = (r.warnings || []).map(function (w) { return '<div class="warn">\u26A0\uFE0F ' + esc(w) + '</div>'; }).join('');
  var action = already ? '<button type="button" class="btn" disabled>\u2713 Already in your list</button>' : full ? '<button type="button" class="btn" disabled>Your list is full (' + B.maxAddons + ')</button>' : '<button type="button" class="btn ok" id="doAdd">\uFF0B Add to Fast Combo</button>';
  box.innerHTML = '<div class="preview"><div class="pv-h"><img alt="" src="' + esc(r.logo || '/logo.png') + '" onerror="this.onerror=null;this.src=\'/logo.png\'">' +
    '<div style="flex:1;min-width:180px"><h3>' + esc(r.name) + ' <span class="ver">v' + esc(r.version || '?') + '</span></h3><p class="pv-desc">' + esc(r.description || '') + '</p></div>' +
    '<span class="pill ' + v[0] + '"><span class="dot"></span>' + esc(v[1]) + '</span></div>' +
    '<div class="chips">' + chips + '</div><div class="kv">' + tiles.join('') + '</div>' + warns +
    '<div class="btns">' + action + '<button type="button" class="btn ghost" id="pvClose">Close</button></div></div>';
}
$('#inspect').addEventListener('click', function (e) {
  if (e.target.id === 'pvClose') { $('#inspect').innerHTML = ''; return; }
  if (e.target.id !== 'doAdd') return;
  var r = S.inspect; if (!r || !r.ok) return;
  S.prof.addons.push({ id: r.aid, name: r.name, url: r.url, on: true, w: 0 });
  S.meta[r.aid] = { logo: r.logo || '', version: r.version || '' };
  $('#addUrl').value = '';
  $('#inspect').innerHTML = '<div class="okbox">\u2705 <b>' + esc(r.name) + '</b> is in your list. Press <b>Save changes</b> to start using it.</div>';
  renderAddons(); markDirty();
});

/* ---------- save ---------- */
$('#undoBtn').addEventListener('click', function () { S.prof = JSON.parse(S.saved); renderAddons(); renderSettings(); markDirty(); toast('Changes undone'); });
$('#saveBtn').addEventListener('click', function () {
  var btn = $('#saveBtn'); btn.disabled = true; btn.textContent = 'Saving\u2026';
  api('profile', { addons: S.prof.addons, settings: S.prof.settings }).then(function (r) {
    if (!r.ok) throw new Error(r.error || 'Could not save');
    S.saved = snap(); markDirty();
    if (r.mode === 'link') {
      S.token = r.token;
      try { history.replaceState(null, '', '/' + B.key + '/' + r.token + '/configure#install'); } catch (e) {}
      $('#installNote').classList.remove('hidden'); showTab('install');
      toast('\u2705 Saved. Install the new link to apply it', 'ok');
    } else {
      if (S.token) { S.token = ''; try { history.replaceState(null, '', '/' + B.key + '/configure' + location.hash); } catch (e) {} renderInstall(); }
      toast('\u2705 Saved. Stremio gets it automatically (within a minute)', 'ok');
    }
    setTimeout(function () { refreshHealth(false); }, 400);
  }).catch(function (e) { if (!e.login) toast('\u274C ' + e.message, 'bad'); })
    .then(function () { btn.disabled = false; btn.textContent = 'Save Changes'; });
});

/* ---------- settings ---------- */
var SORTS = [['balanced', '\u2696\uFE0F Balanced', 'Working, fast links first. Mixes 4K and 1080p; smaller files win ties.'], ['smallest', '\u{1FAB6} Smallest first', 'Lowest bitrate first: starts fastest, best for slow internet.'], ['4kfirst', '\u{1F525} 4K first', 'All 4K on top, then 1080p.'], ['1080first', '\u{1F680} 1080p first', '1080p on top (lighter), then 4K.']];
var M1080 = [[4, '4 Mbps \u00B7 \u22483.6 GB per 2 h movie'], [6, '6 Mbps \u00B7 \u22485.4 GB'], [8, '8 Mbps \u00B7 \u22487 GB (default)'], [12, '12 Mbps \u00B7 \u224811 GB'], [16, '16 Mbps \u00B7 \u224814 GB'], [0, 'No limit']];
var M4K = [[10, '10 Mbps \u00B7 \u22489 GB per 2 h movie'], [15, '15 Mbps \u00B7 \u224813.5 GB'], [20, '20 Mbps \u00B7 \u224818 GB (default)'], [30, '30 Mbps \u00B7 \u224827 GB'], [40, '40 Mbps \u00B7 \u224836 GB'], [0, 'No limit']];
var LIMITS = [[10, '10 streams'], [15, '15 streams'], [20, '20 streams'], [30, '30 streams'], [50, '50 streams']];
var RES = [['2160', '4K'], ['1080', '1080p'], ['720', '720p \u00B7 slow internet']];
var TOGGLES = [['test', '\u{1F9EA} Test links live', 'Checks links before showing them and hides the dead ones.'], ['newBadge', '\u{1F195} Mark new links', 'Links that appear after you first opened a title get a \u{1F195} badge for ' + B.newHours + ' h.'], ['remux', '\u{1F4BF} Allow REMUX', 'Untouched Blu-ray copies: huge files, slow to buffer.'], ['hideDV', '\u{1F7E3} Hide Dolby-Vision-only', 'For TVs without Dolby Vision (wrong purple / green colours).'], ['hideAV1', '\u{1F9E9} Hide AV1', 'For older devices that can\'t play AV1.']];
function options(list, cur) {
  if (!list.some(function (o) { return +o[0] === +cur; })) list = list.concat([[cur, cur + ' (custom)']]);
  return list.map(function (o) { return '<option value="' + o[0] + '"' + (+o[0] === +cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
}
function renderSettings() {
  var s = S.prof.settings, res = String(s.res || '').split(','), lang = String(s.lang || '').split(',').filter(Boolean);
  var h = '<div class="card"><h2>Order</h2><p class="lead">How streams are sorted in Stremio.</p><div class="grid2">' +
    SORTS.map(function (o) { var on = s.sort === o[0]; return '<label class="opt' + (on ? ' on' : '') + '"><input type="radio" name="sort" value="' + o[0] + '"' + (on ? ' checked' : '') + '><div><b>' + o[1] + '</b><span>' + o[2] + '</span></div></label>'; }).join('') + '</div></div>';
  h += '<div class="card"><h2>Quality &amp; Size</h2><p class="lead">A lower bitrate means a smaller file, so it buffers faster.</p><label class="lbl">Qualities to keep</label><div class="langs" data-group="res">' +
    RES.map(function (o) { return '<button type="button" data-v="' + o[0] + '" class="' + (res.indexOf(o[0]) >= 0 ? 'on' : '') + '">' + o[1] + '</button>'; }).join('') + '</div>' +
    '<div class="grid2" style="margin-top:18px"><div><label class="lbl">Biggest 1080p allowed</label><select class="select" data-k="max1080">' + options(M1080, s.max1080) + '</select></div>' +
    '<div><label class="lbl">Biggest 4K allowed</label><select class="select" data-k="max4k">' + options(M4K, s.max4k) + '</select></div>' +
    '<div><label class="lbl">Show up to</label><select class="select" data-k="limit">' + options(LIMITS, s.limit) + '</select></div></div></div>';
  h += '<div class="card"><h2>Links</h2>' + TOGGLES.map(function (o) { return '<div class="tg"><div><b>' + o[1] + '</b><span>' + esc(o[2]) + '</span></div><label class="switch"><input type="checkbox" data-k="' + o[0] + '"' + (s[o[0]] ? ' checked' : '') + '><span></span></label></div>'; }).join('') + '</div>';
  h += '<div class="card"><h2>Preferred Audio Languages</h2><p class="lead">Streams in these languages are moved up. Nothing is hidden.</p><div class="langs" data-group="lang">' +
    B.langs.map(function (l) { return '<button type="button" data-v="' + l[0] + '" class="' + (lang.indexOf(l[0]) >= 0 ? 'on' : '') + '">' + (l[2] ? l[2] + ' ' : '') + esc(l[1]) + '</button>'; }).join('') + '</div></div>';
  h += '<p class="hint center">Changes are kept on this page until you press <b>Save changes</b>.</p>';
  $('#settingsBody').innerHTML = h;
}
$('#settingsBody').addEventListener('change', function (e) {
  var el = e.target, s = S.prof.settings;
  if (el.name === 'sort') { s.sort = el.value; renderSettings(); }
  else if (el.matches('select[data-k]')) s[el.getAttribute('data-k')] = +el.value;
  else if (el.matches('input[type=checkbox][data-k]')) s[el.getAttribute('data-k')] = el.checked ? 1 : 0;
  markDirty();
});
$('#settingsBody').addEventListener('click', function (e) {
  var b = e.target.closest('[data-group] button'); if (!b) return;
  var g = b.parentNode.getAttribute('data-group'), v = b.getAttribute('data-v'), s = S.prof.settings;
  var cur = String(s[g] || '').split(',').filter(Boolean), i = cur.indexOf(v);
  if (i >= 0) cur.splice(i, 1); else cur.push(v);
  if (g === 'res') { if (!cur.length) { toast('Keep at least one quality'); return; } cur.sort(function (x, y) { return y - x; }); }
  s[g] = cur.join(',');
  b.classList.toggle('on', i < 0);
  markDirty();
});

/* ---------- try it ---------- */
$('#searchForm').addEventListener('submit', function (e) { e.preventDefault(); search(); });
function search() {
  var q = $('#q').value.trim(); if (!q) return;
  var idm = /^(tt\d{5,10})(?::(\d{1,3}):(\d{1,4}))?$/i.exec(q), km = /^(kitsu|mal|anilist|anidb):\d+(?::\d+)?$/i.test(q);
  if (idm && !idm[2]) {
    $('#results').innerHTML = '<div class="loading"><div class="spin"></div>Looking it up\u2026</div>';
    api('title?id=' + encodeURIComponent(idm[1].toLowerCase())).then(function (r) {
      $('#results').innerHTML = '';
      if (!r.ok) { $('#results').innerHTML = '<div class="err">' + esc(r.error || 'Not found') + '</div>'; return; }
      S.eps = r.eps; pickTitle({ id: r.id, type: r.type, name: r.name, year: r.year, poster: r.poster }, r.eps);
    }).catch(function (e) { if (!e.login) $('#results').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
    return;
  }
  if (idm || km) { $('#results').innerHTML = ''; pickTitle({ id: q, type: (idm ? !!idm[2] : q.split(':').length > 2) ? 'series' : 'movie', name: q, direct: true }); return; }
  $('#results').innerHTML = '<div class="loading"><div class="spin"></div>Searching\u2026</div>';
  api('search?q=' + encodeURIComponent(q)).then(function (r) {
    var m = (r && r.metas) || []; S.found = m;
    if (!m.length) { $('#results').innerHTML = '<div class="empty">Nothing found for \u201C' + esc(q) + '\u201D.</div>'; return; }
    $('#results').innerHTML = '<div class="results">' + m.map(function (x, i) {
      return '<button type="button" class="tile" data-i="' + i + '"><div class="ph">\u{1F3AC}' + (x.poster ? '<img loading="lazy" alt="" src="' + esc(x.poster) + '" onerror="this.remove()">' : '') + '</div><div class="tt"><b>' + esc(x.name) + '</b><span>' + esc(x.year || '') + ' \u00B7 ' + (x.type === 'series' ? 'Series' : 'Movie') + '</span></div></button>';
    }).join('') + '</div>';
  }).catch(function (e) { if (!e.login) $('#results').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
}
$('#results').addEventListener('click', function (e) {
  var t = e.target.closest('.tile'); if (!t) return;
  $$('.tile').forEach(function (x) { x.classList.toggle('sel', x === t); });
  pickTitle(S.found[+t.getAttribute('data-i')]);
});
function pickTitle(x, eps) {
  S.pick = x; S.eps = eps || null;
  var series = x.type === 'series' && !x.direct;
  $('#picked').innerHTML = '<div class="picked">' + (x.poster ? '<img alt="" src="' + esc(x.poster) + '" onerror="this.remove()">' : '') +
    '<div style="flex:1;min-width:150px"><b>' + esc(x.name) + '</b><div class="mut small">' + esc((x.year ? x.year + ' \u00B7 ' : '') + (x.type === 'series' ? 'Series' : 'Movie') + ' \u00B7 ' + x.id) + '</div></div>' +
    (series ? '<select class="sel" id="seaSel"><option value="">Loading\u2026</option></select><select class="sel" id="epSel"></select>' : '') +
    '<label class="row small mut" style="gap:6px" title="Ask the addons again right now instead of using the last result"><input type="checkbox" id="liveChk"> Skip cache</label>' +
    '<button type="button" class="btn pri" id="goTry">Find Streams</button></div>';
  $('#picked').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (!series) runTry();
  else if (eps) fillSeasons(eps);
  else api('title?id=' + encodeURIComponent(x.id)).then(function (r) { fillSeasons((r && r.eps) || []); }).catch(function () { fillSeasons([]); });
}
function fillSeasons(eps) {
  var seasons = [];
  S.eps = eps;
  eps.forEach(function (e) { if (seasons.indexOf(e[0]) < 0) seasons.push(e[0]); });
  if (!seasons.length) seasons = [1];
  if (!$('#seaSel')) return;
  $('#seaSel').innerHTML = seasons.map(function (n) { return '<option value="' + n + '">Season ' + n + '</option>'; }).join('');
  fillEps();
}
function fillEps() {
  var se = +$('#seaSel').value, list = (S.eps || []).filter(function (e) { return e[0] === se; });
  if (!list.length) list = [[se, 1, '']];
  $('#epSel').innerHTML = list.map(function (e) { return '<option value="' + e[1] + '">E' + e[1] + (e[2] ? ' \u00B7 ' + esc(e[2].slice(0, 30)) : '') + '</option>'; }).join('');
}
$('#picked').addEventListener('change', function (e) { if (e.target.id === 'seaSel') fillEps(); });
$('#picked').addEventListener('click', function (e) { if (e.target.id === 'goTry') runTry(); });
function runTry() {
  var x = S.pick; if (!x) return;
  var id = x.id, type = x.type;
  if (type === 'series' && !x.direct) {
    var se = $('#seaSel') && $('#seaSel').value, ep = $('#epSel') && $('#epSel').value;
    if (!se || !ep) { toast('Pick an episode first'); return; }
    id = x.id + ':' + se + ':' + ep;
  }
  var fresh = $('#liveChk') && $('#liveChk').checked, t0 = Date.now(), out = $('#tryOut');
  out.innerHTML = '<div class="card"><div class="loading" style="margin:0"><div class="spin"></div>Asking ' + plural(onCount(), 'addon') + ' and testing links live\u2026 usually 2\u20138 s</div></div>';
  var btn = $('#goTry'); if (btn) btn.disabled = true;
  api('try/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + (fresh ? '?fresh=1' : '')).then(function (r) { renderTry(r, Date.now() - t0); out.scrollIntoView({ behavior: 'smooth', block: 'start' }); })
    .catch(function (e) { if (!e.login) out.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; })
    .then(function () { var b2 = $('#goTry'); if (b2) b2.disabled = false; });
}
function renderTry(r, ms) {
  var out = $('#tryOut');
  if (!r.ok) { out.innerHTML = '<div class="err">\u274C ' + esc(r.error || 'Failed') + '</div>'; return; }
  var rep = r.report || {}, st = r.streams || [], d = rep.dropped || {}, removed = 0;
  var keys = Object.keys(d).sort(function (a, b) { return d[b] - d[a]; });
  keys.forEach(function (k) { removed += d[k]; });
  var max = keys.length ? d[keys[0]] : 1;
  S.streams = st;
  var h = '<div class="card"><div class="card-h"><h2>' + esc(rep.title || '') + '</h2><span class="mut small">' + (r.cached ? '\u26A1 from cache (made ' + ago(Date.now() - r.age * 1000) + ') \u00B7 ' : '') + 'answered in ' + fmtMs(ms) + '</span></div>';
  if (dirty()) h += '<div class="warn">You have unsaved changes. This test used your saved setup.</div>';
  h += '<div class="sum"><span class="pill b">\u{1F4E5} ' + (rep.total || 0) + ' found</span><span class="pill g">\u2705 ' + st.length + ' shown</span><span class="pill g">\u{1F9EA} ' + (rep.tested || 0) + ' tested working</span>' +
    (rep.newCount ? '<span class="pill y">\u{1F195} ' + rep.newCount + ' new</span>' : '') + (rep.ms != null ? '<span class="pill n">\u23F1 built in ' + fmtMs(rep.ms) + '</span>' : '') + '</div>';
  h += '<div class="chips">' + (rep.ups || []).map(function (u) {
    return '<span class="chip">' + esc(u.name) + ' \u00B7 ' + (u.err ? '\u274C ' + esc(u.err) : u.skipped ? '\u23ED ' + (u.skipped === 'unsupported' ? 'doesn\'t cover this' : 'paused (down)') : u.n + ' streams' + (u.cached ? ' \u00B7 cached' : u.ms ? ' \u00B7 ' + fmtMs(u.ms) : '')) + '</span>';
  }).join('') + '</div>';
  if (!(rep.ups || []).length) h += '<div class="warn">No addons are switched on.</div>';
  if (keys.length) h += '<details><summary>Removed ' + removed + ' \u2014 see why</summary><div class="bars">' + keys.map(function (k) { return '<div class="bar"><span>' + esc(k) + '</span><i style="width:' + Math.max(3, Math.round(d[k] / max * 100)) + '%"></i><b>' + d[k] + '</b></div>'; }).join('') + '</div></details>';
  h += '</div>';
  h += st.length ? st.map(function (s, i) {
    return '<div class="stream' + (/\u{1F195}/.test(s.name || '') ? ' new' : '') + '"><div class="sname">' + esc(s.name) + '</div><div class="sdesc">' + esc(s.description || s.title || '') + '</div><div>' + (s.url ? '<button type="button" class="ib" data-copy="' + i + '" title="Copy stream link">\u{1F4CB}</button>' : '') + '</div></div>';
  }).join('') : '<div class="empty">No streams passed the filters for this title.</div>';
  out.innerHTML = h;
}
$('#tryOut').addEventListener('click', function (e) { var b = e.target.closest('[data-copy]'); if (b) copy(S.streams[+b.getAttribute('data-copy')].url, 'Stream link copied'); });

/* ---------- health ---------- */
$('#pingBtn').addEventListener('click', function () {
  var b = this; b.disabled = true; b.textContent = 'Checking\u2026';
  refreshHealth(true).then(function () { b.disabled = false; b.textContent = '\u21BB Check Now'; toast('All addons checked'); });
});
function refreshHealth(ping) {
  return api('health' + (ping ? '?ping=1' : '')).then(function (h) {
    if (!h || !h.ok) return;
    S.health = h; renderLive();
    if (S.tab === 'health') renderHealth();
    var ae = document.activeElement;
    if (S.prof && !(ae && ae.closest && ae.closest('#addonList'))) renderAddons();
  }).catch(function () {});
}
function renderLive() {
  var h = S.health, el = $('#live'); if (!h) return;
  var on = h.addons.filter(function (a) { return a.on; });
  var bad = on.filter(function (a) { return a.status === 'down' || a.status === 'failing'; }).length;
  var good = on.filter(function (a) { return a.status === 'working' || a.status === 'slow'; }).length;
  var cls = 'g', txt;
  if (!on.length) { cls = 'y'; txt = 'No addons on'; }
  else if (bad && !good) { cls = 'r'; txt = bad === on.length ? 'Addons down' : plural(bad, 'addon') + ' down'; }
  else if (bad) { cls = 'y'; txt = plural(bad, 'addon') + ' having trouble'; }
  else txt = good ? 'Live \u00B7 ' + good + '/' + on.length + ' working' : 'Live \u00B7 ' + plural(on.length, 'addon') + ' ready';
  el.className = 'pill ' + cls; el.innerHTML = '<span class="dot"></span>' + esc(txt);
}
var HST = { working: ['g', 'Working'], slow: ['y', 'Slow'], failing: ['y', 'Last try failed'], down: ['r', 'Down'], unknown: ['n', 'Not used yet'], off: ['n', 'Off'] };
var HOSTST = { good: ['g', 'Good'], mixed: ['y', 'Mixed'], slow: ['y', 'Slow'], failing: ['r', 'Failing'] };
function hpill(k, map) { var p = (map || HST)[k] || ['n', k]; return '<span class="pill ' + p[0] + '"><span class="dot"></span>' + p[1] + '</span>'; }
function renderHealth() {
  var h = S.health;
  if (!h) { $('#hTiles').innerHTML = '<div class="loading" style="margin:0"><div class="spin"></div>Loading\u2026</div>'; return; }
  var on = h.addons.filter(function (a) { return a.on; });
  var good = on.filter(function (a) { return a.status === 'working' || a.status === 'slow'; }).length, avg = 0, n = 0, ok = 0, all = 0;
  on.forEach(function (a) { if (a.avgMs) { avg += a.avgMs; n++; } });
  h.hosts.forEach(function (x) { ok += x.ok; all += x.ok + x.fail + x.slow; });
  $('#hTiles').innerHTML = '<div class="stat"><b>' + good + ' / ' + on.length + '</b><span>addons working</span></div>' +
    '<div class="stat"><b>' + (n ? fmtMs(avg / n) : '\u2014') + '</b><span>average addon answer</span></div>' +
    '<div class="stat"><b>' + (all ? Math.round(ok / all * 100) + '%' : '\u2014') + '</b><span>tested links that started</span></div>' +
    '<div class="stat"><b>' + (h.storage ? 'Live sync' : 'Link mode') + '</b><span>' + (h.storage ? 'changes apply by themselves' : 'changes need a new link') + '</span></div>';
  $('#hNote').textContent = 'While you watch, results older than ' + dur(h.fresh * 1000) + ' are refreshed from your addons in the background, so new links show up by themselves. Server running for ' + dur(Date.now() - h.upSince) + ' \u00B7 updated ' + new Date(h.now).toLocaleTimeString() + '.';
  $('#hAddons').innerHTML = h.addons.length ? '<table><tr><th>Addon</th><th>Status</th><th>Ping</th><th>Avg answer</th><th>Last results</th><th>OK / Fail</th><th>Note</th></tr>' + h.addons.map(function (a) {
    return '<tr><td><b>' + esc(a.name) + '</b></td><td>' + hpill(a.status) + '</td><td>' + (a.pingMs ? fmtMs(a.pingMs) : '\u2014') + '</td><td>' + (a.avgMs ? fmtMs(a.avgMs) : '\u2014') + '</td><td>' + (a.lastCount != null ? a.lastCount + ' streams' : '\u2014') + '</td><td>' + a.ok + ' / ' + a.fail + '</td><td class="sub" style="color:#FF6961">' + esc(a.lastErr || (a.pausedMin ? 'paused for ' + a.pausedMin + ' min' : '')) + '</td></tr>';
  }).join('') + '</table>' : '<div class="empty">No addons.</div>';
  $('#hHosts').innerHTML = h.hosts.length ? '<table><tr><th>Host</th><th>Status</th><th>Working</th><th>Dead</th><th>Slow</th><th>Avg start</th></tr>' + h.hosts.map(function (x) {
    return '<tr><td>' + esc(x.host) + '</td><td>' + hpill(x.status, HOSTST) + '</td><td>' + x.ok + '</td><td>' + x.fail + '</td><td>' + x.slow + '</td><td>' + (x.avgMs ? fmtMs(x.avgMs) : '\u2014') + '</td></tr>';
  }).join('') + '</table>' : '<div class="empty">No links tested yet. Open a movie in Stremio, or use \u201CTry it\u201D.</div>';
  $('#hRecent').innerHTML = h.recent.length ? '<table><tr><th>When</th><th>Title</th><th>Found</th><th>Shown</th><th>\u{1F195}</th><th>Time</th><th>Removed (top reasons)</th></tr>' + h.recent.map(function (r) {
    var d = r.dropped || {}, top = Object.keys(d).sort(function (a, b) { return d[b] - d[a]; }).slice(0, 3).map(function (k) { return d[k] + ' ' + k; }).join(' \u00B7 ');
    return '<tr><td style="white-space:nowrap">' + ago(r.at) + '</td><td><b>' + esc(r.title) + '</b><div class="sub">' + esc(r.type + ' \u00B7 ' + r.id) + (r.fresh ? ' \u00B7 background refresh' : '') + '</div></td><td>' + r.total + '</td><td><b>' + r.shown + '</b> <span class="sub">(' + r.tested + ' \u2705)</span></td><td>' + (r.newCount || '\u2014') + '</td><td>' + fmtMs(r.ms) + '</td><td class="sub">' + esc(top) + '</td></tr>';
  }).join('') + '</table>' : '<div class="empty">Nothing yet.</div>';
}

/* ---------- install ---------- */
function installUrl() { return B.base + '/' + B.key + (S.token ? '/' + S.token : '') + '/manifest.json'; }
function renderInstall() {
  var u = installUrl();
  $('#instLink').textContent = u;
  $('#instApp').href = u.replace(/^https?:\/\//, 'stremio://');
  $('#instWeb').href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(u);
  var m = $('#modeCard');
  if (S.storage) m.innerHTML = '<h2>Live Sync <span class="pill g"><span class="dot"></span>On</span></h2><p class="lead" style="margin:6px 0 0">Install once. Everything you save here (new addons, switched-off addons, settings) reaches Stremio by itself within about a minute. No reinstalling.</p>';
  else m.innerHTML = '<h2>Link Mode <span class="pill y">no storage connected</span></h2><p class="lead" style="margin:6px 0 10px">Your addon list is stored inside the install link (encrypted, only your server can read it). After you save changes, <b>remove the old Fast Combo in Stremio and install the new link</b>.</p>' +
    (B.onCF ? '<details open><summary>Turn on live sync (free, about 2 minutes) so you never need to reinstall</summary><ol class="steps"><li>Cloudflare dashboard \u2192 your worker \u2192 <b>Bindings</b> \u2192 <b>Add binding</b> \u2192 <b>KV namespace</b> (not D1 database).</li><li>Variable name <code>FC_KV</code> (any name works). KV namespace: pick <code>fastcombo</code>, or type <code>fastcombo</code> and choose the option marked <b>new</b>.</li><li>Click <b>Add binding</b>. This is the last click: there is no separate Deploy. Ignore any example code and the message about updating your Wrangler configuration.</li><li>Reload this page and press <b>Save changes</b> once. Then install the plain link one last time.</li></ol></details>'
      : '<p class="hint">Tip: with server.js, live sync is on automatically (saved in data/kv.json).</p>');
}
$('#instCopy').addEventListener('click', function () { copy(installUrl(), 'Install link copied'); });

/* ---------- AI finder ---------- */
var aiItems = [], aiResult = null;
$('#aiForm').addEventListener('submit', function (e) { e.preventDefault(); aiFind(); });
function aiFind() {
  var q = $('#aiQ').value.trim(), test = $('#aiTest').checked, out = $('#aiOut'), btn = $('#aiBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  out.innerHTML = '<div class="loading"><div class="spin"></div><div>' + (test ? 'Searching the community catalog and live-testing the top ones\u2026 usually 10\u201325 s' : 'Searching the community catalog\u2026 a couple of seconds') + '</div></div>';
  api('ai?q=' + encodeURIComponent(q) + (test ? '&test=1' : '')).then(function (r) { aiResult = r; aiItems = (r && r.candidates) || []; paintAi(); })
    .catch(function (e) { if (!e.login) out.innerHTML = '<div class="err">\u274C ' + esc(e.message) + '</div>'; })
    .then(function () { btn.disabled = false; btn.textContent = '\u{1F50E} Find Best'; });
}
function aiBits(c) {
  var b = [];
  if (c.downloads) b.push('\u{1F4E5} ' + (c.downloads >= 1000 ? Math.round(c.downloads / 1000) + 'k' : c.downloads) + ' installs');
  if (c.rating) b.push('\u2B50 ' + c.rating.toFixed(1));
  if (c.tested && c.live) {
    if (c.live.uhd) b.push('\u2728 ' + c.live.uhd + ' in 4K');
    if (c.live.hd) b.push('\u{1F39E} ' + c.live.hd + ' in 1080p');
    if (c.live.linksTested) b.push('\u{1F517} ' + c.live.linksOk + '/' + c.live.linksTested + ' start');
  }
  return b;
}
function aiRow(c, i) {
  var best = i === 0, bits = aiBits(c), already = S.prof.addons.some(function (a) { return a.id === c.aid; });
  var why = (c.why || []).slice(0, 4).map(esc).join(' \u00B7 ');
  return '<div class="addon" style="' + (best ? 'border-color:rgba(124,108,255,.75);box-shadow:0 0 0 2px rgba(124,108,255,.35)' : '') + '">' +
    (best ? '<div style="flex-basis:100%"><span class="pill b"><span class="dot"></span>\u{1F3C6} Best pick</span>' + (c.reason ? '<span class="mut small" style="margin-left:8px">' + esc(c.reason) + '</span>' : '') + '</div>' : '') +
    '<img class="alogo" alt="" src="' + esc(c.logo || '/logo.png') + '" onerror="this.onerror=null;this.src=\'/logo.png\'">' +
    '<div class="ainfo"><div class="aname"><span>' + (i + 1) + '. ' + esc(c.name) + '</span></div>' +
    (bits.length ? '<div class="astats">' + bits.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '</div>' : '') +
    (why ? '<div class="aurl" style="white-space:normal;max-width:none;overflow:visible">' + why + '</div>' : '') +
    (c.live && c.live.error ? '<div class="aerr">\u26A0 ' + esc(c.live.error) + '</div>' : '') + '</div>' +
    '<div class="actl">' + (already ? '<span class="pill n">\u2713 Added</span>' : '<button type="button" class="btn ok sm" data-ai="' + i + '">\uFF0B Add</button>') + '</div></div>';
}
function paintAi() {
  var out = $('#aiOut'), r = aiResult;
  if (!r) return;
  if (!r.ok) { out.innerHTML = '<div class="err">\u274C ' + esc(r.error || 'Something went wrong') + '</div>'; return; }
  if (!aiItems.length) { out.innerHTML = '<div class="empty">No addons matched. Try a different word, or leave the box empty for the best overall.</div>'; return; }
  var eng = r.llm ? '<span class="pill b">\u{1F9E0} ' + esc(r.llm.model) + '</span>' : '<span class="pill n">\u2699\uFE0F auto-scored</span>';
  var h = '<div class="sum" style="margin:8px 0 2px">' + eng + '<span class="mut small">from ' + esc(r.source) + (r.tested ? ' \u00B7 top ones live-tested' : '') + ' \u00B7 ' + r.count + ' candidates</span></div>';
  h += '<div class="btns" style="margin:12px 0 2px"><button type="button" class="btn pri" id="aiBest">\uFF0B Add the best' + (aiItems[0] ? ': ' + esc(aiItems[0].name) : '') + '</button>';
  var sug = r.suggested || [];
  if (sug.length > 1) h += '<button type="button" class="btn" id="aiTop">\uFF0B Add top ' + sug.length + '</button>';
  h += '</div>';
  h += aiItems.map(aiRow).join('');
  out.innerHTML = h;
  var b = $('#aiBest'); if (b) b.addEventListener('click', function () { aiAdd(0); });
  var t = $('#aiTop'); if (t) t.addEventListener('click', function () { (r.suggested || []).forEach(function (u) { for (var k = 0; k < aiItems.length; k++) if (aiItems[k].url === u) { aiAdd(k); break; } }); });
  $$('#aiOut [data-ai]').forEach(function (el) { el.addEventListener('click', function () { aiAdd(+el.getAttribute('data-ai')); }); });
}
function aiAdd(i) {
  var c = aiItems[i]; if (!c) return;
  if (S.prof.addons.some(function (a) { return a.id === c.aid; })) { toast('Already in your list'); return; }
  if (S.prof.addons.length >= B.maxAddons) { toast('Your addon list is full (' + B.maxAddons + ')', 'bad'); return; }
  S.prof.addons.push({ id: c.aid, name: c.name, url: c.url, on: true, w: 0 });
  S.meta[c.aid] = { logo: c.logo || '', version: c.version || '' };
  renderAddons(); markDirty();
  toast('\u2705 ' + c.name + ' added \u2014 now press Save changes', 'ok');
  paintAi();
}

/* ---------- update ---------- */
$('#updateBtn').addEventListener('click', function () {
  var btn = $('#updateBtn'), out = $('#updateOut');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Checking for updates…';
  out.innerHTML = '<div class="loading"><div class="spin"></div><div>Pulling latest code from GitHub… this takes 30-90 seconds. The server will restart automatically.</div></div>';
  
  api('update').then(function (r) {
    if (!r.ok) throw new Error(r.error || 'Update failed');
    out.innerHTML = '<div class="okbox">✅ Update successful! The server is restarting. Refresh this page in 10 seconds.</div>';
    if (r.log) {
      out.innerHTML += '<details style="margin-top:12px"><summary>Update log</summary><pre style="background:#0a0f22;border:1px solid var(--line);border-radius:10px;padding:12px;font:12px var(--font-mono);color:#A0AEFF;overflow-x:auto;margin-top:8px">' + esc(r.log) + '</pre></details>';
    }
    setTimeout(function () { location.reload(); }, 10000);
  }).catch(function (e) {
    if (!e.login) {
      out.innerHTML = '<div class="err">❌ ' + esc(e.message || 'Update failed') + '</div>';
    }
  }).then(function () {
    btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-6.219-8.56"/><polyline points="21 3 21 9 15 9"/></svg> Check for Updates';
  });
});

/* ---------- start ---------- */
if (PASS) load(); else showLogin('');
})();
</script>
</body>
</html>
`;
// ==UI-END==
function bootData(env, origin, token, priv, tab) {
  return {
    key: RT.ACCESS_KEY, token: token || "", base: RT.PUBLIC_URL || origin, version: VERSION, tab,
    storage: !!(env && env.FC_KV), onCF: ON_CF, auto: priv ? RT.ADMIN_PASSWORD : "",
    maxAddons: RT.MAX_ADDONS, newHours: RT.NEW_HOURS,
    langs: Object.entries(LANGS).map(([k, v]) => [k, v[0], v[1][0] || ""]),
  };
}
function appPage(boot) {
  return APP_HTML.replace("__BOOT__", () => JSON.stringify(boot).replace(/</g, "\\u003c"));
}

// ------------------------------------------------------------------ router
const ROUTES = new Set(["manifest.json", "configure", "status", "stream", "catalog", "meta", "subtitles", "api"]);
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

function isPrivateHost(h) {
  const p = RT.PRIVATE_HOST;
  if (!p) return false;
  h = h.toLowerCase();
  if (RT.PUBLIC_URL) { try { if (new URL(RT.PUBLIC_URL).hostname.toLowerCase() === h) return false; } catch {} }
  return h === p || h.endsWith("." + p);
}
async function route(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const origin = url.origin;
  const seg = url.pathname.split("/").filter(Boolean);
  const priv = isPrivateHost(url.hostname);
  if (!seg.length && RT.ACCESS_KEY && RT.ADMIN_PASSWORD) return html(priv ? appPage(bootData(env, origin, "", true, "addons")) : landingPage());
  if (seg[0] === "logo.png" || seg[0] === "favicon.ico") return logo();
  if (!RT.ACCESS_KEY || !RT.ADMIN_PASSWORD) return html(setupPage(), 503);
  if (seg[0] !== RT.ACCESS_KEY) return html(landingPage(), 404);

  let rest = seg.slice(1), token = "";
  if (rest.length && !ROUTES.has(rest[0])) { token = rest[0]; rest = rest.slice(1); }
  // control panel website (the "configure" button in Stremio opens it too)
  if (!rest.length || rest[0] === "configure" || rest[0] === "status") {
    return html(appPage(bootData(env, origin, token, priv, rest[0] === "status" ? "health" : "addons")));
  }
  const P = await loadProfile(env, token);
  if (rest[0] === "api") return apiHandler(request, env, ctx, P, rest.slice(1));
  if (rest[0] === "manifest.json") return json(await buildManifest(origin, P), 200, 300);

  const [resource, type, ...more] = rest;
  if (!type || !more.length) return json({ err: "not found" }, 404);
  let idRaw = more[0], extraRaw = more.slice(1).join("/");
  if (extraRaw) extraRaw = extraRaw.replace(/\.json$/, "");
  else idRaw = idRaw.replace(/\.json$/, "");
  const id = safeDecode(idRaw);
  const typeD = safeDecode(type);
  const ua = request.headers.get("user-agent") || "";

  if (resource === "stream") {
    const r = await streamHandler(typeD, id, P, ua, ctx, env);
    return json(r.out, 200, r.out.streams.length ? 120 : 30);
  }
  if (resource === "catalog") return json(await catalogHandler(typeD, idRaw, extraRaw, P), 200, 1800);
  if (resource === "meta") return json(await metaHandler(typeD, id, idRaw, P), 200, 3600);
  if (resource === "subtitles") return json(await subtitlesHandler(typeD, id, idRaw, extraRaw, P), 200, 3600);
  return json({ err: "not found" }, 404);
}

// Live-sync storage = a Cloudflare KV namespace. Recommended binding name FC_KV, but any name works
// (e.g. "KV" like Cloudflare's example code): the first KV namespace found is used.
const isKV = (v) => !!v && typeof v === "object" && typeof v.get === "function" && typeof v.put === "function" && typeof v.getWithMetadata === "function";
function withKV(env) {
  if (!env || typeof env !== "object" || env.FC_KV) return env;
  let kv = isKV(env.KV) ? env.KV : null;
  if (!kv) for (const k of Object.keys(env)) if (isKV(env[k])) { kv = env[k]; break; }
  if (!kv) return env;
  const e = Object.create(env); // keeps every other binding / variable as it is
  e.FC_KV = kv;
  return e;
}

export default {
  async fetch(request, env, ctx) {
    env = withKV(env);
    applyEnv(env);
    if (!STARTED) STARTED = Date.now(); // (Cloudflare freezes the clock outside requests)
    try {
      return await route(request, env || {}, ctx);
    } catch (e) {
      return json({ streams: [], err: String((e && e.message) || e) }, 200);
    }
  },
};
