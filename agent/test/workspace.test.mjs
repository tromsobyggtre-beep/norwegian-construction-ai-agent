import test from 'node:test';
import assert from 'node:assert/strict';
import {workspace,analysisInput,analysisFormat,parseAnalysis,osloDateTime} from '../workspace.mjs';

const now=Date.parse('2026-10-24T22:30:00Z'); // Already 25 October in Oslo; clocks change later that night.
const report={at:'2026-10-24T22:25:00Z',messages:[{id:'mail1',threadId:'thread1',subject:'Oferta opłacona — montaż zakończony',snippet:'Czy oferta jest aktualna?',labels:['INBOX','UNREAD']}],events:[],files:[{id:'file1',name:'Umowa',webViewLink:'https://drive.google.com/file/d/file1/view'}],note:'Migawka',limits:{mail:30,events:50,files:50}};
const response=value=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const validAnalysis={summary:'Przejrzyj nową wiadomość.',priorities:[{title:'Sprawdź zakres oferty',reason:'Wiadomość zawiera pytanie o ofertę.',nextStep:'Przeczytaj pełną rozmowę.',sourceIds:['mail:mail1']}],missingInformation:['Pełna korespondencja'],warnings:['Migawka nie potwierdza płatności.']};

test('osloDateTime zamienia zwykłe daty latem i zimą, zachowuje sekundy i waliduje kalendarz',()=>{
  assert.equal(osloDateTime('2026-07-14T09:30'),'2026-07-14T07:30:00.000Z');
  assert.equal(osloDateTime('2026-01-14T09:30:45'),'2026-01-14T08:30:45.000Z');
  for(const value of [null,42,'','2026-02-30T09:00','2026-13-01T09:00','2026-01-01T24:00','2026-01-01T09:60','2026-01-01T09:00:60','2026-01-01T09:00Z'])assert.throws(()=>osloDateTime(value),error=>error.status===400);
});

test('osloDateTime odrzuca nieistniejącą godzinę wiosną, lecz akceptuje obie strony zmiany czasu',()=>{
  assert.throws(()=>osloDateTime('2026-03-29T02:30'),error=>error.status===400&&/nie istnieje/.test(error.message));
  assert.equal(osloDateTime('2026-03-29T01:59'),'2026-03-29T00:59:00.000Z');
  assert.equal(osloDateTime('2026-03-29T03:00'),'2026-03-29T01:00:00.000Z');
});

test('osloDateTime odrzuca niejednoznaczną godzinę jesienią, lecz akceptuje godziny poza powtórzeniem',()=>{
  assert.throws(()=>osloDateTime('2026-10-25T02:30'),error=>error.status===400&&/dwa razy/.test(error.message));
  assert.equal(osloDateTime('2026-10-25T01:59'),'2026-10-24T23:59:00.000Z');
  assert.equal(osloDateTime('2026-10-25T03:00'),'2026-10-25T02:00:00.000Z');
});

test('przegląd proponuje działania bez uznawania tematu za dowód zapłaty, wykonania lub braku odpowiedzi',()=>{
  const data={report,actions:[{id:'p1',state:'pending',kind:'send_email',payload:{subject:'Oferta'}},{id:'u1',state:'uncertain',kind:'calendar_event',payload:{summary:'Montaż'}},{id:'done',state:'completed'},{id:'running',state:'executing'}],quotes:[{id:'q1'}]};
  const original=structuredClone(data),result=workspace(data,now);
  assert.deepEqual(result.counts,{pendingActions:1,uncertainActions:1,unreadMessages:1,upcomingEvents:0,quotes:1});
  assert.deepEqual(result.priorities.map(p=>p.id),['action:u1','action:p1','mail:mail1']);
  assert.equal(result.priorities[0].level,'high');
  assert.equal(result.priorities[2].reason,'Nieprzeczytana wiadomość w skrzynce odbiorczej. Przejrzyj jej treść i zdecyduj o dalszym działaniu.');
  assert(!JSON.stringify(result.priorities.map(p=>p.reason)).match(/brak odpowiedzi|zapłacon|zakończon/i));
  assert.deepEqual(data,original);
});

test('nieprzeczytane dotyczą tylko INBOX, pomijają promotions/social i najwyżej 10 trafia do priorytetów',()=>{
  const messages=Array.from({length:12},(_,i)=>({id:'m'+i,labels:['INBOX','UNREAD']}));
  messages.push({id:'promo',labels:['INBOX','UNREAD','CATEGORY_PROMOTIONS']},{id:'social',labels:['INBOX','UNREAD','CATEGORY_SOCIAL']},{id:'sent',labels:['SENT','UNREAD']},{id:'read',labels:['INBOX']},{id:'m0',labels:['INBOX','UNREAD']});
  const result=workspace({report:{messages}},now);
  assert.equal(result.counts.unreadMessages,12);assert.equal(result.priorities.length,10);
});

