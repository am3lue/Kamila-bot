# Plan: Dashboard Improvements — Settings view, Loopback auth, UX polish

- **Plan name:** `dashboard-improvements`
- **Created:** 2026-09-03T00:14:17+03:00 (ID suffix: `2026-09-03T00-14-17`)
- **Status:** Documented / ready to execute on approval
- **Mode:** Build (after approval)
- **Related plans:**
  - `dashboard-ui-ux+2026-09-02T23-45-39.md` (original SPA redesign — now implemented)
  - `security-and-refactor+2026-09-02T23-45-39.md` (security + refactor track)
  - `decision-log+2026-09-02T23-45-39.md` (running conversation log of decisions)
- **Type:** Amendment/roll-forward plan on top of the already-implemented SPA.

---

## 0. TL;DR

The original `dashboard-ui-ux` plan (§1–§9) has been **implemented**: the dashboard is now a
4-view hash-router SPA in `public/{dashboard.html,dashboard.css,dashboard.js}` with SSE,
Chart.js (CDN), `esc()`-safe rendering, a persisted `drafts` table, draft Approve & Send /
Discard, manual reply, and live connection status.

This plan documents **three follow-up workstreams** that close remaining gaps:

1. **Loopback-only auth** — bind Express to `127.0.0.1` (user-confirmed simplest option).
2. **Fix the Settings view** — it currently shows hardcoded/placeholder config instead of real values.
3. **UX polish** — typing indicator (user-confirmed), diff-aware contact list, draft expiry,
   needs-help badges, loading skeletons, accessibility.

This document is written in **deep** detail so it can be executed cold by a fresh agent.

---

## 1. Context & current-state audit (as of this write-up)

### 1.1 What already exists (implemented SPA)

| Asset | Purpose | Location |
|---|---|---|
| `dashboard.html` | App shell: sidebar (logo + conn badge + 4 nav) + `<main>` view mount + toast container | `public/dashboard.html` |
| `dashboard.css` | Full dark-theme stylesheet (CSS custom properties, no Tailwind) | `public/dashboard.css` |
| `dashboard.js` | IIFE: helpers, `esc()`, fetch client, SSE client, hash router, 4 view renderers | `public/dashboard.js` |
| SSE bus | `EventEmitter` + `sseClients` set + `broadcast(event, data)` | `server.js` §"SSE Infrastructure" |
| DB `drafts` table | Persists drafts across restarts (resolves original §9.2) | `server.js` schema |

### 1.2 Views and their state

| View | Route | Status | Notes |
|---|---|---|---|
| Overview | `#/overview` | Implemented | 4 stat cards + 4 Chart.js charts + recent-evaluations table |
| Chats | `#/chats` | Implemented | 2-pane: searchable contact list + thread bubbles + AUTO/DRAFT/OFF segmented control + manual reply + draft card (Approve/Discard via `window._approveDraft/_discardDraft`) |
| Tasks | `#/tasks` | Implemented | Filter (Pending/Done/All) + search, grouped by HIGH/MEDIUM/LOW with counts, checkbox → `POST /api/complete-task` |
| Settings | `#/settings` | **⚠️ Weakest** | WhatsApp status real, but config values are **hardcoded placeholders** (`http://localhost:11434`, `'kamila'`, `'30000'`, `'2000'`) and it calls the unrelated `/api/stats` to "load" them |

### 1.3 Real-time (SSE)

- One `EventSource('/api/events')`; named events: `message`, `draft`, `task`, `eval`, `contact`, `status`.
- View-scoped handlers re-fetch only the affected slice.
- Redundant `setInterval` polling remains: 5s chats (`server.js`-side timer exists in client), 15s status, 30s badge. **(Not in scope — user did not select polling cleanup.)**

### 1.4 Auth/security status (confirmed in code)

