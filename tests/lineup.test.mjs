import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { WorkspaceSync, canonical, validateWorkspace } from '../cloud-sync.mjs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const mainScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
export function editor(){
  const storage = new Map();
  const node = { textContent:'', classList:{ toggle(){} }, hidden:false };
  const context = { console, setTimeout, clearTimeout, TextEncoder,
    localStorage:{ getItem:key => storage.get(key) ?? null, setItem:(key,value) => storage.set(key,String(value)) },
    document:{ getElementById:() => node }, window:{ matchMedia:() => ({ matches:false }) }
  };
  vm.createContext(context);
  const source = mainScript.replace(/  setupStartupSplash\(\);[\s\S]*?\n\}\)\(\);\s*$/, `
    render = () => {}; renderHistory = () => {}; renderCoachPreview = () => {};
    showToast = () => {}; startTapFeedback = () => {};
    startSwapAnimation = ({commit}) => commit();
    thisUnused();
  })();`.replace('thisUnused();', `globalThis.api = {
      createDefaultState, normalizeState, ensureStructures, buildCoachPlan, buildCompactCoachTable, buildSimpleShareTextForState,
      handlePlayerTap, handleDefenseTap, substituteNineMode, getLineupAt, effectivePosition,
      saveState, loadState, saveSavedOrders, loadSavedOrders, workspacePayload,
      createOrderImageBlob,
      set:st => { state = normalizeState(st); selectedSwapId = null; selectedDefense = null; },
      get:() => state,
      selected:inning => { state.selectedInning = inning; selectedSwapId = null; selectedDefense = null; }
    };`));
  vm.runInContext(source, context);
  return { api:context.api, context, storage };
}

function nine(){
  const { api } = editor();
  const st = api.createDefaultState();
  st.battingMode = 'nine'; st.game.innings = 6;
  api.set(st);
  return api;
}

test('initial tap swaps batting order with player defense; inning taps cannot swap active batters', () => {
  const api = nine();
  const pos1 = api.effectivePosition('p1',1), pos2 = api.effectivePosition('p2',1);
  api.handlePlayerTap('p1'); api.handlePlayerTap('p2');
  assert.equal(api.getLineupAt(1)[0],'p2');
  assert.equal(api.effectivePosition('p1',1),pos1); assert.equal(api.effectivePosition('p2',1),pos2);
  api.selected(3);
  const before = [...api.getLineupAt(3)];
  api.handlePlayerTap('p1'); api.handlePlayerTap('p2');
  assert.deepEqual([...api.getLineupAt(3)],before);
});

test('defense chips swap only from the selected inning; bench substitution retains batting slot', () => {
  const api = nine(); api.selected(3);
  const before1 = api.effectivePosition('p1',2), before2 = api.effectivePosition('p2',2);
  api.handleDefenseTap('p1'); api.handleDefenseTap('p2');
  assert.equal(api.effectivePosition('p1',3),before2);
  assert.equal(api.effectivePosition('p2',3),before1);
  assert.equal(api.effectivePosition('p1',2),before1);
  api.handlePlayerTap('p1'); api.handlePlayerTap('p10');
  assert.equal(api.getLineupAt(3)[0],'p10');
  assert.equal(api.getLineupAt(2)[0],'p1');
});

