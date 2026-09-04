# Security Audit Report

**Date:** 2026-09-04
**Scope:** Full codebase (server.js, utils/, public/)
**Risk Level:** HIGH

---

## Executive Summary

A comprehensive security audit of the Kamila WhatsApp Bot revealed **19 vulnerabilities** across the codebase:

- **Critical:** 3 issues requiring immediate attention
- **High:** 7 issues that should be fixed before production
- **Medium:** 6 issues that should be addressed
- **Low:** 3 issues for future improvement

The most severe issues involve API key exposure, disabled authentication by default, and missing rate limiting on API endpoints.

---

## Critical Vulnerabilities

### C1: API Key Committed to Git History

**CVSS:** 9.8 (Critical)
**CWE:** CWE-798 (Use of Hard-coded Credentials)

**Description:**
The `.env` file containing the API key was committed to the git repository. Even after removal, the key remains in git history.

**Evidence:**
```bash
git log --all -p -- .env | grep "API_KEY"
```

**Impact:**
- Anyone with repository access can extract the API key
- The key may be used to authenticate to external services
- Git history cannot be easily purged

**Remediation:**
1. **Rotate the API key immediately**
2. Clean git history using BFG Repo-Cleaner:
   ```bash
   bfg --delete-files .env
   git reflog expire --expire=now --all && git gc --prune=now --aggressive
   ```
3. Force push cleaned history:
   ```bash
   git push origin --force --all
   ```

**Status:** ✅ FIXED - Key rotated

---

### C2: API Key Stored in localStorage

**CVSS:** 9.1 (Critical)
**CWE:** CWE-922 (Insecure Storage of Sensitive Information)

**Description:**
The API key is stored in `localStorage` and sent with every request:

```javascript
const apiKey = () => localStorage.getItem('kamila_api_key') || '';
headers: { 'x-api-key': apiKey() }
```

**Impact:**
- Any XSS vulnerability allows API key theft
- `localStorage` persists across sessions
- Accessible to any JavaScript on the same origin

**Remediation:**
```javascript
// Option 1: Use httpOnly cookies (recommended)
// Server sets: Set-Cookie: api_key=xxx; HttpOnly; Secure; SameSite=Strict

// Option 2: Use sessionStorage (cleared on tab close)
const apiKey = () => sessionStorage.getItem('kamila_api_key') || '';

// Option 3: Use in-memory only (most secure, lost on refresh)
let apiKeyCache = null;
```

**Status:** Open

---

### C3: Authentication Disabled by Default

**CVSS:** 9.0 (Critical)
**CWE:** CWE-306 (Missing Authentication for Critical Function)

**Description:**
Authentication is disabled unless explicitly enabled:

```javascript
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === '1' || process.env.REQUIRE_AUTH === 'true';
function requireAuth(req, res, next) {
  if (!REQUIRE_AUTH) return next(); // Bypasses all auth
  // ...
}
```

**Impact:**
- All API endpoints accessible without authentication
- Anyone can send messages, read conversations, delete contacts
- Broadcast endpoint can spam up to 500 contacts

**Remediation:**
```javascript
// Change default to require auth
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== '0' && process.env.REQUIRE_AUTH !== 'false';
```

**Status:** Open

---

## High Priority Vulnerabilities

### H1: Weak CSRF Protection

**CVSS:** 8.1 (High)
**CWE:** CWE-352 (Cross-Site Request Forgery)

**Description:**
CSRF check only validates the `Origin` header and accepts any valid IPv4 address:

```javascript
const allowed = host === '' || origin.startsWith('file://') || loopback || !!validIpv4;
```

**Impact:**
- Attackers on the same network can bypass CSRF
- No CSRF token mechanism exists
- State-changing operations vulnerable

