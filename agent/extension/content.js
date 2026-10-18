(() => {
  const C=globalThis.TBTMittanbudCore;
  const INPUT='textarea[data-testid="message-input"][placeholder="Skriv ditt svar her..."]';
  const SEND='button[data-testid="submit-button"][type="submit"]';
  const SENT='[data-testid="chat-message-wrapper-sent"]';
  const BUBBLE='[data-testid="chat-message"]';
  let route=null,intent=null,enabled=false,known=new WeakSet(),knownBubbles=new WeakSet(),fingerprints=new Set(),confirmation=null,confirmationTimer=null;
  const trustedInputs=new WeakMap();
  const shownResults=new Set();
  function visible(element){return !!(element?.isConnected&&element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden');}
  function textOf(wrapper){const bubble=wrapper.querySelector(BUBBLE);return bubble?C.normalizeText(bubble.innerText):'';}
  function remember(wrapper){known.add(wrapper);const bubble=wrapper.querySelector(BUBBLE);if(bubble)knownBubbles.add(bubble);const text=textOf(wrapper);if(text)fingerprints.add(text);}
  function synchronizeRoute(){const current=C.conversationURL(location.href);if(current?.conversationId===route?.conversationId)return !!current;route=current;intent=null;confirmation=null;clearTimeout(confirmationTimer);known=new WeakSet();knownBubbles=new WeakSet();fingerprints=new Set();if(route)document.querySelectorAll(SENT).forEach(remember);return !!route;}
  function composer(){return document.querySelector(INPUT);}
  function pendingIndicator(wrapper,input){const selector='[data-testid*="error"],[data-testid*="pending"],[data-testid*="sending"],[data-testid*="retry"],[aria-busy="true"]';return !!input?.disabled||(wrapper.matches(selector)&&visible(wrapper))||[...wrapper.querySelectorAll(selector)].some(visible);}
  function show(state,sourceKey=''){if(!C.resultLabels[state])return;const key=sourceKey+'|'+state;if(sourceKey&&shownResults.has(key))return;if(sourceKey){shownResults.add(key);if(shownResults.size>40)shownResults.delete(shownResults.values().next().value);}let box=document.getElementById('tbt-mittanbud-notice');if(!box){box=document.createElement('div');box.id='tbt-mittanbud-notice';box.setAttribute('role','status');Object.assign(box.style,{position:'fixed',bottom:'20px',right:'20px',zIndex:'2147483647',maxWidth:'340px',padding:'15px 18px',background:'#163b4b',color:'#fff',borderRadius:'10px',boxShadow:'0 4px 20px #0002',font:'14px/1.5 system-ui',whiteSpace:'normal'});document.body.append(box);}box.textContent='TBT: '+C.resultLabels[state];clearTimeout(box.tbtTimer);box.tbtTimer=setTimeout(()=>box.remove(),state==='created'||state==='duplicate'?7000:15000);}
  async function send(message){try{return await chrome.runtime.sendMessage(message);}catch{return null;}}
  function verifyInFreshTab(key){
    let candidate=null,stableWrapper=null,stableSince=0,checking=false,lastHeartbeat=0,finished=false,translationGuard=false;
    const started=Date.now();
    function preventTranslation(){if(translationGuard)return;translationGuard=true;const apply=()=>{if(!document.documentElement)return false;document.documentElement.setAttribute('translate','no');return true;};if(apply())return;const observer=new MutationObserver(()=>{if(apply())observer.disconnect();});observer.observe(document,{childList:true,subtree:true});}
    const tick=async()=>{if(checking||finished)return;checking=true;try{
      const current=C.conversationURL(location.href),query=new URL(location.href).searchParams.get('tbt_verify');
      if(!current||query!==key){finished=true;clearInterval(interval);return;}
      if(Date.now()-lastHeartbeat>=1000){lastHeartbeat=Date.now();const response=await send({type:'TBT_HEARTBEAT'});if(response?.verification?.sourceKey===key){candidate=response.verification;preventTranslation();}}
      if(Date.now()-started>50000||(candidate&&Date.now()>=candidate.expiresAt)){finished=true;clearInterval(interval);await send({type:'TBT_VERIFIED',sourceKey:key,found:false});return;}
      if(!candidate||document.readyState!=='complete'){stableWrapper=null;stableSince=0;return;}
      const field=document.querySelector(INPUT),wrapper=[...document.querySelectorAll(SENT)].find(item=>visible(item)&&textOf(item)===candidate.messageText&&!pendingIndicator(item,field));
      if(!wrapper){stableWrapper=null;stableSince=0;return;}
      if(wrapper!==stableWrapper){stableWrapper=wrapper;stableSince=Date.now();return;}
      if(Date.now()-stableSince>=2000){finished=true;clearInterval(interval);await send({type:'TBT_VERIFIED',sourceKey:key,found:true});}
    }finally{checking=false;}};
    const interval=setInterval(()=>tick().catch(()=>{}),500);tick().catch(()=>{});
  }
  async function updateStatus(){if(!synchronizeRoute())return;const status=await send({type:'TBT_HEARTBEAT'});enabled=!!(status?.enabled&&status?.hasToken);if(status?.lastResult&&status.lastResult.sourceKey===intent?.sourceKey)show(status.lastResult.state,status.lastResult.sourceKey);}
  function projectTitle(){const headings=[...document.querySelectorAll('h4')].filter(visible);if(headings.length!==1)return null;const title=C.normalizeText(headings[0].textContent).replace(/\s+/g,' ');return title&&title.length<=160&&!/[\x00-\x1f\x7f]/.test(title)?title:null;}
  function capture(input,event){if(!event.isTrusted||!enabled||!synchronizeRoute()||input!==composer()||input.disabled)return;const body=C.normalizeText(input.value);if(!body||body.length>C.MAX_TEXT||!C.hasDateCandidate(body))return;const userInput=trustedInputs.get(input);if(!userInput||userInput.text!==body)return;clearTimeout(confirmationTimer);confirmation=null;const title=projectTitle();intent={...route,messageText:body,sentAt:new Date().toISOString(),at:Date.now(),submitted:false,...(title?{projectTitle:title}:{})};}
  const verificationKey=new URL(location.href).searchParams.get('tbt_verify');
  if(verificationKey!==null){if(/^[a-f0-9]{64}$/.test(verificationKey)&&C.conversationURL(location.href))verifyInFreshTab(verificationKey);return;}
  document.addEventListener('input',event=>{if(!synchronizeRoute())return;if(event.isTrusted&&event.target instanceof HTMLTextAreaElement&&event.target.matches(INPUT))trustedInputs.set(event.target,{text:C.normalizeText(event.target.value),at:Date.now()});},true);
  document.addEventListener('click',event=>{if(!synchronizeRoute()||!event.isTrusted||!(event.target instanceof Element))return;const button=event.target.closest(SEND),input=composer();if(!button||button.disabled||!input)return;let area=input.parentElement,contains=false;for(let depth=0;area&&depth<10;depth++,area=area.parentElement){if(area.contains(button)){contains=true;break;}}if(contains)capture(input,event);},true);
  document.addEventListener('keydown',event=>{if(!synchronizeRoute())return;if(event.isTrusted&&event.target instanceof HTMLTextAreaElement&&event.target.matches(INPUT)&&event.key==='Enter'&&!event.shiftKey&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.isComposing){const button=document.querySelector(SEND);if(button&&!button.disabled)capture(event.target,event);}},true);
  function inspect(){if(!synchronizeRoute())return;const wrappers=[...document.querySelectorAll(SENT)];for(const wrapper of wrappers){if(known.has(wrapper))continue;const body=textOf(wrapper);if(!body)continue;if(knownBubbles.has(wrapper.querySelector(BUBBLE))){remember(wrapper);continue;}const matches=intent&&!intent.submitted&&Date.now()-intent.at<=C.INTENT_WINDOW_MS&&body===intent.messageText;
      if(!matches){remember(wrapper);continue;}
      wrapper.setAttribute('translate','no');
      if(fingerprints.has(body)){remember(wrapper);intent.submitted=true;show('history_match');continue;}
      if(confirmation&&confirmation.wrapper!==wrapper)continue;
      const input=composer();if(!C.canConfirm({intent,body,newSent:true,composerEmpty:!!input&&!C.normalizeText(input.value),wrapperPresent:visible(wrapper),pendingIndicator:pendingIndicator(wrapper,input)}))continue;
      if(confirmation)continue;confirmation={wrapper,intent};confirmationTimer=setTimeout(async()=>{const candidate=confirmation;confirmation=null;if(!candidate||candidate.intent!==intent||!enabled||!synchronizeRoute())return;const field=composer(),current=textOf(candidate.wrapper);if(!C.canConfirm({intent,body:current,newSent:!known.has(candidate.wrapper),composerEmpty:!!field&&!C.normalizeText(field.value),wrapperPresent:visible(candidate.wrapper),pendingIndicator:pendingIndicator(candidate.wrapper,field)})){remember(candidate.wrapper);return;}
        intent.submitted=true;remember(candidate.wrapper);const source={conversationId:intent.conversationId,url:intent.url,messageText:intent.messageText,sentAt:intent.sentAt,...(intent.projectTitle?{projectTitle:intent.projectTitle}:{})};const sourceKey=await C.sourceKey(source);intent.sourceKey=sourceKey;const response=await send({type:'TBT_OBSERVE',source,sourceKey});if(response?.state)show(response.state,sourceKey);
      },3000);
    }}
  const observer=new MutationObserver(inspect);
  chrome.runtime.onMessage.addListener((message,sender)=>{if(sender.id!==chrome.runtime.id)return;if(message?.type==='TBT_RESULT'&&message.sourceKey===intent?.sourceKey&&C.resultLabels[message.state])show(message.state,message.sourceKey);if(message?.type==='TBT_SETTINGS'){enabled=!!(message.enabled&&message.hasToken);if(!enabled){intent=null;confirmation=null;clearTimeout(confirmationTimer);}}});
  function start(){synchronizeRoute();observer.observe(document.body,{childList:true,subtree:true,characterData:true});updateStatus();setInterval(()=>{updateStatus();inspect();},20000);}
  if(document.body)start();else document.addEventListener('DOMContentLoaded',start,{once:true});
})();
