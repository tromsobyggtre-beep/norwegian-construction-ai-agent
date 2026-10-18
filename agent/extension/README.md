# TBT · Mittanbud do Kalendarza

Prywatne rozszerzenie Chrome Manifest V3 dla Tromsø Bygg & Tre ANS. Po włączeniu zapisuje jednoznaczne terminy z **Twoich nowo wysłanych wiadomości** na `https://minbedrift.mittanbud.no/meldinger/<numer>` w istniejącej usłudze TBT. Domyślna wizyta trwa 30 minut. Daty i godziny dotyczą Tromsø.

## Uruchomienie przez właściciela

1. Otwórz `chrome://extensions` i włącz tryb programisty.
2. Wybierz „Załaduj rozpakowane” i wskaż ten folder `extension`.
3. Otwórz okno wtyczki. Wklej **ograniczony token integracji Mittanbud** wygenerowany dla TBT. Nie używaj klucza administratora ani kluczy Google/OpenAI.
4. Zapisz ustawienia i wybierz „Sprawdź połączenie”.
5. Włącz „Automatycznie zapisuj terminy”. Odśwież już otwartą rozmowę Mittanbud po pierwszej instalacji lub aktualizacji rozszerzenia.

Token wpisuje właściciel bezpośrednio w oknie rozszerzenia. Archiwum i kod nie zawierają tokenu. Jest zapisany lokalnie w tym profilu Chrome; nie jest udostępniany stronie Mittanbud ani skryptowi treści. Usunięcie tokenu wyłącza integrację i usuwa lokalną kolejkę oczekujących zgłoszeń.

## Kiedy wtyczka działa

- Karta Chrome z rozmową Mittanbud musi być otwarta, a konto zalogowane.
- Skrypt uruchamia się na domenie `minbedrift.mittanbud.no`, aby obsłużyć przejście z profilu do rozmowy bez przeładowania strony. Odczyt treści i przekazywanie danych są aktywne wyłącznie pod adresem `/meldinger/<numer>`; na pozostałych ścieżkach nie odczytuje treści formularzy ani wiadomości.
- Wtyczka wymaga ręcznego wpisania lub wklejenia treści oraz rzeczywistego kliknięcia „Wyślij” albo Enter bez Shift.
- Po wysyłce czeka na nowy dymek własnej wiadomości z identyczną znormalizowaną treścią, pusty edytor i jeszcze 3 sekundy bez widocznego stanu błędu lub wysyłania.
- Następnie otwiera jedną własną nieaktywną kartę tej samej rozmowy. W świeżo załadowanym widoku sprawdza własny wysłany dymek z tą samą treścią, brak wskaźnika błędu/wysyłania i 2 sekundy stabilnego widoku. Ta karta jest tylko do odczytu i zamyka się po sprawdzeniu lub po maksymalnie 45 sekundach. Karty właściciela pozostają otwarte.
- Nowy własny dymek pasujący do właśnie wysłanej treści oznacza jako niepodlegający tłumaczeniu. W swojej dodatkowej karcie weryfikacji chroni w ten sposób cały dokument, dopiero po potwierdzeniu przez proces wtyczki, że to utworzona przez nią karta. Nie zmienia ustawień tłumaczenia Chrome ani pozostałych rozmów. Jeśli Chrome zdąży przetłumaczyć wiadomość przed jej rozpoznaniem, dopasowanie jest pomijane; wyłączenie automatycznego tłumaczenia Mittanbud przez właściciela może poprawić synchronizację.
- Dopiero potwierdzenie z tej konkretnej świeżej karty pozwala przekazać zgłoszenie do TBT. Brak potwierdzenia, zamknięcie karty lub przekroczenie czasu kończą się komunikatem „Nie potwierdzono wysyłki — nie zapisano terminu”, bez wywołania API kalendarza.
- Weryfikacja korzysta ze świeżego widoku Mittanbud, a nie z przechwytywania wewnętrznych odpowiedzi sieciowych. Jeśli widok nie pozwala potwierdzić wysłania, automatyczny zapis jest pomijany.
- Do TBT przekazuje tylko własną wiadomość z kandydatem daty/dnia oraz numer i adres rozmowy i czas wysłania. Opcjonalnie dołącza tytuł projektu, gdy w rozmowie widoczny jest dokładnie jeden nagłówek projektu, o długości do 160 znaków. Nie odczytuje osobno nazwiska ani adresu klienta. Odczytane wiadomości klientów i historia rozmowy nie są importowane.
- Ponowne pojawienie się identycznej treści znanej już z widocznej historii jest pomijane dla ostrożności. W takim przypadku sprawdź termin ręcznie w panelu TBT.
- TBT rozstrzyga datę, godzinę i konflikt z kalendarzem. Niejasny termin, konflikt i niepewny wynik nie uruchamiają automatycznej kolejnej próby zapisu.

Rozszerzenie nie wysyła wiadomości Mittanbud i nie zmienia szkiców. Nie odczytuje plików cookie, pamięci strony ani ruchu sieciowego. Ma uprawnienie `storage` i dostęp tylko do domeny Mittanbud oraz wskazanej domeny serwera TBT. Nie zawiera zewnętrznych bibliotek ani zdalnego kodu.

## Przerwy połączenia

Kolejka weryfikacji i zapisów mieści łącznie najwyżej 20 zgłoszeń i jest zapisywana lokalnie. Jednocześnie otwarta jest najwyżej jedna własna karta weryfikacji. Krótkie błędy sieci, HTTP 429, 502, 503 i 504 po potwierdzeniu wysyłki są ponawiane maksymalnie 5 razy z rosnącym odstępem, zawsze z tym samym identyfikatorem idempotencji. Ponawianie budzi otwarta karta Mittanbud lub okno wtyczki; przy zamkniętym Chrome rozszerzenie nie pracuje. Po trwałym błędzie albo niepewnym wyniku sprawdź kalendarz i panel TBT.

## Sprawdzenie bez wiadomości do klientów

Testy adaptera można uruchomić z katalogu `agent` przez `node --test test/extension.test.mjs`. Weryfikują dozwolone adresy, tekst, warunki potwierdzenia nowej wysyłki, klucz idempotencji i ograniczenia ponawiania. Nie wykonują połączeń sieciowych, nie instalują rozszerzenia i nie wysyłają żadnych wiadomości.
