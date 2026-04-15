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

  test('history subtab valid when agent enabled', () => {
    app._setProjects([{name: 'p', agent: 'Claude'}]);
    const ws = {project: 'p', tabs: []};
    assert.equal(app.normalizeWsSubtab(ws, 'history'), 'history');
  });

  test('history subtab falls back when agent is None', () => {
    app._setProjects([{name: 'p', agent: 'None'}]);
    const ws = {project: 'p', tabs: [{id: 1}]};
    assert.equal(app.normalizeWsSubtab(ws, 'history'), 'tab-1');
  });
});

describe('containsEraseDisplay', () => {
  test('detects \\e[2J', () => {
    assert.equal(app.containsEraseDisplay(new Uint8Array([0x1b, 0x5b, 0x32, 0x4a])), true);
  });

  test('detects \\e[2J in middle of data', () => {
    assert.equal(app.containsEraseDisplay(new Uint8Array([0x41, 0x1b, 0x5b, 0x32, 0x4a, 0x42])), true);
  });

  test('returns false for empty data', () => {
    assert.equal(app.containsEraseDisplay(new Uint8Array([])), false);
  });

  test('returns false for too-short data', () => {
    assert.equal(app.containsEraseDisplay(new Uint8Array([0x1b, 0x5b, 0x32])), false);
  });

  test('returns false for \\e[3J', () => {
    assert.equal(app.containsEraseDisplay(new Uint8Array([0x1b, 0x5b, 0x33, 0x4a])), false);
  });

  test('returns false for plain text', () => {
    assert.equal(app.containsEraseDisplay(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])), false);
  });
});

describe('computeDotState', () => {
  const compute = app.computeDotState;
  const now = 100000;

  // Initial state: gray
  test('starts gray with no output', () => {
    assert.equal(compute('', null, now, false), '');
  });

  test('stays gray with no output even if selected', () => {
    assert.equal(compute('', null, now, true), '');
  });

  // Gray → busy on text output
  test('gray goes busy when output is recent', () => {
    assert.equal(compute('', now - 1000, now, false), 'busy');
  });

  test('gray goes busy when output just happened', () => {
    assert.equal(compute('', now, now, false), 'busy');
  });

  // Gray does NOT go busy if output is already old (e.g. initial load with stale data)
  test('gray stays gray if output is already 5s old', () => {
    assert.equal(compute('', now - 5000, now, false), '');
  });

  test('gray stays gray if output is already 10s old', () => {
    assert.equal(compute('', now - 10000, now, false), '');
  });

  // Busy stays busy while output is recent
  test('busy stays busy with recent output', () => {
    assert.equal(compute('busy', now - 2000, now, false), 'busy');
  });

  test('busy stays busy at 4999ms', () => {
    assert.equal(compute('busy', now - 4999, now, false), 'busy');
  });

  // Busy → slowing at 5s
  test('busy goes slowing at 5s idle', () => {
    assert.equal(compute('busy', now - 5000, now, false), 'slowing');
  });

  test('busy goes slowing at 7s idle', () => {
    assert.equal(compute('busy', now - 7000, now, false), 'slowing');
  });

  // Busy → slowing, not directly to done
  test('busy does NOT skip to done at 10s', () => {
    assert.equal(compute('busy', now - 10000, now, false), 'slowing');
  });

  // Slowing → busy on new output
  test('slowing goes back to busy on new output', () => {
    assert.equal(compute('slowing', now - 1000, now, false), 'busy');
  });

  // Slowing stays slowing between 5-10s
  test('slowing stays slowing at 7s', () => {
    assert.equal(compute('slowing', now - 7000, now, false), 'slowing');
  });

  // Slowing → done at 10s (not selected)
  test('slowing goes done at 10s when not selected', () => {
    assert.equal(compute('slowing', now - 10000, now, false), 'done');
  });

  test('slowing goes done at 15s when not selected', () => {
    assert.equal(compute('slowing', now - 15000, now, false), 'done');
  });

  // Selected (viewing agent pane) → always gray, regardless of state
  test('selected: gray stays gray with recent output', () => {
    assert.equal(compute('', now - 1000, now, true), '');
  });

  test('selected: busy goes gray', () => {
    assert.equal(compute('busy', now - 2000, now, true), '');
  });

  test('selected: slowing goes gray', () => {
    assert.equal(compute('slowing', now - 7000, now, true), '');
  });

  test('selected: slowing goes gray even at 10s', () => {
    assert.equal(compute('slowing', now - 10000, now, true), '');
  });

  // Done is sticky — stays done regardless of time
  test('done stays done with old output', () => {
    assert.equal(compute('done', now - 30000, now, false), 'done');
  });

  test('done stays done with no output', () => {
    assert.equal(compute('done', null, now, false), 'done');
  });

  // Done → busy on new output
  test('done goes busy on new output', () => {
    assert.equal(compute('done', now - 1000, now, false), 'busy');
  });

  // Done → gray when user clicks (selected)
  test('done goes gray when selected', () => {
    assert.equal(compute('done', now - 30000, now, true), '');
  });

  // Done → gray when selected even with no output
  test('done goes gray when selected with no output', () => {
    assert.equal(compute('done', null, now, true), '');
  });
});

