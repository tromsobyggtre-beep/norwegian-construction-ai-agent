import './shared.js';
const C=globalThis.TBTMittanbudCore,STORE='tbtMittanbudV1';
let cached=null,loading=null,draining=false,verifying=false,lane=Promise.resolve(),timer=null,verifyTimer=null;
function lock(fn){const run=lane.then(fn,fn);lane=run.catch(()=>{});return run;}
async function state(){
  if(cached)return cached;
  if(!loading)loading=(async()=>{
    await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    const raw=(await chrome.storage.local.get(STORE))[STORE]||{};
    const valid=item=>item&&/^[a-f0-9]{64}$/.test(item.sourceKey||'')&&item.source;
    const oldQueue=Array.isArray(raw.queue)?raw.queue.filter(valid):[];
    const jobs=Array.isArray(raw.verifications)?raw.verifications.filter(valid):[];
    for(const item of oldQueue)if(!item.verifiedAt&&!jobs.some(x=>x.sourceKey===item.sourceKey))jobs.push({sourceKey:item.sourceKey,source:item.source,originTabId:item.tabId,status:'waiting',createdAt:Date.now()});
    cached={config:{enabled:raw.config?.enabled===true,token:typeof raw.config?.token==='string'?raw.config.token:''},queue:oldQueue.filter(x=>Number.isFinite(x.verifiedAt)).slice(0,C.MAX_QUEUE),verifications:jobs.slice(0,C.MAX_QUEUE),history:Array.isArray(raw.history)?raw.history.slice(0,20):[]};
    cached.verifications=cached.verifications.slice(0,Math.max(0,C.MAX_QUEUE-cached.queue.length));
    for(const item of cached.queue)if(item.status==='working')item.status='pending';
    return cached;
  })();
  return loading;
}
async function save(){await chrome.storage.local.set({[STORE]:cached});}
function publicStatus(s){const latest=s.history[0];return {enabled:s.config.enabled,hasToken:!!s.config.token,pending:s.queue.length+s.verifications.length,verifying:s.verifications.length,blocked:s.queue.filter(x=>x.status==='blocked').length,visitMinutes:30,lastResult:latest?{state:latest.state,at:latest.at,sourceKey:latest.sourceKey}:null};}
function remember(s,key,result){s.history.unshift({sourceKey:key,state:result,at:new Date().toISOString()});s.history=s.history.slice(0,20);}
async function badge(){const s=await state(),count=s.queue.length+s.verifications.length,warning=['uncertain','conflict','ambiguous','failed','not_verified'].includes(s.history[0]?.state);await chrome.action.setBadgeText({text:!s.config.enabled?'OFF':count?String(count):warning?'!':''});await chrome.action.setBadgeBackgroundColor({color:warning?'#9b5630':'#096f76'});}
function popupSender(sender){return sender.id===chrome.runtime.id&&!sender.tab&&sender.url===chrome.runtime.getURL('popup.html');}
function contentSender(sender){return sender.id===chrome.runtime.id&&sender.tab&&sender.frameId===0&&C.conversationURL(sender.url);}
async function notify(item,result){const tabId=item.originTabId??item.tabId;if(!Number.isInteger(tabId))return;try{await chrome.tabs.sendMessage(tabId,{type:'TBT_RESULT',state:result,sourceKey:item.sourceKey});}catch{}}
async function broadcast(){const s=await state();try{const tabs=await chrome.tabs.query({url:C.MITTANBUD_ORIGIN+'/*'});for(const tab of tabs)if(Number.isInteger(tab.id)&&C.conversationURL(tab.url))await chrome.tabs.sendMessage(tab.id,{type:'TBT_SETTINGS',enabled:s.config.enabled,hasToken:!!s.config.token}).catch(()=>{});}catch{}}
async function closeVerification(item){if(!Number.isInteger(item.tabId))return;try{const tab=await chrome.tabs.get(item.tabId);if((tab.pendingUrl||tab.url)===C.verificationURL(item.source,item.sourceKey))await chrome.tabs.remove(item.tabId);}catch{}}
async function request(path,token,body){let response;try{response=await fetch(C.TBT_ORIGIN+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(25000),credentials:'omit',cache:'no-store',redirect:'error',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}catch{return {status:0,retry:true};}let data;try{data=await response.json();}catch{return {status:response.status,retry:C.retryable(response.status),invalid:true};}return {status:response.status,ok:response.ok,data,retry:C.retryable(response.status)};}
function schedule(ms){clearTimeout(timer);timer=setTimeout(()=>drain().catch(()=>{}),Math.max(500,Math.min(ms,20000)));}
function scheduleVerification(ms){clearTimeout(verifyTimer);verifyTimer=setTimeout(()=>pumpVerifications().catch(()=>{}),Math.max(500,Math.min(ms,20000)));}

async function pumpVerifications(){
  if(verifying)return;verifying=true;
  try{
    const expired=await lock(async()=>{const s=await state(),items=s.verifications.filter(x=>!s.config.enabled||!s.config.token||(x.status!=='waiting'&&Number(x.expiresAt||0)<=Date.now()));if(items.length){const keys=new Set(items.map(x=>x.sourceKey));s.verifications=s.verifications.filter(x=>!keys.has(x.sourceKey));for(const item of items)remember(s,item.sourceKey,'not_verified');await save();}return items;});
    for(const item of expired){await closeVerification(item);await notify(item,'not_verified');}
    const job=await lock(async()=>{const s=await state();if(!s.config.enabled||!s.config.token)return null;const active=s.verifications.find(x=>x.status==='opening'||x.status==='verifying');if(active){scheduleVerification(active.expiresAt-Date.now());return null;}const item=s.verifications.find(x=>x.status==='waiting');if(!item)return null;item.status='opening';item.expiresAt=Date.now()+C.VERIFY_WINDOW_MS;await save();return {...item};});
    if(job){
      let tab;
      try{
        tab=await chrome.tabs.create({url:C.verificationURL(job.source,job.sourceKey),active:false});
        if(!Number.isInteger(tab.id))throw Error('Missing verification tab');
        const stored=await lock(async()=>{const s=await state(),item=s.verifications.find(x=>x.sourceKey===job.sourceKey);if(!item||!s.config.enabled||!s.config.token)return false;item.tabId=tab.id;item.status='verifying';await save();scheduleVerification(item.expiresAt-Date.now());return true;});
        if(!stored)await closeVerification({...job,tabId:tab.id});
      }catch{
        await lock(async()=>{const s=await state();s.verifications=s.verifications.filter(x=>x.sourceKey!==job.sourceKey);remember(s,job.sourceKey,'not_verified');await save();});
        if(Number.isInteger(tab?.id))await closeVerification({...job,tabId:tab.id});await notify(job,'not_verified');scheduleVerification(500);
      }
    }
    await badge();
  }finally{verifying=false;}
}
async function verified(message,sender){
  const result=await lock(async()=>{const s=await state(),item=s.verifications.find(x=>x.sourceKey===message.sourceKey);if(!C.verificationSender(item,sender,chrome.runtime.id)||typeof message.found!=='boolean')return {error:'Nieprawidłowe potwierdzenie źródła.'};s.verifications=s.verifications.filter(x=>x.sourceKey!==item.sourceKey);if(message.found===true&&s.config.enabled&&s.config.token){s.queue.push({sourceKey:item.sourceKey,source:item.source,tabId:item.originTabId,verifiedAt:Date.now(),status:'pending',attempts:0,nextAttemptAt:Date.now()});await save();return {state:'queued',item};}remember(s,item.sourceKey,'not_verified');await save();return {state:'not_verified',item};});
  if(result.item){await closeVerification(result.item);await notify(result.item,result.state);await badge();pumpVerifications().catch(()=>{});if(result.state==='queued')drain().catch(()=>{});}
  return result.error?{error:result.error}:{state:result.state};
}
async function drain(){
  if(draining)return;draining=true;
  try{
    for(;;){
      const job=await lock(async()=>{const s=await state();if(!s.config.enabled||!s.config.token)return null;const item=s.queue.find(x=>x.status==='pending'&&Number.isFinite(x.verifiedAt)&&Number(x.nextAttemptAt||0)<=Date.now());if(!item)return null;item.status='working';item.attempts=Number(item.attempts||0)+1;await save();return {item:{...item},token:s.config.token};});
      if(!job)break;
      const response=await request('/api/mittanbud/observe',job.token,{source:job.item.source,sourceKey:job.item.sourceKey});let outcome;
      await lock(async()=>{const s=await state(),item=s.queue.find(x=>x.sourceKey===job.item.sourceKey);if(!item)return;
        if(response.ok&&response.data&&['created','duplicate','conflict','ambiguous','ignored','uncertain'].includes(response.data.state)){outcome=response.data.state;s.queue=s.queue.filter(x=>x.sourceKey!==item.sourceKey);remember(s,item.sourceKey,outcome);}
        else if(response.status===401||response.status===403){item.status='blocked';outcome='blocked';}
        else if(response.retry&&item.attempts<C.MAX_ATTEMPTS){item.status='pending';item.nextAttemptAt=Date.now()+C.retryDelay(item.attempts);outcome='queued';}
        else{outcome=response.ok||response.status===0?'uncertain':'failed';s.queue=s.queue.filter(x=>x.sourceKey!==item.sourceKey);remember(s,item.sourceKey,outcome);}await save();
      });
      if(outcome)await notify(job.item,outcome);await badge();
    }
    const s=await state(),pending=s.queue.filter(x=>x.status==='pending');if(s.config.enabled&&pending.length)schedule(Math.min(...pending.map(x=>Number(x.nextAttemptAt||Date.now())))-Date.now());
  }finally{draining=false;}
}
async function observe(message,sender){
  const source=C.validateSource(message.source);
  if(new URL(sender.url).searchParams.has('tbt_verify')||!source||!C.sourceMatchesSender(source,sender.url)||!/^[a-f0-9]{64}$/.test(message.sourceKey||'')||await C.sourceKey(source)!==message.sourceKey)return {error:'Nieprawidłowe źródło wiadomości.'};
  const result=await lock(async()=>{const s=await state();if(!s.config.enabled||!s.config.token)return {state:'blocked'};const previous=s.history.find(x=>x.sourceKey===message.sourceKey);if(previous)return {state:previous.state};if(s.queue.some(x=>x.sourceKey===message.sourceKey))return {state:'queued'};if(s.verifications.some(x=>x.sourceKey===message.sourceKey))return {state:'verifying'};if(s.queue.length+s.verifications.length>=C.MAX_QUEUE)return {state:'queue_full'};s.verifications.push({sourceKey:message.sourceKey,source,originTabId:sender.tab.id,status:'waiting',createdAt:Date.now()});await save();return {state:'verifying'};});
  await badge();pumpVerifications().catch(()=>{});return result;
}
async function cancelVerifications(){const items=await lock(async()=>{const s=await state(),items=s.verifications.splice(0);for(const item of items)remember(s,item.sourceKey,'not_verified');await save();return items;});for(const item of items){await closeVerification(item);await notify(item,'not_verified');}}
async function handle(message,sender){
  if(!message||typeof message!=='object')return {error:'Nieprawidłowe polecenie.'};
  if(contentSender(sender)){
    if(message.type==='TBT_VERIFIED')return verified(message,sender);
    if(message.type==='TBT_HEARTBEAT'){await pumpVerifications();const s=await state(),job=s.verifications.find(x=>C.verificationSender(x,sender,chrome.runtime.id));if(job)return {enabled:false,hasToken:false,verification:{sourceKey:job.sourceKey,messageText:job.source.messageText,expiresAt:job.expiresAt}};if(new URL(sender.url).searchParams.has('tbt_verify'))return {enabled:false,hasToken:false,verificationDone:true};drain().catch(()=>{});return publicStatus(s);}
    if(message.type==='TBT_OBSERVE')return observe(message,sender);
    return {error:'Niedozwolone polecenie.'};
  }
  if(!popupSender(sender))return {error:'Niedozwolone źródło.'};
  if(message.type==='TBT_POPUP_STATUS'){await pumpVerifications();drain().catch(()=>{});return publicStatus(await state());}
  if(message.type==='TBT_SAVE_SETTINGS'){
    const result=await lock(async()=>{const s=await state();if(typeof message.enabled!=='boolean')return {error:'Wybierz ustawienie automatyzacji.'};const newToken=typeof message.token==='string'?message.token.trim():'';if(newToken&&(newToken.length<32||newToken.length>512||!/^[\x21-\x7e]+$/.test(newToken)))return {error:'Wklej pełny ograniczony token TBT.'};if(newToken)s.config.token=newToken;if(message.enabled&&!s.config.token)return {error:'Dodaj ograniczony token TBT przed włączeniem.'};s.config.enabled=message.enabled;if(newToken)for(const item of s.queue)if(item.status==='blocked'){item.status='pending';item.nextAttemptAt=Date.now();item.attempts=0;}await save();return publicStatus(s);});
    if(!result.error&&!message.enabled)await cancelVerifications();await badge();await broadcast();pumpVerifications().catch(()=>{});drain().catch(()=>{});return result.error?result:publicStatus(await state());
  }
  if(message.type==='TBT_REMOVE_TOKEN'){await lock(async()=>{const s=await state();s.config={enabled:false,token:''};s.queue=[];await save();});await cancelVerifications();await badge();await broadcast();return publicStatus(await state());}
  if(message.type==='TBT_TEST_CONNECTION'){const s=await state();if(!s.config.token)return {error:'Najpierw zapisz ograniczony token TBT.'};const result=await request('/api/mittanbud/status',s.config.token);if(!result.ok||result.data?.ok!==true)return {error:result.status===401||result.status===403?'Token nie ma dostępu do tej integracji. Wklej ograniczony token Mittanbud.':'Brak poprawnej odpowiedzi TBT. Sprawdź połączenie i spróbuj ponownie.'};if(result.data.enabled!==true)return {error:'Połączenie odpowiada, ale integracja Mittanbud jest wyłączona na serwerze TBT. Włącz ją w konfiguracji TBT.'};return {ok:true,visitMinutes:result.data.visitMinutes===30?30:null};}
  return {error:'Niedozwolone polecenie.'};
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{handle(message,sender).then(sendResponse).catch(()=>sendResponse({error:'Nie udało się obsłużyć operacji. Spróbuj ponownie.'}));return true;});
chrome.tabs.onRemoved.addListener(tabId=>{lock(async()=>{const s=await state(),item=s.verifications.find(x=>x.tabId===tabId);if(!item)return null;s.verifications=s.verifications.filter(x=>x.sourceKey!==item.sourceKey);remember(s,item.sourceKey,'not_verified');await save();return item;}).then(async item=>{if(item){await notify(item,'not_verified');await badge();pumpVerifications().catch(()=>{});}}).catch(()=>{});});
function wake(){state().then(badge).then(pumpVerifications).then(drain).catch(()=>{});}
chrome.runtime.onStartup.addListener(wake);chrome.runtime.onInstalled.addListener(wake);wake();
