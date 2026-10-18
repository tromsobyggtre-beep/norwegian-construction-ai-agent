import {hash} from './core.mjs';
import {osloDateTime} from './workspace.mjs';

const OSLO='Europe/Oslo';
const MINUTE=60000;
const MAX_IMPORTS=1000;
const CALENDAR_ID='tromsobyggtre@gmail.com';
const CALENDAR=`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const escapeHtml=value=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const plainText=(value,max,name)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw fail(`Nieprawidłowe pole: ${name}.`);
  return value.trim();
};
function clock(now) {
  const value=Number(now);
  if(!Number.isFinite(value))throw fail('Nieprawidłowy czas obserwacji.');
  return value;
}
function rfc3339(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))return NaN;
  const day=Date.parse(value.slice(0,10)+'T00:00:00Z');
  if(!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==value.slice(0,10))return NaN;
  return Date.parse(value);
}
function calendarLimit(now) {
  const current=new Date(now),target=new Date(now);
  target.setUTCDate(1);target.setUTCMonth(target.getUTCMonth()+18);
  const lastDay=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  target.setUTCDate(Math.min(current.getUTCDate(),lastDay));
  return target.getTime();
}
function localTime(time) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:OSLO,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(time).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const eventId=(observation,appointment)=>hash({source:'mittanbud',conversationId:observation.conversationId,kind:appointment.kind,start:appointment.start,end:appointment.end});

export function validateObservation(input,now=Date.now()) {
  const timestamp=clock(now);
  if(!record(input))throw fail('Brak obserwacji wysłanej wiadomości Mittanbud.');
  const conversationId=typeof input.conversationId==='number'&&Number.isSafeInteger(input.conversationId)?String(input.conversationId):input.conversationId;
  if(typeof conversationId!=='string'||! /^[1-9]\d{0,19}$/.test(conversationId))throw fail('Nieprawidłowy identyfikator rozmowy Mittanbud.');
  let url;
  try {url=new URL(input.url);}catch {throw fail('Nieprawidłowy adres rozmowy Mittanbud.');}
  if(url.protocol!=='https:'||url.hostname!=='minbedrift.mittanbud.no'||url.port||url.username||url.password||!new RegExp(`^/meldinger/${conversationId}/?$`).test(url.pathname))throw fail('Adres nie wskazuje właściwej rozmowy Mittanbud.');
  const messageText=plainText(input.messageText,8000,'wysłana wiadomość');
  const sent=rfc3339(input.sentAt);
  if(!Number.isFinite(sent)||sent>timestamp+5*MINUTE||sent<timestamp-24*60*MINUTE)throw fail('Data potwierdzonej wysyłki musi pochodzić z ostatnich 24 godzin.');
  const projectTitle=Object.hasOwn(input,'projectTitle')?plainText(input.projectTitle,160,'tytuł pracy'):undefined;
  const result={conversationId,url:`https://minbedrift.mittanbud.no/meldinger/${conversationId}`,messageText,sentAt:new Date(sent).toISOString(),...(projectTitle?{projectTitle}:{})};
  return {...result,sourceHash:hash(result)};
}

export function normalizeAppointment(observation,extraction,settings={visitMinutes:30},now=Date.now()) {
  const timestamp=clock(now),source=validateObservation(observation,timestamp);
  if(!record(extraction)||!['visit','project'].includes(extraction.kind))throw fail('Nie rozpoznano rodzaju terminu: wizyta albo realizacja.');
  if(extraction.certainty!=='clear')throw fail('Termin nie jest jednoznaczny. Uzupełnij lub potwierdź go ręcznie.');
  const evidence=plainText(extraction.evidence,2000,'fragment potwierdzający termin');
  if(!source.messageText.includes(evidence))throw fail('Fragment potwierdzający termin nie występuje w wysłanej wiadomości.');
  const pattern=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  if(typeof extraction.startLocal!=='string'||!pattern.test(extraction.startLocal))throw fail('Termin wymaga dokładnej daty i godziny w Norwegii.');
  const start=osloDateTime(extraction.startLocal),startTime=Date.parse(start);
  let end,endWasDefaulted=false,visitMinutes;
  if(extraction.endLocal==null) {
    if(extraction.kind!=='visit')throw fail('Realizacja wymaga określenia końca. Nie przypisano jej czasu trwania wizyty.');
    visitMinutes=settings?.visitMinutes;
    if(!Number.isInteger(visitMinutes)||visitMinutes<1||visitMinutes>480)throw fail('Nieprawidłowy domyślny czas wizyty.');
    end=new Date(startTime+visitMinutes*MINUTE).toISOString();endWasDefaulted=true;
  } else {
    if(typeof extraction.endLocal!=='string'||!pattern.test(extraction.endLocal))throw fail('Koniec terminu wymaga dokładnej daty i godziny w Norwegii.');
    end=osloDateTime(extraction.endLocal);
  }
  const endTime=Date.parse(end),limit=calendarLimit(timestamp);
  if(startTime<=timestamp||endTime<=startTime)throw fail('Termin musi być przyszły, a koniec późniejszy od początku.');
  if(startTime>limit||endTime>limit)throw fail('Automatyczny termin nie może wykraczać poza najbliższe 18 miesięcy.');
  const summary=plainText(extraction.summary,200,'tytuł terminu');
  const location=extraction.location==null?null:plainText(extraction.location,500,'miejsce');
  const appointment={kind:extraction.kind,start,end,startLocal:extraction.startLocal,endLocal:endWasDefaulted?localTime(endTime):extraction.endLocal,endWasDefaulted,...(endWasDefaulted?{visitMinutes}:{}),summary,location,evidence,sourceHash:source.sourceHash};
  return {...appointment,eventId:eventId(source,appointment)};
}