describe('tickDot', () => {
  const tick = app.tickDot;
  const now = 100000;

  // Basic: not selected, no output → gray, no output change
  test('gray with no output stays gray', () => {
    const r = tick('', null, now, false);
    assert.equal(r.state, '');
    assert.equal(r.outputMs, null);
  });

  // Not selected, recent output → busy, output preserved
  test('gray with recent output goes busy', () => {
    const r = tick('', now - 1000, now, false);
    assert.equal(r.state, 'busy');
    assert.equal(r.outputMs, now - 1000);
  });

  // Selected → gray, output CLEARED (user saw it)
  // tickDot(prev, lastOutputMs, now, isSelected, wasSelected)
  // 5th param tracks previous tick's selected state

  test('selected clears output and stays gray', () => {
    const r = tick('', now - 500, now, true, true);
    assert.equal(r.state, '');
    assert.equal(r.outputMs, null);
  });

  test('selected clears output from busy state', () => {
    const r = tick('busy', now - 500, now, true, false);
    assert.equal(r.state, '');
    assert.equal(r.outputMs, null);
  });

  test('selected clears output from done state', () => {
    const r = tick('done', now - 30000, now, true, false);
    assert.equal(r.state, '');
    assert.equal(r.outputMs, null);
  });

  // Just deselected → sets grace period to suppress residual output
  test('just deselected returns graceUntil', () => {
    const r = tick('', null, now, false, true);
    assert.equal(r.state, '');
    assert.ok(r.graceUntil > now);
  });

  test('not just deselected returns no graceUntil', () => {
    const r = tick('', null, now, false, false);
    assert.equal(r.graceUntil, null);
  });

  test('staying selected returns no graceUntil', () => {
    const r = tick('', null, now, true, true);
    assert.equal(r.graceUntil, null);
  });

  // THE KEY BUG SCENARIO:
  // User watches agent pane, output happening. Leaves. Residual WebSocket
  // data arrives. Should NOT trigger busy because of grace period.
  test('full scenario: watch, leave, residual output stays gray', () => {
    // Tick 1: watching, output happening
    const t1 = tick('', now - 500, now, true, true);
    assert.equal(t1.state, '');
    assert.equal(t1.outputMs, null);

    // Tick 2: user just left (wasSelected=true, isSelected=false)
    const t2 = tick(t1.state, t1.outputMs, now + 1000, false, true);
    assert.equal(t2.state, '');
    assert.ok(t2.graceUntil > now + 1000); // grace period set

    // Between ticks, WS data arrives — but shouldRecordOutput blocks it
    // (tested separately below)

    // Tick 3: still away, no output recorded (grace blocked it)
    const t3 = tick(t2.state, null, now + 2000, false, false);
    assert.equal(t3.state, '');
  });

  // New output well after grace period DOES trigger busy
  test('output after grace period triggers busy', () => {
    const t1 = tick('', null, now, false, true); // just deselected
    // Grace expires after ~2s. New output at now+5000:
    const t2 = tick(t1.state, now + 5000, now + 5500, false, false);
    assert.equal(t2.state, 'busy');
  });

  // Notification flag
  test('notify on slowing → done transition', () => {
    const r = tick('slowing', now - 10000, now, false, false);
    assert.equal(r.state, 'done');
    assert.equal(r.notify, true);
  });

  test('no notify on other transitions', () => {
    assert.equal(tick('', now - 1000, now, false, false).notify, false);
    assert.equal(tick('busy', now - 5000, now, false, false).notify, false);
    assert.equal(tick('busy', now - 1000, now, false, false).notify, false);
  });
});

