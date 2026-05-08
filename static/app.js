/* AgentDispatch UI */

/* Mirror console.log/warn/error to the server so they land in agentdispatch.log.
 * Entries are batched (flushed on size/time threshold and on page unload). */
if (typeof window !== 'undefined') (function() {
  const MAX_BATCH = 20;
  const FLUSH_DELAY_MS = 500;
  const queue = [];
  let flushTimer = null;
  let inFlight = false;
  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (inFlight || queue.length === 0) return;
    const entries = queue.splice(0, queue.length);
    inFlight = true;
    fetch('/api/client-log', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({entries}),
      keepalive: true,
    }).catch(() => {}).finally(() => { inFlight = false; if (queue.length) schedule(); });
  }
  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }
  function enqueue(level, args) {
    let msg;
    try {
      msg = args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
    } catch { msg = '[unserializable]'; }
    queue.push({level, msg});
    if (queue.length >= MAX_BATCH) flush(); else schedule();
  }
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = function(...args) { orig(...args); enqueue(level, args); };
  }
  window.addEventListener('beforeunload', flush);
  window.addEventListener('error', (e) => enqueue('error', [`window.onerror: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`, e.error]));
  window.addEventListener('unhandledrejection', (e) => enqueue('error', ['unhandledrejection:', e.reason]));
})();

let evtSource = null;
let buildHash = null;
let _workspaces = [];
let _selectedWsId = null;
let _selectedWsSubtab = '';
let _wsSubtabs = {}; // workspace id -> last selected subtab
let _tabTerminals = {}; // keyed by tab id -> {term, ws, fitAddon, container}
const _wsLastOutput = {}; // workspace id -> last output timestamp (ms)
const _wsDotState = {}; // workspace id -> last dot class ('', 'recent', 'idle')
const _wsWasSelected = {}; // workspace id -> was selected last tick
const _wsOutputGrace = {}; // workspace id -> suppress output recording until this timestamp
const _tabLastOutput = {}; // tab id -> last output timestamp (ms)
const _tabDotState = {}; // tab id -> dot state
const _tabWasSelected = {}; // tab id -> was selected last tick
const _tabOutputGrace = {}; // tab id -> suppress output recording until this timestamp
const _exitedTabs = new Set(); // tab ids whose pane has exited (kept until user dismisses)
let _categories = [];
let _dialogCallback = null;
let _dialogFields = [];

/* -- Pure logic (testable without DOM) -- */

// morphdom callback: skip updating popover elements that are currently open
// (the "open" class is runtime state, not in the template HTML)
function morphdomShouldUpdate(fromEl, toEl) {
  if (fromEl.classList.contains('ws-popover') && fromEl.classList.contains('open')
      && !toEl.classList.contains('open')) {
    return false; // preserve the open menu
  }
  return true;
}


function getDefaultWsSubtab(ws) {
  if (ws && ws.tabs.length > 0) return 'tab-' + ws.tabs[0].id;
  return '';
}

function normalizeWsSubtab(ws, subtab) {
  if (!ws) return '';
  if (subtab && subtab.startsWith('tab-')) {
    return ws.tabs.some(t => 'tab-' + t.id === subtab) ? subtab : getDefaultWsSubtab(ws);
  }
  return getDefaultWsSubtab(ws);
}

function getTerminalConfig() {
  return {
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: {
      background: '#000000',
      foreground: '#e2e8f0',
      cursor: '#818cf8',
      selectionBackground: 'rgba(129, 140, 248, 0.3)',
    },
  };
}

function containsEraseDisplay(data) {
  // \e[2J = bytes 0x1b 0x5b 0x32 0x4a
  for (let i = 0; i <= data.length - 4; i++) {
    if (data[i] === 0x1b && data[i+1] === 0x5b && data[i+2] === 0x32 && data[i+3] === 0x4a) {
      return true;
    }
  }
  return false;
}

/* -- DOM-dependent functions -- */

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase() === name);
  });
  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.toggle('active', el.id === 'tab-' + name);
  });
  if (name === 'workspaces') {
    fetchWorkspaces();
  }
}

