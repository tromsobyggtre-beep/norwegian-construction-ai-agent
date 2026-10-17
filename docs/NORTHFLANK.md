# Open Construction ERP na Northflank

Szablon `deploy/northflank.template.json` tworzy projekt, prywatny PostgreSQL 16 z TLS, grupę sekretów, dysk `/data` i usługę aplikacji z portem 8080. Pierwsze uruchomienie pozostaje prywatne, aby właściciel utworzył konto administratora przed udostępnieniem ERP.

Dockerfile w głównym katalogu korzysta z oficjalnego obrazu OpenConstructionERP 18.6.4 przypiętego do digestu SHA-256. Repozytorium upstream jest dołączone jako submoduł `openconstructionerp`. Budowanie tego wdrożenia nie kompiluje frontend/backend ze źródeł submodułu. Zmiany w samym submodule nie zmieniają uruchamianej aplikacji — aktualizacja wymaga świadomej zmiany wersji obrazu w Dockerfile.

## 1. Przygotuj konto i konfigurację

1. Połącz GitHub z Northflank i przyznaj dostęp do `tromsobyggtre-beep/norwegian-construction-ai-agent`.
2. Dopilnuj, aby pliki konfiguracji były już na wdrażanej gałęzi. Domyślna gałąź szablonu to `main`; przed scaleniem można ustawić argument `branch` na gałąź przygotowanego PR.
3. W Northflank otwórz **Templates**, utwórz szablon i wklej JSON z `deploy/northflank.template.json` do edytora kodu. Zapisanie szablonu nie uruchamia zasobów automatycznie.
4. Sprawdź argumenty i podsumowanie opłat przed **Run**. Identyfikatory planów, limity konta i dostępność regionu należy potwierdzić w panelu.

| Argument | Wartość początkowa / znaczenie |
| --- | --- |
| `projectName` | `Norwegian Construction ERP`; osobny projekt dla ERP |
| `region` | `europe-west`; zmiana regionu wymaga migracji danych |
| `repositoryUrl`, `branch` | Twoje repozytorium i gałąź zawierająca konfigurację |
| `appPlan` | `nf-compute-100-4`: 1 CPU / 4 GiB RAM; zapas na import katalogów kosztów |
| `databasePlan` | `nf-compute-50`: 0,5 CPU / 1 GiB RAM |
| `buildPlan` | `nf-compute-400-16`: 4 CPU / 16 GiB RAM, tylko na czas budowy |
| `databaseStorageMB`, `appStorageMB` | Po 10240 MB; osobny dysk bazy i aplikacji |
| `appOrigin` | Początkowo `https://example.invalid`; przed publikacją ustaw rzeczywisty adres HTTPS, bez końcowego `/` i bez ścieżki |
| `publicHttp` | Początkowo `false`; pozostaw do zakończenia kroku 2 |

