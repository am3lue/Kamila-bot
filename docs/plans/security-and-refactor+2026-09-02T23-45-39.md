# Plan: Security & Refactor Remediation — Kamila Bot

- **Plan name:** `security-and-refactor`
- **Created:** 2026-09-02T23:45:39+03:00 (ID suffix: `2026-09-02T23-45-39`)
- **Status:** Approved / ready to execute
- **Mode:** Build
- **Related:** `dashboard-ui-ux+2026-09-02T23-45-39.md` (UI/UX dashboard track); reviews in `docs/reviews/2026-09-02T23-21-39/`

> This documents the remediation workstreams agreed earlier in the session (fix
> Phase 4 CRITICAL/WARNING items, finish npm vuln work, add tests, refactor).

---

## 1. Scope

- Fix all CRITICAL + HIGH + key MEDIUM findings from the two code reviews.
- Finish npm vulnerability work.
- Refactor `server.js` (527 lines) into many small files.
- Add a `node:test` suite (0% coverage today).

**Explicit decisions (from user):**
| Question | Decision |
|---|---|
| Security headers | **helmet + real CSP** (move inline JS to static files) |
| API auth | **loopback + origin + shared token** |
| Test framework | **node:test** (built-in, zero new deps) |

---

## 2. npm vulnerability work

**Resolved already:**
- `body-parser` 1.20.2 → 1.20.6 (DoS fix).
- `whatsapp-web.js` → 1.34.7, `puppeteer`/`puppeteer-core` → 24.38.0.
- `ws` → 8.21.3, `tar-fs` → 3.1.3 (puppeteer transitive).
- `qs` → 6.16.0 via `overrides` in `package.json` (2 moderate, gone).

**Remaining (accepted risk, document only):**
- `extract-zip` (5 HIGH, GHSA-jmr9-qjv8-65gv, CVSS 8.1) via
  `whatsapp-web.js` → `puppeteer` → `@puppeteer/browsers` → `extract-zip`.
- **No safe fix:** forcing `@puppeteer/browsers` 3.x requires Node >= 22.12 and is
  API-incompatible with `puppeteer-core@24.38.0` (pinned by `whatsapp-web.js@1.34.7`);
  even `npm audit fix --force` cannot resolve it.
- Runtime impact is low: `extract-zip` runs only during **browser install**, not message handling.
- **Action:** add `docs/security.md` documenting the accepted risk + mitigation.

**Related — browser fix (separate, already diagnosed):**
- Puppeteer 24.38.0 pins Chrome `146.0.7680.31`; the cache was replaced with v152
  (`chrome@stable`). WhatsApp cannot launch. Fix:
  `npx puppeteer browsers install chrome@146.0.7680.31`
  (or delete the v152 cache and let the bot auto-download the pinned revision).

---

## 3. CRITICAL fixes (server.js → new modules)

### C1 — Stored XSS (`innerHTML`)
- Add client-side `esc()` helper; apply to EVERY interpolation (contact name,
  phone, sender, text, task desc/urgency, alert chat_id/summary).
- Sanitize AI task/summary on **write** paths (`sanitizeInput` before DB insert).

### C2 — Unauthenticated / CSRF-vulnerable mutating API
- Bind listener to loopback: `app.listen(PORT, '127.0.0.1', ...)`.
- Origin/referer allowlist middleware (reject non-localhost).
- Require shared secret token (`X-Api-Key` from `DASHBOARD_API_KEY` env) on all
  mutating POSTs: `/mode`, `/send-draft`, `/send`, `/complete-task`, `/evaluate`.
- `SameSite=Strict` cookie + CSRF token (`csrf-csrf`) for browser interactions.

### C3 — covered by "npm vulnerability work" above (accepted risk, no code change).

### C4 — Tailwind CDN supply-chain risk → bundled CSS (see dashboard plan).

### C5 — Prompt injection into Ollama (evaluator/extractor)
- Delimit the transcript as a JSON-encoded data block.
- Strict schema validation of parsed output (score 1-10 clamp, sentiment enum,
  boolean, non-empty summary); reject out-of-range.

---

## 4. WARNING fixes

| # | Item | Fix |
|---|---|---|
| W1 | Dead `bot.js` | Delete it |
| W2 | No body limit | `express.json({ limit: '100kb' })` (drop `body-parser` dep) |
| W3 | No security headers | `helmet` + **real CSP**; move inline JS/CSS to `public/` |
| W4 | Rate-limit Map leak | periodic eviction `setInterval(...).unref()` (or LRU) |
| W5 | Duplicate/racy task extraction | per-chat promise queue; dedupe by `(chat_id, task_description)`; last-evaluated cursor |
| W6 | Prompt injection | see C5 (schema validation) |
| W7 | sanitizeInput | keep as defense-in-depth on read+write; not the XSS fix |
| W8 | Draft preview surrogate cut | code-point-aware truncation (`Array.from(...).slice`) |
| W9 | `/api/send-draft` arbitrary send | validate chatId→to mapping, add draft expiry, require auth |
| W10 | Unsafe `JSON.parse` on LLM output | wrap in try/catch with specific logging |
| W11 | `.gitignore` | add: `node_modules/`, `.env`, `*.db`, `.wwebjs_auth/`, `logs/` |

---

## 5. Refactor — file layout (many small files)

```
src/db.js           # better-sqlite3 schema + prepared statements (exported for tests)
src/ollama.js       # axios client + evaluateConversation + extractTasks + schema validation
src/whatsapp.js     # Client wiring + 'message' handler + modes + rate limit
src/security.js     # sanitizeInput, esc, origin/CSRF middleware, eviction
src/dashboard.js    # served HTML (render now isolated/testable)  [see dashboard plan]
public/dashboard.js # client JS (CSP-safe)
public/dashboard.css# client CSS (CSP-safe)
src/server.js       # routes + bootstrap (slim)
```

---

## 6. Tests (`node:test`, script `"test": "node --test"`)

- **Unit:** `sanitizeInput` — tags, control chars, injection phrases, empty/non-string, length cap.
- **Unit:** `splitMessage` — short, exact-boundary, sentence-split, no-space, multi-byte.
- **Unit:** `checkRateLimit` + eviction.
- **Unit:** evaluation/task JSON parser — valid, garbage, malicious/injection, empty, out-of-range rejection.
- **Integration:** DB schema round-trip on `better-sqlite3(':memory:')`.
- **Route:** origin guard → 403 on foreign origin; missing/wrong `X-Api-Key` → 401.

---

## 7. Sequencing / dependencies

1. **C1 (delete bot.js)** + **A (security.md)** + **W11 (.gitignore)** — trivial, no risk.
2. **C2 (CRITICAL)** — XSS escape + origin/loopback/token guard (independent).
3. **W2–W4** — body limit, helmet/CSP, rate-limit eviction (small, additive).
4. **Refactor (Section 5)** — BEFORE C5/W5/W6 so logic lands in new modules.
5. **C5, W5, W6, W9, W10** — logic fixes in refactored modules.
6. **Tests (Section 6)** — after refactor, against extracted pure functions.
7. **Verify:** `npm audit`, `node --check` on all files, `npm test`, smoke test.

---

## 8. Verification checklist

- [ ] `npm audit` — only documented `extract-zip` accepted risk remains.
- [ ] `node --check` passes on all `.js` files.
- [ ] `npm test` green (node:test suite).
- [ ] Brief `npm start` smoke test on `localhost:3000` (WhatsApp browser launcher uses pinned Chrome 146).

---
*End of plan.*
