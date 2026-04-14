/* AgentDispatch UI */

let evtSource = null;
let buildHash = null;
let _projects = [];
let _workspaces = [];
let _selectedWsId = null;
let _selectedWsSubtab = 'agent';
let _wsSubtabs = {}; // workspace id -> last selected subtab
let _tabTerminals = {}; // keyed by tab id -> {term, ws, fitAddon, container}
let _historyTerminals = {}; // keyed by workspace id -> {term, fitAddon, container}
const _wsLastOutput = {}; // workspace id -> last output timestamp (ms)
const _wsDotState = {}; // workspace id -> last dot class ('', 'recent', 'idle')
const _wsWasSelected = {}; // workspace id -> was agent pane selected last tick
const _wsOutputGrace = {}; // workspace id -> suppress output recording until this timestamp
let _wsDividerPos = null; // index where divider appears in workspace list (null = end)
const _wsTitles = {}; // workspace id -> pane title string
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
  if (subtab === 'history') {
    const proj = ws ? _projects.find(p => p.name === ws.project) : null;
    return getProjectAgent(proj) !== 'None' ? 'history' : getDefaultWsSubtab(ws);
  }
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
    const projectBody = {
      name, root_dir: dir,
      git: values['proj-git'],
      agent: values['proj-agent'],
      conda_env: conda,
      claude_internet: values['proj-claude-internet'],
      claude_skip_permissions: values['proj-claude-skip-perms'],
    };
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(projectBody),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.dir_not_found) {
          closeDialog();
          openDialog(`Directory "${dir}" does not exist. Create it?`, [], async () => {
            const res2 = await fetch('/api/projects', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({...projectBody, create_dir: true, git: true}),
            });
            if (!res2.ok) {
              const err = await readApiError(res2, 'Failed to create project.');
              setDialogError(err);
              return false;
            }
            fetchProjects();
          }, {okText: 'Create'});
          return false;
        }
        return (data && data.error) || `Failed to add project. "${dir}" must be an existing directory.`;
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
      // Only auto-check when transitioning from disabled to enabled
      // (first detection). Don't override if the user already unchecked it.
      if (isGit && gitCb.disabled) {
        gitCb.checked = true;
      } else if (!isGit) {
        gitCb.checked = false;
      }
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
    const data = await res.json();
    const workspaces = data.workspaces || data; // handle wrapped or raw format
    _workspaces = workspaces;
    if (data.divider_pos != null) {
      _wsDividerPos = data.divider_pos;
    }
    // Initialize activity timestamps and titles from server-reported tmux data
    for (const ws of workspaces) {
      if (ws.agent_title && !_wsTitles[ws.id]) {
        _wsTitles[ws.id] = ws.agent_title;
      }
    }
    renderWorkspaces();
  } catch {}
}


// Pure state machine for activity dots.
function isAgentPaneSelected(selectedWsId, selectedSubtab, wsId) {
  return selectedWsId === wsId && selectedSubtab === 'agent';
}

function shouldRecordOutput(isSelected, now, graceUntil) {
  if (isSelected) return false;
  if (graceUntil != null && now < graceUntil) return false;
  return true;
}

// prev: current state ('' | 'busy' | 'slowing' | 'done')
// lastOutputMs: timestamp of last text output (ms), or null/undefined
// now: current time (ms)
// isSelected: whether this workspace is currently selected by the user
function computeDotState(prev, lastOutputMs, now, isSelected) {
  if (isSelected) return '';
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
  // prev === '' (gray)
  if (recentOutput) return 'busy';
  return '';
}

// Full tick: compute new state and clear output if user is watching.
// Returns { state, outputMs, notify, graceUntil }.
function tickDot(prev, lastOutputMs, now, isSelected, wasSelected) {
  const state = computeDotState(prev, lastOutputMs, now, isSelected);
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
    const isSelected = isAgentPaneSelected(_selectedWsId, _selectedWsSubtab, ws.id);
    const wasSelected = _wsWasSelected[ws.id] || false;
    const r = tickDot(prev, _wsLastOutput[ws.id], now, isSelected, wasSelected);
    _wsDotState[ws.id] = r.state;
    _wsLastOutput[ws.id] = r.outputMs;
    _wsWasSelected[ws.id] = isSelected;
    if (r.graceUntil) _wsOutputGrace[ws.id] = r.graceUntil;
    const sidebar = document.getElementById('activity-ws-' + ws.id);
    if (sidebar) sidebar.className = 'activity-dot' + (r.state ? ' ' + r.state : '');
    const tab = document.getElementById('activity-tab-' + ws.id);
    if (tab) tab.className = 'activity-dot' + (r.state ? ' ' + r.state : '');
    if (r.notify) notifyIdle(ws.name);
  }
}