Publiczne API planów Northflank podczas przygotowania konfiguracji wskazywało 36 USD/miesiąc dla aplikacji i 12 USD/miesiąc dla bazy. To około **48 USD/miesiąc za sam compute**, bez dysków, kopii zapasowych, budowania, transferu i podatków. Plan budowy ma stawkę 0,20 USD/godz.; jest naliczany podczas budowania. Ostateczne stawki, rozliczenie i wybrane zasoby sprawdź w panelu przed uruchomieniem. [Plany API](https://api.northflank.com/v1/plans), [cennik Northflank](https://northflank.com/pricing).

Domyślne 4 GiB aplikacji uwzględnia wzrost pamięci przy imporcie katalogów kosztów. Dokumentacja upstream podaje około 800 MB dla bezczynnej aplikacji i dodatkowo około 1,2 GB podczas importu; 2 GiB zostawiałoby niewielki zapas. Dobór CPU i RAM wymaga potwierdzenia na rzeczywistych danych i liczbie użytkowników. [Wymagania upstream](https://github.com/datadrivenconstruction/OpenConstructionERP/blob/v18.6.4/docs/INSTALL_LINUX.md).

## 2. Uruchom prywatnie i utwórz administratora

1. Uruchom szablon z `publicHttp=false`. Szablon czeka na uruchomienie PostgreSQL, podłącza jego dane dostępowe i dysk `/data`, a następnie konfiguruje usługę budującą główny `/Dockerfile` z kontekstem `/`. Gdy usługa nie ma jeszcze obrazu, uruchom pierwszy build z wybranej gałęzi w jej zakładce **Builds**.
2. Poczekaj na udany build, migracje i zdrową instancję. Kontrole HTTP sprawdzają `/api/health` na porcie 8080. Kontrola startowa pozwala na około 15 minut rozruchu. Przy błędach sprawdź logi bazy i aplikacji przed kolejną próbą.
3. W interaktywnej konsoli **Exec** działającego kontenera uruchom:

   ```sh
   python /opt/deployment/bootstrap_admin.py
   ```

   Podaj własny e-mail, imię/nazwę i silne hasło. Hasło jest wpisywane w ukryciu. Potrzebna jest interaktywna konsola/TTY; nie przekazuj danych w argumentach polecenia ani przez potok. Helper łączy się wyłącznie z lokalną aplikacją. Sukces potwierdza aktywne konto administratora.
4. **Dopiero po potwierdzonym utworzeniu administratora udostępnij port.** `OE_REGISTRATION_MODE=closed` blokuje dalszą samodzielną rejestrację, ale upstream dopuszcza pierwszego administratora również w tym trybie. Dlatego świeżej instalacji nie należy publikować przed tym krokiem.

Nie zmieniaj `SEED_DEMO=false`: zapobiega wstawianiu demonstracyjnych kont i danych. Helper służy wyłącznie pierwszej inicjalizacji; nie resetuje hasła istniejącego administratora.

## 3. Opublikuj usługę przez HTTPS

Po utworzeniu administratora w **Networking** usługi `open-construction-erp` włącz publiczny port HTTP 8080. Northflank nada mu adres HTTPS. Jeżeli potrzebujesz własnej domeny, najpierw zweryfikuj ją w Northflank i połącz z tym portem.

W konfiguracji aplikacji ustaw `ALLOWED_ORIGINS` i `FRONTEND_URL` na dokładny adres HTTPS, np. `https://erp.twoja-domena.no`, i wykonaj redeploy. Dla kilku dozwolonych originów `ALLOWED_ORIGINS` jest listą rozdzieloną przecinkami; `FRONTEND_URL` pozostaje jednym adresem. Usuń `https://example.invalid`. Następnie otwórz stronę i zaloguj się utworzonym kontem.

Zapisz rzeczywisty adres jako argument `appOrigin` szablonu i zmień argument `publicHttp` na `true` po zakończeniu bootstrapu, aby późniejsze uruchomienie szablonu zachowało publikację. Wyłączone `autorun` pozwala osobno przejrzeć i uruchomić zmiany infrastruktury. Kod na wdrażanej gałęzi ma włączone CI; zmiany samej dokumentacji są pomijane. Kolejne commity nie wymagają ponownego uruchamiania całego szablonu.

Sprawdź przez publiczny adres: `/api/health` zwraca powodzenie, logowanie działa, a próba nowej rejestracji po bootstrapie jest zablokowana. Dodaj dokument testowy i po kontrolowanym restarcie sprawdź jego dostępność. To potwierdza działanie aplikacji, bazy i trwałego dysku na rzeczywistym koncie.

## Dane, sekrety i eksploatacja

Grupa `erp-runtime` otrzymuje z dodatku PostgreSQL aliasy `OE_DB_HOST`, `OE_DB_PORT`, `OE_DB_USER`, `OE_DB_PASSWORD`, `OE_DB_NAME`. `PGSSLMODE=require` wymusza szyfrowane połączenie obu sterowników aplikacji. Nie dodawaj równolegle `DATABASE_URL`/`DATABASE_SYNC_URL`: nadpisują konfigurację częściową, a parametr `sslmode` w URL SQLAlchemy/asyncpg może być niezgodny ze sterownikiem.

`JWT_SECRET` powstaje przez `fn.randomSecret(64, 'hex')` i pozostaje w zaszyfrowanej grupie sekretów przy następnych uruchomieniach szablonu. Nigdy nie wpisuj haseł, tokenów ani plików `.env` do Git. Grupa jest dostępna dla zasobów w tym wydzielonym projekcie — nie dodawaj tu niezaufanych usług. Klucze do wybranego dostawcy AI i ustawienia poczty dodaj jako sekrety runtime, jeśli chcesz używać tych integracji. Podstawowe wdrożenie nie tworzy zewnętrznych kont AI ani nie kupuje ich usług.

Dysk `erp-data` ma tryb `ReadWriteOnce` i montuje się pod `/data`; obejmuje pliki aplikacji i LanceDB pod `/data/vectors`. Obraz kończy się `USER oe:oe`, aby Northflank nadał dyskowi grupę używaną przez aplikację. Nie wymuszaj innego użytkownika w panelu. Nie zakładaj stałego numeru UID/GID. [Zasady uprawnień i wolumenów](https://northflank.com/docs/v1/application/databases-and-persistence/add-a-volume).

Utrzymuj **jedną instancję** aplikacji. Przy takim dysku Northflank zatrzymuje poprzedni kontener przed uruchomieniem kolejnego, więc aktualizacja powoduje krótką przerwę. Redis nie jest wymagany do tego wariantu (`REDIS_URL` jest pusty); pracownicy, wiele instancji i współdzielone przetwarzanie w tle wymagają osobnego projektu architektury oraz przetestowania.

Szablon ustawia codzienny dump PostgreSQL o 03:15 i snapshot dysku o 03:30 według czasu harmonogramu Northflank, z retencją 7 dni. Sprawdź widoczną w panelu strefę i rzeczywiste wykonanie kopii. Są to oddzielne kopie; przed migracją lub istotną aktualizacją zatrzymaj zapisy, wykonaj skoordynowaną kopię bazy i `/data`, a następnie przetestuj odtworzenie obu w odizolowanym projekcie. Sama kopia bazy nie zawiera plików z dysku aplikacji.

Aktualizację OpenConstructionERP przygotuj najpierw na stagingu: przypnij nowy tag/commit submodułu i odpowiadający digest obrazu, przeczytaj migracje, zbuduj obraz i sprawdź logowanie, pliki, restart oraz przywrócenie kopii. Cofnięcie samego obrazu może być niewystarczające po migracji schematu bazy. Nie usuwaj dodatku PostgreSQL ani dysku w celu naprawienia nieudanego builda.

## Źródła konfiguracji

- [Szablony i kolejność zasobów](https://northflank.com/docs/v1/application/infrastructure-as-code/write-a-template)
- [Argumenty, referencje i trwałe losowe sekrety](https://northflank.com/docs/v1/application/infrastructure-as-code/make-a-template-dynamic)
- [Publiczny schemat API Northflank](https://api.northflank.com/v1/swagger-json)
- [OpenConstructionERP — źródła](https://github.com/datadrivenconstruction/OpenConstructionERP)

JSON oraz specyfikacje zasobów można sprawdzić lokalnie. Pełne potwierdzenie wdrożenia wymaga udanego buildu, startu i kontroli funkcjonalnej na docelowym koncie Northflank.
