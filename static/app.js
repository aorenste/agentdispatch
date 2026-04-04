/* AgentDispatch UI */

let evtSource = null;
let buildHash = null;
let _projects = [];
let _workspaces = [];
let _selectedWsId = null;
let _selectedWsSubtab = 'agent';
let _wsSubtabs = {}; // workspace id -> last selected subtab
let _tabTerminals = {}; // keyed by tab id -> {term, ws, fitAddon, container}
let _dialogCallback = null;
let _dialogFields = [];

/* -- Pure logic (testable without DOM) -- */

function getProjectAgent(proj) {
  if (!proj) return 'Claude';
  if (proj.agent === 'Claude' || proj.agent === 'Codex' || proj.agent === 'None') {
    return proj.agent;
  }
  return 'Claude';
}

function getDefaultWsSubtab(ws) {
  const proj = ws ? _projects.find(p => p.name === ws.project) : null;
  if (getProjectAgent(proj) !== 'None') return 'agent';
  if (ws && ws.tabs.length > 0) return 'tab-' + ws.tabs[0].id;
  return '';
}

function normalizeWsSubtab(ws, subtab) {
  if (!ws) return '';
  if (subtab === 'claude') subtab = 'agent';
  if (subtab === 'agent') return getDefaultWsSubtab(ws);
  if (subtab && subtab.startsWith('tab-')) {
    return ws.tabs.some(t => 'tab-' + t.id === subtab) ? subtab : getDefaultWsSubtab(ws);
  }
  return getDefaultWsSubtab(ws);
}

function getTerminalConfig() {
  return {
    cursorBlink: true,
    scrollback: 10000,
    theme: {
      background: '#000000',
      foreground: '#e2e8f0',
      cursor: '#818cf8',
      selectionBackground: 'rgba(129, 140, 248, 0.3)',
    },
  };
}

function buildAgentCommand(agent, proj) {
  let cmd = agent === 'Codex' ? 'codex' : 'claude';
  if ((agent === 'Claude' || agent === 'Codex') && proj && proj.claude_internet) {
    cmd += ' --dangerously-enable-internet-mode';
  }
  if (agent === 'Claude' && proj && proj.claude_skip_permissions) {
    cmd += ' --dangerously-skip-permissions';
  }
  if (proj && proj.conda_env) {
    cmd = 'conda activate ' + proj.conda_env + ' && ' + cmd;
  }
  return cmd;
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
    fetchProjects();
    fetchWorkspaces();
    reconnectAllTerminals();
  });

  evtSource.addEventListener('update', e => {
    const data = JSON.parse(e.data);
    if (data.build_hash && data.build_hash !== buildHash) {
      location.reload();
    }
  });

  evtSource.onerror = () => {
    document.getElementById('conn-overlay').classList.add('active');
    status.textContent = 'Disconnected \u2014 reconnecting\u2026';
    status.className = 'error';
    status.style.display = 'block';
  };
}

