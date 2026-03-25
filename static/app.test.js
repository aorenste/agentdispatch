const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./app.js');

describe('getProjectAgent', () => {
  test('returns Claude for null project', () => {
    assert.equal(app.getProjectAgent(null), 'Claude');
  });

  test('returns Claude for undefined project', () => {
    assert.equal(app.getProjectAgent(undefined), 'Claude');
  });

  test('returns Claude for project with no agent field', () => {
    assert.equal(app.getProjectAgent({}), 'Claude');
  });

  test('returns valid agent values', () => {
    assert.equal(app.getProjectAgent({agent: 'Claude'}), 'Claude');
    assert.equal(app.getProjectAgent({agent: 'Codex'}), 'Codex');
    assert.equal(app.getProjectAgent({agent: 'None'}), 'None');
  });

  test('returns Claude for unknown agent', () => {
    assert.equal(app.getProjectAgent({agent: 'GPT'}), 'Claude');
    assert.equal(app.getProjectAgent({agent: ''}), 'Claude');
    assert.equal(app.getProjectAgent({agent: 'claude'}), 'Claude'); // case-sensitive
  });
});

describe('getTerminalConfig', () => {
  test('scrollback is large enough for meaningful history', () => {
    assert.ok(app.getTerminalConfig().scrollback >= 10000);
  });

  test('cursor blinks', () => {
    assert.equal(app.getTerminalConfig().cursorBlink, true);
  });

  test('has theme with required colors', () => {
    const theme = app.getTerminalConfig().theme;
    assert.ok(theme);
    assert.ok(theme.background);
    assert.ok(theme.foreground);
    assert.ok(theme.cursor);
  });

  test('returns fresh object each call', () => {
    const a = app.getTerminalConfig();
    const b = app.getTerminalConfig();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });
});

describe('escAttr', () => {
  test('plain text unchanged', () => {
    assert.equal(app.escAttr('hello'), 'hello');
  });

  test('escapes single quotes', () => {
    assert.equal(app.escAttr("test's"), "test\\'s");
  });

  test('escapes backslashes', () => {
    assert.equal(app.escAttr('a\\b'), 'a\\\\b');
  });

  test('escapes both together', () => {
    assert.equal(app.escAttr("it\\'s"), "it\\\\\\'s");
  });

  test('safe for onclick attribute', () => {
    const name = "my'project";
    const attr = `onclick="fn('${app.escAttr(name)}')"`;
    // Should produce valid HTML attribute with escaped JS string
    assert.ok(!attr.includes("my'project"));
    assert.ok(attr.includes("my\\'project"));
  });
});

describe('buildAgentCommand', () => {
  test('claude base command', () => {
    assert.equal(app.buildAgentCommand('Claude', {}), 'claude');
  });

  test('codex base command', () => {
    assert.equal(app.buildAgentCommand('Codex', {}), 'codex');
  });

  test('claude with internet flag', () => {
    assert.equal(
      app.buildAgentCommand('Claude', {claude_internet: true}),
      'claude --dangerously-enable-internet-mode'
    );
  });

  test('codex with internet flag', () => {
    assert.equal(
      app.buildAgentCommand('Codex', {claude_internet: true}),
      'codex --dangerously-enable-internet-mode'
    );
  });

  test('claude with skip permissions', () => {
    assert.equal(
      app.buildAgentCommand('Claude', {claude_skip_permissions: true}),
      'claude --dangerously-skip-permissions'
    );
  });

  test('codex does NOT get skip permissions', () => {
    assert.equal(
      app.buildAgentCommand('Codex', {claude_skip_permissions: true}),
      'codex'
    );
  });

  test('claude with both flags', () => {
    assert.equal(
      app.buildAgentCommand('Claude', {claude_internet: true, claude_skip_permissions: true}),
      'claude --dangerously-enable-internet-mode --dangerously-skip-permissions'
    );
  });

  test('with conda env', () => {
    assert.equal(
      app.buildAgentCommand('Claude', {conda_env: 'py310'}),
      'conda activate py310 && claude'
    );
  });

  test('conda env with flags', () => {
    assert.equal(
      app.buildAgentCommand('Claude', {conda_env: 'py310', claude_internet: true}),
      'conda activate py310 && claude --dangerously-enable-internet-mode'
    );
  });

  test('null proj uses defaults', () => {
    assert.equal(app.buildAgentCommand('Claude', null), 'claude');
  });

  test('empty conda_env is not prepended', () => {
    assert.equal(app.buildAgentCommand('Claude', {conda_env: ''}), 'claude');
  });
});

describe('getDefaultWsSubtab', () => {
  beforeEach(() => {
    app._setProjects([]);
  });

  test('returns agent when project agent is Claude', () => {
    app._setProjects([{name: 'p', agent: 'Claude'}]);
    assert.equal(app.getDefaultWsSubtab({project: 'p', tabs: []}), 'agent');
  });

  test('returns agent when project agent is Codex', () => {
    app._setProjects([{name: 'p', agent: 'Codex'}]);
    assert.equal(app.getDefaultWsSubtab({project: 'p', tabs: []}), 'agent');
  });

  test('returns first tab when agent is None', () => {
    app._setProjects([{name: 'p', agent: 'None'}]);
    assert.equal(app.getDefaultWsSubtab({project: 'p', tabs: [{id: 7}]}), 'tab-7');
  });

  test('returns empty when agent is None and no tabs', () => {
    app._setProjects([{name: 'p', agent: 'None'}]);
    assert.equal(app.getDefaultWsSubtab({project: 'p', tabs: []}), '');
  });

  test('returns agent when project not found (defaults to Claude)', () => {
    app._setProjects([]);
    assert.equal(app.getDefaultWsSubtab({project: 'missing', tabs: []}), 'agent');
  });

  test('returns agent for null ws', () => {
    assert.equal(app.getDefaultWsSubtab(null), 'agent');
  });
});

describe('normalizeWsSubtab', () => {
  beforeEach(() => {
    app._setProjects([{name: 'p', agent: 'Claude'}]);
  });

  test('returns empty for null workspace', () => {
    assert.equal(app.normalizeWsSubtab(null, 'agent'), '');
  });

  test('normalizes legacy "claude" to "agent"', () => {
    const ws = {project: 'p', tabs: []};
    assert.equal(app.normalizeWsSubtab(ws, 'claude'), 'agent');
  });

  test('keeps valid tab reference', () => {
    const ws = {project: 'p', tabs: [{id: 5}]};
    assert.equal(app.normalizeWsSubtab(ws, 'tab-5'), 'tab-5');
  });

  test('falls back to default when tab is gone', () => {
    const ws = {project: 'p', tabs: [{id: 3}]};
    assert.equal(app.normalizeWsSubtab(ws, 'tab-99'), 'agent');
  });

  test('returns default for unknown subtab value', () => {
    const ws = {project: 'p', tabs: []};
    assert.equal(app.normalizeWsSubtab(ws, 'garbage'), 'agent');
  });

  test('agent subtab uses getDefaultWsSubtab', () => {
    app._setProjects([{name: 'p', agent: 'None'}]);
    const ws = {project: 'p', tabs: [{id: 1}]};
    // agent is None, so default is first tab
    assert.equal(app.normalizeWsSubtab(ws, 'agent'), 'tab-1');
  });
});