/* SSE */
function connectSSE() {
  const status = document.getElementById('conn-status');
  evtSource = new EventSource('/api/events');

  evtSource.addEventListener('init', e => {
    const data = JSON.parse(e.data);
    if (buildHash && data.build_hash !== buildHash) {
      location.reload();
      return;
    }
    buildHash = data.build_hash;
    document.getElementById('conn-overlay').classList.remove('active');
    status.textContent = 'Connected';
    status.className = 'connected';
    setTimeout(() => { status.style.display = 'none'; }, 2000);
    // Refresh all data from server (handles --reset, server restart, etc.)
    fetchWorkspaces();
    reconnectAllTerminals();
  });

  evtSource.addEventListener('update', e => {
    const data = JSON.parse(e.data);
    if (data.build_hash && data.build_hash !== buildHash) {
      location.reload();
    }
    // Server detected a workspace status change — refresh
    fetchWorkspaces();
  });

  evtSource.onerror = () => {
    document.getElementById('conn-overlay').classList.add('active');
    status.textContent = 'Disconnected \u2014 reconnecting\u2026';
    status.className = 'error';
    status.style.display = 'block';
  };
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML.replace(/'/g, '&#39;').replace(/\\/g, '&#92;');
}

// Escape for use inside a JS string literal within an onclick attribute.
// Must handle both JS escaping (backslash, quotes) and HTML entity context.
function escAttr(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function fetchWorkspaces() {
  try {
    const res = await fetch('/api/workspaces');
    const data = await res.json();
    _workspaces = data.workspaces || [];
    _categories = data.categories || [];
    renderWorkspaces();
  } catch {}
}


// Pure state machine for activity dots.

function isWsSelected(selectedWsId, wsId) {
  return selectedWsId === wsId;
}

function shouldRecordOutput(isSelected, now, graceUntil) {
  if (isSelected) return false;
  if (graceUntil != null && now < graceUntil) return false;
  return true;
}

function computeDotState(prev, lastOutputMs, now, isSelected, isBuilding) {
  if (isSelected) return '';
  if (isBuilding) return 'busy';
  const age = lastOutputMs != null ? now - lastOutputMs : Infinity;
  const recentOutput = age < 5000;

  if (prev === 'done') {
    if (recentOutput) return 'busy';
    return 'done';
  }
  if (prev === 'slowing') {
    if (recentOutput) return 'busy';
    if (age >= 10000) return 'done';
    return 'slowing';
  }
  if (prev === 'busy') {
    if (recentOutput) return 'busy';
    return 'slowing';
  }
  if (recentOutput) return 'busy';
  return '';
}

function tickDot(prev, lastOutputMs, now, isSelected, wasSelected, isBuilding) {
  const state = computeDotState(prev, lastOutputMs, now, isSelected, isBuilding);
  const justDeselected = wasSelected && !isSelected;
  return {
    state,
    outputMs: isSelected ? null : lastOutputMs,
    notify: state === 'done' && prev === 'slowing',
    graceUntil: justDeselected ? now + 2000 : null,
  };
}

function updateActivityDots() {
  const now = Date.now();
  for (const ws of _workspaces) {
    const prev = _wsDotState[ws.id] || '';
    const isSelected = isWsSelected(_selectedWsId, ws.id);
    const wasSelected = _wsWasSelected[ws.id] || false;
    const r = tickDot(prev, _wsLastOutput[ws.id], now, isSelected, wasSelected, false);
    _wsDotState[ws.id] = r.state;
    _wsLastOutput[ws.id] = r.outputMs;
    _wsWasSelected[ws.id] = isSelected;
    if (r.graceUntil) _wsOutputGrace[ws.id] = r.graceUntil;
    const sidebar = document.getElementById('activity-ws-' + ws.id);
    if (sidebar) sidebar.className = 'activity-dot' + (r.state ? ' ' + r.state : '');
    if (r.notify) notifyIdle(ws.name);

    if (ws.tabs && ws.id === _selectedWsId) {
      for (const tab of ws.tabs) {
        const tabPrev = _tabDotState[tab.id] || '';
        const isTabSelected = _selectedWsSubtab === 'tab-' + tab.id;
        const tabWasSelected = _tabWasSelected[tab.id] || false;
        const tr = tickDot(tabPrev, _tabLastOutput[tab.id], now, isTabSelected, tabWasSelected, false);
        _tabDotState[tab.id] = tr.state;
        _tabLastOutput[tab.id] = tr.outputMs;
        _tabWasSelected[tab.id] = isTabSelected;
        if (tr.graceUntil) _tabOutputGrace[tab.id] = tr.graceUntil;
        const tabDot = document.getElementById('activity-tab-' + tab.id);
        if (tabDot) tabDot.className = 'activity-dot' + (tr.state ? ' ' + tr.state : '');
      }
    }
  }
}

function notifyIdle(name) {
  const toast = document.createElement('div');
  toast.className = 'idle-toast';
  toast.textContent = `${name} is idle`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
  if (Notification.permission === 'granted') {
    new Notification('AgentDispatch', { body: `${name} is idle`, tag: 'idle-' + name });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission();
  }
}

function saveWorkspaceOrder(categoryId) {
  const inCat = _workspaces.filter(w => (w.category_id || null) === categoryId);
  fetch('/api/workspaces/reorder', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ ids: inCat.map(w => w.id) }),
  });
}

function saveCategoryOrder() {
  fetch('/api/categories/reorder', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ ids: _categories.map(c => c.id) }),
  });
}

async function addCategory() {
  showForm('New Category', [{id: 'cat-name', placeholder: 'Category name'}], async (values) => {
    const name = values['cat-name'];
    if (!name) return 'Name is required.';
    await fetch('/api/categories', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
    });
    fetchWorkspaces();
  });
}

