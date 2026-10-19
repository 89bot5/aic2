'use strict';

const $ = (id) => document.getElementById(id);
const BASE = document.querySelector('meta[name=base]')?.content || '';
const els = {
  app: $('app'), sidebar: $('sidebar'), scrim: $('scrim'), toggle: $('sidebarToggle'), resizer: $('resizer'), newChat: $('newChat'),
  sysPrompt: $('sysPrompt'), sysText: $('sysText'), sysMore: $('sysMore'),
  dialog: $('promptDialog'), promptForm: $('promptForm'), promptInput: $('promptInput'), promptName: $('promptChatName'),
  promptClear: $('promptClear'), promptCancel: $('promptCancel'),
  keyBtn: $('keyBtn'), keyDialog: $('keyDialog'), keyForm: $('keyForm'), keyStatus: $('keyStatus'),
  keyInput: $('keyInput'), modelInput: $('modelInput'), keyRemove: $('keyRemove'), keyCancel: $('keyCancel'),
  chatList: $('chatList'), title: $('chatTitle'), thread: $('thread'), messages: $('messages'),
  empty: $('empty'), composer: $('composer'), input: $('input'), send: $('send'), stop: $('stop'),
};

const ICONS = {
  copy: '<svg viewBox="0 0 20 20"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M4 13V5a1 1 0 0 1 1-1h8"/></svg>',
  retry: '<svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 1 0 2-4.5M4 4v3h3"/></svg>',
  cog: '<svg viewBox="0 0 20 20"><path d="M15.64 8.26L17.49 8.71L17.49 11.29L15.64 11.74L15.22 12.75L16.21 14.39L14.39 16.21L12.75 15.22L11.74 15.64L11.29 17.49L8.71 17.49L8.26 15.64L7.25 15.22L5.61 16.21L3.79 14.39L4.78 12.75L4.36 11.74L2.51 11.29L2.51 8.71L4.36 8.26L4.78 7.25L3.79 5.61L5.61 3.79L7.25 4.78L8.26 4.36L8.71 2.51L11.29 2.51L11.74 4.36L12.75 4.78L14.39 3.79L16.21 5.61L15.22 7.25Z"/><circle cx="10" cy="10" r="2.3"/></svg>',
  edit: '<svg viewBox="0 0 20 20"><path d="M13.5 4.5l2 2L8 14H6v-2z"/></svg>',
  x: '<svg viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
  trash: '<svg viewBox="0 0 20 20"><path d="M5 6h10M8 6V4.5h4V6M6.5 6l.5 9.5h6l.5-9.5"/></svg>',
};

const GAUGE = {
  default: '<svg viewBox="0 0 20 20"><path d="M3 13.5a7 7 0 0 1 14 0"/><path d="M10 13.5L10.00 8.30"/><circle cx="10" cy="13.5" r="1.1" fill="currentColor"/></svg>',
  low: '<svg viewBox="0 0 20 20"><path d="M3 13.5a7 7 0 0 1 14 0"/><path d="M10 13.5L5.50 10.90"/><circle cx="10" cy="13.5" r="1.1" fill="currentColor"/></svg>',
  high: '<svg viewBox="0 0 20 20"><path d="M3 13.5a7 7 0 0 1 14 0"/><path d="M10 13.5L13.98 10.16"/><circle cx="10" cy="13.5" r="1.1" fill="currentColor"/></svg>',
  max: '<svg viewBox="0 0 20 20"><path d="M3 13.5a7 7 0 0 1 14 0"/><path d="M10 13.5L15.15 12.78"/><circle cx="10" cy="13.5" r="1.1" fill="currentColor"/></svg>',
};
const EFFORT_OPTIONS = [
  { value: null, label: 'Default', hint: "Don't send a setting" },
  { value: 'low', label: 'Low', hint: 'Faster, shorter thinking' },
  { value: 'high', label: 'High', hint: 'More thorough' },
  { value: 'max', label: 'Max', hint: 'Thinks the longest' },
];
const effortLabel = (v) => EFFORT_OPTIONS.find((o) => o.value === (v || null)).label;

let chats = [];
let currentId = null;
let streaming = null; // AbortController while a reply is streaming
let streamingChat = null;
let stopTimer = null;

