// Optional integration test: run against the Firestore emulator, never production.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.LINEUP_RULES_TEST_PACKAGE || new URL('../package.json', import.meta.url));
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, collection, setDoc, getDoc, getDocs, deleteDoc, serverTimestamp } = require('firebase/firestore');
if(!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST must point to a local emulator.');
const env = await initializeTestEnvironment({
  projectId:'demo-lineup-cloud-test',
  firestore:{ rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8') }
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());
const reference = db => doc(db,'lineupUsers','owner','workspace','current');
const record = revision => ({schema:1,revision,payload:'{"schema":1}',deviceId:'test-device',updatedAt:serverTimestamp()});

test('owner can create, get and advance revision', async () => {
  const ref=reference(env.authenticatedContext('owner').firestore());
  await assertSucceeds(setDoc(ref,record(1)));
  await assertSucceeds(setDoc(ref,record(2)));
  const result=await assertSucceeds(getDoc(ref)); assert.equal(result.data().revision,2);
});
test('unauthenticated users cannot read or write', async () => {
  const ref=reference(env.unauthenticatedContext().firestore());
  await assertFails(getDoc(ref)); await assertFails(setDoc(ref,record(1)));
});
test('another signed-in account cannot read or overwrite an owner workspace', async () => {
  await setDoc(reference(env.authenticatedContext('owner').firestore()),record(1));
  const ref=reference(env.authenticatedContext('other').firestore());
  await assertFails(getDoc(ref)); await assertFails(setDoc(ref,record(2)));
});
test('stale revisions and arbitrary additional fields are rejected', async () => {
  const ref=reference(env.authenticatedContext('owner').firestore());
  await setDoc(ref,record(1));
  await assertFails(setDoc(ref,record(1))); await assertFails(setDoc(ref,record(3)));
  await assertFails(setDoc(ref,{...record(2),public:true}));
});
test('delete and collection listing are not enabled', async () => {
  const db=env.authenticatedContext('owner').firestore();
  await setDoc(reference(db),record(1));
  await assertFails(deleteDoc(reference(db)));
  await assertFails(getDocs(collection(db,'lineupUsers','owner','workspace')));
});
test('wrong schema and oversized payloads are rejected', async () => {
  const ref=reference(env.authenticatedContext('owner').firestore());
  await assertFails(setDoc(ref,{...record(1),schema:2}));
  await assertFails(setDoc(ref,{...record(1),payload:'x'.repeat(850001)}));
});