test('terminy stosują Oslo, obsługują dzień zmiany czasu i wykluczają cancelled, tentative, przeszłe oraz granicę 48h',()=>{
  const events=[
    {id:'today',status:'confirmed',summary:'Cały dzień',start:{date:'2026-10-25'},end:{date:'2026-10-26'}},
    {id:'yesterday',status:'confirmed',start:{date:'2026-10-24'},end:{date:'2026-10-25'}},
    {id:'multi',status:'confirmed',start:{date:'2026-10-24'},end:{date:'2026-10-27'}},
    {id:'cancelled',status:'cancelled',start:{dateTime:'2026-10-25T10:00:00+01:00'}},
    {id:'tentative',status:'tentative',start:{dateTime:'2026-10-25T10:00:00+01:00'}},
    {id:'past',status:'confirmed',start:{dateTime:'2026-10-24T22:29:59Z'}},
    {id:'soon',status:'confirmed',summary:'Pomiar',start:{dateTime:'2026-10-25T09:00:00+01:00'}},
    {id:'boundary',status:'confirmed',start:{dateTime:'2026-10-26T22:30:00Z'}},
    {id:'invalid',status:'confirmed',start:{date:'2026-02-30'}},
    {id:'timezone-less',status:'confirmed',start:{dateTime:'2026-10-25T10:00:00'}},
    {id:'oslo-wall-time',status:'confirmed',start:{dateTime:'2026-10-25T09:30:00',timeZone:'Europe/Oslo'}}
  ];
  const result=workspace({report:{events}},now);
  assert.deepEqual(result.priorities.map(p=>p.sourceId),['multi','today','soon','oslo-wall-time']);
  assert.equal(result.counts.upcomingEvents,4);
  assert.match(result.priorities[1].reason,/25\.10\.2026/);
  assert.match(result.priorities[2].reason,/09:00/);
});

test('całodniowy termin kończy się o północy Oslo także po skróceniu i wydłużeniu doby',()=>{
  for(const [day,end,justBefore,justAfter] of [
    ['2026-03-29','2026-03-30','2026-03-29T21:59:59Z','2026-03-29T22:00:00Z'],
    ['2026-10-25','2026-10-26','2026-10-25T22:59:59Z','2026-10-25T23:00:00Z']
  ]) {
    const data={report:{events:[{id:'all-day',status:'confirmed',start:{date:day},end:{date:end}}]}};
    assert.equal(workspace(data,Date.parse(justBefore)).counts.upcomingEvents,1);
    assert.equal(workspace(data,Date.parse(justAfter)).counts.upcomingEvents,0);
    delete data.report.events[0].end;
    assert.equal(workspace(data,Date.parse(justBefore)).counts.upcomingEvents,1);
    assert.equal(workspace(data,Date.parse(justAfter)).counts.upcomingEvents,0);
  }
});

test('odnośniki z raportu są ograniczone do HTTPS i konkretnych hostów Google',()=>{
  const links=['javascript:alert(1)','http://calendar.google.com/event','https://calendar.google.com.evil.example/event','https://drive.google.com@evil.example/file','https://www.google.com/url?url=https://evil.example','https://calendar.google.com:444/event','https://user:secret@calendar.google.com/event','https://www.google.com/calendar/event?eid=abc','https://calendar.google.com/calendar/event?eid=abc'];
  const events=links.map((htmlLink,i)=>({id:'e'+i,status:'confirmed',start:{dateTime:'2026-10-25T10:00:00+01:00'},htmlLink}));
  const priorities=workspace({report:{events}},now).priorities;
  assert(priorities.slice(0,7).every(p=>!p.sourceUrl));
  assert(priorities.slice(7).every(p=>p.sourceUrl?.startsWith('https:')));
  const maliciousMail={id:'m/https://evil.example',threadId:'x#https://evil.example',labels:['INBOX','UNREAD']};
  const mailUrl=workspace({report:{messages:[maliciousMail]}},now).priorities[0].sourceUrl;
  assert.equal(new URL(mailUrl).hostname,'mail.google.com');assert(mailUrl.includes('%23'));
});