const responseStatus=error=>Number(error?.response?.status||error?.status||error?.code);
function eventMatches(event,source,appointment) {
  const privateData=event?.extendedProperties?.private;
  return record(event)&&event.id===appointment.eventId&&['confirmed','tentative'].includes(event.status)&&privateData?.tbtSource==='mittanbud'&&privateData.tbtConversation===source.conversationId&&privateData.tbtKind===appointment.kind&&Date.parse(event.start?.dateTime)===Date.parse(appointment.start)&&Date.parse(event.end?.dateTime)===Date.parse(appointment.end);
}
function eventUrl(event) {
  try {
    const url=new URL(event?.htmlLink);
    return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&(url.hostname==='calendar.google.com'||url.hostname==='www.google.com'&&url.pathname.startsWith('/calendar/'))?url.href:undefined;
  } catch {return undefined;}
}
function save(store,item,auditEvent) {
  store.data.mittanbudImports[item.eventId]=item;
  if(typeof store.audit==='function')store.audit(auditEvent,item.eventId);
  else store.save();
  return structuredClone(item);
}
function sameSavedAppointment(saved,source,appointment) {
  return saved.source?.conversationId===source.conversationId&&saved.appointment?.kind===appointment.kind&&saved.appointment.start===appointment.start&&saved.appointment.end===appointment.end;
}
function validateNormalized(source,appointment,now) {
  if(!record(appointment)||appointment.sourceHash!==source.sourceHash||!['visit','project'].includes(appointment.kind)||!Number.isFinite(rfc3339(appointment.start))||!Number.isFinite(rfc3339(appointment.end))||Date.parse(appointment.start)<=now||Date.parse(appointment.end)<=Date.parse(appointment.start)||Date.parse(appointment.end)>calendarLimit(now)||appointment.eventId!==eventId(source,appointment))throw fail('Nieprawidłowa lub zmieniona propozycja terminu Mittanbud.');
  plainText(appointment.summary,200,'tytuł terminu');
  if(appointment.location!=null)plainText(appointment.location,500,'miejsce');
  const evidence=plainText(appointment.evidence,2000,'fragment potwierdzający termin');
  if(!source.messageText.includes(evidence))throw fail('Niepotwierdzone źródło terminu Mittanbud.');
}

