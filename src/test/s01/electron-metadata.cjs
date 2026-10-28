// Compiled development app; isolated graph and Electron profile only.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const repo = path.resolve(__dirname, '../../..');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's01-metadata-'));
  const graph = path.join(root, 'graph');
  fs.mkdirSync(path.join(graph, 'logseq'), {recursive:true});
  fs.mkdirSync(path.join(graph, 'pages'));
  fs.writeFileSync(path.join(graph,'logseq/config.edn'), '{:s01/enabled? true :preferred-format "Markdown"}');
  const source = path.join(graph,'pages/a.md');
  const content = '- parent\n  query-sort-by:: authored\n  owner:: me\n  - child\n- TODO task\n- question #card';
  fs.writeFileSync(source, content);
  const bootstrap = path.join(root,'bootstrap.cjs');
  fs.writeFileSync(bootstrap, `const {app}=require('electron'); app.setPath('home',${JSON.stringify(root)}); app.setPath('userData',${JSON.stringify(path.join(root,'user'))}); app.setAppPath(${JSON.stringify(path.join(repo,'static'))}); require(${JSON.stringify(path.join(repo,'static/electron.js'))});`);
  let app, page; const errors=[];
  const launch = async () => {
    app = await electron.launch({executablePath:require('electron'),cwd:path.join(repo,'static'),args:[bootstrap],timeout:25000});
    page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror',e=>errors.push(e.message));
    await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(5000);
    await page.evaluate(g=>{window.__E2E_TESTING__=true; window.__MOCKED_OPEN_DIR_PATH__=g;},graph);
    const choose=page.getByText('Choose a folder',{exact:true});
    if(await choose.count()) {await choose.click();await page.waitForTimeout(8000);}
    await page.waitForFunction(()=>frontend.db.get_file_page('pages/a.md'));
    await page.evaluate(()=>{location.hash='#/page/'+encodeURIComponent(frontend.db.get_file_page('pages/a.md'));});
    await page.getByText('parent',{exact:true}).waitFor();
  };
  try {
    await launch();
    const ids=await page.locator('.page-blocks-inner .ls-block').evaluateAll(es=>es.map(e=>e.getAttribute('blockid')));
    const id=ids[0], taskId=ids[2], cardId=ids[3];
    const setApp=(id,key,value)=>page.evaluate(({id,key,value})=>frontend.handler.editor.property.set_app_property_BANG_(cljs.core.uuid(id),cljs.core.keyword(key),value),{id,key,value});
    const props=id=>page.evaluate(id=>cljs.core.clj__GT_js(cljs.core.get(frontend.db.entity(cljs.core.vector(cljs.core.keyword('block/uuid'),cljs.core.uuid(id))),cljs.core.keyword('block/properties'))),id);
    const blockContent=id=>page.evaluate(id=>cljs.core.get(frontend.db.entity(cljs.core.vector(cljs.core.keyword('block/uuid'),cljs.core.uuid(id))),cljs.core.keyword('block/content')),id);
    const before=fs.statSync(source).mtimeMs;
    await setApp(id,'query-sort-by','updated-at');
    await setApp(id,'query-sort-desc',true);
    await setApp(id,'background-color','red');
    await setApp(id,'logseq.order-list-type','number');
    await setApp(id,'hl-color','yellow');
    await setApp(id,'template','Daily');
    await page.evaluate(id=>frontend.extensions.srs.save_block_card_properties_BANG_(frontend.db.pull(cljs.core.vector(cljs.core.keyword('block/uuid'),cljs.core.uuid(id))),cljs.core.hash_map(cljs.core.keyword('card-repeats'),3,cljs.core.keyword('card-next-schedule'),'2026-10-29T10:00:00.000Z')),cardId);
    await page.waitForTimeout(1800);
    assert.equal(fs.readFileSync(source,'utf8'),content);
    assert.equal(fs.statSync(source).mtimeMs,before);
    assert.equal((await props(id))['query-sort-by'],'updated-at');
    assert.equal((await props(cardId))['card-repeats'],3);
    await setApp(id,'background-color','blue');
    await page.keyboard.press('Meta+z'); await page.waitForTimeout(800);
    assert.equal((await props(id))['background-color'],'red');
    await page.keyboard.press('Meta+Shift+z'); await page.waitForTimeout(800);
    assert.equal((await props(id))['background-color'],'blue');
    assert.equal(await page.evaluate(()=>frontend.modules.file.core.dirty_QMARK_(frontend.state.get_current_repo(),frontend.db.get_file_page('pages/a.md'))),false);
    // Actual task transition creates a clock, but the clock stays out of Markdown.
    await page.evaluate(id=>frontend.handler.editor.save_block_if_changed_BANG_(frontend.db.pull(cljs.core.vector(cljs.core.keyword('block/uuid'),cljs.core.uuid(id))),'DOING task'),taskId);
    await page.waitForTimeout(1800);
    assert.match(await blockContent(taskId),/CLOCK:/);
    assert.match(fs.readFileSync(source,'utf8'),/DOING task/);
    assert.doesNotMatch(fs.readFileSync(source,'utf8'),/LOGBOOK|CLOCK:|card-repeats|background-color|hl-color|template::|logseq.order-list-type/);
    assert.match(fs.readFileSync(source,'utf8'),/query-sort-by:: authored/);
    await app.close(); await launch();
    assert.equal((await props(id))['query-sort-by'],'updated-at');
    assert.equal((await props(cardId))['card-repeats'],3);
    assert.match(await blockContent(taskId),/CLOCK:/);
    // Ordinary editing must not re-inject hidden properties into the source.
    await page.getByText('parent',{exact:true}).click(); await page.locator('textarea:visible').fill('edited parent\nowner:: me');
    await page.keyboard.press('Escape'); await page.waitForTimeout(1800);
    assert.doesNotMatch(fs.readFileSync(source,'utf8'),/card-repeats|query-sort-desc|background-color|LOGBOOK|CLOCK:|hl-color/);
    assert.match(fs.readFileSync(source,'utf8'),/query-sort-by:: authored/);
    assert.equal((await props(id))['query-sort-by'],'updated-at');
    // Explicit public property writes remain authored, even for a built-in key.
    await page.evaluate(id=>frontend.handler.editor.property.set_block_property_BANG_(cljs.core.uuid(id),cljs.core.keyword('query-sort-by'),'manual'),id);
    await page.waitForTimeout(1800);
    assert.match(fs.readFileSync(source,'utf8'),/query-sort-by:: manual/);
    assert.equal((await props(id))['query-sort-by'],'manual');
    assert.doesNotMatch(fs.readFileSync(source,'utf8'),/background-color|card-repeats|query-sort-desc|hl-color|LOGBOOK|CLOCK:/);
    // Code examples with metadata-looking text are authored content.
    const codeFile=path.join(graph,'pages/code.md');
    const codeText='- ```\n  query-sort-by:: example\n  :LOGBOOK:\n  example clock\n  :END:\n  ```';
    fs.writeFileSync(codeFile,codeText);
    await page.waitForFunction(()=>frontend.db.get_file_page('pages/code.md'));
    const codeId=await page.evaluate(()=>String(cljs.core.get(cljs.core.first(frontend.db.get_page_blocks_no_cache(frontend.state.get_current_repo(),frontend.db.get_file_page('pages/code.md'))),cljs.core.keyword('block/uuid'))));
    await setApp(codeId,'background-color','green'); await page.waitForTimeout(1600);
    assert.equal(fs.readFileSync(codeFile,'utf8'),codeText);
    // Repeated task completion keeps its history outside Markdown.
    const repeatFile=path.join(graph,'pages/repeat.md');
    fs.writeFileSync(repeatFile,'- TODO repeat\n  SCHEDULED: <2026-10-28 Wed +1d>');
    await page.waitForFunction(()=>frontend.db.get_file_page('pages/repeat.md'));
    const repeatId=await page.evaluate(()=>String(cljs.core.get(cljs.core.first(frontend.db.get_page_blocks_no_cache(frontend.state.get_current_repo(),frontend.db.get_file_page('pages/repeat.md'))),cljs.core.keyword('block/uuid'))));
    await page.evaluate(id=>frontend.handler.editor.check(frontend.format.block.parse_title_and_body(frontend.db.pull(cljs.core.vector(cljs.core.keyword('block/uuid'),cljs.core.uuid(id))))),repeatId);
    await page.waitForTimeout(1800);
    assert.match(await blockContent(repeatId),/State "DONE"/);
    assert.doesNotMatch(fs.readFileSync(repeatFile,'utf8'),/LOGBOOK|State "DONE"/);
    assert.match(fs.readFileSync(repeatFile,'utf8'),/2026-10-29/);
    // Roam-generated reference IDs use the side store; imported source properties remain.
    await page.evaluate(()=>frontend.handler.external.import_from_roam_json_BANG_(JSON.stringify([{title:'Imported',children:[{uid:'abc123456',string:'target\nowner:: importer'},{uid:'def123456',string:'((abc123456))'}]}]),()=>{}));
    await page.waitForFunction(()=>frontend.db.get_file_page('pages/Imported.md'));
    await page.waitForFunction(root=>window.apis.s01({root,op:'read',relative:'pages/Imported.md'}).value.content!==null,graph);
    const imported=fs.readFileSync(path.join(graph,'pages/Imported.md'),'utf8');
    assert.doesNotMatch(imported,/id::/); assert.match(imported,/owner:: importer/);
    const importProps=await page.evaluate(()=>cljs.core.clj__GT_js(cljs.core.map(b=>cljs.core.get(b,cljs.core.keyword('block/properties')),frontend.db.get_page_blocks_no_cache(frontend.state.get_current_repo(),frontend.db.get_file_page('pages/Imported.md')))));
    assert.ok(importProps.some(p=>p && p.id));
    // Cache rebuilding must not delete feature history.
    fs.unlinkSync(path.join(graph,'logseq/identity.sqlite'));
    await page.waitForTimeout(7500);
    assert.equal((await props(cardId))['card-repeats'],3);
    assert.match(await blockContent(taskId),/CLOCK:/);
    assert.deepEqual(errors,[]);
    console.log('PASS: feature overlays, authored same-name properties, clock source separation, restart and cache recovery');
    console.log('GRAPH',graph);
  } finally {if(app) await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