test('multiple replacements and re-entry stay under one of nine batting slots', () => {
  const api = nine();
  api.substituteNineMode('p1','p10',3);
  api.substituteNineMode('p10','p1',5);
  const plan = api.buildCoachPlan(api.get());
  assert.equal(plan.slots.length,9);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.slots[0].segments.map(s => [s.id,s.start,s.end]))),[['p1',1,2],['p10',3,4],['p1',5,6]]);
  const text = api.buildSimpleShareTextForState(api.get());
  assert.match(text,/1番 はると　初期：三 \/ 想定1：交代 \/ 想定2：三/);
  assert.match(text,/→ ゆうと　想定1：三 \/ 想定2：交代/);
  assert.doesNotMatch(text,/10番/);
  assert.doesNotMatch(text,/回|メモ/);
  const table = api.buildCompactCoachTable(api.get());
  assert.deepEqual(Array.from(table.columns, c => c.label), ['初期','想定1','想定2']);
  assert.deepEqual(Array.from(table.columns, c => c.inning), [1,3,5]);
  assert.equal(table.rows.length,10);
  assert.deepEqual(Array.from(table.rows.filter(r => r.slot === 1), r => [r.id,r.order]), [['p1',1],['p10',null]]);
  assert.deepEqual(Array.from(table.rows[0].cells, c => c.kind), ['start','exit','change']);
  assert.deepEqual(Array.from(table.rows[1].cells, c => c.kind), ['empty','change','exit']);
});

test('all-batting defense changes retain all batters and never imply leaving the batting order', () => {
  const {api} = editor(); api.selected(3);
  api.handlePlayerTap('p1'); api.handlePlayerTap('p10');
  const plan = api.buildCoachPlan(api.get());
  assert.equal(plan.slots.length,10);
  assert.ok(plan.slots.every(slot => slot.segments.length === 1));
  const text = api.buildSimpleShareTextForState(api.get());
  assert.match(text,/全員打ち：ベンチの選手も打順/);
  assert.match(text,/10番 ゆうと　初期：ベ \/ 想定1：三/);
  assert.ok(api.buildCompactCoachTable(api.get()).rows.every(row => !row.substitute));
});

test('only actual changes create share columns; unchanged positions remain readable', () => {
  const api = nine();
  api.get().defenseChanges.p1 = {2:api.effectivePosition('p1',1)};
  assert.deepEqual(Array.from(api.buildCompactCoachTable(api.get()).columns, c => c.label), ['初期']);
  api.selected(4); api.handleDefenseTap('p1'); api.handleDefenseTap('p2');
  const table = api.buildCompactCoachTable(api.get());
  assert.deepEqual(Array.from(table.columns, c => c.label), ['初期','想定1']);
  assert.equal(table.columns[1].inning,4);
  assert.equal(table.rows[0].cells[1].kind,'change');
  assert.equal(table.rows[2].cells[1].text,'―');
  assert.equal(table.unused[0].id,'p10');
  assert.doesNotMatch(api.buildSimpleShareTextForState(api.get()),/10番/);
});

test('first-inning selection stays separate from initial batting-order editing after reload', () => {
  const api = nine();
  api.substituteNineMode('p1','p10',3);
  const saved = JSON.parse(JSON.stringify(api.get())); saved.selectedInning = 1;
  api.set(saved);
  assert.equal(api.get().selectedInning,1);
  const before = [...api.getLineupAt(1)];
  api.handlePlayerTap('p1'); api.handlePlayerTap('p2');
  assert.deepEqual([...api.getLineupAt(1)],before);
  assert.equal(api.getLineupAt(3)[0],'p10');
  assert.equal(api.getLineupAt(2)[0],'p1');
});

test('fifth and ninth innings remain editable while shared scenarios are consecutive', () => {
  const api = nine();
  api.get().game.innings = 9; api.ensureStructures();
  api.selected(5); api.handleDefenseTap('p1'); api.handleDefenseTap('p2');
  const fifthPosition = api.effectivePosition('p1',5);
  api.selected(9); api.handleDefenseTap('p1'); api.handleDefenseTap('p2');
  assert.equal(api.effectivePosition('p1',8),fifthPosition);
  assert.notEqual(api.effectivePosition('p1',9),fifthPosition);
  api.saveState(); api.set(api.loadState());
  assert.equal(api.get().selectedInning,9);
  assert.equal(api.get().game.innings,9);
  const table = api.buildCompactCoachTable(api.get());
  assert.deepEqual(Array.from(table.columns, c => [c.inning,c.label]), [[1,'初期'],[5,'想定1'],[9,'想定2']]);
  assert.doesNotMatch(api.buildSimpleShareTextForState(api.get()),/[1-9]回/);
});

