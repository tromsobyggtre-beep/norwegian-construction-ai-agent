import test from 'node:test';
import assert from 'node:assert/strict';
import {extractAppointment} from '../mittanbud-parser.mjs';
const source=messageText=>({conversationId:'12345',sentAt:'2026-10-18T18:00:00Z',messageText});
for(const [message,start,end,kind] of [
  ['Przyjadę na wizytę 22.10.2026 o 10:00.','2026-10-22T10:00',null,'visit'],
  ['Vi kommer på befaring tirsdag kl. 09:30.','2026-10-20T09:30',null,'visit'],
  ['I will come by tomorrow at 09:00.','2026-10-19T09:00',null,'visit'],
  ['Oględziny przed montażem 22.10.2026 od 09:00 do 10:00.','2026-10-22T09:00','2026-10-22T10:00','visit'],
  ['Befaring 22 oktober 2026 kl. 10.30.','2026-10-22T10:30',null,'visit'],
  ['Site visit October 22, 2026 at 10:30.','2026-10-22T10:30',null,'visit'],
  ['Wizyta 22 października 2026 od 9 do 11.','2026-10-22T09:00','2026-10-22T11:00','visit'],
  ['Montering 2026-10-22 fra 09:00 til 15:00.','2026-10-22T09:00','2026-10-22T15:00','project'],
  ['Montaż 22.10.2026 o 10:00 przez 2 godziny.','2026-10-22T10:00','2026-10-22T12:00','project'],
  ['Realizacja od 22.10.2026 08:00 do 24.10.2026 16:00.','2026-10-22T08:00','2026-10-24T16:00','project'],
  ['Befaring i morgen kl. 9.','2026-10-19T09:00',null,'visit'],
  ['Wizyta pojutrze o 10:00 na 45 minut.','2026-10-20T10:00','2026-10-20T10:45','visit'],
  ['Czy pasuje wizyta 22.10.2026 o 10:00?','2026-10-22T10:00',null,'visit'],
  ['I will come by October 22, 2026 at 2:30 PM.','2026-10-22T14:30',null,'visit'],
  ['I will come by October 22, 2026 at 12 AM.','2026-10-22T00:00',null,'visit'],
])test('extracts without inventing: '+message,()=>{
  const result=extractAppointment(source(message));assert.equal(result.state,'ready');
  assert.equal(result.extraction.startLocal,start);assert.equal(result.extraction.endLocal,end);assert.equal(result.extraction.kind,kind);
  assert.ok(message.includes(result.extraction.evidence));
});
for(const message of [
  'Może przyjadę na wizytę 22.10.2026 o 10:00.',
  'Befaring tirsdag eller onsdag kl. 10:00.',
  'Wizyta we wtorek.',
  'Befaring kl. 10:00.',
  'Montaż 22.10.2026 o 10:00.',
  'Wizyta 31.02.2027 o 10:00.',
  'Wizyta 22.10.2026 o 10:00 lub 11:00.',
  'Wizyta w przyszłym tygodniu.',
  'Wizyta next Tuesday at 10:00.',
  'Wizyta w piątek 22.10.2026 o 10:00.',
  'Odwołuję wizytę 22.10.2026 o 10:00.',
  'Vi kan ikke komme på befaring tirsdag kl. 10:00.',
  'Wizyta 22.10.2026 o 10:00, druga 23.10.2026 o 12:00.',
  'Site visit October 22, 2026 at 10:00 UTC.',
  'Jeg kommer ikke på befaring 22.10.2026 kl. 10:00.',
  'Nie będę na wizycie 22.10.2026 o 10:00.',
  'I will not come by October 22, 2026 at 10:00.',
  'Płatność za realizację 22.10.2026 o 10:00.',
  'Byliśmy na wizycie 22.10.2026 o 10:00.',
])test('requires clarification: '+message,()=>assert.equal(extractAppointment(source(message)).state,'ambiguous'));
test('ordinary correspondence does not schedule anything',()=>assert.equal(extractAppointment(source('Dziękuję za wiadomość. Prześlemy ofertę.')).state,'ignored'));
test('relative date is resolved at the Oslo date of sending',()=>{
  const result=extractAppointment({...source('Befaring i morgen kl. 10:00.'),sentAt:'2026-10-18T22:30:00Z'});
  assert.equal(result.extraction.startLocal,'2026-10-20T10:00');
});
test('calendar title carries the observed project name, without inventing client details',()=>{
  const result=extractAppointment({...source('Befaring tirsdag kl. 10:00.'),projectTitle:'Bytte av vinduer'});
  assert.equal(result.extraction.summary,'Wizyta · Bytte av vinduer');
});
