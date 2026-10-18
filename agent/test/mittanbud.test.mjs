import test from 'node:test';
import assert from 'node:assert/strict';
import {validateObservation,normalizeAppointment,importAppointment} from '../mittanbud.mjs';

const now=Date.parse('2026-10-18T12:00:00Z');
const calendarId='tromsobyggtre@gmail.com';
const observation={conversationId:12345,url:'https://minbedrift.mittanbud.no/meldinger/12345',messageText:'Vi kommer på befaring 20.10.2026 kl. 10:00 på Storgata 5.',sentAt:'2026-10-18T13:59:00+02:00'};
const extraction={kind:'visit',startLocal:'2026-10-20T10:00',endLocal:null,evidence:'20.10.2026 kl. 10:00',summary:'Befaring — Storgata 5',location:'Storgata 5',certainty:'clear',reason:'Dato og klokkeslett er oppgitt.'};
const make=()=>{const source=validateObservation(observation,now);return {source,appointment:normalizeAppointment(source,extraction,{visitMinutes:30},now)};};
const httpError=status=>Object.assign(new Error('provider detail SECRET'),{response:{status}});
const store=()=>({data:{},saveCalls:0,save(){this.saveCalls++;}});
function googleMock({existing=null,busy=[],getError,insertError,busyError,insertResponse}={}) {
  const calls=[],events=new Map(existing?[[existing.id,structuredClone(existing)]]:[]);
  return {calls,events,async request(url,options) {
    calls.push({url,options:structuredClone(options)});
    if(url.endsWith('/freeBusy')){if(busyError)throw busyError;return {calendars:{[calendarId]:{busy}}};}
    if(options?.method==='POST') {
      if(insertError)throw insertError;
      const event={...structuredClone(options.data),status:'confirmed',htmlLink:'https://www.google.com/calendar/event?eid=test'};
      events.set(event.id,event);return insertResponse??event;
    }
    if(getError)throw getError;
    const event=events.get(url.split('/').at(-1));if(!event)throw httpError(404);return structuredClone(event);
  }};
}
const inserts=google=>google.calls.filter(c=>c.options?.method==='POST'&&!c.url.endsWith('/freeBusy'));

test('obserwacja waliduje konkretną rozmowę Mittanbud i nie ufa źródłowemu kluczowi',()=>{
  const input={...observation,sourceKey:'FORGED',url:observation.url+'?private=ignore#fragment'},original=structuredClone(input),validated=validateObservation(input,now);
  assert.equal(validated.conversationId,'12345');assert.equal(validated.url,observation.url);assert.equal(validated.sentAt,'2026-10-18T11:59:00.000Z');assert.match(validated.sourceHash,/^[0-9a-f]{64}$/);
  assert.equal(validated.sourceHash,validateObservation({...input,sourceKey:'DIFFERENT'},now).sourceHash);assert.deepEqual(input,original);
  for(const changes of [{conversationId:0},{conversationId:'123/evil'},{url:'https://minbedrift.mittanbud.no.evil.example/meldinger/12345'},{url:'https://user:pass@minbedrift.mittanbud.no/meldinger/12345'},{url:'http://minbedrift.mittanbud.no/meldinger/12345'},{url:'https://minbedrift.mittanbud.no/meldinger/99999'},{sentAt:'2026-02-30T11:00:00Z'},{sentAt:'2026-10-18T12:10:00Z'},{sentAt:'2026-10-17T11:59:59Z'},{messageText:'x'.repeat(8001)}])assert.throws(()=>validateObservation({...observation,...changes},now),e=>e.status===400);
});

test('opcjonalny tytuł pracy jest oczyszczony, ograniczony i objęty hashem źródła',()=>{
  const without=validateObservation(observation,now),withTitle=validateObservation({...observation,projectTitle:'  Montering av ytterdør  '},now);
  assert(!Object.hasOwn(without,'projectTitle'));assert.equal(withTitle.projectTitle,'Montering av ytterdør');assert.notEqual(withTitle.sourceHash,without.sourceHash);
  assert.equal(withTitle.sourceHash,validateObservation({...observation,projectTitle:'Montering av ytterdør'},now).sourceHash);
  for(const projectTitle of [null,42,{},'', 'x'.repeat(161),'Tittel\u0000'])assert.throws(()=>validateObservation({...observation,projectTitle},now),e=>e.status===400);
});