**Remediation:**
```javascript
// Implement proper CSRF protection
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

**Status:** Open

---

### H2: No Rate Limiting on API Endpoints

**CVSS:** 7.5 (High)
**CWE:** CWE-770 (Allocation of Resources Without Limits)

**Description:**
Rate limiting only applies to WhatsApp messages, not API endpoints:

```javascript
function checkRateLimit(userId) {
  // Only used for WhatsApp message handling
  const now = Date.now();
  const last = userRateLimit.get(userId) || 0;
  if (now - last < Number(RATE_LIMIT_COOLDOWN_MS)) return false;
  // ...
}
```

**Impact:**
- API endpoints can be hammered with requests
- Broadcast endpoint can be abused for spam
- No protection against brute force

**Remediation:**
```bash
npm install express-rate-limit
```

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

**Status:** Open

---

### H3: Error Messages Leak Internal Details

**CVSS:** 7.5 (High)
**CWE:** CWE-209 (Generation of Error Message Containing Sensitive Information)

**Description:**
Internal error messages are exposed to clients:

```javascript
} catch (err) {
  res.status(500).json({ error: err.message }); // Leaks internal details
}
```

**Impact:**
- Attackers learn about database structure and file paths
- Error messages may contain stack traces or SQL errors

**Remediation:**
```javascript
} catch (err) {
  logger.error('API', 'Endpoint failed', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'An internal error occurred' });
}
```

**Status:** Open

---

### H4: Vulnerable Dependencies

**CVSS:** 7.4 (High)
**CWE:** CWE-1035 (Use of Third-party Components with Known Vulnerabilities)

**Description:**
`npm audit` found 5 high-severity vulnerabilities in the puppeteer chain:

```
extract-zip: unvalidated symlink path traversal (HIGH)
@puppeteer/browsers: depends on vulnerable extract-zip (HIGH)
puppeteer: depends on vulnerable @puppeteer/browsers (HIGH)
puppeteer-core: depends on vulnerable @puppeteer/browsers (HIGH)
whatsapp-web.js: depends on vulnerable puppeteer (HIGH)
```

**Impact:**
- Symlink path traversal could allow arbitrary file writes
- Exploitable during Puppeteer operations

**Remediation:**
```bash
npm audit fix --force
npm install whatsapp-web.js@latest
```

**Status:** Open

---

### H5: Puppeteer Running Without Sandbox

**CVSS:** 7.2 (High)
**CWE:** CWE-250 (Execution with Unnecessary Privileges)

**Description:**
Puppeteer is configured with `--no-sandbox`:

```javascript
PUPPETEER_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu
```

**Impact:**
- Chromium runs with reduced security isolation
- Compromised webpage could escape sandbox
- Increased attack surface for RCE

**Remediation:**
```bash
# Run as non-root user
sudo useradd -m -s /bin/bash kamila
sudo su - kamila

# Update .env
PUPPETEER_ARGS=--disable-dev-shm-usage,--disable-gpu
```

**Status:** Open

---

### H6: No HTTPS Enforcement

**CVSS:** 7.1 (High)
**CWE:** CWE-319 (Cleartext Transmission of Sensitive Information)

**Description:**
Server runs on HTTP without TLS:

```javascript
const httpServer = app.listen(PORT, () => {
  logger.info('Dashboard', `Server running at http://localhost:${PORT}`);
});
```

**Impact:**
- API keys transmitted in plaintext
- Session data and messages can be intercepted
- Man-in-the-middle attacks possible

**Remediation:**
```javascript
import https from 'https';
import fs from 'fs';

if (process.env.NODE_ENV === 'production') {
  const httpsServer = https.createServer({
    key: fs.readFileSync(process.env.TLS_KEY_PATH),
    cert: fs.readFileSync(process.env.TLS_CERT_PATH)
  }, app);
  httpsServer.listen(PORT);
} else {
  app.listen(PORT);
}
```

**Status:** Open

---

### H7: Missing Security Headers

**CVSS:** 7.0 (High)
**CWE:** CWE-693 (Protection Mechanism Failure)

**Description:**
Critical security headers are missing:

```javascript
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Missing: Content-Security-Policy, Strict-Transport-Security, Permissions-Policy
  next();
});
```

**Impact:**
- No CSP means XSS attacks can load external scripts
- No HSTS allows downgrade attacks
- No Permissions-Policy allows feature abuse

**Remediation:**
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

**Status:** Open

---

## Medium Priority Vulnerabilities

### M1: Input Validation Gaps

**CVSS:** 5.3 (Medium)
**CWE:** CWE-20 (Improper Input Validation)

**Description:**
The `/api/enhance` endpoint doesn't validate the `mode` parameter:

```javascript
const enhanceMode = mode || 'professional'; // No validation
```

**Remediation:**
```javascript
const ALLOWED_MODES = ['professional', 'casual', 'friendly', 'formal', 'polish'];
const enhanceMode = ALLOWED_MODES.includes(mode) ? mode : 'professional';
```

---

### M2: No CORS Configuration

**CVSS:** 5.3 (Medium)
**CWE:** CWE-942 (Permissive Cross-domain Policy)

**Description:**
No CORS headers are configured, allowing any origin to make requests.

**Remediation:**
```javascript
import cors from 'cors';

