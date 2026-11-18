# Remote server mode over Tailscale (fork)

This fork can run the LearnHarness server on a machine that you own and make
it reachable **only on your tailnet**. One server then owns all chats, the
knowledge graph and settings. You use it from:

- a browser on any of your devices (phone, tablet, laptop) that runs Tailscale;
- the desktop app, in **server mode**. No password or token is needed.

The desktop app can still run fully local. You choose in
**LearnHarness → LearnHarness Server…**.

**Recommended: a machine at home** (a home server, a mini PC, a Raspberry Pi 5
or your desktop PC). A VPS is a supported alternative (see
[Alternative: install on a VPS](#alternative-install-on-a-vps)).

Why home first:

- Your learning data and your API keys stay on your own hardware.
- You open no ports and change nothing on your router. The server is not on
  the public internet at all.
- It works behind CGNAT and other NATs that you do not control: Tailscale
  connects out, and it falls back to its relays when a direct path is not
  possible.
- Your phone and tablet reach it over the tailnet from anywhere, not only at
  home.

The cost: the machine must stay on. If it is off, the server is off (see
[When the home machine is off](#when-the-home-machine-is-off)).

## Contents

- [Design](#design)
- [Server settings](#server-settings)
- [Install on a home machine (recommended)](#install-on-a-home-machine-recommended)
  - [A. Tailnet settings](#a-tailnet-settings-admin-console-once)
  - [B. Tailscale on your devices](#b-tailscale-on-your-devices)
  - [C. Prepare the home machine](#c-prepare-the-home-machine)
  - [D. Get the files](#d-get-the-files)
  - [E. Settings](#e-settings)
  - [F. Build the image](#f-build-the-image)
  - [G. First start and health check](#g-first-start-and-health-check)
  - [H. Move your local data to the server](#h-move-your-local-data-to-the-server)
  - [I. Desktop app](#i-desktop-app)
  - [J. Phone](#j-phone)
- [Run it at home](#run-it-at-home): stay awake, start on boot, backups,
  updates, when the machine is off, resources
- [Alternative: install on a VPS](#alternative-install-on-a-vps)
- [Troubleshooting](#troubleshooting)
- [Limits](#limits)

## Design

```
 your devices (Tailscale app, logged in as you)
 phone browser ─┐
 tablet app ────┼── WireGuard (tailnet) ──┐
 laptop ────────┘                         │
                    ┌───────── home machine or VPS (Docker) ────────┐
                    │ learnharness-ts  (tailscale/tailscale sidecar)│
                    │   tailscale serve: https://learnharness.<tailnet>.ts.net
                    │     adds Tailscale-User-Login, proxies to ──┐ │
                    │ learnharness-ts-app (same network namespace)│ │
                    │   node server.js on 127.0.0.1:3000  ◄───────┘ │
                    │   /data volume                                │
                    └───────────────────────────────────────────────┘
```

- **Tailscale sidecar.** The official `tailscale/tailscale` container joins
  your tailnet as its own machine (`learnharness`). Its `tailscale serve`
  gets a Let's Encrypt certificate for `learnharness.<tailnet>.ts.net`,
  terminates HTTPS on port 443 of the tailnet address only, and proxies to
  `http://127.0.0.1:3000`. Funnel (public internet) is off. It runs in
  userspace networking mode, so it needs no `/dev/net/tun` and no
  `NET_ADMIN`. That is why the same compose file runs on Docker Engine
  (Linux, amd64 or arm64) and on Docker Desktop (Windows, macOS).
- **Shared network namespace.** The app container uses
  `network_mode: service:tailscale`, so it has no network interface of its own.
  The server listens on `127.0.0.1` (`HOSTNAME=127.0.0.1`). Only the sidecar
  can reach it. No host port is published, so no other container on the
  machine, no process on the host and no device on your home network can
  connect to it.
- **Identity check in the app.** For every request from a device that is
  owned by a tailnet user, Serve adds `Tailscale-User-Login` (for example
  `you@example.com`) and removes any copy of that header that the client sent.
  The server checks this header on **every** page and API request
  (`src/server/remote-access.ts`, `proxy.ts`) against
  `LH_TAILSCALE_ALLOWED_LOGINS`. A missing header or another login gets
  HTTP 403. Only `GET /api/health` is open; it returns no data. Requests from
  tagged devices carry no user, so they are refused.
- **Fail closed.** In remote mode the server does not start when
  `LH_TAILSCALE_ALLOWED_LOGINS` or `LH_PUBLIC_ORIGIN` is missing or wrong, or
  when `HOSTNAME` is not a loopback address.
- **Origin pinning.** `LH_PUBLIC_ORIGIN` (`https://learnharness.<tailnet>.ts.net`)
  is the only allowed host name besides IP addresses and the origin for the
  cross-site write check. Forwarded headers are never trusted.
- Answers are generated on the server, not in your browser tab. If a device
  disconnects or the phone sleeps, open the chat again: the running answer
  replays and continues. Turn streams send a heartbeat every 20 s.

### Why this design

| Option | Result |
|---|---|
| [tailcat](https://github.com/tailscale/tailcat) | Not used. It is "netcat over Tailscale's data plane" without the control plane: raw TCP/UDP tunnels between two peers that exchange addresses out of band. It has no tailnet, no MagicDNS, no HTTPS certificates and no user identity. Each device would need the tailcat client, and the phone has none. |
| No Docker: host Tailscale + `tailscale serve` + Node under a systemd user service | Not used. The server would listen on the host's `127.0.0.1:3000`, which every process and every user account on that machine can reach, and any of them could send a forged `Tailscale-User-Login` header. The host's own Tailscale machine (your PC's name) would carry the certificate, and Serve would take its port 443. You would also need the right Node version and must build the native modules on the host. The container keeps all of this sealed and is the same on every OS. |
| `tsnet` (Tailscale inside the server process) | Not used. It is a Go library. The server is Node.js, so it would need a Go proxy that we build and maintain. |
| **Sidecar container + `tailscale serve`** | **Used.** Official image, no code to maintain, its own machine name and certificate, no changes to the host or its Tailscale, and the shared loopback means nothing else can reach the server. |

## Server settings

| Variable | Where | Value |
|---|---|---|
| `TS_AUTHKEY` | `.env` | one-time Tailscale auth key (first start only) |
| `TS_HOSTNAME` | `.env` | machine name on the tailnet, default `learnharness` |
| `LH_SERVER_MODE` | `app.env` | `remote` (also set in the image) |
| `LH_TAILSCALE_ALLOWED_LOGINS` | `app.env` | your Tailscale login name(s), comma-separated |
| `LH_PUBLIC_ORIGIN` | `app.env` | `https://<TS_HOSTNAME>.<tailnet>.ts.net` |
| `HOSTNAME` | image + compose | `127.0.0.1` (must be loopback) |
| `LH_DATA_DIR` | image | `/data/data` |
| `LH_AUTH_FILE` | image | `/data/auth.json`: your API keys |

Templates: `deploy/compose.example.yml`, `deploy/tailscale/serve.json`,
`deploy/compose.env.example`, `deploy/app.env.example`. They contain
placeholders only. The two env files are separate so that the Tailscale auth
key never reaches the app container.

## Install on a home machine (recommended)

The examples use the stack folder `~/learnharness-server` (on Windows
`$HOME\learnharness-server`). Replace `tail1234.ts.net` with your tailnet DNS
name and `you@example.com` with your Tailscale login everywhere.

On Linux, run the `docker` commands with `sudo` if your user is not in the
`docker` group. Windows commands are for PowerShell.

### A. Tailnet settings (admin console, once)

1. Open <https://login.tailscale.com/admin/dns>.
2. Under **Nameservers / MagicDNS**, make sure **MagicDNS** is on.
3. Under **HTTPS Certificates**, select **Enable HTTPS**.
   Note: every certificate is published in the public Certificate Transparency
   logs. The machine name (`learnharness`) and your tailnet DNS name become
   public. Do not use a secret machine name.
4. Write down the **Tailnet DNS name** on that page, for example
   `tail1234.ts.net`. Your server URL is `https://learnharness.tail1234.ts.net`.
5. Open <https://login.tailscale.com/admin/users> and write down your login
   name exactly as shown (for example `you@example.com` or `yourname@github`).
   This is the value for `LH_TAILSCALE_ALLOWED_LOGINS`.
6. If you changed the tailnet policy (ACLs or grants) from the default, allow
   your user to reach the `learnharness` machine on TCP port 443. The default
   policy already allows this.

### B. Tailscale on your devices

1. **Phone:** install Tailscale from the App Store or Google Play. Log in with
   the same account. Keep the VPN on when you use LearnHarness.
2. **Tablet or laptop (Linux, including aarch64):** install Tailscale from your
   distribution's packages or with the official instructions at
   <https://tailscale.com/download/linux> (they support arm64). Then:
   ```sh
   sudo systemctl enable --now tailscaled
   sudo tailscale up
   ```
   Open the login URL that it prints and log in with the same account.
3. **Windows or macOS laptop:** install Tailscale from
   <https://tailscale.com/download> and log in with the same account.
4. Make sure each device uses MagicDNS:
   ```sh
   tailscale status
   ```
   On Linux, if names do not resolve later, run
   `sudo tailscale set --accept-dns=true`.
5. **The home machine itself** does not need Tailscale on the host. The
   sidecar container is its own machine on the tailnet. If the host already
   runs Tailscale, nothing changes for it.

### C. Prepare the home machine

Pick the section for your machine. Every option needs about 2 GB of free disk
space for the image and its build cache, plus your data.

#### C1. Linux home server or mini PC (amd64)

1. Use any current 64-bit Linux with systemd (for example Debian, Ubuntu
   Server, Fedora).
2. Install Docker Engine and the compose plugin: your distribution's
   packages (`docker.io` + `docker-compose-v2` on Debian/Ubuntu, `moby-engine`
   + `docker-compose` on Fedora) or the instructions at
   <https://docs.docker.com/engine/install/>.
3. Start Docker now and at every boot:
   ```sh
   sudo systemctl enable --now docker
   docker compose version
   ```
4. Install `git` (`sudo apt install git` or `sudo dnf install git`).
5. Do the steps in [Stay awake](#stay-awake) for Linux before you rely on it.

#### C2. Raspberry Pi 5 or another arm64 board

1. Install a **64-bit** OS (Raspberry Pi OS 64-bit, Debian or Ubuntu arm64).
   A 32-bit OS does not work: the Node base image is amd64 and arm64 only.
2. Put Docker's data on an SSD (USB or NVMe) if you can. An SD card wears out
   faster and is slow for the build.
3. Memory: the image build needs more memory than the running server (see
   [Resources](#resources)). On a 4 GB board, add swap before you build. On
   Raspberry Pi OS:
   ```sh
   sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=4096/' /etc/dphys-swapfile
   sudo systemctl restart dphys-swapfile
   free -h
   ```
   (On other distributions, create a swap file with `fallocate`, `mkswap` and
   `swapon`.)
4. Then do steps 2 to 5 of C1 (Docker, autostart, git).

#### C3. Windows PC with Docker Desktop

1. Install Docker Desktop from <https://docs.docker.com/desktop/>. Use the
   WSL 2 backend (the default). Check that its license terms fit your use.
2. In Docker Desktop, open **Settings → General** and turn on **Start Docker
   Desktop when you sign in to your computer**.
3. Open **Settings → Resources** (shown when you do not use WSL 2) or
   `%UserProfile%\.wslconfig` (WSL 2) and allow at least 6 GB of memory for
   the build. Example `.wslconfig`:
   ```ini
   [wsl2]
   memory=6GB
   ```
   Then run `wsl --shutdown` and start Docker Desktop again.
4. Install Git for Windows (<https://git-scm.com/download/win>).
5. Docker Desktop starts only after you sign in to Windows. After a restart
   (for example a Windows update), the server is off until you sign in. See
   [Start on boot](#start-on-boot).
6. Do the steps in [Stay awake](#stay-awake) for Windows.

The sidecar needs no extra settings on Docker Desktop: it uses userspace
networking (`TS_USERSPACE=true` in the compose file).

#### C4. macOS with Docker Desktop

1. Install Docker Desktop from <https://docs.docker.com/desktop/> (Apple
   silicon or Intel build).
2. In Docker Desktop, open **Settings → General** and turn on **Start Docker
   Desktop when you sign in to your computer**.
3. Open **Settings → Resources** and set **Memory** to at least 6 GB for the
   build. You can lower it again after the build.
4. Install git: `xcode-select --install` (or Homebrew `brew install git`).
5. Docker Desktop starts only after you sign in. See
   [Start on boot](#start-on-boot) and [Stay awake](#stay-awake) for macOS.

### D. Get the files

Linux and macOS:

```sh
mkdir -p ~/learnharness-server && cd ~/learnharness-server
git clone --branch remote-tailscale https://github.com/nadelacruz-00/learnharness.git src
cp src/deploy/compose.example.yml compose.yml
mkdir -p tailscale && cp src/deploy/tailscale/serve.json tailscale/serve.json
cp src/deploy/compose.env.example .env
cp src/deploy/app.env.example app.env
chmod 600 .env app.env
```

Windows (PowerShell). `core.autocrlf=false` keeps Linux line endings in the
files that go into the image:

```powershell
New-Item -ItemType Directory -Force "$HOME\learnharness-server" | Out-Null
Set-Location "$HOME\learnharness-server"
git clone -c core.autocrlf=false --branch remote-tailscale https://github.com/nadelacruz-00/learnharness.git src
Copy-Item src\deploy\compose.example.yml compose.yml
New-Item -ItemType Directory -Force tailscale | Out-Null
Copy-Item src\deploy\tailscale\serve.json tailscale\serve.json
Copy-Item src\deploy\compose.env.example .env
Copy-Item src\deploy\app.env.example app.env
```

The folder now has `compose.yml`, `.env`, `app.env`, `tailscale/serve.json`
and `src/`.

### E. Settings

1. Create an auth key: <https://login.tailscale.com/admin/settings/keys> →
   **Generate auth key**. Not reusable, not ephemeral. Pre-approved, if your
   tailnet uses device approval. Copy the key (it starts with `tskey-auth-`).
2. Edit `.env`: set `TS_AUTHKEY` to that key. Keep `TS_HOSTNAME=learnharness`
   or choose another name.
3. Edit `app.env`:
   ```sh
   LH_SERVER_MODE=remote
   LH_TAILSCALE_ALLOWED_LOGINS=you@example.com
   LH_PUBLIC_ORIGIN=https://learnharness.tail1234.ts.net
   ```
   `LH_PUBLIC_ORIGIN` must use the same machine name as `TS_HOSTNAME`.

### F. Build the image

Build on the machine that runs the server. Native modules
(`@napi-rs/canvas`, `@resvg/resvg-js`, photon) are built for the build
machine's architecture: an image built on an arm64 machine does not run on an
amd64 machine, and the reverse.

1. In the stack folder:
   ```sh
   docker compose build app
   ```
   This takes a few minutes on a current PC (the build steps took about
   2 minutes on an 8-core arm64 machine, plus the downloads) and longer on a
   Raspberry Pi.
2. If the Next build stops once with a security-upgrade notice from Next, run
   the same command again. Do not run the upgrade that it suggests.
3. If the build stops with an out-of-memory error, give Docker more memory or
   add swap (step C2, C3 or C4).

### G. First start and health check

1. Start the stack and follow the sidecar's log:
   ```sh
   docker compose up -d
   docker compose logs -f tailscale
   ```
   Wait until the log shows that the machine is logged in and the serve
   config is applied. Press Ctrl+C to stop following the log.
2. Check the sidecar:
   ```sh
   docker exec learnharness-ts tailscale status
   docker exec learnharness-ts tailscale serve status
   ```
   `serve status` must show `https://learnharness.tail1234.ts.net` →
   `proxy http://127.0.0.1:3000` and no Funnel. If the machine name has a
   suffix (for example `learnharness-1`, because the name was taken), change
   `LH_PUBLIC_ORIGIN` in `app.env` to match and run `docker compose up -d app`.
3. Check the app:
   ```sh
   docker compose ps
   docker compose logs app
   ```
   After about 30 s the app must be `healthy`, and the log must show
   `Remote server mode (Tailscale): https://learnharness…`.
4. On **another device** on the tailnet (tablet or laptop), check health and
   identity:
   ```sh
   curl https://learnharness.tail1234.ts.net/api/health
   # {"ok":true}
   curl https://learnharness.tail1234.ts.net/api/whoami
   # {"ok":true,"remote":true,"login":"you@example.com"}
   ```
   The first HTTPS request can take a few seconds while the certificate is
   issued.
5. A device that is **not** on the tailnet cannot resolve or reach that name.
   A device on your home network that is not on the tailnet cannot reach the
   server either. That is correct.
6. In the Tailscale admin console, open **Machines** → `learnharness` → **…** →
   **Disable key expiry**. Otherwise the server drops off the tailnet when its
   key expires.
7. Remove the auth key from `.env` (delete the `TS_AUTHKEY=` line, or leave it
   empty). The machine key is now in the `learnharness-ts_ts-state` volume.
   Revoke the auth key in the admin console if it is still listed.
8. Open `https://learnharness.tail1234.ts.net` in a browser on the phone. Add
   your API keys in **Settings → Providers**. They are stored on the server in
   `/data/auth.json`.

### H. Move your local data to the server

Do this once, before you use the server for new chats.

**With the desktop app:** **LearnHarness → Copy Local Data to Server…** sends
this computer's data folder (chats, knowledge graph, settings, plugin data) to
the server. If the server already has chats, the app asks first. The server
then saves a backup in `/data/backups/<time>/` before it replaces its data.
API keys and logins are never copied.

**Without the desktop app** (from a device on the tailnet, in a checkout of
the source):

```sh
node scripts/data-archive.mjs export ~/.config/LearnHarness/data learnharness-data.tar.gz
curl -X POST --data-binary @learnharness-data.tar.gz -H 'Content-Type: application/gzip' \
  https://learnharness.tail1234.ts.net/api/data/import
```

No token is needed: Serve identifies your device. Add `?replace=1` to the URL
to replace data that is already on the server (the server keeps a backup).

**Archives larger than 26 MB** are cut by the request size limit, and the
server refuses them (`{"error":"truncated"}`). Copy the archive into the stack
folder on the server machine and import it there with the app stopped
(Linux/macOS; on Windows leave out the `chown` line and use `"${PWD}\src"` and
`"${PWD}"` in the mounts):

```sh
cd ~/learnharness-server
# The archive is mode 600; the import runs as the image's user (uid 10001).
sudo chown 10001:10001 learnharness-data.tar.gz
docker compose stop app
docker run --rm --user 10001:10001 \
  -v learnharness-ts_data:/data -v "$PWD/src":/src:ro -v "$PWD":/in:ro \
  node:26-bookworm-slim node /src/scripts/data-archive.mjs import /in/learnharness-data.tar.gz /data/data
docker compose start app
```

### I. Desktop app

1. Make sure Tailscale is connected on that computer (`tailscale status`).
2. Open **LearnHarness → LearnHarness Server…**.
3. Select **LearnHarness server** and enter
   `https://learnharness.tail1234.ts.net`.
4. Select **Test connection**. It must say
   `Connected as you@example.com. The server accepts this device.`
5. Select **Save and restart**.

The profile stores only the mode and the address
(`<userData>/server-profile.json`). There is no secret to store. A profile from
an older build with a stored service token is read without error; the old
fields are dropped on the next save.

In server mode, attaching local file paths is off (the server cannot read your
computer's files). ChatGPT subscription login does not work in server mode;
use API keys (or the device-code subscription logins). To go back to local
mode, open the same window and select **This computer**.

You can also run the desktop app on the home machine itself and point it at
the server, if that machine runs Tailscale on the host.

### J. Phone

1. Connect the Tailscale app.
2. Open `https://learnharness.tail1234.ts.net` in the browser.
3. Optional: **Add to Home Screen**.

## Run it at home

### Stay awake

The server answers only while the machine is on and awake.

**Linux (server, mini PC, desktop):**

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

On a laptop, also set `HandleLidSwitch=ignore` (and
`HandleLidSwitchExternalPower=ignore`) in `/etc/systemd/logind.conf`, then
`sudo systemctl restart systemd-logind`. A Raspberry Pi does not suspend.
To undo: `sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target`.

**Windows:** **Settings → System → Power & battery → Screen and sleep**: set
"When plugged in, put my device to sleep after" to **Never**. Or in
PowerShell:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

**macOS:** **System Settings → Energy** (desktop Macs) or **Battery →
Options** (laptops): turn on **Prevent automatic sleeping when the display is
off** (on power adapter) and **Start up automatically after a power failure**
where it is shown. Or in Terminal:

```sh
sudo pmset -c sleep 0
```

The screen can still turn off; only system sleep must be off.

### Start on boot

- **Both containers** have `restart: unless-stopped`: they start again when
  Docker starts, unless you stopped them with `docker compose stop`.
- **Linux (Docker Engine):** `sudo systemctl enable docker` (step C1). The
  server is back after a reboot without a login.
- **Windows and macOS (Docker Desktop):** Docker Desktop starts at **sign-in**
  (steps C3/C4). After a reboot the server is off until a user signs in. On a
  machine that is only a server, you can turn on automatic sign-in (macOS:
  **System Settings → Users & Groups → Automatically log in as**; this is not
  available with FileVault on). Check after Windows updates that you are
  signed in.

### Backups

Server data is in the Docker volume `learnharness-ts_data`. It includes
`auth.json` (your API keys). Keep backups private.

1. **To a local or external disk.** Mount the disk (Linux example:
   `/mnt/backup`; Windows example: `E:\Backups`; macOS example:
   `/Volumes/Backup`) and run, with the same quotes on every OS:
   ```sh
   docker run --rm -v learnharness-ts_data:/data:ro -v /mnt/backup:/out node:26-bookworm-slim sh -c 'tar czf /out/learnharness-$(date +%F).tar.gz -C /data .'
   ```
   On Windows replace `/mnt/backup` with `E:\Backups`. On Docker Desktop for
   macOS, the folder must be in a shared location (`/Volumes` and `/Users` are
   shared by default).
2. **Schedule it:** cron on Linux (`sudo crontab -e`, for example
   `30 3 * * * docker run …`), Task Scheduler on Windows (action `docker`,
   arguments the rest of the command), cron or launchd on macOS. Delete old
   archives from time to time.
3. **Restore** a backup. The current data is moved to `/data/pre-restore`
   first, not deleted. The command stops without changes if
   `/data/pre-restore` already exists from an earlier restore:
   ```sh
   docker compose stop app
   docker run --rm -v learnharness-ts_data:/data -v /mnt/backup:/in:ro node:26-bookworm-slim sh -c 'mkdir /data/pre-restore && mv /data/data /data/home /data/pre-restore/ && { mv /data/auth.json /data/pre-restore/ 2>/dev/null || true; } && tar xzf /in/learnharness-2026-11-18.tar.gz -C /data'
   docker compose start app
   ```
   When the restored server works, delete the old copy:
   `docker run --rm -v learnharness-ts_data:/data node:26-bookworm-slim rm -r /data/pre-restore`.
4. **A portable copy without secrets**, from any device on the tailnet:
   ```sh
   curl -o learnharness-export.tar.gz https://learnharness.tail1234.ts.net/api/data/export
   ```
   It returns HTTP 409 while an answer is running. Try again later.
5. Keep one copy away from the home machine (another disk or another place).
   A home machine has no provider-side backups.
6. The `learnharness-ts_ts-state` volume holds the machine key. You do not
   need to back it up: without it, generate a new auth key and do step E1–E2
   and G again.

### Update

```sh
cd ~/learnharness-server
git -C src pull
docker compose build app
docker compose up -d
```

To update the sidecar, change the pinned `tailscale/tailscale` tag and digest
in `compose.yml` and run `docker compose up -d tailscale`. Back up first (see
above).

### When the home machine is off

- Browsers show that they cannot reach `learnharness.tail1234.ts.net`. Nothing
  is lost: the data is on the machine's disk.
- The desktop app shows **LearnHarness cannot connect to your server** at
  start, with **Try Again**, **Server Settings…** and **Quit**. In **Server
  Settings…** you can select **This computer** to work in local mode.
- Local mode uses **this computer's own data folder**, not a copy of the
  server's data. Chats that you make in local mode stay on this computer.
  **Copy Local Data to Server…** later *replaces* the server's data (the server
  keeps a backup first), so do not work in both places and then copy. Use local
  mode for short gaps, or export from the server first and import locally.
- An answer that was running when the machine went off is lost. Start it again.

### Resources

- The running server uses about 140 MB of RAM when idle and about 200 MB
  after some use (measured on arm64), more while it generates answers or runs
  plugins. The sidecar needs much less. The compose file limits them to 1 GB
  and 256 MB.
- The image build needs a lot more: the Next build alone peaks at about 3 GB.
  Give Docker at least 4 GB of RAM (6 GB is better), or add swap.
- The image is about 700 MB. The build cache needs more; run
  `docker builder prune` after a build to free it.
- CPU use is low: the models run at your API providers, not on the machine.

## Alternative: install on a VPS

The same compose stack works on a VPS. Do the home steps with these changes:

1. **A and B** (tailnet, devices): the same.
2. **C:** install Docker Engine on the VPS as in C1. Stay awake and start on
   boot do not apply beyond `sudo systemctl enable docker`.
3. **D:** use any stack folder, for example `/opt/stacks/learnharness-ts`
   (`sudo mkdir -p …`, then the Linux commands).
4. **E–G:** the same. Build on the VPS itself (usually amd64; see F). On a VPS
   with 2 GB of RAM or less, add swap before the build.
5. **Firewall:** open nothing. The stack publishes no ports; the sidecar only
   connects out.
6. **Host Tailscale:** if the VPS host already runs Tailscale, it is not
   changed. The sidecar is a separate machine on the tailnet.
7. **Other stacks:** the container names (`learnharness-ts`,
   `learnharness-ts-app`) and volumes (`learnharness-ts_*`) do not collide
   with another LearnHarness stack on the same host.
8. **Backups:** as above, to storage outside the VPS.
9. **H–J:** the same.

Consider the trade-off: a VPS stays on and has a stable network, but your data
and API keys are on a provider's machine.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Browser: name not found | Tailscale is off on this device, or MagicDNS is off. Connect Tailscale; on Linux run `sudo tailscale set --accept-dns=true`. |
| Browser: cannot connect, but it worked before | The home machine is off, asleep, or Docker Desktop is not running (nobody signed in). See [Stay awake](#stay-awake) and [Start on boot](#start-on-boot). Check `docker exec learnharness-ts tailscale status` on the machine. |
| Browser: certificate error, or HTTPS does not answer | HTTPS certificates are not enabled (step A3), or the first certificate is still being issued. Check `docker exec learnharness-ts tailscale serve status` and the sidecar log. |
| Slow over mobile data | The connection may go through a Tailscale relay (strict NAT, Docker Desktop). `tailscale ping learnharness` on the device shows `via DERP` for a relay. It still works; only latency is higher. |
| HTTP 403 "Open this server over Tailscale…" | The request had no user identity: a tagged device, a request through Funnel, or a request that did not pass through Serve. Use a device that is logged in as your user. |
| HTTP 403 "The Tailscale user … may not use this server." | That login is not in `LH_TAILSCALE_ALLOWED_LOGINS`. Add it exactly as shown, then `docker compose up -d app`. |
| HTTP 403 "This host name is not allowed" or "Cross-site requests … are not allowed" (API) | `LH_PUBLIC_ORIGIN` does not match the URL that you opened (for example the machine name is `learnharness-1`). Fix `app.env`. |
| App container restarts; log says "Refusing to start" | A setting is missing or wrong, or `HOSTNAME` is not `127.0.0.1`. The log line names it. |
| Sidecar log asks for a login URL | No valid auth key and no saved state. Put a new key in `.env` (step E1) and run `docker compose up -d`. |
| Server is gone from the tailnet after months | Key expiry. Disable key expiry for the machine (step G6), then re-authenticate with a new auth key. |
| Desktop app: "Cannot reach the server … Is Tailscale connected" | Start Tailscale on that computer. Test with `curl https://learnharness.tail1234.ts.net/api/health`. |
| Build fails with out of memory, or "Killed" | Give Docker more memory (C3, C4) or add swap (C2). |
| Build fails on Windows with `\r` or "bad interpreter" errors | The checkout has Windows line endings. Clone again with `-c core.autocrlf=false` (step D). |
| `exec format error` when the app starts | The image was built on another architecture. Build on the machine that runs it (step F). |
| Import fails with `truncated` | The archive is larger than 26 MB. Use the server-side import in step H. |

To check the gate locally without a tailnet, build the image and run
`scripts/smoke-remote.mjs` in the server's network namespace (see the comment
at the top of that script).

## Limits

- One user, one server process. Do not run two server containers on one volume.
- If two devices change the same chat at the same moment, the last write wins.
  Only one answer can run per chat at a time (a second one gets HTTP 409).
- A server restart in the middle of an answer loses that partial answer: the
  answer is saved when it finishes.
- Uploads through the web UI are limited to 26 MB per request.
- Demo execution (headless Chrome) is not in the image.
