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

const VERSION = "2.0.0";
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
const LOGO_B64 = "iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAMAAAC8EZcfAAAAwFBMVEUoEGlZMJrOsVWul2TUz+KQcVAwGWMvG2dZCGZVGJxxZaAwGWPk1oRtUFpVJZv02VJGKXUfCj1UJZm3sM4AAP+Zjro+FIBAH3pCH30/L7/Du9gAf39/f39VVap/AAB/f/+MZz+EaLA3HGwqGFhKIon+1UBCIHdAHnkAAAD9/f7+64xFKlU6IlNRNFA6IWn+2D3+4j5FGIr+949mR02LcrJ1VkyplcjKp0S5lkj+427ryEHt6/NMRIcXDGMcEmaspsfW1gUeAAAAQHRSTlMR8///7v9l3gcT96P//2b/4gSl8QH0/3CbBPACAgMCAv/4/v7+//7+AOr//////v//////9v/z/////+v6///yMWCgLwAACpBJREFUeNrN3WlX4zgaBWBnD0lBwtbQVd09M28cO8FryqRChST8/381kmXLkuVFkm1ofagDnAKec6/kNTHGpmjc4n+M8Xg+XzUZIDPm8/HYiH9fIaXoq1P0ZWM+WTUdID8mcwP91umDDPAWZ9dch4FqRpyjUQuMeau2BqiNIqKR//S2nfTSDNWEOMVpBRB90iZPI0NEFE3Mx8Z81fZQFcKcD9Fgp18HPnUgFhpFQPTlyaqLoSycsBka2QfjVVdDmTjOhMYn+DRqHjOwtN9Vl0NZSFs2up1/zechAU5v56vVv0pozY2/MuDtpmufeoTWfEOPcTpdINrrxCZLmSi7mYBeOvSEkylJDxXcRYDuylsEazzCwUQLaMbbGqOrAN1V/+c6FgaRZsdLw3jY4NXcTYCjny8xMOhrTkLYPW2u4hA74KGCX15efmNg+Ia0WkCw8clHFzPQdXHBSIgjDPfaQDwLjX/an4HYd419MfDo6FaMZ+GPDnbCyOd632Ig6jhpWAsIFj40nLfvc1aD2BdHuMczUhNoPqM5OGkd6CQFx8Cj5zYAoi2N0V3BuOLFwdUH2rZpGOMOC0YBhqOVowm0bRuscctAlysYbwc9kiDoAc2npidyIAJpwShA1LCjB7TjYT03BEJVwXgjo90wAZp3zdYIgOBz9y8vNMD1+trVA9rpMNoN0HGcb0yAQd/Rati2WwHi/CAfIC0YBxgO3IZAy2jiAxB8e+qLD2X2pGHt/KxmQL5iXHC2guMZiBr+MiCIPtdjCsYB6jXM8vSB5GexRL5gcjS9J0Dt+PSB9OeVFRzPwKOn3nDOpwmE/ALJF0yOpd9cVWA+P02gmF8cYER5JMBgpNyw4NMClvicfm4Gqjcs+nSAhT5uE52ezinuRuwCnwYQ6gsmAYYjVxdoNQCCRMG/yTWPSKnhwvzUgeyPLFvByRWFg6MJtBoAS3x8wSRA3LAjv4ZLfIpAKAC6MbCfD3AdRI78RsYu85lGUx8pePQzH2DSsDIw51MCQmnBzD4uDTAcOR4GNstPCQilAToDIcB1sCcJNstPBVjqc7iCkwDXfc+TXSNVPnkglAFzBf9Or/s6kkC70icNhGIgPg3mCk4DXO8J0G2WnzQQZAtOZyBqWApYk58ssDS/fMFpgOEgBa4a5ScJhPIJmCs4CXC9HsXA2ghrfVJAkC6YzsBjRIGur9+vHBDkC06BizePEbq+79cQS30SQCgBusJBDNtwhIFYSIgx0i8FlvvqgVAB5M4zuYb3UXSdClNlEbHWVwus9OULXqQBHqK8kCgFYq2vDghVwHzBNMD1YL9Hwoje7qRGBPAtXz6/OiBUB5grmM7A438zX9ax+AMlfNVAUCo4C/B4SEY/Hm/8GLztwafAGl8lsNxXWDANkIzFYhEWj6PFJFjjqwICKK3gLMC6EYGVAuvyqwLW+PjTEHYJ14xwBDTBel85EBQLlg0w7ANdxnyCphKwZNdUfJ5ZMAMrC/bpFKz1lQGrfORCwkIzQFSwX7SGTSVgnU8sWDLA8OBahUBTCQjKBUsGGBw9hwXW+wqBoF6wZIDB3sVAIUBTCVjn4y8FqgQYXxMuCNBUAkJ9gELBv6ULLmrYVAIC1M5At68XYHyxAQN9rmFTCQi1wPxpiHSA6FyeHG+p+PJAGV/+IEYyQHSqXBSgqQQEGWBfK8AAXxFWLjgHhDogvqEuFCwXYHw5zhIaNlWAIAEsKFgqwPDgeHQG2vIBskCQAa4GWgEGxyhdIT57KmIqAEEGmL3kRHEGjhy6DVTyZUCQALorsWCpAMN+VrCajwJBDjjQC/DoObxPGQgywKKC5ZbwnqxgNAFVfQlQ6lYB+n/fXnQCJJeDY6CyjwBBEjj4KYxFsAiDoG4X4ukWTICSN6tWy0E2+sk4MOfo5QXz+dnyvBgofbtZeJERHvH1jSiK9vtB3S7E0gOqvOLBJ9f6WBv17Q/luxDOZ6n4TEPtNTfplctMGTOvsbC4YroLsSyN/JSBZHPocsZEOKouWNOnDuRSzIgIGJTtQpr4dIApEygRA723sOQsxGni0weSkQm9fvFZiBig+ZlAvK6TCMt2ISzPVuU1BxIhAhZMQboLoULrK4B+3LEzKJiCUS5ADV9rQK8fyGxhzM8Hoo4xMDoKBR+8FnwtAT1HmIL4LCRfsPmFQGErKBSs52ut4vwUpMcIDRZwW0C8SKKyYwTG90VAsopHYfUuRNvXDlCYguFbW76WEsxNwWBBdyFNfS0Bo+LTTMb3ZUDft4QpmB0jWI19LQDxGuGmYHyM0JavOdASpmC2hbGa+9oBRuW7kKa+pkBxCvK7EN63Y77zj3jshNEF0GWmYHIvJAFyPtjNXmvHzNy1D/SOAbcLKc4PZsOtxBi+7loE+jFwHxTvQnjf41ZyfG8VaFnOKpuC8b2QtGDuKjm8bqXHx65NIFojh5C9F8LxUt+ut1UYs12rCWZTEO9CCvPLF/z+gcY7/uj+4+N+m3zwOCyIsCEQGdwoyLYwuX4pcMcvkNnkcj7HX5qczz6Wvp4vk9N76u+1CQQ6BZktjHCXhgN+x6sL4i+dAHrI9XrxL7Ms4N6uxTm4SqdgOPIdSwrYu+DbYSlw+b6dcb42gUjhHIWCC25Us8DX82TGAHvb2ZnztQuEiO5CLEsKOITz4/2ZqRj5zrNtF0C8iNMpGOyhwscCT+fT9tclBeK2fZhtuwOSHXH4VuljgI9nf8gDfZhsuwGiin3rSJ44YlX6MuAQLmib+CGf4LxZghAlb7+B6leyUeDsfHp/3z4i1/dkDqItTvkcvGsMjC+74VdkSQJP4E/IywJ8VDUGnoZ5IQccN6kYTcFDIFEwA+ydL2jgb76c72PgZJsXMsAbdaDNBbiMp+AS6l6qmFV8wmOJvv10GqZ7kpyQAxrNGsbHgkLBZgUwORwAfleHhdm2OgP2rozbiW6AuGK0FTyGh3pfHvjrDJchafw8wccIQ/8Mk5kINIyN2iqxbRaJp2BwtKD+pag54FA43BrSIzDmaKZ3h5/6puazOZ91XAfXEr4/7lUOWL/TKXi1MX4YExUeGQnSgusgvwspPrvdzVSAr9kU/IE6HmsASdN4CvZlCkbCX/K+YfpNvZvNn/ixVqo8ikRTMEQFy7yY1zSlSx5mx9NXG/JgMC0g9lnBYCLpM3eP73LndPTUHQX4NwI+GHKzkH3/UQq87kN2/lF3EWbX+9+v2vHKHCegjeBD8nA6pfiyGx8wwgVL+pBQapjsDEweTicRIf/+rfTDJeszWx4owOT5g/WzUHh/WbpQuvTdbK7oAxLrdifi+9+Szzr03eGC04d0/lV9WFj0/rzc5+37rv7DPkV0UzENy94/KPlKbd0JyD3mFAuV339pWd350Cb6SnjUruL7L7vD0QWSf1ixTn5d+5jHPeN5aCn5zG5Gr3eV+fhHUxtzS75fsyvfHevjHjmOMny2pfIzO8zvbsr6xIe2L02l9ye3Xu/Nhn+uvJH/owZGRvx0H+Kh+B4q/3AAPoB9sk3rC3w98+aq9g8HpMQlYtjFb6DuStfDvD9l/njFA/qP0+nz0sRr4ZPyQ0sX/da/H+T+ukby1enT0/Od3fnG5e7u5iZetsZDEeX/9BQfz0DgdAcAAAAASUVORK5CYII=";
let LOGO_BYTES = null;
function logo() {
  if (!LOGO_BYTES) {
    const bin = atob(LOGO_B64);
    LOGO_BYTES = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) LOGO_BYTES[i] = bin.charCodeAt(i);
  }
  return new Response(LOGO_BYTES, { headers: { ...CORS, "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
}
const PAGE_CSS = `:root{--bg:#0b0f1e;--card:#141a30;--line:#26305a;--txt:#e9edfb;--mut:#97a3c8;--pri:#6d5dfc}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;background:radial-gradient(1100px 600px at 10% -10%,#2a1f6b 0,transparent 60%) no-repeat,var(--bg);color:var(--txt);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.w{max-width:680px;margin:0 auto;padding:28px 18px 64px}.hd{display:flex;gap:14px;align-items:center}.hd img{width:64px;height:64px;border-radius:16px}
h1{font-size:24px;margin:0}.sub{color:var(--mut);margin:2px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:16px}
.card h2{font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:0 0 10px}
.opt{display:flex;gap:12px;align-items:flex-start;padding:9px 10px;border-radius:12px;cursor:pointer}.opt:hover{background:#1b2342}
.opt input{margin-top:3px;accent-color:var(--pri);transform:scale(1.15)}.opt b{display:block}.opt span{color:var(--mut);font-size:13px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
select{width:100%;background:#0f1428;color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:14px}
.lbl{font-size:13px;color:var(--mut);margin:0 0 6px}
.btn{display:block;text-align:center;padding:14px;border-radius:12px;font-weight:700;text-decoration:none;margin-top:10px;border:0;width:100%;font-size:15px;cursor:pointer}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}@media (max-width:560px){table{font-size:13px}}
.b1{background:linear-gradient(90deg,#6d5dfc,#3d8bfd);color:#fff}.b2{background:#1b2342;color:var(--txt);border:1px solid var(--line)}
.link{margin-top:10px;background:#0f1428;border:1px dashed var(--line);border-radius:10px;padding:10px;font:12px ui-monospace,Menlo,monospace;word-break:break-all;color:#c9d3f5}
.foot{color:var(--mut);font-size:12.5px;margin-top:12px}.foot a{color:#9db4ff}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:700}.g{background:#123d2a;color:#5be39b}.r{background:#4a1620;color:#ff7d8f}.y{background:#463a12;color:#ffd35b}.n{background:#232b4a;color:#aab6dd}`;

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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>⚡ Fast Combo · setup</title><style>${PAGE_CSS} li{margin:6px 0}</style></head>
<body><div class="w"><div class="hd"><img src="/logo.png" alt=""><div><h1>⚡ Fast Combo: one step left</h1><p class="sub">This copy has no access key and password yet, so it's locked.</p></div></div>
<div style="${box}"><b>1.</b> In Cloudflare open this Worker → <b>Settings</b> → <b>Variables and Secrets</b> → <b>+ Add</b>, and add these two (copy each box):</div>
${item("FC_ACCESS_KEY", randomText(12), "Secret")}${item("FC_ADMIN_PASSWORD", randomText(12, 4), "Secret")}
<div style="${box}"><b>2.</b> Press <b>Deploy</b>. <b>Save the password</b> somewhere safe.<br><b>3.</b> Open ${code("/YOUR-ACCESS-KEY/configure")} on this address (example: <span style="word-break:break-all">this-address/<b>abc123…</b>/configure</span>) and log in with the password.</div>
<div style="${box}"><b>Optional: live sync</b> (changes reach Stremio without reinstalling)<ol style="padding-left:20px;margin:6px 0 0"><li>This Worker → <b>Bindings</b> → <b>Add binding</b> → <b>KV namespace</b> (not D1 database).</li><li>Variable name ${code("FC_KV")}${btn("FC_KV")} (any name works). KV namespace: pick ${code("fastcombo")}, or type it and choose the one marked <b>new</b>.</li><li>Click <b>Add binding</b>: it goes live at once, no separate Deploy. Ignore any example code and the "Update your Wrangler configuration" message.</li></ol></div>
<p class="sub" style="margin-top:14px">On Node.js, Docker or a VPS you won't see this page: the key and password are created on the first start.</p>
</div><script>document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;var t=b.getAttribute("data-copy"),done=function(){b.textContent="Copied ✓";setTimeout(function(){b.textContent="Copy"},1500)};if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(t).then(done,function(){prompt("Copy this:",t)});else prompt("Copy this:",t)});</script></body></html>`;
}
function landingPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>⚡ Fast Combo</title><style>${PAGE_CSS}</style></head>
<body><div class="w"><div class="hd"><img src="/logo.png" alt=""><div><h1>⚡ Fast Combo</h1><p class="sub">This Stremio addon server is running. Open your private link to install it or manage your addons.</p></div></div></div></body></html>`;
}

