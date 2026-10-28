// Run after compiling app/electron and copying resources/js/preload.js to static/js/preload.js.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const repo = path.resolve(__dirname, '../../..');
async function waitForText(file, text) {
 const deadline=Date.now()+15000;
 while(Date.now()<deadline) { if(fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes(text))return;await new Promise(r=>setTimeout(r,100)); }
 assert.fail(`Timed out waiting for persisted ${text}: ${fs.readFileSync(file,'utf8')}`);
}
(async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'s01-ui-'));
 const graph=path.join(root,'graph'); fs.mkdirSync(path.join(graph,'logseq'),{recursive:true}); fs.mkdirSync(path.join(graph,'pages'));
 fs.writeFileSync(path.join(graph,'logseq/config.edn'),'{:s01/enabled? true :preferred-format "Markdown"}');
 fs.writeFileSync(path.join(graph,'pages/회의.md'),'- 첫 번째\n- 두 번째');
 const bootstrap=path.join(root,'bootstrap.cjs');
 fs.writeFileSync(bootstrap,`const {app}=require('electron'); app.setPath('home',${JSON.stringify(root)}); app.setPath('userData',${JSON.stringify(path.join(root,'user'))}); app.setAppPath(${JSON.stringify(path.join(repo,'static'))}); require(${JSON.stringify(path.join(repo,'static/electron.js'))});`);
 const app=await electron.launch({executablePath:require('electron'),cwd:path.join(repo,'static'), args:[bootstrap],timeout:25000});
 try {
 const page=await app.firstWindow();
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
 const initialIds = await page.locator('.page-blocks-inner .ls-block').evaluateAll(es=>es.map(e=>e.getAttribute('blockid')));
 await page.locator('.page-blocks-inner .ls-block').first().click();
 await page.waitForTimeout(500);
 await page.locator('textarea:visible').fill('앱에서 변경');
 await page.keyboard.press('Escape');
 await page.waitForTimeout(2500);
 assert.equal(fs.readFileSync(path.join(graph,'pages/회의.md'),'utf8'),'- 앱에서 변경\n- 두 번째');
 assert.deepEqual(await page.locator('.page-blocks-inner .ls-block').evaluateAll(es=>es.map(e=>e.getAttribute('blockid'))),initialIds);
 console.log('SAVED',fs.readFileSync(path.join(graph,'pages/회의.md'),'utf8'));
 await page.keyboard.press('Escape');
 fs.writeFileSync(path.join(graph,'pages/회의.md'),'- 외부 수정\n- 두 번째');
 await page.waitForTimeout(2500);
 assert.notDeepEqual(await page.locator('.page-blocks-inner .ls-block').evaluateAll(es=>es.map(e=>e.getAttribute('blockid'))),initialIds);
 assert.ok((await page.locator('body').innerText()).includes('외부 수정'));
 const undo = await page.evaluate(()=>({pageId:frontend.db.get_file_page_id('pages/회의.md'),stack:cljs.core.clj__GT_js(cljs.core.deref(cljs.core.get(frontend.modules.editor.undo_redo.get_state(),cljs.core.keyword('undo-stack'))))}));
 assert.equal(undo.stack.some(x=>(x.blocks||[]).some(b=>b.id===undo.pageId||b.page?.id===undo.pageId)),false);
 await page.keyboard.press('Meta+z'); await page.waitForTimeout(400);
 assert.equal(fs.readFileSync(path.join(graph,'pages/회의.md'),'utf8'),'- 외부 수정\n- 두 번째');
 await page.evaluate(()=>{location.hash='#/page/'+encodeURIComponent('pages/회의.md');});
 await page.getByText('외부 수정',{exact:true}).waitFor();
 await page.locator('.page-blocks-inner .ls-block').first().click();
 await page.locator('textarea:visible').fill('미저장 편집본');
 fs.writeFileSync(path.join(graph,'pages/회의.md'),'- 외부 동시 변경\n- 두 번째');
 await page.getByText('외부 변경본 사용',{exact:true}).waitFor({timeout:10000});
 assert.deepEqual(await page.locator('textarea[readonly]').evaluateAll(es=>es.map(e=>e.value)),['- 미저장 편집본\n- 두 번째','- 외부 동시 변경\n- 두 번째']);
 console.log('VERSIONS',await page.locator('textarea[readonly]').evaluateAll(es=>es.map(e=>e.value)));
 await page.getByText('외부 변경본 사용',{exact:true}).click();
 await page.waitForTimeout(1500);
 console.log('RESOLVED',fs.readFileSync(path.join(graph,'pages/회의.md'),'utf8'));
 assert.equal(fs.readFileSync(path.join(graph,'pages/회의.md'),'utf8'),'- 외부 동시 변경\n- 두 번째');
 for(const restore of [true,false]) {
   await page.locator('.page-blocks-inner .ls-block').first().click();
   await page.locator('textarea:visible').fill(restore?'삭제 시 미저장본':'다른 미저장 삭제본');
   fs.unlinkSync(path.join(graph,'pages/회의.md'));
   const button=page.getByText(restore?'편집본으로 문서 복원':'삭제 유지',{exact:true});
   await button.waitFor({timeout:10000}); await button.click(); await page.waitForTimeout(1000);
   assert.equal(fs.existsSync(path.join(graph,'pages/회의.md')),restore);
   if(restore) assert.match(fs.readFileSync(path.join(graph,'pages/회의.md'),'utf8'),/삭제 시 미저장본/);
 }
 fs.writeFileSync(path.join(graph,'pages/A.md'),'- [[없는 문서]]\n- {{embed [[B]]}}\n- ((12345678-1234-1234-1234-123456789abc))');
 fs.writeFileSync(path.join(graph,'pages/B.md'),'- {{embed [[A]]}}\n- B 내용');
 await page.waitForFunction(()=>frontend.db.get_file_page('pages/A.md')&&frontend.db.get_file_page('pages/B.md'));
 await page.evaluate(()=>{location.hash='#/page/'+encodeURIComponent(frontend.db.get_file_page('pages/A.md'));});
 await page.waitForTimeout(800);console.log('EMBEDBODY',(await page.locator('body').innerText()).slice(-1800));
 await page.getByText('순환 임베드: 위 원본 링크에서 문서를 열 수 있습니다.',{exact:true}).waitFor({timeout:10000});
 assert.ok((await page.locator('body').innerText()).includes('((12345678-1234-1234-1234-123456789abc))'));
 const sourceA=fs.readFileSync(path.join(graph,'pages/A.md'),'utf8');
 await page.locator('.embed .ls-block').filter({hasText:'B 내용'}).last().click();
 await page.locator('textarea:visible').fill('임베드에서 변경');
 await page.keyboard.press('Escape'); await page.waitForTimeout(1500);
 await waitForText(path.join(graph,'pages/B.md'),'임베드에서 변경');
 assert.match(fs.readFileSync(path.join(graph,'pages/B.md'),'utf8'),/임베드에서 변경/);
 assert.equal(fs.readFileSync(path.join(graph,'pages/A.md'),'utf8'),sourceA);
 await page.getByText('[[없는 문서]]',{exact:true}).click();
 await page.getByText('문서 생성 위치',{exact:true}).waitFor();
 assert.equal(await page.locator('input:visible').last().inputValue(),'pages/없는 문서.md');
 await page.getByText('생성',{exact:true}).click(); await page.waitForTimeout(1000);
 assert.equal(fs.existsSync(path.join(graph,'pages/없는 문서.md')),true);
 assert.equal(fs.readFileSync(path.join(graph,'pages/없는 문서.md'),'utf8').includes('id::'),false);
 await page.locator('h1.page-title').click();
 await page.locator('input.edit-input').fill('표시 제목');
 await page.locator('input.edit-input').press('Enter');
 await page.getByRole('heading',{name:'표시 제목',exact:true}).waitFor();
 await page.waitForTimeout(1500);
 assert.match(fs.readFileSync(path.join(graph,'pages/없는 문서.md'),'utf8'),/title:: 표시 제목/);
 assert.equal(fs.existsSync(path.join(graph,'pages/표시 제목.md')),false);
 assert.deepEqual(errors,[]);
 console.log('PASS: edit, IDs, external change, conflict choice, deletion restore/keep, embed cycle, literal block ref, missing document creation');
 console.log('GRAPH',graph); console.log('CACHE',fs.existsSync(path.join(graph,'logseq/identity.sqlite')));
 await page.screenshot({path:path.join(root,'result.png')});
 } finally {await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