/* Projects */
async function fetchProjects() {
  try {
    const res = await fetch('/api/projects');
    const projects = await res.json();
    renderProjects(projects);
  } catch {}
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

function renderProjects(projects) {
  _projects = projects;
  const container = document.getElementById('projects');
  const empty = document.getElementById('no-projects');
  if (projects.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  container.innerHTML = projects.map(p => `
    <div class="project-row">
      <div class="project-info">
        <span class="project-name">${esc(p.name)}</span>
        <span class="project-dir">${esc(p.root_dir)}</span>
      </div>
      <div class="project-actions">
        <button class="btn-primary" onclick="launchProject('${escAttr(p.name)}')">Launch</button>
        <button class="btn-secondary" onclick="showProjectInfo('${escAttr(p.name)}')">Edit</button>
        <button class="btn-danger" onclick="removeProject('${escAttr(p.name)}')">Remove</button>
      </div>
    </div>
  `).join('');
}

async function fetchCondaEnvs() {
  try {
    const res = await fetch('/api/conda-envs');
    return await res.json();
  } catch { return []; }
}

async function readApiError(res, fallback) {
  try {
    const data = await res.json();
    return data && data.error ? data.error : fallback;
  } catch {
    return fallback;
  }
}

async function checkIsGitDir(path) {
  if (!path) return false;
  try {
    const res = await fetch(`/api/check-git?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const data = await res.json();
      return !!data.git;
    }
  } catch {}
  return false;
}

async function showAddProject() {
  const condaEnvs = await fetchCondaEnvs();
  showForm('Add Project', [
    {id: 'proj-name', placeholder: 'Project name'},
    {id: 'proj-dir', placeholder: 'Root directory'},
    {id: 'proj-git', type: 'checkbox', label: 'Make new git worktree', checked: false, disabled: true},
    {id: 'proj-conda', type: 'select', label: 'Conda environment', options: ['none', ...condaEnvs], value: 'none'},
    {id: 'proj-agent', type: 'select', label: 'Agent', options: ['Claude', 'Codex', 'None'], value: 'Claude'},
    {id: 'proj-agent-options-heading', type: 'heading', label: 'Claude Options'},
    {id: 'proj-claude-internet', type: 'checkbox', label: '--dangerously-enable-internet-mode', checked: false, section: 'agent-options'},
    {id: 'proj-claude-skip-perms', type: 'checkbox', label: '--dangerously-skip-permissions', checked: false, section: 'agent-options'},
  ], async (values) => {
    const name = values['proj-name'];
    const dir = values['proj-dir'];
    // Force git off if the checkbox is disabled (non-git dir)
    const gitCb = document.getElementById('dlg-proj-git');
    if (gitCb && gitCb.disabled) values['proj-git'] = false;
    if (!name) {
      return 'Project name is required.';
    }
    if (!dir) {
      return 'Root directory is required.';
    }
    const conda = values['proj-conda'] === 'none' ? '' : values['proj-conda'];
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name, root_dir: dir,
          git: values['proj-git'],
          agent: values['proj-agent'],
          conda_env: conda,
          claude_internet: values['proj-claude-internet'],
          claude_skip_permissions: values['proj-claude-skip-perms'],
        }),
      });
      if (!res.ok) {
        return await readApiError(res, `Failed to add project. "${dir}" must be an existing directory.`);
      }
      fetchProjects();
    } catch {
      return 'Failed to add project. Check that the server is reachable and try again.';
    }
  });
  // Wire up auto-detect: when directory field loses focus, check if it's a git repo
  const dirInput = document.getElementById('dlg-proj-dir');
  const gitCb = document.getElementById('dlg-proj-git');
  if (dirInput && gitCb) {
    const updateGit = async () => {
      const path = dirInput.value.trim();
      if (!path) {
        gitCb.checked = false;
        gitCb.disabled = true;
        return;
      }
      const isGit = await checkIsGitDir(path);
      gitCb.checked = isGit;
      gitCb.disabled = !isGit;
    };
    dirInput.addEventListener('blur', updateGit);
  }
}

async function showProjectInfo(name) {
  const p = _projects.find(proj => proj.name === name);
  if (!p) return;
  const condaEnvs = await fetchCondaEnvs();
  const condaVal = p.conda_env || 'none';
  const agentVal = getProjectAgent(p);
  const isGit = await checkIsGitDir(p.root_dir);
  showForm('Edit Project', [
    {id: 'proj-name', placeholder: 'Project name', value: p.name},
    {id: 'proj-dir', placeholder: 'Root directory', value: p.root_dir},
    {id: 'proj-git', type: 'checkbox', label: 'Make new git worktree', checked: isGit && p.git, disabled: !isGit},
    {id: 'proj-conda', type: 'select', label: 'Conda environment', options: ['none', ...condaEnvs], value: condaVal},
    {id: 'proj-agent', type: 'select', label: 'Agent', options: ['Claude', 'Codex', 'None'], value: agentVal},
    {id: 'proj-agent-options-heading', type: 'heading', label: 'Claude Options'},
    {id: 'proj-claude-internet', type: 'checkbox', label: '--dangerously-enable-internet-mode', checked: p.claude_internet, section: 'agent-options'},
    {id: 'proj-claude-skip-perms', type: 'checkbox', label: '--dangerously-skip-permissions', checked: p.claude_skip_permissions, section: 'agent-options'},
  ], async (values) => {
    const newName = values['proj-name'];
    const dir = values['proj-dir'];
    if (!newName) {
      return 'Project name is required.';
    }
    if (!dir) {
      return 'Root directory is required.';
    }
    const conda = values['proj-conda'] === 'none' ? '' : values['proj-conda'];
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: newName, root_dir: dir,
          git: values['proj-git'],
          agent: values['proj-agent'],
          conda_env: conda,
          claude_internet: values['proj-claude-internet'],
          claude_skip_permissions: values['proj-claude-skip-perms'],
        }),
      });
      if (!res.ok) {
        return await readApiError(res, `Failed to update project. "${dir}" must be an existing directory.`);
      }
      fetchProjects();
    } catch {
      return 'Failed to update project. Check that the server is reachable and try again.';
    }
  });
  // Wire up auto-detect for directory changes
  const dirInput = document.getElementById('dlg-proj-dir');
  const gitCb = document.getElementById('dlg-proj-git');
  if (dirInput && gitCb) {
    dirInput.addEventListener('blur', async () => {
      const path = dirInput.value.trim();
      if (!path) {
        gitCb.checked = false;
        gitCb.disabled = true;
        return;
      }
      const isGit = await checkIsGitDir(path);
      gitCb.checked = isGit;
      gitCb.disabled = !isGit;
    });
  }
}

async function launchProject(name) {
  const p = _projects.find(proj => proj.name === name);
  const fields = [
    {id: 'ws-name', placeholder: 'Workspace name (optional)'},
  ];
  if (p && p.git) {
    // Fetch branches with a timeout so slow repos don't block the dialog
    let branches = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}/branches`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) branches = data;
      }
    } catch {}
    const options = ['HEAD', ...branches.filter(b => b !== 'HEAD')];
    fields.push({id: 'ws-revision', type: 'combobox', label: 'Start revision', options, value: 'HEAD'});
  }
  showForm('Launch Workspace', fields, async (values) => {
    const body = {};
    if (values['ws-name']) body.name = values['ws-name'];
    const rev = values['ws-revision'];
    if (rev && rev !== 'HEAD') body.revision = rev;
    const res = await fetch(`/api/projects/${encodeURIComponent(name)}/launch`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) { showDialog(data.error); return; }
    _selectedWsId = data.id;
    switchTab('workspaces');
  });
}

