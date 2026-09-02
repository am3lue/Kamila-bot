# Kamila WhatsApp Bot

WhatsApp bot with Ollama AI, web dashboard, broadcast messaging, and contact management.

## Features

- **AI Auto-Reply** — Responds to messages via Ollama (configurable model)
- **Three modes per contact** — `AUTO` (AI replies), `DRAFT` (AI drafts for review), `OFF`
- **Web Dashboard** — Overview stats, chat viewer, task tracker, broadcast sender, settings
- **Broadcast Messaging** — Send to multiple contacts with delay and AI message enhancement
- **Contact Import** — vCard (.vcf), CSV, or plain text with deduplication
- **WhatsApp Sync** — Cross-references imported contacts with actual WhatsApp contacts
- **Group Read-Only** — Logs group messages without replying
- **Auto-Reconnect** — Reconnects on disconnect after 5s
- **SSE + Polling** — Real-time dashboard updates with fallback polling

## Requirements

- Node.js >= 18
- Chromium (for whatsapp-web.js puppeteer)
- Ollama running locally with a model pulled

## Setup

```bash
# Install dependencies
npm install

# Copy and edit config
cp .env.example .env

# Start Ollama (in separate terminal)
ollama serve
ollama pull qwen2.5-coder:0.5b  # or your preferred model

# Start the bot
npm start
```

Scan the QR code with WhatsApp (Settings > Linked Devices > Link a Device).

## Configuration (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Dashboard server port |
| `OLLAMA_URL` | http://localhost:11434/api/chat | Ollama API endpoint |
| `MODEL_NAME` | kamila | Ollama model name |
| `AXIOS_TIMEOUT_MS` | 30000 | Ollama request timeout (ms) |
| `RATE_LIMIT_COOLDOWN_MS` | 2000 | Min delay between replies per user (ms) |
| `PUPPETEER_HEADLESS` | true | Run Chromium headless |
| `PUPPETEER_ARGS` | --no-sandbox,--disable-setuid-sandbox | Chromium flags |
| `CHROMIUM_PATH` | /usr/bin/chromium | Chromium binary path |
| `DB_PATH` | ./kamila.db | SQLite database path |

## Dashboard

Open `http://localhost:3000` in your browser.

- **Overview** — Stats, volume chart, sentiment mix, task completion
- **Chats** — View conversations, switch modes, send messages, save drafts
- **Tasks** — AI-extracted tasks from conversations
- **Broadcast** — Send messages to multiple contacts with AI enhancement
- **Settings** — Import contacts, sync with WhatsApp

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Bot connection status |
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/contacts` | List all contacts |
| GET | `/api/contacts/:id/messages` | Messages for a contact |
| GET | `/api/messages` | All messages |
| GET | `/api/tasks` | All tasks |
| POST | `/api/send` | Send message `{chatId, text}` |
| POST | `/api/send-draft` | Send a saved draft |
| POST | `/api/discard-draft` | Delete a draft |
| POST | `/api/contacts/import` | Import contacts `{vcard}` or `{contacts}` |
| POST | `/api/contacts/sync` | Check contacts against WhatsApp |
| POST | `/api/broadcast` | Broadcast message `{contacts, text, delayMs}` |
| POST | `/api/enhance` | AI enhance text `{text, mode}` |
| POST | `/api/tasks/:id/complete` | Mark task done |
| GET | `/api/events` | SSE stream for real-time updates |

## Project Structure

```
├── server.js          # Main server — bot logic, API, SSE, SQLite
├── public/
│   ├── dashboard.html # SPA shell
│   ├── dashboard.js   # Router, views, SSE client
│   ├── dashboard.css  # Dark theme styles
│   └── favicon.svg    # Bot icon
├── bot.js             # Legacy (unused)
├── .env.example       # Config template
├── package.json
└── kamila.db          # SQLite database (auto-created)
```

## License

MIT
