// Compiled development app; isolated graph and Electron profile only.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const repo = path.resolve(__dirname, '../../..');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's01-collapsed-'));
  const graph = path.join(root, 'graph');
  fs.mkdirSync(path.join(graph, 'logseq'), {recursive:true});
  fs.mkdirSync(path.join(graph, 'pages'));
  fs.writeFileSync(path.join(graph,'logseq/config.edn'), '{:s01/enabled? true :preferred-format "Markdown"}');
  const source = path.join(graph,'pages/a.md');
  const content = '- parent\r\n  - child\r\n- other\r\n';
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
  const ui = async (id, value) => {
    await page.evaluate(({id,value})=>frontend.handler.editor[value?'collapse_block_BANG_':'expand_block_BANG_'](cljs.core.uuid(id)), {id,value});
    await page.waitForTimeout(1600);
  };
  const collapsed = id => page.evaluate(id=>!!frontend.util.collapsed_QMARK_(frontend.db.entity(cljs.core.vector(cljs.core.keyword('block/uuid'),cljs.core.uuid(id)))),id);
  try {
    await launch();
    const id=await page.locator('.page-blocks-inner .ls-block').first().getAttribute('blockid');
    const before=fs.statSync(source).mtimeMs;
    await ui(id,true); assert.equal(await collapsed(id),true);
    assert.equal(fs.readFileSync(source,'utf8'),content); assert.equal(fs.statSync(source).mtimeMs,before);
    assert.equal(await page.evaluate(()=>frontend.modules.file.core.dirty_QMARK_(frontend.state.get_current_repo(),frontend.db.get_file_page('pages/a.md'))),false);
    await ui(id,false); assert.equal(await collapsed(id),false);
    await page.keyboard.press('Meta+z'); await page.waitForTimeout(1600);
    assert.equal(await collapsed(id),true);
    assert.equal(fs.statSync(source).mtimeMs,before);
    await app.close(); await launch();
    assert.equal(await collapsed(id),true);
    // Simulate a newer UI write than the renderer snapshot, without touching Markdown.
    await page.evaluate(({root,id})=>window.apis.s01({root,op:'save-block-ui',entries:[{id,collapsed:false}]}),{root:graph,id});
    await app.close(); await launch();
    assert.equal(await collapsed(id),false);
    assert.equal(fs.readFileSync(source,'utf8'),content);
    await ui(id,false); await app.close(); await launch();
    assert.equal(await collapsed(id),false);
    await page.getByText('parent',{exact:true}).click(); await page.locator('textarea:visible').fill('edited parent');
    await page.keyboard.press('Escape'); await page.waitForTimeout(1800);
    assert.match(fs.readFileSync(source,'utf8'),/edited parent/);
    assert.doesNotMatch(fs.readFileSync(source,'utf8'),/collapsed::|id::/);
    // Legacy metadata is imported without rewriting, then removed on a real edit.
    const legacy=path.join(graph,'pages/legacy.md');
    const legacyText='- legacy parent\n  collapsed:: true\n  owner:: me\n  - legacy child';
    fs.writeFileSync(legacy,legacyText);
    await page.waitForFunction(()=>frontend.db.get_file_page('pages/legacy.md'));
    await page.evaluate(()=>{location.hash='#/page/'+encodeURIComponent(frontend.db.get_file_page('pages/legacy.md'));});
    await page.getByText('legacy parent',{exact:true}).waitFor();
    const legacyId=await page.locator('.page-blocks-inner .ls-block').first().getAttribute('blockid');
    assert.equal(await collapsed(legacyId),true);
    assert.equal(fs.readFileSync(legacy,'utf8'),legacyText);
    await ui(legacyId,false);
    assert.equal(fs.readFileSync(legacy,'utf8'),legacyText);
    await page.getByText('legacy child',{exact:true}).click(); await page.locator('textarea:visible').fill('changed child');
    await page.keyboard.press('Escape'); await page.waitForTimeout(1800);
    assert.doesNotMatch(fs.readFileSync(legacy,'utf8'),/collapsed::/);
    assert.match(fs.readFileSync(legacy,'utf8'),/owner:: me/);
    // Direct handlers must also respect S01's ban on auto-generated block IDs.
    const beforeGuards=fs.readFileSync(legacy,'utf8');
    await page.evaluate(id=>{
      const block=frontend.db.pull(cljs.core.vector(cljs.core.keyword('block/uuid'),cljs.core.uuid(id)));
      frontend.handler.editor.block_on_chosen_handler(null,'',cljs.core.keyword('markdown'),null)(block,null);
      frontend.handler.dnd.move_blocks({altKey:true},cljs.core.vector(block),block,cljs.core.keyword('top'));
    },legacyId);
    await page.waitForTimeout(1600);
    assert.equal(fs.readFileSync(legacy,'utf8'),beforeGuards);
    assert.deepEqual(errors,[]);
    console.log('PASS: collapse/expand/undo leave Markdown bytes and mtime intact, true/false survive restart, edits omit metadata');
    console.log('GRAPH',graph);
  } finally {if(app) await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
