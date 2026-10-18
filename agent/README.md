# Bogdan — agent TBT na Northflank

Agent działa niezależnie od zachowanego ERP w głównym katalogu. Buduj `agent/Dockerfile` z kontekstem repozytorium. Port 8080, kontrola stanu `/healthz`, jedna instancja, trwały dysk `/data`. Wszystkie dane i refresh token Google są szyfrowane AES-256-GCM. Zachowaj niezależną, bezpieczną kopię `DATA_ENCRYPTION_KEY`; bez niej odtworzenie kopii danych jest niemożliwe.

Wycena: osobogodziny × 850 NOK netto + potwierdzone materiały netto + potwierdzona logistyka netto. MVA 25%. Bez automatycznego narzutu na stawkę sprzedaży. Potwierdź osobno, że wszystkie koszty zostały uwzględnione. Wygenerowane wersje PL i NO są projektami do sprawdzenia. Ilości i zakres wpisuje właściciel; agent nie wymyśla pomiarów. Dla okien domyślnie uwzględnij zakup i dostawę TBT.

## Google od początku

1. W koncie firmy utwórz projekt Google Cloud `TBT Bogdan Agent`.
2. Włącz Gmail API, Google Calendar API, Google Drive API.
3. W Google Auth Platform ustaw nazwę aplikacji `TBT Bogdan`, firmowy adres wsparcia i adres kontaktowy właściciela. Konto Gmail wymaga typu External. W trybie Testing dodaj `tromsobyggtre@gmail.com` jako test user. Zewnętrzny tryb Testing dla tych uprawnień może powodować wygaśnięcie refresh tokena po 7 dniach; do stałej pracy sprawdź wymagania publikacji i weryfikacji Google. Nie omijaj ostrzeżeń bezpieczeństwa.
4. Utwórz klienta OAuth typu Web application. Authorized redirect URI: `https://site--norwegian-construction-ai-agent--jkpql7qmx4kk.code.run/oauth/google/callback`.
5. W sekretach runtime istniejącej usługi Northflank dodaj `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ACCOUNT_EMAIL=tromsobyggtre@gmail.com`. Nie wklejaj sekretów do czatu ani Git. Opcjonalnie ustaw `GOOGLE_DRIVE_FOLDER_ID` na folder ofert.
6. Po ponownym wdrożeniu otwórz panel, zaloguj się kluczem `ADMIN_TOKEN`, wybierz Połącz Google i samodzielnie udziel zgody na ekranie Google. PKCE i jednorazowy state chronią wymianę kodu; konto musi odpowiadać ustawionemu adresowi.
7. Uruchom ręczny przegląd, sprawdź wynik i włącz monitoring co 15 minut. Monitoring odczytuje dane, nie wysyła wiadomości. Zmienione źródła są widoczne w ostatniej migawce panelu; ta wersja nie wysyła powiadomień push ani e-mailowych.

Zakresy OAuth są jawnie zadeklarowane w `google.mjs`: odczyt Gmail + wysłanie zatwierdzonej wiadomości; odczyt kalendarza + zapis wydarzenia; odczyt Drive + tworzenie plików aplikacji. Odczyt Drive w tej wersji pobiera nazwy i metadane, a Gmail nagłówki i skróty wiadomości. Treść załączników i dokumentów nie jest automatycznie importowana. Limity migawki: 30 wiadomości z ostatnich 30 dni, 50 wydarzeń w ciągu 14 dni, 50 plików. To nie jest pełny audyt skrzynki.

## Jednorazowy OAuth przez komputer właściciela

Jeśli Google odrzuca współdzieloną domenę `code.run`, zarejestruj klienta Web z redirect URI `http://localhost:8787/oauth/google/callback`. Pomocnik `oauth-local.mjs` uruchamia nasłuch wyłącznie na `127.0.0.1`, sprawdza PKCE, jednorazowy state i adres konta, a otrzymane tokeny zapisuje wyłącznie w szyfrowanym magazynie. Wymaga `GOOGLE_CREDENTIALS_FILE` (pobrany JSON Web OAuth), `GOOGLE_ACCOUNT_EMAIL`, `DATA_ENCRYPTION_KEY`, `OAUTH_DATA_DIR`, `OAUTH_URL_FILE`. Uruchom `node oauth-local.mjs`, otwórz adres z `OAUTH_URL_FILE` i samodzielnie zaakceptuj dostęp Google. Sesja domyślnie wygasa po 15 minutach; przy interaktywnym przekazaniu właścicielowi można ustawić `OAUTH_SESSION_MINUTES=60` (dozwolone 1–60). Nie przekazuj pliku JSON ani tokenów w czacie.

