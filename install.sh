#!/usr/bin/env bash
# ⚡ Fast Combo — one-command setup for your own VPS (Ubuntu / Debian), with free HTTPS.
#
#   curl -fsSL https://raw.githubusercontent.com/AfzalAshraf/stremio-addons/main/install.sh | sudo bash
#                                         downloads Fast Combo, asks for your free DuckDNS name + token,
#                                         then does everything (or: git clone … && sudo bash install.sh)
#   sudo bash install.sh --domain myaddon --token YOUR-DUCKDNS-TOKEN      same, without questions
#   sudo bash install.sh --domain addon.example.com                       your own domain instead
#   sudo bash /opt/fastcombo/install.sh --update   get the newest version (keeps your settings + addons)
#   sudo bash install.sh --no-caddy       you already run nginx/apache: skip Caddy (prints an nginx example)
#   sudo bash install.sh --caddy          switch back to Caddy after an install with --no-caddy
#   sudo bash install.sh --port 7010      use another local port (default 7000)
#   sudo bash install.sh --uninstall      remove Fast Combo from this server
#
# What it does
#   • installs Node.js (if missing) and Caddy, a web server that gets free HTTPS certificates
#     from Let's Encrypt automatically and renews them by itself
#   • installs Fast Combo in /opt/fastcombo and runs it as a service (starts on boot, restarts on crash)
#   • points your DuckDNS name at this server and keeps it pointed (checks every 5 minutes)
#   • opens ports 80 and 443 in this server's own firewall (ufw / firewalld / iptables)
# Re-running it is safe. Your settings, access key and password live in /etc/fastcombo/fastcombo.env.

if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
# Started with "curl … | sudo bash", or asked for the newest version? Fetch Fast Combo from GitHub first.
FC_REPO=${FC_REPO:-AfzalAshraf/stremio-addons}
FC_BRANCH=${FC_BRANCH:-main}
_here=$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd) || _here=$PWD
_fetch=0
if [ ! -f "$_here/fastcombo.js" ]; then _fetch=1; fi
case " $* " in *" --update "*) if [ "$_here" = /opt/fastcombo ] && [ -z "${FC_FETCHED:-}" ]; then _fetch=1; fi ;; esac
if [ "$_fetch" = 1 ]; then
  command -v curl >/dev/null 2>&1 || { echo "Please install curl first:  sudo apt install -y curl" >&2; exit 1; }
  _tmp=$(mktemp -d)
  echo "Downloading Fast Combo from github.com/$FC_REPO …"
  if ! curl -fsSL "https://codeload.github.com/$FC_REPO/tar.gz/refs/heads/$FC_BRANCH" | tar xz -C "$_tmp" --strip-components=1 ||
    [ ! -f "$_tmp/install.sh" ] || [ ! -f "$_tmp/fastcombo.js" ]; then
    echo "Download failed. Check the internet connection, or use:  git clone https://github.com/$FC_REPO.git" >&2
    exit 1
  fi
  export FC_FETCHED=1
  if [ ! -t 0 ] && { true </dev/tty; } 2>/dev/null; then exec bash "$_tmp/install.sh" "$@" </dev/tty; fi
  exec bash "$_tmp/install.sh" "$@"
fi
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then exec sudo -E bash "$0" "$@"; fi
  echo "Please run this as root:  sudo bash $0" >&2
  exit 1
fi
set -Eeuo pipefail
umask 022

APP_DIR=/opt/fastcombo
ETC_DIR=/etc/fastcombo
ENV_FILE=$ETC_DIR/fastcombo.env
DDNS_FILE=$ETC_DIR/duckdns.env
DATA_DIR=/var/lib/fastcombo
UNIT_DIR=/etc/systemd/system
DDNS_BIN=/usr/local/sbin/fastcombo-duckdns
CADDY_MAIN=/etc/caddy/Caddyfile
CADDY_SITE=/etc/caddy/fastcombo.caddy
CADDY_BACKUP=/etc/caddy/Caddyfile.before-fastcombo
IMPORT_LINE="import $CADDY_SITE"
SVC_USER=fastcombo
NODE_MAJOR=24
DNS_WAIT=${FC_DNS_WAIT:-180}
HTTPS_WAIT=${FC_HTTPS_WAIT:-180}
LOG=/var/log/fastcombo-install.log
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ -t 1 ]; then
  B=$'\033[1m' D=$'\033[2m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' C=$'\033[36m' N=$'\033[0m'
else
  B='' D='' G='' Y='' R='' C='' N=''
