import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const ADMIN='local-test-owner-token-'.repeat(3);
const INGEST='local-test-mittanbud-token-'.repeat(3);
const PUBLIC_URL='https://tbt.example.invalid';
const EXTENSION='chrome-extension://'+'a'.repeat(32);
const CALENDAR_ID='tromsobyggtre@gmail.com';
const CALENDAR='https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(CALENDAR_ID)+'/events';
const futureDay=()=>new Date(Date.now()+7*86400000).toISOString().slice(0,10);
const source=(messageText=`Vi kommer på befaring ${futureDay()} kl. 10:00.`,conversationId='12345')=>({
  conversationId,url:'https://minbedrift.mittanbud.no/meldinger/'+conversationId,
  messageText,sentAt:new Date(Date.now()-60000).toISOString()
});

async function withServer(run,{ingestToken=INGEST}={}) {
  const directory=mkdtempSync(join(tmpdir(),'tbt-mittanbud-http-'));
  const fixture=`
    import http from 'node:http';
    import {Google} from './google.mjs';
    const events=new Map();
    const calendar=${JSON.stringify(CALENDAR)},calendarId=${JSON.stringify(CALENDAR_ID)};
    Google.prototype.request=async function(url,options={}) {
      console.log('TEST_GOOGLE_CALL '+JSON.stringify({url,options}));
      if(url==='https://www.googleapis.com/calendar/v3/freeBusy')return {calendars:{[calendarId]:{busy:[]}}};
      if(url===calendar&&options.method==='POST') {
        const event={...structuredClone(options.data),htmlLink:'https://calendar.google.com/calendar/event?eid=fixture'};
        events.set(event.id,event);return structuredClone(event);
      }
      if(url.startsWith(calendar+'/')&&(!options.method||options.method==='GET')) {
        const event=events.get(url.slice(calendar.length+1));
        if(!event)throw Object.assign(new Error('Fixture not found'),{response:{status:404}});
        return structuredClone(event);
      }
      throw Error('Unexpected Google operation in fixture');
    };
    globalThis.fetch=async()=>{console.log('TEST_EXTERNAL_FETCH_FORBIDDEN');throw Error('External network forbidden in fixture');};
    const listen=http.Server.prototype.listen;
    http.Server.prototype.listen=function(...args) {
      this.once('listening',()=>console.log('TEST_PORT '+this.address().port));
      return listen.apply(this,args);
    };
    await import('./server.mjs');
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',fixture],{
    cwd:new URL('..',import.meta.url),
    env:{...process.env,PORT:'0',ADMIN_TOKEN:ADMIN,MITTANBUD_INGEST_TOKEN:ingestToken,
      DATA_DIR:directory,DATA_ENCRYPTION_KEY:'c'.repeat(64),PUBLIC_URL,
      GOOGLE_ACCOUNT_EMAIL:'tromsobyggtre@gmail.com',GOOGLE_CLIENT_ID:'local-test-client',
      GOOGLE_CLIENT_SECRET:'local-test-secret',GOOGLE_REFRESH_TOKEN:'local-test-refresh',
      GOOGLE_REDIRECT_URI:'',OPENAI_API_KEY:'local-test-only',OPENAI_MODEL:'local-test-only'}
  });
  let output='',errors='';
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{errors+=chunk;});
  const calls=()=>output.split('\n').filter(line=>line.startsWith('TEST_GOOGLE_CALL ')).map(line=>JSON.parse(line.slice('TEST_GOOGLE_CALL '.length)));
  const inserts=()=>calls().filter(call=>call.url===CALENDAR&&call.options.method==='POST');
  try {
    const port=await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(Error('Fixture startup timed out: '+errors)),5000);
      const check=()=>{const match=/TEST_PORT (\d+)/.exec(output);if(match){clearTimeout(deadline);resolve(Number(match[1]));}};
      child.stdout.on('data',check);
      child.once('error',error=>{clearTimeout(deadline);reject(error);});
      child.once('exit',code=>{clearTimeout(deadline);reject(Error('Fixture exited '+code+': '+errors));});
      check();
    });
    const base='http://127.0.0.1:'+port;
    const request=async(path,{method='GET',token=INGEST,origin,body,headers={}}={})=>{
      const response=await fetch(base+path,{method,signal:AbortSignal.timeout(5000),
        headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{}),...headers},
        ...(body!==undefined?{body:JSON.stringify(body)}:{})});
      return {status:response.status,headers:response.headers,data:response.status===204?null:await response.json()};
    };
    await run({request,calls,inserts});
    assert.equal(output.includes('TEST_EXTERNAL_FETCH_FORBIDDEN'),false,'Mittanbud observation must not call AI or another fetch endpoint');
  } finally {
    if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    rmSync(directory,{recursive:true,force:true});
  }
}

test('Mittanbud limited access is isolated from owner APIs and CORS rejects websites',async()=>{
  await withServer(async({request,calls})=>{
    const limited=await request('/api/mittanbud/status',{origin:EXTENSION});
    assert.equal(limited.status,200);
    assert.deepEqual(limited.data,{ok:true,enabled:false,visitMinutes:30});
    assert.equal(limited.headers.get('access-control-allow-origin'),EXTENSION);
    for(const [path,method,body] of [
      ['/api/status','GET'],['/api/actions','POST',{}],['/api/actions/approve','POST',{}],
      ['/api/mittanbud/history','GET'],['/api/mittanbud/settings','POST',{enabled:true}],
      ['/api/monitor/settings','POST',{enabled:true}],['/api/analyze','POST',{}]
    ])assert.equal((await request(path,{method,body})).status,401,path+' must require the owner token');
    assert.equal((await request('/api/mittanbud/status',{token:null})).status,401);
    assert.equal((await request('/api/mittanbud/observe',{method:'POST',token:null,body:{}})).status,401);
    assert.equal((await request('/api/mittanbud/status',{origin:'https://attacker.example'})).status,403);
    const hostile=await request('/api/mittanbud/observe',{method:'POST',origin:'https://attacker.example',body:{source:source()}});
    assert.equal(hostile.status,403);assert.equal(hostile.headers.get('access-control-allow-origin'),null);
    const preflight=await request('/api/mittanbud/observe',{method:'OPTIONS',token:null,origin:EXTENSION,
      headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'}});
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('access-control-allow-origin'),EXTENSION);
    assert.match(preflight.headers.get('access-control-allow-methods'),/POST/);
    assert.match(preflight.headers.get('access-control-allow-headers'),/Authorization/);
    assert.equal((await request('/api/mittanbud/observe',{method:'OPTIONS',token:null,origin:'https://attacker.example'})).status,401);
    assert.equal((await request('/api/mittanbud/settings',{method:'POST',token:ADMIN,origin:EXTENSION,body:{enabled:true}})).status,403);
    const disabled=await request('/api/mittanbud/observe',{method:'POST',origin:EXTENSION,body:{source:source()}});
    assert.equal(disabled.status,400);assert.match(disabled.data.error,/wyłączony/);
    assert.equal((await request('/api/mittanbud/settings',{method:'POST',token:ADMIN,body:{enabled:'true'}})).status,400);
    const enabled=await request('/api/mittanbud/settings',{method:'POST',token:ADMIN,origin:PUBLIC_URL,body:{enabled:true}});
    assert.equal(enabled.status,200);assert.equal(enabled.data.enabled,true);assert.equal(enabled.data.tokenConfigured,true);
    assert.equal((await request('/api/mittanbud/status')).data.enabled,true);
    for(const body of [{},{source:null},{source:{...source(),url:'https://attacker.example/meldinger/12345'}},
      {source:{...source(),conversationId:'different'}},{source:{...source(),sentAt:new Date(Date.now()-25*3600000).toISOString()}}]) {
      assert.equal((await request('/api/mittanbud/observe',{method:'POST',body})).status,400);
    }
    const history=await request('/api/mittanbud/history',{token:ADMIN});
    assert.equal(history.status,200);assert.equal(history.data.enabled,true);assert.deepEqual(history.data.recent,[]);
    assert.equal(calls().length,0,'authentication, settings and invalid observations must not contact Google');
  });
});

test('Mittanbud observation creates one private tentative 30-minute visit and never sends it to AI',async()=>{
  await withServer(async({request,calls,inserts})=>{
    assert.equal((await request('/api/mittanbud/settings',{method:'POST',token:ADMIN,body:{enabled:true}})).status,200);
    const observation=source();
    const created=await request('/api/mittanbud/observe',{method:'POST',origin:EXTENSION,body:{source:observation}});
    assert.equal(created.status,200);assert.equal(created.data.state,'created');
    assert.equal(inserts().length,1);
    const insert=inserts()[0],event=insert.options.data;
    assert.equal(event.status,'tentative');assert.equal(event.visibility,'private');assert.equal(event.transparency,'opaque');
    assert.equal(Object.hasOwn(event,'attendees'),false);assert.equal(insert.options.params.sendUpdates,'none');
    assert.equal(Date.parse(event.end.dateTime)-Date.parse(event.start.dateTime),30*60000);
    assert.equal(event.start.timeZone,'Europe/Oslo');assert.equal(event.end.timeZone,'Europe/Oslo');
    assert.equal(event.extendedProperties.private.tbtConversation,'12345');
    assert.equal(event.extendedProperties.private.tbtSource,'mittanbud');
    assert.match(event.extendedProperties.private.tbtSourceHash,/^[a-f0-9]{64}$/);
    assert.ok(event.description.includes(observation.url));
    assert.ok(event.description.includes('akceptacja klienta nie została potwierdzona'));
    assert.ok(calls()[0].url.endsWith('/'+event.id),'deduplication lookup must precede insertion');
    assert.ok(calls()[1].url.endsWith('/freeBusy'),'calendar conflict check must precede insertion');
    assert.deepEqual(calls()[1].options.data.items,[{id:CALENDAR_ID}],'conflicts must be checked in the exact TBT calendar');
    const duplicate=await request('/api/mittanbud/observe',{method:'POST',body:{source:observation}});
    assert.equal(duplicate.status,200);assert.equal(duplicate.data.state,'duplicate');assert.equal(inserts().length,1);
    const ambiguous=await request('/api/mittanbud/observe',{method:'POST',body:{source:source(`Może przyjadę na wizytę ${futureDay()} o 10:00.`,'12346')}});
    assert.equal(ambiguous.status,200);assert.equal(ambiguous.data.state,'ambiguous');assert.equal(inserts().length,1);
    const history=await request('/api/mittanbud/history',{token:ADMIN});
    assert.equal(history.status,200);assert.equal(history.data.recent.length,2);
    assert.deepEqual(history.data.recent.map(entry=>entry.state).sort(),['ambiguous','duplicate']);
    assert.equal(history.data.recent.some(entry=>Object.hasOwn(entry,'messageText')),false);
    const status=await request('/api/status',{token:ADMIN});
    assert.equal(status.status,200);assert.deepEqual(status.data.actions,[],'automatic import must not manufacture an unrelated approval action');
    assert.equal((await request('/api/mittanbud/settings',{method:'POST',token:ADMIN,body:{enabled:false}})).status,200);
    assert.equal((await request('/api/mittanbud/observe',{method:'POST',body:{source:source()}})).status,400);
    assert.equal(inserts().length,1);
  });
});

test('an ingest token shorter than 32 characters cannot authenticate or enable the integration',async()=>{
  await withServer(async({request,calls})=>{
    assert.equal((await request('/api/mittanbud/status',{token:'too-short'})).status,401);
    assert.equal((await request('/api/mittanbud/observe',{method:'POST',token:'too-short',body:{source:source()}})).status,401);
    const settings=await request('/api/mittanbud/settings',{method:'POST',token:ADMIN,body:{enabled:true}});
    assert.equal(settings.status,400);
    const history=await request('/api/mittanbud/history',{token:ADMIN});
    assert.equal(history.status,200);assert.equal(history.data.enabled,false);assert.equal(history.data.tokenConfigured,false);
    assert.equal(calls().length,0);
  },{ingestToken:'too-short'});
});