// ---------- markdown ----------
marked.setOptions({ gfm: true, breaks: false });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});
function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['style', 'form', 'input', 'button'] });
}
// Some models put their reasoning inline as <think>…</think>; split it out.
function splitThink(content, reasoning) {
  const m = content.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
  if (!m) return { content, reasoning };
  return { content: content.slice(m[0].length).trimStart(), reasoning: (reasoning || '') + m[1] };
}

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.reload(); throw new Error('Logged out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- sidebar ----------
function groupLabel(date) {
  const d = new Date(date), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 864e5;
  if (diff < 1) return 'Today';
  if (diff < 2) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return 'Older';
}

function renderSidebar() {
  els.chatList.textContent = '';
  let lastGroup = null;
  for (const chat of chats) {
    const g = groupLabel(chat.updated_at);
    if (g !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'group'; h.textContent = g;
      els.chatList.append(h);
      lastGroup = g;
    }
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === currentId ? ' active' : '');
    const a = document.createElement('a');
    a.href = `${BASE}/c/${chat.id}`;
    a.textContent = chat.title;
    a.title = chat.title;
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      openChat(chat.id, true);
      closeSidebar();
    });
    const actions = document.createElement('div');
    actions.className = 'actions';
    const gauge = button(GAUGE[chat.reasoning_effort || 'default'], 'Reasoning effort', (e) => openEffortMenu(chat, e.currentTarget));
    gauge.title = `Reasoning: ${effortLabel(chat.reasoning_effort)}`;
    if (chat.reasoning_effort) gauge.classList.add('on');
    const cog = button(ICONS.cog, 'System prompt', () => openPromptDialog(chat));
    if (chat.has_prompt) cog.classList.add('on');
    const ren = button(ICONS.edit, 'Rename', () => startRename(item, chat));
    const del = button(ICONS.trash, 'Delete', () => deleteChat(chat));
    actions.append(gauge, cog, ren, del);
    item.append(a, actions);
    els.chatList.append(item);
  }
}

function button(icon, label, onClick, text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = icon + (text ? `<span>${text}</span>` : '');
  b.setAttribute('aria-label', label);
  b.title = label;
  b.addEventListener('click', onClick);
  return b;
}

function startRename(item, chat) {
  const input = document.createElement('input');
  input.value = chat.title;
  item.textContent = '';
  item.append(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const title = input.value.trim();
    if (save && title && title !== chat.title) {
      chat.title = title;
      if (chat.id === currentId) els.title.textContent = title;
      api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { title } }).catch(alert);
    }
    renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function deleteChat(chat) {
  if (!confirm(`Delete "${chat.title}"?`)) return;
  await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
  chats = chats.filter((c) => c.id !== chat.id);
  if (chat.id === currentId) newChat(true);
  else renderSidebar();
}

async function loadChats() {
  // The server tidies up untouched empty chats (e.g. left behind by a closed tab),
  // except the one this URL points at.
  const keep = chatIdFromUrl();
  chats = await api('/api/chats' + (keep ? `?keep=${keep}` : ''));
  renderSidebar();
}

const currentChat = () => chats.find((c) => c.id === currentId);
// A chat nobody has touched: no messages, no system prompt, never renamed.
const isPristine = (c) => !c.has_messages && !c.has_prompt && !c.reasoning_effort && c.title === 'New chat';

// Leaving an untouched new chat deletes it.
function discardIfPristine(nextId) {
  const cur = currentChat();
  if (!cur || cur.id === nextId || !isPristine(cur)) return;
  chats = chats.filter((c) => c !== cur);
  api(`/api/chats/${cur.id}`, { method: 'DELETE' }).catch(() => {});
}

// ---------- thread ----------
function setEmpty() { els.empty.hidden = els.messages.children.length > 0; }

function nearBottom() {
  const t = els.thread;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollToBottom() { els.thread.scrollTop = els.thread.scrollHeight; }

function addDeleteButton(wrap) {
  const b = button(ICONS.x, 'Delete message', () => deleteMessage(wrap));
  b.className = 'msg-del';
  wrap.append(b);
}

function addUserMessage(text, id) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  if (id) wrap.dataset.id = id;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.append(bubble);
  addDeleteButton(wrap);
  els.messages.append(wrap);
  setEmpty();
  return wrap;
}

