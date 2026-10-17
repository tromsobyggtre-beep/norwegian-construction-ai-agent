# Norwegian Construction AI Agent

Projekt dla Tromsø Bygg & Tre, oparty na [OpenConstructionERP](https://github.com/datadrivenconstruction/OpenConstructionERP), z konfiguracją wdrożenia na Northflank.

## Co zawiera projekt

- `openconstructionerp/` — pełne repozytorium ERP jako submoduł Git, przypięte do wydania **v18.6.4**, commit `a7adbbe01bacac0b44168a279a8a2f286551dd02`.
- `Dockerfile` — oficjalny obraz tego wydania przypięty sumą SHA-256; frontend i API na porcie 8080.
- `deploy/northflank.template.json` — infrastruktura Northflank: aplikacja, PostgreSQL, sekrety, trwały dysk i kontrola stanu.
- `scripts/bootstrap_admin.py` — utworzenie pierwszego administratora przez prywatną konsolę.
- `compose.yaml` — lokalne uruchomienie tej samej aplikacji z PostgreSQL.

Konfiguracja wyłącza dane demonstracyjne i publiczną rejestrację. Pierwszego administratora tworzysz przed otwarciem publicznego portu. Klucz dostawcy AI jest opcjonalny i trafia do sekretów hostingu.

## Wdrożenie na Northflank

Przejdź do [instrukcji wdrożenia](docs/NORTHFLANK.md). Szablon należy uruchomić w swoim koncie Northflank po podłączeniu tego repozytorium GitHub. Dobierz region i plan w panelu przed utworzeniem płatnych zasobów.

Do zbudowania domyślnego obrazu nie trzeba pobierać submodułu — korzysta z przypiętego oficjalnego obrazu ERP. Zmiany kodu w `openconstructionerp/` wymagają osobnego budowania ze źródeł; sam Dockerfile w katalogu głównym ich nie wdraża.

## Pobranie kodu

```sh
git clone --recurse-submodules https://github.com/tromsobyggtre-beep/norwegian-construction-ai-agent.git
cd norwegian-construction-ai-agent
```

Jeśli masz już klon:

```sh
git submodule update --init --recursive
```

## Uruchomienie lokalne

1. Skopiuj `.env.example` do `.env` i wpisz dwa różne, losowe sekrety: `POSTGRES_PASSWORD` i `JWT_SECRET`. Każdy możesz wygenerować poleceniem `python -c "import secrets; print(secrets.token_hex(32))"`.
2. Uruchom `docker compose up --build -d --wait`.
3. Utwórz administratora: `docker compose exec erp python /opt/deployment/bootstrap_admin.py`.
4. Otwórz [http://localhost:8080](http://localhost:8080).

PostgreSQL i dokumenty mają oddzielne, trwałe wolumeny. `docker compose down` zatrzymuje usługę i zachowuje dane. Usuwanie wolumenów usuwa również dane.

## Weryfikacja i aktualizacje

```sh
node scripts/validate-deployment.mjs
python -m unittest discover -s tests -v
```

GitHub Actions wykonuje te kontrole i test startu kontenera z PostgreSQL. Lokalny test kontenera wymaga Dockera. Wersje źródeł i obrazu zapisane są w `source-lock.json`; aktualizuj submoduł, wersję oraz digest razem. Przed aktualizacją wykonaj kopię PostgreSQL i `/data`; migracja bazy może wymagać przywrócenia kopii przy powrocie do starszego wydania.

## Rozwój własnych funkcji

Przed zmianą ERP przeczytaj `openconstructionerp/DEVELOPING.md`. Kompilacja obrazu ze zmodyfikowanych źródeł:

```sh
docker build -f openconstructionerp/deploy/docker/Dockerfile.unified -t norwegian-erp-source openconstructionerp
```

Budowa frontendu tego wydania wymaga około 14 GB RAM. Domyślne wdrożenie używa gotowego obrazu, więc nie wykonuje tej kompilacji. Własne integracje norweskich dostawców i reguły wyceny można rozwijać na dołączonym kodzie ERP.

## Licencja

OpenConstructionERP i konfiguracja tego projektu są udostępniane na AGPL-3.0-or-later. Pełna treść: [LICENSE](LICENSE); informacje o autorach i składnikach: [NOTICE](NOTICE) oraz pliki w submodule. Przy udostępnianiu zmodyfikowanej aplikacji przez sieć należy zapewnić użytkownikom dostęp do odpowiadającego jej kodu źródłowego na warunkach licencji.
