# Kamila WhatsApp Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![WhatsApp Web.js](https://img.shields.io/badge/WhatsApp%20Web.js-1.34.7-blue.svg)](https://github.com/pedroslopez/whatsapp-web.js)
[![Ollama](https://img.shields.io/badge/Ollama-supported-orange.svg)](https://ollama.ai/)

WhatsApp bot powered by Ollama AI with a web dashboard, broadcast messaging, and contact management.

> Self-hosted. No cloud services. Your data stays on your machine.

![Dashboard](https://via.placeholder.com/800x400?text=Dashboard+Screenshot)

## Features

- **AI Auto-Reply** — Responds to WhatsApp messages using any Ollama model
- **Three Modes** — `AUTO` (AI replies), `DRAFT` (AI drafts for your review), `OFF` (silent)
- **Web Dashboard** — Stats, chat viewer, task tracker, broadcast sender, settings
- **Broadcast Messaging** — Send to multiple contacts with configurable delay
- **AI Message Enhancement** — Professional, casual, friendly, formal, polish modes
- **Contact Import** — vCard (.vcf), CSV, or plain text with deduplication
- **WhatsApp Sync** — Verify which imported contacts are on WhatsApp
- **Group Read-Only** — Logs group messages for context without replying
- **Auto-Reconnect** — Recovers from disconnections automatically
- **Human Typing** — Response delay scales with message length
- **Real-time Dashboard** — SSE updates with polling fallback

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **Chromium** — Required by whatsapp-web.js for WhatsApp Web
- **Ollama** — Running locally with at least one model pulled

### Install

```bash
# Clone the repo
git clone https://github.com/your-username/Kamila-Tsaap-Bot.git
cd Kamila-Tsaap-Bot

# Install dependencies
npm install

# Copy config
cp .env.example .env
```

### Run

```bash
# Terminal 1: Start Ollama
ollama serve
ollama pull qwen2.5-coder:0.5b   # or any model you prefer

# Terminal 2: Start the bot
npm start
```

Open `http://localhost:3000` and scan the QR code with WhatsApp (Settings > Linked Devices > Link a Device).

## Configuration

All config is in `.env`. Copy from `.env.example` and edit:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Dashboard server port |
| `API_KEY` | *(empty)* | API key for dashboard auth (blank = dev mode, no auth) |
| `OLLAMA_URL` | `http://localhost:11434/api/chat` | Ollama API endpoint |
| `MODEL_NAME` | `kamila` | Ollama model to use |
| `AXIOS_TIMEOUT_MS` | `30000` | Ollama request timeout (ms) |
| `RATE_LIMIT_COOLDOWN_MS` | `2000` | Min delay between replies per user (ms) |
| `PUPPETEER_HEADLESS` | `true` | Run Chromium headless (`false` for debugging) |
| `PUPPETEER_ARGS` | `--no-sandbox,--disable-setuid-sandbox` | Chromium flags |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | Path to Chromium binary |
| `DB_PATH` | `./kamila.db` | SQLite database file path |

## Dashboard

| View | Description |
|------|-------------|
| **Overview** | Stats, volume chart, sentiment analysis, task completion |
| **Chats** | View conversations, switch modes, send messages, save drafts |
| **Tasks** | AI-extracted action items from conversations |
| **Broadcast** | Send messages to multiple contacts with AI enhancement |
| **Settings** | Import contacts, sync with WhatsApp |

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Bot connection status |
| `GET` | `/api/stats` | Dashboard statistics |
| `GET` | `/api/contacts` | List all contacts |
| `GET` | `/api/contacts/:id/messages` | Messages for a contact |
| `GET` | `/api/messages` | All messages |
| `GET` | `/api/tasks` | All tasks |
| `GET` | `/api/events` | SSE stream for real-time updates |
| `POST` | `/api/send` | Send message `{chatId, text}` |
| `POST` | `/api/send-draft` | Send a saved draft |
| `POST` | `/api/discard-draft` | Delete a draft |
| `POST` | `/api/contacts/import` | Import contacts `{vcard}` or `{contacts}` |
| `POST` | `/api/contacts/sync` | Check contacts against WhatsApp |
| `POST` | `/api/broadcast` | Broadcast `{contacts, text, delayMs}` |
| `POST` | `/api/enhance` | AI enhance text `{text, mode}` |
| `POST` | `/api/tasks/:id/complete` | Mark task done |

## Project Structure

```
├── server.js              # Main server — bot logic, API, SSE, SQLite
├── public/
│   ├── dashboard.html     # SPA shell
│   ├── dashboard.js       # Router, views, SSE client
│   ├── dashboard.css      # Dark theme styles
│   └── favicon.svg        # Bot icon
├── .env.example           # Config template
├── package.json
└── kamila.db              # SQLite database (auto-created, gitignored)
```

## Troubleshooting

**Bot won't connect / QR code not showing**
- Ensure Chromium is installed: `which chromium`
- Check `CHROMIUM_PATH` in `.env`
- Try `PUPPETEER_HEADLESS=false` to debug

**Ollama errors**
- Ensure Ollama is running: `ollama serve`
- Check model exists: `ollama list`
- Increase timeout: `AXIOS_TIMEOUT_MS=60000`

**Dashboard blank**
- Check console for errors (F12)
- Ensure port 3000 is free

**Contact import not working**
- vCard files must start with `BEGIN:VCARD`
- Phone numbers need 7+ digits

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

Report vulnerabilities via [SECURITY.md](SECURITY.md). Do not open public issues for security bugs.

## License

[MIT](LICENSE)
