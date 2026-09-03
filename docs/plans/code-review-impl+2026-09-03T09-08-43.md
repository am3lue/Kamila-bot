# Plan: Implement Remaining Open Findings from code-review.md

- **Plan name:** `code-review-impl`
- **Created:** 2026-09-03T09:08:43+03:00 (ID suffix: `2026-09-03T09-08-43`)
- **Status:** Documented / ready to execute on approval
- **Mode:** Build (after approval)
- **Source:** `docs/reviews/2026-09-02T23-21-39/code-review.md` (+ fresh review pass captured below)
- **Related plans:**
  - `security-and-refactor+2026-09-02T23-45-39.md`
  - `dashboard-improvements+2026-09-03T00-14-17.md`
  - `dashboard-ui-ux+2026-09-02T23-45-39.md`

---

## 0. TL;DR

`code-review.md` flagged 23 issues (5 CRITICAL / 6 HIGH / 9 MED / 3 LOW). Grounding that report
against the **current working tree** shows most are already resolved (XSS, Tailwind CDN, bot.js,
.gitignore, body-parser, security headers, input validation, drafts table, SSE).

This plan covers the **genuinely still-open** items, plus new findings from a re-review of the
current code. It uses a conservative, low-risk approach suitable for a local single-PC tool.

---

## 1. Snapshot used for this plan

- `server.js` — 878 lines, `app.listen(PORT)` binds `0.0.0.0` (line 230). Auth via optional
  `API_KEY` header (also accepts `?key=` query) + CSRF same-origin check + manual security headers.
  SSE `sseClients` is an unbounded `Set` with no heartbeat. Ollama uses linear retry, no circuit
  breaker. `evaluateConversation`/`extractTasks` fired via bare `setTimeout`. Model:
  `better-sqlite3@13.0.3`.
- `public/dashboard.js` — 827 lines; `esc()`-safe rendering; API key in `localStorage`.
- `bot.js` — **deleted**. `src/` dir — **does not exist** (monolith remains).
- No tests, no test scripts. `.gitignore` present and good.

## 2. Open findings from code-review.md → action

| # (from report) | Finding | Status in current tree | Action |
|---|---|---|---|
| CRIT #2 + HIGH #8 | No auth + binds 0.0.0.0 | ✅ auth exists (API_KEY) — user chose **no loopback bind**, keep API_KEY | **WS-1: header-only key, keep API_KEY** |
| HIGH #6 | Unbounded maps / SSE leak | `userRateLimit` has cleanup; `sseClients` unbounded | **WS-2: SSE heartbeat + cap** |
| HIGH #11 | Fire-and-forget eval/tasks | open (`setTimeout`, no queue) | **WS-3: simple concurrency+tracking** |
| MED #14 | Magic numbers | open | **WS-4: named constants** |
| MED #15 | 41 console.log, no logging | open | **WS-5: minimal logger** |
| MED #17 | No tests | open | **WS-6: node:test suite** |

Additional new findings (fresh review) folded in:
- **WS-2** covers the reviewer's C3 (SSE heartbeat/max connections).
- **WS-7 (included):** circuit breaker on Ollama (real C4). **User opted IN — include now.**
- **`?key=` query-param auth** (real C1) — folded into WS-1 (accept header only).

## 3. Open conflict — resolved (design decision)

**User decision (2026-09-03):** "just use API_KEY since its Less Internet required" →
**Do NOT bind to loopback. Keep the existing optional `API_KEY` auth model.** The earlier
`dashboard-improvements` loopback-only idea is **superseded** for this plan. The dashboard
remains reachable on all interfaces but is gated by the API key. This is the user's stated
preference (consistent with accessing from devices; no port-bind complications).

Consequence for the earlier `dashboard-improvements` plan:
- Its **Workstream 1 (loopback bind) is dropped** in favor of API_KEY.
- Its WS-1 "explicitly do NOT add token" stance is reversed — the token stays.

**WS-1 scope (narrowed):** keep API_KEY and the existing CSRF + security headers; just
**remove the `?key=` query-string fallback** so the key is only accepted via the `x-api-key`
header (prevents key leakage in URLs/logs/referrers).

---

## 4. Workstreams

### WS-1 — Header-only API key (keep API_KEY auth, no loopback bind) (security)
**File:** `server.js`
- **Keep** `app.listen(PORT, ...)` as-is (do NOT bind `127.0.0.1`). Server stays reachable on all
  interfaces; security comes from the API key.