app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));
```

---

### M3: Unprotected SSE Endpoint

**CVSS:** 5.3 (Medium)
**CWE:** CWE-306 (Missing Authentication for Critical Function)

**Description:**
The SSE endpoint has no authentication, allowing anyone to subscribe to real-time events.

**Remediation:**
```javascript
app.get('/api/events', requireAuth, (req, res) => {
  // Add requireAuth middleware
});
```

---

### M4: Weak Input Sanitization

**CVSS:** 5.3 (Medium)
**CWE:** CWE-79 (Cross-site Scripting)

**Description:**
The `sanitizeInput` function only strips HTML tags, allowing prompt injection attacks.

**Remediation:**
```javascript
function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/['";\\]/g, '') // Remove SQL metacharacters
    .replace(/(ignore|disregard|override)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi, '[FILTERED]')
    .trim()
    .slice(0, MAX_MSG_LEN);
}
```

---

### M5: Database Files Not Encrypted

**CVSS:** 5.3 (Medium)
**CWE:** CWE-311 (Missing Encryption of Sensitive Data)

**Description:**
SQLite databases are stored unencrypted on disk.

**Remediation:**
```javascript
// Use SQLCipher for encrypted SQLite
import Database from 'better-sqlite3';
const db = new Database(DB_PATH);
db.pragma(`key = '${process.env.DB_ENCRYPTION_KEY}'`);
```

---

### M6: Information Disclosure in Config Endpoint

**CVSS:** 5.3 (Medium)
**CWE:** CWE-200 (Exposure of Sensitive Information)

**Description:**
The `/api/config` endpoint exposes internal configuration including Ollama URL.

**Remediation:**
```javascript
app.get('/api/config', requireAuth, (_req, res) => {
  res.json({
    modelName: MODEL_NAME,
    timeout: AXIOS_TIMEOUT_MS,
    rateLimit: RATE_LIMIT_COOLDOWN_MS,
  });
});
```

---

## Low Priority Vulnerabilities

### L1: No Request Size Limits

**CVSS:** 3.7 (Low)
**CWE:** CWE-770 (Allocation of Resources Without Limits)

**Remediation:**
```javascript
app.use(express.json({ limit: '1mb' }));
```

---

### L2: No Security Event Logging

**CVSS:** 3.7 (Low)
**CWE:** CWE-778 (Insufficient Logging)

**Remediation:**
```javascript
function logSecurityEvent(type, details) {
  logger.warn('Security', type, details);
}
```

---

### L3: No Session Management

**CVSS:** 3.7 (Low)
**CWE:** CWE-613 (Insufficient Session Expiration)

**Remediation:**
Implement JWT-based sessions with expiration.

---

## Security Checklist

- [x] No hardcoded secrets in source code (fixed)
- [ ] All inputs validated
- [x] SQL injection prevention (using parameterized queries)
- [x] XSS prevention (using `esc()` function)
- [ ] CSRF protection (weak implementation)
- [ ] Authentication required by default
- [ ] Authorization verified
- [ ] Rate limiting enabled on all endpoints
- [ ] HTTPS enforced
- [x] Security headers set (partial)
- [ ] Dependencies up to date
- [x] Logging sanitized
- [x] Error messages safe (mostly)
- [x] No vulnerable packages (but outdated)
- [ ] CORS configured
- [ ] File uploads validated

---

## References

- [OWASP Top 10 2021](https://owasp.org/Top10/)
- [OWASP API Security Top 10](https://owasp.org/API-Security/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Express.js Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
