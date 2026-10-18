import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import '../extension/shared.js';
const C=globalThis.TBTMittanbudCore;
const now=Date.parse('2026-10-18T17:00:00.000Z');
const source={conversationId:'123456',url:'https://minbedrift.mittanbud.no/meldinger/123456',messageText:'Vi kommer mandag kl. 10:00.',sentAt:new Date(now).toISOString()};

test('extension matches only the exact Mittanbud conversation origin and numeric path',()=>{
  assert.deepEqual(C.conversationURL(source.url+'?view=chat'),{conversationId:'123456',url:source.url});
  for(const url of ['http://minbedrift.mittanbud.no/meldinger/123456','https://minbedrift.mittanbud.no.evil.test/meldinger/123456','https://evil.test/meldinger/123456','https://minbedrift.mittanbud.no/meldinger/abc','https://minbedrift.mittanbud.no/meldinger/123456/extra','https://x@minbedrift.mittanbud.no/meldinger/123456','https://minbedrift.mittanbud.no/profil','https://minbedrift.mittanbud.no/meldinger'])assert.equal(C.conversationURL(url),null,url);
});
test('extension normalizes exact displayed text without interpreting markup',()=>{
  assert.equal(C.normalizeText('  A\u00a0B\r\n C  '),'A B\nC');
  assert.equal(C.normalizeText('<img src=x onerror=alert(1)>'),'<img src=x onerror=alert(1)>');
  assert.notEqual(C.normalizeText('Mandag kl 10'),C.normalizeText('Mandag kl 11'));
});
test('extension date hint handles PL NO EN without importing ordinary own messages',()=>{
  for(const text of ['Vi kommer mandag kl 10.','I morgen kl 13','Befaring overmorgen kl. 10:00.','Wizyta pojutrze o 10:00.','Befaring i dag kl. 10:00.','Wizyta dziś o 10:00.','Visit the day after tomorrow at 10:00.','W środę o 10:00','W niedzielę o 11:00','20 października o 12:00','Monday at 09:00','2026-10-20 09:00','20.10.2026 kl 10'])assert.equal(C.hasDateCandidate(text),true,text);
  assert.equal(C.hasDateCandidate('Takk for svaret!'),false);
});
test('extension rejects source mismatches, oversized text and old timestamps',()=>{
  assert.deepEqual(C.validateSource(source,now),source);
  assert.equal(C.validateSource({...source,conversationId:'999'},now),null);
  assert.equal(C.validateSource({...source,messageText:'mandag '+ 'a'.repeat(C.MAX_TEXT)},now),null);
  assert.equal(C.validateSource({...source,sentAt:'2026-10-16T17:00:00Z'},now),null);
  assert.equal(C.sourceMatchesSender(source,source.url+'?foo=bar'),true);
  assert.equal(C.sourceMatchesSender(source,'https://minbedrift.mittanbud.no/meldinger/999'),false);
  assert.equal(C.sourceMatchesSender(source,'https://example.com/meldinger/123456'),false);
});
test('optional project title stays plain and bounded while source URL is canonical',()=>{
  assert.deepEqual(C.validateSource({...source,projectTitle:'  Prosjekt\n kjøkken  '},now),{...source,projectTitle:'Prosjekt kjøkken'});
  assert.equal('projectTitle' in C.validateSource(source,now),false);
  assert.equal(C.validateSource({...source,projectTitle:'a'.repeat(161)},now),null);
  assert.equal(C.validateSource({...source,projectTitle:{title:'Wrong type'}},now),null);
  assert.equal(C.validateSource({...source,projectTitle:'A\u0000B'},now),null);
  assert.deepEqual(C.validateSource({...source,url:source.url+'?unneeded=value'},now),source);
});
test('extension requires a new matching sent bubble, empty composer and no pending indicator',()=>{
  const input={intent:{at:now,messageText:source.messageText,submitted:false},body:source.messageText,now:now+3000,newSent:true,composerEmpty:true,wrapperPresent:true};
  assert.equal(C.canConfirm(input),true);
  for(const key of ['newSent','composerEmpty','wrapperPresent'])assert.equal(C.canConfirm({...input,[key]:false}),false,key);
  assert.equal(C.canConfirm({...input,pendingIndicator:true}),false);
  assert.equal(C.canConfirm({...input,body:'Different message'}),false);
  assert.equal(C.canConfirm({...input,intent:{...input.intent,submitted:true}}),false);
  assert.equal(C.canConfirm({...input,now:now+C.INTENT_WINDOW_MS+1}),false);
  assert.equal(C.canConfirm({...input,intent:null}),false);
});
test('extension uses a stable source key for retries and a distinct key for later sends',async()=>{
  const key=await C.sourceKey(source);
  assert.match(key,/^[a-f0-9]{64}$/);
  assert.equal(await C.sourceKey({...source}),key);
  assert.equal(await C.sourceKey({...source,projectTitle:'Different label'}),key);
  assert.notEqual(await C.sourceKey({...source,sentAt:new Date(now+1000).toISOString()}),key);
  assert.notEqual(await C.sourceKey({...source,conversationId:'999'}),key);
});
test('fresh verification proof is bound to extension, exact owned tab, URL, key and expiry',async()=>{
  const key=await C.sourceKey(source),url=C.verificationURL(source,key);
  assert.equal(url,source.url+'?tbt_verify='+key);
  const job={source,sourceKey:key,tabId:42,status:'verifying',expiresAt:now+C.VERIFY_WINDOW_MS};
  const sender={id:'extension-under-test',frameId:0,tab:{id:42},url};
  assert.equal(C.verificationSender(job,sender,'extension-under-test',now),true);
  for(const changed of [{...sender,id:'other-extension'},{...sender,frameId:1},{...sender,tab:{id:43}},{...sender,url:source.url},{...sender,url:url+'0'},{...sender,url:url.replace('/123456?','/999?')}])assert.equal(C.verificationSender(job,changed,'extension-under-test',now),false);
  assert.equal(C.verificationSender({...job,status:'waiting'},sender,'extension-under-test',now),false);
  assert.equal(C.verificationSender({...job,expiresAt:now},sender,'extension-under-test',now),false);
  assert.equal(C.verificationSender(null,sender,'extension-under-test',now),false);
  assert.equal(C.verificationURL({...source,url:'https://example.com/'},key),null);
  assert.equal(C.verificationURL(source,'bad-key'),null);
});
test('extension retry bounds and manifest keep the integration narrowly scoped',()=>{
  assert.equal(C.MAX_QUEUE,20);assert.equal(C.MAX_ATTEMPTS,5);
  assert.equal(C.retryable(429),true);assert.equal(C.retryable(502),true);assert.equal(C.retryable(503),true);assert.equal(C.retryable(504),true);assert.equal(C.retryable(0),true);
  for(const code of [200,400,401,403,409,500])assert.equal(C.retryable(code),false);
  assert.ok(C.retryDelay(2)>C.retryDelay(1));
  const manifest=JSON.parse(readFileSync(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.permissions,['storage']);
  assert.equal(manifest.manifest_version,3);
  assert.deepEqual(manifest.host_permissions,[C.MITTANBUD_ORIGIN+'/*',C.TBT_ORIGIN+'/*']);
  assert.deepEqual(manifest.content_scripts[0].matches,[C.MITTANBUD_ORIGIN+'/*']);
  assert.equal(manifest.content_scripts[0].run_at,'document_start');
  assert.equal('externally_connectable' in manifest,false);
});