async function renameCategory(id) {
  const cat = _categories.find(c => c.id === id);
  if (!cat) return;
  showForm('Rename Category', [{id: 'cat-name', placeholder: 'Category name', value: cat.name}], async (values) => {
    const name = values['cat-name'];
    if (!name) return 'Name is required.';
    await fetch(`/api/categories/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
    });
    fetchWorkspaces();
  });
}

async function deleteCategory(id) {
  const cat = _categories.find(c => c.id === id);
  if (!cat) return;
  showConfirm(`Delete category "${cat.name}"? Workspaces will move to Uncategorized.`, async () => {
    await fetch(`/api/categories/${id}`, {method: 'DELETE'});
    fetchWorkspaces();
  });
}

function toggleCategory(id) {
  const cat = _categories.find(c => c.id === id);
  if (!cat) return;
  cat.collapsed = !cat.collapsed;
  fetch(`/api/categories/${id}/toggle`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({collapsed: cat.collapsed}),
  });
  renderWorkspaces();
}

function moveWorkspaceToCategory(wsId, categoryId) {
  const ws = _workspaces.find(w => w.id === wsId);
  if (ws) ws.category_id = categoryId;
  fetch(`/api/workspaces/${wsId}/category`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({category_id: categoryId}),
  });
}

async function newWorkspace() {
  const res = await fetch('/api/workspaces', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (data.error) { showDialog(data.error); return; }
  _selectedWsId = data.id;
  switchTab('workspaces');
  fetchWorkspaces();
}

function renderWsItem(ws) {
  return `<div class="ws-sidebar-item ${ws.id === _selectedWsId ? 'active' : ''}"
       draggable="true" data-ws-id="${ws.id}" data-cat-id="${ws.category_id || ''}"
       onclick="selectWorkspace(${ws.id})">
    <span id="activity-ws-${ws.id}" class="activity-dot"></span>
    <div class="ws-sidebar-info">
      <div class="ws-name" ondblclick="event.stopPropagation(); renameWorkspace(${ws.id})">${esc(ws.name)}</div>
    </div>
    <button class="ws-menu-btn" onclick="event.stopPropagation(); toggleWsMenu(${ws.id})">…</button>
    <div class="ws-popover" id="ws-menu-${ws.id}">
      <div class="ws-popover-item" onclick="event.stopPropagation(); renameWorkspace(${ws.id})">Rename</div>
      <div class="ws-popover-item danger" onclick="event.stopPropagation(); destroyWorkspace(${ws.id})">Destroy</div>
    </div>
  </div>`;
}

function renderCategorySection(cat, workspaces) {
  const isUncat = cat === null;
  const catId = isUncat ? '' : cat.id;
  const name = isUncat ? 'Uncategorized' : cat.name;
  const collapsed = !isUncat && cat.collapsed;
  const arrow = collapsed ? '▶' : '▼';
  const items = collapsed ? '' : workspaces.map(renderWsItem).join('');
  const menuHtml = isUncat ? '' : `
    <button class="ws-menu-btn" onclick="event.stopPropagation(); toggleCatMenu(${catId})">…</button>
    <div class="ws-popover" id="cat-menu-${catId}">
      <div class="ws-popover-item" onclick="event.stopPropagation(); renameCategory(${catId})">Rename</div>
      <div class="ws-popover-item danger" onclick="event.stopPropagation(); deleteCategory(${catId})">Delete</div>
    </div>`;
  return `<div class="ws-category" data-cat-id="${catId}">
    <div class="ws-category-header" draggable="${!isUncat}" data-cat-id="${catId}"
         onclick="${isUncat ? '' : 'toggleCategory(' + catId + ')'}">
      <span class="ws-category-arrow">${arrow}</span>
      <span class="ws-category-name" ondblclick="event.stopPropagation(); ${isUncat ? '' : 'renameCategory(' + catId + ')'}">${esc(name)}</span>
      <span class="ws-category-count">${workspaces.length}</span>
      ${menuHtml}
    </div>
    <div class="ws-category-items" data-cat-id="${catId}">${items}</div>
  </div>`;
}

function renderWorkspaces() {
  const sidebar = document.getElementById('ws-sidebar');
  const toolbar = '<div class="ws-toolbar"><div class="ws-new-btn" onclick="newWorkspace()">+ Workspace</div><div class="ws-new-btn" onclick="addCategory()">+ Category</div></div>';

  const grouped = {};
  for (const ws of _workspaces) {
    const key = ws.category_id || null;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(ws);
  }

  let html = toolbar;
  for (const cat of _categories) {
    html += renderCategorySection(cat, grouped[cat.id] || []);
  }
  html += renderCategorySection(null, grouped[null] || []);

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  if (typeof morphdom !== 'undefined') {
    morphdom(sidebar, tmp, {
      childrenOnly: true,
      onBeforeElUpdated: morphdomShouldUpdate,
    });
  } else {
    sidebar.innerHTML = html;
  }

  renderSelectedWorkspace();
  updateActivityDots();
}

function toggleCatMenu(catId) {
  const menu = document.getElementById('cat-menu-' + catId);
  if (!menu) return;
  const wasOpen = menu.classList.contains('open');
  closeAllWsMenus();
  if (!wasOpen) menu.classList.add('open');
}

// Drag-and-drop for workspaces and categories
let _dragType = null; // 'ws' or 'category'
let _dragId = null;
let _dropTarget = null; // {el, inLowerHalf} — resolved during dragover, used by drop
function initSidebarDragDrop() {
  const sidebar = document.getElementById('ws-sidebar');
  const clearDragOver = () => sidebar.querySelectorAll('.drag-over-above, .drag-over-below').forEach(x => { x.classList.remove('drag-over-above', 'drag-over-below'); });
  const findTarget = (e) => e.target.closest('.ws-sidebar-item, .ws-category-header, .ws-category-items');

  sidebar.addEventListener('dragstart', (e) => {
    const wsItem = e.target.closest('.ws-sidebar-item');
    const catHeader = e.target.closest('.ws-category-header');
    if (wsItem) {
      _dragType = 'ws';
      _dragId = parseInt(wsItem.dataset.wsId);
      wsItem.classList.add('dragging');
    } else if (catHeader && catHeader.getAttribute('draggable') === 'true') {
      _dragType = 'category';
      _dragId = parseInt(catHeader.dataset.catId);
      catHeader.classList.add('dragging');
    }
    e.dataTransfer.effectAllowed = 'move';
  });
  sidebar.addEventListener('dragend', () => {
    sidebar.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    clearDragOver();
    _dropTarget = null;
  });
  sidebar.addEventListener('dragover', (e) => {
    const el = findTarget(e);
    if (!el) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDragOver();
    const rect = el.getBoundingClientRect();
    const inLowerHalf = (e.clientY - rect.top) > rect.height / 2;
    el.classList.add(inLowerHalf ? 'drag-over-below' : 'drag-over-above');
    _dropTarget = { el, inLowerHalf };
  });
  sidebar.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDragOver();
    if (!_dropTarget) return;
    const { el, inLowerHalf } = _dropTarget;
    _dropTarget = null;
    if (_dragType === 'ws') handleWsDrop(el, inLowerHalf);
    else if (_dragType === 'category') handleCatDrop(el, inLowerHalf);
  });
}

function parseCatId(str) {
  if (str === '' || str == null) return null;
  return parseInt(str);
}

function handleWsDrop(el, inLowerHalf) {
  const wsId = _dragId;
  const ws = _workspaces.find(w => w.id === wsId);
  if (!ws) return;

  if (el.classList.contains('ws-sidebar-item')) {
    const targetId = parseInt(el.dataset.wsId);
    if (targetId === wsId) return;
    const targetW = _workspaces.find(w => w.id === targetId);
    if (!targetW) return;
    const container = el.closest('.ws-category-items');
    const targetCatId = container ? parseCatId(container.dataset.catId) : (targetW.category_id || null);

    if ((ws.category_id || null) !== targetCatId) {
      ws.category_id = targetCatId;
      moveWorkspaceToCategory(wsId, targetCatId);
    }

    const inCat = _workspaces.filter(w => (w.category_id || null) === targetCatId);
    const fromIdx = inCat.indexOf(ws);
    let toIdx = inCat.indexOf(targetW);
    if (toIdx < 0) return;
    if (fromIdx >= 0) inCat.splice(fromIdx, 1);
    toIdx = inCat.indexOf(targetW);
    if (inLowerHalf) toIdx++;
    inCat.splice(toIdx, 0, ws);
    saveWorkspaceOrder(targetCatId);
    renderWorkspaces();
  } else if (el.classList.contains('ws-category-header') && !inLowerHalf) {
    // Upper half of a category header — user was dragging at the bottom of the
    // previous category. Find the category just above this header and drop there.
    const thisCatEl = el.closest('.ws-category');
    const prevCatEl = thisCatEl && thisCatEl.previousElementSibling;
    const prevItems = prevCatEl && prevCatEl.querySelector('.ws-category-items');
    const catId = prevItems ? parseCatId(prevItems.dataset.catId) : parseCatId(el.dataset.catId);
    ws.category_id = catId;
    moveWorkspaceToCategory(wsId, catId);
    renderWorkspaces();
  } else {
    const catId = parseCatId(el.dataset.catId);
    ws.category_id = catId;
    moveWorkspaceToCategory(wsId, catId);
    renderWorkspaces();
  }
}

function handleCatDrop(el, inLowerHalf) {
  const catId = _dragId;
  const targetHeader = el.closest('.ws-category-header');
  if (!targetHeader) return;
  const targetCatIdStr = targetHeader.dataset.catId;
  if (!targetCatIdStr) return;
  const targetCatId = parseInt(targetCatIdStr);
  if (targetCatId === catId) return;

  const fromIdx = _categories.findIndex(c => c.id === catId);
  let toIdx = _categories.findIndex(c => c.id === targetCatId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = _categories.splice(fromIdx, 1);
  toIdx = _categories.findIndex(c => c.id === targetCatId);
  if (inLowerHalf) toIdx++;
  _categories.splice(toIdx, 0, moved);
  saveCategoryOrder();
  renderWorkspaces();
}

function selectWorkspace(id) {
  _selectedWsId = id;
  const ws = _workspaces.find(w => w.id === id);
  _selectedWsSubtab = normalizeWsSubtab(ws, _wsSubtabs[id] || getDefaultWsSubtab(ws));
  renderWorkspaces();
}

function switchWsSubtab(name) {
  _selectedWsSubtab = name;
  if (_selectedWsId != null) _wsSubtabs[_selectedWsId] = name;
  renderSelectedWorkspace();
}

async function addShellPane(wsId) {
  const ws = _workspaces.find(w => w.id === wsId);
  const shellCount = ws ? ws.tabs.filter(t => t.tab_type === 'shell').length : 0;
  const name = 'Shell ' + (shellCount + 1);
  const res = await fetch(`/api/workspaces/${wsId}/tabs`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name, tab_type: 'shell'}),
  });
  const tab = await res.json();
  if (ws) ws.tabs.push(tab);
  _selectedWsSubtab = 'tab-' + tab.id;
  renderSelectedWorkspace();
}

function disposeTerminal(key) {
  const t = _tabTerminals[key];
  if (!t) return;
  t.disposed = true;
  if (t.resizeObserver) t.resizeObserver.disconnect();
  if (t.ws) t.ws.close();
  t.term.dispose();
  delete _tabTerminals[key];
}

function confirmCloseTab(tabId, tabName) {
  if (_exitedTabs.has(tabId)) {
    closeTab(tabId);
  } else {
    showConfirm(`Close "${tabName}"?`, () => closeTab(tabId), 'Close');
  }
}

async function toggleMouseWheel(tabId) {
  const ws = _workspaces.find(w => w.id === _selectedWsId);
  if (!ws) return;
  const tab = ws.tabs.find(t => t.id === tabId);
  if (!tab) return;
  tab.mouse_wheel_fs = !tab.mouse_wheel_fs;
  await fetch(`/api/tabs/${tabId}/mouse-wheel-fs`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ enabled: tab.mouse_wheel_fs }),
  });
  disposeTerminal(tabId);
  renderSelectedWorkspace();
}

async function closeTab(tabId) {
  console.log('[closeTab]', tabId, 'called from:', new Error().stack);
  disposeTerminal(tabId);
  _exitedTabs.delete(tabId);
  await fetch(`/api/tabs/${tabId}`, {method: 'DELETE'});
  const ws = _workspaces.find(w => w.id === _selectedWsId);
  if (ws) ws.tabs = ws.tabs.filter(t => t.id !== tabId);
  if (_selectedWsSubtab === 'tab-' + tabId) {
    _selectedWsSubtab = getDefaultWsSubtab(ws);
  }
  renderSelectedWorkspace();
}


async function renameWorkspace(wsId) {
  closeAllWsMenus();
  const ws = _workspaces.find(w => w.id === wsId);
  if (!ws) return;
  showForm('Rename workspace', [
    {id: 'ws-name', placeholder: 'Workspace name', value: ws.name},
  ], async (values) => {
    const name = values['ws-name'];
    if (!name) return;
    await fetch(`/api/workspaces/${wsId}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
    });
    ws.name = name;
    renderWorkspaces();
  });
}

