// UI regression tests against the unchanged production HTML. No cloud writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LINEUP_PLAYWRIGHT || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const server=createServer(async(req,res) => {
  try{
    const name=new URL(req.url,'http://localhost').pathname.slice(1) || 'index.html';
    const file=path.resolve(root,name);
    if(!file.startsWith(root)) throw new Error('Invalid path');
    res.setHeader('Content-Type',name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
    res.setHeader('Cache-Control','no-store'); res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.LINEUP_BROWSER ? {executablePath:process.env.LINEUP_BROWSER} : {})});
const errors=[], report=[], storageKey='lineupPlannerV10OrderInlineGame';
const read=p => p.evaluate(key => JSON.parse(localStorage.getItem(key)),storageKey);
const records=p => p.evaluate(() => JSON.parse(localStorage.getItem('lineupPlannerSavedOrders') || '[]'));
const log=message => { report.push(message); console.log('PASS',message); };
async function theme(p,value){await p.locator('#settingsBtn').click(); await p.locator('#themeMode').selectOption(value); await p.locator('#settingsDoneBtn').click();}
async function edit(p,field,value){await p.locator('#settingsBtn').click(); await p.locator(`#${field}`).fill(value); await p.locator('#settingsDoneBtn').click();}
async function contrast(p,selectors){
  const results=await p.locator(selectors).evaluateAll(elements => {
    const rgb=text => (text.match(/[\d.]+/g) || []).map(Number);
    const blend=(fg,bg) => {const a=fg[3] ?? 1;return fg.slice(0,3).map((v,i)=>v*a+bg[i]*(1-a));};
    const background=el => {const c=rgb(getComputedStyle(el).backgroundColor);return blend(c,el.parentElement ? background(el.parentElement) : [255,255,255]);};
    const lum=c => c.map(v => v/255).map(v => v<=.04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    return elements.filter(el => el.getClientRects().length && !el.disabled && getComputedStyle(el).visibility!=='hidden').map(el => {
      const bg=background(el),fg=blend(rgb(getComputedStyle(el).color),bg),a=lum(fg),b=lum(bg);
      return {element:el.id || el.className,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
    });
  });
  assert.deepEqual(results.filter(item=>item.ratio<4.5),[],'Readable text contrast (4.5:1)');
}
try{
  for(const [label,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
    const ctx=await browser.newContext({viewport,reducedMotion:'reduce',colorScheme:'light'});
    await ctx.route('https://fonts.googleapis.com/**',r=>r.fulfill({contentType:'text/css',body:''}));
    await ctx.addInitScript(()=>sessionStorage.setItem('lineupSplashSeen','1'));
    const p=await ctx.newPage(); p.on('pageerror',e=>errors.push(String(e)));
    await p.goto(origin);
    const base=await read(p);
    await p.locator('#newGameBtn').click();
    assert.equal(await p.locator('#newGameModal').isVisible(),false);
    assert.equal(await p.locator('#settingsModal').isVisible(),true);
    assert.equal(await p.locator('#settingsTitle').innerText(),'新規作成・試合設定');
    await p.locator('#gameOpponent').fill('保存テスト'); await p.locator('#settingsDoneBtn').click();
    const draft=await read(p);
    await p.locator('#newGameBtn').click(); assert.equal(await p.locator('#newGameModal').isVisible(),true);
    await p.keyboard.press('Shift+Tab'); assert.equal(await p.locator('#newGameCancelBtn').evaluate(el=>el===document.activeElement),true);
    await p.keyboard.press('Escape'); assert.deepEqual(await read(p),draft);
    log(`${label}: fresh new game opens settings; unsaved draft can cancel without changing data`);

    await p.locator('#newGameBtn').click(); await p.locator('#newGameSaveBtn').click();
    let saved=await records(p); assert.equal(saved.length,1); assert.equal(saved[0].state.game.opponent,'保存テスト');
    assert.equal((await read(p)).game.opponent,''); assert.deepEqual((await read(p)).players,base.players);
    await p.locator('#settingsDoneBtn').click();
    await theme(p,'dark');
    await p.locator('[data-tab="history"]').click();
    await p.locator('.history-summary').first().click();
    await contrast(p,'.history-summary,.history-title,.history-meta,.history-actions button,.history-pos,.history-number-badge');
    await p.locator('[data-history-action="load"]').first().click();
    assert.equal(await p.locator('html').getAttribute('data-theme'),'dark');
    await p.getByRole('button',{name:'3回',exact:true}).click();
    await contrast(p,'#orderResetDefenseBtn,#newGameBtn,.inning-btn,.player-card,.pos-chip,.coach-cell,.coach-number-badge,#coachShareBtn');
    if(process.env.LINEUP_SCREENSHOTS){
      await mkdir(process.env.LINEUP_SCREENSHOTS,{recursive:true});
      await p.screenshot({path:path.join(process.env.LINEUP_SCREENSHOTS,`${label}-dark-inning.png`),fullPage:true});
    }
    await p.locator('#newGameBtn').click();
    assert.equal(await p.locator('#newGameModal').isVisible(),false);
    assert.equal((await records(p)).length,1);
    await p.locator('#settingsDoneBtn').click();
    log(`${label}: save-and-create keeps the record; unchanged saved game skips the prompt even after navigation/theme changes`);

    await p.locator('[data-tab="history"]').click(); await p.locator('.history-summary').first().click();
    await p.locator('[data-history-action="load"]').first().click();
    await p.getByRole('button',{name:'3回',exact:true}).click();
    await p.locator('#orderList .defense-card').nth(0).locator('.pos-chip').first().click();
    await p.locator('#orderList .defense-card').nth(1).locator('.pos-chip').first().click();
    await p.waitForFunction(key=>Object.keys(JSON.parse(localStorage.getItem(key)).defenseChanges).length>0,storageKey);
    await p.locator('#newGameBtn').click(); await p.locator('#newGameSaveBtn').click();
    saved=await records(p); assert.equal(saved.length,1); assert.ok(Object.keys(saved[0].state.defenseChanges).length>0);
    assert.equal(Object.keys((await read(p)).defenseChanges).length,0);
    await p.locator('#settingsDoneBtn').click();
    log(`${label}: save-and-create updates the linked match and starts without its substitution history`);

    await edit(p,'gameOpponent','破棄する変更');
    const historyBefore=await records(p);
    await p.locator('#newGameBtn').click(); await contrast(p,'#newGameTitle,#newGameNote,#newGameSummary,.save-choice-actions button');
    await p.locator('#newGameDiscardBtn').click(); await p.locator('#settingsDoneBtn').click();
    assert.deepEqual(await records(p),historyBefore); assert.equal((await read(p)).game.opponent,'');
    await p.reload(); await p.locator('#newGameBtn').click();
    assert.equal(await p.locator('#newGameModal').isVisible(),false);
    await p.locator('#settingsDoneBtn').click();
    log(`${label}: discard creates no record; clean new draft stays clean after reload`);

    await edit(p,'gameOpponent','保存失敗でも残す');
    const protectedDraft=await read(p);
    await p.locator('#newGameBtn').click();
    await p.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='lineupPlannerSavedOrders') throw new DOMException('full','QuotaExceededError');return window.originalSetItem.call(this,key,value);};});
    await p.locator('#newGameSaveBtn').click();
    assert.equal(await p.locator('#newGameError').isVisible(),true); assert.deepEqual(await read(p),protectedDraft);
    assert.deepEqual(await records(p),historyBefore);
    await p.evaluate(()=>{Storage.prototype.setItem=function(key,value){if(key==='lineupPlannerV10OrderInlineGame') throw new DOMException('full','QuotaExceededError');return window.originalSetItem.call(this,key,value);};});
    await p.locator('#newGameDiscardBtn').click(); assert.deepEqual(await read(p),protectedDraft);
    await p.evaluate(()=>{Storage.prototype.setItem=window.originalSetItem;});
    await p.locator('#newGameCancelBtn').click();
    log(`${label}: simulated storage failures keep both current draft and saved records intact`);

    for(const tab of ['players','history','order']){
      await p.locator(`[data-tab="${tab}"]`).click();
      assert.equal(await p.locator('html').getAttribute('data-theme'),'dark');
      assert.equal(await p.locator('#newGameBtn').isVisible(),tab==='order');
      await contrast(p,'.nav-btn.active,.player-row input,.add-row button,.history-summary,.sync-status');
    }
    await p.locator('#settingsBtn').click(); await p.locator('#gameDateBtn').click();
    await contrast(p,'.settings-section h3,.setting-field,select,input:not([type="hidden"]),.calendar-day,.calendar-nav,.settings-actions button,.sync-actions button');
    if(process.env.LINEUP_SCREENSHOTS){
      await mkdir(process.env.LINEUP_SCREENSHOTS,{recursive:true});
      await p.screenshot({path:path.join(process.env.LINEUP_SCREENSHOTS,`${label}-dark-settings.png`)});
    }
    await p.locator('#settingsDoneBtn').click();
    if(process.env.LINEUP_SCREENSHOTS) await p.screenshot({path:path.join(process.env.LINEUP_SCREENSHOTS,`${label}-dark-order.png`),fullPage:true});
    await p.reload(); assert.equal(await p.locator('html').getAttribute('data-theme'),'dark');
    await ctx.setOffline(true); await p.locator('[data-tab="players"]').click();
    assert.equal(await p.locator('html').getAttribute('data-theme'),'dark'); await ctx.setOffline(false);
    await theme(p,'light'); await p.reload(); assert.equal(await p.locator('html').getAttribute('data-theme'),'light');
    if(label==='mobile') await p.setViewportSize({width:320,height:740});
    await p.locator('[data-tab="order"]').click();
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const box=await p.locator('#newGameBtn').boundingBox(); assert.ok(box.height>=44 && box.x>=0 && box.x+box.width<=(label==='mobile'?320:1440));
    log(`${label}: dark contrast, every tab, reload/offline persistence and explicit Light switch pass; new button fits the viewport`);
    await ctx.close();
  }
  assert.deepEqual(errors,[]); console.log(JSON.stringify({passed:report.length,tests:report},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