| Concern | Status in code |
|---|---|
| Bind address | ❌ `app.listen(PORT, () => …)` at `server.js:128` → binds **all interfaces (0.0.0.0)** |
| Origin/referer allowlist | ❌ absent |
| Shared-token auth | ❌ absent (`DASHBOARD_API_KEY` not destructured) |
| Security headers / helmet | ❌ absent |
| XSS escaping | ✅ `esc()` used on all user/AI/DB text in the SPA |
| `countTable` template-string SQL | ⚠️ `server.js` uses a template literal into SQL but only called with hardcoded table names—low risk |
| JSON body limit | ✅ default 100kb (fine) |

→ This matches code-review `CRITICAL #2` (API unauthorized) and the `0.0.0.0` HIGH finding,
still open in the current code.

---

## 2. Decisions locked in this session (user-confirmed)

| Question | Decision | Rationale / impact |
|---|---|---|
| Auth strength | **Loopback-only bind** (`127.0.0.1`) | Simplest; fully blocks LAN/remote access. No token, no origin allowlist, **no client changes** needed. |
| Typing indicator | **Yes, add it** | AI-generation feedback in the Chats thread. |

> **Session note:** There was ambiguity in an earlier answer ("just once") that did not map to
> the offered auth options; on clarification the user selected **Loopback-only (simplest)**.
> This reverses the earlier `decision-log` entry that listed "loopback + origin + shared token"
> — the user has since opted for the minimal option. Record this here so future readers don't
> assume the token middleware was requested.

**Implication of loopback-only:** the dashboard and all `/api/*` will be reachable **only** from
the local machine (`http://localhost:3000`). It will **not** be reachable from a LAN IP. This is
intended, given the user's statement *"this is locally runned like i do it only in my pc"*.

---

## 3. Workstream 1 — Loopback-only auth (security)

### 3.1 Goal
Eliminate remote/LAN exposure of the dashboard and its mutating endpoints with a minimal change.

### 3.2 Change (server.js)
Replace the server-start block (~line 128):

```js
// before
const httpServer = app.listen(PORT, () => {
  console.log(`[Dashboard] http://localhost:${PORT}`);
});

// after
const HOST = '127.0.0.1';   // loopback only — do NOT expose on the LAN
const httpServer = app.listen(PORT, HOST, () => {
  console.log(`[Dashboard] http://${HOST}:${PORT}`);
});
```

### 3.3 Verified behavior
- `curl http://localhost:3000/` → 200/302 (dashboard serves).
- `curl http://<LAN-IP>:3000/` → connection refused (nothing listening on non-loopback).
- All existing client code untouched (it connects to the same origin).

### 3.4 Not doing (explicitly, per user choice)
- ❌ No shared-token (`X-Api-Key`) middleware.
- ❌ No origin/referer allowlist.
- ❌ No helmet/CSP addition in this workstream (see note below).

> **Note on helmet/CSP:** The earlier plan reserved "helmet + real CSP". Since the user chose
> the simplest auth path, helmet/CSP is **deferred/optional** and NOT part of this workstream.
> It can be revisited separately if desired. Chart.js comes from jsdelivr (external), so any
> future CSP must allow that single host with SRI; see original plan §9.1.

### 3.5 Acceptance criteria
- Server binds to loopback only.
- Dashboard reachable on `localhost`, unreachable from LAN IP.
- No client-side changes required.

---

## 4. Workstream 2 — Fix Settings view (real config)

### 4.1 Problem
`renderSettings()` in `public/dashboard.js`:
- Calls `api('/api/stats')` (unrelated) and then writes **hardcoded** literals:
  `http://localhost:11434`, `'kamila'`, `'30000'`, `'2000'`.
- Those hardcoded values will drift from the real env (e.g., different `MODEL_NAME`,
  `RATE_LIMIT_COOLDOWN_MS`, or `PORT`).
- No DB path, no headless display, no Ollama reachability check.

### 4.2 Server change: add `GET /api/config`
Add near the other `/api` routes in `server.js`:

```js
app.get('/api/config', (_req, res) => {
  res.json({
    ollamaUrl:   OLLAMA_URL,
    modelName:   MODEL_NAME,
    axiosTimeoutMs: AXIOS_TIMEOUT_MS,
    rateLimitCooldownMs: RATE_LIMIT_COOLDOWN_MS,
    port:        PORT,
    dbPath:      DB_PATH,
    headless:    PUPPETEER_HEADLESS === 'true',
  });
});
```