async function renameTab(tabId) {
  const ws = _workspaces.find(w => w.id === _selectedWsId);
  const tab = ws && ws.tabs.find(t => t.id === tabId);
  if (!tab) return;
  showForm('Rename tab', [
    {id: 'tab-name', placeholder: 'Tab name', value: tab.name},
  ], async (values) => {
    const name = values['tab-name'];
    if (!name) return;
    await fetch(`/api/tabs/${tabId}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
    });
    tab.name = name;
    renderSelectedWorkspace();
  });
}

function renderSelectedWorkspace() {
  const main = document.getElementById('ws-main');
  const ws = _workspaces.find(w => w.id === _selectedWsId);
  if (!ws) {
    main.innerHTML = '<div class="ws-empty" style="padding:16px">No workspace selected</div>';
    return;
  }

  // Stash terminal containers in a hidden div before rebuilding innerHTML.
  let stash = document.getElementById('terminal-stash');
  if (!stash) {
    stash = document.createElement('div');
    stash.id = 'terminal-stash';
    stash.style.cssText = 'position:fixed;left:-9999px;top:0;width:100vw;height:100vh;overflow:hidden;pointer-events:none';
    document.body.appendChild(stash);
  }
  for (const [, entry] of Object.entries(_tabTerminals)) {
    if (entry.container.parentElement) {
      entry.skipNextFit = true;
      stash.appendChild(entry.container);
    }
  }
  _selectedWsSubtab = normalizeWsSubtab(ws, _selectedWsSubtab);
  _wsSubtabs[ws.id] = _selectedWsSubtab;

  const tabButtons = ws.tabs.map(t => {
    const tabKey = 'tab-' + t.id;
    const exitedClass = _exitedTabs.has(t.id) ? ' exited' : '';
    const mouseOn = t.mouse_wheel_fs;
    const fsBadge = `<span id="altscreen-${t.id}" class="altscreen-badge" style="display:none" onclick="event.stopPropagation(); toggleMouseWheel(${t.id})" title="Click to ${mouseOn ? 'disable' : 'enable'} mouse wheel in fullscreen">FS${mouseOn ? '\u{1f5b1}' : ''}</span>`;
    return `<button class="ws-subtab${exitedClass} ${_selectedWsSubtab === tabKey ? 'active' : ''}" draggable="true" data-tab-id="${t.id}" onclick="switchWsSubtab('${tabKey}')"><span class="ws-subtab-inner"><span id="activity-tab-${t.id}" class="activity-dot"></span><span class="ws-subtab-close" onclick="event.stopPropagation(); confirmCloseTab(${t.id}, '${esc(t.name)}')">\u2715</span><span class="ws-subtab-label" ondblclick="event.stopPropagation(); renameTab(${t.id})">${esc(t.name)}</span>${fsBadge}</span></button>`;
  }).join('');

  const currentEntry = _selectedWsSubtab ? _tabTerminals[parseInt(_selectedWsSubtab.replace('tab-', ''))] : null;
  const currentTitle = currentEntry && currentEntry.paneTitle ? currentEntry.paneTitle : '';

  main.innerHTML = `
    <div class="ws-subtabs">
      ${tabButtons}
      <button class="ws-subtab ws-subtab-add" onclick="addShellPane(${ws.id})">+</button>
    </div>
    <div class="pane-title-bar" id="pane-title-bar" style="${currentTitle ? '' : 'display:none'}">${esc(currentTitle)}</div>
    <div class="ws-pane active" id="ws-active-pane"></div>
  `;

  const paneEl = document.getElementById('ws-active-pane');
  if (!_selectedWsSubtab) {
    paneEl.innerHTML = '<div class="ws-empty" style="padding:16px">No panes open</div>';
  } else {
    const tabId = parseInt(_selectedWsSubtab.replace('tab-', ''));
    const tab = ws.tabs.find(t => t.id === tabId);
    if (tab && tab.tab_type === 'shell') {
      initTerminal(tabId, paneEl, {workspaceId: ws.id, tabId: 'tab-' + tabId});
    }
  }

  // Restore altscreen badge and scrollbar state for all tabs
  for (const [key, entry] of Object.entries(_tabTerminals)) {
    const badge = document.getElementById('altscreen-' + key);
    if (badge) badge.style.display = entry.altScreen ? 'inline' : 'none';
    entry.container.classList.toggle('xterm-altscreen', entry.altScreen);
  }
  updateActivityDots();
  initTabDragDrop();
}

function initTabDragDrop() {
  const bar = document.querySelector('.ws-subtabs');
  if (!bar) return;
  let dragTabId = null;
  bar.addEventListener('dragstart', (e) => {
    const btn = e.target.closest('[data-tab-id]');
    if (!btn) return;
    dragTabId = parseInt(btn.dataset.tabId);
    e.dataTransfer.effectAllowed = 'move';
    btn.classList.add('dragging');
  });
  bar.addEventListener('dragend', (e) => {
    const btn = e.target.closest('[data-tab-id]');
    if (btn) btn.classList.remove('dragging');
    bar.querySelectorAll('.drag-over-left, .drag-over-right').forEach(el => el.classList.remove('drag-over-left', 'drag-over-right'));
  });
  bar.addEventListener('dragover', (e) => {
    const btn = e.target.closest('[data-tab-id]');
    if (!btn) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    bar.querySelectorAll('.drag-over-left, .drag-over-right').forEach(el => el.classList.remove('drag-over-left', 'drag-over-right'));
    const rect = btn.getBoundingClientRect();
    const inRightHalf = (e.clientX - rect.left) > rect.width / 2;
    btn.classList.add(inRightHalf ? 'drag-over-right' : 'drag-over-left');
  });
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    bar.querySelectorAll('.drag-over-left, .drag-over-right').forEach(el => el.classList.remove('drag-over-left', 'drag-over-right'));
    const btn = e.target.closest('[data-tab-id]');
    if (!btn || dragTabId == null) return;
    const targetTabId = parseInt(btn.dataset.tabId);
    if (targetTabId === dragTabId) return;
    const ws = _workspaces.find(w => w.id === _selectedWsId);
    if (!ws) return;
    const fromIdx = ws.tabs.findIndex(t => t.id === dragTabId);
    let toIdx = ws.tabs.findIndex(t => t.id === targetTabId);
    if (fromIdx < 0 || toIdx < 0) return;
    const rect = btn.getBoundingClientRect();
    const inRightHalf = (e.clientX - rect.left) > rect.width / 2;
    const [moved] = ws.tabs.splice(fromIdx, 1);
    toIdx = ws.tabs.findIndex(t => t.id === targetTabId);
    if (inRightHalf) toIdx++;
    ws.tabs.splice(toIdx, 0, moved);
    fetch(`/api/workspaces/${ws.id}/tabs/reorder`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ ids: ws.tabs.map(t => t.id) }),
    });
    renderSelectedWorkspace();
  });
}

function reconnectAllTerminals() {
  for (const [key, entry] of Object.entries(_tabTerminals)) {
    if (!entry.disposed && !entry.connected) {
      entry.connectWs();
    }
  }
}


function initTerminal(key, paneEl, opts) {
  // Reuse existing terminal — never detach from DOM to preserve scroll state.
  // Instead, move container into the pane if needed and ensure it's visible.
  if (_tabTerminals[key]) {
    const t = _tabTerminals[key];
    if (t.container.parentElement !== paneEl) {
      paneEl.appendChild(t.container);
    }
    // Reattach triggers a ResizeObserver notification. Skip that one (it fires
    // before layout is stable), but fit in rAF so the terminal adapts to the
    // actual pane width (stash uses 100vw which may differ).
    // Skip the ResizeObserver's fit (fires before layout is stable).
    // Use double-rAF to ensure layout has settled before fitting — single rAF
    // can fire before the browser applies the pane's dimensions, causing fit()
    // to pick up the stash's 100vw width and send a spurious resize.
    t.skipNextFit = true;
    t.term.scrollToBottom();
    requestAnimationFrame(() => { requestAnimationFrame(() => {
      t.fitAddon.fit();
      // DOM scrollTop resets to 0 on reattach even though xterm.js viewportY
      // is correct. Sync the DOM so mouse wheel scrolling works.
      const vp = t.container.querySelector('.xterm-viewport');
      if (vp) {
        vp.scrollTop = vp.scrollHeight - vp.clientHeight;
      }
    }); });
    t.term.focus();
    return;
  }

  const container = document.createElement('div');
  container.style.flex = '1';
  container.style.minHeight = '0';
  paneEl.innerHTML = '';
  paneEl.appendChild(container);

  const termConfig = getTerminalConfig();
  if (opts.readOnly) termConfig.disableStdin = true;
  const term = new Terminal(termConfig);

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  if (typeof WebLinksAddon !== 'undefined') {
    term.loadAddon(new WebLinksAddon.WebLinksAddon((e, url) => {
      if (e.ctrlKey || e.metaKey) window.open(url, '_blank');
    }));
  }
  term.open(container);
  fitAddon.fit();

  const entry = { term, ws: null, fitAddon, container, resizeObserver: null, opts, disposed: false, connected: false, connectWs: null, altScreen: false, _autoScroll: true, paneTitle: '' };

  term.onTitleChange((title) => {
    entry.paneTitle = title;
    const bar = document.getElementById('pane-title-bar');
    if (bar && entry.container.closest('#ws-active-pane')) {
      if (title) {
        bar.textContent = title;
        bar.style.display = '';
      } else {
        bar.style.display = 'none';
      }
    }
  });
  _tabTerminals[key] = entry;

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    if (opts.cwd) params.set('cwd', opts.cwd);
    if (opts.cmd) params.set('cmd', opts.cmd);
    if (opts.workspaceId != null) params.set('workspace_id', opts.workspaceId);
    if (opts.tabId) params.set('tab_id', opts.tabId);
    params.set('cols', term.cols);
    params.set('rows', term.rows);
    const wsUrl = proto + '//' + location.host + '/api/terminal' + '?' + params.toString();
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    entry.ws = ws;

    ws.onopen = () => {
      entry.connected = true;
      entry.connectedAt = Date.now();
      clearPaneError(entry);
      // Only focus if this terminal is in the active pane (not stashed)
      if (entry.container.closest('#ws-active-pane')) term.focus();
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && e.data.startsWith('{"type":"pane_exit"')) {
        // Mark the pane exited but do NOT auto-delete. The pane can die for many
        // reasons — shell exit, tmux churn, bugs — and losing tabs to transient
        // events loses work. User dismisses via the close (X) button.
        console.log('[pane_exit] received for key=' + key + ' (type=' + typeof key + ')');
        if (typeof key === 'number') {
          _exitedTabs.add(key);
          renderSelectedWorkspace();
        }
        return;
      }
      if (typeof e.data === 'string' && e.data.startsWith('{"type":"pane_title"')) {
        try {
          const msg = JSON.parse(e.data);
          entry.paneTitle = msg.title || '';
          const bar = document.getElementById('pane-title-bar');
          if (bar && entry.container.closest('#ws-active-pane')) {
            if (entry.paneTitle) {
              bar.textContent = entry.paneTitle;
              bar.style.display = '';
            } else {
              bar.style.display = 'none';
            }
          }
        } catch {}
        return;
      }
      if (typeof e.data === 'string' && e.data.startsWith('{"type":"altscreen"')) {
        try {
          const msg = JSON.parse(e.data);
          entry.altScreen = msg.active;
          const indicator = document.getElementById('altscreen-' + key);
          if (indicator) indicator.style.display = msg.active ? 'inline' : 'none';
          entry.container.classList.toggle('xterm-altscreen', msg.active);
        } catch {}
        return;
      }
      const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data;
      if (opts.workspaceId != null
          && entry.connectedAt && Date.now() - entry.connectedAt > 2000) {
        const now = Date.now();
        if (shouldRecordOutput(isWsSelected(_selectedWsId, opts.workspaceId), now, _wsOutputGrace[opts.workspaceId])) {
          _wsLastOutput[opts.workspaceId] = now;
        }
        if (typeof key === 'number') {
          const isTabSelected = isWsSelected(_selectedWsId, opts.workspaceId) && _selectedWsSubtab === 'tab-' + key;
          if (shouldRecordOutput(isTabSelected, now, _tabOutputGrace[key])) {
            _tabLastOutput[key] = now;
          }
        }
      }
      // Auto-scroll: use _autoScroll flag instead of checking viewportY vs
      // baseY on each write. The flag is only cleared by explicit user
      // wheel-scroll-up, not by transient viewport desyncs that can occur
      // during xterm.js sync mode rendering or resize reflows.
      term.write(data, () => {
        if (entry._autoScroll && !term.hasSelection()) {
          term.scrollToBottom();
        }
      });
    };

    ws.onerror = () => {
      entry.connectError = true;
      const overlay = document.createElement('div');
      overlay.className = 'pane-error-overlay';
      overlay.innerHTML = 'Connection failed \u2014 session may no longer exist.'
        + (opts.workspaceId != null
          ? '<br><button class="btn-primary" style="margin-top:8px;margin-right:8px" onclick="this.disabled=true;this.textContent=\'Recreating\u2026\';recreateWorkspace(' + opts.workspaceId + ')">Recreate</button>'
            + '<button class="btn-danger" style="margin-top:8px" onclick="this.disabled=true;this.textContent=\'Destroying\u2026\';destroyWorkspace(' + opts.workspaceId + ')">Destroy Workspace</button>'
          : '');
      container.style.position = 'relative';
      container.appendChild(overlay);
    };

    ws.onclose = () => {
      entry.connected = false;
      // Reconnection is handled by reconnectAllTerminals() when SSE reconnects
    };
  }

  entry.connectWs = connectWs;
  connectWs();

  // Auto-scroll: disabled when the user scrolls up via mouse wheel, re-enabled
  // when they scroll back to the bottom. This avoids the feedback loop where a
  // transient viewportY desync permanently disables auto-scroll.
  container.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) {
      // Scrolling up — disable auto-scroll
      entry._autoScroll = false;
    } else if (e.deltaY > 0) {
      // Scrolling down — re-enable if we've reached the bottom
      requestAnimationFrame(() => {
        const buf = term.buffer.active;
        if (buf.viewportY >= buf.baseY) {
          entry._autoScroll = true;
        }
      });
    }
  }, { passive: true });

  // In full-screen mode (emacs, vim): intercept Cmd+key and send as Meta+key.
  // In normal mode (shell, Claude): let all Cmd+key pass through to the browser
  // for native copy/paste/undo/etc behavior.
  const _shiftMap = {',':'<', '.':'>', '/':'?', ';':':', "'":'"', '[':'{', ']':'}',
    '\\':'|', '`':'~', '1':'!', '2':'@', '3':'#', '4':'$', '5':'%', '6':'^',
    '7':'&', '8':'*', '9':'(', '0':')', '-':'_', '=':'+'};
  term.attachCustomKeyEventHandler((e) => {
    // Cmd+key → send to terminal as Meta+key (ESC prefix) in all modes.
    // Cmd+Ctrl+key → send as ESC + Ctrl+key.
    // Exceptions: Cmd+C with selection (copy), Cmd+V (paste in normal mode).
    if (e.metaKey && !e.altKey) {
      let key = e.key;
      if (e.shiftKey && key.length === 1 && _shiftMap[key]) {
        key = _shiftMap[key];
      } else if (e.shiftKey && key.length === 1) {
        key = key.toUpperCase();
      }
      if (key.toLowerCase() === 'c' && term.hasSelection()) return true;
      if (key.toLowerCase() === 'v' && !entry.altScreen) return true;
      if (key.length === 1) {
        if (e.type === 'keydown' && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
          let ch = key;
          if (e.ctrlKey) {
            // Ctrl+key → control character (a=1, b=2, ..., z=26)
            const code = ch.toLowerCase().charCodeAt(0);
            if (code >= 97 && code <= 122) ch = String.fromCharCode(code - 96);
          }
          entry.ws.send('\x1b' + ch);
        }
        e.preventDefault();
        return false;
      }
      // Cmd+Backspace → Meta+Backspace (ESC + DEL)
      if (key === 'Backspace') {
        if (e.type === 'keydown' && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send('\x1b\x7f');
        }
        e.preventDefault();
        return false;
      }
    }

    // Option+key → Meta+key (for emacs M-v, M-f, M-b, etc.)
    // Exception: Option+V → browser paste
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      let key = e.key;
      if (key.toLowerCase() === 'v' || key === '√') {
        // Option+V → paste from clipboard into terminal
        if (e.type === 'keydown') {
          navigator.clipboard.readText().then(text => {
            if (text && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
              entry.ws.send(text);
            }
          }).catch(() => {});
        }
        e.preventDefault();
        return false;
      }
      if (key.length === 1) {
        if (e.type === 'keydown' && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send('\x1b' + key);
        }
        e.preventDefault();
        return false;
      }
    }

    return true;
  });

  term.onData((data) => {
    if (term.hasSelection()) term.clearSelection();
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) { entry.ws.send(data); }
  });


  // Copy-on-select: copy to clipboard whenever text is selected (like iTerm2)
  term.onSelectionChange(() => {
    const text = term.getSelection();
    if (text && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  });

  // Right-click context menu
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    closeTermContextMenu();
    const menu = document.createElement('div');
    menu.className = 'term-context-menu open';
    menu.innerHTML = '<div class="term-context-menu-item" data-action="clear">Clear</div>';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.addEventListener('click', (ev) => {
      const action = ev.target.dataset.action;
      if (action === 'clear') {
        term.clear();
      }
      closeTermContextMenu();
      term.focus();
    });
    document.body.appendChild(menu);
    // Close on next click anywhere
    setTimeout(() => document.addEventListener('click', closeTermContextMenu, { once: true }), 0);
  });

  term.onResize(({ cols, rows }) => {
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  let fitTimer = null;
  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (entry.skipNextFit) {
        entry.skipNextFit = false;
        term.scrollToBottom();
        return;
      }
      fitAddon.fit();
      if (entry._autoScroll) {
        term.scrollToBottom();
      }
    }, 100);
  });
  resizeObserver.observe(container);
  entry.resizeObserver = resizeObserver;

}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }).catch(() => {});
}


