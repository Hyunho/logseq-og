// Run after compiling app/electron and copying resources/js/preload.js to static/js/preload.js.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const repo = path.resolve(__dirname, '../../..');
(async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'s01-ui-'));
 const graph=path.join(root,'graph'); fs.mkdirSync(path.join(graph,'logseq'),{recursive:true}); fs.mkdirSync(path.join(graph,'pages'));
 fs.writeFileSync(path.join(graph,'logseq/config.edn'),'{:s01/enabled? true :preferred-format "Markdown"}');
 fs.writeFileSync(path.join(graph,'pages/회의.md'),'- 첫 번째\n- 두 번째');
 const bootstrap=path.join(root,'bootstrap.cjs');
 fs.writeFileSync(bootstrap,`const {app}=require('electron'); app.setPath('home',${JSON.stringify(root)}); app.setPath('userData',${JSON.stringify(path.join(root,'user'))}); app.setAppPath(${JSON.stringify(path.join(repo,'static'))}); require(${JSON.stringify(path.join(repo,'static/electron.js'))});`);
 let app=await electron.launch({executablePath:require('electron'),cwd:path.join(repo,'static'), args:[bootstrap],timeout:25000});
 try {
 let page=await app.firstWindow();
 page.setDefaultTimeout(10000);
 const errors=[];
 page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message);});
 page.on('console',m=>{if(m.type()==='error') console.log('CONSOLE',m.text().slice(0,800));});
 await page.waitForLoadState('domcontentloaded');
 await page.waitForTimeout(5000);
 await page.evaluate(g=>{ window.__E2E_TESTING__=true;window.__MOCKED_OPEN_DIR_PATH__=g;},graph);
 const choose=page.getByText('Choose a folder',{exact:true});
 if(await choose.count()) {await choose.click();await page.waitForTimeout(8000);}
 await page.evaluate(()=>{location.hash='#/page/'+encodeURIComponent('pages/회의.md');});
 await page.waitForTimeout(2000);

 const call=(op,args={})=>page.evaluate(({root,op,args})=>window.apis.s01({root,op,...args}).value,{root:graph,op,args});
 const route=async file=>{await page.evaluate(file=>{location.hash='#/page/'+encodeURIComponent(frontend.db.get_file_page(file));},file);await page.waitForTimeout(600);};
 const ids=()=>page.locator('.page-blocks-inner .ls-block').evaluateAll(es=>es.map(e=>e.getAttribute('blockid')));
 const plain=path.join(graph,'pages/plain.md');fs.writeFileSync(plain,'plain paragraph\r\n\r\nsecond paragraph\r\n');
 await page.waitForFunction(()=>frontend.db.get_file_page('pages/plain.md'));await route('pages/plain.md');
 await page.locator('.page-blocks-inner .ls-block').first().click();await page.keyboard.press('Escape');
 fs.writeFileSync(plain,'external paragraph\r\n\r\nsecond paragraph\r\n');
 await page.waitForFunction(()=>document.body.innerText.includes('external paragraph'));assert.equal((await call('conflicts')).length,0);
 assert.equal(fs.readFileSync(plain,'utf8'),'external paragraph\r\n\r\nsecond paragraph\r\n');
 for(const damage of ['delete','corrupt']) {
  const before=await ids();const raw=fs.readFileSync(plain);const cache=path.join(graph,'logseq/identity.sqlite');
  if(damage==='delete')fs.unlinkSync(cache);else fs.writeFileSync(cache,'broken sqlite');
  await page.waitForTimeout(6500);assert.notDeepEqual(await ids(),before);assert.deepEqual(fs.readFileSync(plain),raw);
 }
 // Duplicate file names must invalidate both direct and inherited backlinks without changing source bytes.
 fs.writeFileSync(path.join(graph,'pages/ref.md'),'- [[plain]]\n  - inherited');
 await page.waitForFunction(()=>frontend.db.get_file_page('pages/ref.md'));await page.waitForTimeout(700);
 const refIds=()=>page.evaluate(()=>{const blocks=frontend.db.get_page_blocks_no_cache(frontend.state.get_current_repo(),frontend.db.get_file_page('pages/ref.md'));return cljs.core.clj__GT_js(cljs.core.map(b=>cljs.core.map(e=>cljs.core.get(e,cljs.core.keyword('db/id')),cljs.core.concat(cljs.core.get(b,cljs.core.keyword('block/refs')),cljs.core.get(b,cljs.core.keyword('block/path-refs')))),blocks));});
 const targetId=await page.evaluate(()=>frontend.db.get_file_page_id('pages/plain.md'));
 assert.ok((await refIds()).flat().includes(targetId));
 fs.mkdirSync(path.join(graph,'pages/sub'));fs.writeFileSync(path.join(graph,'pages/sub/plain.md'),'- duplicate');
 await page.waitForFunction(()=>frontend.db.get_file_page('pages/sub/plain.md'));await page.waitForTimeout(500);
 // A proposal opens; the source text remains untouched until explicit selection.
 assert.equal(fs.readFileSync(path.join(graph,'pages/ref.md'),'utf8'),'- [[plain]]\n  - inherited');
 assert.equal((await refIds()).flat().includes(targetId),false);
 await page.keyboard.press('Escape');
 await route('pages/plain.md');await page.locator('.page-blocks-inner .ls-block').first().click();await page.locator('textarea:visible').fill('pending restart edit');
 fs.writeFileSync(plain,'outside restart');await page.getByText('외부 변경본 사용',{exact:true}).waitFor();
 const pending=(await call('conflicts'))[0];assert.ok(pending);
 await app.close();
 // A valid new SQLite cache must outrank a stale renderer snapshot after restart.
 fs.unlinkSync(path.join(graph,'logseq/identity.sqlite'));
 const restoredIdentity=require('../../electron/electron/s01.js').dispatch({op:'identity',root:graph,relative:'pages/회의.md',content:fs.readFileSync(path.join(graph,'pages/회의.md'),'utf8'),count:2});
 app=await electron.launch({executablePath:require('electron'),cwd:path.join(repo,'static'),args:[bootstrap],timeout:25000});page=await app.firstWindow();page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(e.message));await page.waitForLoadState('domcontentloaded');
 await page.getByText('저장 충돌 목록',{exact:true}).waitFor({timeout:25000});
 await page.waitForFunction(expected=>cljs.core.str(cljs.core.get(frontend.db.pull(frontend.db.get_file_page_id('pages/회의.md')),cljs.core.keyword('block/uuid')))===expected,restoredIdentity.pageId);
 await page.getByRole('button',{name:`${pending.path} · ${pending.createdAt}`,exact:true}).click();
 await page.getByText('앱 편집본 사용',{exact:true}).click();await page.waitForTimeout(1200);
 assert.match(fs.readFileSync(plain,'utf8'),/pending restart edit/);assert.equal((await call('details',{id:pending.id})).state,'resolved');
 assert.deepEqual(errors,[]);console.log('PASS: raw CRLF/plain text, live cache deletion/corruption, backlink reconciliation, restart conflict recovery');console.log('GRAPH',graph);
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
