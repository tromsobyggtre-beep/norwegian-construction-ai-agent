import './shared.js';
const C=globalThis.TBTMittanbudCore,$=id=>document.getElementById(id);
let busy=false;
function message(value,error=false){$('message').textContent=value;$('message').classList.toggle('error',error);$('message').hidden=false;}
function render(s){$('enabled').checked=s.enabled;$('mode').textContent=s.enabled?'Włączona':'Wyłączona';$('tokenState').textContent=s.hasToken?'Zapisany w tym profilu Chrome':'Brak';$('token').placeholder=s.hasToken?'Token zapisany · wklej nowy, aby zmienić':'Wklej token integracji';$('pending').textContent=String(s.pending||0)+(s.verifying?' · '+s.verifying+' weryfikacja wysyłki':'')+(s.blocked?' · '+s.blocked+' wymaga tokenu':'');$('latest').textContent=s.lastResult?C.resultLabels[s.lastResult.state]||'Sprawdź panel TBT.':'Jeszcze brak';}
async function send(payload){const result=await chrome.runtime.sendMessage(payload);if(result?.error)throw Error(result.error);if(!result)throw Error('Wtyczka nie odpowiedziała. Otwórz jej okno ponownie.');return result;}
async function safe(fn){if(busy)return;busy=true;$('message').hidden=true;document.querySelectorAll('button,input').forEach(e=>e.disabled=true);try{await fn();}catch(e){message(e.message||'Nie udało się wykonać operacji.',true);}finally{busy=false;document.querySelectorAll('button,input').forEach(e=>e.disabled=false);}}
$('settings').addEventListener('submit',e=>{e.preventDefault();const payload={type:'TBT_SAVE_SETTINGS',enabled:$('enabled').checked,token:$('token').value};safe(async()=>{const result=await send(payload);$('token').value='';render(result);message('Ustawienia zapisane.');});});
$('test').addEventListener('click',()=>safe(async()=>{const result=await send({type:'TBT_TEST_CONNECTION'});message(result.visitMinutes===30?'Połączenie działa. Domyślna wizyta: 30 minut.':'Połączenie działa.');}));
$('refresh').addEventListener('click',()=>safe(async()=>render(await send({type:'TBT_POPUP_STATUS'}))));
$('remove').addEventListener('click',()=>safe(async()=>{if(!confirm('Usunąć token, wyłączyć integrację i usunąć oczekujące wpisy z lokalnej kolejki?'))return;render(await send({type:'TBT_REMOVE_TOKEN'}));$('token').value='';message('Token usunięty. Integracja wyłączona.');}));
safe(async()=>render(await send({type:'TBT_POPUP_STATUS'})));