Po zgodzie przenieś przez zaufany proces wdrożenia `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` i `GOOGLE_REDIRECT_URI=http://localhost:8787/oauth/google/callback` do sekretów runtime Northflank. Ten refresh token inicjalizuje szyfrowany magazyn agenta. Zmiana tokenu lub klienta w zmiennych środowiskowych zastępuje poprzednie dane dostępowe po przeładowaniu usługi, zachowując oferty i ustawienia. Komputer nie jest potrzebny do odświeżania tokena; jest potrzebny tylko przy ponownym udzielaniu zgody. Przycisk Połącz Google w panelu informuje wtedy o konieczności użycia pomocnika. Ustawienia aplikacji w trybie Testing mogą nadal wymagać ponownej zgody po 7 dniach.

18 października 2026 projekt `tbt-bogdan-agent` został przełączony na External / In production. Własna domena aplikacji to `tromsobyggtre.no`; publiczny opis jest pod `https://tromsobyggtre.no/tbt-bogdan`, a informacja o prywatności pod `https://tromsobyggtre.no/tbt-bogdan-personvern`. Tryb produkcyjny nie oznacza zakończenia weryfikacji Google; ostrzeżenie i limit niezweryfikowanej aplikacji mogą pozostać. Po zmianie trybu uzyskaj nowe upoważnienie, aby nie polegać na tokenie wydanym w Testing. Nowe tokeny produkcyjne nie podlegają testowej regule 7 dni, ale dostęp może zostać cofnięty lub wygasnąć z innych przyczyn.

## Na dziś i priorytety

Widok „Na dziś” pokazuje liczniki oraz propozycje do przeglądu wyliczane z zapisanych danych: działania oczekujące na zatwierdzenie, operacje z niepewnym wynikiem, potwierdzone terminy w najbliższych 48 godzinach i do 10 nieprzeczytanych wiadomości z INBOX, z pominięciem kategorii Promocje i Społeczności. Odnośniki prowadzą do źródeł w Google. Nieprzeczytana wiadomość nie oznacza braku odpowiedzi, a tytuł wiadomości lub wydarzenia nie potwierdza płatności ani wykonania prac.

Terminy są wyświetlane i wprowadzane w czasie norweskim `Europe/Oslo`. Formularz daty nie wymaga ręcznego podawania strefy; serwer przelicza ją na UTC, uwzględniając zmianę czasu. Nieistniejące godziny wiosną oraz podwójne godziny jesienią wymagają wybrania innej godziny. Wydarzenia całodniowe zachowują datę kalendarzową w Oslo.

## Analiza AI

Ustaw `OPENAI_API_KEY` i `OPENAI_MODEL` w sekretach Northflank. Model jest konfigurowalny, nie jest to nazwa wtyczki Bogdan. Przycisk Analiza Bogdana przekazuje ostatnią migawkę do OpenAI Responses API z `store:false`; AI nie otrzymuje narzędzi wykonujących działania. Analiza jest ręczna, bez cyklicznego kosztu modeli. Same obliczenia Fast Price działają bez klucza AI.

Analiza ma uporządkowany format: podsumowanie, do 5 priorytetów z uzasadnieniem i następnym krokiem, brakujące informacje oraz ostrzeżenia. Każdy priorytet wskazuje istniejące źródło z analizowanej migawki; odpowiedź z nieznanym identyfikatorem źródła jest odrzucana. Poprzednia analiza nie jest ponownie wysyłana jako materiał źródłowy. Panel zachowuje ostatni wynik i ostrzega, gdy monitoring pobierze nowszą migawkę niż ta użyta do analizy. Propozycje AI służą do sprawdzenia przez właściciela; wysyłki, zapis wydarzeń i plików nadal wymagają osobnego zatwierdzenia.

## Zatwierdzenia i eksploatacja

Każda wysyłka, wydarzenie i plik Drive powstaje jako niezmienna propozycja z sumą kontrolną. Zatwierdzenie dotyczy odbiorcy i dokładnej treści. Wynik niepewny lub przerwany pozostaje do ręcznego sprawdzenia; brak automatycznego ponowienia. Przed zapisem wydarzenia sprawdzana jest dostępność, bez zapraszania uczestników. Zapis Drive tworzy plik TXT, bez zmiany uprawnień. Nie ma kasowania poczty ani automatycznego archiwizowania.

Panel jest chroniony kluczem administratora przesyłanym w nagłówku HTTPS. Klucz nie jest zapisywany w przeglądarce. Dla większej liczby użytkowników należy dodać indywidualne konta/SSO. Zapis jest przeznaczony dla jednej instancji. Kopie dysku i klucza szyfrowania są osobnymi elementami odzyskiwania; regularnie testuj odtworzenie. Historia audytu ma limit 1000 wpisów, 1000 ofert i 2000 działań; po osiągnięciu limitu potrzebna jest świadoma archiwizacja.

Testy: `npm ci`, `npm test`. Integracja z prawdziwym kontem wymaga OAuth i testu wykonanego przez właściciela, bez wysyłania oferty do klienta w trakcie konfiguracji.

Dokumentacja: https://developers.google.com/identity/protocols/oauth2/web-server oraz https://developers.openai.com/api/docs/guides/text .
