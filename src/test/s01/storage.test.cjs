require('../../electron/electron/s01').configure(require('mldoc').Mldoc);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dispatch } = require('../../electron/electron/s01.js');
function graph(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-s01-'));
  fs.mkdirSync(path.join(root, 'pages'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'pages/a.md'), call: (op, args = {}) => dispatch({ root, relative: 'pages/a.md', op, ...args }) };
}
test('SQLite cache survives reopen and changed contents regenerate every ID', t => {
  const g = graph(t);
  const a = g.call('identity', { content: '- A\n- B', count: 2 });
  const b = g.call('identity', { content: '- A\n- B', count: 2 });
  assert.equal(a.pageId, b.pageId); assert.deepEqual(a.blockIds, b.blockIds);
  const c = g.call('identity', { content: '- B\n- A', count: 2 });
  assert.ok(c.blockIds.every(id => !a.blockIds.includes(id)));
  assert.equal(fs.readFileSync(path.join(g.root, 'logseq/identity.sqlite')).subarray(0, 15).toString(), 'SQLite format 3');
});
test('cache deletion and corruption regenerate without touching Markdown', t => {
  const g = graph(t); fs.writeFileSync(g.file, '- preserved\r\n');
  const args = { content: '- preserved\r\n', count: 1 };
  const a = g.call('identity', args);
  const cache = path.join(g.root, 'logseq/identity.sqlite');
  fs.unlinkSync(cache);
  const b = g.call('identity', args); assert.notEqual(a.pageId, b.pageId); assert.ok(b.notice);
  fs.writeFileSync(cache, 'not SQLite');
  const c = g.call('identity', args); assert.ok(c.notice); assert.notEqual(b.pageId, c.pageId);
  assert.equal(fs.readFileSync(g.file, 'utf8'), args.content);
});
test('save compares exact contents, commits cache, and keeps both conflict choices', t => {
  const g = graph(t); fs.writeFileSync(g.file, '- old');
  const ids = g.call('identity', { content: '- old', count: 1 });
  assert.equal(g.call('save', { expected: '- old', content: '- app', ids }).status, 'saved');
  assert.deepEqual(g.call('identity', { content: '- app', count: 1 }).blockIds, ids.blockIds);
  fs.writeFileSync(g.file, '- disk\n');
  const result = g.call('save', { expected: '- app', content: '- mine', ids });
  assert.equal(result.status, 'conflict'); assert.equal(fs.readFileSync(g.file, 'utf8'), '- disk\n');
  const details = g.call('details', { id: result.conflict.id });
  assert.equal(details.app, '- mine'); assert.equal(details.disk, '- disk\n');
  assert.equal(g.call('resolve', { id: details.id, choice: 'app' }).status, 'resolved');
  assert.equal(fs.readFileSync(g.file, 'utf8'), '- mine');
  assert.equal(g.call('details', { id: details.id }).disk, '- disk\n');
});
test('external deletion stays deleted until user chooses to restore', t => {
  const g = graph(t);
  const conflict = g.call('save', { expected: '- old', content: '- app' }).conflict;
  assert.equal(conflict.deleted, true); assert.equal(fs.existsSync(g.file), false);
  const r = g.call('resolve', { id: conflict.id, choice: 'disk' });
  assert.equal(r.content, null); assert.equal(fs.existsSync(g.file), false);
  assert.equal(g.call('details', { id: conflict.id }).app, '- app');
});
test('external deletion can be restored and changed disk requires a new choice', t => {
  const g = graph(t);
  const c = g.call('save', { expected: '- old', content: '- app' }).conflict;
  fs.writeFileSync(g.file, '- newer');
  const next = g.call('resolve', { id: c.id, choice: 'app' });
  assert.equal(next.status, 'conflict'); assert.equal(fs.readFileSync(g.file, 'utf8'), '- newer');
  g.call('resolve', { id: next.conflict.id, choice: 'app' });
  assert.equal(fs.readFileSync(g.file, 'utf8'), '- app');
  assert.deepEqual(g.call('conflicts'), []);
});
test('path traversal and symlinks cannot escape the graph', t => {
  const g = graph(t); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'og-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(g.root, 'pages/link'));
  for (const relative of ['../outside.md', '/tmp/outside.md', 'pages/link/file.md', 'logseq/conflicts/x.md']) {
    assert.throws(() => g.call('save', { relative, expected: null, content: 'bad' }));
  }
});
test('cache failure after Markdown save never rolls back the document', t => {
  const g = graph(t); const ids = g.call('identity', { content: '- old', count: 1 });
  ids.blockIds = ['invalid'];
  const result = g.call('save', { expected: null, content: '- saved', ids });
  assert.equal(result.status, 'saved'); assert.ok(result.notice);
  assert.equal(fs.readFileSync(g.file, 'utf8'), '- saved');
  assert.notDeepEqual(g.call('identity', { content: '- saved', count: 1 }).blockIds, ids.blockIds);
});
test('conflict snapshot failure does not overwrite the source', t => {
  const g = graph(t); fs.writeFileSync(g.file, '- disk');
  fs.mkdirSync(path.join(g.root, 'logseq')); fs.writeFileSync(path.join(g.root, 'logseq/conflicts'), 'blocked');
  assert.throws(() => g.call('save', { expected: '- old', content: '- app' }));
  assert.equal(fs.readFileSync(g.file, 'utf8'), '- disk');
});
test('file rename proposes only parsed links and embeds, leaves code unchanged', t => {
  const g = graph(t); fs.writeFileSync(g.file, '- document');
  fs.writeFileSync(path.join(g.root, 'pages/ref.md'), '- [[a]] and `[[a]]`\n- {{embed [[a]]}}\n```\n[[a]]\n```');
  const r = g.call('move', { destination: 'pages/new.md', expected: '- document' });
  assert.equal(fs.existsSync(g.file), false);
  assert.equal(r.plan.updates.length, 1);
  assert.equal(r.plan.updates[0].items.length, 2);
  assert.ok(r.plan.updates[0].after.includes('`[[a]]`'));
  assert.ok(r.plan.updates[0].after.includes('```\n[[a]]\n```'));
  assert.ok(fs.readFileSync(path.join(g.root, 'pages/ref.md'), 'utf8').includes('[[a]]'));
  const applied = g.call('apply-plan', { id: r.plan.id, selected: ['pages/ref.md'] });
  assert.equal(applied[0].status, 'saved');
  assert.ok(fs.readFileSync(path.join(g.root, 'pages/ref.md'), 'utf8').includes('[[new]]'));
});
test('adding a duplicate proposes path qualification, changed source is skipped', t => {
  const g = graph(t); fs.writeFileSync(g.file, '- A');
  fs.writeFileSync(path.join(g.root, 'pages/ref.md'), '- [[a]]');
  g.call('scan');
  fs.mkdirSync(path.join(g.root, 'pages/nested'));
  fs.writeFileSync(path.join(g.root, 'pages/nested/a.md'), '- other');
  const plan = g.call('scan').plan;
  assert.ok(plan.updates[0].after.includes('[[pages/a]]'));
  fs.writeFileSync(path.join(g.root, 'pages/ref.md'), '- newer');
  assert.equal(g.call('apply-plan', { id: plan.id, selected: ['pages/ref.md'] })[0].status, 'changed');
  assert.equal(fs.readFileSync(path.join(g.root, 'pages/ref.md'), 'utf8'), '- newer');
});
test('external rename uses file identity, copy is not a move', t => {
  const g = graph(t); fs.writeFileSync(g.file, '- A'); g.call('scan');
  fs.copyFileSync(g.file, path.join(g.root, 'pages/copy.md'));
  assert.deepEqual(g.call('scan').moves, {});
  fs.renameSync(g.file, path.join(g.root, 'pages/new.md'));
  assert.deepEqual(g.call('scan').moves, { 'pages/a.md': 'pages/new.md' });
});
test('UTF-8 offsets, labels, bold and quoted references preserve surrounding text', t => {
  const g = graph(t); fs.writeFileSync(g.file, '- A');
  fs.writeFileSync(path.join(g.root, 'pages/ref.md'), '- 한글 **[[a]]** [표시]([[a]]) `[[a]]`\n> [[a]]');
  const plan=g.call('move',{destination:'pages/변경.md',expected:'- A'}).plan;
  assert.equal(plan.updates[0].after,'- 한글 **[[변경]]** [표시]([[변경]]) `[[a]]`\n> [[변경]]');
});
test('logically damaged ID rows rebuild without touching Markdown', t => {
  const g = graph(t); fs.writeFileSync(g.file,'- A');
  g.call('identity',{content:'- A',count:1});
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(path.join(g.root,'logseq/identity.sqlite'));
  db.exec("UPDATE documents SET block_ids='broken'"); db.close();
  const r=g.call('identity',{content:'- A',count:1});
  assert.equal(r.reused,false); assert.ok(r.notice);
  assert.equal(fs.readFileSync(g.file,'utf8'),'- A');
  assert.throws(()=>g.call('save',{relative:'pages/../logseq/conflicts/a.md',expected:null,content:'bad'}));
});
test('incomplete SQLite schema is disposable', t => {
  const g=graph(t); fs.mkdirSync(path.join(g.root,'logseq'));
  const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(path.join(g.root,'logseq/identity.sqlite'));
  db.exec('CREATE TABLE documents (path TEXT PRIMARY KEY)');db.close();
  const r=g.call('identity',{content:'- A',count:1});assert.ok(r.notice);assert.equal(r.blockIds.length,1);
});

