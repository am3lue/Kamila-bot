(() => {
  'use strict';

  // ── Helpers ──
  const $ = (s, p) => (p || document).querySelector(s);
  const $$ = (s, p) => [...(p || document).querySelectorAll(s)];
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
  function renderMd(text) {
    if (!text) return '';
    let out = esc(text);
    out = out.replace(/```([\s\S]*?)```/g, '<pre class="md-code-block"><code>$1</code></pre>');
    out = out.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
    out = out.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
    out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
    out = out.replace(/~([^~]+)~/g, '<del>$1</del>');
    out = out.replace(/\n/g, '<br>');
    return out;
  }
  // Every call carries the Tausi session token (see auth-boot.js).
  const Auth = window.KamilaAuth;
  function apiErr(r, msg) {
    const e = new Error(msg || 'API error');
    e.status = r.status;
    return e;
  }
  async function authedFetch(u, opts = {}) {
    const r = await fetch(u, { ...opts, headers: await Auth.headers(opts.headers) });
    if (r.status === 401) Auth.expired();
    return r;
  }
  const api = (u) => authedFetch(u).then(r => {
    if (!r.ok) throw apiErr(r, `GET ${u} failed (${r.status})`);
    return r.json();
  });
  const post = (u, b) => authedFetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => {
    if (!r.ok) throw apiErr(r, `POST ${u} failed (${r.status})`);
    return r.json();
  });

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    $('#toast-container').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function timeAgo(ts) {
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // ── SSE with auto-reconnect and polling fallback ──
  let evtSource = null;
  let pollInterval = null;
  const sseListeners = {};

  function onSSE(event, fn) {
    if (!sseListeners[event]) sseListeners[event] = [];
    sseListeners[event].push(fn);
  }

  async function connectSSE() {
    if (evtSource) evtSource.close();
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    let ticket;
    try {
      const r = await authedFetch('/auth/sse-ticket', { method: 'POST' });
      if (!r.ok) throw new Error('ticket ' + r.status);
      ({ ticket } = await r.json());
    } catch {
      setTimeout(connectSSE, 5000);
      startPollingFallback();
      return;
    }
    evtSource = new EventSource('/api/events?ticket=' + encodeURIComponent(ticket));
    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        (sseListeners['message'] || []).forEach(fn => fn(data));
      } catch {}
    };
    for (const ev of ['message', 'draft', 'task', 'eval', 'contact', 'status', 'session', 'otp', 'chat']) {
      evtSource.addEventListener(ev, (e) => {
        try {
          const data = JSON.parse(e.data);
          (sseListeners[ev] || []).forEach(fn => fn(data));
        } catch {}
      });
    }
    evtSource.onerror = () => {
      evtSource.close();
      setTimeout(connectSSE, 3000);
      startPollingFallback();
    };
  }

  function startPollingFallback() {
    if (pollInterval) return;
    if (!Auth.isOwner) return;
    pollInterval = setInterval(async () => {
      try {
        const s = await api('/api/status');
        (sseListeners['status'] || []).forEach(fn => fn(s));
      } catch {}
    }, 5000);
  }

  // ── Local storage helpers ──
  function saveState(key, val) { try { localStorage.setItem('kamila_' + key, JSON.stringify(val)); } catch {} }
  function loadState(key, fallback) { try { return JSON.parse(localStorage.getItem('kamila_' + key)) || fallback; } catch { return fallback; } }

  // ── Router ──
  const routes = {};
  let currentView = null;

  // route('#/x', fn) matches exactly; route('#/x/*', fn) matches '#/x/<rest>' and calls fn(rest).
  const prefixRoutes = [];
  function route(hash, handler) {
    if (hash.endsWith('/*')) prefixRoutes.push([hash.slice(0, -1), handler]);
    else routes[hash] = handler;
  }

  const OWNER_VIEWS = new Set(['#/overview', '#/chats', '#/tasks', '#/settings']);
  function navigate() {
    const home = '#/projects';
    const hash = location.hash || home;
    let handler = routes[hash];
    if (!handler) {
      const m = prefixRoutes.find(([p]) => hash.startsWith(p) && hash.length > p.length);
      if (m) handler = () => m[1](decodeURIComponent(hash.slice(m[0].length)));
    }
    if (!handler || (OWNER_VIEWS.has(hash) && !Auth.isOwner)) {
      if (location.hash === home) return;
      location.hash = home;
      return;
    }
    $$('.nav-item').forEach((n) => { const h = n.getAttribute('href'); n.classList.toggle('active', h === hash || hash.startsWith(h + '/')); });
    currentView = hash.replace('#/', '');
    // Chats view is full-bleed: no page scroll, only the two panels scroll internally
    $('#main-content').classList.toggle('chat-view-active', currentView === 'chats');
    if (window.KamilaDash?.onLeave) { window.KamilaDash.onLeave(); window.KamilaDash.onLeave = null; }
    // Stop chat poll when leaving chats view
    if (currentView !== 'chats' && chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    handler();
  }

  window.addEventListener('hashchange', navigate);

  // ── Status ──
  async function refreshStatus() {
    try {
      const s = await api('/api/status');
      const el = $('#conn-status');
      el.className = 'conn-badge ' + (s.connected ? 'conn-on' : s.hasQr ? 'conn-qr' : 'conn-off');
      $('.conn-text', el).textContent = s.connected ? 'Online' : s.hasQr ? 'Scan QR' : 'Offline';
    } catch {}
  }

  async function refreshTaskBadge() {
    try {
      const tasks = await api('/api/tasks');
      const badge = $('#task-badge');
      if (tasks.length) { badge.textContent = tasks.length; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    } catch {}
  }

  // ══════════════════════════════════
  // VIEW: Overview
  // ══════════════════════════════════

  let charts = {};
  // Chart colours come from the CSS theme tokens so they follow light/dark mode.
  const tok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function chartTheme() {
    if (window.Chart) {
      Chart.defaults.font.family = tok('--font') || 'system-ui';
      Chart.defaults.font.size = 12;
      Chart.defaults.color = tok('--text-muted');
      Chart.defaults.borderColor = tok('--border');
      Chart.defaults.plugins.legend.labels.usePointStyle = true;
      Chart.defaults.plugins.legend.labels.boxWidth = 8;
      Chart.defaults.plugins.legend.labels.boxHeight = 8;
      Chart.defaults.elements.arc.borderColor = tok('--bg-card');
      Chart.defaults.elements.arc.borderWidth = 2;
    }
    return { text: tok('--text'), dim: tok('--text-dim'), muted: tok('--text-muted'), border: tok('--border'), green: tok('--green'), red: tok('--red'), yellow: tok('--yellow'), card: tok('--bg-card') };
  }

  async function renderOverview() {
    const mount = $('#view-mount');
    mount.innerHTML = `
      <div class="card-grid card-grid-4" style="margin-bottom:16px">
        <div class="card"><div class="stat-label">Active Contacts</div><div class="stat-value" id="s-contacts">-</div></div>
        <div class="card"><div class="stat-label">Total Messages</div><div class="stat-value" id="s-messages">-</div></div>
        <div class="card"><div class="stat-label">Open Tasks</div><div class="stat-value" id="s-tasks">-</div></div>
        <div class="card clickable-card" onclick="location.hash='#/chats'" style="cursor:pointer"><div class="stat-label">Needs Human Help</div><div class="stat-value" id="s-help">-</div></div>
      </div>
      <div class="card-grid card-grid-3" style="margin-bottom:16px">
        <div class="card"><div class="section-title">Feedback</div><div id="s-feedback" style="font-size:28px;font-weight:700">-</div><div id="s-feedback-detail" style="font-size:12px;color:var(--text-muted);margin-top:4px"></div></div>
      </div>
      <div class="card-grid card-grid-2" style="margin-bottom:16px">
        <div class="card"><div class="section-title">Messages (14 days)</div><div class="chart-wrap"><canvas id="chart-volume"></canvas></div></div>
        <div class="card"><div class="section-title">Sentiment Mix</div><div class="chart-wrap"><canvas id="chart-sentiment"></canvas></div></div>
      </div>
      <div class="card-grid card-grid-2">
        <div class="card"><div class="section-title">Reply Mode Mix</div><div class="chart-wrap"><canvas id="chart-mode"></canvas></div></div>
        <div class="card"><div class="section-title">Task Completion</div><div class="chart-wrap"><canvas id="chart-tasks"></canvas></div></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="section-title">Recent Evaluations</div><div id="eval-table-wrap"></div></div>
    `;
    loadOverviewData();
  }

  async function loadOverviewData() {
    let data;
    try { data = await api('/api/stats'); } catch { return; }
    if (!data.totals) return;
    $('#s-contacts').textContent = data.totals.contacts;
    $('#s-messages').textContent = data.totals.messages;
    $('#s-tasks').textContent = data.totals.openTasks;
    const helpEl = $('#s-help');
    helpEl.textContent = data.totals.needsHelp;
    if (data.totals.needsHelp > 0) helpEl.classList.add('red'); else helpEl.classList.remove('red');

    // Volume chart
    const T = chartTheme();
    if (charts.volume) charts.volume.destroy();
    const volLabels = data.volume.map(v => v.day.slice(5));
    charts.volume = new Chart($('#chart-volume'), {
      type: 'bar', data: {
        labels: volLabels,
        datasets: [
          { label: 'Total', data: data.volume.map(v => v.messages), backgroundColor: T.text, borderRadius: 4, maxBarThickness: 18 },
          { label: 'AI', data: data.volume.map(v => v.ai), backgroundColor: T.muted, borderRadius: 4, maxBarThickness: 18 },
        ]
      }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { align: 'end' } }, scales: { x: { grid: { display: false }, border: { display: false } }, y: { beginAtZero: true, grid: { color: T.border }, border: { display: false }, ticks: { precision: 0 } } } }
    });

    // Sentiment chart
    if (charts.sentiment) charts.sentiment.destroy();
    const sentLabels = Object.keys(data.sentimentMix);
    const sentColors = sentLabels.map(s => s === 'positive' ? T.green : s === 'negative' ? T.red : T.yellow);
    charts.sentiment = new Chart($('#chart-sentiment'), {
      type: 'doughnut', data: { labels: sentLabels, datasets: [{ data: Object.values(data.sentimentMix), backgroundColor: sentColors }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '72%', plugins: { legend: { position: 'right' } } }
    });

    // Mode chart
    if (charts.mode) charts.mode.destroy();
    const modeLabels = Object.keys(data.modeMix);
    const modeColors = modeLabels.map(m => m === 'AUTO' ? T.green : m === 'DRAFT' ? T.yellow : T.muted);
    charts.mode = new Chart($('#chart-mode'), {
      type: 'doughnut', data: { labels: modeLabels, datasets: [{ data: Object.values(data.modeMix), backgroundColor: modeColors }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '72%', plugins: { legend: { position: 'right' } } }
    });

    // Task chart
    if (charts.tasks) charts.tasks.destroy();
    charts.tasks = new Chart($('#chart-tasks'), {
      type: 'doughnut', data: { labels: ['Done', 'Pending'], datasets: [{ data: [data.taskCompletion.done, data.taskCompletion.pending], backgroundColor: [T.text, T.border] }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '72%', plugins: { legend: { position: 'right' } } }
    });

    // Evaluations table
    const evals = await api('/api/evaluations');
    const wrap = $('#eval-table-wrap');
    if (!evals.length) { wrap.innerHTML = '<div class="empty-state">No evaluations yet</div>'; return; }
    wrap.innerHTML = `<table class="eval-table"><thead><tr><th>Chat</th><th>Score</th><th>Sentiment</th><th>Help?</th><th>Summary</th><th></th></tr></thead><tbody>${evals.slice(0, 20).map(e => `
      <tr>
        <td><a href="#/chats" class="eval-chat-link" onclick="window._jumpToChat('${esc(e.chat_id)}');return false;" title="Open chat">${esc(e.chat_id)}</a></td>
        <td>${e.resolution_score}/10</td>
        <td class="sentiment-${e.sentiment?.[0] || 'neu'}">${esc(e.sentiment || '-')}</td>
        <td>${e.needs_human_help ? '<span style="color:var(--red)">Yes</span>' : 'No'}</td>
        <td>${esc((e.summary || '').slice(0, 80))}</td>
        <td>${e.needs_human_help ? `<button class="btn btn-sm" onclick="window._resolveChat('${esc(e.chat_id)}')">Resume AI</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;

    // Feedback stats
    try {
      const fbStats = await api('/api/feedback/stats');
      const fbEl = $('#s-feedback');
      const fbDetail = $('#s-feedback-detail');
      if (fbStats.length && fbEl) {
        const totalFb = fbStats.reduce((s, f) => s + f.count, 0);
        const avgFb = fbStats.reduce((s, f) => s + f.avg_rating, 0) / fbStats.length;
        fbEl.textContent = `${totalFb}`;
        fbDetail.textContent = `Avg: ${avgFb > 0 ? '+' : ''}${avgFb.toFixed(1)} across ${fbStats.length} chats`;
        fbEl.style.color = avgFb > 0 ? 'var(--green)' : avgFb < 0 ? 'var(--red)' : 'var(--text)';
      }
    } catch {}
  }

  // ══════════════════════════════════
  // VIEW: Chats
  // ══════════════════════════════════

  let selectedChat = loadState('selectedChat', null);
  let chatPollTimer = null;
  let allContacts = [];

  async function renderChats() {
    const mount = $('#view-mount');
    mount.innerHTML = `
      <div class="chats-layout">
        <div class="chats-sidebar">
          <div class="chats-sidebar-header">
            <input class="input" id="contact-search" placeholder="Search by name or number...">
          </div>
          <div class="contact-list" id="contact-list"></div>
        </div>
        <div class="chat-main">
          <div class="chat-header">
            <div>
              <div id="chat-title" style="font-weight:600">Select a contact</div>
              <div id="chat-subtitle" style="font-size:11px;color:var(--text-muted)"></div>
            </div>
            <div id="mode-controls" style="display:none;align-items:center;gap:6px">
              <button class="btn btn-sm mode-btn" data-mode="AUTO">AUTO</button>
              <button class="btn btn-sm mode-btn" data-mode="DRAFT">DRAFT</button>
              <button class="btn btn-sm mode-btn" data-mode="OFF">OFF</button>
              <button class="btn btn-sm btn-red" id="drop-btn" style="margin-left:6px">Drop</button>
            </div>
          </div>
          <div class="chat-messages" id="chat-messages">
            <div class="empty-state">
              <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
              <div>Select a contact to view messages</div>
            </div>
          </div>
          <div id="draft-area"></div>
          <div class="msg-input-area">
            <input class="input" id="msg-input" placeholder="Type a reply..." disabled>
            <button class="btn btn-primary" id="send-btn" disabled>Send</button>
          </div>
        </div>
      </div>
    `;

    await loadContactList();
    $('#contact-search').addEventListener('input', filterContacts);
    $('#send-btn').addEventListener('click', sendManualReply);
    $('#msg-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendManualReply(); } });
    $$('.mode-btn').forEach(b => b.addEventListener('click', () => setChatMode(b.dataset.mode)));
    $('#drop-btn')?.addEventListener('click', () => {
      if (!selectedChat) return;
      if (!confirm(`Permanently drop ${selectedChat} and all its data?`)) return;
      post('/api/contacts/drop', { chatId: selectedChat }).then(r => {
        if (r.ok) { toast('Dropped ' + selectedChat); selectedChat = null; renderChats(); }
      }).catch(e => toast('Drop failed: ' + (e.message || 'error'), 'error'));
    });

    // Restore selected chat
    if (selectedChat) {
      const c = allContacts.find(x => x.phone_number === selectedChat);
      if (c) selectChat(c.phone_number, c.name);
    }

    if (chatPollTimer) clearInterval(chatPollTimer);
    chatPollTimer = setInterval(async () => {
      if ($('#contact-list')) await loadContactList();
      if (selectedChat && $('#chat-messages')) loadChatMessages(selectedChat);
    }, 5000);
  }

  async function loadContactList(filter) {
    try { allContacts = await api('/api/contacts'); } catch { return; }
    const el = $('#contact-list');
    if (!el) return;
    if (!Array.isArray(allContacts) || !allContacts.length) { el.innerHTML = '<div class="empty-state">No conversations yet. Import contacts in Settings, then chat with them on WhatsApp.</div>'; return; }

    // Contacts come back already sorted by most-recent-message; keep server order.
    let filtered = allContacts;
    if (filter) {
      const f = filter.toLowerCase();
      filtered = allContacts.filter(c =>
        (c.name || '').toLowerCase().includes(f) ||
        (c.phone_number || '').includes(f)
      );
    }

    el.innerHTML = filtered.map(c => `
      <div class="contact-item ${selectedChat === c.phone_number ? 'active' : ''}" data-id="${esc(c.phone_number)}" data-name="${esc(c.name || '')}">
        <div class="contact-name">${esc(c.name || c.phone_number)}</div>
        <div class="contact-phone">${esc(c.phone_number)}</div>
        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
          ${c.registered === 0 ? '<span class="badge badge-new">New</span>' : ''}
          ${c.on_whatsapp === 0 ? '<span class="badge badge-drop">No WA</span>' : ''}
          <span class="contact-mode mode-${c.auto_reply_mode}">${c.auto_reply_mode}</span>
        </div>
      </div>`).join('');
    $$('.contact-item', el).forEach(item => item.addEventListener('click', () => selectChat(item.dataset.id, item.dataset.name)));
  }

  function filterContacts(e) { loadContactList(e.target.value); }

  async function selectChat(id, name) {
    selectedChat = id;
    saveState('selectedChat', id);
    $('#chat-title').textContent = name || id;
    $('#chat-subtitle').textContent = id;
    $('#mode-controls').style.display = 'flex';
    $('#msg-input').disabled = false;
    $('#send-btn').disabled = false;
    await loadChatMessages(id);
    loadDraftArea(id);
    $$('.contact-item').forEach(c => c.classList.toggle('active', c.dataset.id === id));
    // Highlight current mode
    const contact = allContacts.find(c => c.phone_number === id);
    const currentMode = contact?.auto_reply_mode || 'AUTO';
    $$('.mode-btn').forEach(b => {
      b.style.background = b.dataset.mode === currentMode ? 'var(--accent)' : 'var(--border)';
      b.style.color = b.dataset.mode === currentMode ? '#fff' : 'var(--text)';
    });
  }

  async function loadChatMessages(chatId) {
    const msgs = await api(`/api/contacts/${encodeURIComponent(chatId)}/messages`);
    const el = $('#chat-messages');
    if (!msgs.length) { el.innerHTML = '<div class="empty-state">No messages yet</div>'; return; }
    el.innerHTML = msgs.map(m => `
      <div class="msg-bubble ${m.is_ai ? 'msg-ai' : 'msg-user'}">
        <div class="msg-text">${m.is_ai ? renderMd(m.text) : esc(m.text)}</div>
        <div class="msg-meta">
          <span>${m.is_ai ? 'Kamila' : 'User'} · ${timeAgo(m.timestamp)}</span>
          ${m.is_ai ? `<span class="feedback-btns" data-ts="${m.timestamp}">
            <button class="fb-btn fb-up" onclick="window._giveFeedback('${esc(chatId)}',${m.timestamp},1,this)" title="Helpful">&#128077;</button>
            <button class="fb-btn fb-down" onclick="window._giveFeedback('${esc(chatId)}',${m.timestamp},-1,this)" title="Not helpful">&#128078;</button>
          </span>` : ''}
        </div>
      </div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  async function loadDraftArea(chatId) {
    const el = $('#draft-area');
    try {
      const drafts = await api(`/api/drafts/${encodeURIComponent(chatId)}`);
      if (!drafts.length) { el.innerHTML = ''; return; }
      const d = drafts[0];
      el.innerHTML = `<div class="draft-card">
        <div class="draft-label">Pending Draft</div>
        <div class="draft-text">${esc(d.text.slice(0, 300))}${d.text.length > 300 ? '...' : ''}</div>
        <div class="draft-actions">
          <button class="btn btn-green btn-sm" onclick="window._approveDraft(${d.id})">Approve & Send</button>
          <button class="btn btn-red btn-sm" onclick="window._discardDraft(${d.id})">Discard</button>
        </div>
      </div>`;
    } catch { el.innerHTML = ''; }
  }

  window._approveDraft = async (id) => {
    const r = await post('/api/send-draft', { draftId: id });
    if (r.ok) { toast('Draft sent', 'success'); loadChatMessages(selectedChat); loadDraftArea(selectedChat); }
    else toast('Failed: ' + r.error, 'error');
  };

  window._discardDraft = async (id) => {
    const r = await post('/api/discard-draft', { draftId: id });
    if (r.ok) { toast('Draft discarded', 'info'); loadDraftArea(selectedChat); }
  };

  window._giveFeedback = async (chatId, ts, rating, btn) => {
    try {
      const r = await post('/api/feedback', { chatId, messageTs: ts, rating });
      if (r.ok) {
        // Mark the clicked button, disable both
        const container = btn.closest('.feedback-btns');
        if (container) {
          container.querySelectorAll('.fb-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
          btn.style.opacity = '1';
          btn.classList.add('fb-active');
        }
        toast(rating > 0 ? 'Marked helpful' : 'Marked not helpful', 'success');
      }
    } catch (e) { toast('Feedback failed', 'error'); }
  };

  window._resolveChat = async (chatId) => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Resume AI');
    try {
      const r = await post('/api/evaluate/resolve', { chatId });
      if (r.ok) {
        toast('AI resumed for ' + chatId);
        await loadOverviewData();
      } else {
        toast('Resolve failed: ' + (r.error || 'unknown error'), 'error');
      }
    } catch (e) {
      toast('Resolve failed: ' + (e.message || 'network error'), 'error');
    }
  };

  window._jumpToChat = async (chatId) => {
    selectedChat = chatId;
    saveState('selectedChat', chatId);
    if (location.hash !== '#/chats') {
      location.hash = '#/chats';
      // Wait for chats view to render
      await new Promise(r => setTimeout(r, 100));
    }
    // Select the chat
    const c = allContacts.find(x => x.phone_number === chatId);
    if (c) selectChat(c.phone_number, c.name);
    else selectChat(chatId, chatId);
  };

  async function sendManualReply() {
    const input = $('#msg-input');
    const text = input.value.trim();
    if (!text || !selectedChat) return;
    input.value = '';
    try {
      const r = await post('/api/send', { chatId: selectedChat, text });
      if (r.ok) { await loadChatMessages(selectedChat); }
      else { toast('Send failed: ' + (r.error || 'unknown error'), 'error'); input.value = text; }
    } catch (e) {
      toast('Send failed: ' + (e.message || 'network error'), 'error');
      input.value = text;
    }
  }

  async function setChatMode(mode) {
    if (!selectedChat) return;
    const r = await post(`/api/contacts/${encodeURIComponent(selectedChat)}/mode`, { mode });
    if (r.ok) {
      toast(`Mode: ${mode}`, 'success');
      // Update active button styling
      $$('.mode-btn').forEach(b => {
        b.style.background = b.dataset.mode === mode ? 'var(--accent)' : 'var(--border)';
        b.style.color = b.dataset.mode === mode ? '#fff' : 'var(--text)';
      });
      loadContactList();
    } else {
      toast('Failed: ' + (r.error || 'unknown'), 'error');
    }
  }

  // ══════════════════════════════════
  // VIEW: Tasks
  // ══════════════════════════════════

  async function renderTasks() {
    const mount = $('#view-mount');
    mount.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div class="section-title" style="margin:0">Tasks</div>
        <div style="display:flex;gap:8px">
          <select class="input" id="task-filter" style="width:auto">
            <option value="pending">Pending</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
          <input class="input" id="task-search" placeholder="Search tasks..." style="width:200px">
        </div>
      </div>
      <div id="task-list"></div>
    `;
    $('#task-filter').addEventListener('change', loadTaskList);
    $('#task-search').addEventListener('input', loadTaskList);
    loadTaskList();
  }

  async function loadTaskList() {
    const filter = $('#task-filter')?.value || 'pending';
    const search = ($('#task-search')?.value || '').toLowerCase();
    const all = filter !== 'pending' ? '?all=1' : '';
    let tasks;
    try { tasks = await api(`/api/tasks${all}`); } catch { return; }
    if (!Array.isArray(tasks)) return;
    if (filter === 'pending') tasks = tasks.filter(t => t.status === 'PENDING');
    else if (filter === 'done') tasks = tasks.filter(t => t.status === 'DONE');
    if (search) tasks = tasks.filter(t => (t.task_description || '').toLowerCase().includes(search));

    const el = $('#task-list');
    if (!tasks.length) { el.innerHTML = '<div class="empty-state">No tasks found</div>'; return; }

    const groups = { HIGH: [], MEDIUM: [], LOW: [] };
    tasks.forEach(t => { (groups[t.urgency] || groups.MEDIUM).push(t); });

    el.innerHTML = Object.entries(groups).filter(([, v]) => v.length).map(([urgency, items]) => `
      <div class="task-group">
        <div class="task-group-header">
          <span class="task-urgency urgency-${urgency}">${urgency}</span>
          <span style="font-size:13px;font-weight:600">${items.length}</span>
        </div>
        ${items.map(t => `
          <div class="task-item ${t.status === 'DONE' ? 'done' : ''}">
            <input type="checkbox" ${t.status === 'DONE' ? 'checked' : ''} data-id="${t.id}">
            <div style="flex:1">
              <div class="task-desc">${esc(t.task_description)}</div>
              <div class="task-chat"><a href="#/chats" style="color:var(--accent);text-decoration:none;cursor:pointer" onclick="window._jumpToChat('${esc(t.chat_id)}')">${esc(t.chat_id)}</a> · ${timeAgo(t.created_at)}</div>
            </div>
          </div>`).join('')}
      </div>`).join('');

    $$('.task-item input[type=checkbox]', el).forEach(cb => cb.addEventListener('change', async () => {
      if (cb.checked) { await post('/api/complete-task', { taskId: Number(cb.dataset.id) }); loadTaskList(); refreshTaskBadge(); }
    }));
  }

  // ══════════════════════════════════
  // VIEW: Settings
  // ══════════════════════════════════

  async function renderSettings() {
    const mount = $('#view-mount');
    const status = await api('/api/status');
    mount.innerHTML = `
      <div class="section-title">Connection</div>
      <div class="card" style="margin-bottom:16px">
        <div class="setting-row"><span class="setting-key">WhatsApp</span><span class="setting-val" style="color:${status.connected ? 'var(--green)' : 'var(--red)'}">${status.connected ? 'Connected' : 'Disconnected'}</span></div>
        <div class="setting-row"><span class="setting-key">Dashboard URL</span><span class="setting-val">http://localhost:${location.port || 3000}</span></div>
      </div>
      <div class="section-title">Configuration</div>
      <div class="card">
        <div class="setting-row"><span class="setting-key">AI</span><span class="setting-val" id="cfg-ai">Loading...</span></div>
        <div class="setting-row"><span class="setting-key">GEMINI_MODEL</span><span class="setting-val" id="cfg-model">Loading...</span></div>
        <div class="setting-row"><span class="setting-key">AXIOS_TIMEOUT_MS</span><span class="setting-val" id="cfg-timeout">Loading...</span></div>
        <div class="setting-row"><span class="setting-key">RATE_LIMIT_COOLDOWN_MS</span><span class="setting-val" id="cfg-ratelimit">Loading...</span></div>
      </div>
      <div class="section-title">Pending Registrations</div>
      <div class="card">
        <p style="color:var(--muted);margin:0 0 10px;font-size:13px">New numbers that messaged you and are waiting for registry approval. Approve to register them (AI replies continue), or reject to drop them.</p>
        <div id="reg-list" style="font-size:13px">Loading...</div>
      </div>
      <div class="section-title">Import Contacts</div>
      <div class="card">
        <div style="display:flex;gap:12px;margin-bottom:12px">
          <label class="btn btn-primary" style="cursor:pointer">
            <input type="file" id="import-file" accept=".vcf,.csv,.txt" style="display:none">
            Upload .vcf / .csv
          </label>
          <span id="import-filename" style="font-size:13px;color:var(--muted);line-height:36px"></span>
        </div>
        <p style="color:var(--muted);margin:0 0 12px;font-size:13px">Or paste below — one contact per line: <code>number,name</code> or just <code>number</code>. vCard content also works.</p>
        <textarea id="import-text" rows="8" placeholder="254712345678,John Doe&#10;254798765432&#10;--- or paste vCard (BEGIN:VCARD...) ---" class="input"></textarea>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
          <button id="import-btn" class="btn btn-primary">Import</button>
          <button id="sync-btn" class="btn">Sync WhatsApp</button>
          <span id="import-result" style="font-size:13px;color:var(--muted)"></span>
        </div>
      </div>
    `;
    // Fetch config
    try {
      const cfg = await api('/api/config');
      $('#cfg-ai').textContent = 'Gemini';
      $('#cfg-model').textContent = cfg.modelName || '';
      $('#cfg-timeout').textContent = cfg.timeout || '30000';
      $('#cfg-ratelimit').textContent = cfg.rateLimit || '2000';
    } catch {}

    // Pending registrations: load list + wire approve/reject
    const regList = $('#reg-list');
    async function loadRegistrations() {
      if (!regList) return;
      try {
        const rows = await api('/api/registrations');
        if (!rows.length) { regList.innerHTML = '<div style="color:var(--muted)">No pending registrations.</div>'; return; }
        regList.innerHTML = rows.map(r => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
            <div style="flex:1">
              <div style="font-weight:600">${esc(r.wa_name || r.submitted_name || 'Unknown')}</div>
              <div style="color:var(--muted);font-size:12px">${esc(r.phone)}</div>
            </div>
            <button class="btn btn-sm btn-primary" onclick="window._regApprove('${esc(r.chat_id)}')">Approve</button>
            <button class="btn btn-sm btn-red" onclick="window._regReject('${esc(r.chat_id)}')">Reject</button>
          </div>`).join('');
      } catch (e) {
        regList.innerHTML = '<div style="color:var(--red)">Failed to load registrations.</div>';
      }
    }
    window._regApprove = async (chatId) => {
      try { const r = await post(`/api/registrations/${encodeURIComponent(chatId)}/approve`, {}); if (r.ok) toast('Registered ' + chatId); await loadRegistrations(); }
      catch (e) { toast('Approve failed: ' + (e.message || 'error'), 'error'); }
    };
    window._regReject = async (chatId) => {
      if (!confirm('Permanently drop this contact and all its data?')) return;
      try { const r = await post(`/api/registrations/${encodeURIComponent(chatId)}/reject`, {}); if (r.ok) toast('Rejected & dropped ' + chatId); await loadRegistrations(); }
      catch (e) { toast('Reject failed: ' + (e.message || 'error'), 'error'); }
    };
    loadRegistrations();

    // Wire up import button and file upload
    const importBtn = $('#import-btn');
    const importFile = $('#import-file');
    const importFilename = $('#import-filename');
    if (importFile) importFile.onchange = () => {
      const file = importFile.files[0];
      if (!file) return;
      importFilename.textContent = file.name;
      const reader = new FileReader();
      reader.onload = () => { $('#import-text').value = reader.result; };
      reader.readAsText(file);
    };
    if (importBtn) importBtn.onclick = async () => {
      const text = $('#import-text').value.trim();
      const result = $('#import-result');
      if (!text) { result.textContent = 'Paste some numbers or upload a .vcf file'; result.style.color = 'var(--red)'; return; }
      const isVCard = text.toUpperCase().includes('BEGIN:VCARD');
      result.textContent = 'Importing...';
      result.style.color = 'var(--muted)';
      try {
        let res;
        if (isVCard) {
          res = await post('/api/contacts/import', { vcard: text });
        } else {
          const lines = text.split('\n').filter(l => l.trim());
          const contacts = lines.map(l => {
            const [phone, ...nameParts] = l.split(',');
            return { phone: phone.trim(), name: nameParts.join(',').trim() };
          });
          res = await post('/api/contacts/import', { contacts });
        }
        result.textContent = `Done: ${res.added} added, ${res.updated} updated, ${res.skipped || 0} skipped (of ${res.total})`;
        result.style.color = 'var(--green)';
        $('#import-text').value = '';
        if (importFilename) importFilename.textContent = '';
      } catch (err) {
        result.textContent = 'Error: ' + err.message;
        result.style.color = 'var(--red)';
      }
    };
    // Sync button handler
    const syncBtn = $('#sync-btn');
    if (syncBtn) syncBtn.onclick = async () => {
      const result = $('#import-result');
      result.textContent = 'Syncing WhatsApp contacts...';
      result.style.color = 'var(--muted)';
      try {
        const res = await post('/api/contacts/sync', {});
        result.textContent = `Sync: ${res.matched} on WhatsApp, ${res.unmatched} not found (of ${res.total})`;
        result.style.color = 'var(--green)';
      } catch (err) {
        result.textContent = 'Sync error: ' + err.message;
        result.style.color = 'var(--red)';
      }
    };
  }

  // ── Routes ──
  route('#/overview', renderOverview);
  route('#/chats', renderChats);
  route('#/tasks', renderTasks);
  route('#/settings', renderSettings);

  // ── SSE wiring ──
  onSSE('message', () => { if (currentView === 'chats' && selectedChat) loadChatMessages(selectedChat); });
  onSSE('draft', () => { if (currentView === 'chats' && selectedChat) loadDraftArea(selectedChat); });
  onSSE('task', () => { if (currentView === 'tasks') loadTaskList(); refreshTaskBadge(); });
  onSSE('eval', () => { if (currentView === 'overview') loadOverviewData(); });
  onSSE('contact', () => { if (currentView === 'chats') loadContactList(); });
  onSSE('status', (d) => {
    const el = $('#conn-status');
    el.className = 'conn-badge ' + (d.connected ? 'conn-on' : d.qr ? 'conn-qr' : 'conn-off');
    $('.conn-text', el).textContent = d.connected ? 'Online' : d.qr ? 'Scan QR' : 'Offline';
  });

  // ── Init ── (called by auth-boot.js once gateway.js has registered its routes)
  function start() {
    if (Auth.isOwner) {
      refreshStatus();
      refreshTaskBadge();
      setInterval(refreshStatus, 15000);
      setInterval(refreshTaskBadge, 30000);
    }
    connectSSE();
    navigate();
  }

  // Small API so add-on pages (gateway.js) can register views.
  window.KamilaDash = { $, $$, esc, toast, timeAgo, route, onSSE, navigate, authedFetch, start, onLeave: null };

})();
