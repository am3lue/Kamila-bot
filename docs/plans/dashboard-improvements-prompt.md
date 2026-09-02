# PROMPT: Dashboard Improvements — Settings view, loopback auth, UX polish

You are working on the **Kamila Bot** project at:
`/home/blue/Projects/.MESYS/Kamila-Tsaap-Bot`

It is a local, single-PC Node app (`"type": "module"`, Node 26). The Express server is
`server.js`. The dashboard is a hash-router SPA in `public/dashboard.{html,css,js}` already
implemented with 4 views (overview/chats/tasks/settings), SSE real-time, and Chart.js.

Your job: implement THREE scoped workstreams. Read the current `server.js` and
`public/dashboard.js` in full before editing. Do NOT refactor beyond the asks. Add NO comments
unless the code is genuinely non-obvious. Do not run `npm install`. Do not commit.

---

## Workstream 1 — Loopback-only auth (security)

**Goal:** bind the Express server to loopback so the dashboard/API is NOT exposed on the LAN.

In `server.js`, change the `app.listen(...)` call so it binds to `127.0.0.1`:
- before: `const httpServer = app.listen(PORT, () => { ... })`
- after:  `const HOST = '127.0.0.1'; const httpServer = app.listen(PORT, HOST, () => { ... })`
- update the log line to show the host, e.g. `http://${HOST}:${PORT}`.

**Explicitly do NOT add:** shared-token auth, origin allowlist, helmet/CSP. Loopback-only, per
the user's decision. No client-side changes needed for this workstream.

**Verify:** `node --check server.js`; server serves on `localhost` and refuses LAN-IP connections.

---

## Workstream 2 — Fix the Settings view (real config)

**Problem:** `renderSettings()` in `public/dashboard.js` shows HARDCODED config
(`http://localhost:11434`, `'kamila'`, `'30000'`, `'2000'`) and wrongly calls `/api/stats` to
"load" them.

**Server (`server.js`):** add `GET /api/config` returning non-secret operational env:
```js
app.get('/api/config', (_req, res) => {
  res.json({
    ollamaUrl: OLLAMA_URL,
    modelName: MODEL_NAME,
    axiosTimeoutMs: AXIOS_TIMEOUT_MS,
    rateLimitCooldownMs: RATE_LIMIT_COOLDOWN_MS,
    port: PORT,
    dbPath: DB_PATH,
    headless: PUPPETEER_HEADLESS === 'true',
  });
});
```
NEVER expose secrets or tokens in this endpoint.

**Client (`public/dashboard.js`):** rewrite `renderSettings()` to:
- fetch both `/api/status` (WhatsApp connection) and `/api/config`.
- populate `#cfg-ollama`, `#cfg-model`, `#cfg-timeout`, `#cfg-ratelimit` from real config
  (render timeouts with an `ms` suffix).
- add two rows: **DB Path** (`config.dbPath`) and **Headless** (`config.headless ? 'true' : 'false'`).
- wrap in try/catch so a failed config fetch still shows the connection status (fail-degraded).
- set all values via `textContent` (or `esc()`) — stay XSS-safe.

---

## Workstream 3 — UX polish, including the typing indicator

### 3a. Typing indicator (server + client + css)
- **Server:** `broadcast('typing', { chatId, typing: true })` just BEFORE the Ollama/AI reply
  call for a chat; `broadcast('typing', { chatId, typing: false })` (or rely on the incoming
  `message` event) when the reply is produced or errors.
- **Client:** add `onSSE('typing', d => { if (currentView === 'chats' && selectedChat === d.chatId) toggleTyping(d.typing); })`.
  `toggleTyping(true)` appends an animated "Kamila is typing…" `msg-bubble msg-ai typing-bubble`
  to the thread; `toggleTyping(false)` removes it. Also dismiss it from the `message` handler.
- **CSS (`dashboard.css`):** add `.typing-bubble` styling with a pulsating three-dot animation.

### 3b. Diff-aware contact list (prevent flicker)
- In `loadContactList()` (`dashboard.js`), compute a signature (e.g. `JSON.stringify(contacts)`),
  skip re-render when unchanged, and preserve `el.scrollTop` across re-renders.

### 3c. Draft expiry display
- In `loadDraftArea()` (`dashboard.js`), show `· created ${timeAgo(d.created_at)}` in the draft
  card meta; add a `.draft-stale` class (dimmed) when older than 24h.
- Add `.draft-stale { ... }` to `dashboard.css`.

### 3d. Needs-help badge on contacts
- **Server:** add a `needsHelp` flag to the `/api/contacts` response by joining/looking up the
  `evaluations` table (`needs_human_help = 1`). Additive only.
- **Client:** render a small red flag/dot on contact items where `needsHelp`, with a
  `title="Needs human help"`.

### 3e. Loading skeletons
- Overview stat cards: replace bare `-` with skeleton shimmer until `/api/stats` resolves.
- Evaluations table: skeleton rows / spinner while fetching.
- Add `.skeleton` + shimmer keyframes to `dashboard.css`.

### 3f. Accessibility
- `dashboard.html`: add `aria-label` to the `<nav>`, `aria-hidden="true"` on icon SVGs, and
  `role="status" aria-live="polite"` on `#toast-container`.
- `dashboard.css`: add `:focus-visible` styles for `.nav-item`, `.btn`, `.input`, `.contact-item`.

---

## Rules & verification
- Read the current `server.js` and `public/dashboard.js` in full first; changes may already
  diverge from the above — adapt.
- `node --check server.js` and `node --check public/dashboard.js` must pass.
- Follow existing code style (no comments unless needed, keep the IIFE/`esc()` pattern).
- Do not touch `bot.js`, do not add dependencies, do not add a `.gitignore`, do not run tests
  that don't exist — scope is exactly the three workstreams above.
- Report what you changed per workstream and the verification results.
