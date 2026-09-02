# Phase 4 Review Plan — Architecture & Web Dashboard

**Date:** 2026-09-02
**Scope:** `server.js`, `bot.js`, `package.json`, `.env*`, `Modelfile`
**Type:** Security + Code Quality + Architecture review

---

## 1. Objectives

Review the Phase 4 implementation against current Node.js/Express/WhatsApp-bot
best practices. Goal: identify CRITICAL/HIGH blockers before merge, plus
MEDIUM/LOW improvements. Findings are grounded in live dependency audit
(`npm audit`) and current OWASP / Express security guidance.

---

## 2. Files Under Review

| File | Size | Role |
|------|------|------|
| `server.js` | 505 lines | Express app, SQLite schema, WhatsApp bot, dashboard |
| `bot.js` | 57 lines | Legacy single-message bot (superseded by server.js) |
| `package.json` | 26 lines | Dependency manifest |
| `.env` / `.env.example` | — | Configuration |
| `Modelfile` | 35 lines | Ollama persona |

---

## 3. Threat Model

Local dashboard exposed at `http://localhost:3000`. Key assumptions / risks:

1. **No authentication** on any `/api/*` route — any local process (and on a
   shared machine, any browser tab) can read contacts/messages and mutate
   state (send drafts, mark tasks done, change modes).
2. **Lateral injection** — a malicious WhatsApp message is stored in SQLite,
   then rendered client-side via `innerHTML`. If sanitization is bypassed this
   is stored XSS that reaches the dashboard.
3. **Puppeteer/whatsapp-web.js** — the audit shows a HIGH-severity transitive
   path traversal (`extract-zip` GHSA-jmr9-qjv8-65gv) reachable through
   puppeteer → whatsapp-web.js.
4. **Ollama SSRF/abuse** — the bot calls a local model with user-controlled
   text; prompt-injection and unbounded cost/latency are real concerns.

---

## 4. Review Checklist (executed)

### Security (CRITICAL)
- [ ] Hardcoded credentials / secrets in source
- [ ] SQL injection via string concatenation (better-sqlite3 prepared stmts)
- [ ] Stored / reflected XSS via `innerHTML` + untrusted AI/WhatsApp text
- [ ] Input validation on every `/api/*` handler
- [ ] Dependency CVEs (`npm audit`)
- [ ] Missing security headers (helmet), CSP, request-size limits
- [ ] CSRF on state-changing endpoints
- [ ] Path traversal in route params (`:id` used in SQL)

### Code Quality (HIGH)
- [ ] Functions / files over recommended size
- [ ] Nesting depth
- [ ] Error handling coverage
- [ ] `console.log` statements
- [ ] TODO/FIXME markers

### Best Practices & Performance (MEDIUM)
- [ ] Test coverage (currently 0%)
- [ ] Polling vs real-time (setInterval loadContacts)
- [ ] Rate limiting robustness
- [ ] Background worker concurrency / duplicate task extraction

### Style (LOW)
- [ ] Naming consistency, formatting, magic numbers

---

## 5. Execution Steps

1. Read `server.js` fully (done) and map every route to its handler.
2. Run `npm audit` (done — see findings).
3. Grep for `innerHTML`, `eval`, dangerous input sinks (done).
4. Cross-check with current OWASP Node.js cheat sheet (done via web search).
5. Compile findings into `docs/reviews/phase4-review-report.md` with
   CRITICAL / WARNING / SUGGESTION severity and copy-paste fixes.

---

## 6. Deliverables

- [x] This plan
- [x] `docs/reviews/phase4-review-report.md` — full severity-ranked report with
      line-referenced fixes.
- [ ] Follow-up: add `.gitignore`, init git, add tests, apply fixes.

---

## 7. Grounding Sources (web search performed)

- Express.js — Production Best Practices: Security
- OWASP Node.js Security Cheat Sheet (2025)
- better-sqlite3 prepared-statement SQL-injection posture (GH issue #720)
- Bright Coding — Build WhatsApp Bots with Node.js (2025): `.env`, throttling,
  blacklist, auth, webhook HMAC guidance
- Nexus — secured Express 5 playbook (2026): helmet, rate-limit, body cap,
  CSRF via `csrf-csrf`, zod boundary validation
- live `npm audit` for this repo's lockfile

**Verdict (preliminary):** BLOCK — one or more CRITICAL/HIGH issues confirmed
(minimum: stored XSS + unauthenticated state-mutating API + HIGH CVE), until
remediation.
