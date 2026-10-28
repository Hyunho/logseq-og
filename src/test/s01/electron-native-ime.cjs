// MANUAL: raise the uniquely titled test window, click the prepared empty first block, and type 한글.
// Commit composition with Right Arrow. This script checks real composition events and persisted text.
// Run separately from other UI suites; no OS input method settings are changed by the script.
// Run after compiling app/electron and copying resources/js/preload.js to static/js/preload.js.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const repo = path.resolve(__dirname, '../../..');
const nativePrep = process.env.S01_IME_NATIVE_PREP === '1';
(async () => {
 const electronProcesses=require('node:child_process').execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').filter(line=>/\/Electron\.app\/Contents\/MacOS\/Electron(?:\s|$)/.test(line));
 assert.deepEqual(electronProcesses,[],'Close other Electron instances before native IME testing; bundle-id targeting is ambiguous. No processes were terminated.');
 const reopen=process.env.S01_IME_REOPEN_ROOT;
 const root=reopen?fs.realpathSync(reopen):fs.mkdtempSync(path.join(os.tmpdir(),'s01-ui-'));
 if(reopen){assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith('s01-ui-'));assert.ok(fs.existsSync(path.join(root,'native-ime-fixture.json')));}
 const previous=reopen?JSON.parse(fs.readFileSync(path.join(root,'native-ime-result.json'),'utf8')):null;
 const run=1+Math.max(0,...fs.readdirSync(root).map(name=>Number(/^ime-native-window-(\d+)\.jsonl$/.exec(name)?.[1]??0)));
 const traceName=`ime-trace-${run}.jsonl`,nativeName=`ime-native-window-${run}.jsonl`;
 if(!reopen){fs.writeFileSync(path.join(root,'native-ime-fixture.json'),JSON.stringify({purpose:'S01 native IME test'}));
 const graph=path.join(root,'graph'); fs.mkdirSync(path.join(graph,'logseq'),{recursive:true}); fs.mkdirSync(path.join(graph,'pages'));
 fs.writeFileSync(path.join(graph,'logseq/config.edn'),'{:s01/enabled? true :preferred-format "Markdown"}');
 fs.writeFileSync(path.join(graph,'pages/회의.md'),'- 첫 번째\n- 두 번째');}
 const graph=path.join(root,'graph');
 const bootstrap=path.join(root,'bootstrap.cjs');
 fs.writeFileSync(bootstrap,`const {app}=require('electron'); app.setPath('home',${JSON.stringify(root)}); app.setPath('userData',${JSON.stringify(path.join(root,'user'))}); app.setAppPath(${JSON.stringify(path.join(repo,'static'))}); require(${JSON.stringify(path.join(repo,'static/electron.js'))});`);
 const app=await electron.launch({executablePath:require('electron'),cwd:path.join(repo,'static'), args:[bootstrap],timeout:25000});
 let page;const errors=[];
 try {
 page=await app.firstWindow();
 await app.evaluate(({BrowserWindow},root)=>{const fs=process.getBuiltinModule('fs');for(const w of BrowserWindow.getAllWindows()){
 const record=(kind,input)=>fs.appendFileSync(root,JSON.stringify({kind,input,focused:w.isFocused(),visible:w.isVisible(),time:Date.now()})+'\n');
 w.webContents.on('before-input-event',(_event,input)=>record('before-input-event',input));
 for(const kind of ['focus','blur','show','hide'])w.on(kind,()=>record(kind));
 record('initial');
 }},path.join(root,nativeName));
 page.setDefaultTimeout(10000);
 page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message);});
 page.on('console',m=>{if(m.text().startsWith('IME_TRACE '))fs.appendFileSync(path.join(root,traceName),m.text().slice(10)+'\n');if(m.type()==='error'||m.text().startsWith('IME_')) console.log('CONSOLE',m.text().slice(0,800));});
 await page.waitForLoadState('domcontentloaded');
 await page.waitForTimeout(5000);
 await page.evaluate(g=>{ window.__E2E_TESTING__=true;window.__MOCKED_OPEN_DIR_PATH__=g;},graph);
 const choose=page.getByText('Choose a folder',{exact:true});
 if(await choose.count()) {await choose.click();await page.waitForTimeout(8000);}
 await page.evaluate(()=>{location.hash='#/page/'+encodeURIComponent('pages/회의.md');});
 await page.waitForTimeout(2000);

 const initial=await page.locator('.page-blocks-inner .ls-block').first().getAttribute('blockid');
 if(previous)assert.equal(initial,previous.finalId,'ID must survive application restart');
 if(!nativePrep){await page.locator('.page-blocks-inner .ls-block').first().click();await page.locator('textarea:visible').fill('');}
 await page.evaluate(diagnostic=>{
 if(diagnostic){const plain=document.createElement('textarea');plain.id='ime-plain-control';plain.setAttribute('aria-label','IME plain control');plain.style='position:fixed;right:20px;bottom:30px;width:320px;height:80px;z-index:99999;background:white;color:black';document.body.appendChild(plain);}
 for(const name of ['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','focusin','focusout'])document.addEventListener(name,e=>console.log('IME_TRACE '+JSON.stringify({name,key:e.key,code:e.code,keyCode:e.keyCode,data:e.data,inputType:e.inputType,isComposing:e.isComposing,trusted:e.isTrusted,target:e.target.id,value:e.target.value,focus:document.activeElement?.id,documentFocus:document.hasFocus(),time:performance.now()})),true);
 window.__imeEvents=[];window.__imeDispatches=[];
 const originalDispatch=EventTarget.prototype.dispatchEvent;
 EventTarget.prototype.dispatchEvent=function(e){if(e.type.startsWith('composition'))window.__imeDispatches.push({type:e.type,stack:new Error().stack});return originalDispatch.call(this,e);};
 for(const name of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(name,e=>{if(!e.target.id.startsWith('edit-block-'))return;const event={name,data:e.data,trusted:e.isTrusted,value:e.target.value};window.__imeEvents.push(event);console.log('IME_EVENT',JSON.stringify(event));});},!!process.env.S01_IME_DIAGNOSTIC);
 await page.evaluate(title=>{document.title=title;},`S01 Native IME ${path.basename(root)} run ${run}`);
 const readyAt=Date.now();
 console.log('IME_READY',graph,JSON.stringify(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({focused:w.isFocused(),visible:w.isVisible(),minimized:w.isMinimized()})))));
 await page.waitForFunction(()=>window.__imeEvents.at(-1)?.name==='compositionend'&&window.__imeEvents.at(-1)?.value==='한글',null,{timeout:Number(process.env.S01_IME_TIMEOUT_MS??240000)});
 assert.equal(await page.evaluate(()=>frontend.state.editor_in_composition_QMARK_()),false);
 await page.keyboard.press('Escape');
 const source=path.join(graph,'pages/회의.md'),expected='- 한글\n- 두 번째',deadline=Date.now()+10000;
 const readSource=()=>{try{return fs.readFileSync(source,'utf8')}catch(e){if(e.code==='ENOENT')return null;throw e}};
 while(readSource()!==expected&&Date.now()<deadline)await page.waitForTimeout(100);
 assert.equal(fs.readFileSync(source,'utf8'),expected);
 assert.equal(await page.locator('.page-blocks-inner .ls-block').first().getAttribute('blockid'),initial);
 const events=await page.evaluate(()=>window.__imeEvents);
 const nativeEvents=events.filter(e=>e.trusted);
 assert.ok(['compositionstart','compositionupdate'].every(name=>nativeEvents.some(e=>e.name===name)));
 assert.ok(events.some(e=>e.name==='compositionend'&&e.value==='한글'));
 const javascriptDispatches=await page.evaluate(()=>window.__imeDispatches);
 assert.deepEqual(javascriptDispatches,[]);
 const versions=await app.evaluate(()=>process.versions);
 const nativeWindow=fs.readFileSync(path.join(root,nativeName),'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.time>=readyAt);
 const letterKeys=nativeWindow.filter(e=>e.kind==='before-input-event'&&e.input.type==='keyUp'&&/^Key[GKSRMF]$/.test(e.input.code));
 assert.ok(letterKeys.length>=6,'Native keys must reach this exact Electron process');
 assert.ok(letterKeys.every(e=>e.focused),'Native input must target the foreground test window');
 const evidence={graph,run,inputActor:process.env.S01_IME_ACTOR??'unspecified',reopened:!!reopen,prepareMode:nativePrep?'native':'empty-fixture',pid:app.process().pid,electronProcessesBefore:electronProcesses,nativeWindow,checks:{compositionReleased:true,exactMarkdown:true,idStable:true,restartIdStable:previous?true:null,noJavascriptCompositionDispatch:true,nativeKeysInFocusedProcess:true},versions,javascriptDispatches,events,initialId:initial,finalId:await page.locator('.page-blocks-inner .ls-block').first().getAttribute('blockid'),content:fs.readFileSync(path.join(graph,'pages/회의.md'),'utf8'),errors};
 fs.writeFileSync(path.join(root,'native-ime-result.json'),JSON.stringify(evidence,null,2));
 fs.writeFileSync(path.join(root,`native-ime-result-${run}.json`),JSON.stringify(evidence,null,2));
 await page.screenshot({path:path.join(root,`native-ime-result-${run}.png`)});
 console.log('PASS_NATIVE_IME',JSON.stringify(evidence));assert.deepEqual(errors,[]);
 await page.waitForTimeout(2000);
 }catch(error){
 const observed=page?await page.evaluate(()=>({events:window.__imeEvents??[],javascriptDispatches:window.__imeDispatches??[],values:[...document.querySelectorAll('textarea')].map(e=>e.value)})).catch(()=>null):null;
 fs.writeFileSync(path.join(root,`native-ime-failure-${run}.json`),JSON.stringify({graph,error:String(error),observed,errors},null,2));
 throw error;
 }finally{
 // Test fixtures only: bypass the product's before-quit UI, and bound cleanup even on a hung main process.
 const shutdown=setTimeout(()=>app.process().kill('SIGKILL'),5000);
 try{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close();}finally{clearTimeout(shutdown);}
 }
})().catch(e=>{console.error(e);process.exitCode=1});
