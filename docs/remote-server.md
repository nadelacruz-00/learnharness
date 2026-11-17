# Remote server mode (fork)

This fork can run the LearnHarness server on your own machine (for example a
VPS) behind a **Cloudflare Tunnel** and **Cloudflare Access**. One server then
owns all chats, the knowledge graph and settings. You use it from:

- any browser (phone, tablet, laptop), after the Cloudflare Access login;
- the desktop app, in **server mode**, with a Cloudflare Access service token.

The desktop app can still run fully local. You choose in
**LearnHarness → LearnHarness Server…**.

## How it works

```
phone browser ──┐                    ┌─────────────── VPS ────────────────┐
                ├─► Cloudflare Access ─► Tunnel ─► learnharness-app:3000 │
desktop app ────┘   (login or token)               (Docker, /data volume) │
                                       └────────────────────────────────────┘
```

- Cloudflare Access signs each request it lets through with a JWT in the
  `Cf-Access-Jwt-Assertion` header. The server verifies that JWT on **every**
  page and API request (`src/server/remote-access.ts`, `proxy.ts`). Only
  `GET /api/health` is open; it returns no data.
- The server checks the JWT itself because other containers on the tunnel's
  Docker network can reach it without passing through Access.
- Answers are generated on the server, not in your browser tab. If a device
  disconnects or the phone sleeps, open the chat again: the running answer
  replays and continues (`GET /api/chats/<id>/stream`). Turn streams send a
  heartbeat every 20 s so Cloudflare does not close an idle connection.

## Server settings

| Variable | Value |
|---|---|
| `LH_SERVER_MODE` | `remote` (set in the image) |
| `LH_CF_ACCESS_TEAM_DOMAIN` | your Access team domain, e.g. `myteam.cloudflareaccess.com` |
| `LH_CF_ACCESS_AUD` | the Access application's AUD tag |
| `LH_PUBLIC_ORIGIN` | the public origin, e.g. `https://learn.example.com` |
| `LH_DATA_DIR` | `/data/data` (set in the image) |
| `LH_AUTH_FILE` | `/data/auth.json` (set in the image): your API keys |
| `LH_CF_ACCESS_CERTS_URL` | smoke tests only: override the JWKS URL |

The server refuses to start in remote mode when one of the first four values
is missing or malformed.

## Build and run

Build on the machine's own architecture (native modules are per platform):

```sh
docker build -t learnharness:0.6.1-remote.1 .
```

Use `deploy/compose.example.yml` as the compose file. It publishes no host
port; the tunnel reaches `http://learnharness-app:3000` on the external `edge`
network. Set `mem_limit` (1 GB is enough for one user).

## Cloudflare setup

1. **Access application** (create it before the route goes live):
   self-hosted, domain `learn.example.com`, with two policies:
   - *Owner only*: `allow`, include your email;
   - *Desktop app (service token)*: `non_identity` (Service Auth), include the
     service token.
2. **Service token** for the desktop app (Access → Service credentials).
   Cloudflare shows the client secret only once.
3. **Tunnel public hostname**: `learn.example.com` → `http://learnharness-app:3000`.
   Do not set `httpHostHeader`: the server checks the Host header.

## Desktop app

**LearnHarness → LearnHarness Server…** opens the chooser:

- *This computer*: the app runs its own local server (the default).
- *LearnHarness server*: enter the server address, the client ID and the
  client secret. **Test connection** checks the server and the token. **Save
  and restart** switches modes.

The secret is stored encrypted with the system keyring (Electron
`safeStorage`). The app refuses to store it when no keyring is available. The
token is sent only to the server's exact origin.

If a token file exists at `~/.config/learnharness-remote/service-token.json`
(`{url, clientId, clientSecret}`), the app imports it once at start, stores it
encrypted, and deletes the plaintext file. The mode does not change.

In server mode, attaching local file paths is off (the server cannot read your
computer's files). ChatGPT subscription login does not work in server mode;
use API keys (or the device-code subscription logins).

## Move your local data to the server

**LearnHarness → Copy Local Data to Server…** sends this computer's data
folder (chats, knowledge graph, settings, plugin data) to the server. If the
server already has chats, the app asks first; the server then saves a backup
in `/data/backups/<time>/` before it replaces its data. API keys and logins are
never copied: add your API keys on the server in Settings, or copy `auth.json`
once (`chmod 600`).

Without the desktop app:

```sh
node scripts/data-archive.mjs export ~/.config/LearnHarness/data learnharness-data.tar.gz
curl -X POST --data-binary @learnharness-data.tar.gz -H 'Content-Type: application/gzip' \
  -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
  https://learn.example.com/api/data/import
```

## Backups

Back up the Docker volume (`/data`), for example nightly with
`docker run --rm -v learnharness_data:/data -v "$PWD":/out alpine tar czf /out/learnharness-$(date +%F).tar.gz -C /data .`

## Limits

- One user, one server process. Do not run two server containers on one volume.
- If two devices change the same chat at the same moment, the last write wins.
  Only one answer can run per chat at a time (a second one gets HTTP 409).
- A server restart in the middle of an answer loses that partial answer: the
  answer is saved when it finishes.
- Demo execution (headless Chrome) is not in the image.