function toggleWsMenu(id) {
  const menu = document.getElementById('ws-menu-' + id);
  const wasOpen = menu.classList.contains('open');
  closeAllWsMenus();
  if (!wasOpen) menu.classList.add('open');
}

function closeAllWsMenus() {
  document.querySelectorAll('.ws-popover.open').forEach(el => el.classList.remove('open'));
}

function closeTermContextMenu() {
  document.querySelectorAll('.term-context-menu').forEach(el => el.remove());
}

async function recreateWorkspace(id) {
  const ws = _workspaces.find(w => w.id === id);
  if (ws) {
    for (const tab of ws.tabs) disposeTerminal(tab.id);
  }
  const res = await fetch(`/api/workspaces/${id}/recreate`, {method: 'POST'});
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Recreate failed: ' + (err.error || res.statusText));
    return;
  }
  renderSelectedWorkspace();
}

async function destroyWorkspace(id) {
  const ws = _workspaces.find(w => w.id === id);
  if (ws) {
    for (const tab of ws.tabs) disposeTerminal(tab.id);
  }
  _workspaces = _workspaces.filter(w => w.id !== id);
  if (_selectedWsId === id) _selectedWsId = null;
  renderWorkspaces();
  await fetch(`/api/workspaces/${id}`, {method: 'DELETE'});
  fetchWorkspaces();
}

