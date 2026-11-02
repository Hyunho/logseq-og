'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { render, today } = require('./journal.cjs');

// Terminal controls in journal text are never executed.
function safe(text) { return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function width(char) {
  if (/^\p{Mark}+$/u.test(char)) return 0;
  const n = char.codePointAt(0);
  return /\p{Extended_Pictographic}/u.test(char) || n >= 0x1100 && (n <= 0x115f || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7a3 || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f || n >= 0xff01 && n <= 0xff60 || n >= 0x20000) ? 2 : 1;
}
function wrap(text, columns) {
  const rows = []; let row = '', used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = width(segment);
    if (used + size > columns && row) { rows.push(row); row = ''; used = 0; }
    row += segment; used += size;
  }
  rows.push(row); return rows;
}
function parse(source) {
  const raw = safe(source).replace(/\r/g, '').replace(/\t/g, '  ').split('\n');
  if (raw.at(-1) === '') raw.pop();
  const decorated = render(raw.join('\n')).split('\n');
  const nodes = [], stack = [], counts = new Map(); let fence = null;
  raw.forEach((line, i) => {
    const mark = line.match(/^\s*(?:[-*+]\s+)?(`{3,}|~{3,})/);
    const match = !fence && line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
    }
    if (match) {
      const indent = match[1].length;
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const parent = stack.at(-1);
      // Ignore task-state changes when matching blocks across reloads.
      const base = JSON.stringify([parent?.id || '', match[2].replace(/^(TODO|DONE|\[[ xX]\])(?:\s+|$)/, '')]);
      const count = counts.get(base) || 0; counts.set(base, count + 1);
      const node = { line: i, editable: !mark, id: base + ':' + count, indent, parent: parent?.id, lines: [decorated[i]], children: false };
      if (parent) parent.children = true;
      nodes.push(node); stack.push(node);
    } else if (nodes.length) nodes.at(-1).lines.push(decorated[i]);
    else nodes.push({ id: 'preamble', indent: 0, lines: [decorated[i]], children: false });
  });
  return nodes;
}
class Model {
  constructor() { this.nodes = []; this.closed = new Set(); this.selected = null; this.offset = 0; this.focusId = null; this.beforeFocus = null; }
  visible() {
    const hidden = new Set(), inFocus = new Set();
    return this.nodes.filter(n => {
      if (this.focusId) {
        if (n.id !== this.focusId && !inFocus.has(n.parent)) return false;
        inFocus.add(n.id);
      }
      if (hidden.has(n.parent)) { hidden.add(n.id); return false; }
      if (this.closed.has(n.id)) hidden.add(n.id);
      return true;
    });
  }
  rows(columns) {
    return this.visible().flatMap(n => n.lines.flatMap((line, index) =>
      wrap((index === 0 ? n.children ? this.closed.has(n.id) ? '▸ ' : '▾ ' : '  ' : '  ') + line, columns)
        .map(text => ({ id: n.id, text }))));
  }
  update(source, columns) {
    const old = this.rows(columns); const anchor = old[this.offset];
    const within = anchor ? this.offset - old.findIndex(r => r.id === anchor.id) : 0;
    const index = this.visible().findIndex(n => n.id === this.selected);
    this.nodes = parse(source);
    const ids = new Set(this.nodes.map(n => n.id));
    this.closed = new Set([...this.closed].filter(id => ids.has(id)));
    if (this.focusId && !ids.has(this.focusId)) { this.focusId = null; this.beforeFocus = null; }
    const visible = this.visible();
    if (!visible.some(n => n.id === this.selected)) this.selected = visible[Math.max(0, Math.min(index, visible.length - 1))]?.id;
    const rows = this.rows(columns); const anchorIndex = rows.findIndex(r => r.id === anchor?.id);
    this.offset = anchorIndex >= 0 ? anchorIndex + within : Math.min(this.offset, Math.max(0, rows.length - 1));
  }
  move(delta, columns, height) {
    const visible = this.visible(); const index = visible.findIndex(n => n.id === this.selected);
    this.selected = visible[Math.max(0, Math.min(visible.length - 1, index + delta))]?.id;
    const rows = this.rows(columns); const row = rows.findIndex(r => r.id === this.selected);
    if (row < this.offset) this.offset = Math.max(0, row);
    if (row >= this.offset + height) this.offset = row - height + 1;
  }
  focus() {
    if (!this.selected || this.selected === 'preamble') return;
    if (!this.focusId) this.beforeFocus = { selected: this.selected, offset: this.offset };
    this.focusId = this.selected;
    this.closed.delete(this.focusId);
    this.offset = 0;
  }
  unfocus(columns, height) {
    if (!this.focusId) return;
    this.focusId = null;
    const saved = this.beforeFocus;
    this.beforeFocus = null;
    if (saved && this.visible().some(n => n.id === saved.selected)) this.selected = saved.selected;
    this.offset = saved?.offset || 0;
    this.move(0, columns, height);
  }
  fold(action) {
    const node = this.nodes.find(n => n.id === this.selected);
    if (!node?.children) return;
    if (action === 'expand' || action === 'toggle' && this.closed.has(node.id)) this.closed.delete(node.id);
    else this.closed.add(node.id);
  }
}
function keyAction(seq) {
  const actions = {
    '\x03': 'quit', q: 'quit', '?': 'help', '\x1b': 'back',
    k: 'up', j: 'down', ' ': 'toggle', t: 'task', '\r': 'focus', '\n': 'focus',
    '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down',
    '\x1b[D': 'collapse', '\x1bOD': 'collapse', '\x1b[C': 'expand', '\x1bOC': 'expand',
    '\x1b[5~': 'pageUp', '\x1b[6~': 'pageDown',
    '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home',
    '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end',
  };
  if (Object.hasOwn(actions, seq)) return actions[seq];
  // Decode unmodified CSI-u keys; former Cmd/Option/Ctrl bindings are ignored.
  const match = seq.match(/^\x1b\[(\d+)(?:;1(?::[12])?)?u$/);
  if (!match) return null;
  const code = Number(match[1]);
  const special = {57350: 'collapse', 57351: 'expand', 57352: 'up', 57353: 'down',
    57354: 'pageUp', 57355: 'pageDown', 57356: 'home', 57357: 'end'};
  return special[code] || (code <= 0x10ffff ? actions[String.fromCodePoint(code)] : null) || null;
}
// Change only the selected block's first line, retaining indentation, CRLF,
// properties, children, checkbox notation, and the file's trailing newline.
function toggleTask(source, selected) {
  if (typeof source !== 'string') throw new Error('읽은 저널이 없습니다. 갱신 후 다시 시도하세요.');
  const node = parse(source).find(n => n.id === selected);
  if (!node?.editable) throw new Error('상태를 변경할 수 있는 목록 항목을 선택하세요.');
  const lines = source.split('\n');
  const match = lines[node.line].match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*?)(\r?)$/);
  if (!match) throw new Error('항목 형식을 확인할 수 없습니다.');
  const [, prefix, body, ending] = match;
  if (/^(NOW|LATER|DOING|WAITING|CANCELED|CANCELLED)(?=\s|$)/.test(body)) {
    throw new Error('TODO/DONE 이외의 작업 상태는 변경하지 않습니다.');
  }
  const task = body.match(/^(TODO|DONE|\[ \]|\[[xX]\])(?=\s|$)/);
  const next = task ? ({TODO: 'DONE', DONE: 'TODO', '[ ]': '[x]', '[x]': '[ ]', '[X]': '[ ]'})[task[1]] + body.slice(task[1].length) : 'TODO ' + body;
  lines[node.line] = prefix + next + ending;
  return lines.join('\n');
}
function saveTask(filename, expected, selected) {
  // Refuse stale snapshots, rather than guessing which duplicate block to edit.
  const target = fs.realpathSync(filename);
  const before = fs.statSync(target);
  if (fs.readFileSync(target, 'utf8') !== expected) throw new Error('외부 변경을 감지했습니다. 내용을 확인하고 t를 다시 누르세요.');
  const next = toggleTask(expected, selected);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.journal-${process.pid}-${require('node:crypto').randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', before.mode & 0o777);
    fs.writeFileSync(fd, next, 'utf8');
    fs.fchmodSync(fd, before.mode & 0o777);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const current = fs.statSync(target);
    if (fs.realpathSync(filename) !== target || before.ino !== current.ino || before.mtimeMs !== current.mtimeMs ||
        before.ctimeMs !== current.ctimeMs || fs.readFileSync(target, 'utf8') !== expected) {
      throw new Error('저장 중 외부 변경을 감지했습니다. 내용을 확인하고 다시 시도하세요.');
    }
    fs.renameSync(temp, target);
    return next;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function start({ graph, file, date, followToday, color }) {
  const input = process.stdin, output = process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('전체 화면은 터미널에서 실행하세요. 파이프 출력은 --print를 사용하세요.');
  let model = new Model(), currentDate = date, lastSource, lastError, notice = '', help = false, stopped = false, pending = '', pasting = false, keyTimer;
  const columns = () => Math.max(1, (output.columns || 80) - 1);
  const height = () => Math.max(1, (output.rows || 24) - 3);
  const target = () => file || path.join(graph, 'journals', currentDate.replaceAll('-', '_') + '.md');
  function draw() {
    const cols = columns(), h = height();
    const rows = model.rows(cols);
    model.offset = Math.max(0, Math.min(model.offset, Math.max(0, rows.length - h)));
    const lines = help ? [
      'Journal TUI 단축키', '↑ / ↓ 또는 k / j: 항목 이동',
      '←: 접기 · →: 펼치기', 'Space: 접기/펼치기 전환',
      't: TODO/DONE 변경·저장 (상태 없으면 TODO)',
      'Enter: 선택 블록만 보기 · Esc: 전체 보기',
      'PgUp/PgDn: 스크롤 · Home/End: 처음/끝',
      '?: 도움말 닫기 · q / Ctrl+C: 종료',
    ].flatMap(line => wrap(line, cols)) : rows.slice(model.offset, model.offset + h).map(r => {
      let text = r.text;
      if (color) text = text.replace(/☐ TODO|☑ DONE/g, s => `\x1b[${s.startsWith('☑') ? 32 : 33}m${s}\x1b[39m`);
      return r.id === model.selected ? `\x1b[7m${text}\x1b[0m` : text;
    });
    if (!help && !rows.length) lines.push(lastError || '저널이 비어 있습니다. 변경을 기다리는 중…');
    const clip = text => wrap(safe(text), cols)[0];
    const screen = [clip(`Journal ${currentDate} · ${model.focusId ? '블록 보기 · Esc 전체 보기' : '전체 보기'}`), ...Array.from({ length: h }, (_, i) => lines[i] || ''),
      clip(notice || target()), clip('↑↓/jk 이동 · t 상태 · Enter 블록 · Esc 복귀 · ? 도움말 · q 종료')];
    output.write('\x1b[H' + screen.map(line => '\x1b[2K' + line).join('\r\n'));
  }
  function refresh() {
    const nextDate = followToday ? today() : currentDate;
    if (nextDate !== currentDate) {
      currentDate = nextDate; model = new Model(); lastSource = undefined; lastError = undefined;
      notice = '새 날짜의 저널로 전환했습니다.';
    }
    try {
      const source = fs.readFileSync(target(), 'utf8');
      if (source !== lastSource || lastError) {
        model.update(source, columns());
        if (lastSource !== undefined || lastError) notice = `변경 반영 ${new Date().toLocaleTimeString()} · 읽던 위치 유지`;
        lastSource = source; lastError = undefined; draw();
      }
    } catch (error) {
      const message = error.code === 'ENOENT' ? '저널 파일이 없습니다. 생성 대기 중…' : `저널 읽기 실패 (${error.code}) · 재시도 중…`;
      if (message !== lastError) { lastError = message; notice = message; draw(); }
    }
  }
  function action(name) {
    if (name === 'quit') return stop();
    if (name === 'help') help = !help;
    else if (name === 'back') {
      if (help) help = false;
      else model.unfocus(columns(), height());
    }
    else if (!help) {
      if (name === 'focus') model.focus();
      if (name === 'task') {
        if (followToday && today() !== currentDate) {
          refresh(); notice = '날짜가 바뀌었습니다. 변경할 항목을 다시 선택하세요.';
        } else {
          try {
            const next = saveTask(target(), lastSource, model.selected);
            model.update(next, columns()); lastSource = next; lastError = undefined;
            notice = 'TODO/DONE 상태를 저장했습니다.';
          } catch (error) {
            refresh(); notice = error.message;
          }
        }
      }
      if (name === 'up' || name === 'down') model.move(name === 'up' ? -1 : 1, columns(), height());
      if (['collapse', 'expand', 'toggle'].includes(name)) model.fold(name);
      const rows = model.rows(columns());
      if (name === 'home') { model.offset = 0; model.selected = rows[0]?.id; }
      if (name === 'end') { model.offset = Math.max(0, rows.length - height()); model.selected = rows.at(-1)?.id; }
      if (name === 'pageUp' || name === 'pageDown') {
        model.offset = Math.max(0, Math.min(Math.max(0, rows.length - height()), model.offset + (name === 'pageUp' ? -height() : height())));
        model.selected = rows[model.offset]?.id;
      }
    }
    draw();
  }
  function consume(flush = false) {
    while (pending) {
      let token;
      if (pending.startsWith('\x1b[')) {
        const match = pending.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (!match) { if (!flush) return; pending = ''; return; }
        token = match[0];
      } else if (pending.startsWith('\x1bO')) {
        if (pending.length < 3 && !flush) return;
        token = pending.slice(0, 3);
      } else {
        if (pending === '\x1b' && !flush) return;
        token = pending[0];
      }
      pending = pending.slice(token.length);
      if (token === '\x1b[200~') { pasting = true; continue; }
      if (token === '\x1b[201~') { pasting = false; continue; }
      if (pasting) continue;
      const name = keyAction(token); if (name) action(name);
      if (stopped) return;
    }
  }
  function onData(data) { pending += data.toString(); clearTimeout(keyTimer); consume(); keyTimer = setTimeout(() => consume(true), 80); }
  const wasRaw = input.isRaw;
  function stop() {
    if (stopped) return; stopped = true;
    clearInterval(timer); clearTimeout(keyTimer);
    input.off('data', onData); output.off('resize', draw);
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('SIGHUP', stop);
    input.setRawMode(wasRaw); input.pause();
    output.write('\x1b[?2004l\x1b[<u\x1b[0m\x1b[?25h\x1b[?1049l');
  }
  input.setRawMode(true); input.resume();
  output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[>1u');
  const timer = setInterval(refresh, 500);
  input.on('data', onData); output.on('resize', draw);
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
  refresh(); draw();
  return stop;
}
module.exports = { safe, width, wrap, parse, Model, keyAction, toggleTask, saveTask, start };
