# ⚡ Fast Combo: all your Stremio addons merged into one fast addon

Add as many Stremio addons as you like. Fast Combo asks them all at once and shows **only working, fast-starting 1080p and 4K streams**, with small, efficient files first so videos start quickly and don't buffer.

> **No addons are included.** Fast Combo starts empty: you add the addons you want on its control panel after installing. It never searches for or recommends addons on its own — the one exception is the **opt-in AI finder** (the 🤖 tab), which searches Stremio's public community catalog and suggests the best scraper for what you ask for, but only adds it when you press **Add**.

**Every time you open a movie or episode, it:**

1. Asks all your switched-on addons at the same time. Dead or slow addons are skipped automatically and retried later.
2. Keeps only **4K and 1080p**. It removes CAM/TS copies, huge REMUX files, "download only" pages, ads and error cards.
3. **Removes duplicates.** If the same file comes from 5 places, it keeps the fastest one.
4. **Hides wrong episodes**, which some sources send for series and anime.
5. **Tests the links live and hides dead ones.**
6. **Hides links that would expire before the movie ends.**
7. Sorts the list: tested-working first, then the best picture for the smallest file.

**Plus:**
- 🤖 **AI finder.** Tell it what you want (or nothing, for the best overall) and it searches Stremio's public community catalog, ranks the scrapers by installs, **live-tests the top ones** and highlights the best pick. Opt-in — it never adds anything without your **Add**. Optionally add an LLM key so it explains its choice in one line.
- 🧩 **Control panel website** for your phone or computer. Add, remove, switch off and reorder addons. Each addon is **tested live before it's added**.
- 🔄 **Always fresh.** Answers come instantly from memory and are re-checked in the background, so new links show up by themselves.
- 🆕 **New-link badges** for files that appear after you first opened a title.
- 🔎 **Try it.** See exactly what Stremio will get for any title, and why every other stream was removed.
- 🩺 **Live health** of every addon and file host.
- 🗣️ **Preferred audio languages**, and a **priority** for each addon.

---

## 📦 What's new

**v2.1.0**
- 🤖 **AI addon finder** (new 🤖 tab): searches Stremio's public community catalog, ranks scrapers by installs, and — if you tick it — live-tests the top ones to verify real 1080p/4K + working links, then highlights the 🏆 best pick. Fast by default (installs-only); **optional** `FC_LLM_API_KEY` lets a small LLM make the final call with a one-line reason.
- The control panel no longer re-checks addons you've switched off (fewer background requests).

## 🚀 Install (pick one)

