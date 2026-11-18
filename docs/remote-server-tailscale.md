# Remote server mode over Tailscale (fork)

This fork can run the LearnHarness server on your own VPS and make it
reachable **only on your tailnet**. One server then owns all chats, the
knowledge graph and settings. You use it from:

- a browser on any of your devices (phone, tablet, laptop) that runs Tailscale;
- the desktop app, in **server mode**. No password or token is needed.

The desktop app can still run fully local. You choose in
**LearnHarness → LearnHarness Server…**.

## Design

```
 your devices (Tailscale app, logged in as you)
 phone browser ─┐
 tablet app ────┼── WireGuard (tailnet) ──┐
 laptop ────────┘                         │
                    ┌──────────────── VPS (Docker) ─────────────────┐
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
  `http://127.0.0.1:3000`. Funnel (public internet) is off.
- **Shared network namespace.** The app container uses
  `network_mode: service:tailscale`, so it has no network interface of its own.
  The server listens on `127.0.0.1` (`HOSTNAME=127.0.0.1`). Only the sidecar
  can reach it. No host port is published, so no other container on the VPS
  and no process on the host can connect to it.
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
| `tailscale serve` on the VPS host | Not used. The host's own Tailscale node would change, and the app would need a host port (`127.0.0.1:3000`). Every process on the host and every container that can reach that port could then send a forged `Tailscale-User-Login` header. |
| `tsnet` (Tailscale inside the server process) | Not used. It is a Go library. The server is Node.js, so it would need a Go proxy that we build and maintain. |
| **Sidecar container + `tailscale serve`** | **Used.** Official image, no code to maintain, its own machine name and certificate, no host changes, and the shared loopback means nothing else can reach the server. It runs in userspace mode: no `/dev/net/tun` and no `NET_ADMIN`. |

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
placeholders only.

## Install, step by step

The examples use `/opt/stacks/learnharness-ts` on the VPS. Replace
`tail1234.ts.net` with your tailnet DNS name and `you@example.com` with your
Tailscale login everywhere.

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
2. **Tablet (aarch64 Linux):** install Tailscale from your distribution's
   packages or with the official instructions at
   <https://tailscale.com/download/linux> (they support arm64). Then:
   ```sh
   sudo systemctl enable --now tailscaled
   sudo tailscale up
   ```
   Open the login URL that it prints and log in with the same account.
3. Make sure the tablet uses MagicDNS:
   ```sh
   tailscale status
   getent hosts learnharness.tail1234.ts.net   # works after step D
   ```
   If names do not resolve, run `sudo tailscale set --accept-dns=true`.
4. **VPS:** the host's own Tailscale node is not needed and not
   changed. The sidecar is a separate machine on the tailnet.

### C. Prepare the stack on the VPS

1. Install Docker Engine with the compose plugin, if it is not installed.
2. Make the stack folder and get the source (the branch of this fork):
   ```sh
   sudo mkdir -p /opt/stacks/learnharness-ts && cd /opt/stacks/learnharness-ts
   sudo git clone --branch remote-tailscale https://github.com/nadelacruz-00/learnharness.git src
   ```
3. Copy the templates:
   ```sh
   sudo cp src/deploy/compose.example.yml compose.yml
   sudo mkdir -p tailscale && sudo cp src/deploy/tailscale/serve.json tailscale/serve.json
   sudo cp src/deploy/compose.env.example .env
   sudo cp src/deploy/app.env.example app.env
   sudo chmod 600 .env app.env
   ```
4. Create an auth key: <https://login.tailscale.com/admin/settings/keys> →
   **Generate auth key**. Not reusable, not ephemeral. Pre-approved, if your
   tailnet uses device approval. Copy the key (it starts with `tskey-auth-`).
5. Edit `.env`: set `TS_AUTHKEY` to that key. Keep `TS_HOSTNAME=learnharness`
   or choose another name.
6. Edit `app.env`:
   ```sh
   LH_SERVER_MODE=remote
   LH_TAILSCALE_ALLOWED_LOGINS=you@example.com
   LH_PUBLIC_ORIGIN=https://learnharness.tail1234.ts.net
   ```
   `LH_PUBLIC_ORIGIN` must use the same machine name as `TS_HOSTNAME`.

### D. Build the image on the amd64 VPS

Build on the VPS itself. Native modules (`@napi-rs/canvas`,
`@resvg/resvg-js`, photon) are built for the build machine's architecture. An
image built on the aarch64 tablet does not run on an amd64 VPS.

1. Build:
   ```sh
   cd /opt/stacks/learnharness-ts
   sudo docker compose build app
   ```
   This takes several minutes and needs about 4 GB of RAM. If the VPS has less,
   add swap first.
2. If the Next build stops once with a security-upgrade notice from Next, run
   the same command again. Do not run the upgrade that it suggests.

### E. First start and health check

1. Start the stack:
   ```sh
   sudo docker compose up -d
   sudo docker compose logs -f tailscale
   ```
   Wait until the log shows that the machine is logged in and the serve
   config is applied. Press Ctrl+C to stop following the log.