- In `requireAuth`, change `const key = req.headers['x-api-key'] || req.query.key;` →
  `const key = req.headers['x-api-key'];` and update the 401 message to reference only the header
  (drop the `?key=` param mention).
- For readability, add a small helper for the key lookup, e.g. `const apiKeyFromReq = (req) => req.get('x-api-key');`.
- Verification: `curl -H "x-api-key: $KEY" http://localhost:3000/api/stats` works; `?key=$KEY` no
  longer accepted; missing/bad key returns 401.

### WS-2 — SSE heartbeat + max connections (memory safety)
**File:** `server.js` (§"SSE Infrastructure" + `/api/events`)
- Convert `sseClients` from `Set<res>` to `Map<res, {lastPing:number}>`.
- Add constants `MAX_SSE_CLIENTS = 50`, `SSE_HEARTBEAT_MS = 15000`, `SSE_IDLE_TIMEOUT_MS = 30000`.
- Add a `setInterval` heartbeat that writes `: ping\n\n` and drops stale connections.
- In `/api/events`, reject with 429 when `sseClients.size >= MAX_SSE_CLIENTS`.
- Update `broadcast()` to iterate the Map and keep the existing try/catch cleanup.
- Verification: `node --check`; load the dashboard; confirm SSE still updates; open many tabs to
  confirm the 50-cap returns a 429 on the 51st.

### WS-3 — Tracking + limited concurrency for eval/tasks (fire-and-forget fix)
**File:** `server.js`
- Replace bare `setTimeout(() => { evaluateConversation(chatId); extractTasks(chatId); }, 5000)`
  (message handler) and any similar paths with a small **task queue**:
  - A `const backgroundQueue = []` + a `MAX_BG_CONCURRENCY = 2` counter, or use
    `setImmediate` serialisation. **No new dependency** (per no-deps rule) unless the user allows
    `p-queue`.
  - Wrap each job in try/finally so a failure can't wedge the counter.
- Verification: `node --check`; send a test message and observe eval/task jobs run without
  overlapping beyond the cap.

### WS-4 — Name the magic numbers (maintainability)
**File:** `server.js` (+ `dashboard.js` where shared)
- Extract to named constants near the top:
  - `MIN_EVAL_MESSAGES = 3`, `CONTEXT_WINDOW_SIZE = 10`, `MAX_RECENT_MESSAGES = 50`,
    `TYPING_DELAY_MIN_MS = 1500`, `TYPING_DELAY_MAX_MS = 8000`, `TYPING_DELAY_PER_CHAR_MS = 40`,
    `EVAL_DELAY_MS = 5000`, `RATE_LIMIT_CLEANUP_CUTOFF_MS = 3600000`, `RATE_LIMIT_CLEANUP_INTERVAL_MS = 600000`.
- Replace the inline literals at the relevant call sites.
- Verification: `node --check`; behavior identical (constants equal old literals).

### WS-5 — Minimal structured logger (maintainability)
**File:** `server.js`
- Add a tiny `log` object near the top:
  ```js
  const log = {
    info: (...a) => process.env.LOG_LEVEL !== 'silent' && console.log(...a),
    warn: (...a) => process.env.LOG_LEVEL !== 'silent' && console.warn(...a),
    error: (...a) => console.error('[ERROR]', ...a),
  };
  ```
- Replace noisy `console.log/error` in the bot message handler and Ollama path with `log.…`.
  Keep the error-path detail logging but route through `log.error`.
- Verification: `node --check`; run with `LOG_LEVEL=silent` and confirm info/warn suppressed,
  errors still shown.

### WS-6 — node:test suite (regression safety)
**Files (new):** `src/lib.js`, `test/*.test.js`, plus `"test": "node --test"` script in `package.json`.
- **User decision:** extract `src/lib.js` (recommended). Create `src/lib.js` exporting the pure
  helpers — `sanitizeInput`, `splitMessage`, `checkRateLimit`, `normalizePhone`, `parseVCard`,
  `accessAllowed` (subject to dependency check: `accessAllowed` reads DB, so it should be
  parameterised to accept a `getType`/`whitelistCount` closure for testability).