| Where | Cost | How long | Best for |
|---|---|---|---|
| [🏠 Your own VPS](#-your-own-vps-one-command) | your VPS | 5 min | Always on, no limits, up to 50 addons |
| [☁️ Cloudflare Workers](#️-cloudflare-workers-free-no-server) | free | 3 min (one-click button) | No server at all |
| [🐳 Docker](#-docker) / [💻 Node.js](#-nodejs-on-any-computer) | free | 2 min | Your own computer or NAS |

Every install creates **its own private access key and password**. Nothing secret is stored in this repository.

### 🏠 Your own VPS (one command)

On an **Ubuntu 20.04+** or **Debian 11+** VPS, run:

```bash
curl -fsSL https://raw.githubusercontent.com/AfzalAshraf/stremio-addons/main/install.sh | sudo bash
```

It asks for a **free DuckDNS address** (or your own domain), then sets everything up:
- free HTTPS (Caddy + Let's Encrypt, renews by itself)
- auto-start and auto-restart
- DuckDNS updates
- the firewall

At the end it shows your **control panel link and password**. No Cloudflare is needed.

📖 Step by step, including what to click at each VPS company: **[VPS-SETUP.md](VPS-SETUP.md)**

<details><summary>Prefer git?</summary>

```bash
git clone https://github.com/AfzalAshraf/stremio-addons.git
cd stremio-addons
sudo bash install.sh
```
</details>

Update later (keeps your addons and settings): `sudo bash /opt/fastcombo/install.sh --update`

### ☁️ Cloudflare Workers (free, no server)

> **You never write code.** When you create KV storage, Cloudflare shows example code (`env.KV.put(...)`, `env.KV.get(...)`, `list`, `delete`). **Ignore it.** It's for programmers, and Fast Combo already does all of that by itself.

#### Option A: one click (easiest, about 3 minutes)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AfzalAshraf/stremio-addons)

1. Click the button above. Log in to Cloudflare (or sign up, it's free) and connect GitHub when asked.
2. Everything on the page that opens is already filled in (the storage too), **except 2 boxes**:

   | Box | Type this |
   |---|---|
   | `FC_ACCESS_KEY` | about 12 random letters and numbers, no spaces (the secret part of your addon link) |
   | `FC_ADMIN_PASSWORD` | a password for your control panel |

   ✍️ **Write both down.**
3. Click **Create and deploy** and wait about a minute.
4. Open your control panel. Put in your own Worker address (shown when it's done) and your own key:
   ```
   https://fast-combo.YOUR-NAME.workers.dev/YOUR-ACCESS-KEY/configure
   ```
5. Log in with your password, then go to [After installing](#-after-installing-add-your-addons). Live sync is already on.

> The button also makes a copy of this project in your GitHub. That's normal: Cloudflare builds your Worker from that copy.

#### Option B: by hand (about 10 minutes, copy and paste only)

Every grey box below has a **copy button** in its top-right corner (on GitHub). Paste exactly what's in it.

**Step 1: create the Worker**

Go to **https://dash.cloudflare.com** → **Workers & Pages** (in the left menu, sometimes under **Compute**) → **Create** → **Start with Hello World**. Name it:
```
fast-combo
```
Click **Deploy**.

**Step 2: put Fast Combo in it**

1. Click **Edit code**. Select everything in the editor (`Ctrl+A`, or `⌘+A` on a Mac) and delete it.
2. Open **[fastcombo.js](https://raw.githubusercontent.com/AfzalAshraf/stremio-addons/main/fastcombo.js)**, select all, copy, and paste it into the editor.
3. Click **Deploy**.
4. Open your Worker's address (`https://fast-combo.YOUR-NAME.workers.dev`). It shows **"one step left"** with ready-made random values and **Copy** buttons. Keep it open for step 3.

**Step 3: add your key and password**

Your Worker → **Settings** → **Variables and Secrets** → **+ Add**. Add these 2, choosing type **Secret** each time.

Variable name:
```
FC_ACCESS_KEY
```
Value: about 12 random letters and numbers, no spaces (or the one from the "one step left" page).

Variable name:
```
FC_ADMIN_PASSWORD
```
Value: a password you choose for the control panel.

Click **Deploy**. ✍️ **Write both values down.**

**Step 4: turn on live sync** (recommended: changes reach Stremio without reinstalling)

1. Open your Worker **fast-combo** → **Bindings** (a tab at the top, or under **Settings**) → **Add binding**.
2. Choose **KV namespace**. ⚠️ Not *D1 database*: if you see a **Location hint** box, you picked the wrong one, so close it and pick **KV namespace**.
3. Variable name:
   ```
   FC_KV
   ```
4. KV namespace: pick **fastcombo** from the list. Not in the list? Type this and choose the option marked **new**, and Cloudflare creates it for you:
   ```
   fastcombo
   ```
5. Leave **Previews** as it is and click **Add binding**. That's the last click: it saves and goes live straight away. There's no separate Deploy button.

Cloudflare may then say *"Update your Wrangler configuration with these changes to keep deployments in sync."* **Ignore it.** It's for people who deploy from their own computer, so there's nothing to update. Ignore any example code too. Already used another variable name, such as `KV`? That works too.

**Step 5: open your control panel**
```
https://fast-combo.YOUR-NAME.workers.dev/YOUR-ACCESS-KEY/configure
```
Log in with your password, then go to [After installing](#-after-installing-add-your-addons).

The free plan allows 100,000 requests a day. Its limits mean up to **15 addons** per Worker.

### 🐳 Docker

```bash
git clone https://github.com/AfzalAshraf/stremio-addons.git && cd stremio-addons
docker build -t fast-combo .
docker run -d --name fastcombo --restart unless-stopped -p 7000:7000 -v fastcombo-data:/app/data fast-combo
docker logs fastcombo      # shows your control panel link + password
```

### 💻 Node.js on any computer

Needs Node.js 18 or newer (Windows, Mac, Linux, Raspberry Pi):

```bash
git clone https://github.com/AfzalAshraf/stremio-addons.git && cd stremio-addons
node server.js
```

The first start prints your control panel link and password, and saves them in `data/secrets.json`.

> Stremio needs an **https** address for addons that aren't on the same device. On your own computer `http://localhost:7000/…` works. For other devices, use the VPS installer, or put it behind HTTPS (Caddy, nginx, a Cloudflare Tunnel) and set `FC_PUBLIC_URL`.

---

## ➕ After installing: add your addons

1. Open your **control panel**: `https://YOUR-ADDRESS/YOUR-ACCESS-KEY/configure`, then type your password.
2. **🧩 Addons** tab: paste an addon's link (`…/manifest.json` or `stremio://…`) and press **Check**. It's tested live: is it online, how fast, how many 4K/1080p streams it finds. Then press **Add**. Repeat for as many addons as you like.
3. Press **Save changes**.
4. **📲 Install** tab: **Install in Stremio app**, or copy the link into Stremio's addon search box.

With **live sync** on (VPS, Docker, Node, or Cloudflare with KV), later changes reach Stremio by themselves; you install once. Without it ("link mode"), your addon list travels **encrypted inside the install link**, so reinstall after changes.

Tip: if you also keep the original addons installed in Stremio, you'll see their streams twice. Fast Combo already includes their streams, catalogs and subtitles.

---

## 🧩 The control panel

| Tab | What you can do |
|---|---|
| **🧩 Addons** | Add addons (tested live first). For each one: switch on/off, **priority** (High/Normal/Low decides whose link wins when two addons have the same file), move ▲▼, rename, test again, remove. |
| **🤖 AI best** | Find the best addon for what you're after: searches the public catalog, ranks by installs, **live-tests the top ones**, and highlights the 🏆 best pick. Add `FC_LLM_API_KEY` and a small LLM makes the final call with a one-line reason. Nothing is added until you press **Add**. |
| **⚙️ Settings** | Sorting, qualities, size limits, how many streams, link testing, 🆕 badges, REMUX / Dolby Vision / AV1, preferred audio languages. |
| **🔎 Try it** | Search any movie or series (or paste an ID like `tt1375666`) and see the exact list Stremio will get, plus everything removed and why. **Skip cache** asks your addons again right now. |
| **🩺 Health** | Live status of every addon (ping, answer time, last results, errors), which file hosts work right now, recent requests. |
| **📲 Install** | Install buttons, the link to copy, live sync status. |

Nothing changes until you press **Save changes**. The bar at the bottom also has **Undo**.

## 🆕 Fresh results and new links

- The first time you open a title, your addons are asked and the links are tested. That takes 2–8 s; after that it's instant.
- When a saved result is older than **2 minutes**, you still get it **instantly**, while your addons are asked again in the background. Results are never kept longer than 15 minutes.
- If a background check comes back much thinner than before (a hiccup or rate limit), the good list is kept.
- **🆕 badges:** a file that appears after you first opened a title is marked **🆕 NEW** for 24 hours, moved up a little, and always kept visible. The first few looks only build the baseline, so nothing is marked by mistake.
- Live TV (if an addon provides it) is passed through without the quality and size filters.

## ⚙️ The settings

| Setting | What it does |
|---|---|
| **Balanced** (default) | Tested-working links first, then the best picture for the smallest file. Mixes 4K and 1080p. |
| **Smallest first** | Fastest start, least buffering. |
| **4K first / 1080p first** | That quality on top, the other below. |
| **Qualities to keep** | 4K + 1080p by default. Add 720p only if your internet is slow. |
| **Biggest 1080p / 4K allowed** | About 7 GB (1080p) and 18 GB (4K) for a 2-hour movie by default. It's a bitrate limit, so episodes are scaled automatically. |
| **Test links live** | On by default. Hides dead links. |
| **Mark new links 🆕** | On by default. |
| **Allow REMUX** | Off. REMUX files are 30–80 GB, too big for a quick start. |
| **Hide Dolby-Vision-only** | Turn on if some 4K files show purple/green colours on your TV. |
| **Hide AV1** | Turn on if your device can't play AV1. |
| **Preferred audio languages** | Streams with these languages move up. Nothing is hidden. |

## 📺 How to read the stream list

On the left Stremio shows the quality and size (e.g. `✅ 4K` · `4.63 GB`); on the right the details:

```
🎬 Some Movie (2024)
📦 4.63 GB · 📊 3.7 Mbps · 🎞️ HEVC 10bit · ✨ DV HDR
🎥 BluRay · 🎧 DD+ · 5.1 · 🗣️ 🇬🇧
✅ Tested OK · starts in 1.9s · 🌐 Pixeldrain · 🔍 Addon name
📄 Some.Movie.2024.2160p.DV.HDR.BluRay.HEVC…
```

| Badge | Meaning |
|---|---|
| ⚡ | Tested; starts in under 1.5 s |
| ✅ | Tested and working, a bit slower to start |
| 🆕 | New link (appeared after you first opened this title, 24 h) |
| ❔ | Not tested (there wasn't time), shown below the tested ones |
| 🐢 | Slow to start (over 3 s) |
| ⏳ | The link expires before the movie ends |

📊 is the bitrate: the lower, the less internet speed you need (roughly 1.5× that number in Mbps).

---

## 🔧 Configuration

Everything is optional. Set these as environment variables: in `/etc/fastcombo/fastcombo.env` with the VPS installer, as Worker variables on Cloudflare, or with `-e` in Docker.

| Variable | Meaning |
|---|---|
| `FC_ACCESS_KEY` | The secret part of your links. Created automatically on VPS/Node/Docker; **required on Cloudflare** |
| `FC_ADMIN_PASSWORD` | Control panel password. Created automatically on VPS/Node/Docker; **required on Cloudflare** |
| `FC_SECRET` | Encrypts addon lists inside links. Created automatically; on Cloudflare it's derived from the password if not set |
| `FC_PUBLIC_URL` | The https address Stremio should use, when Fast Combo sits behind a proxy or tunnel |
| `FC_MAX_ADDONS` | Max addons in the list (Node/VPS/Docker: 50, Cloudflare: 15) |
| `FC_UPSTREAMS` | Optional starting addons: manifest links separated by commas |
| `FC_ADDON_NAME` | Name shown in Stremio |
| `FC_FRESH_SECONDS` / `FC_CACHE_MINUTES` | Background refresh after (120 s) / keep results at most (15 min) |
| `FC_NEW_HOURS` | How long a link stays 🆕 (24) |
| `FC_MAX_PROBES`, `FC_PROBE_CONCURRENCY`, `FC_PROBE_TIMEOUT_MS` | Link testing |
| `FC_AI_CATALOG` | Where the 🤖 AI finder searches for scrapers (default: Stremio's public `https://api.strem.io/addons/`) |
| `FC_AI_TEST_N` | How many top candidates the AI finder live-tests (default 3; keep it low on Cloudflare) |
| `FC_LLM_API_KEY` | Optional: an OpenAI-compatible API key so the AI finder uses a small LLM for the final pick + a one-line reason |
| `FC_LLM_BASE_URL` | LLM endpoint (default `https://api.openai.com/v1`; any OpenAI-compatible API works) |
| `FC_LLM_MODEL` | LLM model (default `gpt-4o-mini`) |
| `PORT` / `HOST` | Where `server.js` listens (default `7000` on `0.0.0.0`; the VPS installer uses `127.0.0.1` behind Caddy) |
| `FC_DATA_FILE` / `FC_NO_STORAGE=1` | `server.js` only: where to save data / turn live sync off |
| `FC_PRIVATE_HOST` | A private address where `/` opens the control panel **without a password**. **Never set it to a public address.** |

## 🩺 Troubleshooting

| Problem | What to do |
|---|---|
| No streams at all | Have you added addons? Then open **🩺 Health**: an addon marked **Down** is offline (retried every 5 minutes). **🔎 Try it** shows what each addon returned. |
| 🤖 AI finder says it can't reach the catalog | It needs internet to search Stremio's public catalog (`api.strem.io`). Check your connection and try again; everything else in Fast Combo works without it. |
| First open of a title is slow (5–10 s) | Your addons are looking it up for the first time. Opening it again is instant. |
| Saved, but Stremio shows the old list | **Live sync:** wait up to a minute and reopen the title. **Link mode:** reinstall from the 📲 Install tab. |
| Catalogs of a newly added addon don't appear | Stremio reads catalogs only when installing. Reinstall Fast Combo once. (Streams from new addons work without reinstalling.) |
| Forgot the password / key | VPS: `sudo cat /etc/fastcombo/fastcombo.env` · Node/Docker: `data/secrets.json` (Docker: `docker exec fastcombo cat /app/data/secrets.json`) · Cloudflare: set new values in the Worker's variables. |
| Cloudflare page says **"one step left"** | Your key and password aren't set yet. Do [Option B, step 3](#️-cloudflare-workers-free-no-server), or redeploy with the button and fill in both boxes. |
| Cloudflare: the 📲 Install tab says **"Turn on live sync"** | Add the KV storage: [Option B, step 4](#️-cloudflare-workers-free-no-server). Any variable name works. Then press **Save changes** once and install one last time. |
| Cloudflare says *"Update your Wrangler configuration…"* | Ignore it. It's only for people who deploy with a config file from their computer. Nothing is wrong. |
| "Wrong password" although it's right | The browser may have saved an old one. Retype it. |
| "Error 1102" on Cloudflare (rare) | The free plan allows 10 ms of processing per request. Reopen the title; if it happens often, turn off **Test links** or use a VPS. |
| Some 4K files show purple/green | Turn on **Hide Dolby-Vision-only**. |
| A video stops near the end | That host's link expired. Fast Combo hides and marks (⏳) these; pick another stream. |

## 📁 Files

| File | What it is |
|---|---|
| `fastcombo.js` | **The addon**, including the control panel (the only file needed on Cloudflare) |
| `server.js` | Runs it with Node.js (live sync in `data/kv.json`, keys in `data/secrets.json`) |
| `install.sh` | One-command VPS installer (Ubuntu/Debian): HTTPS, service, DuckDNS, firewall |
| `VPS-SETUP.md` | Step-by-step VPS guide |
| `Dockerfile`, `package.json` | Docker / Node packaging |
| `wrangler.jsonc`, `.dev.vars.example` | Cloudflare settings for the one-click button (Node, Docker and VPS users can ignore them) |
| `ui/app.html` | Source of the control panel. After editing, run `python3 tools/embed_ui.py` to copy it into `fastcombo.js` |
| `test/smoke.mjs` | End-to-end test with fake addons: `node test/smoke.mjs` |

---

Fast Combo doesn't host or include any content or addons. It only combines the addons **you** add, so use addons you're allowed to use.
