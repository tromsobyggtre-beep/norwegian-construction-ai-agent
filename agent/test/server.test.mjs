import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('HTTP: publiczny health, prywatne dane, walidacja i brak zapisu Google bez zgody',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tbt-http-')),port=18000+Math.floor(Math.random()*1000),token='test-admin-'.repeat(5);
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),ADMIN_TOKEN:token,DATA_ENCRYPTION_KEY:'a'.repeat(64),DATA_DIR:dir}});
  try{
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exited '+c)));});
    const base='http://127.0.0.1:'+port;
    assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/api/status')).status,401);
    const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
    const s=await(await fetch(base+'/api/status',{headers})).json();assert.equal(s.rateNet,850);assert.equal(s.googleConnected,false);
    assert.equal((await fetch(base+'/api/quotes',{method:'POST',headers,body:'{}'})).status,400);
    assert.equal((await fetch(base+'/api/monitor/settings',{method:'POST',headers,body:'{"enabled":true}'})).status,400);
    assert.equal((await fetch(base+'/api/actions/approve',{method:'POST',headers,body:'{}'})).status,400);
    assert.equal((await fetch(base+'/oauth/google/callback?state=forged&code=bad')).status,400);
    assert.equal((await fetch(base+'/api/google/connect',{method:'POST',headers,body:'{}'})).status,400);
    const futureYear=new Date().getUTCFullYear()+2;
    const proposal=await fetch(base+'/api/actions',{method:'POST',headers,body:JSON.stringify({kind:'calendar_event',summary:'Test lokalnej daty',description:'Tylko lokalna propozycja',start:`${futureYear}-01-20T09:00`,end:`${futureYear}-01-20T10:00`})});
    assert.equal(proposal.status,201);const event=await proposal.json();
    assert.equal(event.payload.start.dateTime,`${futureYear}-01-20T08:00:00.000Z`);assert.equal(event.payload.start.timeZone,'Europe/Oslo');assert.equal(event.state,'pending');
    assert.equal((await fetch(base+'/api/actions',{method:'POST',headers,body:JSON.stringify({kind:'calendar_event',summary:'Błędna data',description:'Test',start:`${futureYear}-02-30T09:00:00+01:00`,end:`${futureYear}-03-02T10:00:00+01:00`})})).status,400);
  }finally{child.kill();await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true});}
});