test('absent players are excluded and share output does not depend on the selected inning', () => {
  const api = nine(); api.get().attendanceByPlayerId.p10 = 'absent';
  api.ensureStructures();
  const before = api.buildSimpleShareTextForState(api.get());
  assert.doesNotMatch(before,/ゆうと/);
  api.selected(6);
  assert.equal(api.buildSimpleShareTextForState(api.get()),before);
});

test('registered players, replacement plans and saved histories survive local reload', () => {
  const api = nine(); api.get().players[0].nickname = '確認用選手';
  api.substituteNineMode('p1','p10',3); api.saveState();
  const snapshot = api.loadState();
  assert.equal(snapshot.players[0].nickname,'確認用選手');
  assert.equal(snapshot.lineupByInning[3][0],'p10');
  api.saveSavedOrders([{id:'saved-test',state:snapshot}]);
  assert.equal(api.loadSavedOrders()[0].state.lineupByInning[3][0],'p10');
  assert.doesNotThrow(() => validateWorkspace(api.workspacePayload()));
});

function payload(label = '試合A'){
  const {api} = editor();
  const value = JSON.parse(JSON.stringify(api.workspacePayload()));
  value.state.game.opponent = label;
  return value;
}
function fixture(t, { local=payload(), remote=null, meta={}, meaningful=true, online=true } = {}){
  const f = { local, remote, meta, meaningful, online, writes:0, backups:[], status:null, listeners:[] };
  f.adapter = {
    watch(uid,next){ f.listeners.push(next); next(f.remote); return () => {}; },
    async commit(uid, expected, data){
      if((f.remote?.revision || 0) !== expected) return { ok:false, remote:f.remote };
      f.remote = { schema:1, revision:expected + 1, payload:data };
      f.writes++;
      return { ok:true, remote:f.remote };
    }
  };
  f.sync = new WorkspaceSync({
    adapter:f.adapter, getPayload:() => f.local, applyPayload:value => { f.local = value; },
    emptyPayload:() => payload(''), hasLocalData:() => f.meaningful, markLocalData:() => { f.meaningful = true; },
    readMeta:() => f.meta, writeMeta:value => { f.meta = value; }, backup:(value,label) => f.backups.push({value,label}),
    onStatus:status => { f.status = status; }, online:() => f.online, delay:100000
  });
  t.after(() => f.sync.disconnect());
  return f;
}
const remoteData = (value,revision=1) => ({schema:1,revision,payload:canonical(value)});

