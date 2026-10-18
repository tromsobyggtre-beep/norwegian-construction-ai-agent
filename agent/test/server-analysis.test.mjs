import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {Store} from '../core.mjs';

test('AI and monitoring do not overlap; a later snapshot retains a clearly stale analysis',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tbt-analysis-')),port=20000+Math.floor(Math.random()*1000),token='local-test-admin-'.repeat(4),key='b'.repeat(64);
  const firstAt='2026-10-18T10:00:00.000Z',nextAt='2026-10-18T10:15:00.000Z';
  const report={at:firstAt,messages:[{id:'18abc000000001',threadId:'18abc000000001',subject:'Zapytanie testowe',from:'demo@example.invalid',snippet:'Proszę o ustalenie zakresu.',labels:['INBOX','UNREAD']}],events:[],files:[],limits:{mail:30,events:50,files:50},analysis:'OLD_ANALYSIS_DO_NOT_FORWARD'};
  const local=new Store(dir,key);local.data.report=report;local.save();
  const fixture=`
    import {Google} from './google.mjs';
    Google.prototype.monitor=async()=>(${JSON.stringify({...report,at:nextAt,analysis:undefined})});
    globalThis.fetch=async(url,options)=>{
      if(url!=='https://api.openai.com/v1/responses')throw Error('Unexpected outbound request');
      const request=JSON.parse(options.body);
      if(request.store!==false||request.tools||request.text?.format?.type!=='json_schema'||request.input.includes('OLD_ANALYSIS_DO_NOT_FORWARD'))throw Error('Unsafe analysis request');
      console.log('AI_FETCH_START');await new Promise(r=>setTimeout(r,500));
      return {ok:true,status:200,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Testowy przegląd',priorities:[{title:'Sprawdź zapytanie',reason:'Fragment zawiera prośbę o ustalenie zakresu.',nextStep:'Przeczytaj pełną wiadomość.',sourceIds:['mail:18abc000000001']}],missingInformation:[],warnings:[]})}]}]})};
    };
    await import('./server.mjs');
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',fixture],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),ADMIN_TOKEN:token,DATA_ENCRYPTION_KEY:key,DATA_DIR:dir,OPENAI_API_KEY:'local-test-only',OPENAI_MODEL:'local-test-only',GOOGLE_REFRESH_TOKEN:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:''}});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});
  const waitFor=async text=>{const until=Date.now()+5000;while(!output.includes(text)){if(child.exitCode!==null||Date.now()>until)throw Error('Child server did not reach '+text);await new Promise(r=>setTimeout(r,15));}};
  try{
    await waitFor('TBT Bogdan listening');
    const base='http://127.0.0.1:'+port,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
    const post=(path,body={})=>fetch(base+'/api/'+path,{method:'POST',headers,body:JSON.stringify(body)});
    const analysisPromise=post('analyze');await waitFor('AI_FETCH_START');
    assert.deepEqual(await(await post('monitor/run')).json(),{busy:true});
    assert.equal((await post('analyze')).status,409);
    const result=await analysisPromise;assert.equal(result.status,200);
    assert.equal((await result.json()).analysisReport.priorities[0].sourceIds[0],'mail:18abc000000001');
    const before=await(await fetch(base+'/api/status',{headers})).json();
    assert.equal(before.report.analysisReport.stale,false);assert.equal(before.report.analysis,undefined);
    assert.equal((await post('monitor/run')).status,200);
    const after=await(await fetch(base+'/api/status',{headers})).json();
    assert.equal(after.report.at,nextAt);assert.equal(after.report.analysisReport.sourceReportAt,firstAt);
    assert.equal(after.report.analysisReport.stale,true);assert.equal(after.lastSuccessfulRun.ok,true);
    assert.ok(after.workspace);assert.equal(after.monitorEnabled,false);
  }finally{
    if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    rmSync(dir,{recursive:true,force:true});
  }
});