function notifyIdle(name) {
  // In-page toast
  const toast = document.createElement('div');
  toast.className = 'idle-toast';
  toast.textContent = `${name} is idle`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 5000);

  // Browser notification (best-effort)
  if (Notification.permission === 'granted') {
    new Notification('AgentDispatch', { body: `${name} is idle`, tag: 'idle-' + name });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission();
  }
}

function saveWorkspaceOrder() {
  fetch('/api/workspaces/reorder', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      ids: _workspaces.map(w => w.id),
      divider_pos: _wsDividerPos,
    }),
  });
}

function renderWorkspaces() {
  const sidebar = document.getElementById('ws-sidebar');
  if (_workspaces.length === 0) {
    sidebar.innerHTML = '<div class="ws-empty">No workspaces</div>';
    renderSelectedWorkspace();
    return;
  }
  const dividerPos = _wsDividerPos != null ? _wsDividerPos : _workspaces.length;
  const wsHtml = _workspaces.map((ws, i) => {
    let html = '';
    if (i === dividerPos) {
      html += '<div class="ws-divider" draggable="true" data-divider="true"><span>\u2015\u2015\u2015</span></div>';
    }
    html += `<div class="ws-sidebar-item ${ws.id === _selectedWsId ? 'active' : ''}"
         draggable="true" data-ws-id="${ws.id}"
         onclick="selectWorkspace(${ws.id})">
      <span id="activity-ws-${ws.id}" class="activity-dot"></span>
      <div class="ws-sidebar-info">
        <div class="ws-name" ondblclick="event.stopPropagation(); renameWorkspace(${ws.id})">${esc(ws.name)}</div>
        <div class="ws-project">${esc(ws.project)}</div>
        <div id="title-ws-${ws.id}" class="ws-title">${esc(_wsTitles[ws.id] || '')}</div>
      </div>
      <button class="ws-menu-btn" onclick="event.stopPropagation(); toggleWsMenu(${ws.id})">\u2026</button>
      <div class="ws-popover" id="ws-menu-${ws.id}">
        <div class="ws-popover-item" onclick="event.stopPropagation(); renameWorkspace(${ws.id})">Rename</div>
        <div class="ws-popover-item" onclick="event.stopPropagation(); showWsInfo(${ws.id})">Info</div>
        <div class="ws-popover-item danger" onclick="event.stopPropagation(); destroyWorkspace(${ws.id})">Destroy</div>
      </div>
    </div>`;
    return html;
  }).join('');
  // Divider at the end if position is past all workspaces
  sidebar.innerHTML = wsHtml + (dividerPos >= _workspaces.length
    ? '<div class="ws-divider" draggable="true" data-divider="true"><span>\u2015\u2015\u2015</span></div>'
    : '');

  // Drag-and-drop reordering (workspaces + divider)
  let dragType = null; // 'ws' or 'divider'
  let dragWsId = null;
  const clearDragOver = () => sidebar.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));

  sidebar.querySelectorAll('.ws-sidebar-item, .ws-divider').forEach(el => {
    const isDivider = el.dataset.divider === 'true';

    el.addEventListener('dragstart', (e) => {
      if (isDivider) {
        dragType = 'divider';
        dragWsId = null;
      } else {
        dragType = 'ws';
        dragWsId = parseInt(el.dataset.wsId);
      }
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearDragOver();
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDragOver();
      el.classList.add('drag-over');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      clearDragOver();

      if (dragType === 'divider' && !isDivider) {
        // Divider dropped on a workspace — move divider to that position
        const targetIdx = _workspaces.findIndex(w => w.id === parseInt(el.dataset.wsId));
        if (targetIdx >= 0) {
          _wsDividerPos = targetIdx;
          saveWorkspaceOrder();
          renderWorkspaces();
        }
      } else if (dragType === 'ws') {
        if (isDivider) {
          // Workspace dropped on divider — move it to the divider position
          const fromIdx = _workspaces.findIndex(w => w.id === dragWsId);
          if (fromIdx >= 0) {
            let dp = _wsDividerPos != null ? _wsDividerPos : _workspaces.length;
            const [moved] = _workspaces.splice(fromIdx, 1);
            if (fromIdx < dp) dp--;
            _workspaces.splice(dp, 0, moved);
            _wsDividerPos = dp;
            saveWorkspaceOrder();
            renderWorkspaces();
          }
        } else {
          // Workspace dropped on workspace — reorder
          const targetId = parseInt(el.dataset.wsId);
          if (dragWsId == null || dragWsId === targetId) return;
          const fromIdx = _workspaces.findIndex(w => w.id === dragWsId);
          const toIdx = _workspaces.findIndex(w => w.id === targetId);
          if (fromIdx < 0 || toIdx < 0) return;
          let dp = _wsDividerPos != null ? _wsDividerPos : _workspaces.length;
          if (fromIdx < dp && toIdx >= dp) dp--;
          else if (fromIdx >= dp && toIdx < dp) dp++;
          _wsDividerPos = dp;
          const [moved] = _workspaces.splice(fromIdx, 1);
          const insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
          _workspaces.splice(insertIdx, 0, moved);
          saveWorkspaceOrder();
          renderWorkspaces();
        }
      }
    });
  });

  renderSelectedWorkspace();
  updateActivityDots();
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
      entry.skipNextFit = true;
      stash.appendChild(entry.container);
    }
  }
  for (const [, entry] of Object.entries(_historyTerminals)) {
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
      ${agentEnabled ? `<button class="ws-subtab ${_selectedWsSubtab === 'agent' || _selectedWsSubtab === 'history' ? 'active' : ''}" onclick="switchWsSubtab(_selectedWsSubtab === 'history' ? 'agent' : 'agent')"><span class="ws-subtab-inner"><span id="activity-tab-${ws.id}" class="activity-dot"></span><span class="ws-subtab-label">${esc(agent)}</span><span id="altscreen-agent-${ws.id}" class="altscreen-badge" style="display:none">FS</span><select class="agent-view-select" onchange="switchWsSubtab(this.value); event.stopPropagation();" onclick="event.stopPropagation()"><option value="agent"${_selectedWsSubtab === 'agent' ? ' selected' : ''}>Live</option><option value="history"${_selectedWsSubtab === 'history' ? ' selected' : ''}>History</option></select></span></button>` : ''}
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
  } else if (_selectedWsSubtab === 'history') {
    const histEntry = getOrCreateHistoryTerminal(ws.id);
    paneEl.appendChild(histEntry.container);
    requestAnimationFrame(() => { histEntry.fitAddon.fit(); });
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

  // Restore altscreen badge and scrollbar state for all tabs
  for (const [key, entry] of Object.entries(_tabTerminals)) {
    const badge = document.getElementById('altscreen-' + key);
    if (badge) badge.style.display = entry.altScreen ? 'inline' : 'none';
    entry.container.classList.toggle('xterm-altscreen', entry.altScreen);
  }
  updateActivityDots();
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

function getOrCreateHistoryTerminal(wsId) {
  if (_historyTerminals[wsId]) return _historyTerminals[wsId];

  const container = document.createElement('div');
  container.style.flex = '1';
  container.style.minHeight = '0';

  const term = new Terminal({
    ...getTerminalConfig(),
    disableStdin: true,
    scrollback: 20000,
    cursorBlink: false,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  const resizeObserver = new ResizeObserver(() => { fitAddon.fit(); });
  resizeObserver.observe(container);

  const entry = { term, fitAddon, container, resizeObserver };
  _historyTerminals[wsId] = entry;
  return entry;
}

function captureAndAppendSnapshot(wsId, agentTerm) {
  if (typeof SerializeAddon === 'undefined') return;
  const histEntry = getOrCreateHistoryTerminal(wsId);
  const addon = new SerializeAddon.SerializeAddon();
  agentTerm.loadAddon(addon);
  const serialized = addon.serialize({ scrollback: 0 });
  addon.dispose();

  if (!serialized || serialized.trim() === '') return;

  const sep = '\r\n\x1b[38;5;240m' + '\u2500'.repeat(60) + '\x1b[0m\r\n';
  histEntry.term.write(sep);
  histEntry.term.write(serialized);
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

  const term = new Terminal(getTerminalConfig());

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  if (typeof WebLinksAddon !== 'undefined') {
    term.loadAddon(new WebLinksAddon.WebLinksAddon((e, url) => {
      if (e.ctrlKey || e.metaKey) window.open(url, '_blank');
    }));
  }
  term.open(container);
  fitAddon.fit();

  const entry = { term, ws: null, fitAddon, container, resizeObserver: null, opts, disposed: false, connected: false, connectWs: null, altScreen: false, _autoScroll: true };
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
      // Only focus if this terminal is in the active pane (not stashed)
      if (entry.container.closest('#ws-active-pane')) term.focus();
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && e.data.startsWith('{"type":"pane_exit"')) {
        // Auto-close shell tabs when their pane exits
        console.log('[pane_exit] received for key=' + key + ' (type=' + typeof key + ')');
        if (typeof key === 'number') {
          console.log('[pane_exit] auto-closing tab ' + key);
          closeTab(key);
        }
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
      // Track agent output for activity dot.
      // Skip the first 2s after connection — that's capture-pane replay, not live output.
      // Don't record while user is watching or during the grace period after leaving.
      if (typeof key === 'string' && key.startsWith('agent-') && opts.workspaceId != null
          && entry.connectedAt && Date.now() - entry.connectedAt > 2000
          && shouldRecordOutput(
              isAgentPaneSelected(_selectedWsId, _selectedWsSubtab, opts.workspaceId),
              Date.now(), _wsOutputGrace[opts.workspaceId])) {
        _wsLastOutput[opts.workspaceId] = Date.now();
      }
      // Capture agent terminal screen before erase-display clears it
      if (typeof key === 'string' && key.startsWith('agent-') && data instanceof Uint8Array && containsEraseDisplay(data)) {
        captureAndAppendSnapshot(opts.workspaceId, term);
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

  // Track pane title changes (OSC 0/2)
  if (opts.workspaceId != null) {
    term.onTitleChange((title) => {
      _wsTitles[opts.workspaceId] = title;
      const sideEl = document.getElementById('title-ws-' + opts.workspaceId);
      if (sideEl) sideEl.textContent = title;
    });
  }

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

function showWsInfo(id) {
  closeAllWsMenus();
  const ws = _workspaces.find(w => w.id === id);
  if (!ws) return;
  const proj = _projects.find(p => p.name === ws.project);
  const copyBtn = (path) => `<button class="copy-btn" onclick="copyText('${esc(path)}', this)">Copy</button>`;
  let html = `<div class="ws-info">`;
  html += `<div>Name: ${esc(ws.name)}</div>`;
  html += `<div>Project: ${esc(ws.project)}</div>`;
  html += `<div>Created: ${esc(ws.created_at)}</div>`;
  if (ws.worktree_dir) {
    html += `<div>Worktree: <code>${esc(ws.worktree_dir)}</code> ${copyBtn(ws.worktree_dir)}</div>`;
  }
  if (proj) {
    html += `<div>Root: <code>${esc(proj.root_dir)}</code> ${copyBtn(proj.root_dir)}</div>`;
  }
  html += `</div>`;
  showDialog(html, true);
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
  disposeTerminal('agent-' + id);
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
  disposeTerminal('agent-' + id);
  if (_historyTerminals[id]) {
    _historyTerminals[id].resizeObserver.disconnect();
    _historyTerminals[id].term.dispose();
    delete _historyTerminals[id];
  }
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
  fetchProjects();

  // Activity dot updater
  setInterval(updateActivityDots, 1000);
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
    containsEraseDisplay,
    computeDotState,
    tickDot,
    isAgentPaneSelected,
    shouldRecordOutput,
    _setProjects: (p) => { _projects = p; },
  };
}