test('fresh device downloads cloud data without overwriting it', async t => {
  const f = fixture(t,{remote:remoteData(payload('クラウド')),meaningful:false});
  await f.sync.connect('user');
  assert.equal(f.local.state.game.opponent,'クラウド'); assert.equal(f.writes,0); assert.equal(f.status.status,'synced');
});
test('first upload to an empty cloud preserves the existing local workspace', async t => {
  const f = fixture(t);
  await f.sync.connect('user'); await f.sync.flush();
  assert.equal(f.writes,1); assert.equal(f.remote.payload,canonical(f.local));
});
test('existing local and cloud data require a choice and keep a recovery backup', async t => {
  const f = fixture(t,{remote:remoteData(payload('クラウド'))});
  await f.sync.connect('user'); await f.sync.flush();
  assert.equal(f.writes,0); assert.equal(f.status.status,'conflict');
  await f.sync.useRemote();
  assert.equal(f.backups[0].value.state.game.opponent,'試合A'); assert.equal(f.local.state.game.opponent,'クラウド');
});
test('two-device write race is detected by revision rather than silently overwriting', async t => {
  const original = payload();
  const f = fixture(t,{remote:remoteData(original),local:original});
  await f.sync.connect('user');
  f.local = payload('PC編集'); f.sync.changed();
  f.remote = remoteData(payload('スマホ編集'),2);
  await f.sync.flush();
  assert.equal(f.writes,0); assert.equal(f.status.status,'conflict');
  assert.equal(f.local.state.game.opponent,'PC編集');
  await f.sync.useLocal();
  assert.equal(f.remote.revision,3); assert.equal(f.remote.payload,canonical(f.local)); assert.equal(f.backups.length,2);
});
test('offline edits stay local and reconnecting detects conflicting cloud edits', async t => {
  const f = fixture(t,{remote:remoteData(payload()),local:payload()});
  await f.sync.connect('user'); f.online=false;
  f.local=payload('オフライン編集'); f.sync.changed(); await f.sync.flush();
  assert.equal(f.status.status,'offline'); assert.equal(f.writes,0);
  f.online=true; f.sync.receive(remoteData(payload('別端末'),2));
  assert.equal(f.status.status,'conflict'); assert.equal(f.local.state.game.opponent,'オフライン編集');
});
test('changing accounts never automatically uploads the previous account workspace', async t => {
  const f = fixture(t,{meta:{owner:'previous',revision:1,baseData:canonical(payload())}});
  await f.sync.connect('new-user'); await f.sync.flush();
  assert.equal(f.status.status,'account'); assert.equal(f.writes,0);
});
test('own snapshot arriving before commit acknowledgement does not report a conflict', async t => {
  const f = fixture(t,{remote:remoteData(payload()),local:payload()}); await f.sync.connect('user');
  f.adapter.commit = async (uid,expected,data) => {
    const remote=remoteData(JSON.parse(data),expected+1); f.sync.receive(remote); return {ok:true,remote};
  };
  f.local=payload('編集中'); f.sync.changed(); await f.sync.flush();
  assert.equal(f.status.status,'synced'); assert.equal(f.sync.conflict,false);
});
test('cloud workspace disappearance does not silently recreate old data', async t => {
  const f=fixture(t,{remote:remoteData(payload())}); await f.sync.connect('user');
  f.sync.receive(null); await f.sync.flush();
  assert.equal(f.status.status,'conflict'); assert.equal(f.writes,0);
});
test('edits made during an in-flight write are sent in a subsequent revision', async t => {
  const f=fixture(t,{remote:remoteData(payload())}); await f.sync.connect('user');
  let finish;
  const commit=f.adapter.commit;
  f.adapter.commit=(...args) => new Promise(resolve => { finish=async () => resolve(await commit(...args)); });
  f.local=payload('最初の編集'); f.sync.changed(); const pending=f.sync.flush();
  f.local=payload('続きの編集'); f.sync.changed(); await finish(); await pending;
  assert.notEqual(f.meta.baseData,canonical(f.local));
  f.adapter.commit=commit; await f.sync.flush();
  assert.equal(f.remote.payload,canonical(f.local)); assert.equal(f.remote.revision,3);
});
test('late commit acknowledgements after sign-out cannot update another account session', async t => {
  const f=fixture(t,{remote:remoteData(payload())}); await f.sync.connect('user');
  let finish;
  f.adapter.commit=(uid,expected,data) => new Promise(resolve => { finish=() => resolve({ok:true,remote:remoteData(JSON.parse(data),expected+1)}); });
  f.local=payload('編集中'); f.sync.changed(); const pending=f.sync.flush();
  f.sync.disconnect(); const saved=f.meta; finish(); await pending;
  assert.equal(f.sync.uid,null); assert.equal(f.meta,saved); assert.equal(f.status.status,'local');
});
test('invalid backups and unsafe player IDs are rejected before changing state', () => {
  const value=payload(); value.state.players[0].id='__proto__';
  assert.throws(() => validateWorkspace(value));
  assert.throws(() => validateWorkspace({schema:1,state:{},history:[]}));
});
