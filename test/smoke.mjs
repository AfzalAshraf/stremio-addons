// End-to-end check with two FAKE addons, so no real addons are needed:   node test/smoke.mjs
// It starts fake addons + a fake video host on 127.0.0.1 and drives Fast Combo the way Stremio and the
// control panel do: empty start → add addons → ask for streams → change settings.
// (Only the movie length is looked up online, at Stremio's public Cinemeta catalog; if you're offline
//  the one check that needs it is skipped.)
import http from "node:http";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  · " + extra : ""}`);
  if (!ok) fails++;
};

// ------------------------------------------------------------ fake addons + video host
const ID = "tt0111161"; // a real movie id (142 min), so the bitrate check has a runtime
const FILES = {
  "a-1080-small": { size: 1_523_456_789, fname: "Some.Movie.1994.1080p.WEB-DL.x265.10bit.mkv" },
  "a-1080-huge": { size: 14_734_567_891, fname: "Some.Movie.1994.1080p.BluRay.x264.mkv" }, // ~13.8 Mbps: too big
  "a-720": { size: 912_345_678, fname: "Some.Movie.1994.720p.WEB-DL.x264.mkv" },
  "a-cam": { size: 1_234_567_891, fname: "Some.Movie.1994.1080p.HDCAM.x264.mkv" },
  "a-dead": { size: 2_345_678_912, fname: "Some.Movie.1994.1080p.WEBRip.x264.mkv", dead: true },
  "b-2160": { size: 9_876_543_219, fname: "Some.Movie.1994.2160p.WEB-DL.HDR.x265.mkv" },
  "b-1080": { size: 3_210_987_654, fname: "Some.Movie.1994.1080p.AMZN.WEB-DL.DDP5.1.H.264.mkv" },
  "b-dup": { size: 1_523_456_789, fname: "Some.Movie.1994.1080p.WEB-DL.x265.10bit.mkv" }, // same file as a-1080-small
};
const BY_ADDON = { a: ["a-1080-small", "a-1080-huge", "a-720", "a-cam", "a-dead"], b: ["b-2160", "b-1080", "b-dup"], c: [] };
let base = "";
const label = (f) => (/2160p/.test(f) ? "4K" : /1080p/.test(f) ? "1080p" : "720p");
const toStream = (key) => {
  const f = FILES[key];
  return {
    name: `Fake ${key[0].toUpperCase()}\n${label(f.fname)}`,
    description: `${f.fname}\n💾 ${(f.size / 1e9).toFixed(2)} GB`,
    url: `${base}/v/${key}.mkv`,
    behaviorHints: { filename: f.fname, videoSize: f.size },
  };
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  let m;
  if ((m = /^\/([abc])\/manifest\.json$/.exec(u.pathname))) {
    return send(200, { id: `test.fake.${m[1]}`, version: "1.0.0", name: `Fake ${m[1].toUpperCase()}`, resources: ["stream"], types: ["movie", "series"], idPrefixes: ["tt"], catalogs: [] });
  }
  if ((m = /^\/([abc])\/stream\/movie\/(tt\d+)\.json$/.exec(u.pathname))) return send(200, { streams: m[2] === ID ? BY_ADDON[m[1]].map(toStream) : [] });
  if ((m = /^\/v\/([\w-]+)\.mkv$/.exec(u.pathname)) && FILES[m[1]]) {
    const f = FILES[m[1]];
    if (f.dead) return send(404, "gone", "text/plain");
    res.writeHead(206, { "content-type": "video/x-matroska", "accept-ranges": "bytes", "content-range": `bytes 0-65535/${f.size}`, "content-length": 65536 });
    return res.end(Buffer.alloc(65536));
  }
  send(404, { error: "not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------ helpers
const memKV = () => {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
};
let n = 0;
const load = async () => (await import(`../fastcombo.js?smoke=${++n}`)).default; // fresh copy each time
const pending = [];
const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
async function call(app, env, path, { method = "GET", body, pw } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (pw) headers["x-admin-key"] = encodeURIComponent(pw);
  const r = await app.fetch(new Request("https://fc.test" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, text, data };
}
const keysOf = (streams) => streams.map((s) => (/\/v\/([\w-]+)\.mkv/.exec(s.url || "") || [])[1]).filter(Boolean);
const online = await fetch(`https://v3-cinemeta.strem.io/meta/movie/${ID}.json`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);

// ------------------------------------------------------------ 1. a copy without key/password is locked
{
  const app = await load();
  const r = await call(app, {}, "/");
  check("no access key / password → locked setup page", r.status === 503 && r.text.includes("FC_ACCESS_KEY") && r.text.includes("FC_ADMIN_PASSWORD"));
  check("…with copy buttons", (r.text.match(/data-copy=/g) || []).length >= 4);
  check("…addon routes are locked too", (await call(app, {}, "/anything/manifest.json")).status === 503);
}

// ------------------------------------------------------------ 2. configured: starts with no addons
const KEY = "smoketestkey1", PW = "test-pass-1234";
const env = { FC_ACCESS_KEY: KEY, FC_ADMIN_PASSWORD: PW, FC_SECRET: "x".repeat(32), FC_KV: memKV() };
const app = await load();
let r = await call(app, env, `/${KEY}/manifest.json`);
check("manifest works with no addons", r.status === 200 && r.data && Array.isArray(r.data.catalogs) && r.data.catalogs.length === 0, `v${r.data && r.data.version}`);
r = await call(app, env, `/${KEY}/stream/movie/${ID}.json`);
check("no addons → empty list, no error", r.status === 200 && r.data && r.data.streams.length === 0);
check("control panel API needs the password", (await call(app, env, `/${KEY}/api/profile`)).status === 401);
check("wrong password is refused", (await call(app, env, `/${KEY}/api/profile`, { pw: "nope" })).status === 401);
check("wrong access key → 404", (await call(app, env, `/wrongkey/manifest.json`)).status === 404);
r = await call(app, env, `/${KEY}/api/profile`, { pw: PW });
check("control panel opens with the password", r.status === 200 && r.data && r.data.ok && r.data.addons.length === 0, `max addons: ${r.data && r.data.maxAddons}`);

// ------------------------------------------------------------ 3. add addons the way the control panel does
r = await call(app, env, `/${KEY}/api/inspect`, { method: "POST", pw: PW, body: { url: `${base}/a/manifest.json` } });
check("inspect an addon before adding it", r.data && r.data.ok, r.data && (r.data.name || r.data.error));
r = await call(app, env, `/${KEY}/api/profile`, { method: "POST", pw: PW, body: { addons: [{ name: "Fake A", url: `${base}/a/manifest.json` }, { name: "Fake B", url: `${base}/b` }], settings: {} } });
check("save 2 addons (live sync)", r.data && r.data.ok && r.data.mode === "live");

// ------------------------------------------------------------ 4. streams: merged, filtered, tested, de-duplicated
r = await call(app, env, `/${KEY}/stream/movie/${ID}.json`);
const S = (r.data && r.data.streams) || [];
const got = keysOf(S);
console.log("   shown, best first:", got.join(" · "));
check("streams from both addons merged", got.some((k) => k.startsWith("a-")) && got.some((k) => k.startsWith("b-")));
check("only 1080p / 4K (720p dropped)", got.length > 0 && got.every((k) => /1080p|2160p/.test(FILES[k].fname)));
check("CAM copy dropped", !got.includes("a-cam"));
check("dead link tested and hidden", !got.includes("a-dead"));
check("same file from 2 addons shown once", got.filter((k) => k === "a-1080-small" || k === "b-dup").length === 1);
if (online) check("oversized file dropped (keeps buffering fast)", !got.includes("a-1080-huge"));
else console.log("⏭️  oversized-file check skipped (offline: no movie length)");
const cached = Date.now();
await call(app, env, `/${KEY}/stream/movie/${ID}.json`);
check("second request answered from cache", Date.now() - cached < 200, `${Date.now() - cached} ms`);

// ------------------------------------------------------------ 5. settings apply without reinstalling
r = await call(app, env, `/${KEY}/api/profile`, { method: "POST", pw: PW, body: { addons: [{ name: "Fake A", url: `${base}/a/manifest.json` }, { name: "Fake B", url: `${base}/b` }], settings: { res: "1080" } } });
r = await call(app, env, `/${KEY}/stream/movie/${ID}.json`);
const only1080 = keysOf((r.data && r.data.streams) || []);
check("setting \"1080p only\" removes the 4K file", only1080.length > 0 && !only1080.includes("b-2160"), only1080.join(" · "));

// ------------------------------------------------------------ 6. addon limit is respected
{
  const app2 = await load();
  const env2 = { ...env, FC_KV: memKV(), FC_MAX_ADDONS: "2" };
  r = await call(app2, env2, `/${KEY}/api/profile`, { method: "POST", pw: PW, body: { addons: ["a", "b", "c"].map((x) => ({ name: x, url: `${base}/${x}` })), settings: {} } });
  r = await call(app2, env2, `/${KEY}/api/profile`, { pw: PW });
  check("FC_MAX_ADDONS limits the list", r.data && r.data.addons.length === 2 && r.data.maxAddons === 2);
}

// ------------------------------------------------------------ 7. without storage: the list travels inside the link
{
  const app3 = await load();
  const env3 = { FC_ACCESS_KEY: KEY, FC_ADMIN_PASSWORD: PW, FC_SECRET: "y".repeat(32) };
  r = await call(app3, env3, `/${KEY}/api/profile`, { method: "POST", pw: PW, body: { addons: [{ name: "Fake B", url: `${base}/b` }], settings: {} } });
  const token = r.data && r.data.token;
  check("link mode gives an encrypted install link", r.data && r.data.mode === "link" && /^e\./.test(token || ""));
  check("…the link doesn't reveal the addon address", token && !token.includes("127.0.0.1") && !Buffer.from(token.slice(2), "base64").toString("latin1").includes("127.0.0.1"));
  r = await call(app3, env3, `/${KEY}/${token}/stream/movie/${ID}.json`);
  check("…and streams work through that link", r.status === 200 && keysOf(r.data.streams).includes("b-2160"));
}

// ------------------------------------------------------------ 8. live-sync storage works under any binding name
{
  const cfKV = () => Object.assign(memKV(), { async getWithMetadata(k) { return { value: await this.get(k), metadata: null }; }, async list() { return { keys: [] }; } });
  for (const name of ["KV", "MY_STORAGE"]) {
    const app4 = await load();
    const env4 = { FC_ACCESS_KEY: KEY, FC_ADMIN_PASSWORD: PW, FC_SECRET: "z".repeat(32), [name]: cfKV() };
    r = await call(app4, env4, `/${KEY}/api/profile`, { method: "POST", pw: PW, body: { addons: [{ name: "Fake B", url: `${base}/b` }], settings: {} } });
    const live = r.data && r.data.mode === "live";
    r = await call(app4, env4, `/${KEY}/stream/movie/${ID}.json`);
    check(`storage named "${name}" also gives live sync`, live && r.status === 200 && keysOf(r.data.streams).includes("b-2160"));
  }
}

// ------------------------------------------------------------ 9. LAN site (stremioaddon.lan)
{
  const app5 = await load();
  const env5 = { FC_ACCESS_KEY: KEY, FC_ADMIN_PASSWORD: PW, FC_SECRET: "w".repeat(32), FC_PUBLIC_URL: "http://stremioaddon.lan", FC_KV: memKV() };
  const lanHome = await app5.fetch(new Request("http://stremioaddon.lan/"), env5, ctx);
  const lanText = await lanHome.text();
  check("http://stremioaddon.lan/ opens the control panel directly on LAN", lanHome.status === 200 && lanText.includes(`"auto":"${PW}"`));
  const lanManifest = await app5.fetch(new Request("http://stremioaddon.lan/manifest.json"), env5, ctx);
  const lanManifestData = await lanManifest.json();
  check("http://stremioaddon.lan/manifest.json serves the addon manifest on LAN", lanManifest.status === 200 && lanManifestData.version === "2.0.0");
  const pubHome = await app5.fetch(new Request("https://public.example.com/"), env5, ctx);
  const pubText = await pubHome.text();
  check("public address still keeps / locked", pubHome.status === 200 && !pubText.includes(PW));
}

await Promise.allSettled(pending);
server.close();
console.log(fails ? `\n${fails} check(s) failed` : "\nAll checks passed ✅");
process.exit(fails ? 1 : 0);
