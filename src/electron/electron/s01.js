/* S01: disposable SQLite identity cache and durable conflict snapshots.
 * Runs only in Electron main; one synchronous dispatch owns each operation.
 * Markdown is authoritative. Never recover Markdown from the identity cache.
 */
// Load built-ins directly: shadow-cljs 2.19 rewrites CommonJS node: imports
// into shim names that its development module loader cannot resolve.
const fs = globalThis.process.getBuiltinModule('fs');
const path = globalThis.process.getBuiltinModule('path');
const crypto = globalThis.process.getBuiltinModule('crypto');
const { DatabaseSync } = globalThis.process.getBuiltinModule('node:sqlite');
const refs = require('./s01_refs');
// Fault injection is a module API for tests, never an IPC operation.
let testHook = () => {};
function checkpoint(stage, data) { testHook(stage, data); }
function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function mkdirDurable(dir) {
  if (fs.existsSync(dir)) return;
  const parent = path.dirname(dir);
  mkdirDurable(parent);
  try { fs.mkdirSync(dir); }
  catch (error) { if (error.code !== 'EEXIST' || !fs.lstatSync(dir).isDirectory()) throw error; }
  syncDir(parent);
}
const VERSION = 1;
const hash = text => text == null ? null : crypto.createHash('sha256').update(text).digest('hex');
const uuid = () => crypto.randomUUID();
const uuidRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contained(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) throw Error('Invalid graph-relative path');
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) throw Error('Path escapes graph');
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('Symbolic links are not supported');
  }
  return full;
}
function documentPath(root, relative) {
  const normalized = path.relative(root, path.resolve(root, relative));
  if (!/\.(md|markdown)$/i.test(normalized) || /^(logseq|assets)\//i.test(normalized)) throw Error('Not a Markdown document');
  return contained(root, relative);
}
function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function atomic(file, text) {
  mkdirDurable(path.dirname(file));
  const temp = `${file}.${uuid()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function openCache(root) {
  const file = contained(root, 'logseq/identity.sqlite');
  mkdirDurable(path.dirname(file));
  let db;
  let notice = !fs.existsSync(file) ? 'ID 캐시를 생성했습니다. 문서 본문은 변경하지 않았습니다.' : null;
  try {
    db = new DatabaseSync(file);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, VERSION].includes(version)) throw Object.assign(Error('Unsupported identity schema'), { cacheInvalid: true });
    const integrity = db.prepare('PRAGMA quick_check').get();
    if (Object.values(integrity)[0] !== 'ok') throw Object.assign(Error('Invalid identity cache'), { cacheInvalid: true });
    db.exec('CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, hash TEXT NOT NULL, page_id TEXT NOT NULL UNIQUE, block_ids TEXT NOT NULL); PRAGMA user_version=1;');
    const columns = db.prepare('PRAGMA table_info(documents)').all().map(x => x.name);
    if (columns.join(',') !== 'path,hash,page_id,block_ids') throw Object.assign(Error('Incomplete identity schema'), {cacheInvalid:true});
  } catch (e) {
    if (db) db.close();
    // Permission, full disk and I/O errors must propagate, never masquerade as corruption.
    if (!e.cacheInvalid && ![11, 26].includes(e.errcode)) throw e;
    fs.renameSync(file, `${file}.invalid-${uuid()}`);
    db = new DatabaseSync(file);
    db.exec('CREATE TABLE documents (path TEXT PRIMARY KEY, hash TEXT NOT NULL, page_id TEXT NOT NULL UNIQUE, block_ids TEXT NOT NULL); PRAGMA user_version=1;');
    notice = 'ID 캐시가 손상되어 재생성했습니다. 문서 본문은 보존했습니다.';
  }
  const seen = new Set();
  const invalid = db.prepare('SELECT * FROM documents').all().some(row => {
    let value;
    try { value = { pageId: row.page_id, blockIds: JSON.parse(row.block_ids) }; } catch (_) { return true; }
    if (!validIdentity(value, value.blockIds?.length) || !/^[a-f0-9]{64}$/.test(row.hash)) return true;
    const ids = [value.pageId, ...value.blockIds];
    if (ids.some(id => seen.has(id))) return true;
    ids.forEach(id => seen.add(id)); return false;
  });
  if (invalid) {
    db.exec('DELETE FROM documents');
    notice = 'ID 대응 정보가 손상되어 재생성했습니다. 문서 본문은 보존했습니다.';
  }
  db.exec('CREATE TABLE IF NOT EXISTS cache_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO cache_meta VALUES (1, ?)').run(uuid());
  let generation = db.prepare('SELECT generation FROM cache_meta WHERE singleton=1').get().generation;
  if (invalid || !uuidRE.test(generation)) {
    generation = uuid();
    db.prepare('UPDATE cache_meta SET generation=? WHERE singleton=1').run(generation);
    db.exec('DELETE FROM documents');
  }
  db.exec('CREATE TABLE IF NOT EXISTS block_ui (block_id TEXT PRIMARY KEY, collapsed INTEGER NOT NULL CHECK(collapsed IN (0,1)))');
  return { db, notice, generation };
}
// Durable feature data is deliberately independent of disposable identity.sqlite.
function metadataStore(root, entries) {
  const file = contained(root, 'logseq/metadata.sqlite');
  mkdirDurable(path.dirname(file));
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    if (entries !== undefined) {
      if (!Array.isArray(entries) || entries.some(e => !uuidRE.test(e.id) || typeof e.data !== 'string' || e.data.length > 4000000)) throw Error('Invalid app metadata');
      db.exec('BEGIN IMMEDIATE');
      try {
        const put = db.prepare('INSERT OR REPLACE INTO blocks VALUES (?, ?)');
        for (const e of entries) put.run(e.id, e.data);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    return db.prepare('SELECT id, data FROM blocks').all().map(row=>({...row}));
  } finally { db.close(); }
}
function metadataIdentity(root, relative, text, count, blocks, value) {
  const file = contained(root, 'logseq/metadata.sqlite');
  if (!fs.existsSync(file) && !value) return null;
  mkdirDurable(path.dirname(file));
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS identities (path TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL, fingerprints TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const fingerprints = Array.isArray(blocks) && blocks.length === count ? blocks.map(hash) : null;
    if (value) {
      if (value.previousPath && value.previousPath !== relative && !fs.existsSync(documentPath(root,value.previousPath)))
        db.prepare('DELETE FROM identities WHERE path=?').run(value.previousPath);
      db.prepare('INSERT OR REPLACE INTO identities VALUES (?, ?, ?, ?)')
        .run(relative, hash(text), JSON.stringify({pageId:value.pageId,blockIds:value.blockIds}), fingerprints ? JSON.stringify(fingerprints) : null);
      return null;
    }
    let row = db.prepare('SELECT * FROM identities WHERE path=?').get(relative);
    if (!row) {
      const moved = db.prepare('SELECT * FROM identities WHERE hash=?').all(hash(text))
        .filter(r => !fs.existsSync(documentPath(root,r.path)));
      if (moved.length === 1) row = moved[0];
    }
    if (!row) return null;
    const old = JSON.parse(row.data);
    if (!validIdentity(old,old.blockIds?.length)) throw Error('Invalid durable metadata identity');
    const hasMetadata = id => !!db.prepare("SELECT id FROM blocks WHERE id=? AND data <> '{}'").get(id);
    if (!old.blockIds.some(hasMetadata)) return null;
    if (row.hash === hash(text) && validIdentity(old,count)) return {...old, previousPath:row.path};
    const before = row.fingerprints && JSON.parse(row.fingerprints);
    if (!before || !fingerprints) return null;
    const ids = fingerprints.map(fp => {
      const indices = before.flatMap((v,i)=>v===fp?[i]:[]);
      return indices.length===1 && fingerprints.filter(v=>v===fp).length===1 ? old.blockIds[indices[0]] : null;
    });
    // A single edited block among otherwise unchanged positions keeps its feature history.
    const unmatched = ids.flatMap((v,i)=>v===null?[i]:[]);
    if (count === before.length && unmatched.length === 1 && ids.every((id,i)=>id===null || id===old.blockIds[i]))
      ids[unmatched[0]] = old.blockIds[unmatched[0]];
    return {pageId:old.pageId, blockIds:ids.map(id=>id || uuid())};
  } finally { db.close(); }
}
function validIdentity(value, count) {
  return value && uuidRE.test(value.pageId) && Array.isArray(value.blockIds) && value.blockIds.length === count && value.blockIds.every(x => uuidRE.test(x)) && new Set([value.pageId, ...value.blockIds]).size === count + 1;
}
function put(db, relative, text, value) {
  if (!validIdentity(value, value.blockIds?.length)) throw Error('Invalid identity snapshot');
  // UUIDs must not accidentally alias another document's entities.
  const own = new Set([value.pageId, ...value.blockIds]);
  for (const row of db.prepare('SELECT page_id, block_ids FROM documents WHERE path <> ?').all(relative)) {
    if ([row.page_id, ...JSON.parse(row.block_ids)].some(id => own.has(id))) throw Error('Identity belongs to another document');
  }
  db.prepare('INSERT OR REPLACE INTO documents VALUES (?, ?, ?, ?)').run(relative, hash(text), value.pageId, JSON.stringify(value.blockIds));
}
function identity(root, relative, text, count, blocks) {
  documentPath(root, relative);
  if (!Number.isSafeInteger(count) || count < 0 || typeof text !== 'string') throw Error('Invalid parse request');
  const { db, notice } = openCache(root);
  try {
    const row = db.prepare('SELECT * FROM documents WHERE path=?').get(relative);
    let cached;
    try { cached = row && { pageId: row.page_id, blockIds: JSON.parse(row.block_ids) }; } catch (_) { /* invalid cache row */ }
    if (row?.hash === hash(text) && validIdentity(cached, count)) {
      metadataIdentity(root, relative, text, count, blocks, cached);
      return { ...cached, collapsed: Object.fromEntries(cached.blockIds.flatMap(id => {
      const ui = db.prepare('SELECT collapsed FROM block_ui WHERE block_id=?').get(id);
      return ui ? [[id, !!ui.collapsed]] : [];
    })), notice, reused: true };
    }
    const value = metadataIdentity(root, relative, text, count, blocks) || { pageId: uuid(), blockIds: Array.from({ length: count }, uuid) };
    db.exec('BEGIN IMMEDIATE');
    try {
      if (value.previousPath && value.previousPath !== relative && !fs.existsSync(documentPath(root,value.previousPath)))
        db.prepare('DELETE FROM documents WHERE path=?').run(value.previousPath);
      put(db, relative, text, value); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    metadataIdentity(root, relative, text, count, blocks, value);
    return { ...value, reused: false, notice: notice || (row && !validIdentity(cached, count) ? 'ID 대응 정보를 재생성했습니다.' : null) };
  } finally { db.close(); }
}
function snapshot(root, relative, base, app, disk, reason = 'external-change') {
  documentPath(root, relative);
  if (!['save','resolution'].includes(reason)) {
    const duplicate = conflicts(root).find(r => r.path === relative && r.reason === reason &&
      r.baseHash === hash(base) && r.appHash === hash(app) && r.diskHash === hash(disk));
    if (duplicate) return duplicate;
  }
  const id = uuid();
  const dir = contained(root, `logseq/conflicts/${id}`);
  mkdirDurable(dir);
  const record = { id, path: relative, reason, state: 'pending', diskHash: hash(disk), baseHash: hash(base), appHash: hash(app), deleted: disk == null, createdAt: new Date().toISOString() };
  atomic(path.join(dir, 'intent.json'), JSON.stringify(record));
  // Publish the manifest last; a durable intent locates an interrupted backup.
  if (base != null) atomic(path.join(dir, 'base.md'), base);
  atomic(path.join(dir, 'app.md'), app);
  checkpoint('after-snapshot-app', {root,relative,id});
  if (disk != null) atomic(path.join(dir, 'disk.md'), disk);
  checkpoint('before-snapshot-manifest', {root,relative,id});
  atomic(path.join(dir, 'manifest.json'), JSON.stringify(record, null, 2));
  return record;
}
function recoverSnapshot(root, id) {
  const dir = contained(root, `logseq/conflicts/${id}`);
  const intent = read(path.join(dir, 'intent.json'));
  if (!intent) return null;
  const record = JSON.parse(intent);
  if (record.id !== id) throw Error('Invalid recovery intent');
  documentPath(root, record.path);
  if (hash(read(contained(root, `logseq/conflicts/${id}/app.md`))) !== record.appHash) return null;
  let disk = read(contained(root, `logseq/conflicts/${id}/disk.md`));
  if (hash(disk) !== record.diskHash) {
    const base = read(contained(root, `logseq/conflicts/${id}/base.md`));
    disk = hash(base) === record.diskHash ? base : read(documentPath(root, record.path));
    record.capturedDiskHash = record.diskHash;
    record.diskHash = hash(disk); record.deleted = disk === null;
    if (disk !== null) atomic(path.join(dir, 'disk.md'), disk);
  }
  record.recoveredSnapshot = true;
  const text = JSON.stringify(record);
  atomic(path.join(dir, 'manifest.json'), text);
  return text;
}
function conflicts(root) {
  const dir = contained(root, 'logseq/conflicts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(x => uuidRE.test(x)).flatMap(id => {
    const manifest = contained(root, `logseq/conflicts/${id}/manifest.json`);
    const text = read(manifest) || recoverSnapshot(root, id);
    if (!text) return [];
    const record = JSON.parse(text);
    if (record.id !== id) throw Error('Invalid conflict manifest');
    return record.state === 'pending' ? [record] : [];
  });
}
// Capture the inode being replaced, then install without overwriting any path
// created by another writer. The captured inode is retained even if a writer
// still has it open. There is no compare-then-overwrite rename of Markdown.
function guardedReplace(root, relative, expected, content, journal) {
  const file = documentPath(root, relative);
  const dir = contained(root, `logseq/conflicts/${journal.id}`);
  const candidate = path.join(dir, 'candidate.md');
  const displaced = path.join(dir, 'displaced.md');
  atomic(candidate, content);
  mkdirDurable(path.dirname(file));
  try {
  checkpoint('before-displace', {root, relative, file, journal});
  if (expected !== null) {
    try { fs.renameSync(file, displaced); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    syncDir(path.dirname(file)); syncDir(dir);
    checkpoint('after-displace', {root, relative, file, journal});
    const captured = read(displaced);
    if (captured !== expected) {
      // Restore only into an absent path; never replace a newer external file.
      if (captured !== null) {
        try { fs.linkSync(displaced, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      return {status:'conflict', conflict:snapshot(root, relative, expected, content, read(file), 'write-race')};
    }
  }
  checkpoint('before-install', {root, relative, file, journal});
  try { fs.linkSync(candidate, file); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return {status:'conflict', conflict:snapshot(root, relative, expected, content, read(file), 'write-race')};
  }
  fs.unlinkSync(candidate); syncDir(path.dirname(file)); syncDir(dir);
  checkpoint('after-install', {root, relative, file, journal});
  // Detect writes through a previously-open descriptor. displaced.md remains
  // available even when the write happens after this check.
  if ((expected !== null && read(displaced) !== expected) || read(file) !== content)
    return {status:'conflict', conflict:snapshot(root, relative, expected, content, read(file), 'write-race')};
  return {status:'saved'};
  } catch (error) {
    // An ordinary I/O exception gets the same exclusive restoration as a race.
    // Abrupt termination instead leaves an explicit recoverable pending journal.
    if (fs.existsSync(displaced)) {
      try { fs.linkSync(displaced, file); } catch (_) { /* preserve whichever file exists */ }
    }
    throw error;
  }
}

function save(root, relative, expected, content, ids) {
  const file = documentPath(root, relative);
  if (typeof content !== 'string' || !(expected === null || typeof expected === 'string')) throw Error('Invalid write request');
  const disk = read(file);
  const pending = conflicts(root).find(x => x.path === relative);
  if (pending || disk !== expected) return { status: 'conflict', conflict: snapshot(root, relative, expected, content, disk) };
  checkpoint('before-journal', {root,relative,file});
  // Preserve the observed old version and the new edit before replacing Markdown.
  // This is a recovery journal, not the disposable SQLite cache.
  const journal = snapshot(root, relative, expected, content, disk, 'save');
  if (read(file) !== disk) return { status: 'conflict', conflict: snapshot(root, relative, expected, content, read(file)) };
  const replacement = guardedReplace(root, relative, expected, content, journal);
  if (replacement.status !== 'saved') return replacement;
  checkpoint('before-manifest', {root, relative, file, journal});
  const manifest = contained(root, `logseq/conflicts/${journal.id}/manifest.json`);
  atomic(manifest, JSON.stringify({ ...journal, state: 'saved' }, null, 2));
  checkpoint('after-manifest', {root, relative, file, journal});
  let notice = null;
  if (ids) {
    let cache;
    try {
      checkpoint('before-cache', {root, relative, file, journal});
      cache = openCache(root); notice = cache.notice;
      cache.db.exec('BEGIN IMMEDIATE'); put(cache.db, relative, content, ids); checkpoint('before-cache-commit', {root, relative, file, journal}); cache.db.exec('COMMIT');
      metadataIdentity(root, relative, content, ids.blockIds.length, ids.blockContents, ids);
      checkpoint('after-cache', {root, relative, file, journal});
    } catch (e) {
      if (cache) { try { cache.db.exec('ROLLBACK'); } catch (_) {} }
      notice = `본문은 저장했지만 ID 캐시를 갱신하지 못했습니다: ${e.message}`;
    } finally { cache?.db.close(); }
  }
  return { status: 'saved', notice, mtime: fs.statSync(file).mtime };
}
function conflictDetails(root, id) {
  if (!uuidRE.test(id)) throw Error('Invalid conflict ID');
  const dir = contained(root, `logseq/conflicts/${id}`);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  return { ...record, app: read(contained(root, `logseq/conflicts/${id}/app.md`)),
    disk: read(contained(root, `logseq/conflicts/${id}/disk.md`)),
    displaced: read(contained(root, `logseq/conflicts/${id}/displaced.md`)),
    interrupted: ['save','resolution','late-external-write'].includes(record.reason) && record.state === 'pending',
    currentDisk: read(documentPath(root, record.path)),
    currentHash: hash(read(documentPath(root, record.path))),
    displacedHash: hash(read(contained(root, `logseq/conflicts/${id}/displaced.md`))) };
}
function resolve(root, id, choice, observedHash, displacedHash) {
  const record = conflictDetails(root, id);
  if (record.state !== 'pending' || !['app', 'disk', 'previous', 'displaced'].includes(choice)) throw Error('Invalid conflict selection');
  const file = documentPath(root, record.path);
  const disk = read(file);
  const expectedHash = record.interrupted && observedHash !== undefined ? observedHash : record.diskHash;
  if (hash(disk) !== expectedHash) {
    const next = snapshot(root, record.path, record.disk, record.app, disk);
    atomic(contained(root, `logseq/conflicts/${id}/manifest.json`), JSON.stringify({...JSON.parse(read(contained(root, `logseq/conflicts/${id}/manifest.json`))),state:'superseded',replacedBy:next.id}));
    return {status:'conflict',conflict:next};
  }
  if (hash(record.app) !== record.appHash || hash(record.disk) !== record.diskHash) throw Error('Conflict snapshot damaged');
  if (choice === 'previous' && (!record.interrupted || record.disk === null)) throw Error('No previous disk version');
  if (choice === 'displaced' && (!record.interrupted || record.displaced === null || displacedHash !== record.displacedHash)) throw Error('Captured version changed; reopen the conflict');
  const selected = choice === 'displaced' ? record.displaced : choice === 'previous' ? record.disk : record.app;
  let resolutionId;
  if (choice !== 'disk') {
    const journal = snapshot(root, record.path, disk, selected, disk, 'resolution');
    resolutionId = journal.id;
    const replacement = guardedReplace(root, record.path, disk, selected, journal);
    if (replacement.status !== 'saved') return replacement;
  }
  // Choosing disk (including deletion) never writes the current disk version back.
  for (const item of conflicts(root).filter(x => x.id === id || x.id === resolutionId)) {
    atomic(contained(root, `logseq/conflicts/${item.id}/manifest.json`), JSON.stringify({ ...item, state: 'resolved', choice, resolvedAt: new Date().toISOString() }, null, 2));
  }
  return { status: 'resolved', path: record.path, content: choice !== 'disk' ? selected : disk };
}

function inventory(root) {
  const files = [];
  function visit(relative) {
    const dir = relative ? contained(root, relative) : root;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (/^(logseq|assets|node_modules)(\/|$)/.test(rel)) continue;
      if (entry.isDirectory()) visit(rel);
      else if (/\.(md|markdown)$/i.test(rel)) {
        const stat = fs.statSync(contained(root, rel));
        files.push({ path: rel, key: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` });
      }
    }
  }
  visit(''); return files;
}
function propose(root, before, after, moves) {
  const updates = [];
  for (const relative of after) {
    const content = read(documentPath(root, relative));
    const items = refs.changes(content, before, after, moves);
    if (items.length) updates.push({ path: relative, hash: hash(content), before: content, after: refs.apply(content, items), items });
  }
  if (!updates.length) return null;
  const plan = { id: uuid(), updates };
  atomic(contained(root, `logseq/link-plans/${plan.id}.json`), JSON.stringify({...plan, applied:[]}));
  return plan;
}
function scan(root) {
  const { db, notice } = openCache(root);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS inventory (path TEXT PRIMARY KEY, file_key TEXT NOT NULL)');
    const before = db.prepare('SELECT path, file_key as key FROM inventory').all();
    const after = inventory(root);
    const moves = {};
    for (const old of before.filter(x => !after.some(y => x.path === y.path))) {
      const candidates = after.filter(x => x.key === old.key && !before.some(y => y.path === x.path));
      if (candidates.length === 1 && before.filter(x => x.key === old.key).length === 1) moves[old.path] = candidates[0].path;
    }
    const pathsChanged = before.length !== after.length || before.some(x => !after.some(y => y.path === x.path));
    const plan = before.length && pathsChanged ? propose(root, before.map(x=>x.path), after.map(x=>x.path), moves) : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM inventory');
      const insert = db.prepare('INSERT INTO inventory VALUES (?, ?)');
      for (const file of after) insert.run(file.path, file.key);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { notice, plan, moves, pathsChanged };
  } finally { db.close(); }
}
function getPlan(root, id) {
  if (!uuidRE.test(id)) throw Error('Invalid plan ID');
  const raw = read(contained(root, `logseq/link-plans/${id}.json`));
  if (!raw) throw Error('Link update plan expired');
  const plan = JSON.parse(raw);
  if (plan.id !== id || !Array.isArray(plan.updates)) throw Error('Damaged link update plan');
  return {...plan,root};
}
function pendingPlans(root) {
  const dir = contained(root, 'logseq/link-plans');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(x => x.endsWith('.json') && uuidRE.test(x.slice(0,-5)))
    .map(x => getPlan(root,x.slice(0,-5))).filter(p => p.updates.some(u => !(p.applied || []).includes(u.path)));
}
function applyPlan(root, id, selected) {
  const plan = getPlan(root, id);
  if (!Array.isArray(selected)) throw Error('Link update plan expired');
  const results = [];
  for (const relative of selected) {
    const update = plan.updates.find(x => x.path === relative);
    if (!update) throw Error('Unknown link update');
    const current = read(documentPath(root, relative));
    if (current !== update.after && hash(current) !== update.hash) {
      results.push({ path: relative, status: 'changed' }); continue;
    }
    const result = {path:relative, ...(current === update.after ? {status:'saved'} : save(root, relative, update.before, update.after))};
    results.push(result);
    if (result.status === 'saved') {
      plan.applied = [...new Set([...(plan.applied || []), relative])];
      const {root:_, ...persisted} = plan;
      atomic(contained(root, `logseq/link-plans/${id}.json`), JSON.stringify(persisted));
    }
  }
  return results;
}
function move(root, relative, destination, expected) {
  const from = documentPath(root, relative), to = documentPath(root, destination);
  if (fs.existsSync(to)) throw Error('Destination exists');
  if (read(from) !== expected || conflicts(root).some(x => x.path === relative)) throw Error('Document changed or has a pending conflict');
  const before = inventory(root).map(x => x.path);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // Exclusive link creation prevents a concurrently-created destination from being overwritten.
  fs.linkSync(from, to);
  fs.unlinkSync(from);
  const after = inventory(root).map(x => x.path);
  return { plan: propose(root, before, after, { [relative]: destination }), path: destination, content: read(to) };
}

