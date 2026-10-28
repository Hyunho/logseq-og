// Isolate Chromium IME dispatch from Logseq, React, preload scripts and Playwright.
// node ... [--native]: native mode receives only OS keys via the visible textarea.
// Default mode uses Chromium's Input protocol, explicitly NOT an OS IME test.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
if(!process.versions.electron){
 const r=require('node:child_process').spawnSync(require('electron'),[__filename,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
 process.exit(r.status??1);
}else{
 const {app,BrowserWindow}=require('electron');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'s01-ime-origin-'));
 const mode=process.argv.includes('--native')?'native':'protocol';
 app.setPath('userData',path.join(root,'user'));app.setPath('home',root);
 let window;
 app.whenReady().then(async()=>{
  try{
   window=new BrowserWindow({width:800,height:420,webPreferences:{contextIsolation:true,nodeIntegration:false}});
   const html=`<!doctype html><meta charset="utf-8"><title>S01 IME Origin ${mode}</title>
   <h1>S01 IME Origin ${mode}</h1><p>Plain textarea — no Logseq, React, preload or Playwright</p>
   <textarea id="native" aria-label="Native IME probe" autofocus style="font-size:32px;width:90%;height:100px"></textarea>
   <textarea id="control" hidden></textarea><script>
   window.probe={events:[],dispatches:[]};
   const dispatch=EventTarget.prototype.dispatchEvent;
   EventTarget.prototype.dispatchEvent=function(e){if(e.type.startsWith('composition'))probe.dispatches.push({type:e.type,data:e.data,stack:new Error().stack});return dispatch.call(this,e)};
   for(const phase of ['capture','bubble']) for(const type of ['compositionstart','compositionupdate','compositionend'])
    document.addEventListener(type,e=>probe.events.push({phase,type,data:e.data,trusted:e.isTrusted,value:e.target.value,target:e.target.id}),phase==='capture');
   document.getElementById('native').focus();
   </script>`;
   await window.loadURL('data:text/html;base64,'+Buffer.from(html).toString('base64'));window.show();window.focus();
   console.log('PROBE_READY',mode,root);
   if(mode==='protocol'){
    window.webContents.debugger.attach('1.3');
    for(const text of ['ㅎ','하','한','한ㄱ','한그','한글']) await window.webContents.debugger.sendCommand('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});
    await window.webContents.debugger.sendCommand('Input.insertText',{text:'한글'});
   }
   const deadline=Date.now()+180000;
   while(!await window.webContents.executeJavaScript("probe.events.some(e=>e.type==='compositionend'&&e.value==='한글')")){
    assert.ok(Date.now()<deadline,'IME commit timed out');await new Promise(r=>setTimeout(r,100));
   }
   const observed=await window.webContents.executeJavaScript("JSON.parse(JSON.stringify(probe))");
   assert.equal(observed.dispatches.length,0,'IME must bypass JavaScript dispatchEvent');
   for(const phase of ['capture','bubble']){
    assert.ok(observed.events.some(e=>e.phase===phase&&e.type==='compositionstart'&&e.trusted));
    assert.ok(observed.events.some(e=>e.phase===phase&&e.type==='compositionupdate'&&e.trusted));
    assert.ok(observed.events.some(e=>e.phase===phase&&e.type==='compositionend'&&e.value==='한글'));
   }
   const value=await window.webContents.executeJavaScript("document.getElementById('native').value");assert.equal(value,'한글');
   await window.webContents.executeJavaScript("document.getElementById('control').dispatchEvent(new CompositionEvent('compositionend',{data:'positive-control',bubbles:true}))");
   const control=await window.webContents.executeJavaScript("JSON.parse(JSON.stringify(probe))");
   assert.equal(control.dispatches.length,1,'dispatch instrumentation positive control');
   assert.ok(control.events.some(e=>e.target==='control'&&!e.trusted));
   const result={mode,versions:process.versions,os:os.release(),value,observed,positiveControl:control.dispatches,errors:[]};
   fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));
   console.log('PROBE_PASS',JSON.stringify({mode,chrome:process.versions.chrome,endTrusted:observed.events.filter(e=>e.type==='compositionend').map(e=>e.trusted),javascriptDispatches:observed.dispatches.length,result:path.join(root,'result.json')}));
   app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
 });
}