function addAssistantMessage(content = '', reasoning = '', id = null) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  if (id) wrap.dataset.id = id;
  const think = document.createElement('details');
  think.className = 'thinking';
  think.innerHTML = '<summary>Thinking</summary><div class="thinking-body"></div>';
  const body = document.createElement('div');
  body.className = 'body';
  const error = document.createElement('div');
  error.className = 'error';
  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  wrap.append(think, body, error, tools);
  addDeleteButton(wrap);

  const state = { content, reasoning, wrap };
  state.render = (live) => {
    const s = splitThink(state.content, state.reasoning);
    think.hidden = !s.reasoning;
    think.querySelector('.thinking-body').textContent = s.reasoning;
    body.innerHTML = renderMarkdown(s.content);
    body.classList.toggle('cursor', !!live);
    if (!live) addCodeCopyButtons(body);
  };
  state.setError = (msg) => { error.textContent = msg || ''; };
  state.finish = () => {
    state.done = true;
    state.render(false);
    tools.textContent = '';
    tools.append(
      button(ICONS.copy, 'Copy', (e) => copy(splitThink(state.content, state.reasoning).content, e.currentTarget), 'Copy'),
      button(ICONS.retry, 'Retry', regenerate, 'Retry'),
    );
    refreshRetryButtons();
  };

  els.messages.append(wrap);
  setEmpty();
  return state;
}

// Only the last reply can be retried.
function refreshRetryButtons() {
  const all = els.messages.querySelectorAll('.msg.assistant');
  all.forEach((m, i) => {
    const btn = m.querySelector('[aria-label="Retry"]');
    if (btn) btn.hidden = i !== all.length - 1 || m !== els.messages.lastElementChild;
  });
}

function addCodeCopyButtons(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy-code';
    b.textContent = 'Copy';
    b.addEventListener('click', () => copy(pre.querySelector('code')?.textContent ?? pre.textContent, b));
    pre.append(b);
  });
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const span = btn.querySelector('span') || btn;
    const old = span.textContent;
    span.textContent = 'Copied';
    setTimeout(() => { span.textContent = old; }, 1200);
  } catch { /* clipboard blocked */ }
}

async function openChat(id, push) {
  if (streaming) streaming.abort();
  let data;
  try { data = await api(`/api/chats/${id}`); }
  catch { return newChat(false); }
  discardIfPristine(id);
  currentId = id;
  if (push) history.pushState(null, '', `${BASE}/c/${id}`);
  els.title.textContent = data.title;
  document.title = data.title;
  showSystemPrompt(data.system_prompt);
  els.messages.textContent = '';
  for (const m of data.messages) {
    if (m.role === 'user') addUserMessage(m.content, m.id);
    else addAssistantMessage(m.content, m.reasoning || '', m.id).finish();
  }
  // A user message with no reply (e.g. the reply failed) can be retried.
  if (els.messages.lastElementChild?.classList.contains('user')) addRetryRow();
  refreshRetryButtons();
  setEmpty();
  renderSidebar();
  scrollToBottom();
  els.input.focus();
}

// Placeholder after a user message with no saved reply. Not a real message, so it has no ×.
function addRetryRow() {
  const a = addAssistantMessage();
  a.wrap.classList.add('noreply');
  a.setError('No reply.');
  a.finish();
}

async function deleteMessage(wrap) {
  if (wrap.classList.contains('live') || wrap.classList.contains('noreply')) return;
  const id = wrap.dataset.id;
  if (id) {
    try { await api(`/api/chats/${currentId}/messages/${id}`, { method: 'DELETE' }); }
    catch (e) { alert(e.message); return; }
  }
  wrap.remove();
  tidyThread();
}

// Keep the thread consistent after a deletion: one "No reply" row only when the
// conversation ends on a user message.
function tidyThread() {
  els.messages.querySelectorAll('.noreply').forEach((el) => el.remove());
  if (!streaming && els.messages.lastElementChild?.classList.contains('user')) addRetryRow();
  refreshRetryButtons();
  setEmpty();
  const c = currentChat();
  if (c) c.has_messages = !!els.messages.querySelector('[data-id]');
}