/* Dialog system */
function openDialog(msg, fields, callback, opts) {
  _dialogCallback = callback;
  _dialogFields = fields;
  document.getElementById('dialog-msg').textContent = msg;
  clearDialogError();
  const container = document.getElementById('dialog-fields');
  container.innerHTML = '';

  let checkboxRow = null;
  let afterHeading = false;
  fields.forEach((f) => {
    if (f.type === 'heading') {
      checkboxRow = null;
      afterHeading = true;
      const h = document.createElement('div');
      h.className = 'dialog-heading';
      if (f.id) h.id = 'dlg-' + f.id;
      h.textContent = f.label;
      container.appendChild(h);
    } else if (f.type === 'checkbox' && !f.dependsOn) {
      if (afterHeading || !checkboxRow) {
        checkboxRow = document.createElement('div');
        checkboxRow.className = afterHeading ? 'checkbox-row checkbox-col' : 'checkbox-row';
        if (f.section) checkboxRow.dataset.section = f.section;
        container.appendChild(checkboxRow);
      }
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'dlg-' + f.id;
      input.checked = !!f.checked;
      if (f.disabled) input.disabled = true;
      label.appendChild(input);
      label.appendChild(document.createTextNode(f.label));
      checkboxRow.appendChild(label);
    } else if (f.type === 'checkbox' && f.dependsOn) {
      checkboxRow = null;
      const row = document.createElement('div');
      row.className = 'checkbox-row sub-checkbox-row';
      row.dataset.dependsOn = f.dependsOn;
      if (f.section) row.dataset.section = f.section;
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'dlg-' + f.id;
      input.checked = !!f.checked;
      if (f.disabled) input.disabled = true;
      label.appendChild(input);
      label.appendChild(document.createTextNode(f.label));
      row.appendChild(label);
      container.appendChild(row);
    } else if (f.type === 'select') {
      checkboxRow = null;
      afterHeading = false;
      if (f.label) {
        const lbl = document.createElement('div');
        lbl.className = 'dialog-heading';
        lbl.textContent = f.label;
        container.appendChild(lbl);
      }
      const sel = document.createElement('select');
      sel.id = 'dlg-' + f.id;
      (f.options || []).forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === f.value) o.selected = true;
        sel.appendChild(o);
      });
      container.appendChild(sel);
    } else if (f.type === 'combobox') {
      checkboxRow = null;
      afterHeading = false;
      if (f.label) {
        const lbl = document.createElement('div');
        lbl.className = 'dialog-heading';
        lbl.textContent = f.label;
        container.appendChild(lbl);
      }
      const wrapper = document.createElement('div');
      wrapper.className = 'combobox';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'dlg-' + f.id;
      input.placeholder = f.placeholder || '';
      input.value = f.value || '';
      input.autocomplete = 'off';
      const list = document.createElement('div');
      list.className = 'combobox-list';
      const allOptions = f.options || [];
      let highlightIdx = -1;

      function renderList(filter) {
        const q = filter.toLowerCase();
        const matches = q ? allOptions.filter(o => o.toLowerCase().includes(q)) : allOptions;
        highlightIdx = -1;
        list.innerHTML = '';
        matches.forEach((opt, i) => {
          const item = document.createElement('div');
          item.className = 'combobox-item' + (opt === input.value ? ' selected' : '');
          item.textContent = opt;
          item.onmousedown = (e) => {
            e.preventDefault();
            input.value = opt;
            list.classList.remove('open');
          };
          list.appendChild(item);
        });
        if (matches.length > 0) list.classList.add('open');
        else list.classList.remove('open');
      }

      input.addEventListener('focus', () => renderList(input.value));
      input.addEventListener('input', () => renderList(input.value));
      input.addEventListener('blur', () => list.classList.remove('open'));
      input.addEventListener('keydown', (e) => {
        const items = list.querySelectorAll('.combobox-item');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
          items.forEach((el, i) => el.classList.toggle('highlighted', i === highlightIdx));
          if (items[highlightIdx]) items[highlightIdx].scrollIntoView({block: 'nearest'});
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          highlightIdx = Math.max(highlightIdx - 1, 0);
          items.forEach((el, i) => el.classList.toggle('highlighted', i === highlightIdx));
          if (items[highlightIdx]) items[highlightIdx].scrollIntoView({block: 'nearest'});
        } else if (e.key === 'Enter') {
          if (highlightIdx >= 0 && items[highlightIdx]) {
            e.preventDefault();
            input.value = items[highlightIdx].textContent;
            list.classList.remove('open');
          } else {
            dialogOk();
          }
        } else if (e.key === 'Escape') {
          list.classList.remove('open');
        }
      });

      wrapper.appendChild(input);
      wrapper.appendChild(list);
      container.appendChild(wrapper);
    } else {
      checkboxRow = null;
      afterHeading = false;
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.id = 'dlg-' + f.id;
      input.placeholder = f.placeholder || '';
      input.value = f.value || '';
      input.onkeydown = (e) => { if (e.key === 'Enter') dialogOk(); };
      container.appendChild(input);
    }
  });

  // Wire up dependsOn: enable/disable sub-checkbox rows based on parent
  container.querySelectorAll('.sub-checkbox-row').forEach(row => {
    const parentId = 'dlg-' + row.dataset.dependsOn;
    const parentCb = document.getElementById(parentId);
    if (!parentCb) return;
    const update = () => {
      const enabled = parentCb.checked;
      row.style.opacity = enabled ? '1' : '0.4';
      row.querySelectorAll('input').forEach(inp => inp.disabled = !enabled);
    };
    update();
    parentCb.addEventListener('change', update);
  });

  document.getElementById('dialog-cancel').style.display = callback ? '' : 'none';
  const okBtn = document.getElementById('dialog-ok');
  if (opts && opts.destructive) {
    okBtn.className = 'btn-danger';
  } else {
    okBtn.className = 'btn-primary';
  }
  okBtn.textContent = (opts && opts.okText) || 'OK';

  document.getElementById('dialog-overlay').classList.add('open');
  const first = container.querySelector('input[type="text"]');
  if (first) { first.focus(); first.select(); }
}

