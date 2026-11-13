# Kamila

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

Turn WhatsApp numbers into an API. Every **project** is one linked WhatsApp number that can **send messages** to anyone through the API, and also either:

- **sends OTP codes** for your app (send + verify API), or
- runs an **AI chatbot** (Gemini) that answers from your knowledge base, optionally asking your own API first. It answers on WhatsApp, on your website through a drop-in widget, and through a Chat API.

It also includes **Kamila**, a personal AI assistant on the owner's own number, with chats, tasks and drafts.

Sign-in is handled by [Tausi Auth](https://auth.tausi.app). Gateway data lives in [Supabase](https://supabase.com); the Kamila bot's data is a local SQLite file.

> Kamila drives WhatsApp Web (via [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)). This is unofficial, and WhatsApp can ban numbers that send spam or bulk messages. For high-volume OTP, the official WhatsApp Business Platform is the supported route.

## Features

| | |
|---|---|
| **Projects** | Many WhatsApp numbers per server, each owned by one user. QR linking in the dashboard, automatic reconnect |
| **Send messages** | `POST /v1/messages` sends any text from any project (notifications, order updates). On a chatbot project, the AI continues the conversation when the person replies |
| **Sender branding** | Set the number's WhatsApp name and logo from the dashboard so codes and messages show your business, not a bare number |
| **OTP** | Hashed single-use codes, expiry, attempt lockout, resend cooldown, per-number hourly cap, editable message template, delivery status (sent → delivered → read → verified) |
| **AI chatbot** | Gemini with instructions + knowledge base (file import), optional "answer URL" for live data, playground, conversation log, per-project model and API key |
| **Integrations** | Secret keys for servers, publishable keys + allowed origins for the website widget, signed webhooks with retries and delivery logs |
| **Dashboard** | Projects grid with activity sparklines, per-project overview (stats + 14/30-day chart), API keys, webhooks, settings, docs with code samples |
| **Kamila bot** (owners) | Personal assistant on the owner's number: AUTO / DRAFT / OFF per contact, memory, task extraction, human hand-off, contact import |

## Quick start

Requirements: **Node.js 20+**, **Chromium or Chrome**, a **Supabase** project, a **Tausi Auth** project, and a **Gemini API key**.

```bash
npm install
cp .env.example .env     # fill in the REQUIRED values
npm start                # http://localhost:3000
```

1. **Supabase:** run every file in `supabase/migrations/` in order (`supabase db push`, or paste them into the SQL editor). Put the project URL and **service-role** key in `.env`.
2. **Tausi:** create a project at [auth.tausi.app](https://auth.tausi.app). Add your origin (e.g. `http://localhost:3000`) under **Allowed origins** and `<origin>/login.html` under **Redirect URLs**. Put the `pk_…` and `sk_…` keys in `.env`.
3. **Owners:** set `OWNER_EMAILS` or `OWNER_PHONES` to your verified Tausi email/phone (or give your Tausi user the `admin` role).
4. **Gemini:** set `GEMINI_API_KEY`.
5. Open the dashboard, sign in, **Add new…** a project and scan its QR code (WhatsApp → Settings → Linked devices).

## API

Every project has keys on its **API keys** tab. The dashboard's **Docs** page has full examples in cURL, Node.js, Python and PHP.

| Key | Where | Used for |
|---|---|---|
| `wsk_…` secret | Your server only | Messages API, OTP API, Chat API |
| `wpk_…` publishable | Your website | Chat widget, only on allowed origins |

```bash
# Any project: send a WhatsApp message
curl -X POST https://YOUR-HOST/v1/messages -H "Authorization: Bearer $KAMILA_SECRET_KEY" -H "Content-Type: application/json" -d '{"phone":"255712345678","text":"Your order has shipped"}'

# OTP project
curl -X POST https://YOUR-HOST/v1/otp/send   -H "Authorization: Bearer $KAMILA_SECRET_KEY" -H "Content-Type: application/json" -d '{"phone":"255712345678"}'
curl -X POST https://YOUR-HOST/v1/otp/verify -H "Authorization: Bearer $KAMILA_SECRET_KEY" -H "Content-Type: application/json" -d '{"id":"otp_…","code":"482913"}'

# Chatbot project ("user" keeps a separate conversation per end user)
curl -X POST https://YOUR-HOST/v1/chat -H "Authorization: Bearer $KAMILA_SECRET_KEY" -H "Content-Type: application/json" -d '{"message":"Are you open on Sunday?","user":"customer-42"}'
```

```html
<!-- Chat widget for your website (chatbot project) -->
<script src="https://YOUR-HOST/widget.js" data-key="wpk_…" defer></script>
```

| Endpoint | Auth | Description |
|---|---|---|
| `POST /v1/messages` | secret | `{ phone, text }` → `{ id, phone, status }` (any project) |
| `POST /v1/otp/send` | secret | `{ phone, length?, ttl_seconds?, code? }` |
| `POST /v1/otp/verify` | secret | `{ id \| phone, code }` → `{ valid, reason? }` |
| `GET /v1/otp/:id`, `GET /v1/otp` | secret | Code status / recent codes |
| `POST /v1/chat` | secret | `{ message, user? }` → `{ reply, source }` |
| `GET /v1/contacts/:phone/check` | secret | Is the number on WhatsApp? |
| `GET /v1/me` | secret | The project the key belongs to |
| `GET /v1/widget/config`, `POST /v1/widget/chat` | publishable | Used by `widget.js` |
| `/v1/sessions/…`, `/v1/account`, `/v1/stats/…` | dashboard sign-in | Project management (used by the dashboard) |

**Chatbot answers:** each incoming message (WhatsApp, widget or Chat API) is first POSTed to the project's **answer URL**, if set. A `{"reply": "…"}` response is sent as-is. `{"reply": null}`, or no answer URL, lets Gemini answer from the instructions and knowledge base. If the AI fails, the customer gets nothing and the error shows in the dashboard.

**Webhooks:** `otp.sent`, `otp.status`, `otp.verified`, `message.received`, `message.replied`, `message.sent`, `session.status`. Each is signed: `X-Webhook-Signature: sha256=HMAC(secret, "<X-Webhook-Timestamp>.<body>")`. Failed deliveries are retried after 5 s and 30 s.

## Deploy

Kamila is a long-running Node process with headless Chromium (one per WhatsApp number, ~200 MB RAM each). It needs a **persistent disk** for the WhatsApp logins (`WHATSAPP_AUTH_DIR`) and the Kamila bot's SQLite file (`DB_PATH`). Serverless platforms won't work; a VPS or container host will.

```bash
cp .env.example .env    # fill it in
docker compose up -d --build
docker compose logs -f
```

The compose file publishes the app on `127.0.0.1:3000` and keeps `/data` in a volume. Put it behind a reverse proxy with HTTPS (Caddy, nginx, Cloudflare Tunnel) and set `TRUST_PROXY=1`. Example Caddyfile:

```
kamila.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Then add `https://kamila.example.com` and `https://kamila.example.com/login.html` to your Tausi project.

- **Health check:** `GET /healthz` returns `{ status, version, uptime }`.
- **Logs:** go to stdout (`LOG_LEVEL`, optional `LOG_FILE`).
- **Shutdown:** `SIGTERM` closes connections and the WhatsApp browsers cleanly.
- **Scaling:** run a **single instance**. Each WhatsApp number is held by one process, and rate limits are kept in memory.

Without Docker: install Chromium, set `CHROMIUM_PATH`, and run `npm ci --omit=dev && NODE_ENV=production node server.js` under systemd or pm2.

## Configuration

All settings are documented in [`.env.example`](.env.example). Required: `TAUSI_PUBLISHABLE_KEY`, `TAUSI_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Strongly recommended: `GEMINI_API_KEY`, `OWNER_EMAILS`/`OWNER_PHONES`, `ENCRYPTION_KEY`, `OTP_PEPPER`.

## Project structure

```
server.js              Config, wiring, HTTP server, auth proxy, live updates
gateway/               WhatsApp projects (Supabase)
  routes.js            /v1 API: projects, OTP, chat, widget, stats
  sessions.js          One whatsapp-web.js client per project
  chatbot.js           Answer URL → Gemini + knowledge base
  gemini.js            Gemini REST client
  webhooks.js          Signed webhooks + SSRF guard
  auth.js              Tausi session checks, owners, SSE tickets
  db.js, secrets.js, util.js
bot/                   The owner's Kamila bot (SQLite)
  kamila.js            Replies, memory, tasks, hand-off
  routes.js            /api for the Kamila pages of the dashboard
  store.js, memory.js, format.js, vcard.js
prompts/kamila.md      Kamila's persona (Gemini system prompt)
public/                Dashboard, sign-in page, widget.js
supabase/migrations/   Database schema
```

## Troubleshooting

- **No QR code:** check `CHROMIUM_PATH` and the logs. On a headless server use `PUPPETEER_HEADLESS=true` and make sure Chromium's dependencies are installed (the Docker image has them).
- **Sign-in fails:** your origin and `<origin>/login.html` must be in the Tausi project, and `TRUST_PROXY=1` must be set behind a proxy.
- **Bot doesn't reply:** open the project → **Playground**; the error is shown there (missing or bad Gemini key, unknown model, quota). The project must be in AI chatbot mode with instructions, a knowledge base or an answer URL.
- **"Database schema is out of date" on start:** run the newest files in `supabase/migrations/`.

## License

MIT, see [LICENSE](LICENSE).
