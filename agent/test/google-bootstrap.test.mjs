import test from 'node:test';
import assert from 'node:assert/strict';
import {Google} from '../google.mjs';

const initialEnv={GOOGLE_CLIENT_ID:'client-a',GOOGLE_REFRESH_TOKEN:'test-refresh-a'};
function memoryStore(data={google:null}) {
  return {data:structuredClone(data),saves:0,save(){this.saves++;this.persisted=structuredClone(this.data);}};
}
function seededStore() {
  const store=memoryStore();new Google(store,initialEnv);
  store.data.google={...store.data.google,access_token:'test-cached-access',expiry_date:1900000000000};
  store.save();return memoryStore(store.persisted);
}

test('Google bootstrap seeds and persists the refresh token plus a fingerprint',()=>{
  const store=memoryStore();new Google(store,initialEnv);
  assert.deepEqual(store.data.google,{refresh_token:'test-refresh-a'});
  assert.match(store.data.googleBootstrapFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(store.saves,1);
  assert.deepEqual(store.persisted,store.data);
});

test('an unchanged restart preserves the refreshed access token and does not write',()=>{
  const store=seededStore(),before=structuredClone(store.data);
  new Google(store,{...initialEnv});
  assert.deepEqual(store.data,before);
  assert.equal(store.saves,0);
});

test('a rotated bootstrap refresh token replaces old credentials and persists the new fingerprint',()=>{
  const store=seededStore(),oldFingerprint=store.data.googleBootstrapFingerprint;
  new Google(store,{...initialEnv,GOOGLE_REFRESH_TOKEN:'test-refresh-b'});
  assert.deepEqual(store.data.google,{refresh_token:'test-refresh-b'});
  assert.notEqual(store.data.googleBootstrapFingerprint,oldFingerprint);
  assert.deepEqual(store.persisted,store.data);
  assert.equal(store.saves,1);
  const restarted=memoryStore(store.persisted);
  new Google(restarted,{...initialEnv,GOOGLE_REFRESH_TOKEN:'test-refresh-b'});
  assert.equal(restarted.saves,0);
});

test('a changed OAuth client clears cached access credentials even with the same bootstrap token',()=>{
  const store=seededStore(),oldFingerprint=store.data.googleBootstrapFingerprint;
  new Google(store,{...initialEnv,GOOGLE_CLIENT_ID:'client-b'});
  assert.deepEqual(store.data.google,{refresh_token:'test-refresh-a'});
  assert.notEqual(store.data.googleBootstrapFingerprint,oldFingerprint);
  assert.equal(store.saves,1);
  assert.deepEqual(store.persisted,store.data);
});

test('without a bootstrap refresh token existing OAuth credentials are left intact',()=>{
  const store=seededStore(),before=structuredClone(store.data);
  new Google(store,{GOOGLE_CLIENT_ID:'client-a'});
  assert.deepEqual(store.data,before);
  assert.equal(store.saves,0);
});

test('a legacy store without a fingerprint adopts the configured bootstrap credentials once',()=>{
  const store=memoryStore({google:{refresh_token:'test-old-refresh',access_token:'test-old-access'}});
  new Google(store,initialEnv);
  assert.deepEqual(store.data.google,{refresh_token:'test-refresh-a'});
  assert.equal(store.saves,1);
  const restarted=memoryStore(store.persisted);
  new Google(restarted,initialEnv);
  assert.equal(restarted.saves,0);
});