**Security rule:** NEVER expose secrets here (no `DASHBOARD_API_KEY`, no tokens, no WhatsApp
credentials). Only operational, non-secret config.

### 4.3 Client change: rewrite `renderSettings()`
Replace the body of `renderSettings()` so it:
1. `const config = await api('/api/config')` (in addition to `await api('/api/status')`).
2. Populates each existing row from `config`:
   - `#cfg-ollama` ← `config.ollamaUrl`
   - `#cfg-model` ← `config.modelName`
   - `#cfg-timeout` ← `config.axiosTimeoutMs` (render with `ms` suffix)
   - `#cfg-ratelimit` ← `config.rateLimitCooldownMs` (render with `ms` suffix)
3. Add two new rows:
   - `DB Path` ← `config.dbPath`
   - `Headless` ← `config.headless ? 'true' : 'false'`
4. Keep the WhatsApp connection row (from `/api/status`, already correct).
5. Wrap in `try/catch` so a failed config fetch still shows the connection status (fail-degraded).

Example target row markup:
```html
<div class="setting-row">
  <span class="setting-key">OLLAMA_URL</span>
  <span class="setting-val" id="cfg-ollama">-</span>
</div>
```

Use `textContent` (or `esc()`) for all values to stay XSS-safe.

### 4.4 Acceptance criteria
- Settings view shows **real** env-derived config.
- No hardcoded `'kamila'` / `30000` values remain.
- DB path + headless rows present.
- Non-secret only; no keys leaked in `/api/config` response.

---

## 5. Workstream 3 — UX polish (incl. typing indicator)

### 5.1 Typing indicator (user-confirmed)

**Server (`server.js`):**
- Add a `broadcast('typing', { chatId, typing: true })` call **before** invoking Ollama
  (`callOllama`/the AI reply path) for a given chat.
- Add `broadcast('typing', { chatId, typing: false })` (or rely on the reply `message` event)
  when the AI reply is produced or errors.

**Client (`dashboard.js`):**
- Add a listener: `onSSE('typing', (d) => { if (currentView === 'chats' && selectedChat === d.chatId) toggleTyping(d.typing); })`.
- `toggleTyping(true)`: append a `msg-bubble msg-ai typing-bubble` element with an animated
  "Kamila is typing…" indicator; `toggleTyping(false)` (or on a `message` event for the chat):
  remove it / re-render thread.
- Add CSS: `.typing-bubble::after { animation: … }` or three-dot pulse; container
  `@keyframes typingDot` in `dashboard.css`.
- Ensure the existing `onSSE('message', …)` handler also dismisses the typing bubble for that chat.

### 5.2 Diff-aware contact list (prevent flicker)
**Problem:** `loadContactList()` re-renders `#contact-list` via `innerHTML` on every poll/SSE.
**Change:** compute a cheap signature (e.g., `JSON.stringify(contacts)`) and skip re-render if
unchanged:
```js
if (sig === lastContactSig) return;
lastContactSig = sig;
```
Also preserve contact-list scroll position when re-rendering:
```js
const st = el.scrollTop;
el.innerHTML = …;
el.scrollTop = st;
```
Apply the same signature-skip pattern to the thread render if cheap.

### 5.3 Draft expiry display
- In `loadDraftArea()` (`dashboard.js`), show `· created ${timeAgo(d.created_at)}` in the
  draft card meta.
- If the draft is older than a threshold (e.g., > 24h), add a CSS class (e.g., `.draft-stale`)
  to grey it out / dim it, signalling it may be outdated.
- Add `.draft-stale { opacity: .6 }` (or filter: saturate) in `dashboard.css`.

### 5.4 Needs-help badge on contacts
- Server: `/api/contacts` currently returns contacts only. Add a per-contact flag by joining
  the `evaluations` table for `needs_human_help=1`, OR add a separate lightweight endpoint /
  field. Preferred: add `needsHelp` to the `/api/contacts` response via a LEFT JOIN or separate
  query in `server.js`.