async function removeProject(name) {
  showConfirm(`Remove project "${name}"?`, async () => {
    await fetch(`/api/projects/${encodeURIComponent(name)}`, {method: 'DELETE'});
    fetchProjects();
  });
}

/* Workspaces */
async function fetchWorkspaces() {
  try {
    const res = await fetch('/api/workspaces');
    const workspaces = await res.json();
    _workspaces = workspaces;
    renderWorkspaces();
  } catch {}
}

function renderWorkspaces() {
  const sidebar = document.getElementById('ws-sidebar');
  if (_workspaces.length === 0) {
    sidebar.innerHTML = '<div class="ws-empty">No workspaces</div>';
    renderSelectedWorkspace();
    return;
  }
  sidebar.innerHTML = _workspaces.map(ws => `
    <div class="ws-sidebar-item ${ws.id === _selectedWsId ? 'active' : ''}"
         onclick="selectWorkspace(${ws.id})">
      <div class="ws-sidebar-info">
        <div class="ws-name" ondblclick="event.stopPropagation(); renameWorkspace(${ws.id})">${esc(ws.name)}</div>
        <div class="ws-project">${esc(ws.project)}</div>
      </div>
      <button class="ws-menu-btn" onclick="event.stopPropagation(); toggleWsMenu(${ws.id})">\u2026</button>
      <div class="ws-popover" id="ws-menu-${ws.id}">
        <div class="ws-popover-item" onclick="event.stopPropagation(); renameWorkspace(${ws.id})">Rename</div>
        <div class="ws-popover-item" onclick="event.stopPropagation(); showWsInfo(${ws.id})">Info</div>
        <div class="ws-popover-item danger" onclick="event.stopPropagation(); destroyWorkspace(${ws.id})">Destroy</div>
      </div>
    </div>
  `).join('');
  renderSelectedWorkspace();
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
  showConfirm(`Close "${tabName}"?`, () => closeTab(tabId), 'Close');
}

