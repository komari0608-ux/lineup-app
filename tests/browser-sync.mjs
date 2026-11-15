// Runs the production editor and Firebase SDK in two isolated browser contexts.
// Only the test HTTP server rewrites configuration to LOCAL emulators. Never deploy it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../',import.meta.url));
const runtime = process.env.LINEUP_RULES_TEST_PACKAGE;
const require = createRequire(runtime || new URL('../package.json',import.meta.url));
const { chromium } = require(process.env.LINEUP_PLAYWRIGHT || 'playwright');
const firebaseDir = path.dirname(require.resolve('firebase/package.json'));
const firestore = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if(!/^127\.0\.0\.1:\d+$/.test(firestore || '') || !/^127\.0\.0\.1:\d+$/.test(authHost || '')) throw new Error('Local emulator hosts are required.');
const projectId='demo-lineup-cloud-test';
const email=`browser-${Date.now()}@example.invalid`, password='emulator-only-password';
const signup=await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=test-key`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})
});
assert.equal(signup.status,200,await signup.text());
const server=createServer(async (req,res) => {
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/__/firebase/init.json'){
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({projectId,apiKey:'test-key',authDomain:'localhost',appId:'test-app'})); return;
    }
    const name=url.pathname==='/' ? 'index.html' : url.pathname.slice(1);
    const resolved=path.resolve(root,name);
    if(!resolved.startsWith(root)) throw new Error('Invalid test file');
    let data=await readFile(resolved);
    if(name==='index.html') data=Buffer.from(data.toString().replace("['lineup-app-b4f4e.web.app','lineup-app-b4f4e.firebaseapp.com']","['127.0.0.1']"));
    if(name==='cloud-sync.mjs') data=Buffer.from(data.toString()
      .replace("config.projectId !== 'lineup-app-b4f4e'",`config.projectId !== '${projectId}'`)
      .replace('const auth = authSdk.getAuth(app);',`const auth = authSdk.getAuth(app);
        authSdk.connectAuthEmulator(auth,'http://${authHost}',{disableWarnings:true});
        window.testSignIn = () => authSdk.signInWithEmailAndPassword(auth,${JSON.stringify(email)},${JSON.stringify(password)});`)
      .replace('const db = dbSdk.getFirestore(app);',`const db = dbSdk.getFirestore(app);
        dbSdk.connectFirestoreEmulator(db,'127.0.0.1',${Number(firestore.split(':')[1])});`)
      .replace('const sync = new WorkspaceSync({ ...options, adapter });','const sync = new WorkspaceSync({ ...options, adapter }); window.testSync = sync;'));
    const ext=path.extname(name);
    res.setHeader('Content-Type',ext==='.html' ? 'text/html; charset=utf-8' : ['.js','.mjs'].includes(ext) ? 'text/javascript' : ext==='.png' ? 'image/png' : 'application/octet-stream');
    res.setHeader('Cache-Control','no-store'); res.end(data);
  }catch(error){res.writeHead(404);res.end(String(error));}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.LINEUP_BROWSER ? {executablePath:process.env.LINEUP_BROWSER} : {})});
const errors=[];
const contexts=[];
const storageKey='lineupPlannerV10OrderInlineGame';
const report=[];
const log=message => { report.push(message); console.log('PASS',message); };
async function context(viewport,storageState){
  const ctx=await browser.newContext({viewport,storageState,reducedMotion:'reduce'}); contexts.push(ctx);
  await ctx.route('https://www.gstatic.com/firebasejs/13.2.0/**',async route => {
    const name=new URL(route.request().url()).pathname.split('/').pop();
    await route.fulfill({status:200,contentType:'text/javascript',body:await readFile(path.join(firebaseDir,name))});
  });
  await ctx.route('https://fonts.googleapis.com/**',route => route.fulfill({status:200,contentType:'text/css',body:''}));
  await ctx.addInitScript(() => {
    sessionStorage.setItem('lineupSplashSeen','1');
    if(localStorage.getItem('lineupCloudEnabled')===null) localStorage.setItem('lineupCloudEnabled','1');
  });
  return ctx;
}
async function page(ctx){
  const p=await ctx.newPage(); p.on('pageerror',error => errors.push(String(error)));
  await p.goto(origin); await p.waitForFunction(() => !!window.testSync,{},{timeout:30000}); return p;
}
const read=p => p.evaluate(key => JSON.parse(localStorage.getItem(key)),storageKey);
const settled=p => p.waitForFunction(() => window.testSync?.status==='synced',null,{timeout:15000});
async function match(p,fn,arg){await p.waitForFunction(({key,source,arg}) => new Function('state','arg',`return (${source})(state,arg)`)(JSON.parse(localStorage.getItem(key)),arg),{key:storageKey,source:fn.toString(),arg},{timeout:15000});}
async function inning(p,i){await p.getByRole('button',{name:i ? `${i}回` : '初期',exact:true}).click();}
async function swap(p,a,b){
  await p.locator('#orderList .defense-card').nth(a).locator('.pos-chip').first().click();
  await p.locator('#orderList .defense-card').nth(b).locator('.pos-chip').first().click();
}
async function settings(p,field,value){
  await p.locator('#settingsBtn').click(); await p.locator(`#${field}`).fill(value); await p.locator('#settingsDoneBtn').click();
}
try{
  const desktop=await context({width:1440,height:1000});
  let mobile=await context({width:390,height:844});
  const pc=await page(desktop); let phone=await page(mobile);
  await pc.locator('#settingsBtn').click(); await pc.locator('#battingMode').selectOption('nine'); await pc.locator('#settingsDoneBtn').click();
  await pc.evaluate(() => window.testSignIn()); await settled(pc);
  await phone.evaluate(() => window.testSignIn()); await settled(phone);
  await match(phone,s => s.battingMode==='nine');
  log('Initial same-account connection downloads existing lineup without replacing it');

  await inning(pc,3); await match(phone,s => s.selectedInning===3);
  await pc.locator('.bench-wrap > summary').click();
  await pc.locator('#orderList .player-name').nth(0).click(); await pc.locator('#benchList .bench-chip').filter({hasText:'ゆうと'}).click();
  await match(phone,s => s.lineupByInning[3][0]==='p10'); await settled(pc); await settled(phone);
  await swap(phone,2,3); await match(pc,s => s.defenseChanges.p3?.[3]==='2'); await settled(phone); await settled(pc);
  log('PC substitution and phone defense swap automatically arrive on the other device');

  await inning(phone,5); await match(pc,s => s.selectedInning===5);
  await phone.locator('.bench-wrap > summary').click();
  await phone.locator('#orderList .player-name').nth(0).click(); await phone.locator('#benchList .bench-chip').filter({hasText:'はると'}).click();
  await match(pc,s => s.lineupByInning[5][0]==='p1');
  const history=await read(pc);
  for(const i of [2,3,5,1,5]){
    await inning(pc,i); await match(phone,(s,i) => s.selectedInning===i,i);
    const label=i===3 ? 'ゆうと' : 'はると';
    assert.match(await phone.locator('#orderList .player-name').nth(0).innerText(),new RegExp(label));
  }
  const after=await read(pc);
  assert.deepEqual(after.lineupByInning,history.lineupByInning); assert.deepEqual(after.defenseChanges,history.defenseChanges);
  log('Rewind, advance, repeated substitutions and re-entry preserve every inning');

  await Promise.all([settings(pc,'gamePlace','PC球場'),settings(phone,'gameOpponent','スマホ対戦相手')]);
  await match(pc,s => s.game.opponent==='スマホ対戦相手'); await match(phone,s => s.game.place==='PC球場');
  await settled(pc); await settled(phone);
  log('Concurrent independent edits merge and both devices converge');

  await pc.locator('[data-tab="players"]').click();
  const nick=pc.locator('#playerPanel .nick-input').first(); await nick.fill('編集中の選手名');
  const element=await nick.elementHandle();
  await settings(phone,'gamePlace','入力中に届いた球場');
  await new Promise(resolve => setTimeout(resolve,600));
  assert.equal(await element.evaluate(el => el===document.activeElement),true);
  assert.equal(await nick.inputValue(),'編集中の選手名');
  await pc.locator('[data-tab="order"]').click();
  await match(pc,s => s.game.place==='入力中に届いた球場'); await match(phone,s => s.players[0].nickname==='編集中の選手名');
  log('Remote changes preserve focused input, typed text and caret; merge after editing');

  await settled(pc); await settled(phone);
  await mobile.setOffline(true);
  await settings(phone,'gameOpponent','オフライン編集');
  await settings(pc,'gamePlace','オンライン編集'); await settled(pc);
  await mobile.setOffline(false);
  await match(pc,s => s.game.opponent==='オフライン編集'); await match(phone,s => s.game.place==='オンライン編集');
  await settled(pc); await settled(phone);
  log('Offline changes and online changes automatically merge on reconnect');

  await pc.reload(); await settled(pc);
  await mobile.setOffline(true);
  await settings(phone,'gameOpponent','再起動前の未送信編集');
  const savedStorage=await mobile.storageState({indexedDB:true}); await mobile.close();
  await settings(pc,'gamePlace','再起動中のPC編集'); await settled(pc);
  mobile=await context({width:390,height:844},savedStorage); phone=await page(mobile); await settled(phone);
  await match(pc,s => s.game.opponent==='再起動前の未送信編集');
  await match(phone,s => s.game.place==='再起動中のPC編集');
  await inning(phone,4); await match(pc,s => s.selectedInning===4);
  log('Reload/new browser restores login, unsent offline edits and sync without another share action');

  await settled(pc); await settled(phone);
  await Promise.all([desktop.setOffline(true),mobile.setOffline(true)]);
  await Promise.all([swap(pc,4,5),swap(phone,6,7)]);
  await match(pc,s => s.defenseChanges.p5?.[4]==='3'); await match(phone,s => s.defenseChanges.p7?.[4]==='7');
  await Promise.all([desktop.setOffline(false),mobile.setOffline(false)]);
  for(const p of [pc,phone]) await match(p,s => s.defenseChanges.p5?.[4]==='3' && s.defenseChanges.p7?.[4]==='7');
  await settled(pc); await settled(phone);
  log('Concurrent defense swaps merge via real Firestore transactions without duplicate positions');

  await Promise.all([desktop.setOffline(true),mobile.setOffline(true)]);
  for(const p of [pc,phone]) if(!await p.locator('.bench-wrap').evaluate(el => el.open)) await p.locator('.bench-wrap > summary').click();
  await pc.locator('#orderList .player-name').nth(0).click(); await pc.locator('#benchList .bench-chip').filter({hasText:'編集中の選手名'}).click();
  await phone.locator('#orderList .player-name').nth(1).click(); await phone.locator('#benchList .bench-chip').filter({hasText:'編集中の選手名'}).click();
  await match(pc,s => s.lineupByInning[4][0]==='p1'); await match(phone,s => s.lineupByInning[4][1]==='p1');
  await desktop.setOffline(false); await settled(pc); await mobile.setOffline(false);
  await phone.waitForFunction(() => window.testSync.status==='conflict');
  assert.equal((await read(phone)).lineupByInning[4][1],'p1');
  assert.equal((await read(pc)).lineupByInning[4][0],'p1');
  await phone.locator('#settingsBtn').click(); await phone.locator('#cloudUseRemoteBtn').click(); await phone.locator('#settingsDoneBtn').click();
  await settled(phone);
  const recovery=await phone.evaluate(() => JSON.parse(localStorage.getItem('lineupWorkspaceRecovery')));
  assert.equal(recovery[0].payload.state.lineupByInning[4][1],'p1');
  log('Incompatible substitutions preserve both versions and create a recovery backup on resolution');

  await pc.locator('#saveBtn').click();
  await phone.waitForFunction(() => JSON.parse(localStorage.getItem('lineupPlannerSavedOrders') || '[]').length===1);
  await settled(pc); await settled(phone);
  log('Saved match records also synchronize automatically');

  await settled(pc); await settled(phone);
  const revisions=await Promise.all([pc.evaluate(() => testSync.meta.revision),phone.evaluate(() => testSync.meta.revision)]);
  await new Promise(resolve => setTimeout(resolve,1000));
  assert.deepEqual(await Promise.all([pc.evaluate(() => testSync.meta.revision),phone.evaluate(() => testSync.meta.revision)]),revisions);
  log('Idle synchronization creates no repeated writes or update loop');

  await pc.locator('#settingsBtn').click(); await pc.locator('#themeMode').selectOption('dark'); await pc.locator('#settingsDoneBtn').click();
  await phone.locator('#settingsBtn').click(); await phone.locator('#themeMode').selectOption('light'); await phone.locator('#settingsDoneBtn').click();
  await new Promise(resolve => setTimeout(resolve,600));
  assert.deepEqual(await Promise.all([pc.evaluate(() => testSync.meta.revision),phone.evaluate(() => testSync.meta.revision)]),revisions);
  await settings(phone,'gamePlace','テーマ保持の同期確認'); await match(pc,s=>s.game.place==='テーマ保持の同期確認');
  assert.equal(await pc.locator('html').getAttribute('data-theme'),'dark');
  assert.equal(await phone.locator('html').getAttribute('data-theme'),'light');
  await pc.reload(); await settled(pc); assert.equal(await pc.locator('html').getAttribute('data-theme'),'dark');
  log('Dark/light preferences stay device-local through remote edits and reload, without theme-only writes');

  await pc.locator('#newGameBtn').click(); assert.equal(await pc.locator('#newGameModal').isVisible(),true);
  const beforeChoice=await read(pc);
  await settings(phone,'gameOpponent','確認中に届いた変更'); await settled(phone);
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal((await read(pc)).game.opponent,beforeChoice.game.opponent);
  await pc.locator('#newGameCancelBtn').click(); await match(pc,s=>s.game.opponent==='確認中に届いた変更');
  await pc.locator('#newGameBtn').click(); await pc.locator('#newGameSaveBtn').click();
  await phone.waitForFunction(()=>JSON.parse(localStorage.getItem('lineupPlannerSavedOrders') || '[]').length===2);
  await match(phone,s=>s.game.opponent==='' && s.game.place==='' && s.game.start==='' && s.game.limit==='' && s.game.format==='時間制' && s.game.innings===6 && s.selectedInning===0 && Object.keys(s.defenseChanges).length===0);
  await pc.locator('#settingsDoneBtn').click();
  await settled(pc); await settled(phone);
  assert.equal(await pc.locator('html').getAttribute('data-theme'),'dark'); assert.equal(await phone.locator('html').getAttribute('data-theme'),'light');
  log('Remote edits wait during the new-game choice; saved record and new game then sync automatically to the other device');

  for(const p of [pc,phone]) assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  const out=process.env.LINEUP_SCREENSHOTS;
  if(out){await mkdir(out,{recursive:true}); await pc.screenshot({path:path.join(out,'desktop.png'),fullPage:true}); await phone.screenshot({path:path.join(out,'mobile.png'),fullPage:true});}
  assert.deepEqual(errors,[]);
  log('Desktop/mobile layout fits the viewport; no browser JavaScript errors');
  console.log(JSON.stringify({passed:report.length,tests:report},null,2));
}catch(error){
  for(const [index,ctx] of contexts.entries()) for(const p of ctx.pages()){
    if(process.env.LINEUP_SCREENSHOTS){
      await mkdir(process.env.LINEUP_SCREENSHOTS,{recursive:true});
      await p.screenshot({path:path.join(process.env.LINEUP_SCREENSHOTS,`failure-${index}.png`),fullPage:true});
    }
    console.error('Browser state',await p.evaluate(() => ({state:JSON.parse(localStorage.getItem('lineupPlannerV10OrderInlineGame')),status:window.testSync?.status,active:document.activeElement?.tagName,player:JSON.parse(localStorage.getItem('lineupPlannerV10OrderInlineGame'))?.players[0]})),errors);
  }
  throw error;
}finally{
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
