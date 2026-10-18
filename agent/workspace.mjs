const HOUR=60*60*1000;
const OSLO='Europe/Oslo';
const LIMITS={mail:30,events:50,files:50};
const arr=value=>Array.isArray(value)?value:[];
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const clean=(value,max=1000)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max):'';
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u0020\u007f]/.test(value);
const safeId=value=>validId(value)?value:null;

function googleUrl(value) {
  if(typeof value!=='string'||value.length>3000)return undefined;
  try {
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.port)return undefined;
    const allowed=['mail.google.com','calendar.google.com','drive.google.com','docs.google.com'];
    if(!allowed.includes(url.hostname)&&!(url.hostname==='www.google.com'&&url.pathname.startsWith('/calendar/')))return undefined;
    return url.href;
  } catch {return undefined;}
}

function validDay(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const time=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;
}

function zonedParts(time,timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(time).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}

// Convert wall-clock time explicitly, so the host timezone cannot change dates.
function wallTime(value,timeZone=OSLO) {
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if(!match||!validDay(match[1])||+match[2]>23||+match[3]>59||+match[4]>59)return NaN;
  const milliseconds=+(match[5]||'0').padEnd(3,'0');
  const target=Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`)+milliseconds;
  let time=target;
  try {
    for(let i=0;i<4;i++) {
      const p=zonedParts(time,timeZone);
      const rendered=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)+milliseconds;
      const difference=target-rendered;
      if(!difference)return time;
      time+=difference;
    }
  } catch {}
  return NaN;
}

export function osloDateTime(value) {
  const invalid=()=>Object.assign(new Error('Podaj prawidłową datę i godzinę w czasie norweskim (Europe/Oslo).'),{status:400});
  const match=typeof value==='string'&&/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if(!match||!validDay(match[1])||+match[2]>23||+match[3]>59||+(match[4]||0)>59)throw invalid();
  const normalized=`${match[1]}T${match[2]}:${match[3]}:${match[4]||'00'}`;
  const target=Date.parse(normalized+'Z'),offsets=new Set(),matches=new Set();
  // Derive both sides of a clock change from the timezone database, rather
  // than assuming Oslo must always use a fixed one- or two-hour offset.
  for(const hours of [-48,-24,0,24,48]) {
    const sampled=target+hours*HOUR,p=zonedParts(sampled,OSLO);
    const rendered=Date.parse(`${p.year.padStart(4,'0')}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if(Number.isFinite(rendered))offsets.add(rendered-sampled);
  }
  for(const offset of offsets) {
    const candidate=target-offset,p=zonedParts(candidate,OSLO);
    const local=`${p.year.padStart(4,'0')}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    if(local===normalized)matches.add(candidate);
  }
  if(!matches.size)throw Object.assign(new Error('Ta godzina nie istnieje w Norwegii z powodu wiosennej zmiany czasu. Wybierz inną godzinę.'),{status:400});
  if(matches.size>1)throw Object.assign(new Error('Ta godzina występuje dwa razy podczas jesiennej zmiany czasu w Norwegii. Wybierz inną godzinę.'),{status:400});
  return new Date([...matches][0]).toISOString();
}

function eventTime(value) {
  if(!record(value))return NaN;
  if(value.date)return validDay(value.date)?wallTime(value.date+'T00:00:00',OSLO):NaN;
  if(typeof value.dateTime!=='string')return NaN;
  const dateTime=value.dateTime;
  if(!validDay(dateTime.slice(0,10)))return NaN;
  if(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(dateTime))return Date.parse(dateTime);
  return typeof value.timeZone==='string'?wallTime(dateTime,value.timeZone):NaN;
}

function upcoming(report,now) {
  const seen=new Set();
  return arr(report?.events).slice(0,LIMITS.events).flatMap(event=>{
    if(!record(event)||event.status!=='confirmed'||!safeId(event.id)||seen.has(event.id))return [];
    seen.add(event.id);
    const start=eventTime(event.start),allDay=!!event.start?.date;
    if(!Number.isFinite(start)||start>=now+48*HOUR)return [];
    if(allDay) {
      const nextDay=new Date(Date.parse(event.start.date+'T00:00:00Z')+24*HOUR).toISOString().slice(0,10);
      const end=event.end?.date?eventTime(event.end):wallTime(nextDay+'T00:00:00',OSLO);
      if(!Number.isFinite(end)||end<=start||end<=now)return [];
    } else if(start<now)return [];
    return [{event,start,allDay}];
  }).sort((a,b)=>a.start-b.start);
}

function unread(report) {
  const seen=new Set();
  return arr(report?.messages).slice(0,LIMITS.mail).filter(message=>{
    if(!record(message)||!safeId(message.id)||seen.has(message.id))return false;
    seen.add(message.id);
    const labels=arr(message.labels);
    return labels.includes('INBOX')&&labels.includes('UNREAD')&&!labels.includes('CATEGORY_PROMOTIONS')&&!labels.includes('CATEGORY_SOCIAL');
  });
}

export function workspace(data,now=Date.now()) {
  const timestamp=Number(now);
  if(!Number.isFinite(timestamp))throw new TypeError('Nieprawidłowy czas przeglądu');
  const actions=arr(data?.actions).filter(action=>record(action)&&safeId(action.id));
  const pending=actions.filter(action=>action.state==='pending');
  const uncertain=actions.filter(action=>action.state==='uncertain');
  const messages=unread(data?.report),events=upcoming(data?.report,timestamp);
  const priorities=[];
  const kindTitle={send_email:'Wiadomość do zatwierdzenia',calendar_event:'Termin do zatwierdzenia',drive_file:'Plik do zatwierdzenia'};
  for(const action of [...uncertain,...pending]) {
    const subject=clean(action.payload?.subject||action.payload?.summary||action.payload?.name,180);
    priorities.push({id:'action:'+action.id,title:(action.state==='uncertain'?'Sprawdź wynik działania':kindTitle[action.kind]||'Działanie do zatwierdzenia')+(subject?' — '+subject:''),reason:action.state==='uncertain'?'Wynik poprzedniej operacji jest niepewny. Sprawdź go w Google przed jakąkolwiek kolejną próbą.':'Oczekuje na sprawdzenie dokładnej treści i Twoje zatwierdzenie.',sourceType:'action',sourceId:action.id,level:action.state==='uncertain'?'high':'medium'});
  }
  for(const {event,start,allDay} of events) {
    const when=new Intl.DateTimeFormat('pl-PL',{timeZone:OSLO,day:'2-digit',month:'2-digit',year:'numeric',...(allDay?{}:{hour:'2-digit',minute:'2-digit'})}).format(start);
    const sourceUrl=googleUrl(event.htmlLink);
    priorities.push({id:'event:'+event.id,title:clean(event.summary,240)||'Wydarzenie w kalendarzu',reason:`Potwierdzony termin${allDay?' całodniowy':''}: ${when} (${OSLO}). Sprawdź przygotowanie i ustalenia.`,sourceType:'event',sourceId:event.id,...(sourceUrl?{sourceUrl}:{}),level:'high'});
  }
  for(const message of messages.slice(0,10)) {
    const threadId=safeId(message.threadId)||message.id;
    priorities.push({id:'mail:'+message.id,title:clean(message.subject,240)||'Wiadomość bez tematu',reason:'Nieprzeczytana wiadomość w skrzynce odbiorczej. Przejrzyj jej treść i zdecyduj o dalszym działaniu.',sourceType:'mail',sourceId:message.id,sourceUrl:`https://mail.google.com/mail/?authuser=tromsobyggtre%40gmail.com#inbox/${encodeURIComponent(threadId)}`,level:'info'});
  }
  return {priorities,counts:{pendingActions:pending.length,uncertainActions:uncertain.length,unreadMessages:messages.length,upcomingEvents:events.length,quotes:arr(data?.quotes).length}};
}

