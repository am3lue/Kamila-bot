# Plan: Picture & Quoted Messages Support

**Date:** 2026-09-04
**Scope:** `server.js`, `public/dashboard.js`, `public/dashboard.css`, DB schema
**Depends on:** nothing (works on current codebase)

---

## Goal

Make Kamila handle two message shapes it currently mishandles, end to end (WhatsApp → DB → dashboard → AI context):

1. **Picture / media messages** — images (and by extension video/doc/audio) sent by users.
2. **Special (quoted) messages** — messages that quote/reply to another message.

---

## Current Behaviour (the gaps)

| Input | What happens today | Where |
|---|---|---|
| Image **without** caption | **Silently dropped** — `msg.body` is empty → `if (!body) return` at handler top | `server.js:607-608` |
| Image **with** caption | Text = `msg.caption`, but code reads `msg.body` → returns early with empty body | `server.js:607` |
| Quoted message | Treated like a normal message — quote metadata is discarded | `server.js:607-616` |
| Dashboard thread | Text-only bubbles; nothing renders media or quote previews | `dashboard.js:392-402` |
| AI context | History only contains `text`; the AI never sees "user quoted: ..." | `server.js:672-678` |

---

## Research Findings (web, 2026-09)

- **Detecting media:** `msg.hasMedia` → `await msg.downloadMedia()` returns `MessageMedia { data (base64), mimetype, filename, filesize }`. `downloadMedia()` returns `undefined`/`null` when the media can't be resolved (deleted, expired).
- **Captions:** for image/video/document messages the text lives in **`msg.caption`**, *not* `msg.body`. Reading `body` alone misses the message.
- **Sending media:** `client.sendMessage(chatId, media, { caption })` or `msg.reply(media, chatId, { caption })`; construct with `new MessageMedia(mimetype, base64)` or `MessageMedia.fromFilePath()`.
- **Quoted messages:** `msg.hasQuotedMsg` → `await msg.getQuotedMessage()` returns a full `Message` (its `.body`, `.from`, `.timestamp` in `_data.quotedMsg`); `msg.reply(text)` sends a WhatsApp quote-reply.
- **⚠️ Known bug (July 2026):** `downloadMedia()` fails/hangs for chats using the new **`@lid`** identifier (GitHub issue `wwebjs/whatsapp-web.js#201844`). Media resolution returns `null` regardless of version. → **Must wrap every media/timeline call in try/catch and degrade gracefully (log + placeholder), never crash the handler.**
- **Message type constants** (`MessageTypes`): `IMAGE`, `VIDEO`, `DOCUMENT`, `AUDIO`, `STICKER`, `LOCATION`, `CONTACT_CARD`, etc. Filtering on these instead of `body` is the reliable signal.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Media storage | **Metadata in DB + optional on-disk file cache**; never base64 in the DB row | Base64 in SQLite bloats WAL / backups. Store `media_type`, `media_mimetype`, `media_size`, `media_filename`, `media_path`; regenerate/download on demand. |
| Dashboard display | Serve thumbnails via a new **`GET /api/contacts/:id/messages/:msgId/media`** authenticated endpoint; render as `<img>`/chip in bubbles | Keeps base64 out of the JSON list payload; dashboard stays light. |
| Media-only messages | Bot replies politely (once, rate-limited) — *not* silence, *not* vision | Current model is text-only (`Modelfile` has no vision); pretending to "see" images misleads users. Revisit if a vision model is swapped in. |
| Captioned images | Caption text is stored & fed to the AI; media itself is not described | Caption is real user content; photo pixels are not understood by the text model. |
| Quoted messages | Captured as `reply_to/quote` columns on the row **and** injected into AI history as `[User quoted: "…"]` context | Lets the AI answer *about* the quoted message instead of guessing. |
| Quoted media | Quote preview shows a thumbnail + name (not re-downloaded aggressively) | Avoids the `@lid` bug surface; reuses already-fetched thumbnails. |
| Failure model | Every media/quote fetch is `try/catch`, on failure stores `unavailable` placeholder | Research-backed: `downloadMedia()` returns `null` on `@lid` chats — must never throw out of the handler. |

---

## Implementation Steps

### Phase 1 — Schema (DB migration, `server.js` db.exec block)

Add columns to `messages` (idempotent `ALTER TABLE … ADD COLUMN` guarded by a PRAGMA table_info check):

```sql
media_type    TEXT   -- 'image' | 'video' | 'audio' | 'document' | 'sticker' | ...
media_mimetype TEXT  -- e.g. 'image/jpeg'
media_size    INTEGER
media_filename TEXT
media_path    TEXT   -- on-disk cache location, null when not stored
media_status  TEXT   -- 'ready' | 'unavailable' | 'pending'
quote_message_id TEXT -- referenced message serialized id (when hasQuotedMsg)
quote_text    TEXT   -- preview of the quoted message body
quote_sender  TEXT
quote_media   TEXT   -- 'image' | null (quoted message had media)
```

- Migration helper: read `PRAGMA table_info(messages)` once; add any missing columns.
- Existing rows keep `NULL`s — no backfill needed.
- `getContactMessages` / `getMessages` already `SELECT *` → new fields flow to API automatically.

### Phase 2 — Capture media + quotes (incoming, `server.js` message handler)

