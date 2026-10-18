// Conservative parsing of dates in the firm's own, newly sent messages.
// No model receives correspondence and source text cannot supply instructions.
const fold=s=>s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/ł/g,'l').replace(/ø/g,'o');
const pad=n=>String(n).padStart(2,'0');
const dayISO=d=>`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
const validDay=s=>{const n=Date.parse(s+'T12:00:00Z');return Number.isFinite(n)&&dayISO(new Date(n))===s;};
const plusDays=(s,n)=>dayISO(new Date(Date.parse(s+'T12:00:00Z')+n*86400000));
const clock=(day,h,m)=>day+'T'+pad(h)+':'+pad(m);
const localNow=instant=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
const ambiguous=reason=>({state:'ambiguous',message:reason});
const months=[['januar','january','stycznia'],['februar','february','lutego'],['mars','march','marca'],['april','kwietnia'],['mai','may','maja'],['juni','june','czerwca'],['juli','july','lipca'],['august','sierpnia'],['september','wrzesnia'],['oktober','october','pazdziernika'],['november','listopada'],['desember','december','grudnia']];
const monthNumber=Object.fromEntries(months.flatMap((names,i)=>names.map(name=>[name,i+1])));
const monthNames=Object.keys(monthNumber).join('|');
const weekdays=[['sondag','sunday','niedziela','niedziele'],['mandag','monday','poniedzialek'],['tirsdag','tuesday','wtorek'],['onsdag','wednesday','sroda','srode'],['torsdag','thursday','czwartek'],['fredag','friday','piatek'],['lordag','saturday','sobota','sobote']];
const weekdayNumber=Object.fromEntries(weekdays.flatMap((names,i)=>names.map(name=>[name,i])));

export function extractAppointment(observation) {
  const original=observation.messageText;
  const s=fold(original),parts=localNow(observation.sentAt),today=`${parts.year}-${parts.month}-${parts.day}`;
  const year=Number(parts.year),dates=[],clocks=[];
  const addDate=(day,index,length)=>{dates.push({day,index,length});};
  const buildDay=(d,m,y)=>{
    return `${y||year}-${pad(m)}-${pad(d)}`;
  };
  for(const m of s.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g))addDate(`${m[1]}-${m[2]}-${m[3]}`,m.index,m[0].length);
  for(const m of s.matchAll(/\b(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}))?\b/g)) {
    // A decimal clock needs kl/godz/at; it must not become a second date.
    if(/\b(?:kl\.?|godz\.?|godzinie|o|at)\s*$/.test(s.slice(Math.max(0,m.index-12),m.index)))continue;
    if(+m[2]>12&&!m[3])continue;
    addDate(buildDay(+m[1],+m[2],m[3]),m.index,m[0].length);
  }
  const natural=new RegExp(`\\b(\\d{1,2})\\.?\\s+(${monthNames})(?:\\s+(20\\d{2}))?\\b`,'g');
  for(const m of s.matchAll(natural))addDate(buildDay(+m[1],monthNumber[m[2]],m[3]),m.index,m[0].length);
  const english=new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`,'g');
  for(const m of s.matchAll(english))addDate(buildDay(+m[2],monthNumber[m[1]],m[3]),m.index,m[0].length);
  for(const m of s.matchAll(/\b(pojutrze|overmorgen|day after tomorrow|jutro|i morgen|tomorrow|dzisiaj|dzis|i dag|today)\b/g)) {
    const offset=/pojutrze|overmorgen|day after tomorrow/.test(m[1])?2:/jutro|i morgen|tomorrow/.test(m[1])?1:0;
    addDate(plusDays(today,offset),m.index,m[0].length);
  }
  const weekdayPattern=new RegExp(`\\b(${Object.keys(weekdayNumber).join('|')})\\b`,'g');
  const weekdayMatches=[...s.matchAll(weekdayPattern)];
  const addClock=(h,min,index,length,meridiem)=>{let hour=+h;if(meridiem){if(hour<1||hour>12)hour=99;else hour=hour%12+(meridiem.startsWith('p')?12:0);}clocks.push({h:hour,m:+min,index,length});};
  for(const m of s.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)(?!\d)\s*(am\b|pm\b|a\.m\.|p\.m\.)?/g))addClock(m[1],m[2],m.index,m[0].length,m[3]);
  for(const m of s.matchAll(/\b(?:kl\.?|godz\.?|godzinie|o|at)\s*([01]?\d|2[0-3])(?:\.([0-5]\d))?(?!\d|\.\d)\s*(am\b|pm\b|a\.m\.|p\.m\.)?/g)) {
    if(s[m.index+m[0].length]===':')continue;
    addClock(m[1],m[2]||0,m.index,m[0].length,m[3]);
  }
  // Common whole-hour ranges such as "fra 9 til 11".
  for(const m of s.matchAll(/\b(?:fra|od|from)\s*([01]?\d|2[0-3])\s*(?:til|do|to|[-–])\s*([01]?\d|2[0-3])\b/g)) {
    addClock(m[1],0,m.index+m[0].indexOf(m[1]),m[1].length);addClock(m[2],0,m.index+m[0].lastIndexOf(m[2]),m[2].length);
  }
  if(!dates.length&&!weekdayMatches.length&&!clocks.length) {
    return /neste uke|next week|przyszl\w* tygodn/.test(s)?ambiguous('Podaj konkretny dzień i godzinę terminu.'):({state:'ignored',message:'Wiadomość nie zawiera jednoznacznego terminu.'});
  }
  if(/\b(avlys\w*|cancel\w*|odwol\w*|przeloz\w*|reschedul\w*|flytt\w*|nie|ikke|not|cannot)\b|can.t|won.t|don.t/.test(s))return ambiguous('Zaprzeczenie, zmiana lub odwołanie terminu wymaga sprawdzenia istniejącego wpisu.');
  if(/\b(?:faktur\w*|invoice\w*|betaling\w*|platnosc\w*|payment\w*|forfall\w*|yesterday|wczoraj|bylem|bylismy|visited)\b|\bi gar\b|var pa befaring|last (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.test(s))return ambiguous('Wiadomość dotyczy także historii lub rozliczeń. Sprawdź, czy wskazana data jest nowym terminem.');
  if(/\b(?:lub|albo|eller|or|moze|kanskje|maybe|rundt|omkring|around|okolo)\b/.test(s))return ambiguous('Termin zawiera przybliżenie lub alternatywę. Podaj jeden dokładny termin.');
  if(!clocks.length)return ambiguous('Podano dzień, ale brakuje dokładnej godziny.');
  if(clocks.some(c=>c.h>23)||/\b(?:utc|gmt|cet|cest)\b/.test(s))return ambiguous('Godzina lub strefa czasowa wymaga sprawdzenia. Użyj czasu Tromsø.');
  const uniqueClocks=clocks.filter((c,i)=>clocks.findIndex(other=>other.h===c.h&&other.m===c.m&&other.index===c.index)===i).sort((a,b)=>a.index-b.index);
  if(uniqueClocks.length>2)return ambiguous('Wiadomość zawiera więcej niż jeden możliwy zakres godzin.');
  if(dates.some(d=>!validDay(d.day)))return ambiguous('Data w wiadomości jest nieprawidłowa.');
  const uniqueDates=dates.filter((d,i)=>dates.findIndex(other=>other.day===d.day)===i).sort((a,b)=>a.index-b.index);
  if(!uniqueDates.length&&weekdayMatches.length===1) {
    const m=weekdayMatches[0];
    if(/(?:neste|next|przyszl\w*|nastepn\w*)\s*$/.test(s.slice(Math.max(0,m.index-20),m.index)))return ambiguous('Określenie następnego tygodnia wymaga podania daty.');
    const weekday=new Date(today+'T12:00:00Z').getUTCDay();
    let offset=(weekdayNumber[m[1]]-weekday+7)%7;
    if(!offset&&(uniqueClocks[0].h*60+uniqueClocks[0].m<=+parts.hour*60 + +parts.minute))offset=7;
    uniqueDates.push({day:plusDays(today,offset),index:m.index,length:m[0].length});
  }else if(!uniqueDates.length)return ambiguous('Podano godzinę, ale brakuje jednoznacznej daty.');
  if(weekdayMatches.length>1||uniqueDates.length>2)return ambiguous('Wiadomość zawiera kilka możliwych dni.');
  if(weekdayMatches.length===1&&dates.length) {
    const actual=new Date(uniqueDates[0].day+'T12:00:00Z').getUTCDay();
    if(actual!==weekdayNumber[weekdayMatches[0][1]])return ambiguous('Dzień tygodnia i data w wiadomości nie pasują do siebie.');
  }
  const project=/\b(?:realizacj\w*|montaz\w*|instal\w*|monter\w*|arbeid\w*|oppstart|rozpocz\w*|start\w*|wykonan\w*)\b/.test(s);
  const explicitVisit=/\b(?:befaring\w*|ogledzin\w*|wizyt\w*|inspekcj\w*|inspection|visit|pomiar\w*|measure\w*)\b/.test(s);
  const visit=explicitVisit||/\b(?:przyjad\w*|przyjsc|wpadn\w*|bede)\b|come by|be there|komme innom|kommer innom|jeg kommer|vi kommer/.test(s);
  if(!project&&!visit)return ambiguous('Nie wiadomo, czy chodzi o wizytę czy realizację projektu.');
  const kind=explicitVisit||!project?'visit':'project';
  const first=uniqueClocks[0],last=uniqueClocks[1];
  let startLocal=clock(uniqueDates[0].day,first.h,first.m),endLocal=null;
  if(uniqueDates.length===2) {
    if(kind!=='project'||!last||!/(?:\b(?:til|do|to|until)\b|[–—])/.test(s.slice(uniqueDates[0].index+uniqueDates[0].length,uniqueDates[1].index)))return ambiguous('Kilka dat wymaga podania jednego jasnego zakresu realizacji.');
    endLocal=clock(uniqueDates[1].day,last.h,last.m);
  }else if(last) {
    if(!/(?:\b(?:til|do|to|until)\b|[-–—])/.test(s.slice(first.index+first.length,last.index)))return ambiguous('Podano dwie godziny bez jednoznacznego zakresu.');
    endLocal=clock(uniqueDates[0].day,last.h,last.m);
  }else {
    const duration=s.match(/\b(\d{1,3})\s*(minut\w*|minutes?|min\b|godzin\w*|timer?|hours?|h\b)/);
    if(duration) {
      const minutes=+duration[1]*(/godzin|time|hours?|^h$/.test(duration[2])?60:1);
      if(!minutes||minutes>7*24*60)return ambiguous('Czas trwania wymaga sprawdzenia.');
      endLocal=new Date(Date.parse(startLocal+':00Z')+minutes*60000).toISOString().slice(0,16);
    }else if(kind==='project')return ambiguous('Dla realizacji projektu podaj godzinę końca lub czas trwania.');
  }
  const spans=[...uniqueDates,...uniqueClocks];
  const from=Math.min(...spans.map(x=>x.index)),to=Math.max(...spans.map(x=>x.index+x.length));
  if(to-from>600)return ambiguous('Ustalenie terminu jest rozproszone w długiej wiadomości. Podaj je w jednym zdaniu.');
  return {state:'ready',extraction:{kind,startLocal,endLocal,evidence:original.slice(from,to),summary:`${kind==='visit'?'Wizyta':'Realizacja'} · ${observation.projectTitle||'Mittanbud #'+observation.conversationId}`,location:null,certainty:'clear',reason:'Jednoznaczny termin z wysłanej wiadomości.'}};
}