function timing(value) {
  if(!record(value))return undefined;
  return Object.fromEntries(['date','dateTime','timeZone'].filter(key=>typeof value[key]==='string').map(key=>[key,clean(value[key],key==='date'?10:100)]));
}

export function analysisInput(report) {
  const result={at:clean(report?.at,50),note:clean(report?.note,2000),limits:{},messages:[],events:[],files:[],sources:[]};
  for(const key of Object.keys(LIMITS))result.limits[key]=Number.isInteger(report?.limits?.[key])&&report.limits[key]>=0?Math.min(report.limits[key],LIMITS[key]):LIMITS[key];
  const types=[['messages','mail',LIMITS.mail],['events','event',LIMITS.events],['files','file',LIMITS.files]];
  for(const [key,type,max] of types) {
    const seen=new Set();
    for(const item of arr(report?.[key]).slice(0,max)) {
      if(!record(item)||!safeId(item.id)||seen.has(item.id))continue;
      seen.add(item.id);
      const sourceId=type+':'+item.id;
      let copy={id:item.id,sourceId};
      if(type==='mail')copy={...copy,threadId:safeId(item.threadId)||'',from:clean(item.from,400),subject:clean(item.subject,500),date:clean(item.date,100),snippet:clean(item.snippet,2000),labels:arr(item.labels).slice(0,30).map(label=>clean(label,100)).filter(Boolean)};
      if(type==='event')copy={...copy,summary:clean(item.summary,500),start:timing(item.start),end:timing(item.end),status:clean(item.status,40),...(googleUrl(item.htmlLink)?{htmlLink:googleUrl(item.htmlLink)}:{})};
      if(type==='file')copy={...copy,name:clean(item.name,500),mimeType:clean(item.mimeType,160),modifiedTime:clean(item.modifiedTime,50),...(googleUrl(item.webViewLink)?{webViewLink:googleUrl(item.webViewLink)}:{})};
      result[key].push(copy);
      result.sources.push({id:sourceId,type,sourceId:item.id});
    }
  }
  return result;
}