function journalRecords(root) {
  const dir = contained(root, 'logseq/conflicts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(id => uuidRE.test(id)).flatMap(id => {
    const raw = read(contained(root, `logseq/conflicts/${id}/manifest.json`));
    return raw ? [JSON.parse(raw)] : [];
  });
}
function auditJournals(root) {
  let changed = false;
  for (const record of journalRecords(root)) {
    if (record.state !== 'saved') continue;
    const displaced = read(contained(root, `logseq/conflicts/${record.id}/displaced.md`));
    if (displaced !== null && hash(displaced) !== record.diskHash) {
      atomic(contained(root, `logseq/conflicts/${record.id}/manifest.json`),
        JSON.stringify({...record,state:'pending',reason:'late-external-write'}));
      changed = true;
    }
  }
  return changed;
}
function prunableJournals(root) {
  const pendingPaths = new Set(conflicts(root).map(r=>r.path));
  return journalRecords(root).filter(r => r.state === 'saved' && r.reason === 'save' && !pendingPaths.has(r.path))
    .filter(r => hash(read(contained(root, `logseq/conflicts/${r.id}/displaced.md`))) === r.diskHash)
    .map(r => ({id:r.id,path:r.path,createdAt:r.createdAt,
      bytes:fs.readdirSync(contained(root, `logseq/conflicts/${r.id}`))
        .reduce((n,name)=>n+fs.lstatSync(contained(root, `logseq/conflicts/${r.id}/${name}`)).size,0)}));
}
function pruneJournals(root, ids) {
  if (!Array.isArray(ids)) throw Error('Explicit journal selection required');
  const eligible = new Set(prunableJournals(root).map(r=>r.id));
  if (ids.some(id=>!eligible.has(id))) throw Error('Selection includes a conflict or changed journal');
  for (const id of ids) fs.rmSync(contained(root, `logseq/conflicts/${id}`),{recursive:true});
  return {removed:ids.length};
}

