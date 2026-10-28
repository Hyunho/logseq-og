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

 // Split, indent, outdent, and merge through editor keyboard commands.
 await page.locator('.page-blocks-inner .ls-block').first().click();await page.locator('textarea:visible').fill('prefixsuffix');
 for(let n=0;n<6;n++)await page.keyboard.press('ArrowLeft');await page.keyboard.press('Enter');await page.waitForTimeout(400);
 await page.keyboard.press('Tab');await page.keyboard.press('Escape');await page.waitForTimeout(1400);
 const source=path.join(graph,'pages/회의.md');assert.match(fs.readFileSync(source,'utf8'),/prefix\n[ \t]+- suffix/);
 await page.getByText('suffix',{exact:true}).click();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Meta+ArrowLeft');await page.keyboard.press('Backspace');await page.keyboard.press('Escape');await page.waitForTimeout(1200);
 assert.match(fs.readFileSync(source,'utf8'),/prefixsuffix/);assert.equal(fs.readFileSync(source,'utf8').includes('id::'),false);
 const beforeMove=await page.locator('.page-blocks-inner .ls-block').evaluateAll(es=>es.map(e=>e.getAttribute('blockid')).sort());
 await page.getByText('두 번째',{exact:true}).click();await page.waitForFunction(()=>frontend.state.get_edit_content()==='두 번째');await page.evaluate(()=>frontend.handler.editor.move_up_down(true)(new Event('keydown')));await page.keyboard.press('Escape');await waitForText(source,'두 번째\n- prefixsuffix');
 assert.deepEqual(await page.locator('.page-blocks-inner .ls-block').evaluateAll(es=>es.map(e=>e.getAttribute('blockid')).sort()),beforeMove);
 fs.writeFileSync(path.join(graph,'pages/target.md'),'- shared target');
 fs.mkdirSync(path.join(graph,'journals'),{recursive:true});fs.writeFileSync(path.join(graph,'journals/2001_02_03.md'),'- journal source');
 fs.writeFileSync(path.join(graph,'pages/host.md'),'- {{embed [[target]]}}\n- {{embed [[target]]}}\n- {{embed [[journals/2001_02_03]]}}');
 await page.waitForFunction(()=>frontend.db.get_file_page('pages/host.md'));
 await page.evaluate(()=>{location.hash='#/page/'+encodeURIComponent(frontend.db.get_file_page('pages/host.md'));});
 await page.getByText('journal source',{exact:true}).waitFor();assert.equal(await page.getByText('shared target',{exact:true}).count(),2);
 await page.getByText('shared target',{exact:true}).first().click();await page.locator('textarea:visible').fill('shared edited');await page.keyboard.press('Escape');await page.waitForTimeout(1200);
 assert.equal(await page.getByText('shared edited',{exact:true}).count(),2);await waitForText(path.join(graph,'pages/target.md'),'shared edited');assert.equal(fs.readFileSync(path.join(graph,'pages/target.md'),'utf8'),'- shared edited');


 const hostBefore=fs.readFileSync(path.join(graph,'pages/host.md'),'utf8');
 await page.getByText('shared edited',{exact:true}).first().click();await page.locator('textarea:visible').fill('embed pending');
 fs.writeFileSync(path.join(graph,'pages/target.md'),'- external embed');await page.getByText('앱 편집본 사용',{exact:true}).waitFor();
 assert.deepEqual(await page.locator('textarea[readonly]').evaluateAll(es=>es.map(e=>e.value)),['- embed pending','- external embed']);
 await page.getByText('앱 편집본 사용',{exact:true}).click();await waitForText(path.join(graph,'pages/target.md'),'embed pending');
 assert.equal(fs.readFileSync(path.join(graph,'pages/host.md'),'utf8'),hostBefore);
 // Query and card paths retain document/tag meaning without creating block ID properties.
 const queryRows=await page.evaluate(()=>cljs.core.clj__GT_js(cljs.core.deref(frontend.db.query_dsl.query(frontend.state.get_current_repo(),'[[target]]'))));assert.ok(JSON.stringify(queryRows).includes('embed'));
 fs.writeFileSync(path.join(graph,'pages/cards.md'),'- question #card\n  - answer');
 await page.waitForFunction(()=>frontend.db.get_file_page('pages/cards.md'));
 await page.evaluate(()=>{const b=cljs.core.first(frontend.db.get_page_blocks_no_cache(frontend.state.get_current_repo(),frontend.db.get_file_page('pages/cards.md')));frontend.extensions.srs.preview(cljs.core.get(b,cljs.core.keyword('db/id')));});
 await page.locator('#cards-modal').waitFor();assert.match(await page.locator('#cards-modal').innerText(),/question/);
 await page.locator('#card-answers').click();assert.match(await page.locator('#cards-modal').innerText(),/answer/);await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>frontend.extensions.pdf.assets.ensure_ref_block_BANG_(null,cljs.core.hash_map(cljs.core.keyword('id'),cljs.core.random_uuid()),null)),null);
 assert.equal(fs.readFileSync(path.join(graph,'pages/cards.md'),'utf8'),'- question #card\n  - answer');
 // A second independent renderer must not overwrite the first renderer's editing buffer.
 await page.evaluate(()=>{location.hash='#/page/'+encodeURIComponent(frontend.db.get_file_page('pages/회의.md'));});await page.waitForTimeout(800);
 const opened=app.waitForEvent('window');await page.evaluate(()=>frontend.handler.ui.open_new_window_BANG_(frontend.state.get_current_repo()));
 const second=await opened;second.setDefaultTimeout(15000);second.on('pageerror',e=>errors.push(e.message));
 await second.waitForFunction(()=>window.frontend?.db?.get_file_page('pages/회의.md'),null,{timeout:25000});
 await second.evaluate(()=>{location.hash='#/page/'+encodeURIComponent(frontend.db.get_file_page('pages/회의.md'));});await second.waitForTimeout(1500);
 await page.locator('.page-blocks-inner .ls-block').first().click();await page.locator('textarea:visible').fill('window one');
 await second.locator('.page-blocks-inner .ls-block').first().click();await second.locator('textarea:visible').fill('window two');
 assert.equal(await page.locator('textarea:visible').inputValue(),'window one');
 await page.keyboard.press('Escape');await second.getByText('앱 편집본 사용',{exact:true}).waitFor();
 assert.ok((await second.locator('textarea[readonly]').evaluateAll(es=>es.map(e=>e.value))).some(v=>v.includes('window two')));
 await second.getByText('앱 편집본 사용',{exact:true}).click();await second.waitForTimeout(1200);
 assert.match(fs.readFileSync(source,'utf8'),/window two/);try {await page.getByText('window two',{exact:true}).waitFor();}catch(e){console.log('FIRSTBODY',await page.locator('body').innerText());console.log('FIRSTSTATE',await page.evaluate(()=>({dirty:frontend.modules.file.core.dirty_QMARK_(frontend.state.get_current_repo(),frontend.db.get_file_page('pages/회의.md')),file:frontend.db.get_file(frontend.state.get_current_repo(),'pages/회의.md')})));throw e;}
 assert.deepEqual(errors,[]);console.log('PASS: split, indent/outdent, merge, move, multiple editable embeds, journal embed, queries, card preview, PDF reference guard, two-window conflict isolation');console.log('GRAPH',graph);
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