- Client: in `loadContactList()`, when `c.needsHelp`, render a small red dot/badge on the
  contact item (e.g., `<span class="contact-flag"></span>`), styled in `dashboard.css`.
- Tooltip/`title="Needs human help"` for accessibility.

### 5.5 Loading skeletons (replace bare `-`)
- Overview stat cards: initial `-` → skeleton shimmer blocks until `/api/stats` resolves.
- Evaluations table: show a skeleton row set or "Loading…" with spinner while fetching.
- Add CSS `.skeleton { background: linear-gradient(...); animation: shimmer … }` + keyframes.
- Chats/Tasks: keep existing empty states, but use a spinner while first fetch in flight.

### 5.6 Accessibility
- Add `aria-label` to icon-only `nav` links in `dashboard.html` (they already have visible
  text, so this is a light pass — label the nav landmark and each icon SVG `aria-hidden="true"`).
- Add `:focus-visible` outline styles in `dashboard.css` for `.nav-item`, `.btn`, `.input`,
  `.contact-item`.
- Add `role="status" aria-live="polite"` to `#toast-container` in `dashboard.html`.

### 5.7 Acceptance criteria
- Typing indicator appears during AI generation and clears on reply.
- Contact list no longer flickers on unchanged data; scroll preserved.
- Draft cards show age; stale drafts are visually dimmed.
- Contacts with `needs_human_help=1` show a visual flag.
- Overview/tables show skeletons instead of empty placeholders on first load.
- A11y attributes present; keyboard focus visible.

---

## 6. File-touch map

| File | Workstream | Nature of change |
|---|---|---|
| `server.js` | 1 (bind), 2 (`/api/config`), 3 (typing broadcast, contacts needsHelp) | Edit |
| `public/dashboard.js` | 2 (settings rewrite), 3 (typing, diff-aware, expiry, badges, skeletons) | Edit |
| `public/dashboard.html` | 3 (a11y: nav labels, aria-live) | Edit |
| `public/dashboard.css` | 3 (typing animation, skeleton, stale, flag, focus-visible) | Edit |

No new dependencies. No schema migration (drafts table already exists; evaluations exist;
`/api/contacts` change is additive only).

---

## 7. Implementation order (suggested)

1. **Workstream 1** (loopback bind) — security first; one-line change.
2. **Workstream 2** (`/api/config` server + Settings client rewrite).
3. **Workstream 3** in this sub-order:
   a. typing indicator (server broadcast + client bubble + CSS),
   b. diff-aware contact list,
   c. draft expiry + stale style,
   d. needs-help badges (server + client + CSS),
   e. skeletons,
   f. accessibility.

---

## 8. Verification plan

- `node --check server.js` and `node --check public/dashboard.js` (syntax).
- Manual smoke on `http://localhost:3000/dashboard.html`:
  - Overview: stat cards + 4 charts render; skeletons→data; SSE updates.
  - Chats: contact list no flicker; select a chat → thread + manual reply; in DRAFT mode a
    draft card shows age; AI generation shows typing bubble; needs-help contacts flagged.
  - Tasks: filter/search/complete still work; SSE pushes refresh.
  - Settings: shows **real** config (model, ollama URL, timeouts, port, db path, headless);
    WhatsApp status real.
  - Auth: `http://<LAN-IP>:3000` fails to connect; `http://localhost:3000` works.
- Optional (per `security-and-refactor` test plan): `node --test` guards for the loopback bind
  (e.g., assert server `address().address === '127.0.0.1'`).

---

## 9. Open items / decisions deferred

1. **helmet + real CSP** — deferred (not in this workstream). Revisit separately; must allow
   jsdelivr + SRI if added.
2. **Redundant polling cleanup** — user did NOT select this; keep the 5s/15s/30s `setInterval`
   loops. Documented for a future pass.
3. **SRI hash for Chart.js** — current `dashboard.html` links Chart.js CDN without an integrity
   attribute. Optional hardening; track separately.
4. **`countTable` template-string SQL** — code smell, low real risk (only called with
   hardcoded table names). Optionally refactor to a fixed prepared statement.

---

*End of plan.*
