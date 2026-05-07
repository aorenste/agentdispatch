const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./app.js');

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
  });
});

describe('escAttr', () => {
  test('plain text unchanged', () => {
    assert.equal(app.escAttr('hello'), 'hello');
  });

  test('escapes single quotes', () => {
    assert.equal(app.escAttr("it's"), "it\\'s");
  });

  test('escapes backslashes', () => {
    assert.equal(app.escAttr('a\\b'), 'a\\\\b');
  });

  test('escapes both together', () => {
    assert.equal(app.escAttr("a\\'b"), "a\\\\\\'b");
  });

  test('safe for onclick attribute', () => {
    const val = app.escAttr("test'name");
    assert.ok(!val.includes("'") || val.indexOf("'") === val.indexOf("\\'") + 1);
  });
});

describe('getDefaultWsSubtab', () => {
  test('returns first tab when tabs exist', () => {
    assert.equal(app.getDefaultWsSubtab({tabs: [{id: 7}]}), 'tab-7');
  });

  test('returns empty when no tabs', () => {
    assert.equal(app.getDefaultWsSubtab({tabs: []}), '');
  });

  test('returns empty for null ws', () => {
    assert.equal(app.getDefaultWsSubtab(null), '');
  });
});

describe('normalizeWsSubtab', () => {
  test('returns empty for null workspace', () => {
    assert.equal(app.normalizeWsSubtab(null, 'init'), '');
  });

  test('keeps valid tab reference', () => {
    const ws = {tabs: [{id: 5}]};
    assert.equal(app.normalizeWsSubtab(ws, 'tab-5'), 'tab-5');
  });

  test('falls back to default when tab is gone', () => {
    const ws = {tabs: [{id: 3}]};
    assert.equal(app.normalizeWsSubtab(ws, 'tab-99'), 'tab-3');
  });

  test('returns default for unknown subtab value', () => {
    const ws = {tabs: [{id: 1}]};
    assert.equal(app.normalizeWsSubtab(ws, 'garbage'), 'tab-1');
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

  test('starts gray with no output', () => {
    assert.equal(compute('', null, now, false), '');
  });

  test('stays gray with no output even if selected', () => {
    assert.equal(compute('', null, now, true), '');
  });

  test('gray goes busy when output is recent', () => {
    assert.equal(compute('', now - 1000, now, false), 'busy');
  });

  test('gray stays gray if output is already 5s old', () => {
    assert.equal(compute('', now - 5000, now, false), '');
  });

  test('busy stays busy with recent output', () => {
    assert.equal(compute('busy', now - 1000, now, false), 'busy');
  });

  test('busy becomes slowing when output stops', () => {
    assert.equal(compute('busy', now - 6000, now, false), 'slowing');
  });

  test('slowing goes back to busy on new output', () => {
    assert.equal(compute('slowing', now - 1000, now, false), 'busy');
  });

  test('slowing becomes done after 10s', () => {
    assert.equal(compute('slowing', now - 11000, now, false), 'done');
  });

  test('done goes back to busy on new output', () => {
    assert.equal(compute('done', now - 1000, now, false), 'busy');
  });

  test('done stays done when no new output', () => {
    assert.equal(compute('done', now - 20000, now, false), 'done');
  });

  test('selected always returns empty', () => {
    assert.equal(compute('busy', now - 1000, now, true), '');
    assert.equal(compute('done', now - 1000, now, true), '');
  });

  test('building always returns busy', () => {
    assert.equal(compute('', null, now, false, true), 'busy');
  });
});

describe('tickDot', () => {
  const tick = app.tickDot;
  const now = 100000;

  test('notify fires on slowing→done transition', () => {
    const r = tick('slowing', now - 11000, now, false, false, false);
    assert.equal(r.state, 'done');
    assert.equal(r.notify, true);
  });

  test('notify does not fire on done→done', () => {
    const r = tick('done', now - 20000, now, false, false, false);
    assert.equal(r.state, 'done');
    assert.equal(r.notify, false);
  });

  test('clears output when selected', () => {
    const r = tick('busy', now - 1000, now, true, true, false);
    assert.equal(r.outputMs, null);
  });

  test('preserves output when not selected', () => {
    const r = tick('busy', now - 1000, now, false, false, false);
    assert.equal(r.outputMs, now - 1000);
  });

  test('grace period on deselect', () => {
    const r = tick('busy', now - 1000, now, false, true, false);
    assert.ok(r.graceUntil != null);
    assert.ok(r.graceUntil > now);
  });
});

describe('isWsSelected', () => {
  test('true when workspace matches', () => {
    assert.equal(app.isWsSelected(42, 42), true);
  });

  test('false when different workspace', () => {
    assert.equal(app.isWsSelected(42, 99), false);
  });

  test('false when no workspace selected', () => {
    assert.equal(app.isWsSelected(null, 42), false);
  });
});

describe('shouldRecordOutput', () => {
  test('false when selected', () => {
    assert.equal(app.shouldRecordOutput(true, 1000, null), false);
  });

  test('true when not selected', () => {
    assert.equal(app.shouldRecordOutput(false, 1000, null), true);
  });

  test('false during grace period', () => {
    assert.equal(app.shouldRecordOutput(false, 1000, 2000), false);
  });

  test('true after grace period', () => {
    assert.equal(app.shouldRecordOutput(false, 3000, 2000), true);
  });
});

describe('morphdomShouldUpdate', () => {
  const shouldUpdate = app.morphdomShouldUpdate;
  const el = (className) => ({ className, classList: { contains: (c) => className.split(' ').includes(c) } });

  test('returns true for normal elements', () => {
    assert.equal(shouldUpdate(el('ws-popover'), el('ws-popover')), true);
  });

  test('returns false for open popover that would close', () => {
    assert.equal(shouldUpdate(el('ws-popover open'), el('ws-popover')), false);
  });

  test('returns true for open popover staying open', () => {
    assert.equal(shouldUpdate(el('ws-popover open'), el('ws-popover open')), true);
  });
});

describe('adjustDividerAfterRemove', () => {
  const adjust = app.adjustDividerAfterRemove;

  test('returns null when no divider', () => {
    assert.equal(adjust(null, 2, 5), null);
  });

  test('decrements when item removed above divider', () => {
    assert.equal(adjust(3, 1, 4), 2);
  });

  test('no change when item removed below divider', () => {
    assert.equal(adjust(3, 4, 4), 3);
  });

  test('no change when item removed at divider', () => {
    assert.equal(adjust(3, 3, 4), 3);
  });
});
