# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Messages API** (`POST /v1/messages`): send any text to a WhatsApp number from any project with its secret key. Messages are logged in the conversation, so a chatbot project answers replies with context. New `message.sent` webhook event and a per-recipient limit (`SEND_PER_RECIPIENT_PER_MIN`, default 5)
- Dashboard docs: "Send messages" section with code samples and a Try it box
- **Sender branding:** set the linked number's WhatsApp display name and logo from the project's WhatsApp tab (`GET/POST /v1/sessions/:id/profile`), with a preview of how OTPs and messages look to recipients

### Changed
- **Dashboard UI:** today summary and per-type counts on the projects page, cards say what needs doing (e.g. "Scan the QR code to connect"), a "Get started" checklist on each project's Overview, a dot on the WhatsApp tab while disconnected, click-to-copy project ID, friendlier empty states, Playground suggestions, and an OTP message editor with insertable values, validation and a WhatsApp-style preview
- **Chat widget:** text colour adapts to the brand colour, multi-line input (Enter sends, Shift+Enter for a new line), clickable links in replies, a "new conversation" button, Escape to close, launcher turns into a close button, no overlap on phones, reduced-motion support
- **Login page:** describes OTP, messages and the AI chatbot; buttons show a spinner while redirecting

### Fixed
- OTP codes that failed to send no longer show in the dashboard: codes WhatsApp never accepted are marked failed instead of expired (so they aren't counted as sent), and failed codes are deleted 10 minutes after they fail

## [2.0.0] - 2026-11-10

### Added
- **Projects:** many WhatsApp numbers per server, each owned by one user and set to *OTP codes* or *AI chatbot*
- **OTP API** (`/v1/otp/send`, `/v1/otp/verify`): hashed single-use codes, expiry, lockout, resend cooldown, hourly cap, templates, delivery status
- **AI chatbot:** Gemini with instructions and knowledge base, optional answer URL, playground, conversation log, per-project model and encrypted key
- **Chat API** (`/v1/chat`) and **website widget** (`/widget.js`) with publishable keys and allowed origins
- Signed **webhooks** with retries, delivery logs and SSRF protection
- **Sign-in with Tausi Auth** (cookie-mode proxy); gateway data in **Supabase** (`supabase/migrations/`)
- **Dashboard redesign:** projects grid, per-project pages with stats and charts, API keys, webhooks, docs with code samples
- **Deployment:** Dockerfile, docker-compose, `/healthz`, stdout logging, graceful shutdown, `WHATSAPP_AUTH_DIR`

### Changed
- The Kamila bot uses Gemini instead of Ollama; its persona moved from `Modelfile` to `prompts/kamila.md`
- `server.js` split into `gateway/` and `bot/` modules
- The Kamila bot pages require an owner sign-in (or `API_KEY`)
- AI errors are no longer sent to the contact

### Removed
- Broadcast messaging and AI message "enhance"
- Ollama, the disabled whitelist/blacklist code, `REQUIRE_AUTH`, unused `/api` endpoints, `qrcode-terminal`
- Planning and review documents (`docs/`, `CHECKPOINT.md`)

### Fixed
- Dashboard writes were rejected on non-localhost domains by an old origin check
- DRAFT mode no longer sends a "Draft saved" preview to the contact
- Server crash when a bot reply failed

## [1.0.0] - 2026-09-03

### Added
- WhatsApp bot with Ollama AI auto-reply
- Three reply modes per contact: AUTO, DRAFT, OFF
- Web dashboard with 5 views: Overview, Chats, Tasks, Broadcast, Settings
- Real-time updates via SSE with polling fallback
- Broadcast messaging with configurable delay
- AI message enhancement (professional, casual, friendly, formal, polish modes)
- Contact import from vCard (.vcf), CSV, and plain text
- WhatsApp contact sync to verify imported contacts
- Group messages logged read-only (no AI reply)
- Auto-reconnect on disconnect
- Human-like typing delay based on response length
- SQLite database for contacts, messages, tasks, evaluations, drafts
- AI conversation evaluation and task extraction
- Dark theme dashboard UI
- Rate limiting per user
- Auto-save state in dashboard (localStorage)

### Changed
- Upgraded whatsapp-web.js to v1.34.7
- Improved vCard parser (handles HOME/WORK/CELL types, QUOTED-PRINTABLE, photos skipped)

### Fixed
- Ollama "unreachable" false positive (was puppeteer CDP error at msg.getChat())
- Typing indicator crash during WhatsApp loading
- Stale stats in dashboard (countAiMessages/countOpenTasks now functions)
- SQL injection risk in countTable (whitelist enforced)
- Rate limit memory leak (cleanup interval added)
- Dashboard null element crash during poll

## [0.1.0] - 2026-09-02

### Added
- Initial prototype with basic auto-reply
- SQLite storage
- Express server