test('jasna wizyta ma 30 minut, Oslo i stabilne ID niezależne od kolejnej wiadomości o tym samym terminie',()=>{
  const {source,appointment}=make(),original=structuredClone(extraction);
  assert.equal(appointment.start,'2026-10-20T08:00:00.000Z');assert.equal(appointment.end,'2026-10-20T08:30:00.000Z');assert.equal(appointment.endLocal,'2026-10-20T10:30');assert.equal(appointment.endWasDefaulted,true);
  const next=validateObservation({...observation,messageText:'Potwierdzam 20.10.2026 kl. 10:00, do zobaczenia.',sentAt:'2026-10-18T12:00:00Z'},now);
  assert.notEqual(next.sourceHash,source.sourceHash);assert.equal(normalizeAppointment(next,extraction,{visitMinutes:30},now).eventId,appointment.eventId);
  assert.match(appointment.eventId,/^[0-9a-f]{64}$/);assert.deepEqual(extraction,original);
});

test('odrzuca niejednoznaczność, brak dowodu, brak końca realizacji i nieprawidłowe daty',()=>{
  const {source}=make();
  for(const changes of [{certainty:'ambiguous'},{evidence:'nieobecny fragment'},{kind:'project'},{startLocal:'2026-10-17T10:00'},{startLocal:'2028-05-20T10:00'},{startLocal:'2026-10-20'},{startLocal:'2026-02-30T10:00'},{endLocal:'2026-10-20T09:00'},{endLocal:'2028-05-20T10:00'}])assert.throws(()=>normalizeAppointment(source,{...extraction,...changes},{visitMinutes:30},now),e=>e.status===400);
  const project=normalizeAppointment(source,{...extraction,kind:'project',endLocal:'2026-10-20T16:00'},{visitMinutes:30},now);
  assert.equal(project.end,'2026-10-20T14:00:00.000Z');assert.equal(project.endWasDefaulted,false);
});

test('nie wybiera samodzielnie godziny w luce i powtórzeniu DST',()=>{
  const earlier=Date.parse('2026-01-01T00:00:00Z'),source=validateObservation({...observation,sentAt:'2025-12-31T23:59:00Z'},earlier);
  for(const startLocal of ['2026-03-29T02:30','2026-10-25T02:30'])assert.throws(()=>normalizeAppointment(source,{...extraction,startLocal},{visitMinutes:30},earlier),e=>e.status===400);
});