const service = require('../../electron/electron/s01.js');
const {spawnSync} = require('node:child_process');
for (const stage of ['before-displace','before-install']) test(`external replacement at ${stage} is never overwritten`,t=>{
 const g=graph(t); fs.writeFileSync(g.file,'old');
 t.after(()=>service.setTestHook(null));
 service.setTestHook(s=>{if(s===stage) fs.writeFileSync(g.file,'late external');});
 assert.equal(g.call('save',{expected:'old',content:'mine'}).status,'conflict');
 assert.equal(fs.readFileSync(g.file,'utf8'),'late external');
 assert.ok(g.call('conflicts').length);
});
test('late writes to a displaced open inode are discoverable and recoverable',t=>{
 const g=graph(t); fs.writeFileSync(g.file,'old'); const fd=fs.openSync(g.file,'r+');
 t.after(()=>fs.closeSync(fd));
 assert.equal(g.call('save',{expected:'old',content:'mine'}).status,'saved');
 fs.writeSync(fd,'late external',0,'utf8'); fs.fsyncSync(fd);
 assert.equal(g.call('health').recovery,true);
 const d=g.call('details',{id:g.call('conflicts')[0].id});
 assert.equal(d.displaced,'late external'); assert.equal(d.currentDisk,'mine');
 assert.equal(g.call('resolve',{id:d.id,choice:'displaced',observedHash:d.currentHash,displacedHash:d.displacedHash}).status,'resolved');
 assert.equal(fs.readFileSync(g.file,'utf8'),'late external');
});
for(const code of ['EACCES','ENOSPC']) test(`${code} during installation restores the prior source`,t=>{
 const g=graph(t); fs.writeFileSync(g.file,'old');
 t.after(()=>service.setTestHook(null));
 service.setTestHook(s=>{if(s==='before-install') throw Object.assign(Error(code),{code});});
 assert.throws(()=>g.call('save',{expected:'old',content:'mine'}),{code});
 assert.equal(fs.readFileSync(g.file,'utf8'),'old');
 assert.equal(g.call('details',{id:g.call('conflicts')[0].id}).app,'mine');
});
for(const stage of ['after-snapshot-app','before-snapshot-manifest','before-displace','after-displace','before-install','after-install','before-manifest','after-manifest','before-cache','before-cache-commit','after-cache']) test(`process death at ${stage} preserves recoverable source and editor versions`,t=>{
 const g=graph(t); fs.writeFileSync(g.file,'old');
 const ids=g.call('identity',{content:'old',count:1});
 const modulePath=require.resolve('../../electron/electron/s01.js');
 const code=`const s=require(${JSON.stringify(modulePath)});s.setTestHook(stage=>{if(stage===${JSON.stringify(stage)})process.exit(73)});s.dispatch(${JSON.stringify({root:g.root,relative:'pages/a.md',op:'save',expected:'old',content:'mine',ids})});`;
 const child=spawnSync(process.execPath,['-e',code],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 assert.equal(child.status,73,child.stderr.toString());
 g.call('conflicts'); // Finish an interrupted backup from its durable intent.
 const records=fs.readdirSync(path.join(g.root,'logseq/conflicts'));
 const d=g.call('details',{id:records[0]}); assert.equal(d.app,'mine'); assert.equal(d.disk,'old');
 if(d.state==='pending') {
  assert.equal(g.call('resolve',{id:d.id,choice:'previous',observedHash:d.currentHash}).status,'resolved');
  assert.equal(fs.readFileSync(g.file,'utf8'),'old');
 } else {
  assert.equal(fs.readFileSync(g.file,'utf8'),'mine');
  const next=g.call('identity',{content:'mine',count:1}); assert.equal(next.blockIds.length,1);
 }
});
test('separate writer processes conflict instead of silently replacing a newer save',t=>{
 const g=graph(t); fs.writeFileSync(g.file,'old');
 assert.equal(g.call('save',{expected:'old',content:'window one'}).status,'saved');
 const child=spawnSync(process.execPath,['-e',`console.log(JSON.stringify(require(${JSON.stringify(require.resolve('../../electron/electron/s01.js'))}).dispatch(${JSON.stringify({root:g.root,relative:'pages/a.md',op:'save',expected:'old',content:'window two'})})))`],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 assert.equal(child.status,0,child.stderr.toString()); assert.equal(JSON.parse(child.stdout).status,'conflict');
 assert.equal(fs.readFileSync(g.file,'utf8'),'window one');
});
test('cleanup requires explicit selection and retains conflict evidence',t=>{
 const g=graph(t); fs.writeFileSync(g.file,'old');g.call('save',{expected:'old',content:'mine'});
 const ids=g.call('journals').map(x=>x.id);assert.equal(ids.length,1);
 assert.throws(()=>g.call('prune-journals'),/selection/);
 assert.equal(g.call('prune-journals',{ids}).removed,1);
 const c=g.call('save',{expected:'old',content:'another'}).conflict;
 assert.throws(()=>g.call('prune-journals',{ids:[c.id]}),/conflict/);
 g.call('resolve',{id:c.id,choice:'disk'});
 assert.throws(()=>g.call('prune-journals',{ids:[c.id]}),/conflict/);
 assert.equal(g.call('details',{id:c.id}).app,'another');
 assert.equal(fs.readFileSync(g.file,'utf8'),'mine');
});
test('link plans survive a fresh process and applying twice is idempotent',t=>{
 const g=graph(t);fs.writeFileSync(g.file,'- document');fs.writeFileSync(path.join(g.root,'pages/ref.md'),'- [[a]]');
 g.call('scan');const plan=g.call('move',{destination:'pages/new.md',expected:'- document'}).plan;
 const child=spawnSync(process.execPath,['-e',`console.log(JSON.stringify(require(${JSON.stringify(require.resolve('../../electron/electron/s01.js'))}).dispatch(${JSON.stringify({root:g.root,op:'plans'})})))`],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 assert.equal(child.status,0,child.stderr.toString());assert.equal(JSON.parse(child.stdout)[0].id,plan.id);
 for(let n=0;n<2;n++) assert.equal(g.call('apply-plan',{id:plan.id,selected:['pages/ref.md']})[0].status,'saved');
 assert.equal(g.call('plans').length,0);assert.equal(fs.readFileSync(path.join(g.root,'pages/ref.md'),'utf8'),'- [[new]]');
});
test('offline directory moves retain identity evidence for each child document',t=>{
 const g=graph(t);fs.mkdirSync(path.join(g.root,'pages/sub'));fs.writeFileSync(path.join(g.root,'pages/sub/a.md'),'- a');fs.writeFileSync(path.join(g.root,'pages/sub/b.md'),'- b');
 fs.writeFileSync(g.file,'- [[pages/sub/a]]\n- {{embed [[pages/sub/b]]}}');g.call('scan');
 fs.renameSync(path.join(g.root,'pages/sub'),path.join(g.root,'pages/moved'));
 const result=g.call('scan');assert.deepEqual(result.moves,{'pages/sub/a.md':'pages/moved/a.md','pages/sub/b.md':'pages/moved/b.md'});
 assert.equal(result.plan.updates[0].after,'- [[pages/moved/a]]\n- {{embed [[pages/moved/b]]}}');
});
test('resolving one editor version does not dismiss another editor version',t=>{
 const g=graph(t);fs.writeFileSync(g.file,'outside');
 const first=g.call('conflict',{base:'old',app:'editor one'});
 const repeat=g.call('conflict',{base:'old',app:'editor one'});assert.equal(repeat.id,first.id);
 const second=g.call('conflict',{base:'old',app:'editor two'});
 g.call('resolve',{id:first.id,choice:'app'});
 assert.equal(g.call('details',{id:second.id}).state,'pending');
 assert.equal(g.call('details',{id:second.id}).app,'editor two');
});
test('new-file installation never replaces a concurrently created document',t=>{
 const g=graph(t);t.after(()=>service.setTestHook(null));
 service.setTestHook(stage=>{if(stage==='before-install')fs.writeFileSync(g.file,'other creator');});
 assert.equal(g.call('save',{expected:null,content:'new editor'}).status,'conflict');
 assert.equal(fs.readFileSync(g.file,'utf8'),'other creator');
});
test('cache commit I/O failure leaves the saved Markdown and reports the cache failure',t=>{
 const g=graph(t);fs.writeFileSync(g.file,'old');const ids=g.call('identity',{content:'old',count:1});
 t.after(()=>service.setTestHook(null));service.setTestHook(stage=>{if(stage==='before-cache-commit')throw Object.assign(Error('ENOSPC'),{code:'ENOSPC'});});
 const result=g.call('save',{expected:'old',content:'saved',ids});assert.equal(result.status,'saved');assert.match(result.notice,/ENOSPC/);
 assert.equal(fs.readFileSync(g.file,'utf8'),'saved');service.setTestHook(null);
 assert.notEqual(g.call('identity',{content:'saved',count:1}).pageId,ids.pageId);
});
test('cache generation communicates a rebuild to every renderer',t=>{
 const g=graph(t);const before=g.call('health').generation;assert.equal(g.call('health').generation,before);
 fs.unlinkSync(path.join(g.root,'logseq/identity.sqlite'));const after=g.call('health').generation;assert.notEqual(after,before);assert.equal(g.call('health').generation,after);
});
test('two processes released at the same admission boundary retain both edits',async t=>{
 const g=graph(t);fs.writeFileSync(g.file,'old');
 const children=[];
 try {
  const done=['one','two'].map(label=>{
   const code=`const fs=require('node:fs'),s=require(${JSON.stringify(require.resolve('../../electron/electron/s01.js'))});s.setTestHook(stage=>{if(stage==='before-journal'){fs.writeFileSync(${JSON.stringify(g.root)}+'/'+${JSON.stringify(label)}+'.ready','');while(!fs.existsSync(${JSON.stringify(g.root)}+'/go'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}});console.log(JSON.stringify(s.dispatch(${JSON.stringify({root:g.root,relative:'pages/a.md',op:'save',expected:'old',content:label})})));`;
   const child=require('node:child_process').spawn(process.execPath,['-e',code],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});children.push(child);
   return new Promise((resolve,reject)=>{let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',status=>status===0?resolve(JSON.parse(out)):reject(Error(err)));});
  });
  const deadline=Date.now()+10000;
  while(!['one','two'].every(x=>fs.existsSync(path.join(g.root,x+'.ready')))) {assert.ok(Date.now()<deadline,'both writers reached barrier');await new Promise(r=>setTimeout(r,10));}
  fs.writeFileSync(path.join(g.root,'go'),'');const results=await Promise.all(done);
  assert.ok(results.some(x=>x.status==='conflict'));assert.ok(['one','two'].includes(fs.readFileSync(g.file,'utf8')));
  const edits=fs.readdirSync(path.join(g.root,'logseq/conflicts')).map(id=>fs.readFileSync(path.join(g.root,'logseq/conflicts',id,'app.md'),'utf8'));
  assert.ok(edits.includes('one'));assert.ok(edits.includes('two'));
 }finally{children.forEach(child=>{if(child.exitCode===null)child.kill();});}
});
test('a confirmed new document can create its chosen nested directory',t=>{
 const g=graph(t);const relative='pages/new/sub/document.md';
 assert.equal(g.call('save',{relative,expected:null,content:'- created'}).status,'saved');
 assert.equal(fs.readFileSync(path.join(g.root,relative),'utf8'),'- created');
});

test('collapsed UI persists independently of Markdown and follows only matching block identities', t => {
  const g = graph(t), content = '- parent\r\n  - child\r\n';
  fs.writeFileSync(g.file, content);
  const before = fs.statSync(g.file);
  const ids = g.call('identity', {content, count:2});
  g.call('save-block-ui', {entries:[{id:ids.blockIds[0],collapsed:true}]});
  assert.equal(g.call('identity', {content,count:2}).collapsed[ids.blockIds[0]], true);
  g.call('save-block-ui', {entries:[{id:ids.blockIds[0],collapsed:false}]});
  assert.equal(g.call('identity', {content,count:2}).collapsed[ids.blockIds[0]], false);
  assert.equal(fs.readFileSync(g.file,'utf8'), content);
  assert.equal(fs.statSync(g.file).mtimeMs,before.mtimeMs);
  assert.equal(g.call('conflicts').length,0);
  assert.throws(()=>g.call('save-block-ui',{entries:[{id:ids.blockIds[0],collapsed:'true'}]}),/Invalid block UI/);
  const changed = g.call('identity',{content:'- external',count:1});
  assert.equal(changed.collapsed,undefined);
  assert.ok(!changed.blockIds.includes(ids.blockIds[0]));
});

test('feature metadata survives reopen, identity cache loss, and one authored block edit', t => {
  const g=graph(t), content='- card\n- other', blocks=['card','other'];
  const ids=g.call('identity',{content,count:2,blocks});
  const data='{:properties {:card-repeats {:value 3 :source-lines []}}}';
  g.call('save-block-metadata',{entries:[{id:ids.blockIds[0],data}]});
  assert.deepEqual(g.call('block-metadata'),[{id:ids.blockIds[0],data}]);
  fs.unlinkSync(path.join(g.root,'logseq/identity.sqlite'));
  const restored=g.call('identity',{content,count:2,blocks});
  assert.deepEqual(restored.blockIds,ids.blockIds);
  const edited=g.call('identity',{content:'- card changed\n- other',count:2,blocks:['card changed','other']});
  assert.deepEqual(edited.blockIds,ids.blockIds);
  assert.deepEqual(g.call('block-metadata'),[{id:ids.blockIds[0],data}]);
  assert.throws(()=>g.call('save-block-metadata',{entries:[{id:'invalid',data}]}),/Invalid app metadata/);
  g.call('save-block-metadata',{entries:[{id:ids.blockIds[0],data:'{}'}]});
  assert.equal(g.call('block-metadata')[0].data,'{}');
});

test('durable metadata follows a moved document but does not alias a copied document', t => {
  const g=graph(t), content='- card', blocks=['card'];
  fs.writeFileSync(g.file,content);
  const ids=g.call('identity',{content,count:1,blocks});
  g.call('save-block-metadata',{entries:[{id:ids.blockIds[0],data:'{:properties {:card-repeats {:value 2}}}'}]});
  fs.writeFileSync(path.join(g.root,'pages/copy.md'),content);
  const copy=g.call('identity',{relative:'pages/copy.md',content,count:1,blocks});
  assert.notEqual(copy.blockIds[0],ids.blockIds[0]);
  fs.renameSync(g.file,path.join(g.root,'pages/moved.md'));
  const moved=g.call('identity',{relative:'pages/moved.md',content,count:1,blocks});
  assert.deepEqual(moved.blockIds,ids.blockIds);
});

test('damaged feature store is not reset and never changes Markdown', t => {
  const g=graph(t), content='- authored';
  fs.writeFileSync(g.file,content);
  g.call('block-metadata');
  const store=path.join(g.root,'logseq/metadata.sqlite');
  fs.writeFileSync(store,'damaged feature store');
  assert.throws(()=>g.call('block-metadata'));
  assert.equal(fs.readFileSync(store,'utf8'),'damaged feature store');
  assert.equal(fs.readFileSync(g.file,'utf8'),content);
});