// ---------------------------------------------------------- control panel API
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
<meta name="theme-color" content="#0a0e1c">
<title>Fast Combo · Control panel</title>
<link rel="icon" href="/logo.png">
<style>
:root{--bg:#0a0e1c;--line:#253058;--line2:#313d6e;--txt:#e8ecfa;--mut:#97a3c8;--dim:#6f7aa3;--pri:#7c6cff;--pri2:#3d8bfd;--r:16px}
*{box-sizing:border-box}
html{background:var(--bg);-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;color:var(--txt);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif;background:radial-gradient(1000px 520px at -5% -10%,rgba(124,108,255,.26),transparent 60%),radial-gradient(800px 480px at 105% -5%,rgba(61,139,253,.2),transparent 60%),var(--bg);background-repeat:no-repeat;background-attachment:fixed}
a{color:#a8b8ff}
button,input,select{font:inherit;color:inherit}
.hidden{display:none!important}
.wrap{max-width:1000px;margin:0 auto;padding:18px 16px 120px}
.top{display:flex;align-items:center;gap:14px;margin:4px 0 18px}
.top .logo{width:54px;height:54px;border-radius:15px;box-shadow:0 8px 28px rgba(124,108,255,.35);flex:none}
.top h1{margin:0;font-size:22px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.top p{margin:2px 0 0;color:var(--mut);font-size:13.5px}
.top .right{margin-left:auto}
.ver{font-size:11px;font-weight:700;color:#cfc8ff;background:rgba(124,108,255,.16);border:1px solid rgba(124,108,255,.35);padding:1px 7px;border-radius:99px;vertical-align:middle}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700;white-space:nowrap;border:1px solid transparent}
.pill.g{background:rgba(47,210,122,.12);color:#5ff0a3;border-color:rgba(47,210,122,.3)}
.pill.y{background:rgba(255,201,77,.12);color:#ffd36e;border-color:rgba(255,201,77,.3)}
.pill.r{background:rgba(255,92,122,.12);color:#ff8aa1;border-color:rgba(255,92,122,.32)}
.pill.b{background:rgba(124,108,255,.14);color:#c9c1ff;border-color:rgba(124,108,255,.32)}
.pill.n{background:rgba(149,161,198,.1);color:#aab4d6;border-color:rgba(149,161,198,.25)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.pill.g .dot{animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(95,240,163,.55)}70%{box-shadow:0 0 0 7px rgba(95,240,163,0)}100%{box-shadow:0 0 0 0 rgba(95,240,163,0)}}
.tabs{display:flex;gap:4px;padding:5px;background:rgba(13,18,38,.88);border:1px solid var(--line);border-radius:14px;position:sticky;top:10px;z-index:20;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{flex:1 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;background:none;color:var(--mut);padding:9px 14px;border-radius:10px;font-weight:650;font-size:14px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s}
.tabs button:hover{color:var(--txt);background:rgba(255,255,255,.04)}
.tabs button.on{color:#fff;background:linear-gradient(135deg,var(--pri),var(--pri2));box-shadow:0 4px 16px rgba(92,110,255,.35)}
.card{background:linear-gradient(180deg,rgba(22,29,61,.92),rgba(17,23,49,.92));border:1px solid var(--line);border-radius:var(--r);padding:18px;margin:16px 0;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.card h2{margin:0 0 4px;font-size:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.lead{margin:0 0 14px;color:var(--mut);font-size:13.5px}
.card-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.card-h h2{margin:0}
.mut{color:var(--mut)}.small{font-size:12.5px}.center{text-align:center}
.row{display:flex;gap:10px;align-items:center}
.field{flex:1;min-width:0;width:100%;background:#0c1124;border:1px solid var(--line2);border-radius:12px;padding:12px 14px;outline:none;transition:border-color .15s,box-shadow .15s}
.field:focus{border-color:var(--pri);box-shadow:0 0 0 3px rgba(124,108,255,.25)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--line2);background:#1a2246;color:var(--txt);padding:11px 16px;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none;white-space:nowrap;transition:transform .05s,filter .15s}
.btn:hover{filter:brightness(1.13)}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.55;cursor:default;filter:none}
.btn.pri{border:0;background:linear-gradient(135deg,var(--pri),var(--pri2));color:#fff;box-shadow:0 6px 18px rgba(92,110,255,.35)}
.btn.ok{border:0;background:linear-gradient(135deg,#1fbf6b,#169e9a);color:#fff;box-shadow:0 6px 18px rgba(31,191,107,.25)}
.btn.ghost{background:transparent}
.btn.sm{padding:7px 12px;font-size:13px;border-radius:10px}
.btn.danger{color:#ff8aa1;border-color:rgba(255,92,122,.4);background:rgba(255,92,122,.08)}
.ib{width:34px;height:34px;display:inline-grid;place-items:center;border-radius:10px;border:1px solid var(--line2);background:#141b3a;color:var(--mut);cursor:pointer;font-size:13px;flex:none}
.ib:hover{color:var(--txt);border-color:var(--pri)}
.ib:disabled{opacity:.3;cursor:default}
.hint{color:var(--dim);font-size:12.5px;margin:10px 2px 0}
.addon{display:flex;flex-wrap:wrap;gap:12px 14px;align-items:center;padding:14px;border:1px solid var(--line);border-radius:14px;background:rgba(12,17,36,.55);margin-top:10px;transition:opacity .2s,border-color .2s}
.addon:hover{border-color:var(--line2)}
.addon.off{opacity:.55}
.alogo{width:46px;height:46px;border-radius:12px;object-fit:cover;background:#0c1124;flex:none}
.ainfo{flex:1;min-width:200px}
.aname{font-weight:750;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aurl{color:var(--dim);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;max-width:520px}
.astats{color:var(--mut);font-size:12.5px;margin-top:4px;display:flex;gap:4px 14px;flex-wrap:wrap}
.aerr{color:#ff9fb2;font-size:12.5px;margin-top:4px}
.actl{display:flex;gap:6px;align-items:center;flex:none}
.amore{flex-basis:100%;display:flex;gap:8px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--line)}
.sel{background:#0c1124;border:1px solid var(--line2);border-radius:10px;padding:7px 9px;font-size:13px;color:var(--txt);max-width:100%}
.switch{position:relative;width:44px;height:26px;flex:none;display:inline-block}
.switch input{opacity:0;width:0;height:0;position:absolute}
.switch span{position:absolute;inset:0;background:#2a3359;border-radius:99px;cursor:pointer;transition:background .2s}
.switch span:before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 2px 6px rgba(0,0,0,.3)}
.switch input:checked+span{background:linear-gradient(135deg,#21c472,#16a59c)}
.switch input:checked+span:before{transform:translateX(18px)}
.switch input:focus-visible+span{box-shadow:0 0 0 3px rgba(124,108,255,.45)}
.empty{padding:26px;text-align:center;color:var(--mut);border:1px dashed var(--line2);border-radius:14px;margin-top:12px}
.preview{margin-top:14px;border:1px solid var(--line2);border-radius:14px;padding:16px;background:rgba(10,14,30,.6);animation:fade .25s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.pv-h{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.pv-h img{width:56px;height:56px;border-radius:14px;object-fit:cover;background:#0c1124;flex:none}
.pv-h h3{margin:0;font-size:17px}
.pv-desc{color:var(--mut);font-size:13px;margin:4px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.chip{font-size:12px;padding:3px 9px;border-radius:99px;background:#1a2246;border:1px solid var(--line2);color:#c7cfee}
.chip.on{background:rgba(124,108,255,.18);border-color:rgba(124,108,255,.5);color:#fff}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:14px}
.kv div{background:#0f1530;border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.kv b{display:block;font-size:19px;letter-spacing:-.01em}
.kv span{color:var(--mut);font-size:12px}
.warn,.err,.okbox{margin-top:12px;padding:10px 12px;border-radius:12px;font-size:13.5px}
.warn{background:rgba(255,201,77,.08);border:1px solid rgba(255,201,77,.3);color:#ffdc94}
.err{background:rgba(255,92,122,.08);border:1px solid rgba(255,92,122,.35);color:#ffb3c1}
.okbox{background:rgba(47,210,122,.08);border:1px solid rgba(47,210,122,.3);color:#a3f5c8}
.loading{display:flex;align-items:center;gap:12px;color:var(--mut);margin-top:14px}
.spin{width:18px;height:18px;border-radius:50%;border:2px solid rgba(255,255,255,.15);border-top-color:#a99dff;animation:spin .8s linear infinite;flex:none;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
.opt{display:flex;gap:12px;align-items:flex-start;padding:11px 12px;border-radius:12px;cursor:pointer;border:1px solid var(--line);background:rgba(12,17,36,.45)}
.opt:hover{border-color:var(--line2)}
.opt.on{border-color:rgba(124,108,255,.65);background:rgba(124,108,255,.1)}
.opt input{margin-top:4px;accent-color:var(--pri);transform:scale(1.15)}
.opt b{display:block;font-size:14.5px}
.opt span{color:var(--mut);font-size:12.5px}
.lbl{display:block;font-size:13px;color:var(--mut);margin:0 0 6px;font-weight:600}
.select{width:100%;background:#0c1124;border:1px solid var(--line2);border-radius:12px;padding:11px 12px;font-size:14px;color:var(--txt)}
.tg{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 2px;border-top:1px solid var(--line)}
.tg:first-of-type{border-top:0}
.tg b{display:block;font-size:14.5px}
.tg span{color:var(--mut);font-size:12.5px}
.langs{display:flex;flex-wrap:wrap;gap:8px}
.langs button{border:1px solid var(--line2);background:#121a38;color:#c7cfee;border-radius:99px;padding:6px 13px;font-size:13px;cursor:pointer}
.langs button.on{background:linear-gradient(135deg,rgba(124,108,255,.4),rgba(61,139,253,.4));border-color:rgba(124,108,255,.75);color:#fff}
.results{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:12px;margin-top:14px}
.tile{background:#0f1530;border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:pointer;transition:transform .12s,border-color .12s;text-align:left;padding:0;color:var(--txt)}
.tile:hover{transform:translateY(-2px);border-color:var(--pri)}
.tile.sel{border-color:var(--pri);box-shadow:0 0 0 2px rgba(124,108,255,.45)}
.tile .ph{aspect-ratio:2/3;background:#0c1124;display:grid;place-items:center;color:var(--dim);font-size:28px;position:relative;overflow:hidden}
.tile .ph img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.tile .tt{padding:7px 9px 9px;font-size:12.5px;line-height:1.3}
.tile .tt b{display:block;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile .tt span{color:var(--dim)}
.picked{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px;padding:12px;border:1px solid var(--line2);border-radius:14px;background:rgba(10,14,30,.6)}
.picked img{width:46px;height:69px;object-fit:cover;border-radius:8px;background:#0c1124}
.stream{display:grid;grid-template-columns:120px 1fr auto;gap:14px;padding:13px 14px;border:1px solid var(--line);border-radius:14px;background:rgba(12,17,36,.6);margin-top:10px;align-items:start}
.stream.new{border-color:rgba(47,210,122,.45);box-shadow:inset 3px 0 0 #2fd27a}
.sname{white-space:pre-line;font-weight:800;font-size:15px;line-height:1.35}
.sdesc{white-space:pre-line;font-size:13px;color:#cdd4f0;line-height:1.6;min-width:0;overflow-wrap:anywhere}
.sum{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.bars{margin-top:10px;display:grid;gap:7px}
.bar{display:grid;grid-template-columns:minmax(120px,260px) 1fr 40px;gap:10px;align-items:center;font-size:12.5px;color:var(--mut)}
.bar i{display:block;height:8px;border-radius:99px;background:linear-gradient(90deg,#ff6b86,#ffa25c)}
.bar b{text-align:right;color:var(--txt)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--mut);font-weight:650;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
td.sub{color:var(--dim);font-size:12px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:6px}
.stat{background:#0f1530;border:1px solid var(--line);border-radius:14px;padding:14px}
.stat b{display:block;font-size:22px;letter-spacing:-.02em}
.stat span{color:var(--mut);font-size:12.5px}
.linkbox{background:#0a0f22;border:1px dashed var(--line2);border-radius:12px;padding:12px;font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:#cbd5ff}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.steps{margin:8px 0 0;padding-left:20px;color:#cdd4f0;font-size:14px}
.steps li{margin:7px 0}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0c1124;border:1px solid var(--line);padding:1px 6px;border-radius:6px}
details summary{cursor:pointer;color:#b9c3e6;font-size:13.5px;margin-top:12px;font-weight:600}
.savebar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;padding:9px 9px 9px 18px;background:rgba(22,28,60,.97);border:1px solid rgba(124,108,255,.55);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.5);z-index:40;max-width:calc(100% - 24px);animation:fade .2s ease}
.savebar span{font-weight:650;font-size:14px;margin-right:6px;white-space:nowrap}
.toast{position:fixed;left:50%;top:18px;transform:translateX(-50%) translateY(-16px);opacity:0;pointer-events:none;background:#1b2350;border:1px solid var(--line2);padding:11px 16px;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.45);z-index:60;transition:opacity .2s,transform .2s;font-weight:600;font-size:14px;max-width:calc(100% - 24px)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.ok{border-color:rgba(47,210,122,.6)}.toast.bad{border-color:rgba(255,92,122,.7)}
.narrow{max-width:430px;margin:48px auto}
.login-logo{display:block;width:76px;height:76px;border-radius:20px;margin:4px auto 14px;box-shadow:0 10px 30px rgba(124,108,255,.38)}
.foot{color:var(--dim);font-size:12px;text-align:center;margin-top:28px}
@media (max-width:560px){.tabs{gap:2px;padding:4px}.tabs button{flex:1 1 0;flex-direction:column;gap:1px;padding:6px 2px;font-size:11.5px;line-height:1.2}.tabs .ti{font-size:17px}.top .ver{display:none}.top h1{white-space:nowrap}.wrap{padding-left:12px;padding-right:12px}.tiles,.kv{grid-template-columns:1fr 1fr}.stat b,.kv b{font-size:18px}}
@media (max-width:720px){.grid2{grid-template-columns:1fr}.actl{width:100%;justify-content:flex-end}.stream{grid-template-columns:1fr}.top h1{font-size:19px}.top p{display:none}.bar{grid-template-columns:110px 1fr 30px}.card{padding:15px}.savebar span{display:none}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <img class="logo" src="/logo.png" alt="">
    <div><h1>Fast Combo <span class="ver" id="ver"></span></h1><p>Your addons in one · only working, fast 1080p &amp; 4K</p></div>
    <div class="right"><span id="live" class="pill n"><span class="dot"></span>Connecting…</span></div>
  </header>

  <section id="login" class="card narrow center hidden">
    <img class="login-logo" src="/logo.png" alt="">
    <h2 style="justify-content:center">Control panel</h2>
    <p class="lead">Enter your admin password to manage your addons.</p>
    <form id="loginForm">
      <input id="pass" class="field" type="password" placeholder="Admin password" autocomplete="current-password">
      <label class="row small mut" style="justify-content:center;margin:12px 0;gap:6px"><input type="checkbox" id="remember" checked> Remember on this device</label>
      <button class="btn pri" type="submit" style="width:100%">Unlock</button>
    </form>
    <div id="loginErr" class="err hidden"></div>
  </section>

  <main id="app" class="hidden">
    <nav class="tabs" id="tabs">
      <button type="button" data-tab="addons"><span class="ti">🧩</span>Addons</button>
      <button type="button" data-tab="ai"><span class="ti">🤖</span>AI best</button>
      <button type="button" data-tab="settings"><span class="ti">⚙️</span>Settings</button>
      <button type="button" data-tab="try"><span class="ti">🔎</span>Try it</button>
      <button type="button" data-tab="health"><span class="ti">🩺</span>Health</button>
      <button type="button" data-tab="install"><span class="ti">📲</span>Install</button>
    </nav>

    <section data-pane="addons">
      <div class="card">
        <h2>Add an addon</h2>
        <p class="lead">Paste the install link of a Stremio addon you use. It is tested live before it is added.</p>
        <form id="addForm" class="row">
          <input id="addUrl" class="field" placeholder="https://…/manifest.json  or  stremio://…" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="btn pri" id="addBtn" type="submit">Check</button>
        </form>
        <div id="inspect"></div>
      </div>
      <div class="card">
        <div class="card-h"><h2>Your addons</h2><span class="mut small" id="addonCount"></span></div>
        <p class="lead">All switched-on addons are asked at the same time. Dead or slow ones are skipped automatically and retried later. <b>Priority</b> decides which addon's link wins when two have the same file.</p>
        <div id="addonList"></div>
      </div>
    </section>

    <section data-pane="ai" class="hidden">
      <div class="card">
        <h2>🤖 AI: find the best addon</h2>
        <p class="lead">Searches Stremio's public community catalog for scrapers, ranks them by installs, then <b>live-tests the top ones</b> (real 1080p / 4K + links that actually start) so you end up with the best one. <b>Nothing is added until you press Add.</b></p>
        <form id="aiForm" class="row" style="align-items:flex-end">
          <div style="flex:1;min-width:0"><label class="lbl">What do you want?</label><input id="aiQ" class="field" placeholder="e.g. 4k, anime, torbox, subtitles — or leave empty for the best overall" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
          <button class="btn pri" id="aiBtn" type="submit">🔎 Find the best</button>
        </form>
        <label class="row small mut" style="gap:6px;margin-top:12px"><input type="checkbox" id="aiTest" checked> Live-test the top candidates (more accurate, ~10–25 s)</label>
        <div id="aiOut"></div>
      </div>
    </section>

    <section data-pane="settings" class="hidden"><div id="settingsBody"></div></section>

    <section data-pane="try" class="hidden">
      <div class="card">
        <h2>Try it</h2>
        <p class="lead">See exactly what Stremio will get for any movie or episode, and why other streams were removed.</p>
        <form id="searchForm" class="row">
          <input id="q" class="field" placeholder="Search a movie or series…  (or paste an ID like tt1375666)" autocomplete="off">
          <button class="btn pri" type="submit">Search</button>
        </form>
        <div id="results"></div>
        <div id="picked"></div>
      </div>
      <div id="tryOut"></div>
    </section>

    <section data-pane="health" class="hidden">
      <div class="card">
        <div class="card-h"><h2>Live health</h2><div class="row"><label class="row small mut" style="gap:6px"><input type="checkbox" id="autoH" checked> Auto-refresh</label><button type="button" class="btn sm" id="pingBtn">↻ Check addons now</button></div></div>
        <div class="tiles" id="hTiles"></div>
        <p class="hint" id="hNote"></p>
      </div>
      <div class="card"><h2>Addons</h2><div class="tw" id="hAddons"></div></div>
      <div class="card"><h2>File hosts</h2><p class="lead">From live link tests in the last 30 minutes. Failing hosts are skipped automatically.</p><div class="tw" id="hHosts"></div></div>
      <div class="card"><h2>Recent requests</h2><div class="tw" id="hRecent"></div></div>
    </section>

    <section data-pane="install" class="hidden">
      <div class="card">
        <h2>Install in Stremio</h2>
        <div id="installNote" class="okbox hidden">✅ Saved. Your addon list is inside this new link. Remove the old Fast Combo in Stremio, then install this one.</div>
        <div class="linkbox" id="instLink" style="margin-top:12px"></div>
        <div class="btns">
          <a class="btn pri" id="instApp" href="#">📲 Install in Stremio app</a>
          <a class="btn" id="instWeb" href="#" target="_blank" rel="noopener">🌐 Stremio Web</a>
          <button type="button" class="btn" id="instCopy">📋 Copy link</button>
        </div>
        <p class="hint">Keep this link private — it uses your addons.</p>
      </div>
      <div class="card" id="modeCard"></div>
    </section>
    <p class="foot">⚡ Fast Combo <span id="ver2"></span> · uses only the addons you add · <a href="#health">health</a></p>
  </main>

  <div id="saveBar" class="savebar hidden"><span>Unsaved changes</span><button type="button" class="btn ghost sm" id="undoBtn">Undo</button><button type="button" class="btn pri sm" id="saveBtn">Save changes</button></div>
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
function fmtMs(ms) { if (ms == null || ms === '' || isNaN(ms)) return '—'; ms = +ms; return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 9950 ? 1 : 0) + ' s'; }
function ago(t) { if (!t) return '—'; var s = Math.max(0, Math.round((Date.now() - t) / 1000)); if (s < 45) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; }
function dur(ms) { var m = Math.round(ms / 60000); if (m < 60) return m + ' min'; if (m < 2880) return Math.round(m / 60) + ' h'; return Math.round(m / 1440) + ' days'; }
function shortUrl(u) { try { var x = new URL(u), p = x.pathname; if (p.length > 42) p = p.slice(0, 16) + '…' + p.slice(-22); return x.host + p; } catch (e) { return u; } }
function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
function onCount() { return S.prof ? S.prof.addons.filter(function (a) { return a.on; }).length : 0; }
function toast(msg, kind) { var t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + (kind || ''); clearTimeout(toast.t); toast.t = setTimeout(function () { t.className = 'toast ' + (kind || ''); }, 3800); }
function copy(text, label) {
  var done = function () { toast('📋 ' + (label || 'Copied')); };
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
  }, function () { throw new Error('Can’t reach the server. Check your internet connection.'); });
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
    if (p.badToken) toast('⚠️ This link could not be read (old or changed secret) — showing saved setup', 'bad');
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
var AST = { working: ['g', 'Working'], slow: ['y', 'Slow'], failing: ['y', 'Last try failed'], down: ['r', 'Down · paused'], unknown: ['n', 'Ready'], off: ['n', 'Off'] };
function statusOf(a) { if (!a.on) return AST.off; var h = healthOf(a.id); return h ? (AST[h.status] || ['n', h.status]) : ['b', 'Not saved yet']; }
function renderAddons() {
  var L = S.prof.addons, el = $('#addonList');
  $('#addonCount').textContent = onCount() + ' on · ' + L.length + ' of ' + B.maxAddons;
  if (!L.length) { el.innerHTML = '<div class="empty">No addons yet. Paste an addon link above to add your first one.</div>'; return; }
  el.innerHTML = L.map(function (a, i) {
    var m = S.meta[a.id] || {}, h = healthOf(a.id), st = statusOf(a), bits = [];
    if (h && h.avgMs) bits.push('⏱ ' + fmtMs(h.avgMs) + ' avg answer');
    if (h && h.lastCount != null) bits.push('📦 ' + h.lastCount + ' streams last time');
    if (h && (h.ok || h.fail)) bits.push('✅ ' + h.ok + ' · ❌ ' + h.fail);
    if (m.version) bits.push('v' + esc(m.version));
    return '<div class="addon' + (a.on ? '' : ' off') + '" data-i="' + i + '">' +
      '<img class="alogo" alt="" src="' + esc(m.logo || '/logo.png') + '" onerror="this.onerror=null;this.src=\'/logo.png\'">' +
      '<div class="ainfo"><div class="aname"><span>' + esc(a.name) + '</span><span class="pill ' + st[0] + '"><span class="dot"></span>' + st[1] + '</span>' +
      (a.w > 0 ? '<span class="pill b">▲ High priority</span>' : a.w < 0 ? '<span class="pill n">▼ Low priority</span>' : '') + '</div>' +
      '<div class="aurl" title="' + esc(a.url) + '">' + esc(shortUrl(a.url)) + '</div>' +
      (bits.length ? '<div class="astats">' + bits.map(function (b) { return '<span>' + b + '</span>'; }).join('') + '</div>' : '') +
      (h && h.lastErr ? '<div class="aerr">⚠ ' + esc(h.lastErr) + '</div>' : '') + '</div>' +
      '<div class="actl">' +
      '<select class="sel" data-act="w" title="Priority"><option value="1"' + (a.w > 0 ? ' selected' : '') + '>High</option><option value="0"' + (!a.w ? ' selected' : '') + '>Normal</option><option value="-1"' + (a.w < 0 ? ' selected' : '') + '>Low</option></select>' +
      '<label class="switch" title="Switch on / off"><input type="checkbox" data-act="on"' + (a.on ? ' checked' : '') + '><span></span></label>' +
      '<button type="button" class="ib" data-act="up" title="Move up"' + (i ? '' : ' disabled') + '>▲</button>' +
      '<button type="button" class="ib" data-act="down" title="Move down"' + (i < L.length - 1 ? '' : ' disabled') + '>▼</button>' +
      '<button type="button" class="ib" data-act="more" title="More">⋯</button></div>' +
      '<div class="amore hidden"><button type="button" class="btn sm" data-act="ren">✏️ Rename</button><button type="button" class="btn sm" data-act="copy">📋 Copy addon link</button><button type="button" class="btn sm" data-act="recheck">🔁 Test again</button><button type="button" class="btn sm danger" data-act="del">🗑 Remove</button></div>' +
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
  else if (act === 'del') { if (!window.confirm('Remove “' + a.name + '” from Fast Combo?')) return; L.splice(i, 1); }
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
  $('#inspect').innerHTML = '<div class="loading"><div class="spin"></div><div>Testing it live: opening the addon, running a test search and checking a few links… <span style="color:var(--dim)">(up to 25 s)</span></div></div>';
  api('inspect', { url: url }).then(renderInspect).catch(function (e) { if (!e.login) $('#inspect').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; })
    .then(function () { btn.disabled = false; btn.textContent = 'Check'; });
}
function verdict(r) {
  var s = r.sample;
  if (!s) return (r.resources || []).indexOf('stream') < 0 ? ['y', 'Online · no streams'] : ['g', 'Online'];
  if (s.error) return ['r', 'Online, but the test search failed'];
  if (!s.total) return ['y', 'Online, but found nothing in the test'];
  if (!(s.hd + s.uhd)) return ['y', 'Works, but no 1080p / 4K in the test'];
  if (s.linksTested && !s.linksOk) return ['y', 'Works, but its test links didn’t start'];
  if (s.ms > 9000) return ['y', 'Works, but slow (' + fmtMs(s.ms) + ')'];
  return ['g', 'Works · has 1080p / 4K'];
}
function renderInspect(r) {
  S.inspect = r;
  var box = $('#inspect');
  if (!r.ok) { box.innerHTML = '<div class="err">❌ ' + esc(r.error) + '</div>'; return; }
  var already = S.prof.addons.some(function (a) { return a.id === r.aid; });
  var full = !already && S.prof.addons.length >= B.maxAddons;
  var v = verdict(r), s = r.sample, tiles = ['<div><b>' + fmtMs(r.manifestMs) + '</b><span>to open the addon</span></div>'];
  if (s && !s.error) {
    tiles.push('<div><b>' + s.total + '</b><span>streams for ' + esc(s.label) + ' · ' + fmtMs(s.ms) + '</span></div>');
    tiles.push('<div><b>' + s.uhd + ' · ' + s.hd + '</b><span>in 4K · in 1080p</span></div>');
    if (s.linksTested) tiles.push('<div><b>' + s.linksOk + ' / ' + s.linksTested + '</b><span>test links started' + (s.linksMs ? ' · fastest ' + fmtMs(s.linksMs) : '') + '</span></div>');
    else if (s.p2p) tiles.push('<div><b>' + s.p2p + '</b><span>torrent streams</span></div>');
  }
  var chips = (r.types || []).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') +
    (r.resources || []).map(function (t) { return '<span class="chip on">' + esc(t) + '</span>'; }).join('') +
    (r.catalogs ? '<span class="chip">' + plural(r.catalogs, 'catalog') + '</span>' : '');
  var warns = (r.warnings || []).map(function (w) { return '<div class="warn">⚠️ ' + esc(w) + '</div>'; }).join('');
  var action = already ? '<button type="button" class="btn" disabled>✓ Already in your list</button>' : full ? '<button type="button" class="btn" disabled>Your list is full (' + B.maxAddons + ')</button>' : '<button type="button" class="btn ok" id="doAdd">＋ Add to Fast Combo</button>';
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
  $('#inspect').innerHTML = '<div class="okbox">✅ <b>' + esc(r.name) + '</b> is in your list. Press <b>Save changes</b> to start using it.</div>';
  renderAddons(); markDirty();
});

/* ---------- save ---------- */
$('#undoBtn').addEventListener('click', function () { S.prof = JSON.parse(S.saved); renderAddons(); renderSettings(); markDirty(); toast('Changes undone'); });
$('#saveBtn').addEventListener('click', function () {
  var btn = $('#saveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
  api('profile', { addons: S.prof.addons, settings: S.prof.settings }).then(function (r) {
    if (!r.ok) throw new Error(r.error || 'Could not save');
    S.saved = snap(); markDirty();
    if (r.mode === 'link') {
      S.token = r.token;
      try { history.replaceState(null, '', '/' + B.key + '/' + r.token + '/configure#install'); } catch (e) {}
      $('#installNote').classList.remove('hidden'); showTab('install');
      toast('✅ Saved. Install the new link to apply it', 'ok');
    } else {
      if (S.token) { S.token = ''; try { history.replaceState(null, '', '/' + B.key + '/configure' + location.hash); } catch (e) {} renderInstall(); }
      toast('✅ Saved. Stremio gets it automatically (within a minute)', 'ok');
    }
    setTimeout(function () { refreshHealth(false); }, 400);
  }).catch(function (e) { if (!e.login) toast('❌ ' + e.message, 'bad'); })
    .then(function () { btn.disabled = false; btn.textContent = 'Save changes'; });
});

/* ---------- settings ---------- */
var SORTS = [['balanced', '⚖️ Balanced', 'Working, fast links first. Mixes 4K and 1080p; smaller files win ties.'], ['smallest', '🪶 Smallest first', 'Lowest bitrate first: starts fastest, best for slow internet.'], ['4kfirst', '🔥 4K first', 'All 4K on top, then 1080p.'], ['1080first', '🚀 1080p first', '1080p on top (lighter), then 4K.']];
var M1080 = [[4, '4 Mbps · ≈3.6 GB per 2 h movie'], [6, '6 Mbps · ≈5.4 GB'], [8, '8 Mbps · ≈7 GB (default)'], [12, '12 Mbps · ≈11 GB'], [16, '16 Mbps · ≈14 GB'], [0, 'No limit']];
var M4K = [[10, '10 Mbps · ≈9 GB per 2 h movie'], [15, '15 Mbps · ≈13.5 GB'], [20, '20 Mbps · ≈18 GB (default)'], [30, '30 Mbps · ≈27 GB'], [40, '40 Mbps · ≈36 GB'], [0, 'No limit']];
var LIMITS = [[10, '10 streams'], [15, '15 streams'], [20, '20 streams'], [30, '30 streams'], [50, '50 streams']];
var RES = [['2160', '4K'], ['1080', '1080p'], ['720', '720p · slow internet']];
var TOGGLES = [['test', '🧪 Test links live', 'Checks links before showing them and hides the dead ones.'], ['newBadge', '🆕 Mark new links', 'Links that appear after you first opened a title get a 🆕 badge for ' + B.newHours + ' h.'], ['remux', '💿 Allow REMUX', 'Untouched Blu-ray copies: huge files, slow to buffer.'], ['hideDV', '🟣 Hide Dolby-Vision-only', 'For TVs without Dolby Vision (wrong purple / green colours).'], ['hideAV1', '🧩 Hide AV1', 'For older devices that can’t play AV1.']];
function options(list, cur) {
  if (!list.some(function (o) { return +o[0] === +cur; })) list = list.concat([[cur, cur + ' (custom)']]);
  return list.map(function (o) { return '<option value="' + o[0] + '"' + (+o[0] === +cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
}
function renderSettings() {
  var s = S.prof.settings, res = String(s.res || '').split(','), lang = String(s.lang || '').split(',').filter(Boolean);
  var h = '<div class="card"><h2>Order</h2><p class="lead">How streams are sorted in Stremio.</p><div class="grid2">' +
    SORTS.map(function (o) { var on = s.sort === o[0]; return '<label class="opt' + (on ? ' on' : '') + '"><input type="radio" name="sort" value="' + o[0] + '"' + (on ? ' checked' : '') + '><div><b>' + o[1] + '</b><span>' + o[2] + '</span></div></label>'; }).join('') + '</div></div>';
  h += '<div class="card"><h2>Quality &amp; size</h2><p class="lead">A lower bitrate means a smaller file, so it buffers faster.</p><label class="lbl">Qualities to keep</label><div class="langs" data-group="res">' +
    RES.map(function (o) { return '<button type="button" data-v="' + o[0] + '" class="' + (res.indexOf(o[0]) >= 0 ? 'on' : '') + '">' + o[1] + '</button>'; }).join('') + '</div>' +
    '<div class="grid2" style="margin-top:16px"><div><label class="lbl">Biggest 1080p allowed</label><select class="select" data-k="max1080">' + options(M1080, s.max1080) + '</select></div>' +
    '<div><label class="lbl">Biggest 4K allowed</label><select class="select" data-k="max4k">' + options(M4K, s.max4k) + '</select></div>' +
    '<div><label class="lbl">Show up to</label><select class="select" data-k="limit">' + options(LIMITS, s.limit) + '</select></div></div></div>';
  h += '<div class="card"><h2>Links</h2>' + TOGGLES.map(function (o) { return '<div class="tg"><div><b>' + o[1] + '</b><span>' + esc(o[2]) + '</span></div><label class="switch"><input type="checkbox" data-k="' + o[0] + '"' + (s[o[0]] ? ' checked' : '') + '><span></span></label></div>'; }).join('') + '</div>';
  h += '<div class="card"><h2>Preferred audio languages</h2><p class="lead">Streams in these languages are moved up. Nothing is hidden.</p><div class="langs" data-group="lang">' +
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
  if (idm && !idm[2]) { // bare IMDb id → ask whether it is a movie or a series
    $('#results').innerHTML = '<div class="loading"><div class="spin"></div>Looking it up…</div>';
    api('title?id=' + encodeURIComponent(idm[1].toLowerCase())).then(function (r) {
      $('#results').innerHTML = '';
      if (!r.ok) { $('#results').innerHTML = '<div class="err">' + esc(r.error || 'Not found') + '</div>'; return; }
      S.eps = r.eps; pickTitle({ id: r.id, type: r.type, name: r.name, year: r.year, poster: r.poster }, r.eps);
    }).catch(function (e) { if (!e.login) $('#results').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
    return;
  }
  if (idm || km) { $('#results').innerHTML = ''; pickTitle({ id: q, type: (idm ? !!idm[2] : q.split(':').length > 2) ? 'series' : 'movie', name: q, direct: true }); return; }
  $('#results').innerHTML = '<div class="loading"><div class="spin"></div>Searching…</div>';
  api('search?q=' + encodeURIComponent(q)).then(function (r) {
    var m = (r && r.metas) || []; S.found = m;
    if (!m.length) { $('#results').innerHTML = '<div class="empty">Nothing found for “' + esc(q) + '”.</div>'; return; }
    $('#results').innerHTML = '<div class="results">' + m.map(function (x, i) {
      return '<button type="button" class="tile" data-i="' + i + '"><div class="ph">🎬' + (x.poster ? '<img loading="lazy" alt="" src="' + esc(x.poster) + '" onerror="this.remove()">' : '') + '</div><div class="tt"><b>' + esc(x.name) + '</b><span>' + esc(x.year || '') + ' · ' + (x.type === 'series' ? 'Series' : 'Movie') + '</span></div></button>';
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
    '<div style="flex:1;min-width:150px"><b>' + esc(x.name) + '</b><div class="mut small">' + esc((x.year ? x.year + ' · ' : '') + (x.type === 'series' ? 'Series' : 'Movie') + ' · ' + x.id) + '</div></div>' +
    (series ? '<select class="sel" id="seaSel"><option value="">Loading…</option></select><select class="sel" id="epSel"></select>' : '') +
    '<label class="row small mut" style="gap:6px" title="Ask the addons again right now instead of using the last result"><input type="checkbox" id="liveChk"> Skip cache</label>' +
    '<button type="button" class="btn pri" id="goTry">Find streams</button></div>';
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
  $('#epSel').innerHTML = list.map(function (e) { return '<option value="' + e[1] + '">E' + e[1] + (e[2] ? ' · ' + esc(e[2].slice(0, 30)) : '') + '</option>'; }).join('');
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
  out.innerHTML = '<div class="card"><div class="loading" style="margin:0"><div class="spin"></div>Asking ' + plural(onCount(), 'addon') + ' and testing links live… usually 2–8 s</div></div>';
  var btn = $('#goTry'); if (btn) btn.disabled = true;
  api('try/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + (fresh ? '?fresh=1' : '')).then(function (r) { renderTry(r, Date.now() - t0); out.scrollIntoView({ behavior: 'smooth', block: 'start' }); })
    .catch(function (e) { if (!e.login) out.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; })
    .then(function () { var b2 = $('#goTry'); if (b2) b2.disabled = false; });
}
function renderTry(r, ms) {
  var out = $('#tryOut');
  if (!r.ok) { out.innerHTML = '<div class="err">❌ ' + esc(r.error || 'Failed') + '</div>'; return; }
  var rep = r.report || {}, st = r.streams || [], d = rep.dropped || {}, removed = 0;
  var keys = Object.keys(d).sort(function (a, b) { return d[b] - d[a]; });
  keys.forEach(function (k) { removed += d[k]; });
  var max = keys.length ? d[keys[0]] : 1;
  S.streams = st;
  var h = '<div class="card"><div class="card-h"><h2>' + esc(rep.title || '') + '</h2><span class="mut small">' + (r.cached ? '⚡ from cache (made ' + ago(Date.now() - r.age * 1000) + ') · ' : '') + 'answered in ' + fmtMs(ms) + '</span></div>';
  if (dirty()) h += '<div class="warn">You have unsaved changes. This test used your saved setup.</div>';
  h += '<div class="sum"><span class="pill b">📥 ' + (rep.total || 0) + ' found</span><span class="pill g">✅ ' + st.length + ' shown</span><span class="pill g">🧪 ' + (rep.tested || 0) + ' tested working</span>' +
    (rep.newCount ? '<span class="pill y">🆕 ' + rep.newCount + ' new</span>' : '') + (rep.ms != null ? '<span class="pill n">⏱ built in ' + fmtMs(rep.ms) + '</span>' : '') + '</div>';
  h += '<div class="chips">' + (rep.ups || []).map(function (u) {
    return '<span class="chip">' + esc(u.name) + ' · ' + (u.err ? '❌ ' + esc(u.err) : u.skipped ? '⏭ ' + (u.skipped === 'unsupported' ? 'doesn’t cover this' : 'paused (down)') : u.n + ' streams' + (u.cached ? ' · cached' : u.ms ? ' · ' + fmtMs(u.ms) : '')) + '</span>';
  }).join('') + '</div>';
  if (!(rep.ups || []).length) h += '<div class="warn">No addons are switched on.</div>';
  if (keys.length) h += '<details><summary>Removed ' + removed + ' — see why</summary><div class="bars">' + keys.map(function (k) { return '<div class="bar"><span>' + esc(k) + '</span><i style="width:' + Math.max(3, Math.round(d[k] / max * 100)) + '%"></i><b>' + d[k] + '</b></div>'; }).join('') + '</div></details>';
  h += '</div>';
  h += st.length ? st.map(function (s, i) {
    return '<div class="stream' + (/🆕/.test(s.name || '') ? ' new' : '') + '"><div class="sname">' + esc(s.name) + '</div><div class="sdesc">' + esc(s.description || s.title || '') + '</div><div>' + (s.url ? '<button type="button" class="ib" data-copy="' + i + '" title="Copy stream link">📋</button>' : '') + '</div></div>';
  }).join('') : '<div class="empty">No streams passed the filters for this title.</div>';
  out.innerHTML = h;
}
$('#tryOut').addEventListener('click', function (e) { var b = e.target.closest('[data-copy]'); if (b) copy(S.streams[+b.getAttribute('data-copy')].url, 'Stream link copied'); });

/* ---------- health ---------- */
$('#pingBtn').addEventListener('click', function () {
  var b = this; b.disabled = true; b.textContent = 'Checking…';
  refreshHealth(true).then(function () { b.disabled = false; b.textContent = '↻ Check addons now'; toast('All addons checked'); });
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
  else txt = good ? 'Live · ' + good + '/' + on.length + ' working' : 'Live · ' + plural(on.length, 'addon') + ' ready';
  el.className = 'pill ' + cls; el.innerHTML = '<span class="dot"></span>' + esc(txt);
}
var HST = { working: ['g', 'Working'], slow: ['y', 'Slow'], failing: ['y', 'Last try failed'], down: ['r', 'Down'], unknown: ['n', 'Not used yet'], off: ['n', 'Off'] };
var HOSTST = { good: ['g', 'Good'], mixed: ['y', 'Mixed'], slow: ['y', 'Slow'], failing: ['r', 'Failing'] };
function hpill(k, map) { var p = (map || HST)[k] || ['n', k]; return '<span class="pill ' + p[0] + '"><span class="dot"></span>' + p[1] + '</span>'; }
function renderHealth() {
  var h = S.health;
  if (!h) { $('#hTiles').innerHTML = '<div class="loading" style="margin:0"><div class="spin"></div>Loading…</div>'; return; }
  var on = h.addons.filter(function (a) { return a.on; });
  var good = on.filter(function (a) { return a.status === 'working' || a.status === 'slow'; }).length, avg = 0, n = 0, ok = 0, all = 0;
  on.forEach(function (a) { if (a.avgMs) { avg += a.avgMs; n++; } });
  h.hosts.forEach(function (x) { ok += x.ok; all += x.ok + x.fail + x.slow; });
  $('#hTiles').innerHTML = '<div class="stat"><b>' + good + ' / ' + on.length + '</b><span>addons working</span></div>' +
    '<div class="stat"><b>' + (n ? fmtMs(avg / n) : '—') + '</b><span>average addon answer</span></div>' +
    '<div class="stat"><b>' + (all ? Math.round(ok / all * 100) + '%' : '—') + '</b><span>tested links that started</span></div>' +
    '<div class="stat"><b>' + (h.storage ? 'Live sync' : 'Link mode') + '</b><span>' + (h.storage ? 'changes apply by themselves' : 'changes need a new link') + '</span></div>';
  $('#hNote').textContent = 'While you watch, results older than ' + dur(h.fresh * 1000) + ' are refreshed from your addons in the background, so new links show up by themselves. Server running for ' + dur(Date.now() - h.upSince) + ' · updated ' + new Date(h.now).toLocaleTimeString() + '.';
  $('#hAddons').innerHTML = h.addons.length ? '<table><tr><th>Addon</th><th>Status</th><th>Ping</th><th>Avg answer</th><th>Last results</th><th>OK / Fail</th><th>Note</th></tr>' + h.addons.map(function (a) {
    return '<tr><td><b>' + esc(a.name) + '</b></td><td>' + hpill(a.status) + '</td><td>' + (a.pingMs ? fmtMs(a.pingMs) : '—') + '</td><td>' + (a.avgMs ? fmtMs(a.avgMs) : '—') + '</td><td>' + (a.lastCount != null ? a.lastCount + ' streams' : '—') + '</td><td>' + a.ok + ' / ' + a.fail + '</td><td class="sub" style="color:#ff9fb2">' + esc(a.lastErr || (a.pausedMin ? 'paused for ' + a.pausedMin + ' min' : '')) + '</td></tr>';
  }).join('') + '</table>' : '<div class="empty">No addons.</div>';
  $('#hHosts').innerHTML = h.hosts.length ? '<table><tr><th>Host</th><th>Status</th><th>Working</th><th>Dead</th><th>Slow</th><th>Avg start</th></tr>' + h.hosts.map(function (x) {
    return '<tr><td>' + esc(x.host) + '</td><td>' + hpill(x.status, HOSTST) + '</td><td>' + x.ok + '</td><td>' + x.fail + '</td><td>' + x.slow + '</td><td>' + (x.avgMs ? fmtMs(x.avgMs) : '—') + '</td></tr>';
  }).join('') + '</table>' : '<div class="empty">No links tested yet. Open a movie in Stremio, or use “Try it”.</div>';
  $('#hRecent').innerHTML = h.recent.length ? '<table><tr><th>When</th><th>Title</th><th>Found</th><th>Shown</th><th>🆕</th><th>Time</th><th>Removed (top reasons)</th></tr>' + h.recent.map(function (r) {
    var d = r.dropped || {}, top = Object.keys(d).sort(function (a, b) { return d[b] - d[a]; }).slice(0, 3).map(function (k) { return d[k] + ' ' + k; }).join(' · ');
    return '<tr><td style="white-space:nowrap">' + ago(r.at) + '</td><td><b>' + esc(r.title) + '</b><div class="sub">' + esc(r.type + ' · ' + r.id) + (r.fresh ? ' · background refresh' : '') + '</div></td><td>' + r.total + '</td><td><b>' + r.shown + '</b> <span class="sub">(' + r.tested + ' ✅)</span></td><td>' + (r.newCount || '—') + '</td><td>' + fmtMs(r.ms) + '</td><td class="sub">' + esc(top) + '</td></tr>';
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
  if (S.storage) m.innerHTML = '<h2>Live sync <span class="pill g"><span class="dot"></span>On</span></h2><p class="lead" style="margin:6px 0 0">Install once. Everything you save here (new addons, switched-off addons, settings) reaches Stremio by itself within about a minute. No reinstalling.</p>';
  else m.innerHTML = '<h2>Link mode <span class="pill y">no storage connected</span></h2><p class="lead" style="margin:6px 0 10px">Your addon list is stored inside the install link (encrypted, only your server can read it). After you save changes, <b>remove the old Fast Combo in Stremio and install the new link</b>.</p>' +
    (B.onCF ? '<details open><summary>Turn on live sync (free, about 2 minutes) so you never need to reinstall</summary><ol class="steps"><li>Cloudflare dashboard → your worker → <b>Bindings</b> → <b>Add binding</b> → <b>KV namespace</b> (not D1 database).</li><li>Variable name <code>FC_KV</code> (any name works). KV namespace: pick <code>fastcombo</code>, or type <code>fastcombo</code> and choose the one marked <b>new</b>.</li><li>Click <b>Add binding</b>. This is the last click: there is no separate Deploy. Ignore any example code and the message about updating your Wrangler configuration.</li><li>Reload this page and press <b>Save changes</b> once. Then install the plain link one last time.</li></ol></details>'
      : '<p class="hint">Tip: with server.js, live sync is on automatically (saved in data/kv.json).</p>');
}
$('#instCopy').addEventListener('click', function () { copy(installUrl(), 'Install link copied'); });

/* ---------- AI finder ---------- */
var aiItems = [], aiResult = null;
$('#aiForm').addEventListener('submit', function (e) { e.preventDefault(); aiFind(); });
function aiFind() {
  var q = $('#aiQ').value.trim(), test = $('#aiTest').checked, out = $('#aiOut'), btn = $('#aiBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  out.innerHTML = '<div class="loading"><div class="spin"></div><div>' + (test ? 'Searching the community catalog and live-testing the top ones… usually 10–25 s' : 'Searching the community catalog… a couple of seconds') + '</div></div>';
  api('ai?q=' + encodeURIComponent(q) + (test ? '&test=1' : '')).then(function (r) { aiResult = r; aiItems = (r && r.candidates) || []; paintAi(); })
    .catch(function (e) { if (!e.login) out.innerHTML = '<div class="err">❌ ' + esc(e.message) + '</div>'; })
    .then(function () { btn.disabled = false; btn.textContent = '🔎 Find the best'; });
}
function aiBits(c) {
  var b = [];
  if (c.downloads) b.push('📥 ' + (c.downloads >= 1000 ? Math.round(c.downloads / 1000) + 'k' : c.downloads) + ' installs');
  if (c.rating) b.push('⭐ ' + c.rating.toFixed(1));
  if (c.tested && c.live) {
    if (c.live.uhd) b.push('✨ ' + c.live.uhd + ' in 4K');
    if (c.live.hd) b.push('🎞 ' + c.live.hd + ' in 1080p');
    if (c.live.linksTested) b.push('🔗 ' + c.live.linksOk + '/' + c.live.linksTested + ' start');
  }
  return b;
}
function aiRow(c, i) {
  var best = i === 0, bits = aiBits(c), already = S.prof.addons.some(function (a) { return a.id === c.aid; });
  var why = (c.why || []).slice(0, 4).map(esc).join(' · ');
  return '<div class="addon" style="' + (best ? 'border-color:rgba(124,108,255,.75);box-shadow:0 0 0 2px rgba(124,108,255,.35)' : '') + '">' +
    (best ? '<div style="flex-basis:100%"><span class="pill b"><span class="dot"></span>🏆 Best pick</span>' + (c.reason ? '<span class="mut small" style="margin-left:8px">' + esc(c.reason) + '</span>' : '') + '</div>' : '') +
    '<img class="alogo" alt="" src="' + esc(c.logo || '/logo.png') + '" onerror="this.onerror=null;this.src=\'/logo.png\'">' +
    '<div class="ainfo"><div class="aname"><span>' + (i + 1) + '. ' + esc(c.name) + '</span></div>' +
    (bits.length ? '<div class="astats">' + bits.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '</div>' : '') +
    (why ? '<div class="aurl" style="white-space:normal;max-width:none;overflow:visible">' + why + '</div>' : '') +
    (c.live && c.live.error ? '<div class="aerr">⚠ ' + esc(c.live.error) + '</div>' : '') + '</div>' +
    '<div class="actl">' + (already ? '<span class="pill n">✓ Added</span>' : '<button type="button" class="btn ok sm" data-ai="' + i + '">＋ Add</button>') + '</div></div>';
}
function paintAi() {
  var out = $('#aiOut'), r = aiResult;
  if (!r) return;
  if (!r.ok) { out.innerHTML = '<div class="err">❌ ' + esc(r.error || 'Something went wrong') + '</div>'; return; }
  if (!aiItems.length) { out.innerHTML = '<div class="empty">No addons matched. Try a different word, or leave the box empty for the best overall.</div>'; return; }
  var eng = r.llm ? '<span class="pill b">🧠 ' + esc(r.llm.model) + '</span>' : '<span class="pill n">⚙️ auto-scored</span>';
  var h = '<div class="sum" style="margin:8px 0 2px">' + eng + '<span class="mut small">from ' + esc(r.source) + (r.tested ? ' · top ones live-tested' : '') + ' · ' + r.count + ' candidates</span></div>';
  h += '<div class="btns" style="margin:12px 0 2px"><button type="button" class="btn pri" id="aiBest">＋ Add the best' + (aiItems[0] ? ': ' + esc(aiItems[0].name) : '') + '</button>';
  var sug = r.suggested || [];
  if (sug.length > 1) h += '<button type="button" class="btn" id="aiTop">＋ Add top ' + sug.length + '</button>';
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
  toast('✅ ' + c.name + ' added — now press Save changes', 'ok');
  paintAi();
}

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