// Creates the chat row right away so its system prompt can be set before the first message.
// push=true adds a history entry; push=false replaces the current URL.
let creating = null;
async function newChat(push) {
  if (streaming) streaming.abort();
  const setUrl = (id) => history[push ? 'pushState' : 'replaceState'](null, '', `${BASE}/c/${id}`);
  const cur = currentChat();
  if (cur && isPristine(cur)) { // already on an untouched new chat
    if (!push) setUrl(cur.id);
    els.input.focus();
    return;
  }
  if (creating) return creating;
  creating = (async () => {
    let chat;
    try { chat = await api('/api/chats', { method: 'POST' }); }
    catch (e) { alert(e.message); return; }
    Object.assign(chat, { has_messages: false, has_prompt: false, reasoning_effort: null });
    chats.unshift(chat);
    currentId = chat.id;
    setUrl(chat.id);
    els.title.textContent = chat.title;
    document.title = chat.title;
    showSystemPrompt(null);
    els.messages.textContent = '';
    setEmpty();
    renderSidebar();
    els.input.focus();
  })();
  try { await creating; } finally { creating = null; }
}

// ---------- sending ----------
async function streamInto(url, body, msg, userWrap = null) {
  const ac = new AbortController();
  streaming = ac;
  streamingChat = currentId;
  msg.wrap.classList.add('live');
  setBusy(true);
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (msg.done) return; // finish() already did the final render
      const stick = nearBottom();
      msg.render(true);
      if (stick) scrollToBottom();
    });
  };
  msg.render(true);
  try {
    const res = await fetch(BASE + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (res.status === 401) { location.reload(); return; }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        const evt = JSON.parse(line.slice(5));
        if (evt.u && userWrap) userWrap.dataset.id = evt.u;
        if (evt.done && evt.id) msg.wrap.dataset.id = evt.id;
        if (evt.c) msg.content += evt.c;
        if (evt.r) msg.reasoning += evt.r;
        if (evt.error) msg.setError(evt.error);
        schedule();
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') msg.setError(e.message);
  } finally {
    if (streaming === ac) { streaming = null; streamingChat = null; }
    clearTimeout(stopTimer);
    setBusy(false);
    msg.wrap.classList.remove('live');
    if (!msg.wrap.dataset.id) {
      // Nothing was saved (error, or stopped before any text): show it as a retryable gap.
      msg.wrap.classList.add('noreply');
      if (!msg.content && !msg.reasoning && !msg.wrap.querySelector('.error').textContent) msg.setError('No reply.');
    }
    msg.finish();
    bumpCurrentChat();
  }
}

function bumpCurrentChat() {
  const c = chats.find((x) => x.id === currentId);
  if (!c) return;
  c.updated_at = new Date().toISOString();
  chats = [c, ...chats.filter((x) => x !== c)];
  renderSidebar();
}

async function send() {
  const text = els.input.value;
  if (!text.trim() || streaming) return;
  els.input.value = '';
  autosize();

  if (!currentId) await newChat(false);
  const chat = currentChat();
  if (!chat) { els.input.value = text; autosize(); return; }
  if (!chat.has_messages && chat.title === 'New chat') {
    // Matches the title the server gives a chat on its first message.
    chat.title = text.trim().replace(/\s+/g, ' ').slice(0, 60);
    els.title.textContent = chat.title;
    document.title = chat.title;
  }
  chat.has_messages = true;
  renderSidebar();
  // Remove a dangling "No reply" row before continuing the conversation.
  els.messages.querySelectorAll('.noreply').forEach((el) => el.remove());

  const userWrap = addUserMessage(text);
  const msg = addAssistantMessage();
  scrollToBottom();
  await streamInto(`/api/chats/${currentId}/messages`, { content: text }, msg, userWrap);
}

async function regenerate() {
  if (streaming || !currentId) return;
  const last = els.messages.lastElementChild;
  if (last?.classList.contains('assistant')) last.remove();
  const msg = addAssistantMessage();
  scrollToBottom();
  await streamInto(`/api/chats/${currentId}/regenerate`, {}, msg);
}

function setBusy(busy) {
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  updateSendEnabled();
}
function updateSendEnabled() { els.send.disabled = !els.input.value.trim(); }

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = els.input.scrollHeight + 'px';
  updateSendEnabled();
}

