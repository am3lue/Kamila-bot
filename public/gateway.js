// Gateway UI: projects grid, project pages (overview, connect, chatbot/OTP,
// API keys, webhooks, settings) and the developer docs.
(() => {
  'use strict';
  const D = window.KamilaDash;
  if (!D) return;
  const { $, $$, esc, toast, route, onSSE } = D;
  const Auth = window.KamilaAuth;
  const BASE = location.origin;
  const timeAgo = (iso) => D.timeAgo(Math.floor(Date.parse(iso) / 1000));

  async function gw(method, path, body, sessionId) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (sessionId) headers['X-Session-Id'] = sessionId;
    const r = await D.authedFetch('/v1' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error(data?.error || `${method} ${path} failed (${r.status})`);
      e.status = r.status;
      throw e;
    }
    return data;
  }

  const STATUS_LABEL = { WORKING: 'Connected', SCAN_QR: 'Waiting for scan', STARTING: 'Starting', STOPPED: 'Stopped', FAILED: 'Failed' };
  const MODE_LABEL = { otp: 'OTP', chatbot: 'AI chatbot', kamila: 'Kamila bot' };
  const EVENTS_BY_MODE = {
    otp: ['otp.sent', 'otp.status', 'otp.verified', 'message.sent', 'session.status'],
    chatbot: ['message.received', 'message.replied', 'message.sent', 'session.status'],
    kamila: ['session.status'],
  };
  const OTP_STATUS_CLS = { VERIFIED: 'gw-WORKING', SENT: 'gw-STARTING', DELIVERED: 'gw-STARTING', READ: 'gw-STARTING', PENDING: 'gw-STOPPED', EXPIRED: 'gw-STOPPED', CANCELLED: 'gw-STOPPED', FAILED: 'gw-FAILED', BLOCKED: 'gw-FAILED' };
  const KB_MAX = 200000;
  const fmt = (n) => Number(n || 0).toLocaleString();
  const maskPhone = (p) => (p && p.length > 6 ? p.slice(0, 4) + '•'.repeat(p.length - 7) + p.slice(-3) : p || '');
  const statusPill = (s) => `<span class="gw-pill gw-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const modeBadge = (m) => `<span class="gw-mode gw-mode-${m}">${MODE_LABEL[m] || m}</span>`;
  const avatar = (s, size = '') => `<span class="gw-avatar gw-avatar-${s.mode} ${size}" aria-hidden="true">${esc((s.name || '?').trim().charAt(0).toUpperCase())}</span>`;

  // Black or white text for a brand colour, whichever has more contrast (WCAG).
  function inkFor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    const n = parseInt(m[1], 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#fff' : '#111';
  }
  const emptyState = (title, text = '', action = '') => `<div class="pp-empty"><div class="pp-empty-title">${title}</div>${text ? `<p class="gw-muted gw-small">${text}</p>` : ''}${action}</div>`;
  const ATTENTION = { SCAN_QR: 'Scan the QR code to connect', STOPPED: 'Stopped · open to start', FAILED: 'Failed to start · open to retry', STARTING: 'Starting WhatsApp…' };
  const ICONS = {
    otp: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    chatbot: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  };

  function copy(text) {
    navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard', 'success'), () => toast('Copy failed', 'error'));
  }
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (err) { toast(err.message, 'error'); } finally { if (btn) btn.disabled = false; }
  }
  // Two-click confirm without browser dialogs.
  function confirmInline(btn, label) {
    if (btn.dataset.armed === '1') { btn.dataset.armed = ''; return true; }
    const orig = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = label;
    setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = orig; } }, 3500);
    return false;
  }

  // ── Modal ──
  function openModal(html, { wide = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'gw-modal-wrap';
    wrap.innerHTML = `<div class="gw-modal-backdrop" data-close></div><div class="gw-modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(wrap);
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $$('[data-close]', wrap).forEach((b) => { b.onclick = close; });
    setTimeout(() => $('input,textarea,button.btn-primary', wrap)?.focus(), 30);
    return { el: wrap, close };
  }

  function revealKeyModal(title, key, note) {
    const m = openModal(`
      <div class="gw-modal-head"><h3>${esc(title)}</h3></div>
      <div class="gw-modal-body">
        <p class="gw-muted">${note || "Copy it now. It's stored hashed and won't be shown again."}</p>
        <div class="gw-keybox"><code>${esc(key)}</code><button class="btn btn-sm" data-copy>Copy</button></div>
      </div>
      <div class="gw-modal-foot"><button class="btn btn-primary" data-close>I've saved it</button></div>`);
    $('[data-copy]', m.el).onclick = () => copy(key);
  }

  // ── Code samples ──
  function samples(kind, { key, extra = {} } = {}) {
    const K = key || 'wsk_your_secret_key';
    if (kind === 'otp-send') return {
      cURL: `curl -X POST ${BASE}/v1/otp/send \\\n  -H "Authorization: Bearer ${K}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"phone": "255712345678"}'`,
      'Node.js': `const res = await fetch("${BASE}/v1/otp/send", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.KAMILA_SECRET_KEY}\`,\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ phone: "255712345678" }),\n});\nconst { id, expires_in } = await res.json();`,
      Python: `import os, requests\n\nres = requests.post(\n    "${BASE}/v1/otp/send",\n    headers={"Authorization": f"Bearer {os.environ['KAMILA_SECRET_KEY']}"},\n    json={"phone": "255712345678"},\n)\notp_id = res.json()["id"]`,
      PHP: `$ch = curl_init("${BASE}/v1/otp/send");\ncurl_setopt_array($ch, [\n  CURLOPT_POST => true,\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => [\n    "Authorization: Bearer " . getenv("KAMILA_SECRET_KEY"),\n    "Content-Type: application/json",\n  ],\n  CURLOPT_POSTFIELDS => json_encode(["phone" => "255712345678"]),\n]);\n$otp = json_decode(curl_exec($ch), true);`,
    };
    if (kind === 'otp-verify') return {
      cURL: `curl -X POST ${BASE}/v1/otp/verify \\\n  -H "Authorization: Bearer ${K}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"id": "otp_3f9c…", "code": "482913"}'`,
      'Node.js': `const res = await fetch("${BASE}/v1/otp/verify", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.KAMILA_SECRET_KEY}\`,\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ id: otpId, code: userInput }),\n});\nconst { valid, reason } = await res.json();`,
      Python: `res = requests.post(\n    "${BASE}/v1/otp/verify",\n    headers={"Authorization": f"Bearer {os.environ['KAMILA_SECRET_KEY']}"},\n    json={"id": otp_id, "code": user_input},\n)\nif res.json()["valid"]:\n    ...  # signed in`,
      PHP: `$ch = curl_init("${BASE}/v1/otp/verify");\ncurl_setopt_array($ch, [\n  CURLOPT_POST => true,\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => [\n    "Authorization: Bearer " . getenv("KAMILA_SECRET_KEY"),\n    "Content-Type: application/json",\n  ],\n  CURLOPT_POSTFIELDS => json_encode(["id" => $otpId, "code" => $userInput]),\n]);\n$valid = json_decode(curl_exec($ch), true)["valid"];`,
    };
    if (kind === 'send') return {
      cURL: `curl -X POST ${BASE}/v1/messages \\\n  -H "Authorization: Bearer ${K}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"phone": "255712345678", "text": "Your order #1042 has shipped 🚚"}'`,
      'Node.js': `const res = await fetch("${BASE}/v1/messages", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.KAMILA_SECRET_KEY}\`,\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ phone: "255712345678", text: "Your order #1042 has shipped" }),\n});\nconst { id, status } = await res.json();`,
      Python: `import os, requests\n\nres = requests.post(\n    "${BASE}/v1/messages",\n    headers={"Authorization": f"Bearer {os.environ['KAMILA_SECRET_KEY']}"},\n    json={"phone": "255712345678", "text": "Your order #1042 has shipped"},\n)\nmessage_id = res.json()["id"]`,
      PHP: `$ch = curl_init("${BASE}/v1/messages");\ncurl_setopt_array($ch, [\n  CURLOPT_POST => true,\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => [\n    "Authorization: Bearer " . getenv("KAMILA_SECRET_KEY"),\n    "Content-Type: application/json",\n  ],\n  CURLOPT_POSTFIELDS => json_encode(["phone" => "255712345678", "text" => "Your order #1042 has shipped"]),\n]);\n$msg = json_decode(curl_exec($ch), true);`,
    };
    if (kind === 'chat') return {
      cURL: `curl -X POST ${BASE}/v1/chat \\\n  -H "Authorization: Bearer ${K}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"message": "What are your opening hours?", "user": "customer-42"}'`,
      'Node.js': `const res = await fetch("${BASE}/v1/chat", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.KAMILA_SECRET_KEY}\`,\n    "Content-Type": "application/json",\n  },\n  // "user" keeps a separate conversation per end user\n  body: JSON.stringify({ message: text, user: userId }),\n});\nconst { reply } = await res.json();`,
      Python: `res = requests.post(\n    "${BASE}/v1/chat",\n    headers={"Authorization": f"Bearer {os.environ['KAMILA_SECRET_KEY']}"},\n    json={"message": text, "user": user_id},\n)\nreply = res.json()["reply"]`,
      PHP: `$ch = curl_init("${BASE}/v1/chat");\ncurl_setopt_array($ch, [\n  CURLOPT_POST => true,\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => [\n    "Authorization: Bearer " . getenv("KAMILA_SECRET_KEY"),\n    "Content-Type: application/json",\n  ],\n  CURLOPT_POSTFIELDS => json_encode(["message" => $text, "user" => $userId]),\n]);\n$reply = json_decode(curl_exec($ch), true)["reply"];`,
    };
    if (kind === 'widget') return {
      HTML: `<!-- Paste before </body> on your website -->\n<script src="${BASE}/widget.js" data-key="${extra.pk || 'wpk_your_publishable_key'}" defer></script>`,
      React: `useEffect(() => {\n  const s = document.createElement("script");\n  s.src = "${BASE}/widget.js";\n  s.dataset.key = "${extra.pk || 'wpk_your_publishable_key'}";\n  s.defer = true;\n  document.body.appendChild(s);\n}, []);`,
    };
    return {};
  }

  // Tabbed code block. Returns HTML; call wireCode(root) after inserting.
  function codeBlock(set, title) {
    const langs = Object.keys(set);
    let pref = langs[0];
    try { const p = localStorage.getItem('kamila_lang'); if (p && langs.includes(p)) pref = p; } catch {}
    return `<div class="gw-codeblock" data-code>
      <div class="gw-codeblock-head">
        ${title ? `<span class="gw-codeblock-title">${esc(title)}</span>` : ''}
        <div class="gw-codeblock-tabs">${langs.map((l) => `<button type="button" data-lang="${esc(l)}" class="${l === pref ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>
        <button type="button" class="gw-codeblock-copy" data-copy aria-label="Copy code">Copy</button>
      </div>
      ${langs.map((l) => `<pre data-pane="${esc(l)}" class="${l === pref ? '' : 'hidden'}"><code>${esc(set[l])}</code></pre>`).join('')}
    </div>`;
  }
  function wireCode(root) {
    $$('[data-code]', root).forEach((block) => {
      $$('[data-lang]', block).forEach((b) => {
        b.onclick = () => {
          $$('[data-code]').forEach((other) => {
            const btn = $(`[data-lang="${CSS.escape(b.dataset.lang)}"]`, other);
            if (!btn) return;
            $$('[data-lang]', other).forEach((x) => x.classList.toggle('active', x === btn));
            $$('[data-pane]', other).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.lang));
          });
          try { localStorage.setItem('kamila_lang', b.dataset.lang); } catch {}
        };
      });
      $('[data-copy]', block).onclick = () => copy($('pre:not(.hidden) code', block).textContent);
    });
  }

  // ── Sparkline (inline SVG, one series) ──
  function sparkline(values, label) {
    const w = 240, h = 44, pad = 3;
    const max = Math.max(1, ...values);
    const pts = values.map((v, i) => [pad + (i * (w - pad * 2)) / Math.max(1, values.length - 1), h - pad - (v / max) * (h - pad * 2)]);
    const line = pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
    const area = `M${pts[0][0]},${h} L${pts.map((p) => p.join(',')).join(' L')} L${pts[pts.length - 1][0]},${h} Z`;
    const total = values.reduce((a, b) => a + b, 0);
    return `<svg class="gw-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: ${fmt(total)} in the last ${values.length} days">
      <title>${esc(label)}: ${fmt(total)} in the last ${values.length} days</title>
      <path d="${area}" class="gw-spark-area"/><polyline points="${line}" class="gw-spark-line"/></svg>`;
  }

  // ══════════════════════════════════
  // Projects grid
  // ══════════════════════════════════
  let projects = [];
  let page = null; // current project page: { id, tab, root, testHistory, reload, chart }

  async function renderProjects() {
    page = null;
    const mount = $('#view-mount');
    mount.innerHTML = `
      <header class="pg-head">
        <div><h1 class="pg-title">Projects</h1><p class="pg-sub">WhatsApp numbers that send messages and OTP codes, or answer customers with AI.</p></div>
      </header>
      <div class="pj-summary" id="pj-summary" aria-label="Today across all projects"></div>
      <div class="gw-toolbar">
        <div class="gw-search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input class="input" id="pj-search" placeholder="Search projects…" autocomplete="off"></div>
        <div class="gw-seg" id="pj-filter" role="radiogroup" aria-label="Filter by type">
          <button type="button" data-f="all" aria-checked="true">All <span class="gw-seg-n" data-n="all"></span></button><button type="button" data-f="otp" aria-checked="false">OTP <span class="gw-seg-n" data-n="otp"></span></button><button type="button" data-f="chatbot" aria-checked="false">AI chatbot <span class="gw-seg-n" data-n="chatbot"></span></button>
        </div>
        <span class="gw-grow"></span>
        <span class="gw-muted gw-small" id="pj-quota"></span>
        <button class="btn btn-primary" id="pj-new">Add new…</button>
      </div>
      <div id="pj-grid" class="pj-grid"><div class="pj-skeleton"></div><div class="pj-skeleton"></div><div class="pj-skeleton"></div></div>`;

    let filter = 'all';
    let spark = {};
    const draw = () => {
      if (!$('#pj-grid')) return;
      const q = $('#pj-search').value.trim().toLowerCase();
      const list = projects.filter((p) => (filter === 'all' || p.mode === filter) && (!q || p.name.toLowerCase().includes(q) || (p.phone || '').includes(q) || p.id.includes(q)));
      const own = projects.filter((x) => !x.system).length;
      $('#pj-quota').textContent = `${own} of ${Auth.limits.sessions} projects`;
      const grid = $('#pj-grid');
      $$('#pj-filter [data-n]').forEach((el) => { el.textContent = el.dataset.n === 'all' ? projects.length : projects.filter((x) => x.mode === el.dataset.n).length; });
      const sum = $('#pj-summary');
      if (sum) {
        const live = projects.filter((x) => x.status === 'WORKING').length;
        const attn = projects.length - live;
        const total = (k) => projects.reduce((a, x) => a + (x[k] || 0), 0);
        sum.innerHTML = projects.length ? `
          <div class="pj-sum"><div class="stat-label">Connected</div><div class="pj-sum-v">${live}<span> / ${projects.length}</span></div></div>
          <div class="pj-sum"><div class="stat-label">Codes sent today</div><div class="pj-sum-v">${fmt(total('sentToday'))}</div></div>
          <div class="pj-sum"><div class="stat-label">Messages today</div><div class="pj-sum-v">${fmt(total('receivedToday') + total('repliedToday'))}</div></div>
          <div class="pj-sum${attn ? ' warn' : ''}"><div class="stat-label">Need attention</div><div class="pj-sum-v">${attn}</div></div>` : '';
      }
      if (!projects.length) {
        grid.innerHTML = `<div class="pj-empty card"><div class="pj-empty-icon">＋</div><h3>Create your first project</h3>
          <p class="gw-muted">Link a WhatsApp number, then send OTP codes and messages from your app, or let an AI chatbot answer your customers.</p>
          <button class="btn btn-primary" data-new>Add new project</button></div>`;
        $('[data-new]', grid).onclick = newProjectModal;
        return;
      }
      if (!list.length) { grid.innerHTML = `<div class="pj-none">${emptyState('No projects match', 'Try a different search or filter.')}</div>`; return; }
      grid.innerHTML = list.map((p) => {
        const series = spark[p.id] || [];
        const values = series.map((d) => (p.mode === 'chatbot' ? d.messages : d.otp));
        const metric = p.mode === 'chatbot' ? `${fmt(p.receivedToday)} messages today` : `${fmt(p.sentToday)} codes today`;
        return `<a class="pj-card card" href="#/projects/${encodeURIComponent(p.id)}" data-id="${esc(p.id)}">
          <div class="pj-card-top">${avatar(p)}<div class="gw-grow pj-card-id"><div class="pj-card-name">${esc(p.name)}</div>
            <div class="pj-card-sub">${p.phone ? '+' + esc(p.phone) : 'Not linked'}</div></div>
            <span class="pj-dot gw-${p.status}" role="img" aria-label="${esc(STATUS_LABEL[p.status] || p.status)}" title="${esc(STATUS_LABEL[p.status] || p.status)}"></span></div>
          <div class="pj-card-chart">${values.length ? sparkline(values, p.mode === 'chatbot' ? 'Messages' : 'Codes sent') : ''}</div>
          <div class="pj-card-foot">${modeBadge(p.mode)}${p.status !== 'WORKING' && ATTENTION[p.status] ? `<span class="pj-attn gw-${p.status}">${ATTENTION[p.status]}</span>` : `<span class="gw-muted">${metric}</span>`}</div>
        </a>`;
      }).join('');
    };

    try {
      [projects, spark] = await Promise.all([gw('GET', '/sessions'), gw('GET', '/stats/overview?days=14').catch(() => ({}))]);
    } catch (err) {
      $('#pj-grid').innerHTML = `<div class="card gw-error">${esc(err.message)}</div>`;
      return;
    }
    draw();
    $('#pj-search').oninput = draw;
    $$('#pj-filter [data-f]').forEach((b) => {
      b.onclick = () => {
        filter = b.dataset.f;
        $$('#pj-filter [data-f]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        draw();
      };
    });
    $('#pj-new').onclick = newProjectModal;
    redrawProjects = draw;
  }
  let redrawProjects = () => {};

  function newProjectModal() {
    const m = openModal(`
      <form data-f="form">
        <div class="gw-modal-head"><h3>New project</h3><p class="gw-muted gw-small">A project is one WhatsApp number. Next you'll scan a QR code with the phone for that number.</p></div>
        <div class="gw-modal-body">
          <label class="gw-field">Project name<input class="input" name="name" maxlength="60" required placeholder="e.g. Duka Online"></label>
          <div class="gw-field-label">What should this number do?</div>
          <div class="gw-choice">
            <label class="gw-choice-card"><input type="radio" name="mode" value="otp" checked>
              <span class="gw-choice-title">${ICONS.otp} OTP codes</span>
              <span class="gw-choice-desc">Your app sends verification codes through the API. Incoming messages get no reply.</span></label>
            <label class="gw-choice-card"><input type="radio" name="mode" value="chatbot">
              <span class="gw-choice-title">${ICONS.chatbot} AI chatbot</span>
              <span class="gw-choice-desc">Answers on WhatsApp, your website widget and the Chat API, using your knowledge base.</span></label>
          </div>
          <p class="gw-muted gw-small">Both types can also send messages through the Messages API. You can change the type later in Settings.</p>
        </div>
        <div class="gw-modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Create project</button></div>
      </form>`);
    $('[data-f=form]', m.el).onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      busy($('button[type=submit]', f), async () => {
        const created = await gw('POST', '/sessions', { name: f.name.value.trim(), mode: f.mode.value, auto_start: true });
        m.close();
        projects.push(created);
        location.hash = `#/projects/${encodeURIComponent(created.id)}/connect`;
        if (created.apiKey) setTimeout(() => revealKeyModal('Your secret key', created.apiKey, 'Use this server-side key for the Messages, OTP and Chat APIs. Copy it now. It\'s stored hashed and won\'t be shown again.'), 300);
      });
    };
  }

  // ══════════════════════════════════
  // Project page
  // ══════════════════════════════════
  function tabsFor(s) {
    const t = [['overview', 'Overview'], ['connect', 'WhatsApp']];
    if (s.mode === 'chatbot') t.push(['bot', 'Bot'], ['knowledge', 'Knowledge'], ['answer', 'Your API'], ['test', 'Playground'], ['conversations', 'Conversations']);
    if (s.mode === 'otp') t.push(['message', 'Message'], ['activity', 'Activity']);
    if (s.mode === 'kamila') t.push(['activity', 'Activity']);
    t.push(['keys', 'API keys'], ['webhooks', 'Webhooks'], ['settings', 'Settings']);
    return t;
  }

  async function renderProject(rest) {
    const [id, wanted] = rest.split('/');
    const mount = $('#view-mount');
    let s;
    if (page?.id !== id) mount.innerHTML = '<div class="pg-loading"><div class="pj-skeleton" style="height:120px"></div><div class="pj-skeleton" style="height:320px"></div></div>';
    try { s = await gw('GET', `/sessions/${encodeURIComponent(id)}`); } catch (err) {
      mount.innerHTML = `<div class="card gw-error">${err.status === 404 ? 'Project not found.' : esc(err.message)}</div>`;
      return;
    }
    const idx = projects.findIndex((p) => p.id === s.id);
    if (idx >= 0) projects[idx] = s; else projects.push(s);
    const tabs = tabsFor(s);
    const tab = tabs.some(([k]) => k === wanted) ? wanted : 'overview';
    const keepHistory = page?.id === id ? page.testHistory : [];
    page?.chart?.destroy();
    page = { id, tab, testHistory: keepHistory, reload: null, chart: null };

    mount.innerHTML = `
      <nav class="pg-crumbs" aria-label="Breadcrumb"><a href="#/projects">Projects</a><span>/</span><span>${esc(s.name)}</span></nav>
      <header class="pp-head">
        ${avatar(s, 'lg')}
        <div class="gw-grow">
          <div class="pp-title-row"><h1 class="pg-title" data-f="title">${esc(s.name)}</h1>${modeBadge(s.mode)}<span data-f="status">${statusPill(s)}</span></div>
          <div class="pg-sub"><span data-f="identity">${s.phone ? '+' + esc(s.phone) + (s.pushName ? ' · ' + esc(s.pushName) : '') : 'No WhatsApp number linked'}</span> · <button type="button" class="pp-id" data-f="copy-id" title="Copy project ID" aria-label="Copy project ID ${esc(s.id)}">${esc(s.id)}</button></div>
        </div>
        <div class="pp-actions" data-f="actions"></div>
      </header>
      <nav class="pp-tabs" aria-label="Project">${tabs.map(([k, l]) => `<a href="#/projects/${encodeURIComponent(id)}/${k}" data-tab="${k}" class="${k === tab ? 'active' : ''}"${k === tab ? ' aria-current="page"' : ''}>${l}${k === 'connect' ? '<span class="pp-tab-dot" title="Not connected"></span>' : ''}</a>`).join('')}</nav>
      <div class="pp-body" data-f="body"></div>`;
    page.root = $('[data-f=body]', mount);
    $('[data-f=copy-id]', mount).onclick = () => copy(s.id);
    markTabs(s);
    drawActions(s);
    await renderTab(s, tab);
  }

  // Flags the WhatsApp tab while the number isn't connected.
  function markTabs(s) {
    $('.pp-tabs [data-tab=connect]')?.classList.toggle('needs', s.status !== 'WORKING');
  }

  function drawActions(s) {
    const el = $('[data-f=actions]');
    if (!el) return;
    const b = (act, label, cls = '') => `<button class="btn btn-sm ${cls}" data-act="${act}">${label}</button>`;
    el.innerHTML = s.status === 'STOPPED' || s.status === 'FAILED'
      ? b('start', 'Start', 'btn-primary')
      : `${b('restart', 'Restart')}${b('stop', 'Stop')}`;
    $$('[data-act]', el).forEach((btn) => {
      btn.onclick = () => busy(btn, async () => { refreshHeader(await gw('POST', `/sessions/${s.id}/${btn.dataset.act}`)); });
    });
  }

  function refreshHeader(s) {
    const i = projects.findIndex((p) => p.id === s.id);
    if (i >= 0) projects[i] = { ...projects[i], ...s };
    if (page?.id !== s.id) return;
    const full = projects[i] || s;
    const st = $('[data-f=status]');
    if (st) st.innerHTML = statusPill(full);
    const idn = $('[data-f=identity]');
    if (idn && 'phone' in s) idn.textContent = full.phone ? `+${full.phone}${full.pushName ? ' · ' + full.pushName : ''}` : 'No WhatsApp number linked';
    markTabs(full);
    drawActions(full);
    if (page.tab === 'connect' || page.tab === 'overview') page.reloadConn?.();
  }

  const current = () => projects.find((p) => p.id === page?.id);

  async function save(patch, msg) {
    const info = await gw('PATCH', `/sessions/${page.id}`, patch);
    refreshHeader(info);
    toast(msg || 'Saved', 'success');
    return info;
  }

  // Connection card / QR (used by Overview and the WhatsApp tab)
  function connectionHtml(s, big) {
    if (s.status === 'WORKING') {
      return `<div class="pp-conn ok"><div class="pp-conn-icon">✓</div><div><div class="pp-conn-title">Connected</div>
        <div class="gw-muted gw-small">+${esc(s.phone || '')}${s.pushName ? ' · ' + esc(s.pushName) : ''}</div></div></div>
        ${big ? '<div class="gw-row" style="margin-top:16px"><button class="btn btn-sm" data-act="logout">Unlink this number</button></div>' : ''}`;
    }
    if (s.status === 'SCAN_QR') {
      return `<div class="pp-qr-wrap"><div class="gw-qr" data-f="qr"><div class="gw-small" style="color:#525252">Loading QR…</div></div>
        <ol class="gw-steps gw-small"><li>Open WhatsApp on the phone for this number</li><li>Tap <strong>Settings → Linked devices → Link a device</strong></li><li>Point the phone at this code. It refreshes every ~20 seconds.</li></ol></div>`;
    }
    if (s.status === 'STARTING') return '<div class="pp-conn"><div class="pp-conn-icon spin">◌</div><div><div class="pp-conn-title">Starting WhatsApp…</div><div class="gw-muted gw-small">The QR code appears in a few seconds.</div></div></div>';
    return `<div class="pp-conn"><div class="pp-conn-icon">!</div><div><div class="pp-conn-title">${s.status === 'FAILED' ? 'Failed to start' : 'Stopped'}</div>
      <div class="gw-muted gw-small">${esc(s.error || 'Start the project to link a WhatsApp number.')}</div></div></div>
      <div class="gw-row" style="margin-top:14px"><button class="btn btn-primary btn-sm" data-act="start">Start and show QR</button></div>`;
  }
  function wireConnection(box, s) {
    $$('[data-act]', box).forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.act === 'logout' && !confirmInline(btn, 'Click again to unlink')) return;
        busy(btn, async () => { refreshHeader(await gw('POST', `/sessions/${s.id}/${btn.dataset.act}`)); });
      };
    });
    const qr = $('[data-f=qr]', box);
    if (qr) gw('GET', `/sessions/${s.id}/qr`).then((r) => { qr.innerHTML = `<img src="${r.image}" alt="WhatsApp QR code" width="240" height="240">`; }).catch(() => { qr.innerHTML = '<div class="gw-small" style="color:#525252">Waiting for a new code…</div>'; });
  }

  // ── WhatsApp profile: the name and photo recipients see ──
  const PROFILE_NAME_MAX = 25;
  function senderPreview(s, prof, name, text) {
    const shown = name || prof?.name || '';
    const pic = prof?.picture
      ? `<img class="wa-pic" src="${esc(prof.picture)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="wa-pic wa-pic-empty">${esc((shown || s.name || '?').trim().charAt(0).toUpperCase())}</span>`;
    const sample = text != null ? text : s.mode === 'chatbot' ? 'Hi! How can we help you today?' : (s.otpTemplate || '').replace(/\{code\}/g, '482913').replace(/\{brand\}/g, s.name).replace(/\{minutes\}/g, '5');
    return `<div class="wa-phone" aria-label="Preview of what recipients see">
      <div class="wa-head">${pic}<div class="wa-who"><div class="wa-num">${prof?.phone || s.phone ? '+' + esc(prof?.phone || s.phone) : 'Your WhatsApp number'}</div>${shown ? `<div class="wa-name">~ ${esc(shown)}</div>` : ''}</div></div>
      <div class="wa-body"><div class="msg-bubble msg-ai">${esc(sample).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>').replace(/_([^_\n]+)_/g, '<em>$1</em>').replace(/\n/g, '<br>')}</div></div>
    </div>`;
  }

  // Square-crops and shrinks an image to a 640px JPEG data URL.
  function imageToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const size = Math.min(640, side);
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image')); };
      img.src = url;
    });
  }

  async function renderProfile(box, s) {
    if (!box?.isConnected) return;
    const head = '<div class="pp-panel-head"><h2>How people see this number</h2></div>';
    if (s.status !== 'WORKING') {
      box.innerHTML = `${head}<p class="gw-muted gw-small">Connect the number to set the business name and logo that people see when you send them codes and messages.</p>`;
      return;
    }
    box.innerHTML = `${head}<div class="pj-skeleton" style="height:140px"></div>`;
    let prof;
    try { prof = await gw('GET', `/sessions/${s.id}/profile`); } catch (err) { box.innerHTML = `${head}<p class="gw-muted gw-small">${esc(err.message)}</p>`; return; }
    if (!box.isConnected) return;
    const biz = prof.businessApp;
    box.innerHTML = `${head}
      <p class="gw-muted gw-small">Codes and messages come from this WhatsApp number. Give it your business name and logo so people recognise you, like the OTP messages they get from other companies.</p>
      <div class="wa-profile">
        <div data-f="pv">${senderPreview(s, prof)}</div>
        <div class="wa-form">
          <label class="gw-field">Business name<input class="input" data-f="pname" maxlength="${PROFILE_NAME_MAX}" value="${esc(prof.name || s.name || '')}" ${biz ? 'disabled' : ''}></label>
          ${biz ? '<p class="gw-muted gw-small">This is a WhatsApp Business app number. Change its name in the app: <strong>Settings → Business tools → Business profile</strong>.</p>' : `<div class="gw-row"><button class="btn btn-primary btn-sm" data-f="psave">Save name</button><button class="btn btn-sm" data-f="puse">Use project name</button></div>`}
          <div class="gw-field"><span>Logo</span>
            <div class="gw-row"><label class="btn btn-sm wa-file">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" data-f="pfile" hidden></label>${prof.picture ? '<button class="btn btn-sm" data-f="pdel">Remove</button>' : ''}</div>
            <span class="gw-muted gw-small">Square images work best. Shown as a circle.</span>
          </div>
        </div>
      </div>
      <p class="gw-muted gw-small pp-note">People who haven't saved your number see it with your name beside it (<em>~ ${esc(prof.name || 'Name')}</em>). Using a <strong>WhatsApp Business</strong> app number adds a “Business account” label. A verified green tick and a “Copy code” button need Meta's official WhatsApp Business Platform.</p>`;
    const nameIn = $('[data-f=pname]', box);
    const pv = $('[data-f=pv]', box);
    nameIn.oninput = () => { pv.innerHTML = senderPreview(s, prof, nameIn.value.trim()); };
    const saveName = (btn, name) => busy(btn, async () => {
      const r = await gw('POST', `/sessions/${s.id}/profile`, { name });
      prof.name = r.name;
      nameIn.value = r.name;
      pv.innerHTML = senderPreview(s, prof);
      toast('WhatsApp name updated', 'success');
    });
    const ps = $('[data-f=psave]', box);
    if (ps) ps.onclick = () => saveName(ps, nameIn.value.trim());
    const pu = $('[data-f=puse]', box);
    if (pu) pu.onclick = () => saveName(pu, s.name.slice(0, PROFILE_NAME_MAX));
    const file = $('[data-f=pfile]', box);
    file.onchange = () => {
      const f = file.files?.[0];
      if (!f) return;
      busy(file.closest('label'), async () => {
        const picture = await imageToDataUrl(f);
        await gw('POST', `/sessions/${s.id}/profile`, { picture });
        toast('Logo updated. It can take a minute to show on phones.', 'success');
        renderProfile(box, s);
      });
    };
    const del = $('[data-f=pdel]', box);
    if (del) del.onclick = () => {
      if (!confirmInline(del, 'Click again to remove')) return;
      busy(del, async () => { await gw('POST', `/sessions/${s.id}/profile`, { picture: null }); toast('Logo removed', 'success'); renderProfile(box, s); });
    };
  }

  // ── Setup checklist (Overview) ──
  async function renderSetup(box, s) {
    if (!box || s.mode === 'kamila') return;
    const hideKey = `kamila_setup_hidden_${s.id}`;
    try { if (localStorage.getItem(hideKey)) return; } catch {}
    const chat = s.mode === 'chatbot';
    let active = false;
    try {
      const rows = chat ? await gw('GET', `/sessions/${s.id}/messages?limit=1`) : await gw('GET', '/otp?limit=1', undefined, s.id);
      active = rows.length > 0;
    } catch {}
    if (!box.isConnected) return;
    const base = `#/projects/${encodeURIComponent(s.id)}`;
    const link = { done: s.status === 'WORKING' || !!s.phone, title: 'Link a WhatsApp number', text: 'Scan a QR code with the phone for this number.', href: `${base}/connect`, cta: 'Link number' };
    const steps = chat ? [
      link,
      { done: !!(s.chatbot.instructionsChars || s.chatbot.knowledgeChars || s.chatbot.answerUrl), title: 'Teach the bot about your business', text: 'Add instructions and a knowledge base: products, prices, hours, delivery, FAQs.', href: `${base}/knowledge`, cta: 'Add knowledge' },
      { done: !!s.publishableKey && (s.allowedOrigins || []).length > 0, title: 'Add the chat to your website', text: 'Optional. A chat bubble answered by the same bot.', href: `${base}/keys`, cta: 'Set up widget' },
      { done: active, title: 'Get your first conversation', text: 'Message the number on WhatsApp, or try the Playground first.', href: `${base}/test`, cta: 'Open Playground' },
    ] : [
      link,
      { done: !!s.pushName && s.pushName.trim().toLowerCase() === s.name.trim().toLowerCase(), title: 'Show your business name', text: 'Set the name and logo people see when your codes arrive.', href: `${base}/connect`, cta: 'Brand number' },
      { done: active, title: 'Send your first code', text: 'Call the OTP API from your backend with your secret key.', href: `${base}/keys`, cta: 'See the code' },
    ];
    const n = steps.filter((x) => x.done).length;
    if (n === steps.length) return;
    box.innerHTML = `
      <div class="pp-panel-head"><div><h2>Get started</h2><p class="gw-muted gw-small">${n} of ${steps.length} done</p></div><button class="btn btn-sm" data-f="hide">Hide</button></div>
      <div class="pp-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${n}" aria-label="Setup progress"><span style="width:${Math.round((n / steps.length) * 100)}%"></span></div>
      <ol class="pp-steps">${steps.map((x, i) => `<li class="${x.done ? 'done' : ''}">
        <span class="pp-step-mark" aria-hidden="true">${x.done ? '✓' : i + 1}</span>
        <div class="gw-grow"><div class="pp-step-title">${x.title}${x.done ? '<span class="sr-only"> (done)</span>' : ''}</div><div class="gw-muted gw-small">${x.text}</div></div>
        ${x.done ? '' : `<a class="btn btn-sm" href="${x.href}">${x.cta}</a>`}</li>`).join('')}</ol>`;
    box.classList.remove('hidden');
    $('[data-f=hide]', box).onclick = () => { try { localStorage.setItem(hideKey, '1'); } catch {} box.remove(); };
  }

  // ── Chart (Chart.js) ──
  const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function drawChart(canvas, labels, seriesDefs) {
    const surface = tok('--bg-card');
    const crosshair = {
      id: 'crosshair',
      afterDatasetsDraw(chart) {
        const a = chart.tooltip?.getActiveElements?.();
        if (!a?.length) return;
        const x = a[0].element.x;
        const { top, bottom } = chart.chartArea;
        const ctx = chart.ctx;
        ctx.save(); ctx.strokeStyle = tok('--border-strong'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
      },
    };
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: seriesDefs.map((d, i) => ({
          label: d.label, data: d.data,
          borderColor: tok(`--series-${i + 1}`), backgroundColor: tok(`--series-${i + 1}`),
          borderWidth: 2, tension: 0.3, pointRadius: 0, pointHoverRadius: 5,
          pointHoverBorderWidth: 2, pointHoverBorderColor: surface, fill: false,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 18, color: tok('--text-dim'), font: { family: tok('--font'), size: 12 } } },
          tooltip: {
            backgroundColor: tok('--bg-card'), borderColor: tok('--border'), borderWidth: 1, titleColor: tok('--text'), bodyColor: tok('--text-dim'),
            padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true, titleFont: { family: tok('--font'), weight: '600' }, bodyFont: { family: tok('--font') },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { color: tok('--border') }, ticks: { color: tok('--text-muted'), maxRotation: 0, autoSkipPadding: 16, font: { family: tok('--font'), size: 11 } } },
          y: { beginAtZero: true, grid: { color: tok('--border') }, border: { display: false }, ticks: { color: tok('--text-muted'), precision: 0, maxTicksLimit: 5, font: { family: tok('--font'), size: 11 } } },
        },
      },
      plugins: [crosshair],
    });
  }

  function statTile(label, value, prev, { isRate = false } = {}) {
    let delta = '';
    if (prev !== null && prev !== undefined && value !== null) {
      if (isRate) {
        const d = Math.round(value - prev);
        delta = d === 0 ? 'No change' : `${d > 0 ? '↑' : '↓'} ${Math.abs(d)} pts`;
      } else if (prev === 0) {
        delta = value > 0 ? 'New this period' : 'No change';
      } else {
        const d = Math.round(((value - prev) / prev) * 100);
        delta = d === 0 ? 'No change' : `${d > 0 ? '↑' : '↓'} ${Math.abs(d)}%`;
      }
    }
    return `<div class="pp-stat"><div class="stat-label">${esc(label)}</div><div class="pp-stat-value">${isRate ? (value === null ? '—' : Math.round(value) + '%') : fmt(value)}</div>
      ${delta ? `<div class="pp-stat-delta">${delta} <span>vs previous period</span></div>` : '<div class="pp-stat-delta">&nbsp;</div>'}</div>`;
  }

  // ── Tabs ──
  async function renderTab(s, tab) {
    const body = page.root;
    const id = s.id;

    if (tab === 'overview') {
      const chat = s.mode === 'chatbot';
      body.innerHTML = `
        <div class="pp-grid">
          <section class="card pp-panel pp-span2 pp-setup hidden" data-f="setup"></section>
          <section class="card pp-panel pp-span2">
            <div class="pp-panel-head"><h2>Activity</h2>
              <div class="gw-seg gw-seg-sm" data-f="range" role="radiogroup" aria-label="Range">
                ${[7, 14, 30].map((d) => `<button type="button" data-d="${d}" aria-checked="${d === 14}">${d}d</button>`).join('')}
              </div></div>
            <div class="pp-stats" data-f="stats"><div class="pj-skeleton" style="height:84px"></div></div>
            <div class="pp-chart"><canvas data-f="chart" aria-label="${chat ? 'Messages received and replies per day' : 'Codes sent and verified per day'}"></canvas></div>
            <details class="pp-table"><summary>View as table</summary><div data-f="table"></div></details>
          </section>
          <section class="card pp-panel"><div class="pp-panel-head"><h2>WhatsApp</h2><a class="gw-link" href="#/projects/${encodeURIComponent(id)}/connect">Manage</a></div><div data-f="conn"></div></section>
          <section class="card pp-panel"><div class="pp-panel-head"><h2>Quickstart</h2><a class="gw-link" href="#/projects/${encodeURIComponent(id)}/keys">API keys</a></div>
            <p class="gw-muted gw-small">${chat ? 'Ask the bot from your backend, or add the chat widget to your website.' : 'Send a code from your backend, then verify what the user types.'}</p>
            ${codeBlock(samples(chat ? 'chat' : 'otp-send'))}
          </section>
          <section class="card pp-panel pp-span2"><div class="pp-panel-head"><h2>Recent ${chat ? 'messages' : 'codes'}</h2><a class="gw-link" href="#/projects/${encodeURIComponent(id)}/${chat ? 'conversations' : 'activity'}">View all</a></div><div data-f="recent" class="gw-muted gw-small">Loading…</div></section>
        </div>`;
      wireCode(body);
      renderSetup($('[data-f=setup]', body), s);
      const connBox = $('[data-f=conn]', body);
      page.reloadConn = () => { const cur = current(); if (cur && connBox.isConnected) { connBox.innerHTML = connectionHtml(cur, false); wireConnection(connBox, cur); } };
      page.reloadConn();

      const myPage = page;
      const loadStats = async (days) => {
        let st;
        try { st = await gw('GET', `/sessions/${id}/stats?days=${days}`); } catch (err) { $('[data-f=stats]', body).innerHTML = `<div class="gw-error">${esc(err.message)}</div>`; return; }
        if (page !== myPage || page.tab !== 'overview') return;
        const t = st.totals, p = st.previous;
        const rate = (a, b) => (b ? (a / b) * 100 : null);
        $('[data-f=stats]', body).innerHTML = chat
          ? statTile('Messages received', t.msg_in, p.msg_in) + statTile('Replies sent', t.msg_out, p.msg_out) + statTile('Reply rate', rate(t.msg_out, t.msg_in), rate(p.msg_out, p.msg_in), { isRate: true })
          : statTile('Codes sent', t.otp_sent, p.otp_sent) + statTile('Verified', t.otp_verified, p.otp_verified) + statTile('Verification rate', rate(t.otp_verified, t.otp_sent), rate(p.otp_verified, p.otp_sent), { isRate: true });
        const labels = st.series.map((d) => new Date(d.day + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }));
        const defs = chat
          ? [{ label: 'Received', data: st.series.map((d) => d.msg_in) }, { label: 'Replied', data: st.series.map((d) => d.msg_out) }]
          : [{ label: 'Sent', data: st.series.map((d) => d.otp_sent) }, { label: 'Verified', data: st.series.map((d) => d.otp_verified) }];
        page.chart?.destroy();
        if (window.Chart) page.chart = drawChart($('[data-f=chart]', body), labels, defs);
        $('[data-f=table]', body).innerHTML = `<table class="eval-table"><thead><tr><th>Day</th>${defs.map((d) => `<th>${d.label}</th>`).join('')}</tr></thead><tbody>${
          st.series.map((d, i) => `<tr><td>${labels[i]}</td>${defs.map((x) => `<td>${fmt(x.data[i])}</td>`).join('')}</tr>`).reverse().join('')}</tbody></table>`;
      };
      let range = 14;
      $$('[data-f=range] [data-d]', body).forEach((b) => {
        b.onclick = () => { range = Number(b.dataset.d); $$('[data-f=range] [data-d]', body).forEach((x) => x.setAttribute('aria-checked', String(x === b))); loadStats(range); };
      });
      const loadRecent = async () => {
        const box = $('[data-f=recent]', body);
        try {
          if (chat) {
            const rows = await gw('GET', `/sessions/${id}/messages?limit=8`);
            box.innerHTML = rows.length ? `<ul class="pp-feed">${rows.map((m) => `<li><span class="pp-feed-who">${m.role === 'user' ? esc(chatLabel(m.chat_id)) : 'Bot'}</span><span class="pp-feed-text">${esc(m.text.slice(0, 140))}</span><span class="gw-muted">${timeAgo(m.created_at)}</span></li>`).join('')}</ul>` : emptyState('No messages yet', 'Messages from WhatsApp, the website widget and the Chat API show up here.');
          } else {
            const rows = await gw('GET', '/otp?limit=8', undefined, id);
            box.innerHTML = rows.length ? `<ul class="pp-feed">${rows.map((o) => `<li><span class="pp-feed-who">+${esc(maskPhone(o.phone))}</span><span class="pp-feed-text"><span class="gw-pill ${OTP_STATUS_CLS[o.status] || ''}">${esc(o.status)}</span></span><span class="gw-muted">${timeAgo(o.created_at)}</span></li>`).join('')}</ul>` : emptyState('No codes sent yet', 'Codes you send through the OTP API show up here with their delivery status.');
          }
        } catch (err) { box.textContent = err.message; }
      };
      page.reload = () => { loadStats(range); loadRecent(); };
      page.reload();
      return;
    }

    if (tab === 'connect') {
      body.innerHTML = `<section class="card pp-panel pp-narrow"><div class="pp-panel-head"><h2>WhatsApp connection</h2></div><div data-f="conn"></div>
        <p class="gw-muted gw-small pp-note">Use a number that stays online. Kamila runs WhatsApp Web for it, like WhatsApp on a computer. Sending spam or bulk messages can get a number banned.</p></section>
        <section class="card pp-panel pp-narrow" data-f="profile"></section>`;
      const box = $('[data-f=conn]', body);
      const prof = $('[data-f=profile]', body);
      let lastStatus = null;
      page.reloadConn = () => {
        const cur = current();
        if (!cur || !box.isConnected) return;
        box.innerHTML = connectionHtml(cur, true);
        wireConnection(box, cur);
        if (cur.status !== lastStatus) { lastStatus = cur.status; renderProfile(prof, cur); }
      };
      page.reloadConn();
      return;
    }

    if (tab === 'message') {
      const VARS = [['{code}', 'Code'], ['{brand}', 'Business name'], ['{minutes}', 'Minutes left']];
      body.innerHTML = `
        <section class="card pp-panel">
          <div class="pp-panel-head"><h2>OTP message</h2></div>
          <p class="gw-muted gw-small">The text sent with every code. Click a value to insert it. WhatsApp formatting like <code>*bold*</code> and <code>_italic_</code> works.</p>
          <div class="pp-tpl">
            <div class="pp-tpl-edit">
              <div class="gw-row pp-chips">${VARS.map(([v, l]) => `<button type="button" class="pp-chip" data-var="${v}"><code>${v}</code> ${l}</button>`).join('')}</div>
              <textarea class="input" data-f="tpl" rows="6" maxlength="500" aria-describedby="tpl-help">${esc(s.otpTemplate)}</textarea>
              <div class="gw-row gw-small" id="tpl-help"><span class="gw-error" data-f="tpl-err" role="alert"></span><span class="gw-grow"></span><span class="gw-muted" data-f="tpl-n"></span></div>
            </div>
            <div><div class="gw-label">What people see</div><div data-f="tpl-preview"></div></div>
          </div>
          <p class="gw-muted gw-small pp-note">To show your business name and logo instead of a bare number, set them on the <a class="gw-link" href="#/projects/${encodeURIComponent(s.id)}/connect">WhatsApp</a> tab.</p>
          <div class="pp-foot"><button class="btn btn-sm" data-f="reset">Reset to default</button><button class="btn btn-primary btn-sm" data-f="save">Save</button></div>
        </section>`;
      const ta = $('[data-f=tpl]', body);
      const saveBtn = $('[data-f=save]', body);
      let prof = { name: s.pushName, phone: s.phone, picture: null };
      const preview = () => {
        const v = ta.value;
        const bad = [...v.matchAll(/\{([^{}]*)\}/g)].map((m) => m[0]).filter((x) => !VARS.some(([k]) => k === x));
        const err = !v.trim() ? 'The message cannot be empty.' : !v.includes('{code}') ? 'Add {code} so the code is in the message.' : bad.length ? `Unknown value ${bad[0]}. Use {code}, {brand} or {minutes}.` : '';
        $('[data-f=tpl-err]', body).textContent = err;
        $('[data-f=tpl-n]', body).textContent = `${v.length} / 500`;
        saveBtn.disabled = !!err;
        const t = v.replace(/\{code\}/g, '482913').replace(/\{brand\}/g, s.name).replace(/\{minutes\}/g, '5');
        $('[data-f=tpl-preview]', body).innerHTML = senderPreview(s, prof, null, t);
      };
      ta.oninput = preview; preview();
      if (s.status === 'WORKING') gw('GET', `/sessions/${s.id}/profile`).then((r) => { prof = r; if (ta.isConnected) preview(); }).catch(() => {});
      $$('[data-var]', body).forEach((b) => {
        b.onclick = () => {
          const st = ta.selectionStart ?? ta.value.length;
          ta.setRangeText(b.dataset.var, st, ta.selectionEnd ?? st, 'end');
          ta.focus();
          preview();
        };
      });
      saveBtn.onclick = (e) => busy(e.target, () => save({ otp_template: ta.value.trim() || null }, 'Message saved'));
      $('[data-f=reset]', body).onclick = (e) => busy(e.target, async () => { const i = await save({ otp_template: null }, 'Message reset'); ta.value = i.otpTemplate; preview(); });
      return;
    }

    if (tab === 'bot' || tab === 'knowledge' || tab === 'answer') {
      body.innerHTML = '<div class="pj-skeleton" style="height:240px"></div>';
      let cfg;
      try { cfg = await gw('GET', `/sessions/${id}/chatbot`); } catch (err) { body.innerHTML = `<div class="card gw-error">${esc(err.message)}</div>`; return; }
      if (page?.tab !== tab) return;

      if (tab === 'bot') {
        body.innerHTML = `
          <section class="card pp-panel pp-narrow">
            <div class="pp-panel-head"><h2>Instructions</h2></div>
            <p class="gw-muted gw-small">Who the bot is and how it behaves: tone, languages, what to do when it can't help. The project name is used as the business name.</p>
            <textarea class="input" data-f="instr" rows="8" maxlength="4000" placeholder="You are the assistant for Duka Online, a shop in Dar es Salaam. Be friendly and brief. Reply in Swahili or English. If someone wants to order, ask for their name, item and delivery area.">${esc(cfg.instructions)}</textarea>
            <div class="gw-counter gw-small gw-muted" data-f="instr-n"></div>
          </section>
          <section class="card pp-panel pp-narrow">
            <div class="pp-panel-head"><h2>Model</h2></div>
            <label class="gw-field">Gemini model
              <input class="input" data-f="model" list="gw-models" placeholder="Default (${esc(cfg.defaultModel)})" value="${esc(cfg.model)}">
              <datalist id="gw-models"></datalist></label>
            <label class="gw-field">Gemini API key <span class="gw-muted">${cfg.hasOwnKey ? '· this project has its own key' : cfg.serverKey ? '· optional, the server key is used' : '· required, the server has no key'}</span>
              <input class="input" type="password" data-f="key" autocomplete="off" placeholder="${cfg.hasOwnKey ? 'Saved. Enter a new key to replace it' : 'AIza…'}"></label>
            <p class="gw-muted gw-small">Get a key from Google AI Studio. Project keys are encrypted and never shown again.</p>
            <div class="pp-foot">${cfg.hasOwnKey ? '<button class="btn btn-sm btn-red" data-f="rmkey">Remove project key</button>' : ''}<button class="btn btn-primary btn-sm" data-f="save">Save</button></div>
          </section>`;
        const instr = $('[data-f=instr]', body);
        const count = () => { $('[data-f=instr-n]', body).textContent = `${instr.value.length.toLocaleString()} / 4,000`; };
        instr.oninput = count; count();
        gw('GET', '/ai/models').then((m) => { const dl = $('#gw-models'); if (dl) dl.innerHTML = (m.models || []).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join(''); }).catch(() => {});
        $('[data-f=save]', body).onclick = (e) => busy(e.target, async () => {
          const patch = { bot_instructions: instr.value, gemini_model: $('[data-f=model]', body).value.trim() || null };
          const k = $('[data-f=key]', body).value.trim();
          if (k) patch.gemini_api_key = k;
          await save(patch, 'Bot settings saved');
          if (k) renderTab(current(), 'bot');
        });
        const rm = $('[data-f=rmkey]', body);
        if (rm) rm.onclick = (e) => busy(e.target, async () => { await save({ gemini_api_key: null }, 'Project key removed'); renderTab(current(), 'bot'); });
        return;
      }

      if (tab === 'knowledge') {
        body.innerHTML = `
          <section class="card pp-panel">
            <div class="pp-panel-head"><h2>Knowledge base</h2><label class="btn btn-sm" style="cursor:pointer">Import file<input type="file" data-f="file" accept=".txt,.md,.csv,.json,text/plain" multiple hidden></label></div>
            <p class="gw-muted gw-small">Everything the bot may use to answer: products and prices, opening hours, delivery areas, FAQs, policies. It answers only from this and your instructions, and says when it doesn't know.</p>
            <textarea class="input gw-kb" data-f="kb" rows="20" placeholder="## Opening hours&#10;Mon–Sat 8:00–18:00. Closed on Sundays.&#10;&#10;## Delivery&#10;Free delivery in Kinondoni for orders above 50,000 TZS…">${esc(cfg.knowledgeBase)}</textarea>
            <div class="pp-foot"><span class="gw-counter gw-small gw-muted gw-grow" data-f="kb-n"></span><button class="btn btn-primary btn-sm" data-f="save">Save knowledge</button></div>
          </section>`;
        const kb = $('[data-f=kb]', body);
        const count = () => {
          const n = kb.value.length;
          const el = $('[data-f=kb-n]', body);
          el.textContent = `${n.toLocaleString()} / ${KB_MAX.toLocaleString()} characters`;
          el.classList.toggle('gw-error', n > KB_MAX);
        };
        kb.oninput = count; count();
        $('[data-f=file]', body).onchange = async (e) => {
          for (const file of e.target.files) {
            if (file.size > 1024 * 1024) { toast(`${file.name} is larger than 1 MB`, 'error'); continue; }
            kb.value = (kb.value.trim() ? kb.value.trim() + '\n\n' : '') + `## ${file.name}\n${(await file.text()).trim()}`;
          }
          e.target.value = '';
          count();
          toast('Imported. Remember to save.', 'info');
        };
        $('[data-f=save]', body).onclick = (e) => busy(e.target, () => save({ knowledge_base: kb.value }, 'Knowledge base saved'));
        return;
      }

      body.innerHTML = `
        <section class="card pp-panel pp-narrow">
          <div class="pp-panel-head"><h2>Answer with your own API</h2></div>
          <p class="gw-muted gw-small">Optional. For each incoming message (WhatsApp, widget or Chat API), Kamila first POSTs to this URL. Return a reply to send it, or <code>{"reply": null}</code> to let Gemini answer from the knowledge base. Use it for live data: order status, balances, bookings.</p>
          <label class="gw-field">Answer URL<input class="input" data-f="url" value="${esc(cfg.answerUrl)}" placeholder="https://api.example.com/kamila/answer"></label>
          <div class="pp-foot">${cfg.answerUrl ? '<button class="btn btn-sm" data-f="clear">Remove</button>' : ''}<button class="btn btn-primary btn-sm" data-f="save">Save</button></div>
        </section>
        <section class="card pp-panel pp-narrow">
          <div class="pp-panel-head"><h2>Request &amp; response</h2></div>
          <p class="gw-muted gw-small">Signed like webhooks (<code>X-Webhook-Signature</code>), 10 second timeout.</p>
          ${codeBlock({ Request: `POST ${cfg.answerUrl || 'https://api.example.com/kamila/answer'}\nX-Webhook-Event: message.answer\nX-Webhook-Signature: sha256=…\n\n{\n  "event": "message.answer",\n  "session": "${id}",\n  "data": {\n    "chat_id": "255712345678@c.us",\n    "phone": "255712345678",\n    "text": "Where is my order #1042?",\n    "history": [\n      { "role": "user", "text": "Hi" },\n      { "role": "bot", "text": "Hello! How can I help?" }\n    ]\n  }\n}`, Response: `{ "reply": "Order #1042 left our store at 10:15 and arrives today." }\n\n// or let Gemini answer:\n{ "reply": null }` })}
        </section>`;
      wireCode(body);
      $('[data-f=save]', body).onclick = (e) => busy(e.target, () => save({ answer_url: $('[data-f=url]', body).value.trim() || null }, 'Answer URL saved'));
      const clr = $('[data-f=clear]', body);
      if (clr) clr.onclick = (e) => busy(e.target, async () => { await save({ answer_url: null }, 'Answer URL removed'); renderTab(current(), 'answer'); });
      return;
    }

    if (tab === 'test') {
      body.innerHTML = `
        <section class="card pp-panel pp-narrow pp-playground">
          <div class="pp-panel-head"><h2>Playground</h2><button class="btn btn-sm" data-f="reset">Clear</button></div>
          <p class="gw-muted gw-small">Chat with the bot as a customer would. Nothing is sent on WhatsApp and nothing is saved.</p>
          <div class="gw-chat" data-f="chat"></div>
          <form class="gw-row gw-chat-input" data-f="form"><input class="input gw-grow" data-f="msg" placeholder="Ask something…" maxlength="4000" autocomplete="off"><button class="btn btn-primary" type="submit">Send</button></form>
        </section>`;
      const chat = $('[data-f=chat]', body);
      const draw = () => {
        chat.innerHTML = page.testHistory.length
          ? page.testHistory.map((h) => `<div class="msg-bubble ${h.role === 'user' ? 'msg-user' : 'msg-ai'}${h.error ? ' gw-bubble-error' : ''}">${esc(h.text).replace(/\n/g, '<br>')}${h.source ? `<div class="msg-meta">${h.source === 'answer_url' ? 'from your API' : 'Gemini'}</div>` : ''}</div>`).join('')
          : `<div class="gw-chat-empty"><div class="gw-muted gw-small">Ask what a customer would ask, for example:</div>
              <div class="pp-chips">${['What do you sell?', 'What are your opening hours?', 'Do you deliver?', 'How can I pay?'].map((q) => `<button type="button" class="pp-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
        chat.scrollTop = chat.scrollHeight;
      };
      draw();
      chat.onclick = (e) => {
        const q = e.target.closest('[data-q]');
        if (!q) return;
        $('[data-f=msg]', body).value = q.dataset.q;
        $('[data-f=form]', body).requestSubmit();
      };
      $('[data-f=reset]', body).onclick = () => { page.testHistory = []; draw(); };
      $('[data-f=form]', body).onsubmit = async (e) => {
        e.preventDefault();
        const input = $('[data-f=msg]', body);
        const text = input.value.trim();
        if (!text) return;
        const history = page.testHistory.filter((h) => !h.error).map(({ role, text: t }) => ({ role, text: t }));
        const p = page;
        p.testHistory.push({ role: 'user', text });
        input.value = '';
        draw();
        chat.insertAdjacentHTML('beforeend', '<div class="msg-bubble msg-ai gw-typing"><span></span><span></span><span></span></div>');
        chat.scrollTop = chat.scrollHeight;
        try {
          const r = await gw('POST', `/sessions/${id}/chatbot/test`, { message: text, history });
          p.testHistory.push(r.reply ? { role: 'bot', text: r.reply, source: r.source } : { role: 'bot', text: r.reason, error: true });
        } catch (err) {
          p.testHistory.push({ role: 'bot', text: err.message, error: true });
        }
        if (page === p && p.tab === 'test') draw();
      };
      $('[data-f=msg]', body).focus();
      return;
    }

    if (tab === 'conversations') {
      body.innerHTML = `<section class="card pp-panel"><div class="pp-panel-head"><h2>Conversations</h2><button class="btn btn-sm" data-f="refresh">Refresh</button></div><div data-f="list" class="gw-muted gw-small">Loading…</div></section>`;
      const load = async () => {
        const box = $('[data-f=list]', body);
        try {
          const rows = await gw('GET', `/sessions/${id}/messages?limit=200`);
          if (!rows.length) { box.innerHTML = emptyState('No conversations yet', 'Chats from WhatsApp, the website widget, the Chat API and messages you send show up here.', `<a class="btn btn-sm" href="#/projects/${encodeURIComponent(id)}/test">Try the Playground</a>`); return; }
          const threads = new Map();
          for (const m of rows) { if (!threads.has(m.chat_id)) threads.set(m.chat_id, []); threads.get(m.chat_id).push(m); }
          box.innerHTML = `<div class="pp-threads">${[...threads.entries()].map(([chatId, msgs]) => `
            <div class="gw-thread">
              <div class="gw-thread-head"><span>${esc(chatLabel(chatId))} <span class="gw-chan">${esc(msgs[0].channel || 'whatsapp')}</span></span><span class="gw-muted">${timeAgo(msgs[0].created_at)}</span></div>
              <div class="gw-thread-body">${msgs.slice(0, 8).reverse().map((m) => `<div class="msg-bubble ${m.role === 'user' ? 'msg-user' : 'msg-ai'}">${esc(m.text).replace(/\n/g, '<br>')}${m.source === 'api_send' ? '<div class="msg-meta">sent via API</div>' : ''}</div>`).join('')}</div>
            </div>`).join('')}</div>`;
        } catch (err) { box.textContent = err.message; }
      };
      $('[data-f=refresh]', body).onclick = load;
      page.reload = load;
      load();
      return;
    }

    if (tab === 'activity') {
      body.innerHTML = `
        <section class="card pp-panel"><div class="pp-panel-head"><h2>Recent codes</h2><button class="btn btn-sm" data-f="r1">Refresh</button></div><div data-f="otps" class="gw-muted gw-small">Loading…</div></section>`;
      const load = async () => {
        const box = $('[data-f=otps]', body);
        try {
          const rows = await gw('GET', '/otp?limit=50', undefined, id);
          box.innerHTML = rows.length ? `<table class="eval-table"><thead><tr><th>Phone</th><th>Status</th><th>Attempts</th><th>Expires</th><th>Created</th></tr></thead><tbody>${
            rows.map((o) => `<tr><td class="mono">+${esc(maskPhone(o.phone))}</td><td><span class="gw-pill ${OTP_STATUS_CLS[o.status] || ''}">${esc(o.status)}</span></td><td>${o.attempts}/${o.max_attempts}</td><td class="gw-muted">${new Date(o.expires_at).toLocaleTimeString()}</td><td class="gw-muted">${timeAgo(o.created_at)}</td></tr>`).join('')}</tbody></table>` : emptyState('No codes sent yet', 'Send one from the Docs page or your backend to see it here.', '<a class="btn btn-sm" href="#/api">Open Docs</a>');
        } catch (err) { box.textContent = err.message; }
      };
      $('[data-f=r1]', body).onclick = load;
      page.reload = load;
      load();
      return;
    }

    if (tab === 'keys') {
      const chat = s.mode === 'chatbot';
      body.innerHTML = `
        <section class="card pp-panel">
          <div class="pp-panel-head"><h2>Secret key</h2><button class="btn btn-sm" data-f="rotate">Roll key</button></div>
          <p class="gw-muted gw-small">For your backend only: ${chat ? 'the Chat API' : 'the OTP API'}. Never put it in a website or mobile app. Store it as <code>KAMILA_SECRET_KEY</code>.</p>
          <div class="gw-keybox"><code>${esc(s.apiKeyPrefix)}${'•'.repeat(20)}</code><span class="gw-muted gw-small">Shown once when created or rolled</span></div>
        </section>
        ${chat ? `
        <section class="card pp-panel">
          <div class="pp-panel-head"><h2>Publishable key</h2>${s.publishableKey ? '<button class="btn btn-sm" data-f="pk-roll">Roll key</button>' : ''}</div>
          <p class="gw-muted gw-small">Safe to put in your website. It only works for the chat widget, and only on the origins listed below.</p>
          ${s.publishableKey
            ? `<div class="gw-keybox"><code>${esc(s.publishableKey)}</code><button class="btn btn-sm" data-f="pk-copy">Copy</button></div>`
            : '<div class="gw-row"><button class="btn btn-primary btn-sm" data-f="pk-roll">Create publishable key</button></div>'}
          <div class="gw-label" style="margin-top:6px">Allowed origins</div>
          <div class="pp-origins" data-f="origins"></div>
          <form class="gw-row" data-f="origin-form"><input class="input gw-grow" data-f="origin" placeholder="https://shop.example.com"><button class="btn btn-sm" type="submit">Add origin</button></form>
        </section>
        <section class="card pp-panel">
          <div class="pp-panel-head"><h2>Website chat widget</h2></div>
          <div class="pp-widget-grid">
            <div>
              <label class="gw-field">Title<input class="input" data-f="w-title" maxlength="60" value="${esc(s.widget.title)}"></label>
              <label class="gw-field">Greeting<textarea class="input" data-f="w-greet" rows="3" maxlength="300">${esc(s.widget.greeting)}</textarea></label>
              <label class="gw-field">Colour<span class="gw-row"><input type="color" data-f="w-color" value="${esc(s.widget.color)}" class="gw-color"><code data-f="w-color-v">${esc(s.widget.color)}</code></span></label>
              <div class="pp-foot"><button class="btn btn-primary btn-sm" data-f="w-save">Save widget</button></div>
            </div>
            <div class="pp-widget-preview" data-f="w-preview" aria-hidden="true"></div>
          </div>
          <div class="gw-label">Embed</div>
          ${codeBlock(samples('widget', { extra: { pk: s.publishableKey } }))}
        </section>` : ''}
        <section class="card pp-panel">
          <div class="pp-panel-head"><h2>Quickstart</h2><a class="gw-link" href="#/api">Full docs</a></div>
          ${chat ? codeBlock(samples('chat'), 'Ask the bot') : `${codeBlock(samples('otp-send'), '1. Send a code')}${codeBlock(samples('otp-verify'), '2. Verify it')}`}
        </section>`;
      wireCode(body);
      $('[data-f=rotate]', body).onclick = (e) => {
        if (!confirmInline(e.target, 'Old key stops working. Roll?')) return;
        busy(e.target, async () => { const info = await gw('POST', `/sessions/${id}/api-key`); refreshHeader(info); revealKeyModal('New secret key', info.apiKey); renderTab(current(), 'keys'); });
      };
      if (chat) {
        const pkRoll = $('[data-f=pk-roll]', body);
        if (pkRoll) pkRoll.onclick = (e) => {
          if (s.publishableKey && !confirmInline(e.target, 'Sites using the old key break. Roll?')) return;
          busy(e.target, async () => { refreshHeader(await gw('POST', `/sessions/${id}/publishable-key`)); renderTab(current(), 'keys'); });
        };
        const pkCopy = $('[data-f=pk-copy]', body);
        if (pkCopy) pkCopy.onclick = () => copy(s.publishableKey);
        let origins = [...(s.allowedOrigins || [])];
        const drawOrigins = () => {
          $('[data-f=origins]', body).innerHTML = origins.length
            ? origins.map((o, i) => `<div class="pp-origin"><code>${esc(o)}</code><button class="btn btn-sm" data-rm="${i}" aria-label="Remove ${esc(o)}">Remove</button></div>`).join('')
            : '<div class="gw-muted gw-small">No origins yet. The widget won\'t load anywhere until you add your site.</div>';
          $$('[data-rm]', body).forEach((b) => { b.onclick = () => busy(b, async () => { const next = origins.filter((_, i) => i !== Number(b.dataset.rm)); const info = await save({ allowed_origins: next }, 'Origin removed'); origins = info.allowedOrigins; drawOrigins(); }); });
        };
        drawOrigins();
        $('[data-f=origin-form]', body).onsubmit = (e) => {
          e.preventDefault();
          const v = $('[data-f=origin]', body).value.trim().replace(/\/+$/, '');
          if (!v) return;
          busy($('button', e.target), async () => { const info = await save({ allowed_origins: [...origins, v] }, 'Origin added'); origins = info.allowedOrigins; $('[data-f=origin]', body).value = ''; drawOrigins(); });
        };
        const prev = () => {
          const c = $('[data-f=w-color]', body).value;
          const k = `background:${esc(c)};color:${inkFor(c)}`;
          $('[data-f=w-color-v]', body).textContent = c;
          $('[data-f=w-preview]', body).innerHTML = `<div class="wp-panel"><div class="wp-head" style="${k}"><span class="wp-av">${esc(($('[data-f=w-title]', body).value || 'K').charAt(0).toUpperCase())}</span><span>${esc($('[data-f=w-title]', body).value)}</span></div>
            <div class="wp-body"><div class="wp-msg">${esc($('[data-f=w-greet]', body).value)}</div><div class="wp-msg wp-me" style="${k}">Do you deliver to Mbezi?</div></div>
            <div class="wp-input"><span>Type your message…</span><span class="wp-send" style="${k}">${'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>'}</span></div></div>
            <div class="wp-bubble" style="${k}">${ICONS.chatbot}</div>`;
        };
        ['w-title', 'w-greet', 'w-color'].forEach((f) => { $(`[data-f=${f}]`, body).oninput = prev; });
        prev();
        $('[data-f=w-save]', body).onclick = (e) => busy(e.target, () => save({ widget: { title: $('[data-f=w-title]', body).value, greeting: $('[data-f=w-greet]', body).value, color: $('[data-f=w-color]', body).value } }, 'Widget saved'));
      }
      return;
    }

    if (tab === 'webhooks') {
      const events = EVENTS_BY_MODE[s.mode] || EVENTS_BY_MODE.otp;
      body.innerHTML = `
        <section class="card pp-panel">
          <div class="pp-panel-head"><h2>Endpoint</h2></div>
          <p class="gw-muted gw-small">We POST these events to your URL as JSON, signed with the secret below. Failed deliveries are retried after 5s and 30s.</p>
          <label class="gw-field">URL<input class="input" data-f="url" value="${esc(s.webhook.url || '')}" placeholder="https://example.com/kamila/webhook"></label>
          <div class="gw-label">Events</div>
          <div class="gw-events">${events.map((ev) => `<label class="gw-check"><input type="checkbox" value="${ev}" ${s.webhook.events.includes(ev) ? 'checked' : ''}> <code>${ev}</code></label>`).join('')}</div>
          <div class="gw-label">Signing secret</div>
          <div class="gw-keybox"><code data-f="secret">${'•'.repeat(32)}</code><button class="btn btn-sm" data-f="show">Reveal</button><button class="btn btn-sm" data-f="copy">Copy</button><button class="btn btn-sm" data-f="rotsec">Roll</button></div>
          <div class="pp-foot"><button class="btn btn-sm" data-f="test">Send test event</button><button class="btn btn-primary btn-sm" data-f="save">Save</button></div>
        </section>
        <section class="card pp-panel"><div class="pp-panel-head"><h2>Recent deliveries</h2><button class="btn btn-sm" data-f="r2">Refresh</button></div><div data-f="logs" class="gw-muted gw-small">Loading…</div></section>`;
      let secret = s.webhook.secret;
      $('[data-f=show]', body).onclick = (e) => {
        const f = $('[data-f=secret]', body);
        const shown = f.dataset.shown === '1';
        f.textContent = shown ? '•'.repeat(32) : secret;
        f.dataset.shown = shown ? '0' : '1';
        e.target.textContent = shown ? 'Reveal' : 'Hide';
      };
      $('[data-f=copy]', body).onclick = () => copy(secret);
      $('[data-f=rotsec]', body).onclick = (e) => { if (confirmInline(e.target, 'Receivers must update. Roll?')) busy(e.target, async () => { const info = await gw('POST', `/sessions/${id}/webhook/secret`); secret = info.webhook.secret; refreshHeader(info); if ($('[data-f=secret]', body).dataset.shown === '1') $('[data-f=secret]', body).textContent = secret; toast('Secret rolled', 'success'); }); };
      $('[data-f=save]', body).onclick = (e) => busy(e.target, () => {
        const visible = new Set(events);
        const kept = s.webhook.events.filter((ev) => !visible.has(ev));
        const on = $$('.gw-events input:checked', body).map((i) => i.value);
        return save({ webhook_url: $('[data-f=url]', body).value.trim() || null, webhook_events: [...kept, ...on] }, 'Webhook saved');
      });
      const loadLogs = async () => {
        const box = $('[data-f=logs]', body);
        try {
          const logs = await gw('GET', `/sessions/${id}/webhook/logs?limit=30`);
          box.innerHTML = logs.length ? `<table class="eval-table"><thead><tr><th>Event</th><th>Result</th><th>Attempt</th><th>Duration</th><th>When</th></tr></thead><tbody>${
            logs.map((l) => `<tr><td><code>${esc(l.event)}</code></td><td class="${l.error ? 'sentiment-neg' : 'sentiment-pos'}">${l.error ? esc(l.error) : `HTTP ${l.status_code}`}</td><td>${l.attempt}</td><td>${l.duration_ms}ms</td><td class="gw-muted">${timeAgo(l.created_at)}</td></tr>`).join('')}</tbody></table>` : emptyState('No deliveries yet', 'Save an endpoint and click “Send test event” to check it works.');
        } catch (err) { box.textContent = err.message; }
      };
      $('[data-f=test]', body).onclick = (e) => busy(e.target, async () => {
        const r = await gw('POST', `/sessions/${id}/webhook/test`);
        toast(r.ok ? `Delivered (HTTP ${r.statusCode})` : `Failed: ${r.error}`, r.ok ? 'success' : 'error');
        loadLogs();
      });
      $('[data-f=r2]', body).onclick = loadLogs;
      loadLogs();
      return;
    }

    if (tab === 'settings') {
      body.innerHTML = `
        <section class="card pp-panel pp-narrow">
          <div class="pp-panel-head"><h2>General</h2></div>
          <label class="gw-field">Project name<input class="input" data-f="name" maxlength="60" value="${esc(s.name)}"></label>
          <label class="gw-check"><input type="checkbox" data-f="auto" ${s.autoStart ? 'checked' : ''}> Start this number when the server starts</label>
          <div class="pp-foot"><button class="btn btn-primary btn-sm" data-f="save">Save</button></div>
        </section>
        ${s.mode === 'kamila' ? '' : `
        <section class="card pp-panel pp-narrow">
          <div class="pp-panel-head"><h2>Project type</h2></div>
          <p class="gw-muted gw-small">OTP projects only send codes and never reply. AI chatbots answer every 1:1 text message, and can't send codes.</p>
          <div class="gw-seg" data-f="mode" role="radiogroup" aria-label="Project type">
            <button type="button" data-mode="otp" aria-checked="${s.mode === 'otp'}">OTP codes</button>
            <button type="button" data-mode="chatbot" aria-checked="${s.mode === 'chatbot'}">AI chatbot</button>
          </div>
        </section>`}
        ${s.aiBot ? '' : `
        <section class="card pp-panel pp-narrow pp-danger">
          <div class="pp-panel-head"><h2>Delete project</h2></div>
          <p class="gw-muted gw-small">Logs the number out of WhatsApp and permanently deletes its settings, keys, codes and conversations.</p>
          <div class="pp-foot"><button class="btn btn-sm btn-red" data-f="delete">Delete project</button></div>
        </section>`}`;
      $('[data-f=save]', body).onclick = (e) => busy(e.target, async () => {
        const info = await save({ name: $('[data-f=name]', body).value.trim(), auto_start: $('[data-f=auto]', body).checked });
        const t = $('[data-f=title]'); if (t) t.textContent = info.name;
      });
      $$('[data-mode]', body).forEach((b) => {
        b.onclick = () => busy(b, async () => {
          if (current().mode === b.dataset.mode) return;
          await save({ mode: b.dataset.mode }, b.dataset.mode === 'chatbot' ? 'Now an AI chatbot' : 'Now sends OTP codes');
          renderProject(`${id}/settings`);
        });
      });
      const del = $('[data-f=delete]', body);
      if (del) del.onclick = (e) => {
        if (!confirmInline(e.target, 'Click again to delete for good')) return;
        busy(e.target, async () => { await gw('DELETE', `/sessions/${id}`); projects = projects.filter((p) => p.id !== id); toast('Project deleted', 'success'); location.hash = '#/projects'; });
      };
    }
  }

  function chatLabel(chatId) {
    if (chatId.startsWith('web:')) return 'Website visitor';
    if (chatId.startsWith('api:')) return `API · ${chatId.slice(4)}`;
    return '+' + maskPhone(chatId.replace(/@.*/, ''));
  }

  // ── Live updates ──
  let refreshTimer = null;
  function onActivity(sessionId) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (page?.id === sessionId) page.reload?.();
      else if (location.hash === '#/projects') renderProjects();
    }, 500);
  }
  onSSE('otp', (d) => onActivity(d.session));
  onSSE('chat', (d) => {
    onActivity(d.session);
    if (d.type === 'error' && page?.id === d.session) toast(`Bot could not reply: ${d.error}`, 'error');
  });
  onSSE('session', async (d) => {
    if (d.status === 'DELETED') { projects = projects.filter((p) => p.id !== d.id); if (location.hash === '#/projects') redrawProjects(); return; }
    if (page?.id === d.id) {
      if (d.status === 'WORKING') { try { refreshHeader(await gw('GET', `/sessions/${d.id}`)); return; } catch {} }
      refreshHeader(d);
    } else if (location.hash === '#/projects') {
      const p = projects.find((x) => x.id === d.id);
      if (p) { Object.assign(p, d); redrawProjects(); } else renderProjects();
    }
  });

  // ══════════════════════════════════
  // Docs
  // ══════════════════════════════════
  async function renderDocs() {
    page = null;
    const mount = $('#view-mount');
    let list = [];
    try { list = await gw('GET', '/sessions'); } catch {}
    const otpOpts = list.filter((s) => s.mode !== 'chatbot').map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    const sendOpts = list.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    const botOpts = list.filter((s) => s.mode === 'chatbot').map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    const ep = (m, p, d) => `<tr><td><span class="gw-method gw-${m}">${m}</span></td><td><code>${p}</code></td><td>${d}</td></tr>`;
    mount.innerHTML = `
      <header class="pg-head"><div><h1 class="pg-title">Docs</h1><p class="pg-sub">Send WhatsApp messages and OTP codes, and add an AI chatbot to your app or website.</p></div></header>
      <div class="docs">
        <nav class="docs-toc" aria-label="On this page">
          <a href="#doc-auth" data-anchor>Authentication</a><a href="#doc-send" data-anchor>Send messages</a><a href="#doc-otp" data-anchor>OTP</a><a href="#doc-chat" data-anchor>Chat API</a>
          <a href="#doc-widget" data-anchor>Website widget</a><a href="#doc-webhooks" data-anchor>Webhooks</a><a href="#doc-errors" data-anchor>Errors &amp; limits</a><a href="#doc-ref" data-anchor>Reference</a>
        </nav>
        <div class="docs-main">
          <section id="doc-auth" class="docs-sec">
            <h2>Authentication</h2>
            <p>Each project has two keys, shown on its <strong>API keys</strong> tab:</p>
            <div class="docs-keys">
              <div class="card"><div class="docs-key-name"><code>wsk_…</code> Secret key</div><p class="gw-muted gw-small">Server-side only. Send as <code>Authorization: Bearer wsk_…</code> to the Messages, OTP and Chat APIs.</p></div>
              <div class="card"><div class="docs-key-name"><code>wpk_…</code> Publishable key</div><p class="gw-muted gw-small">Safe in a browser. Only works for the chat widget, on origins you allow.</p></div>
            </div>
            <p class="gw-muted gw-small">Base URL: <code>${esc(BASE)}/v1</code></p>
          </section>

          <section id="doc-send" class="docs-sec">
            <h2>Send messages</h2>
            <p>Works with every project type. Send any text to a WhatsApp number from your backend: order updates, reminders, alerts. On an <em>AI chatbot</em> project, the message is saved in that person's conversation, and when they reply, the bot answers with that context.</p>
            ${codeBlock(samples('send'), 'Send a message')}
            ${codeBlock({ Response: '// 201 Created\n{\n  "id": "true_255712345678@c.us_3EB0…",\n  "phone": "255712345678",\n  "status": "SENT"\n}' })}
            <p class="gw-muted gw-small">Only message people who expect to hear from you. WhatsApp can ban numbers that send spam. Each number can get a limited number of messages per minute (<code>recipient_limited</code>).</p>
            ${sendOpts ? `<div class="card docs-try"><div class="docs-try-head">Try it</div>
              <div class="gw-grid2"><label class="gw-field">Project<select class="input" data-f="m-p">${sendOpts}</select></label><label class="gw-field">Phone<input class="input" data-f="m-phone" placeholder="255712345678" inputmode="tel"></label></div>
              <label class="gw-field">Message<input class="input" data-f="m-text" placeholder="Hello from Kamila 👋"></label>
              <div class="gw-row"><button class="btn btn-primary btn-sm" data-f="m-send">Send message</button></div>
              <pre class="docs-out" data-f="m-out">Response appears here.</pre></div>` : ''}
          </section>

          <section id="doc-otp" class="docs-sec">
            <h2>OTP</h2>
            <p>For projects of type <em>OTP codes</em>. Kamila generates the code, sends it with your template and stores only a hash. Codes are single-use, expire after 5 minutes and lock after 5 wrong tries.</p>
            ${codeBlock(samples('otp-send'), 'Send a code')}
            ${codeBlock({ Response: '// 201 Created\n{\n  "id": "otp_3f9c2a…",\n  "phone": "255712345678",\n  "status": "SENT",\n  "expires_in": 300,\n  "resend_after": 60\n}' })}
            ${codeBlock(samples('otp-verify'), 'Verify the code')}
            ${codeBlock({ Response: '{ "valid": true, "id": "otp_3f9c2a…", "phone": "255712345678" }\n{ "valid": false, "reason": "invalid_code", "attempts_left": 3 }' })}
            <p class="gw-muted gw-small"><code>reason</code>: <code>invalid_code</code>, <code>expired</code>, <code>already_used</code>, <code>too_many_attempts</code>, <code>superseded</code>, <code>not_delivered</code>, <code>not_found</code>.</p>
            ${otpOpts ? `<div class="card docs-try"><div class="docs-try-head">Try it</div>
              <div class="gw-grid2"><label class="gw-field">Project<select class="input" data-f="o-p">${otpOpts}</select></label><label class="gw-field">Phone<input class="input" data-f="o-phone" placeholder="255712345678" inputmode="tel"></label></div>
              <div class="gw-row"><button class="btn btn-primary btn-sm" data-f="o-send">Send code</button><input class="input gw-code-input" data-f="o-code" placeholder="Code" inputmode="numeric" maxlength="10"><button class="btn btn-sm" data-f="o-verify">Verify</button></div>
              <pre class="docs-out" data-f="o-out">Response appears here.</pre></div>` : ''}
          </section>

          <section id="doc-chat" class="docs-sec">
            <h2>Chat API</h2>
            <p>For <em>AI chatbot</em> projects. Ask the bot from your backend, for an in-app assistant, a support form or your own channel. Pass a stable <code>user</code> id and Kamila keeps that user's conversation history.</p>
            ${codeBlock(samples('chat'), 'Send a message')}
            ${codeBlock({ Response: '{\n  "reply": "We\'re open Mon–Sat, 8:00–18:00.",\n  "source": "gemini",\n  "user": "customer-42"\n}' })}
            ${botOpts ? `<div class="card docs-try"><div class="docs-try-head">Try it</div>
              <div class="gw-grid2"><label class="gw-field">Project<select class="input" data-f="c-p">${botOpts}</select></label><label class="gw-field">Message<input class="input" data-f="c-msg" placeholder="What are your opening hours?"></label></div>
              <div class="gw-row"><button class="btn btn-primary btn-sm" data-f="c-send">Send</button></div>
              <pre class="docs-out" data-f="c-out">Response appears here.</pre></div>` : ''}
          </section>

          <section id="doc-widget" class="docs-sec">
            <h2>Website widget</h2>
            <p>A chat bubble for any website, answered by your chatbot project. Create a publishable key and add your site under <strong>API keys → Allowed origins</strong>, then paste:</p>
            ${codeBlock(samples('widget'))}
            <p class="gw-muted gw-small">Options: <code>data-position="left"</code>, <code>data-open="true"</code>. Visitors are rate-limited, and each project has a daily message cap.</p>
          </section>

          <section id="doc-webhooks" class="docs-sec">
            <h2>Webhooks</h2>
            <p>Set an endpoint on a project's <strong>Webhooks</strong> tab. Every request carries <code>X-Webhook-Event</code>, <code>X-Webhook-Timestamp</code> and <code>X-Webhook-Signature: sha256=HMAC(secret, "timestamp.body")</code>.</p>
            ${codeBlock({ 'Node.js': `import crypto from "crypto";\n\napp.post("/kamila/webhook", express.raw({ type: "application/json" }), (req, res) => {\n  const ts = req.get("X-Webhook-Timestamp");\n  const expected = "sha256=" + crypto\n    .createHmac("sha256", process.env.KAMILA_WEBHOOK_SECRET)\n    .update(ts + "." + req.body)\n    .digest("hex");\n  const got = req.get("X-Webhook-Signature") || "";\n  if (got.length !== expected.length ||\n      !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {\n    return res.sendStatus(401);\n  }\n  const event = JSON.parse(req.body);\n  // event.event: otp.sent | otp.status | otp.verified | message.received | message.replied | message.sent | session.status\n  res.sendStatus(200);\n});`, Python: `import hmac, hashlib, os\n\n@app.post("/kamila/webhook")\ndef webhook():\n    ts = request.headers["X-Webhook-Timestamp"]\n    body = request.get_data()\n    expected = "sha256=" + hmac.new(\n        os.environ["KAMILA_WEBHOOK_SECRET"].encode(),\n        ts.encode() + b"." + body,\n        hashlib.sha256,\n    ).hexdigest()\n    if not hmac.compare_digest(expected, request.headers.get("X-Webhook-Signature", "")):\n        abort(401)\n    event = request.get_json()\n    return "", 200` }, 'Verify the signature')}
          </section>

          <section id="doc-errors" class="docs-sec">
            <h2>Errors &amp; limits</h2>
            <p>Errors return JSON <code>{ "error": "…", "code": "…" }</code> with a matching HTTP status.</p>
            <table class="eval-table"><thead><tr><th>Status</th><th>Code</th><th>Meaning</th></tr></thead><tbody>
              <tr><td>401</td><td><code>unauthenticated</code></td><td>Missing or wrong key</td></tr>
              <tr><td>404</td><td><code>not_on_whatsapp</code></td><td>The phone number has no WhatsApp account</td></tr>
              <tr><td>409</td><td><code>session_not_connected</code></td><td>The project's WhatsApp isn't linked or is offline</td></tr>
              <tr><td>409</td><td><code>otp_disabled</code> / <code>not_chatbot</code></td><td>Wrong project type for this endpoint</td></tr>
              <tr><td>429</td><td><code>rate_limited</code>, <code>recipient_limited</code>, <code>resend_cooldown</code>, <code>hourly_limit</code></td><td>Slow down; see <code>Retry-After</code></td></tr>
              <tr><td>502</td><td><code>send_failed</code>, <code>ai_error</code></td><td>WhatsApp or the AI failed. Safe to retry.</td></tr>
            </tbody></table>
          </section>

          <section id="doc-ref" class="docs-sec">
            <h2>Reference</h2>
            <table class="eval-table gw-endpoints"><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>
              ${ep('POST', '/v1/messages', '<code>{ phone, text }</code> → <code>{ id, status }</code>')}
              ${ep('POST', '/v1/otp/send', '<code>{ phone, length?, ttl_seconds?, code? }</code>')}
              ${ep('POST', '/v1/otp/verify', '<code>{ id | phone, code }</code> → <code>{ valid, reason? }</code>')}
              ${ep('GET', '/v1/otp/:id', 'Status: SENT → DELIVERED → READ → VERIFIED')}
              ${ep('GET', '/v1/otp', 'Recent codes')}
              ${ep('POST', '/v1/chat', '<code>{ message, user? }</code> → <code>{ reply, source }</code>')}
              ${ep('GET', '/v1/contacts/:phone/check', 'Is this number on WhatsApp?')}
              ${ep('GET', '/v1/me', 'The project this key belongs to')}
            </tbody></table>
          </section>
        </div>
      </div>`;
    wireCode(mount);
    $$('[data-anchor]', mount).forEach((a) => { a.onclick = (e) => { e.preventDefault(); $(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }; });
    const out = (sel, obj) => { $(sel, mount).textContent = JSON.stringify(obj, null, 2); };
    const mSend = $('[data-f=m-send]', mount);
    if (mSend) mSend.onclick = () => busy(mSend, async () => {
      try { out('[data-f=m-out]', await gw('POST', '/messages', { phone: $('[data-f=m-phone]', mount).value, text: $('[data-f=m-text]', mount).value || 'Hello from Kamila 👋' }, $('[data-f=m-p]', mount).value)); } catch (e) { out('[data-f=m-out]', { error: e.message, status: e.status }); }
    });
    let lastOtp = null;
    const oSend = $('[data-f=o-send]', mount);
    if (oSend) {
      oSend.onclick = () => busy(oSend, async () => {
        try { const r = await gw('POST', '/otp/send', { phone: $('[data-f=o-phone]', mount).value }, $('[data-f=o-p]', mount).value); lastOtp = r.id; out('[data-f=o-out]', r); } catch (e) { out('[data-f=o-out]', { error: e.message, status: e.status }); }
      });
      $('[data-f=o-verify]', mount).onclick = (e) => busy(e.target, async () => {
        const code = $('[data-f=o-code]', mount).value.trim();
        const b = lastOtp ? { id: lastOtp, code } : { phone: $('[data-f=o-phone]', mount).value, code };
        try { out('[data-f=o-out]', await gw('POST', '/otp/verify', b, $('[data-f=o-p]', mount).value)); } catch (er) { out('[data-f=o-out]', { error: er.message, status: er.status }); }
      });
    }
    const cSend = $('[data-f=c-send]', mount);
    if (cSend) cSend.onclick = () => busy(cSend, async () => {
      try { out('[data-f=c-out]', await gw('POST', '/chat', { message: $('[data-f=c-msg]', mount).value || 'Hello', user: 'docs-playground' }, $('[data-f=c-p]', mount).value)); } catch (e) { out('[data-f=c-out]', { error: e.message, status: e.status }); }
    });
  }

  route('#/projects', renderProjects);
  route('#/projects/*', renderProject);
  route('#/sessions', () => { location.replace('#/projects'); });
  route('#/api', renderDocs);
})();
