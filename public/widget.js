/*!
 * Kamila chat widget. Drop on any website:
 *   <script src="https://YOUR-KAMILA-HOST/widget.js" data-key="wpk_..." defer></script>
 * Options (data-*): key (required), api (defaults to this script's origin),
 * position ("right" | "left"), open ("true" to start open).
 * The page's origin must be listed under the project's Allowed origins.
 */
(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[src*="widget.js"][data-key]');
  if (!script || window.__kamilaWidget) return;
  window.__kamilaWidget = true;

  var KEY = script.getAttribute('data-key') || '';
  var API = (script.getAttribute('data-api') || new URL(script.src).origin).replace(/\/+$/, '');
  var LEFT = script.getAttribute('data-position') === 'left';
  var START_OPEN = script.getAttribute('data-open') === 'true';
  var STORE = 'kamila_widget_' + KEY.slice(4, 16);
  var SIDE = LEFT ? 'left' : 'right';

  function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function save(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { /* private mode */ } }
  function newVisitor() {
    var a = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = Math.random() * 256;
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  var state = load();
  if (!state.visitor) state.visitor = newVisitor();
  state.messages = Array.isArray(state.messages) ? state.messages.slice(-40) : [];

  // Readable text colour (black or white) for the brand colour, by WCAG contrast.
  function ink(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    var n = parseInt(m[1], 16);
    var lum = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var l = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
    return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#fff' : '#111';
  }

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
  var ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:20px;' + SIDE + ':20px';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  root.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;margin:0;padding:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    'svg{width:20px;height:20px;display:block}' +
    'button{font:inherit}button:focus-visible,.k-in:focus-visible{outline:2px solid var(--k);outline-offset:2px}' +
    '.k-btn{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:var(--k);color:var(--ki);display:grid;place-items:center;box-shadow:0 8px 24px rgba(0,0,0,.22),0 2px 6px rgba(0,0,0,.12);transition:transform .15s ease}' +
    '.k-btn:hover{transform:scale(1.06)}.k-btn svg{width:26px;height:26px}' +
    '.k-panel{position:absolute;bottom:72px;' + SIDE + ':0;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 110px);background:#fff;color:#171717;border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.22),0 0 0 1px rgba(0,0,0,.06);display:none;flex-direction:column;overflow:hidden}' +
    '.k-panel.open{display:flex;animation:k-in .2s cubic-bezier(.2,.8,.2,1)}@keyframes k-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}' +
    '.k-head{background:var(--k);color:var(--ki);padding:14px 10px 14px 16px;display:flex;align-items:center;gap:10px}' +
    '.k-av{position:relative;width:38px;height:38px;border-radius:50%;background:rgba(127,127,127,.25);display:grid;place-items:center;font-weight:700;font-size:16px;flex-shrink:0}' +
    '.k-av::after{content:"";position:absolute;right:0;bottom:0;width:10px;height:10px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px var(--k)}' +
    '.k-who{min-width:0;flex:1}.k-title{font-weight:600;font-size:15px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.k-sub{font-size:12px;opacity:.8}' +
    '.k-icon{background:none;border:0;color:inherit;cursor:pointer;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;opacity:.85;flex-shrink:0}.k-icon:hover{opacity:1;background:rgba(127,127,127,.22)}.k-icon svg{width:18px;height:18px}' +
    '.k-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:#f7f7f8;scroll-behavior:smooth}' +
    '.k-msg{max-width:84%;padding:9px 13px;border-radius:16px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}' +
    '.k-msg a{color:inherit;text-decoration:underline;text-underline-offset:2px}' +
    '.k-bot{background:#fff;border:1px solid #ececec;align-self:flex-start;border-bottom-left-radius:5px}' +
    '.k-me{background:var(--k);color:var(--ki);align-self:flex-end;border-bottom-right-radius:5px}' +
    '.k-err{background:#fff1f1;color:#b42318;border:1px solid #fecdca;align-self:center;font-size:13px;text-align:center}' +
    '.k-typing{display:flex;gap:4px;padding:13px 14px}.k-typing i{width:6px;height:6px;border-radius:50%;background:#9a9a9a;animation:k-b 1s infinite}' +
    '.k-typing i:nth-child(2){animation-delay:.15s}.k-typing i:nth-child(3){animation-delay:.3s}@keyframes k-b{0%,100%{opacity:.3;transform:none}50%{opacity:1;transform:translateY(-2px)}}' +
    '.k-form{display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid #eee;background:#fff}' +
    '.k-in{flex:1;border:1px solid #e3e3e3;border-radius:12px;padding:10px 12px;font-size:14px;line-height:1.4;outline:none;color:#171717;background:#fff;resize:none;max-height:120px;min-height:42px;font-family:inherit}.k-in:focus{border-color:var(--k)}' +
    '.k-send{border:0;border-radius:12px;background:var(--k);color:var(--ki);width:42px;height:42px;display:grid;place-items:center;cursor:pointer;flex-shrink:0;transition:opacity .15s}.k-send:disabled{opacity:.4;cursor:default}' +
    '.k-foot{text-align:center;font-size:11px;color:#a3a3a3;padding:0 0 8px;background:#fff}' +
    '@media (max-width:480px){.k-panel{position:fixed;inset:0;width:auto;max-width:none;height:auto;max-height:none;border-radius:0;bottom:0}.k-panel.open~.k-btn{display:none}}' +
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}' +
    '</style>' +
    '<div class="k-panel" role="dialog" aria-label="Chat" aria-modal="false">' +
      '<div class="k-head"><div class="k-av" aria-hidden="true"></div><div class="k-who"><div class="k-title"></div><div class="k-sub">Online · replies instantly</div></div>' +
      '<button class="k-icon k-new" type="button" aria-label="Start a new conversation" title="New conversation">' + ICON_NEW + '</button>' +
      '<button class="k-icon k-x" type="button" aria-label="Close chat" title="Close">' + ICON_X + '</button></div>' +
      '<div class="k-body" role="log" aria-live="polite"></div>' +
      '<form class="k-form"><textarea class="k-in" rows="1" placeholder="Type your message…" maxlength="1000" aria-label="Message"></textarea>' +
      '<button class="k-send" type="submit" aria-label="Send" disabled>' + ICON_SEND + '</button></form>' +
      '<div class="k-foot">Powered by Kamila</div></div>' +
    '<button class="k-btn" type="button" aria-label="Open chat" aria-expanded="false">' + ICON_CHAT + '</button>';

  var $ = function (s) { return root.querySelector(s); };
  var panel = $('.k-panel'), body = $('.k-body'), input = $('.k-in'), send = $('.k-send'), launcher = $('.k-btn');
  var config = null;
  var waiting = false;

  // Text with http(s) links turned into anchors, built from DOM nodes (no HTML parsing).
  var URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,:;!?)\]]/g;
  function fill(el, text, links) {
    if (!links) { el.textContent = text; return; }
    var last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      el.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }

  function render() {
    body.innerHTML = '';
    var list = state.messages.length ? state.messages : (config ? [{ r: 'bot', t: config.greeting }] : []);
    list.forEach(function (m) { add(m.r, m.t, true); });
  }
  function add(role, text, silent) {
    var el = document.createElement('div');
    el.className = 'k-msg ' + (role === 'me' ? 'k-me' : role === 'err' ? 'k-err' : 'k-bot');
    fill(el, text, role === 'bot');
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    if (!silent && role !== 'err') { state.messages.push({ r: role, t: text }); state.messages = state.messages.slice(-40); save(state); }
  }
  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    send.disabled = waiting || !input.value.trim();
  }
  function toggle(open) {
    panel.classList.toggle('open', open);
    launcher.setAttribute('aria-expanded', String(open));
    launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    launcher.innerHTML = open ? ICON_X : ICON_CHAT;
    if (open) { render(); setTimeout(function () { input.focus(); }, 50); }
  }

  fetch(API + '/v1/widget/config?key=' + encodeURIComponent(KEY))
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Chat unavailable'); return j; }); })
    .then(function (c) {
      config = c;
      var color = c.color || '#111111';
      host.style.setProperty('--k', color);
      host.style.setProperty('--ki', ink(color));
      $('.k-title').textContent = c.title;
      $('.k-av').textContent = (c.title || 'K').trim().charAt(0).toUpperCase();
      document.body.appendChild(host);
      if (START_OPEN) toggle(true);
    })
    .catch(function (e) { if (window.console) console.warn('[Kamila widget]', e.message || e); });

  launcher.onclick = function () { toggle(!panel.classList.contains('open')); };
  $('.k-x').onclick = function () { toggle(false); launcher.focus(); };
  $('.k-new').onclick = function () {
    state = { visitor: newVisitor(), messages: [] };
    save(state);
    render();
    input.focus();
  };
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { toggle(false); launcher.focus(); } });
  input.addEventListener('input', grow);
  // Enter sends, Shift+Enter adds a new line.
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('.k-form').requestSubmit ? $('.k-form').requestSubmit() : $('.k-form').onsubmit(e); }
  });
  $('.k-form').onsubmit = function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || waiting) return;
    if (!state.messages.length && config) state.messages.push({ r: 'bot', t: config.greeting });
    add('me', text);
    input.value = '';
    waiting = true;
    grow();
    var typing = document.createElement('div');
    typing.className = 'k-msg k-bot k-typing';
    typing.setAttribute('aria-label', 'Typing');
    typing.innerHTML = '<i></i><i></i><i></i>';
    body.appendChild(typing);
    body.scrollTop = body.scrollHeight;
    // text/plain keeps this a "simple" CORS request (no preflight).
    fetch(API + '/v1/widget/chat', { method: 'POST', body: JSON.stringify({ key: KEY, visitor: state.visitor, message: text }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; }); })
      .then(function (j) { typing.remove(); add('bot', j.reply || "Sorry, I don't have an answer for that."); })
      .catch(function (err) { typing.remove(); add('err', err.message || 'Could not send. Please try again.'); })
      .then(function () { waiting = false; grow(); input.focus(); });
  };
})();