function showDialog(msg, html) {
  openDialog(msg, [], null);
  if (html) document.getElementById('dialog-msg').innerHTML = msg;
}
function showConfirm(msg, callback, okText) {
  openDialog(msg, [], () => callback(), {destructive: true, okText: okText || 'Remove'});
}
function showForm(msg, fields, callback) { openDialog(msg, fields, callback); }

function setDialogError(msg) {
  const el = document.getElementById('dialog-error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function clearDialogError() {
  const el = document.getElementById('dialog-error');
  el.textContent = '';
  el.style.display = 'none';
}

async function dialogOk() {
  const cb = _dialogCallback;
  const values = {};
  _dialogFields.forEach(f => {
    if (!f.id || f.type === 'heading') return;
    const input = document.getElementById('dlg-' + f.id);
    if (f.type === 'checkbox') {
      values[f.id] = input ? input.checked : false;
    } else if (f.type === 'select') {
      values[f.id] = input ? input.value : '';
    } else {
      values[f.id] = input ? input.value.trim() : '';
    }
  });
  if (!cb) {
    closeDialog();
    return;
  }
  clearDialogError();
  try {
    const result = await cb(values);
    if (typeof result === 'string' && result) {
      setDialogError(result);
      return;
    }
    if (result === false) return;
    closeDialog();
  } catch (err) {
    setDialogError(err && err.message ? err.message : 'Something went wrong.');
  }
}

function closeDialog() {
  _dialogCallback = null;
  _dialogFields = [];
  document.getElementById('dialog-overlay').classList.remove('open');
}

/* Browser-only initialization */
if (typeof document !== 'undefined') {
  document.addEventListener('click', closeAllWsMenus);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllWsMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('dialog-overlay').classList.contains('open')) {
      closeDialog();
    }
  });
  connectSSE();
  initSidebarDragDrop();

  // Activity dot updater
  setInterval(updateActivityDots, 1000);
}

/// Adjust divider position after a workspace is removed from the list.
/// `removedIdx` is the index of the workspace that was removed.
/// Returns the new divider position.
function clearPaneError(entry) {
  entry.connectError = false;
  if (!entry.container || typeof entry.container.querySelector !== 'function') return;
  const overlay = entry.container.querySelector('.pane-error-overlay');
  if (overlay) overlay.remove();
}

/* Node.js exports for testing */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getDefaultWsSubtab,
    normalizeWsSubtab,
    getTerminalConfig,
    escAttr,
    containsEraseDisplay,
    computeDotState,
    tickDot,
    isWsSelected,
    shouldRecordOutput,
    morphdomShouldUpdate,
    clearPaneError,
  };
}
