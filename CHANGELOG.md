# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