async function closeTab(tabId) {
  disposeTerminal(tabId);
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

let _setupPollTimer = null;

function renderSelectedWorkspace() {
  const main = document.getElementById('ws-main');
  const ws = _workspaces.find(w => w.id === _selectedWsId);
  if (!ws) {
    main.innerHTML = '<div class="ws-empty" style="padding:16px">No workspace selected</div>';
    return;
  }

  // Show setup message while workspace is being prepared
  if (ws.status === 'setting_up') {
    main.innerHTML = '<div class="ws-empty" style="padding:16px">Setting up workspace\u2026</div>';
    startSetupPoll();
    return;
  }
  if (ws.status === 'error') {
    main.innerHTML = '<div class="ws-empty" style="padding:16px;color:var(--red)">Workspace setup failed</div>';
    return;
  }
  stopSetupPoll();

  // Stash terminal containers in a hidden div before rebuilding innerHTML.
  // This keeps them in the DOM so xterm.js viewport scroll state is preserved.
  let stash = document.getElementById('terminal-stash');
  if (!stash) {
    stash = document.createElement('div');
    stash.id = 'terminal-stash';
    stash.style.cssText = 'position:fixed;left:-9999px;top:0;width:100vw;height:100vh;overflow:hidden;pointer-events:none';
    document.body.appendChild(stash);
  }
  for (const [, entry] of Object.entries(_tabTerminals)) {
    if (entry.container.parentElement) {
      stash.appendChild(entry.container);
    }
  }

  const proj = _projects.find(p => p.name === ws.project);
  const agent = getProjectAgent(proj);
  const agentEnabled = agent !== 'None';
  _selectedWsSubtab = normalizeWsSubtab(ws, _selectedWsSubtab);
  _wsSubtabs[ws.id] = _selectedWsSubtab;

  const tabButtons = ws.tabs.map(t => {
    const tabKey = 'tab-' + t.id;
    return `<button class="ws-subtab ${_selectedWsSubtab === tabKey ? 'active' : ''}" onclick="switchWsSubtab('${tabKey}')"><span class="ws-subtab-inner"><span class="ws-subtab-close" onclick="event.stopPropagation(); confirmCloseTab(${t.id}, '${esc(t.name)}')">\u2715</span><span class="ws-subtab-label" ondblclick="event.stopPropagation(); renameTab(${t.id})">${esc(t.name)}</span><span id="altscreen-${t.id}" class="altscreen-badge" style="display:none">FS</span></span></button>`;
  }).join('');

  main.innerHTML = `
    <div class="ws-subtabs">
      ${agentEnabled ? `<button class="ws-subtab ${_selectedWsSubtab === 'agent' ? 'active' : ''}" onclick="switchWsSubtab('agent')">${esc(agent)}<span id="altscreen-agent-${ws.id}" class="altscreen-badge" style="display:none">FS</span></button>` : ''}
      ${tabButtons}
      <button class="ws-subtab ws-subtab-add" onclick="addShellPane(${ws.id})">+</button>
    </div>
    <div class="ws-pane active" id="ws-active-pane"></div>
  `;

  const paneEl = document.getElementById('ws-active-pane');
  const cwd = ws.worktree_dir || (proj ? proj.root_dir : null);
  if (_selectedWsSubtab === 'agent') {
    const agentCmd = buildAgentCommand(agent, proj);
    const agentTerminal = _tabTerminals['agent-' + ws.id];
    if (agentTerminal && (agentTerminal.opts.cmd !== agentCmd || agentTerminal.opts.cwd !== cwd)) {
      disposeTerminal('agent-' + ws.id);
    }
    initTerminal('agent-' + ws.id, paneEl, {cwd, cmd: agentCmd, workspaceId: ws.id, tabId: 'agent'});
  } else if (!_selectedWsSubtab) {
    disposeTerminal('agent-' + ws.id);
    paneEl.innerHTML = '<div class="ws-empty" style="padding:16px">No panes open</div>';
  } else {
    const tabId = parseInt(_selectedWsSubtab.replace('tab-', ''));
    const tab = ws.tabs.find(t => t.id === tabId);
    if (tab && tab.tab_type === 'shell') {
      initTerminal(tabId, paneEl, {cwd, workspaceId: ws.id, tabId: 'tab-' + tabId});
    }
  }

  // Restore altscreen badge state for all tabs
  for (const [key, entry] of Object.entries(_tabTerminals)) {
    const badge = document.getElementById('altscreen-' + key);
    if (entry.altScreen) console.log('restore badge:', key, 'altScreen:', entry.altScreen, 'badge:', !!badge);
    if (badge) badge.style.display = entry.altScreen ? 'inline' : 'none';
  }
}

function startSetupPoll() {
  if (_setupPollTimer) return;
  _setupPollTimer = setInterval(() => fetchWorkspaces(), 1000);
}

function stopSetupPoll() {
  if (_setupPollTimer) {
    clearInterval(_setupPollTimer);
    _setupPollTimer = null;
  }
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
    // Skip the next ResizeObserver fit — reattach triggers a resize observation
    // but fit() resets the viewport. Just restore scroll position instead.
    t.skipNextFit = true;
    t.term.scrollToBottom();
    // After reattach, DOM scrollTop resets to 0 even though xterm.js viewportY
    // is correct. Sync the DOM after layout to fix mouse wheel scrolling.
    requestAnimationFrame(() => {
      const vp = t.container.querySelector('.xterm-viewport');
      if (vp) {
        vp.scrollTop = vp.scrollHeight - vp.clientHeight;
      }
    });
    t.term.focus();
    return;
  }

  const container = document.createElement('div');
  container.style.flex = '1';
  container.style.minHeight = '0';
  paneEl.innerHTML = '';
  paneEl.appendChild(container);

  const term = new Terminal(getTerminalConfig());

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  const entry = { term, ws: null, fitAddon, container, resizeObserver: null, opts, disposed: false, connected: false, connectWs: null, altScreen: false };
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
      term.focus();
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
      } else if (typeof e.data === 'string' && e.data.startsWith('{"type":"altscreen"')) {
        try {
          const msg = JSON.parse(e.data);
          entry.altScreen = msg.active;
          const indicator = document.getElementById('altscreen-' + key);
          if (indicator) indicator.style.display = msg.active ? 'inline' : 'none';
        } catch {}
        return;
      } else {
        term.write(e.data);
      }
    };

    ws.onerror = () => {
      const overlay = document.createElement('div');
      overlay.className = 'pane-error-overlay';
      overlay.textContent = 'Connection failed — session may no longer exist.';
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

  // In full-screen mode (emacs, vim): intercept Cmd+key and send as Meta+key.
  // In normal mode (shell, Claude): let all Cmd+key pass through to the browser
  // for native copy/paste/undo/etc behavior.
  const _shiftMap = {',':'<', '.':'>', '/':'?', ';':':', "'":'"', '[':'{', ']':'}',
    '\\':'|', '`':'~', '1':'!', '2':'@', '3':'#', '4':'$', '5':'%', '6':'^',
    '7':'&', '8':'*', '9':'(', '0':')', '-':'_', '=':'+'};
  term.attachCustomKeyEventHandler((e) => {
    if (!entry.altScreen) {
      // Normal mode: let browser handle all Cmd+key and Option+key
      return true;
    }

    // Full-screen mode (emacs, vim):
    // Cmd+key → Meta+key (ESC prefix)
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      let key = e.key;
      if (e.shiftKey && key.length === 1 && _shiftMap[key]) {
        key = _shiftMap[key];
      } else if (e.shiftKey && key.length === 1) {
        key = key.toUpperCase();
      }
      // Still let Cmd+C copy when there's a selection
      if (key.toLowerCase() === 'c' && term.hasSelection()) return true;
      if (key.length === 1) {
        if (e.type === 'keydown' && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send('\x1b' + key);
        }
        e.preventDefault();
        return false;
      }
      // Cmd+Backspace/Delete → send as Meta+Backspace (ESC + DEL)
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
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) { entry.ws.send(data); }
  });

  // Copy-on-select: copy to clipboard whenever text is selected (like iTerm2)
  term.onSelectionChange(() => {
    const text = term.getSelection();
    if (text && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
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
      const buf = term.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;
      fitAddon.fit();
      if (wasAtBottom) {
        term.scrollToBottom();
      }
    }, 100);
  });
  resizeObserver.observe(container);
  entry.resizeObserver = resizeObserver;

}