// ---------- system prompt ----------
function showSystemPrompt(text) {
  els.sysPrompt.hidden = !text;
  els.sysText.textContent = text || '';
  els.sysPrompt.classList.remove('expanded');
  els.sysMore.textContent = 'Show more';
  // Only offer "Show more" when the text is actually clamped.
  els.sysMore.hidden = true;
  if (text) requestAnimationFrame(() => { els.sysMore.hidden = els.sysText.scrollHeight <= els.sysText.clientHeight + 1; });
}
els.sysMore.addEventListener('click', () => {
  const open = els.sysPrompt.classList.toggle('expanded');
  els.sysMore.textContent = open ? 'Show less' : 'Show more';
});

let promptChat = null;
async function openPromptDialog(chat) {
  promptChat = chat;
  els.promptName.textContent = chat.title;
  els.promptInput.value = '';
  els.dialog.showModal();
  try {
    const data = await api(`/api/chats/${chat.id}`);
    if (promptChat === chat) els.promptInput.value = data.system_prompt || '';
  } catch (e) { alert(e.message); els.dialog.close(); }
  els.promptInput.focus();
}
async function savePrompt(value) {
  const chat = promptChat;
  if (!chat) return;
  try {
    await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { system_prompt: value } });
  } catch (e) { alert(e.message); return; }
  chat.has_prompt = !!value.trim();
  if (chat.id === currentId) showSystemPrompt(value.trim() ? value : null);
  renderSidebar();
  els.dialog.close();
}
els.promptForm.addEventListener('submit', (e) => { e.preventDefault(); savePrompt(els.promptInput.value); });
els.promptClear.addEventListener('click', () => { els.promptInput.value = ''; els.promptInput.focus(); });
els.promptCancel.addEventListener('click', () => els.dialog.close());
els.dialog.addEventListener('close', () => { promptChat = null; });

// ---------- API key settings ----------
let settings = null;
function showKeyState() {
  const missing = !settings?.has_key;
  els.keyBtn.classList.toggle('missing', missing);
  els.keyBtn.title = missing ? 'API key: not set' : 'API key';
}
async function loadSettings() {
  try { settings = await api('/api/settings'); } catch { return; }
  showKeyState();
}
async function openKeyDialog() {
  await loadSettings();
  if (!settings) return;
  els.keyStatus.textContent = settings.has_key ? `A key ending in …${settings.key_hint} is saved.` : 'No key saved yet. Add one to start chatting.';
  els.keyInput.value = '';
  els.keyInput.placeholder = settings.has_key ? 'Paste a new key to replace it' : 'Paste your key';
  els.modelInput.value = settings.model;
  els.modelInput.placeholder = settings.default_model;
  els.keyRemove.hidden = !settings.has_key;
  els.keyDialog.showModal();
  els.keyInput.focus();
}
async function saveSettings(body) {
  try { await api('/api/settings', { method: 'PUT', body }); }
  catch (e) { alert(e.message); return false; }
  await loadSettings();
  return true;
}
els.keyBtn.addEventListener('click', openKeyDialog);
els.keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { model: els.modelInput.value };
  if (els.keyInput.value.trim()) body.api_key = els.keyInput.value;
  if (await saveSettings(body)) els.keyDialog.close();
});
els.keyRemove.addEventListener('click', async () => {
  if (!confirm('Remove the saved API key?')) return;
  if (await saveSettings({ api_key: '' })) els.keyDialog.close();
});
els.keyCancel.addEventListener('click', () => els.keyDialog.close());

// ---------- reasoning effort menu ----------
let effortMenu = null;
function closeEffortMenu() {
  if (!effortMenu) return;
  effortMenu.remove();
  effortMenu = null;
  document.removeEventListener('pointerdown', outsideEffortMenu, true);
  document.removeEventListener('keydown', escEffortMenu, true);
}
function outsideEffortMenu(e) {
  if (effortMenu && !effortMenu.contains(e.target) && !e.target.closest('[aria-label="Reasoning effort"]')) closeEffortMenu();
}
function escEffortMenu(e) { if (e.key === 'Escape') closeEffortMenu(); }

