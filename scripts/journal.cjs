#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function today(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')].join('-');
}

function render(source, color = false) {
  let fence = null;
  return source.split('\n').map(line => {
    const marker = line.match(/^\s*(?:[-*+]\s+)?(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/^(\s*(?:(?:[-*+]|\d+[.)])\s+)?)(TODO|DONE|\[ \]|\[[xX]\])(?=\s|$)/,
      (_, prefix, status) => {
        const done = status === 'DONE' || /^\[[xX]\]$/.test(status);
        const label = done ? '☑ DONE' : '☐ TODO';
        return prefix + (color ? `\x1b[${done ? '32' : '33'}m${label}\x1b[0m` : label);
      });
  }).join('\n');
}

function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2)) : value;
}

function main(args) {
  let graph = process.env.LOGSEQ_GRAPH || '~/documents/bilog2';
  let date = today();
  let color = 'auto';
  let file;
  let print = false;
  let explicitDate = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`오늘 저널을 전체 화면으로 표시합니다. t: 상태 변경, Enter: 블록 보기\n\n사용법: node scripts/journal.cjs [파일] [옵션]\n\n  --print            출력 후 종료 (파이프에서도 사용)\n  --graph 경로       그래프 폴더 (LOGSEQ_GRAPH 또는 ~/documents/bilog2)\n  --date YYYY-MM-DD   읽을 날짜 (기본: 로컬 시간 기준 오늘)\n  --color 모드       auto, always, never (기본: auto)\n  -h, --help         도움말\n`);
      return;
    }
    if (arg === '--print') { print = true; continue; }
    if (['--graph', '--date', '--color'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다.`);
      if (arg === '--graph') graph = value;
      if (arg === '--date') { date = value; explicitDate = true; }
      if (arg === '--color') color = value;
    } else if (arg.startsWith('-')) throw new Error(`알 수 없는 옵션: ${arg}`);
    else if (file) throw new Error('파일은 하나만 지정할 수 있습니다.');
    else file = arg;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('날짜는 유효한 YYYY-MM-DD 형식이어야 합니다.');
  }
  if (!['auto', 'always', 'never'].includes(color)) throw new Error('--color는 auto, always, never 중 하나여야 합니다.');
  const target = file ? expandHome(file) : path.join(expandHome(graph), 'journals', date.replaceAll('-', '_') + '.md');
  if (!print) {
    return require('./journal-tui.cjs').start({ graph: expandHome(graph), file: file && expandHome(file), date,
      followToday: !file && !explicitDate, color: color === 'always' || color === 'auto' && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb' });
  }
  let source;
  try { source = fs.readFileSync(target, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`저널 파일이 없습니다: ${target}`);
    throw new Error(`저널을 읽을 수 없습니다: ${target} (${error.code})`);
  }
  const useColor = color === 'always' || (color === 'auto' && process.stdout.isTTY &&
    process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb');
  process.stdout.write(render(source, useColor));
}

module.exports = { render, today };

if (require.main === module) {
  process.stdout.on('error', error => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`journal: ${error.message}\n`); process.exitCode = 1; }
}
