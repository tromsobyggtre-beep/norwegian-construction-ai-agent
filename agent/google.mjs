import {OAuth2Client} from 'google-auth-library';
import {check} from './core.mjs';
export const scopes=['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/drive.metadata.readonly','https://www.googleapis.com/auth/drive.file'];
export class Google {
  constructor(store,env=process.env) {this.store=store;this.env=env;}
  configured(){return !!(this.env.GOOGLE_CLIENT_ID&&this.env.GOOGLE_CLIENT_SECRET&&this.env.PUBLIC_URL&&this.env.GOOGLE_ACCOUNT_EMAIL);}
  client(persist=true) {
    check(this.configured(),'Najpierw skonfiguruj klienta OAuth Google i adres konta firmy');
    const c=new OAuth2Client(this.env.GOOGLE_CLIENT_ID,this.env.GOOGLE_CLIENT_SECRET,this.env.PUBLIC_URL+'/oauth/google/callback');
    if(this.store.data.google)c.setCredentials(this.store.data.google);
    if(persist)c.on('tokens',t=>{this.store.data.google={...this.store.data.google,...t};this.store.save();});return c;
  }
  async request(url,options={}) {
    check(this.store.data.google?.refresh_token,'Połącz konto Google');
    const r=await this.client().request({url,timeout:25000,retry:false,...options});return r.data;
  }
  async monitor() {
    const now=new Date(),end=new Date(now.getTime()+14*86400000);
    const [mail,events,files]=await Promise.all([
      this.request('https://gmail.googleapis.com/gmail/v1/users/me/messages',{params:{q:'in:inbox newer_than:30d -in:spam -in:trash',maxResults:30}}),
      this.request('https://www.googleapis.com/calendar/v3/calendars/primary/events',{params:{timeMin:now.toISOString(),timeMax:end.toISOString(),singleEvents:true,orderBy:'startTime',maxResults:50}}),
      this.request('https://www.googleapis.com/drive/v3/files',{params:{q:'trashed = false',pageSize:50,orderBy:'modifiedTime desc',fields:'files(id,name,mimeType,modifiedTime,webViewLink)'}})
    ]);
    const messages=[];
    for(const m of mail.messages||[]) {
      const d=await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`,{params:{format:'metadata',metadataHeaders:['From','Subject','Date']}});
      const h=Object.fromEntries((d.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));
      messages.push({id:d.id,threadId:d.threadId,from:h.from,subject:h.subject,date:h.date,snippet:d.snippet,labels:d.labelIds});
    }
    return {at:now.toISOString(),messages,events:(events.items||[]).map(x=>({id:x.id,summary:x.summary,start:x.start,end:x.end,status:x.status,htmlLink:x.htmlLink})),files:files.files||[],limits:{mail:30,events:50,files:50},note:'Migawka ograniczona do podanych limitów. Status płatności i wykonania wymaga dokumentów; sama wiadomość nie jest dowodem.'};
  }
  async perform(a) {
    if(a.kind==='send_email') {
      const p=a.payload;
      const mime=`To: ${p.to}\r\nSubject: =?UTF-8?B?${Buffer.from(p.subject).toString('base64')}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(p.body).toString('base64').match(/.{1,76}/g).join('\r\n')}`;
      return this.request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',data:{raw:Buffer.from(mime).toString('base64url')}});
    }
    if(a.kind==='calendar_event') {
      const p=a.payload;
      const busy=await this.request('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',data:{timeMin:p.start.dateTime,timeMax:p.end.dateTime,items:[{id:'primary'}]}});
      check(busy.calendars?.primary&&!busy.calendars.primary.errors,'Nie udało się potwierdzić dostępności kalendarza');
      check(!busy.calendars.primary.busy?.length,'Termin koliduje z wydarzeniem w kalendarzu');
      return this.request('https://www.googleapis.com/calendar/v3/calendars/primary/events',{method:'POST',params:{sendUpdates:'none'},data:{...p,id:a.id}});
    }
    if(a.kind==='drive_file') {
      const boundary='tbt'+a.id,p=a.payload;
      const metadata={name:p.name,mimeType:'text/plain',...(this.env.GOOGLE_DRIVE_FOLDER_ID?{parents:[this.env.GOOGLE_DRIVE_FOLDER_ID]}:{})};
      return this.request('https://www.googleapis.com/upload/drive/v3/files',{method:'POST',params:{uploadType:'multipart',fields:'id,name,webViewLink'},headers:{'Content-Type':`multipart/related; boundary=${boundary}`},data:`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${p.content}\r\n--${boundary}--`});
    }
  }
}
