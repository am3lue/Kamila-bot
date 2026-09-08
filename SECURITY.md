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

---

## Security Audit (2026-09-04)

### Critical Issues

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 1 | API key committed to git history | `.env` | **FIXED** - Key rotated |
| 2 | API key stored in localStorage (XSS vulnerable) | `public/dashboard.js` | Open |
| 3 | Auth disabled by default | `server.js:269-306` | Open |

### High Priority Issues

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 4 | Weak CSRF protection | `server.js:285-300` | Open |
| 5 | No rate limiting on API endpoints | `server.js:475-489` | Open |
| 6 | Error messages leak internal details | `server.js:744-746` | Open |
| 7 | Vulnerable dependencies (puppeteer chain) | `package.json` | Open |
| 8 | Puppeteer runs without sandbox | `.env:14` | Open |
| 9 | No HTTPS enforcement | `server.js:318` | Open |
| 10 | Missing security headers (CSP, HSTS) | `server.js:261-267` | Open |

### Medium Priority Issues

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 11 | Input validation gaps | `server.js:1060-1087` | Open |
| 12 | No CORS configuration | `server.js:255-258` | Open |
| 13 | Unprotected SSE endpoint | `server.js:324-333` | Open |
| 14 | Weak input sanitization | `server.js:341-349` | Open |
| 15 | SQLite databases unencrypted | `server.js:44-46` | Open |
| 16 | Config endpoint exposes internal URLs | `server.js:714-722` | Open |

### Low Priority Issues

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 17 | No request size limits | `server.js:256` | Open |
| 18 | No security event logging | `utils/logger.js` | Open |
| 19 | No session management | `server.js:269-282` | Open |

---

## Remediation Guide

### 1. API Key Storage (Issue #1 - FIXED)

**Before:** API key was in `.env` file committed to git history.

**After:** API key rotated and git history cleaned.

```bash
# Clean git history of leaked secrets
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch .env' \
  --prune-empty --tag-name-filter cat -- --all

# Force push cleaned history
git push origin --force --all
```

### 2. Enable Auth by Default (Issue #3)

Change the default in `server.js`:

```javascript
// BEFORE
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === '1' || process.env.REQUIRE_AUTH === 'true';

// AFTER
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== '0' && process.env.REQUIRE_AUTH !== 'false';
```

Then in `.env`:
```env
REQUIRE_AUTH=1
API_KEY=your-new-secure-api-key
```

### 3. Add Rate Limiting (Issue #5)

Install express-rate-limit:
```bash
npm install express-rate-limit
```

Add to `server.js`:
```javascript
import rateLimit from 'express-rate-limit';

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: { error: 'Too many requests' }
});

const broadcastLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 broadcasts per hour
  message: { error: 'Too many broadcasts' }
});

app.use('/api/', apiLimiter);
app.use('/api/broadcast', broadcastLimiter);
```

### 4. Sanitize Error Messages (Issue #6)

Replace `err.message` with generic messages:

```javascript
// BEFORE
} catch (err) {
  res.status(500).json({ error: err.message });
}

// AFTER
} catch (err) {
  logger.error('API', 'Endpoint failed', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'An internal error occurred' });
}
```

### 5. Add Security Headers (Issue #10)

```javascript
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:;");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
```

### 6. Update Vulnerable Dependencies (Issue #7)

```bash
npm audit fix --force
npm install whatsapp-web.js@latest
```

### 7. CSRF Protection (Issue #4)

```javascript
import crypto from 'crypto';

app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const origin = req.headers.origin || req.headers.referer;
    const allowedOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
    if (!origin || !allowedOrigins.some(o => origin.startsWith(o))) {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }
  next();
});
```

---

## Best Practices for Deployment

### Environment Variables

```bash
# Production .env settings
REQUIRE_AUTH=1
API_KEY=<generate-with-openssl-rand-base64-32>
PUPPETEER_HEADLESS=true
PUPPETEER_ARGS=--disable-dev-shm-usage,--disable-gpu
```

### Generate Secure API Key

```bash
openssl rand -base64 32
```

### Run as Non-Root User

```bash
# Create dedicated user
sudo useradd -m -s /bin/bash kamila
sudo su - kamila

# Run the bot
npm start
```

### Enable HTTPS (Production)

```bash
# Using Let's Encrypt
sudo apt install certbot
sudo certbot certonly --standalone -d yourdomain.com

# Update server.js to use HTTPS
import https from 'https';
import fs from 'fs';

const httpsServer = https.createServer({
  key: fs.readFileSync('/etc/letsencrypt/live/yourdomain.com/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/yourdomain.com/fullchain.pem')
}, app);

httpsServer.listen(PORT);
```

---

## Security Checklist

Before deploying to production, verify:

- [ ] `REQUIRE_AUTH=1` is set in `.env`
- [ ] `API_KEY` is set and strong (32+ characters)
- [ ] `.env` is in `.gitignore` and never committed
- [ ] `npm audit` shows no high/critical vulnerabilities
- [ ] Security headers are configured
- [ ] Rate limiting is enabled on API endpoints
- [ ] Error messages don't leak internals
- [ ] Puppeteer runs as non-root user
- [ ] HTTPS is enabled (production)
- [ ] Database backups are encrypted