describe('shouldRecordOutput', () => {
  const should = app.shouldRecordOutput;
  const now = 100000;

  test('no when selected', () => {
    assert.equal(should(true, now, null), false);
  });

  test('yes when not selected and no grace', () => {
    assert.equal(should(false, now, null), true);
  });

  test('yes when not selected and grace is null', () => {
    assert.equal(should(false, now, undefined), true);
  });

  test('no when within grace period', () => {
    assert.equal(should(false, now, now + 1000), false);
  });

  test('yes when grace expired', () => {
    assert.equal(should(false, now, now - 1), true);
  });

  test('yes when grace is exactly now', () => {
    assert.equal(should(false, now, now), true);
  });
});

describe('isAgentPaneSelected', () => {
  const isSel = app.isAgentPaneSelected;

  test('true when workspace matches and subtab is agent', () => {
    assert.equal(isSel(42, 'agent', 42), true);
  });

  test('false when different workspace', () => {
    assert.equal(isSel(42, 'agent', 99), false);
  });

  test('false when subtab is not agent', () => {
    assert.equal(isSel(42, 'tab-1', 42), false);
    assert.equal(isSel(42, 'history', 42), false);
  });

  test('false when no workspace selected', () => {
    assert.equal(isSel(null, 'agent', 42), false);
  });

  // Output should NOT be recorded while viewing the agent pane
  // This is the guard the WebSocket handler must use
  test('used to gate output recording', () => {
    // Simulating: ws handler receives output for workspace 42
    // User is viewing workspace 42 agent pane → don't record
    assert.equal(isSel(42, 'agent', 42), true); // selected → skip recording

    // User switches to shell tab → record
    assert.equal(isSel(42, 'tab-1', 42), false); // not selected → record

    // User switches to different workspace → record
    assert.equal(isSel(99, 'agent', 42), false); // not selected → record
  });
});

describe('morphdomShouldUpdate', () => {
  const shouldUpdate = app.morphdomShouldUpdate;

  // Simulate DOM elements as plain objects with className
  const el = (className) => ({ className, classList: { contains: (c) => className.split(' ').includes(c) } });

  test('returns true for normal elements', () => {
    assert.equal(shouldUpdate(el('ws-popover'), el('ws-popover')), true);
  });

  test('returns false when existing popover has open class', () => {
    assert.equal(shouldUpdate(el('ws-popover open'), el('ws-popover')), false);
  });

  test('returns true when popover is not open', () => {
    assert.equal(shouldUpdate(el('ws-popover'), el('ws-popover')), true);
  });

  test('returns true for non-popover elements even with open class', () => {
    assert.equal(shouldUpdate(el('something open'), el('something')), true);
  });

  test('returns true when both have open', () => {
    assert.equal(shouldUpdate(el('ws-popover open'), el('ws-popover open')), true);
  });
});

describe('adjustDividerAfterRemove', () => {
  const adjust = app.adjustDividerAfterRemove;

  // Workspaces: [A, B, --- divider at 2 ---, C, D]
  // Removing A (idx 0, above divider) should shift divider from 2 to 1
  test('removing workspace above divider shifts divider down', () => {
    assert.equal(adjust(2, 0, 3), 1);
  });

  // Removing C (idx 2, below divider at 2) should not change divider
  test('removing workspace below divider keeps divider', () => {
    assert.equal(adjust(2, 2, 3), 2);
  });

  test('removing workspace at end keeps divider', () => {
    assert.equal(adjust(2, 3, 3), 2);
  });

  // Removing B (idx 1, above divider at 2) should shift divider from 2 to 1
  test('removing second workspace above divider shifts divider', () => {
    assert.equal(adjust(2, 1, 3), 1);
  });

  // Divider at 0 (top), removing workspace below
  test('divider at top, removing below keeps divider at 0', () => {
    assert.equal(adjust(0, 1, 2), 0);
  });

  // Divider at end (all workspaces above)
  test('divider at end, removing workspace above shifts divider', () => {
    assert.equal(adjust(3, 1, 2), 2);
  });

  // Null divider
  test('null divider stays null', () => {
    assert.equal(adjust(null, 0, 2), null);
  });
});