Replace the current `const body = sanitizeInput(msg.body); if (!body) return;` logic (lines 607-608) with a `normalizeIncomingMessage(msg)` helper returning `{ text, media, quote }`:

1. **Text**: use `msg.body || msg.caption || ''` (caption for media messages), sanitize as today.
2. **Media**: if `msg.hasMedia`, wrap `await msg.downloadMedia()` in try/catch:
   - success → keep `{ mimetype, filesize, filename }`, save data to `media/` cache dir, `media_status='ready'`.
   - failure/`null` → `media_status='unavailable'`, log warning. **Never crash.**
3. **Quote**: if `msg.hasQuotedMsg`, `await msg.getQuotedMessage()` in try/catch → capture `body` (first ~300 chars), `from`, `type`. On failure → `quote_text='<unavailable>'`.
4. **Empty text + no media** (e.g. sticker/location with no image payload) → still log the row with `media_type` so the dashboard shows something; only skip the AI reply. Do **not** early-return before logging.

**Media-only reply policy:** after storing, if `mode==='AUTO'` and text is empty and media exists → send a short canned `/mediahint` reply ("I can see you sent a photo — I'm text-only for now. Feel free to type your message!") subject to the existing rate limit, via `msg.reply`. This must be puny prompts in the persona's language tone (Swahili/English per `detectSwahili`).

### Phase 3 — AI context (quotes + captions)

In the history builder (`server.js:672-674`):

- For each history row, build content from:
  - `quote_text` present → prefix: `[You are replying to message: "..."]` — only when that row is the user's latest message.
  - `text` (caption or body).
- Media-only rows with no text → emit `[image]`/`[document]` placeholder token so the AI knows a media message happened without hallucinating its contents.
- Keep the cap of last 10 messages. No prompt for "describe the image" (model is text-only).

### Phase 4 — API + dashboard rendering

1. **New endpoint** `GET /api/contacts/:id/messages/:msgId/media` (behind existing `requireAuth`):
   - Reads `media_path`; if file exists → `res.sendFile` with stored mimetype.
   - If `media_status='unavailable'` → `404 { error: 'media unavailable' }`.
   - Never trusts client-supplied paths — lookup row, then resolve path under `media/` only.
2. **Dashboard bubble renderer** (`loadChatMessages`):
   - `media_type` present and no path yet → fetch thumbnail from the endpoint, render `<img>` capped at `320px`, or a document chip (`📄 name · size`) for non-image types.
   - `quote_text` present → render a small quoted preview block above the bubble: `↪ {sender}: "preview…"`.
   - `media_status='unavailable'` → muted "Media unavailable" chip.
   - Fall back to existing text rendering otherwise; escaping via existing `esc()`/`renderMd`.
3. **CSS:** styles for `.msg-media img`, `.msg-quote`, and the doc chip (dark-theme consistent with `dashboard.css`).

### Phase 5 — Manual composer (outgoing quote/media, optional stretch)

- Support `quote` on manual replies: `client.sendMessage(chatId, text, { quotedMessageId ... })`? — **Not available in wwebjs**: quoting requires `quotedMessage` id lookup. Validate feasibility before committing; if unsupported, keep outgoing replies as plain `msg.reply` (already quotes) and defer composer quoting.
- Media sending from the composer (attach image) = **deferred** to a follow-up plan; requires `MessageMedia` + file input + `POST /api/send` multipart. Out of scope here.

---

## Risks

| Risk | Mitigation |
|---|---|
| `downloadMedia()` returns null on `@lid` chats (research bug #201844) | try/catch everywhere; `media_status='unavailable'`; handler never throws; log once per chat via a warned-set to avoid log spam |
| Base64 media bloats response JSON | Media served via dedicated endpoint, not embedded in list payload |
| DB migration on existing `kamila.db` | Guarded `ADD COLUMN` (PRAGMA table_info check); zero-downtime, idempotent |
| Media folder fills disk | Cap (e.g. keep last N MB); delete-on-drop-contact hook (already have `dropContact`); document cleanup |
| Sticker/location without payload | Log row with type, no AI reply → consistent dashboard history |

---

## Verification

1. `node --check server.js` and `node --check public/dashboard.js`.
2. Start bot; send from WhatsApp:
   - image **with** caption → stored, caption shown in thread, AI sees caption, dashboard shows thumbnail.
   - image **without** caption → media chip + polite text-only hint (AUTO mode).
   - message **quoting** an earlier message → thread shows quoted preview; AI references the quoted message content.
   - document/sticker → chip, no AI crash.
3. Dashboard: select chat → thumbnail/doc chip renders; `unavailable` case shows placeholder after deleting cached file.
4. Regression: text-only chat still auto-replies under 10-word cap; DRAFT/OFF modes unaffected; groups stay read-only.

---

## Files Touched

| File | Change |
|---|---|
| `server.js` | Migration (new columns), `normalizeIncomingMessage`, media cache dir + send-file endpoint, AI history builder, media-only reply |
| `public/dashboard.js` | Bubble renderer (media/quote), thumbnail fetch |
| `public/dashboard.css` | `.msg-media`, `.msg-quote`, doc chip styles |
| `README.md` | New endpoint row + behavior notes |