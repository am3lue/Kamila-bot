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
  const apiKey = () => localStorage.getItem('kamila_api_key') || '';
  let shown401Toast = false;
  function apiErr(r, msg) {
    const e = new Error(msg || 'API error');
    e.status = r.status;
    return e;
  }
  const api = (u) => fetch(u, { headers: { 'x-api-key': apiKey() } }).then(r => {
    if (!r.ok) {
      if (r.status === 401 && !shown401Toast) { shown401Toast = true; toast('API key required — go to Settings to enter it', 'error'); }
      throw apiErr(r, `GET ${u} failed (${r.status})`);
    }
    return r.json();
  });
  const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey() }, body: JSON.stringify(b) }).then(r => {
    if (!r.ok) {
      if (r.status === 401 && !shown401Toast) { shown401Toast = true; toast('API key required — go to Settings to enter it', 'error'); }
      throw apiErr(r, `POST ${u} failed (${r.status})`);
    }
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
  let sseConnected = false;
  let pollInterval = null;
  const sseListeners = {};

  function onSSE(event, fn) {
    if (!sseListeners[event]) sseListeners[event] = [];
    sseListeners[event].push(fn);
  }

  function connectSSE() {
    if (evtSource) evtSource.close();
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    evtSource = new EventSource('/api/events');
    evtSource.onopen = () => {
      sseConnected = true;
      console.log('[SSE] Connected');
    };
    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        (sseListeners['message'] || []).forEach(fn => fn(data));
      } catch {}
    };
    for (const ev of ['message', 'draft', 'task', 'eval', 'contact', 'status', 'broadcast', 'enhance']) {
      evtSource.addEventListener(ev, (e) => {
        try {
          const data = JSON.parse(e.data);
          (sseListeners[ev] || []).forEach(fn => fn(data));
        } catch {}
      });
    }
    evtSource.onerror = () => {
      sseConnected = false;
      console.warn('[SSE] Disconnected, reconnecting in 3s...');
      evtSource.close();
      setTimeout(connectSSE, 3000);
      startPollingFallback();
    };
  }

  function startPollingFallback() {
    if (pollInterval) return;
    console.log('[Poll] Starting fallback polling (5s)');
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

  function route(hash, handler) {
    routes[hash] = handler;
  }

  function navigate() {
    const hash = location.hash || '#/overview';
    const handler = routes[hash];
    if (!handler) { location.hash = '#/overview'; return; }
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.getAttribute('href') === hash));
    currentView = hash.replace('#/', '');
    // Chats view is full-bleed: no page scroll, only the two panels scroll internally
    $('#main-content').classList.toggle('chat-view-active', currentView === 'chats');
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
      $('.conn-text', el).textContent = s.connected ? 'Connected' : s.hasQr ? 'Scan QR' : 'Disconnected';
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
    if (charts.volume) charts.volume.destroy();
    const volLabels = data.volume.map(v => v.day.slice(5));
    charts.volume = new Chart($('#chart-volume'), {
      type: 'bar', data: {
        labels: volLabels,
        datasets: [
          { label: 'Total', data: data.volume.map(v => v.messages), backgroundColor: 'rgba(139,92,246,.4)', borderColor: '#8b5cf6', borderWidth: 1 },
          { label: 'AI', data: data.volume.map(v => v.ai), backgroundColor: 'rgba(34,197,94,.4)', borderColor: '#22c55e', borderWidth: 1 },
        ]
      }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#94a3b8' } } }, scales: { x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } } } }
    });

    // Sentiment chart
    if (charts.sentiment) charts.sentiment.destroy();
    const sentLabels = Object.keys(data.sentimentMix);
    const sentColors = sentLabels.map(s => s === 'positive' ? '#22c55e' : s === 'negative' ? '#ef4444' : '#eab308');
    charts.sentiment = new Chart($('#chart-sentiment'), {
      type: 'doughnut', data: { labels: sentLabels, datasets: [{ data: Object.values(data.sentimentMix), backgroundColor: sentColors }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#94a3b8' } } } }
    });

    // Mode chart
    if (charts.mode) charts.mode.destroy();
    const modeLabels = Object.keys(data.modeMix);
    const modeColors = modeLabels.map(m => m === 'AUTO' ? '#22c55e' : m === 'DRAFT' ? '#eab308' : '#ef4444');
    charts.mode = new Chart($('#chart-mode'), {
      type: 'doughnut', data: { labels: modeLabels, datasets: [{ data: Object.values(data.modeMix), backgroundColor: modeColors }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#94a3b8' } } } }
    });

    // Task chart
    if (charts.tasks) charts.tasks.destroy();
    charts.tasks = new Chart($('#chart-tasks'), {
      type: 'doughnut', data: { labels: ['Done', 'Pending'], datasets: [{ data: [data.taskCompletion.done, data.taskCompletion.pending], backgroundColor: ['#22c55e', '#eab308'] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#94a3b8' } } } }
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
              <button class="btn btn-sm" id="drop-btn" style="background:var(--red);color:#fff;border:none;cursor:pointer;margin-left:6px">Drop</button>
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
        <div class="setting-row"><span class="setting-key">OLLAMA_URL</span><span class="setting-val" id="cfg-ollama">Loading...</span></div>
        <div class="setting-row"><span class="setting-key">MODEL_NAME</span><span class="setting-val" id="cfg-model">Loading...</span></div>
        <div class="setting-row"><span class="setting-key">AXIOS_TIMEOUT_MS</span><span class="setting-val" id="cfg-timeout">Loading...</span></div>
        <div class="setting-row"><span class="setting-key">RATE_LIMIT_COOLDOWN_MS</span><span class="setting-val" id="cfg-ratelimit">Loading...</span></div>
      </div>
      <div class="section-title">API Key</div>
      <div class="card">
        <p style="color:var(--muted);margin:0 0 10px;font-size:13px">This dashboard is protected by an API key (set <code>API_KEY</code> in <code>.env</code>). Enter it here so the dashboard can talk to the server.</p>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="api-key-input" type="password" placeholder="Enter API key..." style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:13px" autocomplete="off">
          <button id="api-key-save" class="btn" style="background:var(--accent);color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600">Save</button>
          <span id="api-key-status" style="font-size:12px;color:var(--muted)"></span>
        </div>
      </div>
      <div class="section-title">Pending Registrations</div>
      <div class="card">
        <p style="color:var(--muted);margin:0 0 10px;font-size:13px">New numbers that messaged you and are waiting for registry approval. Approve to register them (AI replies continue), or reject to drop them.</p>
        <div id="reg-list" style="font-size:13px">Loading...</div>
      </div>
      <div class="section-title">Import Contacts</div>
      <div class="card">
        <div style="display:flex;gap:12px;margin-bottom:12px">
          <label class="btn" style="background:var(--accent);color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;display:inline-flex;align-items:center;gap:6px">
            <input type="file" id="import-file" accept=".vcf,.csv,.txt" style="display:none">
            Upload .vcf / .csv
          </label>
          <span id="import-filename" style="font-size:13px;color:var(--muted);line-height:36px"></span>
        </div>
        <p style="color:var(--muted);margin:0 0 12px;font-size:13px">Or paste below — one contact per line: <code>number,name</code> or just <code>number</code>. vCard content also works.</p>
        <textarea id="import-text" rows="8" placeholder="254712345678,John Doe&#10;254798765432&#10;--- or paste vCard (BEGIN:VCARD...) ---" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:monospace;font-size:13px;resize:vertical"></textarea>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
          <button id="import-btn" class="btn" style="background:var(--accent);color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600">Import</button>
          <button id="sync-btn" class="btn" style="background:var(--green);color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600">Sync WhatsApp</button>
          <span id="import-result" style="font-size:13px;color:var(--muted)"></span>
        </div>
      </div>
    `;
    // Fetch config
    try {
      const cfg = await api('/api/config');
      $('#cfg-ollama').textContent = cfg.ollamaUrl || 'http://localhost:11434';
      $('#cfg-model').textContent = cfg.modelName || 'kamila';
      $('#cfg-timeout').textContent = cfg.timeout || '30000';
      $('#cfg-ratelimit').textContent = cfg.rateLimit || '2000';
    } catch {}

    // API key: prefill from localStorage, save on click
    const apiKeyInput = $('#api-key-input');
    const apiKeySave = $('#api-key-save');
    const apiKeyStatus = $('#api-key-status');
    if (apiKeyInput) apiKeyInput.value = localStorage.getItem('kamila_api_key') || '';
    if (apiKeySave) apiKeySave.onclick = async () => {
      const key = (apiKeyInput.value || '').trim();
      if (!key) { apiKeyStatus.textContent = 'Key cleared'; apiKeyStatus.style.color = 'var(--muted)'; }
      else { apiKeyStatus.textContent = 'Saving...'; apiKeyStatus.style.color = 'var(--muted)'; }
      localStorage.setItem('kamila_api_key', key);
      // Test the key
      try {
        const r = await fetch('/api/stats', { headers: { 'x-api-key': key } });
        if (r.ok) { apiKeyStatus.textContent = key ? 'Saved & working ✓' : 'No key — running open'; apiKeyStatus.style.color = 'var(--green)'; }
        else { apiKeyStatus.textContent = 'Saved (test failed: uses ?key or header)'; apiKeyStatus.style.color = 'var(--yellow)'; }
      } catch {
        apiKeyStatus.textContent = 'Saved (server unreachable)'; apiKeyStatus.style.color = 'var(--yellow)';
      }
    };

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
            <button class="btn btn-sm" style="background:var(--green);color:#fff;border:none;cursor:pointer" onclick="window._regApprove('${esc(r.chat_id)}')">Approve</button>
            <button class="btn btn-sm" style="background:var(--red);color:#fff;border:none;cursor:pointer" onclick="window._regReject('${esc(r.chat_id)}')">Reject</button>
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

  // ══════════════════════════════════
  // VIEW: Broadcast
  // ══════════════════════════════════

  async function renderBroadcast() {
    const mount = $('#view-mount');
    mount.innerHTML = `
      <div class="section-title">Broadcast Message</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <div class="card" style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <strong>Select Contacts</strong>
              <div style="display:flex;gap:6px">
                <button id="bc-select-all" class="btn-sm" style="background:var(--border);color:var(--text);border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">All</button>
                <button id="bc-select-none" class="btn-sm" style="background:var(--border);color:var(--text);border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">None</button>
                <span id="bc-selected-count" style="font-size:12px;color:var(--muted);line-height:24px">0 selected</span>
              </div>
            </div>
            <input id="bc-search" type="text" placeholder="Search contacts..." style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:13px;margin-bottom:8px">
            <div id="bc-contact-list" style="max-height:400px;overflow-y:auto;font-size:13px"></div>
          </div>
        </div>
        <div>
          <div class="card" style="margin-bottom:12px">
            <strong>Message</strong>
            <textarea id="bc-message" rows="6" placeholder="Write your broadcast message here..." style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:13px;margin-top:8px;resize:vertical"></textarea>
            <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
              <select id="bc-enhance-mode" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:13px">
                <option value="professional">Professional</option>
                <option value="casual">Casual</option>
                <option value="friendly">Friendly</option>
                <option value="formal">Formal</option>
                <option value="polish">Polish</option>
              </select>
              <button id="bc-enhance-btn" style="background:var(--accent);color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">AI Enhance</button>
              <span id="bc-enhance-status" style="font-size:12px;color:var(--muted)"></span>
            </div>
          </div>
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <strong>Send Settings</strong>
            </div>
            <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
              <label style="font-size:13px;color:var(--muted)">Delay between messages:</label>
              <select id="bc-delay" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px;font-size:13px">
                <option value="1000">1 second</option>
                <option value="2000" selected>2 seconds</option>
                <option value="5000">5 seconds</option>
                <option value="10000">10 seconds</option>
              </select>
            </div>
            <button id="bc-send-btn" style="width:100%;background:var(--green);color:#fff;border:none;padding:12px;border-radius:6px;cursor:pointer;font-size:15px;font-weight:700">Send Broadcast</button>
            <div id="bc-result" style="margin-top:10px;font-size:13px;color:var(--muted)"></div>
          </div>
        </div>
      </div>
    `;

    // Load contacts
    let contacts;
    try { contacts = await api('/api/contacts'); } catch {}
    if (!Array.isArray(contacts)) contacts = [];
    const list = $('#bc-contact-list');
    const selected = new Set(loadState('bc_selected', []));

    function renderContacts(filter = '') {
      const filtered = contacts.filter(c =>
        (c.name || '').toLowerCase().includes(filter.toLowerCase()) ||
        (c.phone_number || '').includes(filter)
      );
      list.innerHTML = filtered.map(c => `
        <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;border-bottom:1px solid var(--border)">
          <input type="checkbox" data-phone="${esc(c.phone_number)}" ${selected.has(c.phone_number) ? 'checked' : ''}>
          <span style="flex:1">${esc(c.name || c.phone_number)}</span>
          <span style="color:var(--muted);font-size:11px">${esc(c.phone_number)}</span>
        </label>
      `).join('');
      list.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.onchange = () => {
          if (cb.checked) selected.add(cb.dataset.phone); else selected.delete(cb.dataset.phone);
          updateCount();
          saveState('bc_selected', [...selected]);
        };
      });
    }

    function updateCount() {
      $('#bc-selected-count').textContent = selected.size + ' selected';
    }

    renderContacts();
    updateCount();
    $('#bc-search').oninput = (e) => renderContacts(e.target.value);
    $('#bc-select-all').onclick = () => { contacts.forEach(c => selected.add(c.phone_number)); renderContacts($('#bc-search').value); updateCount(); saveState('bc_selected', [...selected]); };
    $('#bc-select-none').onclick = () => { selected.clear(); renderContacts($('#bc-search').value); updateCount(); saveState('bc_selected', [...selected]); };

    // Restore saved message
    const savedMsg = loadState('bc_message', '');
    if (savedMsg) $('#bc-message').value = savedMsg;

    // Save message on input
    $('#bc-message').addEventListener('input', (e) => saveState('bc_message', e.target.value));

    // AI Enhance
    $('#bc-enhance-btn').onclick = async () => {
      const text = $('#bc-message').value.trim();
      const status = $('#bc-enhance-status');
      if (!text) { status.textContent = 'Write a message first'; status.style.color = 'var(--red)'; return; }
      status.textContent = 'Enhancing...';
      status.style.color = 'var(--muted)';
      try {
        const mode = $('#bc-enhance-mode').value;
        const res = await post('/api/enhance', { text, mode });
        $('#bc-message').value = res.enhanced;
        status.textContent = 'Enhanced!';
        status.style.color = 'var(--green)';
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
        status.style.color = 'var(--red)';
      }
    };

    // Send broadcast
    $('#bc-send-btn').onclick = async () => {
      const phones = [...selected];
      const text = $('#bc-message').value.trim();
      const result = $('#bc-result');
      if (phones.length === 0) { result.textContent = 'Select at least one contact'; result.style.color = 'var(--red)'; return; }
      if (!text) { result.textContent = 'Write a message'; result.style.color = 'var(--red)'; return; }
      const delay = Number($('#bc-delay').value);
      result.textContent = `Sending to ${phones.length} contacts...`;
      result.style.color = 'var(--muted)';
      $('#bc-send-btn').disabled = true;
      try {
        const res = await post('/api/broadcast', { contacts: phones, text, delayMs: delay });
        result.innerHTML = `Sent: <strong>${res.sent}</strong> / Failed: <strong>${res.failed}</strong> / Total: ${res.total}`;
        result.style.color = res.failed > 0 ? 'var(--yellow)' : 'var(--green)';
      } catch (err) {
        result.textContent = 'Error: ' + err.message;
        result.style.color = 'var(--red)';
      }
      $('#bc-send-btn').disabled = false;
    };
  }

  // ── Routes ──
  route('#/overview', renderOverview);
  route('#/chats', renderChats);
  route('#/tasks', renderTasks);
  route('#/broadcast', renderBroadcast);
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
    $('.conn-text', el).textContent = d.connected ? 'Connected' : d.qr ? 'Scan QR' : 'Disconnected';
  });

  // ── Init ──
  refreshStatus();
  refreshTaskBadge();
  setInterval(refreshStatus, 15000);
  setInterval(refreshTaskBadge, 30000);
  connectSSE();
  navigate();

  // Cleanup on view change
  const origRender = { overview: renderOverview, chats: renderChats, tasks: renderTasks, settings: renderSettings };
})();