test('import sprawdza GET i konflikt przed pojedynczym prywatnym insertem, bez zapraszania',async()=>{
  const {source,appointment}=make(),s=store(),google=googleMock(),original=structuredClone(appointment);
  const result=await importAppointment(s,google,source,appointment,now);
  assert.equal(result.status,'completed');assert.equal(google.calls.length,3);assert.equal(google.calls[0].options,undefined);assert(google.calls[1].url.endsWith('/freeBusy'));
  assert(google.calls[0].url.includes(`/calendars/${encodeURIComponent(calendarId)}/events/`));
  assert.deepEqual(google.calls[1].options.data.items,[{id:calendarId}]);
  const insert=inserts(google)[0];assert.equal(insert.options.data.id,appointment.eventId);assert.equal(insert.options.params.sendUpdates,'none');assert.equal(insert.options.data.visibility,'private');assert.equal(insert.options.data.status,'tentative');assert(!Object.hasOwn(insert.options.data,'attendees'));assert.equal(insert.options.data.start.timeZone,'Europe/Oslo');assert.equal(insert.options.data.extendedProperties.private.tbtConversation,'12345');assert(insert.options.data.description.includes(source.url));assert(insert.options.data.description.includes('akceptacja klienta nie została potwierdzona'));assert(s.saveCalls>=3);assert.deepEqual(appointment,original);
  assert.equal(insert.url,`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  const again=await importAppointment(s,google,source,appointment,now);
  assert.equal(again.status,'completed');assert.equal(inserts(google).length,1);assert.equal(Object.keys(s.data.mittanbudImports).length,1);
});

test('inna wiadomość tego samego terminu nie nadpisuje pierwotnych danych',async()=>{
  const {source,appointment}=make(),s=store(),google=googleMock();
  await importAppointment(s,google,source,appointment,now);
  const nextSource=validateObservation({...observation,messageText:'Potwierdzam 20.10.2026 kl. 10:00.'},now),next=normalizeAppointment(nextSource,{...extraction,summary:'Nowa nazwa'},{visitMinutes:30},now);
  const result=await importAppointment(s,google,nextSource,next,now);
  assert.equal(result.status,'completed');assert.equal(result.sourceHash,source.sourceHash);assert.equal(result.appointment.summary,appointment.summary);assert.equal(inserts(google).length,1);
});

test('fragment wiadomości pozostaje dosłownym tekstem zamiast aktywnego HTML w opisie Google',async()=>{
  const evidence='<a href="https://evil.example/?x=1&y=2">20.10.2026 kl. 10:00</a> \'tekst\'';
  const source=validateObservation({...observation,messageText:evidence},now),appointment=normalizeAppointment(source,{...extraction,evidence},{visitMinutes:30},now),google=googleMock();
  await importAppointment(store(),google,source,appointment,now);
  const description=inserts(google)[0].options.data.description;
  assert(!description.includes('<a'));assert(!description.includes('</a>'));assert(description.includes('&lt;a href=&quot;https://evil.example/?x=1&amp;y=2&quot;&gt;'));assert(description.includes('&#39;tekst&#39;'));
});

test('konflikt oznacza blocked bez inserta, a błąd odczytu nie powoduje zapisu',async()=>{
  const {source,appointment}=make(),s=store(),google=googleMock({busy:[{start:appointment.start,end:appointment.end}]});
  assert.equal((await importAppointment(s,google,source,appointment,now)).status,'blocked');assert.equal(inserts(google).length,0);
  for(const failure of [httpError(403),httpError(500),new Error('network')]) {
    const g=googleMock({getError:failure});await assert.rejects(()=>importAppointment(store(),g,source,appointment,now),e=>e===failure);assert.equal(g.calls.length,1);assert.equal(inserts(g).length,0);
  }
});

test('brak potwierdzonej dostępności i zapis przerwany restartem nie pozwalają na insert',async()=>{
  const {source,appointment}=make();
  for(const busyResponse of [{},{calendars:{[calendarId]:{errors:[{reason:'internalError'}],busy:[]}}},{calendars:{[calendarId]:{errors:{reason:'invalid'},busy:[]}}},{calendars:{[calendarId]:{}}},{calendars:{primary:{busy:[]}}}]) {
    const s=store(),google=googleMock(),original=google.request.bind(google);
    google.request=async(url,options)=>url.endsWith('/freeBusy')?busyResponse:original(url,options);
    await assert.rejects(()=>importAppointment(s,google,source,appointment,now),e=>e.status===502);assert.equal(inserts(google).length,0);assert.equal(s.data.mittanbudImports[appointment.eventId].status,'blocked');
  }
  const s=store(),google=googleMock();s.data.mittanbudImports={[appointment.eventId]:{id:appointment.eventId,eventId:appointment.eventId,status:'executing',source:{conversationId:source.conversationId},appointment:structuredClone(appointment)}};
  assert.equal((await importAppointment(s,google,source,appointment,now)).status,'uncertain');assert.equal(inserts(google).length,0);
});

test('timeout zapisu pozostawia uncertain i brak eventu przy następnym GET nie uruchamia kolejnego inserta',async()=>{
  const {source,appointment}=make(),s=store(),google=googleMock({insertError:new Error('timeout')});
  assert.equal((await importAppointment(s,google,source,appointment,now)).status,'uncertain');assert.equal(inserts(google).length,1);
  assert.equal((await importAppointment(s,google,source,appointment,now)).status,'uncertain');assert.equal(inserts(google).length,1);
});

test('błąd GET po uncertain ani kolejne 404 po usuniętym completed nie otwierają ponownego zapisu',async()=>{
  const {source,appointment}=make(),s=store(),google=googleMock({insertError:new Error('timeout')});
  await importAppointment(s,google,source,appointment,now);
  const failedLookup=googleMock({getError:httpError(503)});
  await assert.rejects(()=>importAppointment(s,failedLookup,source,appointment,now));
  assert.equal(s.data.mittanbudImports[appointment.eventId].writeAttempted,true);
  assert.equal((await importAppointment(s,google,source,appointment,now)).status,'uncertain');assert.equal(inserts(google).length,1);
  const fresh=store(),success=googleMock();await importAppointment(fresh,success,source,appointment,now);success.events.clear();
  await importAppointment(fresh,success,source,appointment,now);await importAppointment(fresh,success,source,appointment,now);
  assert.equal(inserts(success).length,1);
});

test('odzyskuje potwierdzony wpis po niepewnym zapisie i nie odtwarza wpisu usuniętego po completed',async()=>{
  const {source,appointment}=make(),s=store(),google=googleMock({insertError:new Error('timeout')});
  await importAppointment(s,google,source,appointment,now);
  google.events.set(appointment.eventId,{id:appointment.eventId,status:'confirmed',start:{dateTime:appointment.start},end:{dateTime:appointment.end},extendedProperties:{private:{tbtSource:'mittanbud',tbtConversation:source.conversationId,tbtKind:appointment.kind}}});
  assert.equal((await importAppointment(s,google,source,appointment,now)).status,'completed');
  google.events.clear();assert.equal((await importAppointment(s,google,source,appointment,now)).status,'blocked');assert.equal(inserts(google).length,1);
});

test('409 po insercie odczytuje wynik; obcy event i anulowany termin nie są nadpisywane',async()=>{
  const {source,appointment}=make(),s=store(),google=googleMock();
  const request=google.request.bind(google);
  google.request=async(url,options)=>{if(options?.method==='POST'&&!url.endsWith('/freeBusy')){await request(url,options);throw httpError(409);}return request(url,options);};
  assert.equal((await importAppointment(s,google,source,appointment,now)).status,'completed');assert.equal(inserts(google).length,1);
  for(const overrides of [{extendedProperties:{private:{tbtSource:'other'}}},{status:'cancelled'},{end:{dateTime:'2026-10-20T09:00:00Z'}}]) {
    const event={...google.events.get(appointment.eventId),...overrides},g=googleMock({existing:event});
    await assert.rejects(()=>importAppointment(store(),g,source,appointment,now),e=>e.status===409);assert.equal(inserts(g).length,0);
  }
});

test('serializacja dwóch importów tego samego terminu nie tworzy duplikatu',async()=>{
  const {source,appointment}=make(),s=store(),google=googleMock();
  const results=await Promise.all([importAppointment(s,google,source,appointment,now),importAppointment(s,google,source,appointment,now)]);
  assert(results.every(r=>r.status==='completed'));assert.equal(inserts(google).length,1);
});

test('limit 1000 rekordów i zmieniona propozycja zatrzymują zapis przed Google',async()=>{
  const {source,appointment}=make(),s=store(),google=googleMock();s.data.mittanbudImports=Object.fromEntries(Array.from({length:1000},(_,i)=>['old'+i,{}]));
  await assert.rejects(()=>importAppointment(s,google,source,appointment,now),e=>e.status===409);assert.equal(google.calls.length,0);
  await assert.rejects(()=>importAppointment(store(),google,source,{...appointment,start:'2026-10-20T07:00:00Z'},now),e=>e.status===400);assert.equal(google.calls.length,0);
});
