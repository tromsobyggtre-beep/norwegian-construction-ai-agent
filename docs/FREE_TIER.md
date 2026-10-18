# OpenConstructionERP — pilotaż w Northflank Sandbox

`Dockerfile.free` buduje opcjonalny, ograniczony profil ERP dla małej liczby użytkowników: projekty, przedmiary (BOQ), katalog pozycji i podstawowe koszty. Pełny wariant pozostaje w `Dockerfile`. Nazwa profilu nie jest gwarancją bezpłatnego hostingu ani wystarczającej pamięci.

Użytkownik potwierdził aktywny **Developer Sandbox — Free**. Dokładne dostępne zasoby RAM, pojemność bazy i pozostałe limity trzeba sprawdzić w panelu tego konta. [Northflank](https://northflank.com/pricing) podaje 2 darmowe usługi, 2 zadania i 1 dodatek, lecz publiczne plany zasobów nie potwierdzają darmowych uprawnień konta. [Zasady planów i limitów](https://northflank.com/docs/v1/application/billing/resource-plans-and-quotas).

## Proponowana konfiguracja

| Ustawienie | Wariant pilotażowy |
| --- | --- |
| Zespół | `tromsobyggtres-team` |
| Projekt | Istniejący `default` |
| Środowisko | Bez środowiska |
| Aplikacja | Istniejąca usługa `norwegian-construction-ai-agent`, 1 instancja |
| Budowanie | `/Dockerfile.free`, kontekst `/`, przejrzana gałąź z tym plikiem |
| RAM i CPU aplikacji | Najmniejszy plan **dostępny bezpłatnie na tym koncie**, który przejdzie testy pamięci |
| Baza | 1 dodatek PostgreSQL; wyłącznie plan i pojemność objęte darmowym Sandbox |
| Dane trwałe | Dane ERP w PostgreSQL; pojemność zgodna z limitem konta, bez założenia konkretnej liczby GB |
| Dysk aplikacji | Bez dodatkowego wolumenu, dopóki jego bezpłatność nie zostanie potwierdzona |
| Port | HTTP 8080, początkowo prywatny |
| Pozostałe zasoby | Bez Redis, osobnych workerów, dodatkowej usługi frontendu i płatnych integracji AI |
| Planowany koszt | **0 USD**, warunkowo: panel musi pokazać 0 USD dla wybranych zasobów, budowania i limitów wykorzystania |

Nie uruchamiaj dla tego wariantu wcześniejszego `deploy/northflank.template.json` ani szablonu z 4 GB RAM i dyskami po 10 GB. Opisują inny, płatny wariant. Nie twórz zastępczego projektu i nie przełączaj planu konta. Jeśli żaden bezpłatny plan nie przejdzie testów, zatrzymaj wdrożenie; płatne zwiększenie zasobów wymaga zgody właściciela.

## Zakres i ograniczenia profilu

Profil uruchamia 11 modułów: użytkownicy, projekty, BOQ, koszty, katalog, zestawy robót, kursy walut, języki, walidacja, status zadań i onboarding. Zachowuje wszystkie modele ORM oraz schemat bazy, uwierzytelnianie i walidację. Nie usuwa tabel ani zapisanych ustawień modułów. Pełny obraz pozwala później wrócić do pełnego zakresu funkcji po sprawdzeniu zasobów i zgodności danych.

Wyłączone są AI i semantyczne wyszukiwanie, pobieranie modeli embeddingów, BIM, ciężkie procesy w tle, masowe importy CWICR i katalogów, automatyczne wypełnianie bazy demonstracyjnej oraz aktualizacje podczas pracy. Aktywne funkcje interfejsu mogą być szersze od dostępnego API; operacje spoza profilu będą niedostępne. Małe importy BOQ nadal wymagają sprawdzenia na docelowym limicie pamięci.

Obraz bazuje na gotowym oficjalnym OpenConstructionERP 18.6.4 przypiętym do digestu SHA-256. Unika to kompilacji frontendu ze źródeł, dla której wcześniej przewidziano maszynę budowania z 16 GB RAM. Wielkość obrazu i czas jego pobierania pozostają istotne; przed uruchomieniem sprawdź również limity oraz wycenę buildu na koncie.

Bez trwałego wolumenu katalog `/data` jest nietrwały. **Nie zapisuj w tym pilotażu załączników, plików BIM, trwałych wektorów ani innych dokumentów na lokalnym dysku kontenera.** Restart lub ponowne wdrożenie może je usunąć. Trwałość PostgreSQL nie oznacza trwałości tych plików. Nie zakładaj bezpłatnych kopii zapasowych; przed danymi rzeczywistymi sprawdź eksport i odtworzenie bazy. Sandbox służy do testów, zgodnie z [dokumentacją Northflank](https://northflank.com/docs/v1/application/billing/pricing-on-northflank).

## Uruchomienie po zatwierdzeniu konfiguracji

1. W panelu właściwego zespołu potwierdź cenę 0 USD i dostępność planów aplikacji oraz PostgreSQL. Zweryfikuj wolny limit dodatku, budowanie, transfer i przechowywanie danych. CLI i dostęp do wskazanego projektu były już zweryfikowane; tokenów nie zapisuj w repozytorium.
2. W istniejącej usłudze zmień obecny Buildpack na Dockerfile: `/Dockerfile.free`, kontekst `/`, gałąź zawierająca przejrzane zmiany. Utrzymuj jedną instancję, port 8080 prywatny i kontrolę zdrowia `/api/health`.
3. Podłącz sekrety PostgreSQL jako `OE_DB_HOST`, `OE_DB_PORT`, `OE_DB_USER`, `OE_DB_PASSWORD`, `OE_DB_NAME`, ustaw `PGSSLMODE=require` i wygeneruj trwały `JWT_SECRET` w sekretach Northflank. Nie publikuj ich w Git ani w rozmowie. Pozostaw zabezpieczenia oraz limity z `Dockerfile.free`, w tym `SEED_DEMO=false` i `OE_REGISTRATION_MODE=closed`.
4. Po udanym starcie, migracjach i testach pamięci uruchom w prywatnej, interaktywnej konsoli kontenera:

   ```sh
   python /opt/deployment/bootstrap_admin.py
   ```

   Wprowadź własny e-mail i hasło w konsoli. Dopiero po potwierdzonym utworzeniu administratora udostępnij port i ustaw `ALLOWED_ORIGINS` oraz `FRONTEND_URL` na rzeczywisty adres HTTPS.
5. Sprawdź logowanie, zapis projektu i pozycji BOQ, koszty oraz zachowanie danych bazy po kontrolowanym restarcie. Obserwuj pamięć przy rozruchu i typowej pracy. Jeśli wystąpi OOM lub brak zapasu, nie zwiększaj automatycznie planu poza darmowy limit.

## Wyniki weryfikacji

Wyniki pomiarów i testów należy uzupełnić przed zatwierdzeniem wdrożenia:

| Sprawdzenie | Status |
| --- | --- |
| Start aplikacji i migracje przy docelowym limicie RAM | Oczekuje na pomiar |
| Maksymalne zużycie pamięci podczas rozruchu i pracy | Oczekuje na pomiar |
| Logowanie, projekt, BOQ i podstawowe koszty | Oczekuje na test |
| Dane PostgreSQL po restarcie | Oczekuje na test |
| Cena 0 USD w panelu dla ostatecznej konfiguracji | Oczekuje na potwierdzenie |

Przejście testów lokalnych nie potwierdza dostępnego limitu ani kosztu na docelowym koncie Northflank.
