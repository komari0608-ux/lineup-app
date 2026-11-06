// The editor remains usable without Firebase or a network connection.
export const MAX_WORKSPACE_BYTES = 850000;

export function canonical(value){
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateWorkspace(value){
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  const validState = st => {
    if(!object(st) || !object(st.game) || !Array.isArray(st.players) || !st.players.length || st.players.length > 100) return false;
    if(!Array.isArray(st.battingOrder) || st.battingOrder.length > 100) return false;
    if(!['all','nine'].includes(st.battingMode) || !Number.isFinite(Number(st.game.innings)) || Number(st.game.innings) < 1 || Number(st.game.innings) > 9) return false;
    const ids = new Set();
    for(const player of st.players){
      if(!object(player) || typeof player.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(player.id) || ['__proto__','constructor','prototype'].includes(player.id) || ids.has(player.id)) return false;
      ids.add(player.id);
      for(const key of ['nickname','fullName','number','color']) if(player[key] !== undefined && (typeof player[key] !== 'string' || player[key].length > 200)) return false;
    }
    if(st.battingOrder.some(id => !ids.has(id))) return false;
    for(const key of ['startPositions','defenseChanges','lineupByInning','attendanceByPlayerId']) if(st[key] !== undefined && !object(st[key])) return false;
    if(Object.entries(st.lineupByInning || {}).some(([key,line]) => !/^[1-9]$/.test(key) || !Array.isArray(line) || line.length > 100 || line.some(id => !ids.has(id)))) return false;
    const positions = new Set(['1','2','3','4','5','6','7','8','9','DH','B']);
    if(Object.entries(st.startPositions || {}).some(([id,pos]) => !ids.has(id) || !positions.has(pos))) return false;
    if(Object.entries(st.defenseChanges || {}).some(([id,changes]) => !ids.has(id) || !object(changes) || Object.entries(changes).some(([inning,pos]) => !/^[1-9]$/.test(inning) || !positions.has(pos)))) return false;
    if(st.settings !== undefined && !object(st.settings)) return false;
    for(const key of ['date','place','start','format','opponent']) if(st.game[key] !== undefined && (typeof st.game[key] !== 'string' || st.game[key].length > 1000)) return false;
    return true;
  };
  if(!object(value) || value.schema !== 1 || !validState(value.state) || !Array.isArray(value.history) || value.history.length > 50 || value.history.some(entry => !object(entry) || typeof entry.id !== 'string' || !validState(entry.state))) throw new Error('選手・オーダーのバックアップ形式を確認してください。');
  if(new TextEncoder().encode(canonical(value)).byteLength > MAX_WORKSPACE_BYTES) throw new Error('共有できる容量を超えています。バックアップ保存後に古い記録を整理してください。');
  return value;
}

export class WorkspaceSync {
  constructor(options){
    this.o = options;
    this.uid = null;
    this.remote = null;
    this.ready = false;
    this.conflict = false;
    this.timer = null;
    this.flight = null;
    this.session = 0;
    this.meta = options.readMeta() || {};
    this.status = 'local';
  }
  data(){ return canonical(validateWorkspace(this.o.getPayload())); }
  emit(status, detail = ''){
    this.status = status;
    this.o.onStatus({ status, detail, uid:this.uid, conflict:this.conflict, remote:this.remote });
  }
  persist(){ this.o.writeMeta(this.meta); }
  acceptBase(remote){
    this.meta = { owner:this.uid, revision:remote?.revision || 0, baseData:remote?.payload || null };
    this.persist();
  }
  async connect(uid){
    this.disconnect(false);
    this.uid = uid;
    const session = this.session;
    this.emit('connecting');
    this.unsubscribe = this.o.adapter.watch(uid, remote => {
      if(session !== this.session) return;
      try{ this.receive(remote); }catch(error){ this.emit('error', error.message); }
    }, error => { if(session === this.session) this.emit('error', error.message || '共有先に接続できません。'); });
  }
  disconnect(notify = true){
    this.session++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    clearTimeout(this.timer);
    this.timer = null;
    this.uid = null;
    this.ready = false;
    this.conflict = false;
    this.remote = null;
    this.flight = null;
    if(notify) this.emit('local');
  }
  receive(remote){
    if(!this.uid) return;
    if(remote){
      if(!Number.isInteger(remote.revision) || remote.revision < 1 || typeof remote.payload !== 'string') throw new Error('共有データの形式を確認できません。端末の内容を保持しました。');
      validateWorkspace(JSON.parse(remote.payload));
    }
    if(this.remote && remote && remote.revision < this.remote.revision) return;
    this.remote = remote;
    this.ready = true;
    const data = this.data();
    if(this.meta.owner && this.meta.owner !== this.uid){
      this.conflict = true; this.emit('account'); return;
    }
    // Snapshot notification can arrive before the commit promise resolves.
    if(remote && this.flight?.data === remote.payload){
      this.acceptBase(remote);
      this.conflict = false;
      this.emit(data === remote.payload ? 'synced' : 'pending');
      return;
    }
    if(remote?.payload === data){
      this.acceptBase(remote); this.conflict = false; this.emit('synced'); return;
    }
    if(this.conflict){ this.emit('conflict'); return; }
    if(!remote){
      // A disappeared cloud workspace must never be silently recreated.
      if(this.meta.owner === this.uid && this.meta.revision > 0){ this.conflict = true; this.emit('conflict'); return; }
      this.acceptBase(null); this.queue(); return;
    }
    const changed = this.meta.owner === this.uid && this.meta.baseData ? data !== this.meta.baseData : this.o.hasLocalData();
    if(changed){ this.conflict = true; this.emit('conflict'); return; }
    this.o.applyPayload(JSON.parse(remote.payload));
    this.acceptBase(remote);
    this.emit('synced');
  }
  changed(){
    this.o.markLocalData();
    if(this.conflict){ this.emit(this.status === 'account' ? 'account' : 'conflict'); return; }
    this.queue();
  }
  queue(){
    clearTimeout(this.timer);
    if(!this.uid || !this.ready || this.conflict) return;
    if(this.data() === this.meta.baseData){ this.emit('synced'); return; }
    if(!this.o.online()){ this.emit('offline'); return; }
    this.emit('pending');
    this.timer = setTimeout(() => this.flush(), this.o.delay ?? 1000);
  }
  async flush(){
    clearTimeout(this.timer);
    if(!this.uid || !this.ready || this.conflict || this.flight) return;
    if(!this.o.online()){ this.emit('offline'); return; }
    let data;
    try{ data = this.data(); }catch(error){ this.emit('error', error.message); return; }
    if(data === this.meta.baseData){ this.emit('synced'); return; }
    const session = this.session;
    const expected = this.meta.revision || 0;
    this.flight = { data };
    this.emit('saving');
    try{
      const result = await this.o.adapter.commit(this.uid, expected, data);
      if(session !== this.session) return;
      this.flight = null;
      if(!result.ok){ this.receive(result.remote); return; }
      // Do not replace a newer snapshot received while this write was pending.
      if(!this.remote || result.remote.revision >= this.remote.revision){ this.remote = result.remote; this.acceptBase(result.remote); }
      this.queue();
    }catch(error){
      if(session !== this.session) return;
      this.flight = null;
      this.emit(this.o.online() ? 'error' : 'offline', error.message || '共有先に保存できません。端末には保存されています。');
    }
  }
  async useRemote(){
    if(!this.ready || !this.uid || !this.conflict) return;
    this.o.backup(this.o.getPayload(), '切替前の端末データ');
    this.o.applyPayload(this.remote ? JSON.parse(this.remote.payload) : this.o.emptyPayload());
    this.acceptBase(this.remote);
    this.conflict = false;
    this.queue();
  }
  async useLocal(){
    if(!this.ready || !this.uid || !this.conflict) return;
    this.o.backup(this.o.getPayload(), '共有前の端末データ');
    if(this.remote) this.o.backup(JSON.parse(this.remote.payload), '切替前の共有データ');
    this.acceptBase(this.remote);
    this.conflict = false;
    await this.flush();
  }
}

function friendlyError(error){
  const code = String(error?.code || '');
  if(code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')) return 'ログインをキャンセルしました。端末保存を続けられます。';
  if(code.includes('popup-blocked')) return 'ログイン画面がブロックされました。ブラウザーでポップアップを許可し、もう一度お試しください。';
  if(code.includes('unauthorized-domain')) return 'このURLのログイン許可が未設定です。正式公開URLでお試しください。';
  if(/operation-not-allowed|configuration-not-found/.test(code)) return 'データ共有の初期設定が必要です。端末保存はそのまま使えます。';
  if(/permission-denied|failed-precondition|not-found/.test(code)) return '共有先のデータベース・アクセス設定を確認する必要があります。端末の内容は保持しています。';
  if(/network-request-failed|unavailable/.test(code)) return '通信できません。端末に保存し、接続後に同期を再試行できます。';
  return '共有先に接続できません。端末の内容は保持しています。時間をおいて再試行してください。';
}

export async function startCloudSync(options){
  const firebaseVersion = '13.2.0';
  const base = `https://www.gstatic.com/firebasejs/${firebaseVersion}`;
  const [appSdk, authSdk, dbSdk] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`)
  ]);
  const response = await fetch('/__/firebase/init.json', { cache:'no-store' });
  if(!response.ok) throw new Error('正式公開URLでデータ共有を設定してください。');
  const config = await response.json();
  if(config.projectId !== 'lineup-app-b4f4e' || !config.apiKey) throw new Error('データ共有の初期設定が必要です。');
  const app = appSdk.initializeApp(config, 'lineup-workspace');
  const auth = authSdk.getAuth(app);
  auth.languageCode = 'ja';
  const db = dbSdk.getFirestore(app);
  const deviceId = options.deviceId;
  const path = uid => dbSdk.doc(db, 'lineupUsers', uid, 'workspace', 'current');
  const adapter = {
    watch(uid, next, fail){
      return dbSdk.onSnapshot(path(uid), { includeMetadataChanges:true }, snapshot => {
        // A cached absence is not proof that the cloud workspace is empty.
        if(snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
        next(snapshot.exists() ? snapshot.data() : null);
      }, error => fail(new Error(friendlyError(error))));
    },
    async commit(uid, expected, payload){
      try{
        return await dbSdk.runTransaction(db, async transaction => {
          const ref = path(uid);
          const snapshot = await transaction.get(ref);
          const remote = snapshot.exists() ? snapshot.data() : null;
          if((remote?.revision || 0) !== expected) return { ok:false, remote };
          const data = { schema:1, revision:expected + 1, payload, deviceId, updatedAt:dbSdk.serverTimestamp() };
          transaction.set(ref, data);
          return { ok:true, remote:data };
        });
      }catch(error){ throw new Error(friendlyError(error)); }
    }
  };
  const sync = new WorkspaceSync({ ...options, adapter });
  authSdk.onAuthStateChanged(auth, user => {
    options.onAccount(user ? { email:user.email || '', name:user.displayName || '' } : null);
    if(user) sync.connect(user.uid); else sync.disconnect();
  });
  window.addEventListener('online', () => sync.queue());
  window.addEventListener('offline', () => { if(sync.uid) sync.emit('offline'); });
  return {
    changed:() => sync.changed(),
    retry:() => auth.currentUser ? sync.connect(auth.currentUser.uid) : null,
    async login(){
      try{
        const provider = new authSdk.GoogleAuthProvider();
        provider.setCustomParameters({ prompt:'select_account' });
        await authSdk.signInWithPopup(auth, provider);
      }catch(error){ throw new Error(friendlyError(error)); }
    },
    async logout(){ sync.disconnect(); await authSdk.signOut(auth); },
    useRemote:() => sync.useRemote(),
    useLocal:() => sync.useLocal()
  };
}