fi
STEP=0
STEPS=6
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d] %s%s\n' "$B" "$STEP" "$STEPS" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
info() { printf '  %s•%s %s\n' "$C" "$N" "$*"; }
warn() { printf '  %s! %s%s\n' "$Y" "$*" "$N"; }
die()  { trap - ERR; printf '\n%s✗ %s%s\n\n' "$R" "$*" "$N" >&2; exit 1; }
trap 'die "Stopped at line $LINENO: $BASH_COMMAND
  Fix the problem shown above, then run the installer again (re-running is safe).
  More details: $LOG"' ERR
trap 'die "Cancelled."' INT

usage() { sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ------------------------------------------------------------------ options
DOMAIN_IN='' TOKEN_IN='' PORT_IN='' MODE=install YES=0 USE_CADDY=1 CADDY_FLAG=''
need_val() { [ -n "${2:-}" ] || die "$1 needs a value (try --help)"; }
while [ $# -gt 0 ]; do
  case $1 in
    --domain)     need_val "$1" "${2:-}"; DOMAIN_IN=$2; shift 2 ;;
    --domain=*)   DOMAIN_IN=${1#*=}; shift ;;
    --token)      need_val "$1" "${2:-}"; TOKEN_IN=$2; shift 2 ;;
    --token=*)    TOKEN_IN=${1#*=}; shift ;;
    --port)       need_val "$1" "${2:-}"; PORT_IN=$2; shift 2 ;;
    --port=*)     PORT_IN=${1#*=}; shift ;;
    --no-caddy)   CADDY_FLAG=0; shift ;;
    --caddy)      CADDY_FLAG=1; shift ;;
    --update)     MODE=update; YES=1; shift ;;
    --uninstall|--remove) MODE=uninstall; shift ;;
    -y|--yes)     YES=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "Unknown option: $1 (try --help)" ;;
  esac
done