export const analysisFormat={type:'json_schema',name:'tbt_daily_review',strict:true,schema:{
  type:'object',additionalProperties:false,required:['summary','priorities','missingInformation','warnings'],properties:{
    summary:{type:'string'},
    priorities:{type:'array',maxItems:5,items:{type:'object',additionalProperties:false,required:['title','reason','nextStep','sourceIds'],properties:{title:{type:'string'},reason:{type:'string'},nextStep:{type:'string'},sourceIds:{type:'array',minItems:1,maxItems:8,items:{type:'string'}}}}},
    missingInformation:{type:'array',maxItems:5,items:{type:'string'}},
    warnings:{type:'array',maxItems:5,items:{type:'string'}}
  }
}};

const providerError=message=>Object.assign(new Error(message),{status:502});
function exactKeys(value,keys) {
  return record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
}
function parsedText(value,max) {
  const result=clean(value,max);
  if(!result)throw providerError('Analiza AI zawiera nieprawidłową treść. Spróbuj ponownie.');
  return result;
}
function parsedList(value,max) {
  if(!Array.isArray(value)||value.length>50)throw providerError('Analiza AI ma nieprawidłowy format listy. Spróbuj ponownie.');
  return value.map(item=>parsedText(item,max)).slice(0,5);
}

export function parseAnalysis(response,report) {
  if(!record(response)||response.error||response.incomplete_details||response.status&&response.status!=='completed'||arr(response.output).some(item=>item?.status&&item.status!=='completed'))throw providerError('OpenAI nie zakończyło analizy. Spróbuj ponownie.');
  const content=arr(response.output).flatMap(item=>arr(item?.content));
  if(content.some(item=>item?.type==='refusal'||typeof item?.refusal==='string')||response.refusal)throw providerError('OpenAI odmówiło przygotowania tej analizy. Sprawdź zakres danych.');
  const output=typeof response.output_text==='string'?response.output_text:content.filter(item=>item?.type==='output_text'&&typeof item.text==='string').map(item=>item.text).join('');
  if(!output.trim()||output.length>100000)throw providerError('OpenAI zwróciło pustą lub zbyt długą analizę. Spróbuj ponownie.');
  let parsed;
  try {parsed=JSON.parse(output);}catch {throw providerError('Analiza AI ma nieprawidłowy format. Spróbuj ponownie.');}
  if(!exactKeys(parsed,['summary','priorities','missingInformation','warnings'])||!Array.isArray(parsed.priorities)||parsed.priorities.length>50)throw providerError('Analiza AI ma nieprawidłowy format. Spróbuj ponownie.');
  const input=analysisInput(report),sourceIds=new Set(input.sources.map(source=>source.id));
  const priorities=parsed.priorities.map(priority=>{
    if(!exactKeys(priority,['title','reason','nextStep','sourceIds'])||!Array.isArray(priority.sourceIds)||!priority.sourceIds.length||priority.sourceIds.length>8||priority.sourceIds.some(id=>typeof id!=='string'||!sourceIds.has(id)))throw providerError('Analiza AI odwołuje się do niepotwierdzonego źródła. Spróbuj ponownie.');
    return {title:parsedText(priority.title,240),reason:parsedText(priority.reason,1200),nextStep:parsedText(priority.nextStep,1200),sourceIds:[...new Set(priority.sourceIds)]};
  }).slice(0,5);
  return {summary:parsedText(parsed.summary,2500),priorities,missingInformation:parsedList(parsed.missingInformation,1000),warnings:parsedList(parsed.warnings,1000),generatedAt:new Date().toISOString(),sourceReportAt:input.at};
}
