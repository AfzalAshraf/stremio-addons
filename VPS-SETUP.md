# ⚡ Fast Combo on your own VPS, with a free DuckDNS address

One command sets everything up: the addon, free HTTPS, auto-start, and DuckDNS updates. You don't upload anything; the installer downloads Fast Combo from GitHub.

## 💰 Is it free?

**Yes.** Apart from the VPS you already have, everything is free, and **you don't need Cloudflare** for this:

| Part | What it does | Cost |
|---|---|---|
| **DuckDNS** | Gives you an address like `myfastcombo.duckdns.org` | Free |
| **Caddy + Let's Encrypt** | The HTTPS padlock that Stremio requires. It renews by itself | Free |
| **Fast Combo + Node.js** | The addon itself | Free |
| Cloudflare | Not needed on a VPS | — |

Your VPS only sends small lists of links. **Videos play straight from the sources, not through your VPS.** So even the smallest VPS (1 CPU, 512 MB RAM) is enough, and it uses almost no bandwidth.

> The free Cloudflare Workers option in the main README still works too. It's a separate choice for people without a VPS. You can use either one, or both (they're separate links).

## ✅ What you need

- A VPS with **Ubuntu 20.04 or newer**, or **Debian 11 or newer**. For other Linux systems, see [the end of this guide](#-other-linux).
- The VPS's **IP address** and login (`root`, or a user with `sudo` such as `ubuntu`)
- About 10 minutes

---

## 1️⃣ Get your free DuckDNS address

1. Open **https://www.duckdns.org** and sign in (Google, GitHub, Reddit, X …).
2. Under **sub domain**, type a name, for example `myfastcombo`, and press **add domain**.
3. Keep the page open. You need the **token** shown at the top (it looks like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`).

You don't have to type your VPS's IP on DuckDNS; the installer fills it in for you.

## 2️⃣ Open ports 80 and 443 at your VPS company (only if they have a firewall)

Caddy needs ports **80** and **443** to get the free HTTPS certificate. The installer opens them **inside** the server. Some companies also have a firewall **on their website**:

| Provider | Where to open TCP 80 and 443 |
|---|---|
| **Oracle Cloud** | Networking → Virtual cloud networks → your VCN → Security Lists → Default → **Add Ingress Rules**: Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `80`. Add a second rule for `443` |
| **AWS Lightsail** | Your instance → Networking → IPv4 Firewall → **Add rule** → HTTPS (HTTP is usually there already) |
| **AWS EC2** | Instance → Security → Security group → **Edit inbound rules** → add HTTP and HTTPS |
| **Google Cloud** | VM → Edit → tick **Allow HTTP traffic** and **Allow HTTPS traffic** |
| **Azure** | VM → Networking → **Add inbound port rule** for 80, and another for 443 |
| Hetzner, DigitalOcean, Vultr, Linode | Only if you created a cloud firewall: allow TCP 80 and 443 |
| Contabo, OVH, Hostinger, most others | Usually open already, so nothing to do |

## 3️⃣ Run the installer on your VPS

Log in to the VPS:
- **Windows:** PowerShell
- **Mac / Linux:** Terminal
- **Phone:** an SSH app such as Termius

```
ssh root@YOUR_VPS_IP
```

(Use your own login name instead of `root` if it's different, e.g. `ubuntu@…`. With a key file: `ssh -i path/to/key.pem ubuntu@YOUR_VPS_IP`.)

Then copy and paste this one line:

```
curl -fsSL https://raw.githubusercontent.com/AfzalAshraf/stremio-addons/main/install.sh | sudo bash
```

It downloads Fast Combo, asks for **your DuckDNS name** and **token**, shows what it will do, and asks **Continue?** Press Enter. In 1–3 minutes you'll see:

```
[1/6] Checking this server
[2/6] Pointing myfastcombo.duckdns.org to this server (DuckDNS)
[3/6] Installing Node.js and Caddy
[4/6] Installing Fast Combo
[5/6] Setting up HTTPS (Caddy) and the firewall
[6/6] Final checks

✅ Fast Combo is ready!

  Control panel   https://myfastcombo.duckdns.org/Ab3dEf6hJk9m/configure
  Password        abcd-efgh-jkmn
  Addon link      https://myfastcombo.duckdns.org/Ab3dEf6hJk9m/manifest.json
```

Your **access key** (the `Ab3dEf6hJk9m` part) and **password** are created randomly on your server. **Write them down.** You can always see them again with `sudo cat /etc/fastcombo/fastcombo.env`.

If it stops with a **✗**, the message says what to fix. Fix it and run the same line again (always safe).

<details><summary>Prefer git?</summary>

```
git clone https://github.com/AfzalAshraf/stremio-addons.git
cd stremio-addons
sudo bash install.sh
```
</details>

## 4️⃣ Add your addons

1. Open your **Control panel** link and type the password.
2. On the **🧩 Addons** tab, paste an addon link (`…/manifest.json`) and press **Check**. It's tested live first. Then press **Add**. Repeat for every addon you want (up to 50).
3. Press **Save changes**.

## 5️⃣ Install Fast Combo in Stremio

1. In the control panel, go to **📲 Install** and press **Install in Stremio app**.
   Or paste the **Addon link** into the search box on Stremio's Addons page.
2. If you had an older Fast Combo installed, remove it first.

Live sync is on, so later changes in the control panel (adding addons, settings) apply without reinstalling.

---

## 🔧 Everyday commands

| To do this | Type this on the VPS |
|---|---|
| Check that it's running | `sudo systemctl status fastcombo` |
| Watch the live log | `sudo journalctl -u fastcombo -f` (Ctrl+C to stop watching) |
| Restart it | `sudo systemctl restart fastcombo` |
| **Update** to the newest version | `sudo bash /opt/fastcombo/install.sh --update` (your addons, settings, key and password are kept) |
| See your key and password | `sudo cat /etc/fastcombo/fastcombo.env` |
| Change the password | `sudo nano /etc/fastcombo/fastcombo.env`, change the text after `FC_ADMIN_PASSWORD=`, save (Ctrl+O, Enter, Ctrl+X), then `sudo systemctl restart fastcombo` |
| Use a different address | `sudo bash /opt/fastcombo/install.sh --domain newname --token YOUR-TOKEN` |
| Remove Fast Combo | `sudo bash /opt/fastcombo/install.sh --uninstall` |

Where things are: the program is in `/opt/fastcombo`, settings in `/etc/fastcombo/`, your saved addon list in `/var/lib/fastcombo/kv.json`, and the HTTPS setup in `/etc/caddy/fastcombo.caddy`.

## 🩺 Troubleshooting

| Message or problem | What to do |
|---|---|
| `DuckDNS answered KO` | The name or the token is wrong. Check that the name is in **your** list on duckdns.org, and copy the whole token again. |
| `HTTPS isn't working yet` | Almost always step 2: ports 80/443 are closed at your VPS company. Open them there. Caddy keeps retrying by itself, so it starts working a few minutes later without running anything again. Details: `sudo journalctl -u caddy -n 30` |
| `doesn't point to this server yet` | Wait a minute, then run the installer again. With your own domain, set its **A record** to the VPS IP. |
| `Port 80 is already used by: nginx` (or apache2) | Not using it? `sudo systemctl disable --now nginx`, then run the installer again. Need it for other websites? See [Already using nginx?](#-already-using-nginx-advanced) |
| Stremio says "failed to fetch" | Open the **Addon link** in a browser. If it doesn't load: `sudo systemctl status fastcombo caddy` |
| Oracle Cloud: still not reachable | Oracle has two firewalls: the Security List on their website (step 2) and one inside the server. The installer opens the inside one; you open the Security List. |
| `Couldn't reach duckdns.org` | The VPS can't reach the internet. Test with `curl -I https://www.duckdns.org` |
| No streams | Have you added addons (step 4)? Then open the control panel → **🩺 Health**. If an addon is down, Fast Combo retries it by itself. |
| Forgot the password | `sudo cat /etc/fastcombo/fastcombo.env` |

---

## 🌐 Already using nginx? (advanced)

Keep nginx and skip Caddy:

```
curl -fsSL https://raw.githubusercontent.com/AfzalAshraf/stremio-addons/main/install.sh | sudo bash -s -- --no-caddy
```

Then add a site to nginx, for example in `/etc/nginx/sites-available/fastcombo`:

```nginx
server {
    server_name myfastcombo.duckdns.org;
    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

Turn it on and get the free certificate:

```
sudo ln -s /etc/nginx/sites-available/fastcombo /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d myfastcombo.duckdns.org
```

Changed your mind later? Once nginx no longer uses ports 80/443, `sudo bash /opt/fastcombo/install.sh --caddy` switches to Caddy.

## 🐧 Other Linux

On a system without `apt` or `systemd`, use Docker:

```
git clone https://github.com/AfzalAshraf/stremio-addons.git && cd stremio-addons
docker build -t fast-combo .
docker run -d --name fastcombo --restart unless-stopped -p 127.0.0.1:7000:7000 \
  -e FC_PUBLIC_URL=https://myfastcombo.duckdns.org -v fastcombo-data:/app/data fast-combo
docker logs fastcombo      # shows your control panel link + password
```

Then put Caddy in front of it. Install it with your system's package manager and add this to `/etc/caddy/Caddyfile`:

```
myfastcombo.duckdns.org {
    reverse_proxy 127.0.0.1:7000
}
```

Keep DuckDNS pointed at the server with a cron job (`crontab -e`):

```
*/5 * * * * curl -fsS "https://www.duckdns.org/update?domains=myfastcombo&token=YOUR-TOKEN&ip=" >/dev/null
```

## ❓ Questions

**What does the installer change on my server?**
- It installs Node.js (if missing) and Caddy.
- It creates a `fastcombo` system user, the `fastcombo` service and a DuckDNS timer.
- It opens ports 80/443 in the server's firewall.

`--uninstall` removes everything except Node.js and Caddy.

**Is the control panel safe on the internet?** It needs your password. The addon link contains a secret key, so don't post it publicly. You can change the password at any time (see [Everyday commands](#-everyday-commands)).

**Does it restart after a reboot or a crash?** Yes. The service starts on boot and restarts by itself within seconds.

**Can I use my own domain instead of DuckDNS?** Yes. Point its A record at the VPS and add `--domain addon.yourdomain.com`:
`curl -fsSL https://raw.githubusercontent.com/AfzalAshraf/stremio-addons/main/install.sh | sudo bash -s -- --domain addon.yourdomain.com`

**How many addons can I add?** Up to 50 on a VPS. For more, add `FC_MAX_ADDONS=100` to `/etc/fastcombo/fastcombo.env` and restart.
