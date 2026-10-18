import {createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import {mkdirSync, existsSync, readFileSync, writeFileSync, renameSync} from 'node:fs';
import {join} from 'node:path';

export function check(condition, message) { if (!condition) throw Object.assign(new Error(message), {status:400}); }
export function text(value, name, max=6000) { check(typeof value==='string' && value.trim() && value.length<=max, `Uzupełnij: ${name}`); return value.trim(); }
export function equal(a,b) { const x=Buffer.from(a||''),y=Buffer.from(b||''); return x.length===y.length && timingSafeEqual(x,y); }
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Store {
  constructor(dir,key) {
    check(/^[a-f0-9]{64}$/i.test(key||''),'DATA_ENCRYPTION_KEY musi zawierać 64 znaki hex');
    this.key=Buffer.from(key,'hex'); mkdirSync(dir,{recursive:true,mode:0o700}); this.path=join(dir,'tbt.enc');
    this.data={quotes:[],actions:[],audit:[],report:null,google:null,settings:{monitor:false},lastRun:null};
    if(existsSync(this.path)) {
      const [iv,tag,body]=readFileSync(this.path,'utf8').split('.').map(x=>Buffer.from(x,'base64'));
      const d=createDecipheriv('aes-256-gcm',this.key,iv); d.setAuthTag(tag);
      this.data=JSON.parse(Buffer.concat([d.update(body),d.final()]).toString());
    }
  }
  save() {
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);
    const body=Buffer.concat([c.update(JSON.stringify(this.data)),c.final()]);
    writeFileSync(this.path+'.tmp',[iv,c.getAuthTag(),body].map(x=>x.toString('base64')).join('.'),{mode:0o600});
    renameSync(this.path+'.tmp',this.path);
  }
  audit(event,id) { this.data.audit.push({at:new Date().toISOString(),event,id}); this.data.audit=this.data.audit.slice(-1000); this.save(); }
}
const cents=(n,name,max=100000000)=> {check(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=max,`Nieprawidłowa kwota: ${name}`);return Math.round(n*100);};
export function quote(input) {
  const scopePL=text(input.scopePL,'zakres PL'),scopeNO=text(input.scopeNO,'zakres NO');
  const client=text(input.client,'klient',200);
  check(typeof input.personHours==='number'&&input.personHours>0&&input.personHours<=10000,'Podaj łączną liczbę roboczogodzin wszystkich osób');
  check(input.confirmedCosts===true,'Potwierdź koszty materiałów i logistyki, również jeśli wynoszą zero');
  const labour=Math.round(input.personHours*85000),materials=cents(input.materialsNet,'materiały'),logistics=cents(input.logisticsNet,'logistyka');
  const net=labour+materials+logistics,mva=Math.round(net*.25),gross=net+mva;
  const fmt=n=>new Intl.NumberFormat('nb-NO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n/100)+' NOK';
  const exclusionsPL=text(input.exclusionsPL,'wyłączenia PL'),exclusionsNO=text(input.exclusionsNO,'wyłączenia NO');
  const common='Tromsø Bygg & Tre ANS · Org.nr. 936 389 511';
  return {id:randomBytes(12).toString('hex'),createdAt:new Date().toISOString(),client,
    internal:{personHours:input.personHours,rateNet:850,labourNet:labour/100,materialsNet:materials/100,logisticsNet:logistics/100},
    net:net/100,mva:mva/100,gross:gross/100,
    pl:`${common}\n\nPROJEKT OFERTY FAST PRICE\nKlient: ${client}\n1 kpl. – ${scopePL}\n\nFast Price netto: ${fmt(net)}\nMVA 25%: ${fmt(mva)}\nFast Price brutto: ${fmt(gross)}\n\nWyłączenia: ${exclusionsPL}\nDodatkowe prace wymagają osobnego uzgodnienia i wyceny.`,
    no:`${common}\n\nUTKAST TIL FASTPRISTILBUD\nKunde: ${client}\n1 pakke – ${scopeNO}\n\nFastpris eks. mva: ${fmt(net)}\nMVA 25 %: ${fmt(mva)}\nFastpris inkl. mva: ${fmt(gross)}\n\nIkke inkludert: ${exclusionsNO}\nTilleggsarbeid krever egen avtale og pris.`};
}
export function action(kind,payload) {
  check(['send_email','calendar_event','drive_file'].includes(kind),'Nieznany rodzaj działania');
  const snapshot=structuredClone(payload);
  return {id:randomBytes(12).toString('hex'),kind,payload:snapshot,digest:hash({kind,payload:snapshot}),state:'pending',createdAt:new Date().toISOString()};
}
export async function execute(store,id,digest,confirmed,perform) {
  const a=store.data.actions.find(x=>x.id===id); check(a,'Nie znaleziono działania');
  check(a.state==='pending','Działanie zostało już obsłużone lub wymaga ręcznego sprawdzenia');
  check(confirmed===true&&equal(a.digest,digest)&&equal(a.digest,hash({kind:a.kind,payload:a.payload})),'Wymagane potwierdzenie dokładnej treści i odbiorcy');
  a.state='executing'; a.approvedAt=new Date().toISOString(); store.audit('approved',a.id);
  try {const result=await perform(a);a.state='completed';a.result=result;store.audit('completed',a.id);return a;}
  catch(e) {a.state='uncertain';store.audit('requires_manual_check',a.id);throw Object.assign(new Error('Nie potwierdzono wyniku. Sprawdź Google przed ponowną operacją.'),{status:502});}
}