function dispatch(request) {
  const { op, root, relative, content, count, expected, ids, id, choice, base, app } = request;
  if (typeof root !== 'string' || !path.isAbsolute(root) || fs.lstatSync(root).isSymbolicLink()) throw Error('Invalid graph root');
  switch (op) {
    case 'health': { const cache = openCache(root); cache.db.close(); return {notice:cache.notice, reset:!!cache.notice, generation:cache.generation, recovery:auditJournals(root)}; }
    case 'identities': {
      const cache = openCache(root);
      try { return cache.db.prepare('SELECT path, page_id, block_ids FROM documents').all()
        .map(row=>({path:row.path,pageId:row.page_id,blockIds:JSON.parse(row.block_ids)})); }
      finally { cache.db.close(); }
    }
    case 'block-metadata': return metadataStore(root);
    case 'save-block-metadata': metadataStore(root, request.entries); return {};
    case 'block-ui': {
      const cache = openCache(root);
      try { return cache.db.prepare('SELECT block_id, collapsed FROM block_ui').all()
        .map(row=>({id:row.block_id,collapsed:!!row.collapsed})); }
      finally { cache.db.close(); }
    }
    case 'save-block-ui': {
      const entries = request.entries;
      if (!Array.isArray(entries) || entries.some(e => !uuidRE.test(e.id) || typeof e.collapsed !== 'boolean')) throw Error('Invalid block UI state');
      const cache = openCache(root);
      try {
        cache.db.exec('BEGIN IMMEDIATE');
        const putUI = cache.db.prepare('INSERT OR REPLACE INTO block_ui VALUES (?, ?)');
        for (const e of entries) putUI.run(e.id, Number(e.collapsed));
        cache.db.exec('COMMIT');
        return {notice:cache.notice};
      } catch (e) { cache.db.exec('ROLLBACK'); throw e; }
      finally { cache.db.close(); }
    }
    case 'journals': return prunableJournals(root);
    case 'prune-journals': return pruneJournals(root, request.ids);
    case 'read': { const file = documentPath(root, relative); const content = read(file); return { content, mtime: content === null ? null : fs.statSync(file).mtime }; }
    case 'paths': return inventory(root).map(x=>x.path);
    case 'scan': return scan(root);
    case 'plan': return getPlan(root, id);
    case 'plans': return pendingPlans(root);
    case 'apply-plan': return applyPlan(root, id, request.selected);
    case 'move': return move(root, relative, request.destination, expected);
    case 'identity': return identity(root, relative, content, count, request.blocks);
    case 'save': return save(root, relative, expected, content, ids);
    case 'conflict': return snapshot(root, relative, base, app, read(documentPath(root, relative)));
    case 'conflicts': return conflicts(root);
    case 'details': return conflictDetails(root, id);
    case 'resolve': return resolve(root, id, choice, request.observedHash, request.displacedHash);
    default: throw Error('Unknown S01 operation');
  }
}
module.exports = { dispatch, hash, contained, configure: refs.configure, setTestHook: hook => {testHook = hook || (() => {});} };