function openEffortMenu(chat, anchor) {
  const wasFor = effortMenu?.dataset.chat;
  closeEffortMenu();
  if (wasFor === chat.id) return; // second click toggles it closed
  const menu = document.createElement('div');
  menu.className = 'effort-menu';
  menu.dataset.chat = chat.id;
  menu.setAttribute('role', 'menu');
  const head = document.createElement('div');
  head.className = 'effort-head';
  head.textContent = 'Reasoning effort';
  menu.append(head);
  for (const opt of EFFORT_OPTIONS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitemradio');
    const selected = (chat.reasoning_effort || null) === opt.value;
    item.setAttribute('aria-checked', String(selected));
    item.className = 'effort-item' + (selected ? ' selected' : '');
    item.innerHTML = GAUGE[opt.value || 'default'] + '<span class="effort-text"><span class="effort-label"></span><span class="effort-hint"></span></span>';
    item.querySelector('.effort-label').textContent = opt.label;
    item.querySelector('.effort-hint').textContent = opt.hint;
    item.addEventListener('click', () => setEffort(chat, opt.value));
    menu.append(item);
  }
  document.body.append(menu);
  // Place below the icon, kept inside the window.
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let left = Math.min(r.left, innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = r.top - h - 6;
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
  effortMenu = menu;
  document.addEventListener('pointerdown', outsideEffortMenu, true);
  document.addEventListener('keydown', escEffortMenu, true);
  menu.querySelector('.selected')?.focus();
}

async function setEffort(chat, value) {
  closeEffortMenu();
  if ((chat.reasoning_effort || null) === value) return;
  try { await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { reasoning_effort: value } }); }
  catch (e) { alert(e.message); return; }
  chat.reasoning_effort = value;
  renderSidebar();
}

// ---------- sidebar: collapse, resize, mobile drawer ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const isMobile = () => matchMedia('(max-width: 800px)').matches;

function setCollapsed(collapsed) {
  els.app.classList.toggle('collapsed', collapsed);
  store.set('sidebarCollapsed', collapsed ? '1' : '0');
}
function openSidebar() { els.sidebar.classList.add('open'); els.scrim.classList.add('open'); }
function closeSidebar() { els.sidebar.classList.remove('open'); els.scrim.classList.remove('open'); }
els.toggle.addEventListener('click', () => {
  if (isMobile()) els.sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  else setCollapsed(!els.app.classList.contains('collapsed'));
});

const MIN_W = 200, MAX_W = 520;
function setWidth(w) {
  w = Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
  els.app.style.setProperty('--sidebar-w', w + 'px');
  return w;
}
const savedW = Number(store.get('sidebarWidth'));
if (savedW) setWidth(savedW);
if (store.get('sidebarCollapsed') === '1') els.app.classList.add('collapsed');

els.resizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  els.resizer.setPointerCapture(e.pointerId);
  els.app.classList.add('resizing');
  const move = (ev) => setWidth(ev.clientX);
  const up = (ev) => {
    store.set('sidebarWidth', String(setWidth(ev.clientX)));
    els.app.classList.remove('resizing');
    els.resizer.removeEventListener('pointermove', move);
    els.resizer.removeEventListener('pointerup', up);
  };
  els.resizer.addEventListener('pointermove', move);
  els.resizer.addEventListener('pointerup', up);
});
els.resizer.addEventListener('dblclick', () => store.set('sidebarWidth', String(setWidth(272))));

// ---------- wiring ----------
els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    send();
  }
});
els.stop.addEventListener('click', () => {
  if (!streaming) return;
  const ac = streaming;
  fetch(`${BASE}/api/chats/${streamingChat}/stop`, { method: 'POST' }).catch(() => ac.abort());
  stopTimer = setTimeout(() => ac.abort(), 4000);
});
els.newChat.addEventListener('click', () => { newChat(true); closeSidebar(); });
els.scrim.addEventListener('click', closeSidebar);
window.addEventListener('popstate', route);

function chatIdFromUrl() {
  const m = location.pathname.slice(BASE.length).match(/^\/c\/([0-9a-f-]{36})$/i);
  return m ? m[1] : null;
}
function route() {
  const id = chatIdFromUrl();
  if (id) openChat(id, false);
  else newChat(false);
}

loadChats().then(route).catch((e) => console.error(e));
// First visit after setup: ask for the API key straight away.
loadSettings().then(() => { if (settings && !settings.has_key) openKeyDialog(); });
updateSendEnabled();