2. Check the sidecar:
   ```sh
   sudo docker exec learnharness-ts tailscale status
   sudo docker exec learnharness-ts tailscale serve status
   ```
   `serve status` must show `https://learnharness.tail1234.ts.net` →
   `proxy http://127.0.0.1:3000` and no Funnel. If the machine name has a
   suffix (for example `learnharness-1`, because the name was taken), change
   `LH_PUBLIC_ORIGIN` in `app.env` to match and run
   `sudo docker compose up -d app`.
3. Check the app on the VPS:
   ```sh
   sudo docker compose ps          # app: "healthy" after about 30 s
   sudo docker compose logs app | grep remote-access
   ```
   The log must show `Remote server mode (Tailscale): https://learnharness…`.
4. On the **tablet** (on the tailnet), check health and identity:
   ```sh
   curl https://learnharness.tail1234.ts.net/api/health
   # {"ok":true}
   curl https://learnharness.tail1234.ts.net/api/whoami
   # {"ok":true,"remote":true,"login":"you@example.com"}
   ```
   The first HTTPS request can take a few seconds while the certificate is
   issued.
5. On a machine that is **not** on the tailnet, the name must not resolve or
   connect. That is correct.
6. In the Tailscale admin console, open **Machines** → `learnharness` → **…** →
   **Disable key expiry**. Otherwise the server drops off the tailnet when its
   key expires.
7. Remove the auth key from `.env` (delete the `TS_AUTHKEY=` line, or leave it
   empty). The machine key is now in the `ts-state` volume. Revoke the auth key
   in the admin console if it is still listed.
8. Open `https://learnharness.tail1234.ts.net` in a browser on the phone. Add
   your API keys in **Settings → Providers**. They are stored on the server in
   `/data/auth.json`.

### F. Move your local data to the server

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
server refuses them (`{"error":"truncated"}`). Copy the archive to the VPS and
import it there with the app stopped:

```sh
cd /opt/stacks/learnharness-ts
# The archive is mode 600; the import runs as the image's user (uid 10001).
sudo chown 10001:10001 learnharness-data.tar.gz
sudo docker compose stop app
sudo docker run --rm --user 10001:10001 \
  -v learnharness-ts_data:/data -v "$PWD/src":/src:ro -v "$PWD":/in:ro \
  node:26-bookworm-slim node /src/scripts/data-archive.mjs import /in/learnharness-data.tar.gz /data/data
sudo docker compose start app
```

### G. Desktop app (tablet or laptop)

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

### H. Phone

1. Connect the Tailscale app.
2. Open `https://learnharness.tail1234.ts.net` in the browser.
3. Optional: **Add to Home Screen**.

## Backups

1. Server data is in the `learnharness-ts_data` volume. Back it up, for
   example nightly from cron on the VPS:
   ```sh
   sudo docker run --rm -v learnharness-ts_data:/data:ro -v /var/backups:/out \
     node:26-bookworm-slim tar czf /out/learnharness-$(date +%F).tar.gz -C /data .
   ```
   This includes `auth.json` (your API keys). Keep the backup private.
2. A portable copy without secrets, from any device on the tailnet:
   ```sh
   curl -o learnharness-export.tar.gz https://learnharness.tail1234.ts.net/api/data/export
   ```
   It returns HTTP 409 while an answer is running. Try again later.
3. The `learnharness-ts_ts-state` volume holds the machine key. You do not need
   to back it up: without it, generate a new auth key and start again (step C4).

## Update

```sh
cd /opt/stacks/learnharness-ts
sudo git -C src pull
sudo docker compose build app
sudo docker compose up -d
```

To update the sidecar, change the pinned `tailscale/tailscale` tag and digest
in `compose.yml` and run `sudo docker compose up -d tailscale`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Browser: name not found | Tailscale is off on this device, or MagicDNS is off. Connect Tailscale; on Linux run `sudo tailscale set --accept-dns=true`. |
| Browser: certificate error, or HTTPS does not answer | HTTPS certificates are not enabled (step A3), or the first certificate is still being issued. Check `docker exec learnharness-ts tailscale serve status` and the sidecar log. |
| HTTP 403 "Open this server over Tailscale…" | The request had no user identity: a tagged device, a request through Funnel, or a request that did not pass through Serve. Use a device that is logged in as your user. |
| HTTP 403 "The Tailscale user … may not use this server." | That login is not in `LH_TAILSCALE_ALLOWED_LOGINS`. Add it exactly as shown, then `sudo docker compose up -d app`. |
| HTTP 403 "This host name is not allowed" or "Cross-site requests … are not allowed" (API) | `LH_PUBLIC_ORIGIN` does not match the URL that you opened (for example the machine name is `learnharness-1`). Fix `app.env`. |
| App container restarts; log says "Refusing to start" | A setting is missing or wrong, or `HOSTNAME` is not `127.0.0.1`. The log line names it. |
| Sidecar log asks for a login URL | No valid auth key and no saved state. Put a new key in `.env` (step C4) and `sudo docker compose up -d`. |
| Server is gone from the tailnet after months | Key expiry. Disable key expiry for the machine (step E6), then re-authenticate with a new auth key. |
| Desktop app: "Cannot reach the server … Is Tailscale connected" | Start Tailscale on that computer. Test with `curl https://learnharness.tail1234.ts.net/api/health`. |
| Import fails with `truncated` | The archive is larger than 26 MB. Use the server-side import in step F. |
| `docker compose build` fails with out of memory | Add swap on the VPS, or build with fewer other services running. |

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