- **Important refactor note:** `server.js` currently defines these helper bodies inline. Moving
  them to `src/lib.js` requires:
  - `sanitizeInput`/`splitMessage` reference `MAX_MSG_LEN`/`MAX_WHATSAPP_LEN` → pass as params or
    import constants into `lib.js`.
  - `checkRateLimit`/`parseVCard` are standalone → easy.
  - `normalizePhone`/`accessAllowed` in `server.js` → move; keep `seedAccessFromEnv` importing them.
  - Keep network/DB/WhatsApp logic in `server.js`. This is a **contained** extraction, NOT the
    full `src/` split (documented, still deferred).
- Import the helpers back into `server.js` and into the tests.
- Tests:
  - `sanitize.test.js` — strips HTML, control chars, prompt-injection phrases, truncates to limit.
  - `splitMessage.test.js` — chunk boundaries, sentence/word split, long words, under-limit single chunk.
  - `ratelimit.test.js` — first call passes, rapid repeat blocked, cooldown expiry.
  - `phone.test.js` — `normalizePhone` (digits-only, `@c.us` suffix strip, rejects junk) + `accessAllowed`.
  - `vcard.test.js` — parses FN/TEL, QP encoding, skips photos, dedupes.
- Verification: `npm test` passes green.

### WS-7 — Circuit breaker on Ollama (**included now**)
**File:** `server.js`
- **User decision:** include now. Wrap Ollama calls so that after `N` consecutive failures the
  breaker trips `open` for a cooldown, then `half-open` to probe recovery. No new dependency.
- Minimal design (no deps):
  - Fields: `failures`, `threshold` (e.g. 5), `cooldownMs` (e.g. 30s), `state` ('closed'|'open'|'half-open'), `openedAt`.
  - `call()`: if `open` and past cooldown → `half-open`; if `open` and within cooldown → throw
    fast ("Ollama temporarily disabled — try again shortly"); else attempt, on success reset,
    on failure increment and trip `open` at threshold.
  - Wire it **around** `callOllama` (wrap the axios POST) so `evaluateConversation`,
    `extractTasks`, `/api/enhance`, and the message reply path all benefit without duplicating.
  - In the message reply handler, treat a fast "circuit open" error gracefully (skip the reply or
    send a short notice) rather than blocking the thread for 90s.
- Also update WS-5 error logging to log the `open`/`half-open` transitions at `warn` level.
- Verification: with Ollama stopped, send a message → after threshold the breaker trips and the
  bot fails fast instead of 3×30s timeouts; restart Ollama → auto-recovers.

---

## 5. Out of scope (already done, or noise)

- Tailwind CDN, XSS innerHTML, bot.js, security headers, body-parser, .gitignore, HTML-in-JS,
  drafts persistence, `qs` override, eval/task JSON.parse (already try/catch). ✅ already done.
- Full `src/` module split (H1/H2) — large refactor; **deferred** (documented, not this plan).
- `pino` dependency for logging — avoided (no new deps); WS-5 is the minimal choice.
- `lru-cache` / `p-queue` dependencies — avoided for the same reason.
- Redundant polling removal — previously deferred by user choice; still out of scope.

## 6. File-touch map

| File | Change |
|---|---|
| `server.js` | WS-1, WS-2, WS-3, WS-4, WS-5, WS-6 (import lib), WS-7 (circuit breaker) |
| `src/lib.js` (new) | WS-6 — pure helpers extracted |
| `test/*.test.js` (new) | WS-6 |
| `package.json` | WS-6 `"test": "node --test"` |
| `.env.example` | WS-5 optional `LOG_LEVEL` line |
| `dashboard.js` | only if WS-4 constants shared (minor) |

## 7. Verification

- `node --check server.js`, `node --check src/lib.js`, `node --check public/dashboard.js`.
- `npm test` → all green.
- Manual smoke on `http://localhost:3000/dashboard.html`: overview/chats/tasks/broadcast/settings
  still work; SSE live updates; missing/bad `x-api-key` returns 401; `?key=` rejected.
- WS-7: stop Ollama → after threshold the breaker trips and the bot fails fast (no 90s block);
  restart Ollama → auto-recovery.

## 8. Decisions (locked 2026-09-03)

1. **WS-1** — ✅ **Use API_KEY, no loopback bind.** Keep the existing optional `API_KEY` + CSRF +
   security headers. Only remove the `?key=` query fallback (header-only). "just use API_KEY since
   its Less Internet required".
2. **WS-7** — ✅ **Include the Ollama circuit breaker now** (no new dependency).
3. **WS-6** — ✅ **Extract `src/lib.js`** (pure helpers only, not the full module split).

---

*End of plan.*