async function importOne(store,google,observation,appointment,now) {
  const timestamp=clock(now),source=validateObservation(observation,timestamp);
  validateNormalized(source,appointment,timestamp);
  if(!record(store?.data)||typeof store.save!=='function'||typeof google?.request!=='function')throw fail('Nieprawidłowa konfiguracja importu.',500);
  if(store.data.mittanbudImports==null)store.data.mittanbudImports={};
  if(!record(store.data.mittanbudImports))throw fail('Magazyn importu wymaga ręcznego sprawdzenia.',500);
  const existing=store.data.mittanbudImports[appointment.eventId];
  if(existing&&!sameSavedAppointment(existing,source,appointment))throw fail('Identyfikator importu jest już przypisany do innego terminu. Sprawdź go ręcznie.',409);
  if(!existing&&Object.keys(store.data.mittanbudImports).length>=MAX_IMPORTS)throw fail('Osiągnięto limit 1000 importów Mittanbud. Potrzebna jest świadoma archiwizacja.',409);
  let item=existing?structuredClone(existing):{id:appointment.eventId,eventId:appointment.eventId,status:'checking',sourceHash:source.sourceHash,source:{conversationId:source.conversationId,url:source.url,sentAt:source.sentAt},appointment:structuredClone(appointment),createdAt:new Date(timestamp).toISOString(),writeAttempted:false};
  const initialStatus=item.status;
  if(['completed','uncertain','executing'].includes(initialStatus))item.writeAttempted=true;
  const update=(status,reason,event)=>{
    item={...item,status,reason,writeAttempted:item.writeAttempted||status==='executing'||status==='completed',updatedAt:new Date(timestamp).toISOString(),...(eventUrl(event)?{eventUrl:eventUrl(event)}:{})};
    return save(store,item,'mittanbud_import_'+status);
  };
  if(!existing)save(store,item,'mittanbud_import_received');
  const lookup=async()=>{
    try {return await google.request(`${CALENDAR}/${appointment.eventId}`);}catch(error){if(responseStatus(error)===404)return null;throw error;}
  };
  let found;
  try {found=await lookup();}catch(error){update(item.writeAttempted?'uncertain':'blocked',item.writeAttempted?'Nie udało się sprawdzić wcześniejszego wpisu Google. Sprawdź kalendarz ręcznie.':'Nie udało się sprawdzić istniejącego wpisu Google. Niczego nie zapisano.');throw error;}
  if(found) {
    if(!eventMatches(found,source,appointment)) {
      update('blocked','Wpis o tym identyfikatorze ma inne źródło, zakres albo został anulowany. Nie nadpisano go.');
      throw fail('Istniejący wpis kalendarza nie odpowiada temu importowi. Sprawdź go ręcznie.',409);
    }
    return update('completed','Termin już istnieje w kalendarzu. Nie utworzono drugiego wpisu.',found);
  }
  if(initialStatus==='completed')return update('blocked','Poprzednio zapisany termin nie istnieje już w kalendarzu. Nie odtworzono go automatycznie.');
  if(item.writeAttempted)return update('uncertain','Poprzedni zapis ma niepewny wynik. Sprawdź kalendarz ręcznie przed ponowną próbą.');
  let busy;
  try {busy=await google.request('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',data:{timeMin:appointment.start,timeMax:appointment.end,items:[{id:CALENDAR_ID}]}});}catch(error){update('blocked','Nie udało się sprawdzić dostępności kalendarza. Niczego nie zapisano.');throw error;}
  const calendar=busy?.calendars?.[CALENDAR_ID];
  if(!record(calendar)||calendar.errors&&(!Array.isArray(calendar.errors)||calendar.errors.length)||!Array.isArray(calendar.busy)) {
    update('blocked','Nie potwierdzono dostępności kalendarza. Niczego nie zapisano.');
    throw fail('Google nie potwierdziło dostępności terminu.',502);
  }
  if(calendar.busy.length)return update('blocked','Termin koliduje z kalendarzem. Wybierz dalsze działanie ręcznie.');
  const payload={id:appointment.eventId,summary:appointment.summary,description:`Termin wysłany klientowi; akceptacja klienta nie została potwierdzona.\n\nFragment: ${escapeHtml(appointment.evidence.slice(0,700))}\nRozmowa: ${source.url}\nŹródło: ${source.sourceHash}`,...(appointment.location?{location:appointment.location}:{}),start:{dateTime:appointment.start,timeZone:OSLO},end:{dateTime:appointment.end,timeZone:OSLO},status:'tentative',visibility:'private',transparency:'opaque',extendedProperties:{private:{tbtSource:'mittanbud',tbtConversation:source.conversationId,tbtKind:appointment.kind,tbtSourceHash:source.sourceHash}}};
  update('executing','Trwa zapis terminu w Google.');
  try {
    const created=await google.request(CALENDAR,{method:'POST',params:{sendUpdates:'none'},data:payload});
    if(!eventMatches(created,source,appointment))return update('uncertain','Google nie zwróciło jednoznacznego potwierdzenia terminu. Sprawdź kalendarz ręcznie.');
    return update('completed','Termin zapisano w kalendarzu.',created);
  } catch(error) {
    if(responseStatus(error)===409) {
      try {
        const result=await lookup();
        if(result&&eventMatches(result,source,appointment))return update('completed','Termin już istnieje w kalendarzu. Nie utworzono drugiego wpisu.',result);
      }catch {}
    }
    return update('uncertain','Nie potwierdzono wyniku zapisu. Sprawdź kalendarz ręcznie; automatyczne ponowienie zapisu jest wyłączone.');
  }
}

let importsQueue=Promise.resolve();
export function importAppointment(store,google,observation,appointment,now=Date.now()) {
  const operation=importsQueue.then(()=>importOne(store,google,observation,appointment,now));
  importsQueue=operation.catch(()=>{});
  return operation;
}