function showWsInfo(id) {
  closeAllWsMenus();
  const ws = _workspaces.find(w => w.id === id);
  if (!ws) return;
  const proj = _projects.find(p => p.name === ws.project);
  let info = `Name: ${ws.name}\nProject: ${ws.project}\nCreated: ${ws.created_at}`;
  if (ws.worktree_dir) {
    info += `\nWorktree: ${ws.worktree_dir}`;
  }
  if (proj) {
    info += `\nRoot: ${proj.root_dir}`;
  }
  showDialog(info);
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

async function destroyWorkspace(id) {
  const ws = _workspaces.find(w => w.id === id);
  if (ws) {
    for (const tab of ws.tabs) disposeTerminal(tab.id);
  }
  disposeTerminal('agent-' + id);
  await fetch(`/api/workspaces/${id}`, {method: 'DELETE'});
  if (_selectedWsId === id) _selectedWsId = null;
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

  const agentSelect = document.getElementById('dlg-proj-agent');
  const agentHeading = document.getElementById('dlg-proj-agent-options-heading');
  const agentRows = container.querySelectorAll('[data-section="agent-options"]');
  const internetInput = document.getElementById('dlg-proj-claude-internet');
  const skipPermsInput = document.getElementById('dlg-proj-claude-skip-perms');
  if (agentSelect && agentHeading && agentRows.length > 0) {
    const updateAgentOptions = () => {
      const agent = agentSelect.value;
      if (agent === 'Claude') agentHeading.textContent = 'Claude Options';
      else if (agent === 'Codex') agentHeading.textContent = 'Codex Options';
      else agentHeading.textContent = 'Agent Options';

      const enabled = agent !== 'None';
      agentHeading.style.opacity = enabled ? '1' : '0.45';
      agentRows.forEach(row => {
        row.style.opacity = enabled ? '1' : '0.45';
        row.querySelectorAll('input, select, button').forEach(el => {
          el.disabled = !enabled;
        });
      });

      if (internetInput) {
        const internetLabel = internetInput.closest('label');
        if (internetLabel) internetLabel.style.display = enabled ? '' : 'none';
      }

      if (skipPermsInput) {
        const skipPermsLabel = skipPermsInput.closest('label');
        const showSkipPerms = agent === 'Claude';
        skipPermsInput.disabled = !showSkipPerms;
        if (skipPermsLabel) skipPermsLabel.style.display = showSkipPerms ? '' : 'none';
      }
    };
    updateAgentOptions();
    agentSelect.addEventListener('change', updateAgentOptions);
  }

  document.getElementById('dialog-cancel').style.display = callback ? '' : 'none';
  const okBtn = document.getElementById('dialog-ok');
  if (opts && opts.destructive) {
    okBtn.className = 'btn-danger';
    okBtn.textContent = opts.okText || 'OK';
  } else {
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'OK';
  }

  document.getElementById('dialog-overlay').classList.add('open');
  const first = container.querySelector('input[type="text"]');
  if (first) { first.focus(); first.select(); }
}

function showDialog(msg) { openDialog(msg, [], null); }
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
  fetchProjects();
}

/* Node.js exports for testing */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getProjectAgent,
    getDefaultWsSubtab,
    normalizeWsSubtab,
    getTerminalConfig,
    buildAgentCommand,
    escAttr,
    _setProjects: (p) => { _projects = p; },
  };
}
