# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public issue for security vulnerabilities.**

Instead, please email the maintainers directly or use GitHub's private vulnerability reporting feature.

When reporting, please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Time

We aim to acknowledge reports within 48 hours and provide a fix or mitigation plan within 7 days.

## Scope

This security policy applies to the code in this repository only.

## Security model

- **Sign-in:** Tausi Auth. The dashboard session lives in an HttpOnly cookie set by the server-side proxy (`/auth/tausi`); cookie-authenticated writes must come from the same origin.
- **Isolation:** every project belongs to one Tausi user. API routes check ownership and answer 404 for other users' projects. Owners (Tausi role `admin`, or a verified email/phone in `OWNER_EMAILS` / `OWNER_PHONES`) also see the Kamila bot.
- **Keys:** project secret keys (`wsk_`) are stored as SHA-256 hashes and shown once. Publishable keys (`wpk_`) only work for the chat widget, from allowed origins. Per-project Gemini keys are AES-256-GCM encrypted (`ENCRYPTION_KEY`).
- **OTP:** codes are stored as HMAC hashes, single-use, expire, lock after repeated wrong guesses, and are rate-limited per number and per project.
- **Database:** Supabase is used only with the service-role key on the server. Every gateway table has RLS enabled with no policies, and the SQL functions are executable by `service_role` only.
- **Outbound requests:** webhook and answer URLs are checked against private and loopback addresses both when saved and when connecting (DNS rebinding), unless `ALLOW_PRIVATE_WEBHOOKS=1`.
- **Abuse limits:** OTP, Chat API and widget traffic are rate-limited; the widget also has a daily cap per project (`WIDGET_MAX_MESSAGES_PER_DAY`).

Keep `.env` out of version control and rotate `TAUSI_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` if they are ever exposed.