test('analysisInput bierze tylko bieżące źródła, nadaje canonical ID, ogranicza teksty i nie mutuje raportu',()=>{
  const input={...structuredClone(report),analysis:'OLD SECRET',analysisReport:{summary:'OLD'},google:{refresh_token:'SECRET'},messages:[...report.messages,{id:'file1',subject:'x'.repeat(9000),snippet:'z'.repeat(9000),labels:['INBOX'],access_token:'SECRET'}],events:[{id:'file1',summary:'Pomiar',start:{date:'2026-10-25'},status:'confirmed',htmlLink:'https://evil.example'}],files:[...report.files,{id:'bad file id'},{id:'file1',name:'duplicate'}]};
  const original=structuredClone(input),bounded=analysisInput(input);
  assert.deepEqual(bounded.sources.map(s=>s.id),['mail:mail1','mail:file1','event:file1','file:file1']);
  assert.equal(bounded.messages[1].sourceId,'mail:file1');assert.equal(bounded.events[0].sourceId,'event:file1');
  assert.equal(bounded.messages[1].subject.length,500);assert.equal(bounded.messages[1].snippet.length,2000);
  assert(!JSON.stringify(bounded).includes('SECRET'));assert(!('htmlLink' in bounded.events[0]));
  assert.deepEqual(input,original);
  const many=Array.from({length:80},(_,i)=>({id:'id'+i}));
  assert.equal(analysisInput({messages:many,events:many,files:many}).sources.length,130);
});

test('structured output ma wymagane wszystkie pola i zakazuje dodatkowych kluczy',()=>{
  assert.equal(analysisFormat.type,'json_schema');assert.equal(analysisFormat.strict,true);
  assert.equal(analysisFormat.schema.additionalProperties,false);
  assert.deepEqual(analysisFormat.schema.required,Object.keys(analysisFormat.schema.properties));
  const priority=analysisFormat.schema.properties.priorities.items;
  assert.equal(priority.additionalProperties,false);assert.deepEqual(priority.required,Object.keys(priority.properties));
  assert.equal(priority.properties.sourceIds.minItems,1);
});

test('parseAnalysis przyjmuje jedynie istniejące canonical źródła i przechowuje datę migawki',()=>{
  const input=response(validAnalysis),original=structuredClone(input),parsed=parseAnalysis(input,report);
  assert.equal(parsed.sourceReportAt,report.at);assert(Number.isFinite(Date.parse(parsed.generatedAt)));
  assert.deepEqual(parsed.priorities,validAnalysis.priorities);assert.deepEqual(input,original);
  for(const sourceIds of [[],['mail:missing'],['file:mail1'],['mail1'],['mail:mail1','file:unknown'],[null]]) {
    assert.throws(()=>parseAnalysis(response({...validAnalysis,priorities:[{...validAnalysis.priorities[0],sourceIds}]}),report),error=>error.status===502&&!error.message.includes('missing'));
  }
});

test('parseAnalysis odrzuca refusal, incomplete, błędy, brak tekstu i nieprawidłowy JSON bez wycieku treści',()=>{
  for(const input of [null,{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:JSON.stringify(validAnalysis)},{status:'completed',incomplete_details:{reason:'max_output_tokens'},output_text:JSON.stringify(validAnalysis)},{status:'completed',output:[{status:'incomplete'}],output_text:JSON.stringify(validAnalysis)},{status:'failed',error:{message:'SECRET'}},{status:'completed',output:[{content:[{type:'refusal',refusal:'SECRET'}]}]},{status:'completed',output:[]},{status:'completed',output_text:'SECRET not JSON'},response({...validAnalysis,unexpected:'SECRET'}),response({...validAnalysis,summary:42}),response({...validAnalysis,summary:'\u0000'}),response({...validAnalysis,priorities:[{...validAnalysis.priorities[0],nextStep:null}]})]) {
    assert.throws(()=>parseAnalysis(input,report),error=>error.status===502&&!error.message.includes('SECRET'));
  }
});

test('parseAnalysis ogranicza listy i długość tekstów oraz usuwa powtórzone źródła',()=>{
  const result=parseAnalysis(response({...validAnalysis,summary:'a'.repeat(5000),priorities:Array.from({length:8},()=>({...validAnalysis.priorities[0],title:'t'.repeat(500),sourceIds:['mail:mail1','mail:mail1']})),missingInformation:Array(8).fill('m'.repeat(2000)),warnings:Array(8).fill('w'.repeat(2000))}),report);
  assert.equal(result.summary.length,2500);assert.equal(result.priorities.length,5);assert.equal(result.priorities[0].title.length,240);
  assert.deepEqual(result.priorities[0].sourceIds,['mail:mail1']);assert.equal(result.missingInformation.length,5);assert.equal(result.warnings.length,5);assert.equal(result.warnings[0].length,1000);
});
