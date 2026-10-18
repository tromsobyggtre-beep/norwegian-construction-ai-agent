// One-time owner OAuth. Binds loopback only; tokens are encrypted on disk.
import http from 'node:http';import fs from 'node:fs';import {randomBytes} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';import {Store,check,equal} from './core.mjs';import {scopes} from './google.mjs';
const env=process.env;
const source=JSON.parse(fs.readFileSync(env.GOOGLE_CREDENTIALS_FILE,'utf8').replace(/^\uFEFF/,''));const credentials=source.web;
check(credentials?.client_id&&credentials?.client_secret,'Wskaż pobrany plik klienta OAuth typu Web');
const redirect='http://localhost:8787/oauth/google/callback';
check(credentials.redirect_uris?.includes(redirect),'Klient nie zawiera poprawnego lokalnego redirect URI');
const store=new Store(env.OAUTH_DATA_DIR,env.DATA_ENCRYPTION_KEY),c=new OAuth2Client(credentials.client_id,credentials.client_secret,redirect);
const state=randomBytes(32).toString('hex'),{codeVerifier,codeChallenge}=await c.generateCodeVerifierAsync();
const auth=c.generateAuthUrl({access_type:'offline',prompt:'consent',scope:scopes,state,code_challenge:codeChallenge,code_challenge_method:'S256',login_hint:env.GOOGLE_ACCOUNT_EMAIL});
const sessionMinutes=Number(env.OAUTH_SESSION_MINUTES||15);
check(Number.isInteger(sessionMinutes)&&sessionMinutes>=1&&sessionMinutes<=60,'Czas sesji musi wynosić od 1 do 60 minut');
const sessionMs=sessionMinutes*60000,expires=Date.now()+sessionMs;let used=false;
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Type','text/plain; charset=utf-8');
  let stage='callback_validation';
  try{
    const u=new URL(req.url,'http://localhost:8787');
    if(u.pathname!=='/oauth/google/callback'){res.statusCode=404;return res.end('Nie znaleziono');}
    if(used||Date.now()>=expires||!equal(u.searchParams.get('state'),state)){
      res.statusCode=400;res.end('Ta karta dotyczy starszej lub zakończonej sesji. Wróć do aktualnej karty połączenia Google.');
      console.log('STALE_SESSION_IGNORED');return;
    }
    used=true;
    check(!u.searchParams.has('error'),'Zgoda nie została udzielona');
    stage='token_exchange';
    const {tokens}=await c.getToken({code:u.searchParams.get('code'),codeVerifier});check(tokens.refresh_token,'Brak refresh tokena. Cofnij wcześniejszą zgodę TBT i spróbuj ponownie.');
    store.data.pendingGoogle=tokens;store.audit('google_pending_verification','');
    stage='account_verification';
    c.setCredentials(tokens);const p=await c.request({url:'https://gmail.googleapis.com/gmail/v1/users/me/profile',timeout:25000});
    check(p.data.emailAddress?.toLowerCase()===env.GOOGLE_ACCOUNT_EMAIL.toLowerCase(),'Wybrano inne konto Google');
    store.data.google=tokens;delete store.data.pendingGoogle;store.audit('google_authorized',p.data.emailAddress);
    res.end('Połączono konto Google z TBT. Możesz zamknąć tę kartę. Trwa końcowa konfiguracja serwera.');
    console.log('GOOGLE_AUTH_COMPLETE');server.close();
  }catch(e){res.statusCode=400;res.end('Nie udało się potwierdzić połączenia konta. Sprawdź stan konfiguracji w czacie TBT.');console.log('GOOGLE_AUTH_FAILED',JSON.stringify({stage,code:e.code,status:e.response?.status,cause:e.cause?.code}));server.close();}
});
server.listen(8787,'127.0.0.1',()=>{fs.writeFileSync(env.OAUTH_URL_FILE,auth,{mode:0o600});console.log('Local Google authorization ready.');});
setTimeout(()=>{server.close();process.exit(0);},sessionMs).unref();
