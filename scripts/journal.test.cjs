const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { render, today } = require('./journal.cjs');

test('nested tasks and Markdown checkboxes retain their outline and text', () => {
  assert.equal(render('- TODO 작업\n\t- DONE 완료\n- [ ] 대기\n- [X] 완료\n- TODOish\n- 설명 TODO\n'),
    '- ☐ TODO 작업\n\t- ☑ DONE 완료\n- ☐ TODO 대기\n- ☑ DONE 완료\n- TODOish\n- 설명 TODO\n');
});
test('fenced code is preserved, including nested shorter fences', () => {
  const code = '- ````md\n  - TODO example\n  ```\n  - DONE example\n  ````\n';
  assert.equal(render(code + '- TODO 실제'), code + '- ☐ TODO 실제');
});
test('color is opt-in to the renderer; local dates have padded components', () => {
  assert.equal(render('- DONE 완료', true), '- \x1b[32m☑ DONE\x1b[0m 완료');
  assert.equal(today(new Date(2026, 0, 2)), '2026-01-02');
});
test('invalid dates and missing files return actionable errors without stdout', () => {
  for (const args of [['--date', '2026-02-30'], ['--graph', '/nonexistent-journal-test']]) {
    const result = spawnSync(process.execPath, [require.resolve('./journal.cjs'), '--print', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /journal:/);
  }
});

const { Model, parse, wrap, keyAction, safe } = require('./journal-tui.cjs');
test('folding hides descendants, retains sibling blocks, and ignores fenced list examples', () => {
  const m = new Model();
  m.update('- parent\n  - child\n    - grandchild\n- sibling\n  ```md\n  - example\n  ```', 60);
  assert.equal(m.nodes.length, 4);
  m.fold('collapse');
  assert.deepEqual(m.visible().map(n => n.lines[0]), ['- parent', '- sibling']);
  m.fold('expand'); assert.equal(m.visible().length, 4);
});
test('external insertion and task changes preserve selection, folds, and viewport anchor', () => {
  const m = new Model();
  m.update('- TODO parent\n  - child\n- other', 60);
  m.fold('collapse'); m.move(1, 60, 1);
  const selected = m.selected;
  m.update('- inserted\n- DONE parent\n  - child\n- other', 60);
  assert.equal(m.selected, selected);
  assert.equal(m.rows(60)[m.offset].id, selected);
  assert.equal(m.visible().length, 3);
  m.update('- inserted', 60);
  assert.equal(m.visible().length, 1); assert.equal(m.closed.size, 0);
});
test('Korean and emoji wrap by terminal cells, control sequences are stripped', () => {
  assert.deepEqual(wrap('가나다abc', 4), ['가나', '다ab', 'c']);
  assert.deepEqual(wrap('👩‍💻ab', 3), ['👩‍💻a', 'b']);
  assert.equal(safe('\x1b[2Jhello\x07'), 'hello');
});
test('TUI bindings work without modifiers and former Logseq bindings are ignored', () => {
  for (const [key, action] of Object.entries({j: 'down', k: 'up', ' ': 'toggle',
    '\x1b[D': 'collapse', '\x1b[C': 'expand', '\x1b[A': 'up', '\x1b[B': 'down',
    '\x1b[57350u': 'collapse', '\x1b[32u': 'toggle'})) assert.equal(keyAction(key), action);
  for (const key of ['\x1b[1;9A', '\x1b[1;9B', '\x1b[59;9u', '\x1b[1;3A',
    '\x10', '\x0e', '\x1b[1;5A', '\x1b[13;9u']) assert.equal(keyAction(key), null);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toggleTask, saveTask } = require('./journal-tui.cjs');
test('task toggle changes only first line and retains tabs, CRLF, properties and children', () => {
  const source = '- parent\r\n\t- TODO 작업\r\n\t  id:: abc\r\n\t  - child\r\n- sibling';
  const id = parse(source)[1].id;
  const next = toggleTask(source, id);
  assert.equal(next, source.replace('TODO 작업', 'DONE 작업'));
  assert.equal(toggleTask(next, id), source);
  for (const [from, to] of [['- task', '- TODO task'], ['- [ ] task', '- [x] task'], ['- [X] task', '- [ ] task']]) {
    assert.equal(toggleTask(from, parse(from)[0].id), to);
  }
  assert.throws(() => toggleTask('- ```\n- TODO example\n```', parse('- ```\n- TODO example\n```')[0].id));
  assert.throws(() => toggleTask('- DOING task', parse('- DOING task')[0].id));
});
test('focus shows one subtree, restores selection, survives task changes, and exits when removed', () => {
  const m = new Model();
  m.update('- first\n- TODO parent\n  - child\n    - nested\n- last', 60);
  m.move(1, 60, 1); const selected = m.selected;
  m.fold('collapse'); m.focus();
  assert.equal(m.offset, 0);
  assert.deepEqual(m.visible().map(n => n.lines[0]), ['- ☐ TODO parent', '  - child', '    - nested']);
  m.update('- first\n- DONE parent\n  - child\n    - nested\n- last', 60);
  assert.equal(m.focusId, selected);
  m.move(1, 60, 5); m.focus(); assert.equal(m.visible().length, 2);
  m.unfocus(60, 5); assert.equal(m.selected, selected); assert.equal(m.visible().length, 5);
  m.focus(); m.update('- remaining', 60);
  assert.equal(m.focusId, null); assert.equal(m.visible().length, 1);
});
test('atomic status save refuses stale or concurrently changed files and removes temporary files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-save-'));
  const filename = path.join(dir, 'today.md');
  const source = '- TODO task\n- sibling\n';
  const selected = parse(source)[0].id;
  try {
    fs.writeFileSync(filename, source, {mode: 0o640});
    assert.equal(saveTask(filename, source, selected), source.replace('TODO', 'DONE'));
    assert.equal(fs.statSync(filename).mode & 0o777, 0o640);
    assert.throws(() => saveTask(filename, source, selected), /외부 변경/);
    assert.equal(fs.readFileSync(filename, 'utf8'), source.replace('TODO', 'DONE'));
    fs.writeFileSync(filename, source);
    const sync = fs.fsyncSync;
    fs.fsyncSync = fd => { sync(fd); fs.writeFileSync(filename, '- external edit\n'); };
    try { assert.throws(() => saveTask(filename, source, selected), /외부 변경/); }
    finally { fs.fsyncSync = sync; }
    assert.equal(fs.readFileSync(filename, 'utf8'), '- external edit\n');
    assert.deepEqual(fs.readdirSync(dir), ['today.md']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('task, focus, and back use dedicated unmodified keys', () => {
  assert.equal(keyAction('t'), 'task');
  assert.equal(keyAction('\r'), 'focus');
  assert.equal(keyAction('\x1b'), 'back');
  assert.equal(keyAction('\x1b[13u'), 'focus');
  assert.equal(keyAction('\x1b[27u'), 'back');
});