# ------------------------------------------------------------------ helpers
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1
APT_OPTS=(-y -q -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
APT_FRESH=0
apt_install() {
  if [ "$APT_FRESH" = 0 ]; then
    info "Refreshing package lists …"
    if ! apt-get "${APT_OPTS[@]}" update >>"$LOG" 2>&1; then
      tail -n 12 "$LOG" >&2
      die "apt-get update failed (see above)."
    fi
    APT_FRESH=1
  fi
  if ! apt-get "${APT_OPTS[@]}" install --no-install-recommends "$@" >>"$LOG" 2>&1; then
    tail -n 15 "$LOG" >&2
    die "Could not install: $* (see above)."
  fi
}
ensure_tools() { # curl + gpg + CA certificates, installed only if missing
  local need=()
  command -v curl >/dev/null 2>&1 || need+=(curl)
  command -v gpg >/dev/null 2>&1 || need+=(gnupg)
  [ -s /etc/ssl/certs/ca-certificates.crt ] || need+=(ca-certificates)
  if [ ${#need[@]} -gt 0 ]; then apt_install "${need[@]}"; fi
}
get_var() { # get_var FILE KEY → value ('' if missing)
  if [ -f "$1" ]; then sed -n "s/^$2=//p" "$1" | tail -n 1 | tr -d "\"'" || true; fi
}
set_var() { # set_var FILE KEY VALUE
  if grep -q "^$2=" "$1" 2>/dev/null; then sed -i "s|^$2=.*|$2=$3|" "$1"; else printf '%s=%s\n' "$2" "$3" >>"$1"; fi
}
ask() { # ask VAR "question"
  [ -t 0 ] || die "Missing information. Run for example:  sudo bash install.sh --domain myaddon --token YOUR-DUCKDNS-TOKEN"
  local a=''
  read -r -p "  $2 " a || true
  printf -v "$1" '%s' "$a"
}
confirm() { # confirm "question" → yes (default) / no
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || die "Add --yes to run without questions."
  local a=''
  read -r -p "  $1 [Y/n] " a || true
  [[ -z $a || $a =~ ^[Yy] ]]
}
normalize_domain() {
  local d=${1,,}
  d=${d//[[:space:]]/}; d=${d#http://}; d=${d#https://}; d=${d%%/*}; d=${d%%:*}; d=${d%.}
  if [ -n "$d" ] && [[ $d != *.* ]]; then d=$d.duckdns.org; fi
  printf '%s' "$d"
}
valid_domain() { [[ $1 =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$ ]]; }
port_users() { # port_users PORT [loopback] → names of programs listening on it ('' if free)
  local out
  out=$(ss -Hltnp "( sport = :$1 )" 2>/dev/null || true)
  if [ "${2:-}" = loopback ]; then # only listeners that clash with 127.0.0.1:PORT
    out=$(awk -v p="$1" '$4 ~ ("^(0\\.0\\.0\\.0|\\*|\\[::\\]|127\\.0\\.0\\.1|\\[::ffff:127\\.0\\.0\\.1\\]):" p "$")' <<<"$out" || true)
  fi
  grep -oE '"[^"]+",pid=' <<<"$out" | cut -d'"' -f2 | sort -u | paste -sd' ' - || true
}
node_ok() { # usable Node.js 18+ that the service account can run?
  local real major
  real=$(readlink -f "$1" 2>/dev/null) || return 1
  [ -x "$real" ] || return 1
  case $real in /root/* | /home/*) return 1 ;; esac
  major=$("$real" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "${major:-0}" -ge 18 ]
}
find_node() {
  local c
  for c in /usr/bin/node /usr/local/bin/node; do
    if node_ok "$c"; then printf '%s' "$c"; return 0; fi
  done
  return 1
}
cfg_value() { # cfg_value NAME → override from fastcombo.env, else the value inside fastcombo.js
  local v
  v=$(get_var "$ENV_FILE" "FC_$1")
  if [ -z "$v" ]; then
    v=$(sed -nE "s/^[[:space:]]*$1:[[:space:]]*\"([^\"]*)\".*/\1/p" "$APP_DIR/fastcombo.js" 2>/dev/null | head -n 1 || true)
  fi
  printf '%s' "$v"
}
wait_until() { # wait_until SECONDS "what we wait for" check_function
  local end=$((SECONDS + $1)) shown=0
  while ! "$3"; do
    if [ "$SECONDS" -ge "$end" ]; then
      if [ "$shown" = 1 ]; then printf '\n'; fi
      return 1
    fi
    if [ "$shown" = 0 ]; then printf '  %s… %s%s' "$D" "$2" "$N"; shown=1; else printf '.'; fi
    sleep 5
  done
  if [ "$shown" = 1 ]; then printf '\n'; fi
  return 0
}
caddy_is_default() { # untouched Caddyfile from the package (only the welcome page)?
  [ ! -s "$CADDY_MAIN" ] && return 0
  grep -q 'The Caddyfile is an easy way to configure your Caddy web server' "$CADDY_MAIN" || return 1
  grep -q 'root \* /usr/share/caddy' "$CADDY_MAIN" || return 1
  [ "$(grep -cvE '^[[:space:]]*(#|$)' "$CADDY_MAIN" || true)" -le 6 ]
}
caddy_error() { # last error Caddy logged (certificate problems etc.)
  journalctl -u caddy --since "-15 min" --no-pager -o cat 2>/dev/null | grep '"level":"error"' | tail -n 1 |
    sed -nE 's/.*"error":"([^"]{0,260}).*/\1/p' || true
}

# ------------------------------------------------------------------ uninstall
do_uninstall() {
  printf '\n%s⚡ Fast Combo — remove from this server%s\n\n' "$B" "$N"
  if [ "$YES" != 1 ]; then
    [ -t 0 ] || die "Add --yes to remove without questions."
    local a=''
    read -r -p "  Remove Fast Combo (service, files and saved settings)? [y/N] " a || true
    if ! [[ $a =~ ^[Yy] ]]; then echo "  Nothing was changed."; exit 0; fi
  fi
  systemctl disable --now fastcombo-duckdns.timer fastcombo.service >/dev/null 2>&1 || true
  systemctl stop fastcombo-duckdns.service >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/fastcombo.service" "$UNIT_DIR/fastcombo-duckdns.service" "$UNIT_DIR/fastcombo-duckdns.timer" "$DDNS_BIN"
  systemctl daemon-reload
  if [ -f "$CADDY_MAIN" ]; then
    if [ -f "$CADDY_BACKUP" ] && [ "$(grep -cvE '^[[:space:]]*(#|$)' "$CADDY_MAIN" || true)" -le 1 ]; then
      mv -f "$CADDY_BACKUP" "$CADDY_MAIN"
    else
      sed -i "\|^$IMPORT_LINE\$|d; /^# ⚡ Fast Combo\$/d" "$CADDY_MAIN"
    fi
  fi
  rm -f "$CADDY_SITE"
  if systemctl is-active --quiet caddy; then systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy || true; fi
  rm -rf "$APP_DIR" "$ETC_DIR" "$DATA_DIR" /var/lib/private/fastcombo
  if id -u "$SVC_USER" >/dev/null 2>&1; then userdel "$SVC_USER" >/dev/null 2>&1 || true; fi
  ok "Fast Combo was removed."
  info "Node.js and Caddy are still installed (to remove them too: sudo apt remove caddy nodejs)"
  info "Your DuckDNS name still exists — delete it on duckdns.org if you don't need it any more"
  echo
}
if [ "$MODE" = uninstall ]; then do_uninstall; exit 0; fi

# ================================================================== 1. checks
printf '\n%s⚡ Fast Combo — VPS setup%s\n' "$B" "$N"
step "Checking this server"
echo "=== $(date) install.sh $MODE" >>"$LOG"
command -v apt-get >/dev/null 2>&1 || die "This installer is for Ubuntu or Debian. For other Linux systems see VPS-SETUP.md (\"Other Linux\")."
[ -d /run/systemd/system ] || die "systemd isn't running on this server, so the service can't be set up. See VPS-SETUP.md (\"Other Linux\")."
for f in fastcombo.js server.js package.json; do
  [ -f "$SRC_DIR/$f" ] || die "Can't find $f next to install.sh. Download Fast Combo again:  git clone https://github.com/$FC_REPO.git"
done
# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
ok "${PRETTY_NAME:-Linux} · $(uname -m) · $(awk '/MemTotal/ {printf "%d MB RAM", $2/1024}' /proc/meminfo)"

OLD_URL=$(get_var "$ENV_FILE" FC_PUBLIC_URL)
OLD_DOMAIN=${OLD_URL#https://}
OLD_DOMAIN=${OLD_DOMAIN%%/*}
OLD_PORT=$(get_var "$ENV_FILE" PORT)
OLD_SUB=$(get_var "$DDNS_FILE" DUCKDNS_SUB)
OLD_TOKEN=$(get_var "$DDNS_FILE" DUCKDNS_TOKEN)
if [ -z "$OLD_DOMAIN" ] && [ "$MODE" = update ]; then die "Fast Combo isn't installed yet — run the installer without --update first."; fi
if [ -n "$CADDY_FLAG" ]; then
  USE_CADDY=$CADDY_FLAG
elif [ -f "$UNIT_DIR/fastcombo.service" ] && [ ! -f "$CADDY_SITE" ] && [ -n "$OLD_DOMAIN" ]; then
  USE_CADDY=0 # it was installed with --no-caddy (use --caddy to switch)
fi

DOMAIN=$(normalize_domain "${DOMAIN_IN:-$OLD_DOMAIN}")
if [ -n "$OLD_DOMAIN" ] && [ -z "$DOMAIN_IN" ]; then ok "Using your saved address: $DOMAIN"; fi
if [ -z "$DOMAIN" ]; then
  printf '\n  Fast Combo needs a web address with HTTPS. Free and easy: %sDuckDNS%s\n' "$B" "$N"
  printf '    1. Open https://www.duckdns.org and sign in (Google, GitHub, Reddit …)\n'
  printf '    2. Type a name, for example  myfastcombo  and press "add domain"\n'
  printf '    3. Keep the page open — you need the token shown at the top\n\n'
  ask DOMAIN_RAW "Your DuckDNS name (e.g. myfastcombo) or your own domain:"
  DOMAIN=$(normalize_domain "$DOMAIN_RAW")
fi
valid_domain "$DOMAIN" || die "\"$DOMAIN\" is not a valid web address."

DUCK=0 SUB='' TOKEN='' IPV6_ONLY=0 PUBLIC_IP=''
if [[ $DOMAIN == *.duckdns.org ]]; then
  DUCK=1
  SUB=${DOMAIN%.duckdns.org}
  SUB=${SUB##*.}
  TOKEN=$TOKEN_IN
  if [ -z "$TOKEN" ] && [ "$OLD_SUB" = "$SUB" ]; then TOKEN=$OLD_TOKEN; fi
  if [ -z "$TOKEN" ]; then ask TOKEN "Your DuckDNS token (top of duckdns.org, looks like a1b2c3d4-…):"; fi
  TOKEN=${TOKEN//[[:space:]]/}
  TOKEN=${TOKEN,,}
  [[ $TOKEN =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    die "That doesn't look like a DuckDNS token. It looks like a1b2c3d4-e5f6-7890-abcd-ef1234567890 — copy it again from the top of duckdns.org."
fi

PORT=${PORT_IN:-${OLD_PORT:-7000}}
if ! [[ $PORT =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then die "--port must be a number from 1024 to 65535."; fi

if [ "$USE_CADDY" = 1 ]; then
  for p in 80 443; do
    users=$(port_users "$p")
    if [ -n "$users" ] && [ "$users" != caddy ]; then
      die "Port $p is already used by: $users
  Caddy needs ports 80 and 443 to get the free HTTPS certificate.
  • An old web server you don't need?  sudo systemctl disable --now ${users%% *}   then run this again
  • Need it for other websites?  Run:  sudo bash install.sh --no-caddy   (see VPS-SETUP.md, \"Already using nginx\")"
    fi
  done
fi
users=$(port_users "$PORT" loopback)
if [ -n "$users" ] && ! systemctl is-active --quiet fastcombo; then
  die "Port $PORT is already used by: $users — run again with another port, e.g.  sudo bash install.sh --port 7010"
fi
if [ "$USE_CADDY" = 1 ]; then ok "Ports 80, 443 and $PORT are available"; else ok "Port $PORT is available (Caddy skipped: you'll use your own web server)"; fi
if ! command -v curl >/dev/null 2>&1; then info "Installing curl …"; apt_install curl ca-certificates; fi

printf '\n  Ready to set up Fast Combo on %shttps://%s%s\n' "$B" "$DOMAIN" "$N"
if [ "$MODE" = install ] && [ -z "$OLD_DOMAIN" ]; then
  info "installs Node.js + $([ "$USE_CADDY" = 1 ] && echo "Caddy (free HTTPS)" || echo "the addon service") — takes 1–3 minutes"
fi
confirm "Continue?" || die "Cancelled — nothing was installed."

# ================================================================== 2. DNS
if [ "$DUCK" = 1 ]; then
  step "Pointing $DOMAIN to this server (DuckDNS)"
  resp=$(curl -4 -fsS --max-time 25 "https://www.duckdns.org/update?domains=$SUB&token=$TOKEN&ip=&verbose=true" 2>/dev/null || true)
  if [ -z "$resp" ]; then # maybe this server has no IPv4 address
    ip6=$(curl -6 -fsS --max-time 15 https://api64.ipify.org 2>/dev/null || true)
    if [ -n "$ip6" ]; then
      resp=$(curl -6 -fsS --max-time 25 "https://www.duckdns.org/update?domains=$SUB&token=$TOKEN&ipv6=$ip6&verbose=true" 2>/dev/null || true)
      IPV6_ONLY=1
    fi
  fi
  case $(head -n 1 <<<"$resp") in
    OK)
      if [ "$IPV6_ONLY" = 1 ]; then PUBLIC_IP=$(sed -n 3p <<<"$resp"); else PUBLIC_IP=$(sed -n 2p <<<"$resp"); fi
      ok "$DOMAIN → $PUBLIC_IP"
      ;;
    KO)
      die "DuckDNS answered KO: the name \"$SUB\" or the token is wrong.
  On duckdns.org check that \"$SUB\" is in YOUR list of domains, and copy the token again."
      ;;
    *) die "Couldn't reach duckdns.org from this server. Check its internet connection and try again." ;;
  esac
else
  step "Checking your domain $DOMAIN"
  PUBLIC_IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 10 https://ifconfig.me 2>/dev/null ||
    curl -fsS --max-time 10 https://api64.ipify.org 2>/dev/null || true)
  if [ -n "$PUBLIC_IP" ]; then ok "This server's public IP: $PUBLIC_IP"; else warn "Couldn't detect this server's public IP"; fi
  info "In your domain's DNS settings, $DOMAIN needs an A record pointing to ${PUBLIC_IP:-this server}"
fi

# ================================================================== 3. software
step "Installing Node.js$([ "$USE_CADDY" = 1 ] && echo " and Caddy")"
NODE=$(find_node || true)
if [ -n "$NODE" ]; then
  ok "Node.js $("$NODE" -v) is already installed"
else
  info "Installing Node.js $NODE_MAJOR (LTS) from NodeSource …"
  ensure_tools
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh || die "Couldn't download the Node.js setup script."
  bash /tmp/nodesource_setup.sh >>"$LOG" 2>&1 || die "The Node.js setup script failed (details: $LOG)."
  APT_FRESH=1 # the NodeSource script already refreshed the package lists
  apt_install nodejs
  NODE=$(find_node || true)
  [ -n "$NODE" ] || die "Node.js was installed but can't be used (version 18 or newer is needed)."
  ok "Node.js $("$NODE" -v) installed"
fi
if [ "$USE_CADDY" = 1 ]; then
  if command -v caddy >/dev/null 2>&1; then
    ok "Caddy $(caddy version 2>/dev/null | awk '{print $1}' || true) is already installed"
  else
    info "Installing Caddy (automatic free HTTPS) …"
    ensure_tools
    if curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>>"$LOG" |
      gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>>"$LOG" &&
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list 2>>"$LOG"; then
      chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
      APT_FRESH=0
    else
      warn "Couldn't add Caddy's official package source — using your system's Caddy package instead"
      rm -f /etc/apt/sources.list.d/caddy-stable.list
    fi
    apt_install caddy
    command -v caddy >/dev/null 2>&1 || die "Caddy could not be installed (details: $LOG)."
    ok "Caddy $(caddy version 2>/dev/null | awk '{print $1}' || true) installed"
  fi
fi

# ================================================================== 4. Fast Combo
step "Installing Fast Combo"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi
install -d -m 755 "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  if [ -f "$APP_DIR/fastcombo.js" ]; then cp -p "$APP_DIR/fastcombo.js" "$APP_DIR/fastcombo.js.previous"; fi
  for f in fastcombo.js server.js package.json install.sh VPS-SETUP.md Dockerfile; do
    if [ -f "$SRC_DIR/$f" ]; then install -m 644 "$SRC_DIR/$f" "$APP_DIR/$f"; fi
  done
  chmod 755 "$APP_DIR/install.sh"
fi
"$NODE" --check "$APP_DIR/fastcombo.js" >>"$LOG" 2>&1 || die "fastcombo.js looks damaged or incomplete — upload it again."
ok "Files copied to $APP_DIR"

gen() { # gen LENGTH [GROUP] → random letters/digits (no look-alikes such as 0/O, 1/l)
  "$NODE" -e 'const a="abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789",c=require("crypto");let t="";for(let i=0;i<+process.argv[1];i++)t+=a[c.randomInt(a.length)];const g=+process.argv[2];console.log(g?t.match(new RegExp(".{1,"+g+"}","g")).join("-"):t)' "$1" "${2:-0}"
}
in_code() { sed -nE "s/^[[:space:]]*$1:[[:space:]]*\"([^\"]+)\".*/\1/p" "$APP_DIR/fastcombo.js" | head -n 1 || true; }
install -d -m 755 "$ETC_DIR"
if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<EOF
# ⚡ Fast Combo settings — after editing run:  sudo systemctl restart fastcombo
# (lines starting with # are ignored)

# Public address of this addon (used in the install links)
FC_PUBLIC_URL=https://$DOMAIN
# Listen only on this machine; the web server in front (Caddy) adds HTTPS
HOST=127.0.0.1
PORT=$PORT
# Where the control panel saves your addon list and the "new link" history
FC_DATA_FILE=$DATA_DIR/kv.json
NODE_ENV=production

# Optional:
# FC_ADDON_NAME="⚡ Fast Combo"
# FC_MAX_ADDONS=50

# Your private keys, created on this server at install time. Keep them secret.
# FC_ADMIN_PASSWORD opens the control panel; change it any time (then restart).
EOF
else
  set_var "$ENV_FILE" FC_PUBLIC_URL "https://$DOMAIN"
  set_var "$ENV_FILE" HOST 127.0.0.1
  set_var "$ENV_FILE" PORT "$PORT"
  set_var "$ENV_FILE" FC_DATA_FILE "$DATA_DIR/kv.json"
fi
for kv in "FC_ACCESS_KEY ACCESS_KEY 12 0" "FC_ADMIN_PASSWORD ADMIN_PASSWORD 12 4" "FC_SECRET SECRET 32 0"; do
  read -r e c n g <<<"$kv"
  if [ -z "$(get_var "$ENV_FILE" "$e")" ] && [ -z "$(in_code "$c")" ]; then set_var "$ENV_FILE" "$e" "$(gen "$n" "$g")"; fi
done
chmod 600 "$ENV_FILE"

write_main_unit() { # $1 = 1 → with sandboxing (safer), 0 → plain (for VPS types that don't support it)
  {
    cat <<EOF
[Unit]
Description=Fast Combo (Stremio addon)
Documentation=file://$APP_DIR/VPS-SETUP.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$NODE $APP_DIR/server.js
Restart=always
RestartSec=3
TimeoutStopSec=10
StateDirectory=fastcombo
StateDirectoryMode=0700
EOF
    if [ "$1" = 1 ]; then
      cat <<EOF
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
EOF
    fi
    printf '\n[Install]\nWantedBy=multi-user.target\n'
  } >"$UNIT_DIR/fastcombo.service"
}
KEY=$(cfg_value ACCESS_KEY)
PASS=$(cfg_value ADMIN_PASSWORD)
[ -n "$KEY" ] || die "Couldn't read ACCESS_KEY from fastcombo.js."
local_ok() { curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/$KEY/manifest.json" 2>/dev/null; }

write_main_unit 1
systemctl daemon-reload
systemctl enable fastcombo.service >/dev/null 2>&1
systemctl restart fastcombo.service
if ! wait_until 25 "starting" local_ok; then
  warn "Retrying without the extra service sandboxing (not supported on some VPS types) …"
  write_main_unit 0
  systemctl daemon-reload
  systemctl restart fastcombo.service
  if ! wait_until 25 "starting" local_ok; then
    journalctl -u fastcombo -n 25 --no-pager >&2 || true
    die "Fast Combo did not start (its log is above)."
  fi
fi
VER=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/$KEY/manifest.json" 2>/dev/null | sed -nE 's/.*"version":"([^"]+)".*/\1/p' || true)
ok "Fast Combo ${VER:+v$VER }is running as a service (starts on boot, restarts by itself)"

if [ "$DUCK" = 1 ]; then
  (
    umask 077
    printf '# DuckDNS name + token that keep %s pointed at this server\nDUCKDNS_SUB=%s\nDUCKDNS_TOKEN=%s\nDUCKDNS_IPV6=%s\n' \
      "$DOMAIN" "$SUB" "$TOKEN" "$IPV6_ONLY" >"$DDNS_FILE"
  )
  cat >"$DDNS_BIN" <<'EOF'
#!/bin/sh
# Points your DuckDNS name at this server's current IP address.
# Runs every 5 minutes (fastcombo-duckdns.timer). Manual run:  sudo fastcombo-duckdns
if [ -z "$DUCKDNS_TOKEN" ] && [ -r /etc/fastcombo/duckdns.env ]; then . /etc/fastcombo/duckdns.env; fi
if [ "${DUCKDNS_IPV6:-0}" = 1 ]; then
  ip6=$(curl -6 -fsS --max-time 15 https://api64.ipify.org) || { echo "could not detect this server's IPv6 address" >&2; exit 1; }
  r=$(curl -fsS --max-time 25 "https://www.duckdns.org/update?domains=$DUCKDNS_SUB&token=$DUCKDNS_TOKEN&ipv6=$ip6")
else
  r=$(curl -4 -fsS --max-time 25 "https://www.duckdns.org/update?domains=$DUCKDNS_SUB&token=$DUCKDNS_TOKEN&ip=")
fi
if [ "$r" = OK ]; then exit 0; fi
echo "DuckDNS update failed: ${r:-no answer from duckdns.org}" >&2
exit 1
EOF
  chmod 755 "$DDNS_BIN"
  cat >"$UNIT_DIR/fastcombo-duckdns.service" <<EOF
[Unit]
Description=Fast Combo: keep $DOMAIN pointed at this server
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$SVC_USER
EnvironmentFile=$DDNS_FILE
ExecStart=$DDNS_BIN
EOF
  cat >"$UNIT_DIR/fastcombo-duckdns.timer" <<EOF
[Unit]
Description=Fast Combo: refresh DuckDNS every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
RandomizedDelaySec=20

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now fastcombo-duckdns.timer >/dev/null 2>&1
  ok "DuckDNS auto-update is on (every 5 minutes)"
else
  if [ -f "$UNIT_DIR/fastcombo-duckdns.timer" ]; then
    systemctl disable --now fastcombo-duckdns.timer >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/fastcombo-duckdns.timer" "$UNIT_DIR/fastcombo-duckdns.service" "$DDNS_BIN" "$DDNS_FILE"
    systemctl daemon-reload
  fi
fi

# ================================================================== 5. HTTPS + firewall
open_firewall() {
  local ufw_status rules changed=0 ipt p
  if command -v ufw >/dev/null 2>&1; then
    ufw_status=$(ufw status 2>/dev/null || true)
    if [[ $ufw_status == *"Status: active"* ]]; then
      ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
      ok "Firewall (ufw): ports 80 and 443 are open"
      return 0
    fi
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd -q --permanent --add-service=http --add-service=https && firewall-cmd -q --reload
    ok "Firewall (firewalld): ports 80 and 443 are open"
    return 0
  fi
  for ipt in iptables ip6tables; do
    command -v "$ipt" >/dev/null 2>&1 || continue
    rules=$("$ipt" -S INPUT 2>/dev/null || true)
    if grep -qE -- '^-P INPUT DROP|-j (REJECT|DROP)' <<<"$rules"; then
      for p in 443 80; do
        if ! "$ipt" -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null; then
          "$ipt" -I INPUT 1 -p tcp --dport "$p" -j ACCEPT && changed=1
        fi
      done
    fi
  done
  if [ "$changed" = 1 ]; then
    if command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1; then
      ok "Firewall (iptables): opened ports 80 and 443 (saved for reboots)"
    else
      warn "Firewall (iptables): opened ports 80 and 443 until the next reboot — run: sudo apt install iptables-persistent"
    fi
    return 0
  fi
  ok "This server's own firewall isn't blocking ports 80/443"
}

if [ "$USE_CADDY" = 1 ]; then
  step "Setting up HTTPS (Caddy) and the firewall"
  cat >"$CADDY_SITE" <<EOF
# ⚡ Fast Combo — written by install.sh (running the installer again rewrites this file)
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  install -d -m 755 /etc/caddy
  if caddy_is_default; then
    if [ -f "$CADDY_MAIN" ] && [ ! -f "$CADDY_BACKUP" ]; then cp -p "$CADDY_MAIN" "$CADDY_BACKUP"; fi
    printf '# Caddy configuration. Add your own sites below.\n# (The original welcome-page config was saved as %s)\n\n# ⚡ Fast Combo\n%s\n' \
      "$CADDY_BACKUP" "$IMPORT_LINE" >"$CADDY_MAIN"
  elif ! grep -qxF "$IMPORT_LINE" "$CADDY_MAIN"; then
    cp -p "$CADDY_MAIN" "$CADDY_MAIN.bak-$(date +%Y%m%d-%H%M%S)"
    printf '\n# ⚡ Fast Combo\n%s\n' "$IMPORT_LINE" >>"$CADDY_MAIN"
  fi
  if ! caddy validate --adapter caddyfile --config "$CADDY_MAIN" >>"$LOG" 2>&1; then
    grep -iE 'error|Error' "$LOG" | tail -n 3 >&2 || true
    die "Caddy didn't accept the configuration (see above). If $DOMAIN is already set up in $CADDY_MAIN, remove it there and run this again."
  fi
  systemctl enable caddy >/dev/null 2>&1 || true
  if systemctl is-active --quiet caddy; then systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy; else systemctl restart caddy; fi
  ok "Caddy serves https://$DOMAIN (the certificate renews automatically)"
  open_firewall
else
  step "Web server (skipped: --no-caddy)"
  info "Point your web server for $DOMAIN to http://127.0.0.1:$PORT — example in VPS-SETUP.md (\"Already using nginx\")"
fi

# ================================================================== 6. final checks
step "Final checks"
dns_ok() { [ -z "$PUBLIC_IP" ] && return 0; [[ " $(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd' ' - || true) " == *" $PUBLIC_IP "* ]]; }
https_ok() { curl -fsS -o /dev/null --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/$KEY/manifest.json" 2>/dev/null; }
DNS_GOOD=1 HTTPS_GOOD=1
if wait_until "$DNS_WAIT" "waiting for $DOMAIN to point here (DNS)" dns_ok; then
  ok "$DOMAIN points to this server"
else
  DNS_GOOD=0
  now_ips=$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd' ' - || true)
  if [ -n "$now_ips" ]; then
    warn "$DOMAIN doesn't point to this server yet: it points to $now_ips, this server is $PUBLIC_IP"
  else
    warn "$DOMAIN doesn't exist in DNS yet (it should point to $PUBLIC_IP)"
  fi
fi
if [ "$USE_CADDY" = 1 ]; then
  if wait_until "$HTTPS_WAIT" "getting the free HTTPS certificate" https_ok; then
    ok "HTTPS works: https://$DOMAIN"
  else
    HTTPS_GOOD=0
    warn "HTTPS isn't working yet."
    if [ "$DNS_GOOD" = 0 ]; then
      info "Your address must point to this server first (see the DNS line above)."
    else
      info "Most likely ports 80 and 443 are closed in your VPS provider's firewall (on their website):"
      info "Oracle Cloud: Security List · AWS: Security Group / Lightsail Networking · Google Cloud: VPC firewall · Azure: NSG"
      info "Open TCP 80 and 443 there. Caddy keeps retrying by itself, so it starts working a few minutes later."
    fi
    err=$(caddy_error)
    if [ -n "$err" ]; then info "Caddy says: ${err:0:220}"; fi
  fi
fi

printf '\n'
if [ "$USE_CADDY" = 0 ]; then
  printf '%s%sFast Combo is running — point your web server to it (nginx example at the bottom), then these links work:%s\n\n' "$G" "$B" "$N"
elif [ "$HTTPS_GOOD" = 1 ] && [ "$DNS_GOOD" = 1 ]; then
  printf '%s%s✅ Fast Combo is ready!%s\n\n' "$G" "$B" "$N"
else
  printf '%s%sFast Combo is installed — finish the step marked ! above, then these links work:%s\n\n' "$Y" "$B" "$N"
fi
printf '  Control panel   %shttps://%s/%s/configure%s\n' "$B" "$DOMAIN" "$KEY" "$N"
printf '  Password        %s%s%s\n' "$B" "$PASS" "$N"
printf '  Addon link      https://%s/%s/manifest.json\n\n' "$DOMAIN" "$KEY"
printf '  Next: open the control panel, add your addons (➕), then 📲 Install in Stremio.\n\n'
printf '  %sHandy commands%s\n' "$B" "$N"
printf '    sudo systemctl status fastcombo     is it running?\n'
printf '    sudo journalctl -u fastcombo -f     live log (Ctrl+C to stop watching)\n'
printf '    sudo systemctl restart fastcombo    restart it\n'
printf '    sudo bash %s/install.sh --update     get the newest version (keeps settings + addons)\n' "$APP_DIR"
printf '    sudo bash %s/install.sh --uninstall  remove it\n' "$APP_DIR"
printf '    sudo cat %s                password, key and other settings\n\n' "$ENV_FILE"
if [ "$USE_CADDY" = 0 ]; then
  printf '  %snginx example%s (then: sudo certbot --nginx -d %s)\n' "$B" "$N" "$DOMAIN"
  printf '    server {\n      server_name %s;\n      location / {\n        proxy_pass http://127.0.0.1:%s;\n' "$DOMAIN" "$PORT"
  # shellcheck disable=SC2016  # $host/$scheme are nginx variables, printed as-is
  printf '        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_read_timeout 60s;\n      }\n    }\n\n'
fi
