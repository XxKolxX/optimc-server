# OptiMC (v2.2.1)

**OptiMC** to modyfikacja dla środowiska **Fabric** (Minecraft 1.21.x), która na pierwszy rzut oka (w menu modów Minecrafta oraz w ustawieniach sterowania) wygląda na niewinny mod optymalizacyjny (kamuflaż jako narzędzie do zarządzania alokacją pamięci i pamięcią podręczną). 

W rzeczywistości jest to potężne, w pełni funkcjonalne narzędzie do **kooperacyjnego współdzielenia pozycji graczy, generowania mapy świata w czasie rzeczywistym oraz synchronizacji waypointów** bezpośrednio w przeglądarce internetowej.

---

## Jak działa mod (Opis rzeczywisty / True Description)

Mod integruje w sobie trzy główne komponenty uruchamiane lokalnie na kliencie gracza:
1. **Lokalny serwer mapy (Map Web Server)**: Uruchamia się w tle na porcie `9000` (domyślnie). Serwer ten serwuje interaktywną mapę (Leaflet.js) dostępną pod adresem `http://127.0.0.1:9000/`.
2. **Dynamiczny renderer chunków (Chunk Renderer)**: Nasłuchuje zdarzeń ładowania chunków w kliencie Minecrafta, konwertuje bloki na kolory i zapisuje wyrenderowane miniatury chunków w formacie `.png` w folderze konfiguracyjnym. Te kafelki (tiles) są następnie przesyłane do przeglądarki oraz na serwer współdzielenia.
3. **Klient synchronizacji (Location Sharer)**: Wykorzystuje protokół Server-Sent Events (SSE) oraz zapytania HTTP POST do komunikacji z zewnętrznym serwerem koordynującym (np. Render). Dzięki temu pozycje Twoja i Twoich znajomych, ich punkty życia (HP), kierunek patrzenia (yaw), aktualny wymiar oraz waypointy są natychmiast synchronizowane w czasie rzeczywistym.

### Najważniejsze funkcje:
* **Brak konieczności instalowania modów na serwerze**: Całość działa w 100% po stronie klienta. Serwer gry widzi Cię jako zwykłego gracza.
* **Automatyczne pokoje (Auto-Rooms)**: Jeśli nie podasz nazwy pokoju, mod generuje unikalny skrót SHA-256 na podstawie adresu serwera, na którym grasz. Wszyscy Twoi znajomi z tym modkiem na tym samym serwerze automatycznie trafią do tego samego pokoju i zobaczą się na mapie!
* **Synchronizacja Waypointów**: Każdy waypoint dodany na mapie w przeglądarce jest wysyłany do klienta gry, a stamtąd rozsyłany do wszystkich połączonych znajomych w pokoju. Wspólne cele i bazy są widoczne dla wszystkich od razu.
* **Integracja z Dynmap**: Mod wykrywa znane serwery (np. `sunlightmc.pl`) i automatycznie integruje oficjalną mapę Dynmap bezpośrednio w oknie przeglądarki, ułatwiając orientację w terenie.

---

## Ustawienia Kamuflażu (Camouflage Settings)

Wszystkie widoczne w grze opcje sterowania oraz właściwości pliku konfiguracyjnego zostały zamaskowane pod nazwami sugerującymi optymalizację pamięci. Poniżej znajduje się dwujęzyczne zestawienie i wyjaśnienie, co poszczególne opcje robią w rzeczywistości.

### 1. Klawisze w grze (Controls / Keybindings)

Te klawisze znajdziesz w standardowym menu sterowania Minecrafta:

| Nazwa w grze (English) | Nazwa w grze (Polish) | Rzeczywiste działanie (Polish Explanation) |
| :--- | :--- | :--- |
| **`Cache Settings`** | **`Ustawienia pamięci podręcznej`** | Otwiera wewnętrzną flagę aktywności (wysyła stan `tabPressed` jako `true` do API). Może służyć do wyzwalania widoku ustawień lub dodatkowych paneli na mapie. |
| **`Memory Allocation +`** | **`Alokacja pamięci +`** | Wysyła flagę `zoomInPressed` jako `true`. Pozwala na zdalne przybliżanie widoku mapy w przeglądarce za pomocą klawisza przypisanego w grze. |
| **`Memory Allocation -`** | **`Alokacja pamięci -`** | Wysyła flagę `zoomOutPressed` jako `true`. Pozwala na zdalne oddalanie widoku mapy w przeglądarce za pomocą klawisza przypisanego w grze. |
| **`Temporary Cache Release`** | **`Tymczasowe zwolnienie pamięci`**| Wysyła flagę `zoomHoldPressed` jako `true`. Może być używany do wycentrowania mapy na Twojej postaci lub ukrycia/pokazania elementów interfejsu. |

---

### 2. Plik konfiguracyjny (`config.properties`)

Plik znajduje się w folderze `.minecraft/config/optimc/config.properties`.

| Klucz konfiguracji | Domyślna wartość | Wyjaśnienie działania (Polish Explanation) |
| :--- | :--- | :--- |
| **`port`** | `9000` | Port, na którym uruchamia się lokalny serwer HTTP mapy. Zmień go, jeśli port 9000 jest zajęty przez inną aplikację na Twoim komputerze. |
| **`sharing_enabled`** | `true` | (`true` / `false`) Włącza lub całkowicie wyłącza moduł sieciowy. Gdy jest ustawiony na `false`, mod nie wysyła Twojej pozycji i nie łączy się z serwerem SSE (działa tylko lokalna mapa offline). |
| **`sharing_server`** | `https://optimc-server.onrender.com/` | Adres URL serwera pośredniczącego SSE. Mod używa go do wysyłania (POST) i odbierania (GET/SSE stream) współdzielonych pozycji graczy oraz kafelków mapy. |
| **`sharing_room`** | `""` (pusty) | Nazwa pokoju synchronizacji. Jeśli zostawisz to pole puste, mod automatycznie wygeneruje pokój na podstawie adresu IP/domeny serwera Minecraft. Jeśli wpiszesz tu dowolny ciąg znaków (np. `tajny_sojusz`), połączysz się tylko z graczami posiadającymi identyczny klucz pokoju. |

---

## Architektura techniczna (dla deweloperów)

```mermaid
graph TD
    MC[Klient Minecraft] -->|Zapis kafelków PNG| LocalFS[(Pliki lokalne /tiles)]
    MC -->|Uruchamia| HTTP[MapWebServer: Port 9000]
    HTTP -->|Serwuje index.html / app.js / tiles| Browser[Przeglądarka Web UI]
    
    MC -->|POST: własna pozycja, HP, dim| SSE_Srv[Serwer SSE: Render]
    SSE_Srv -->|GET /stream| MC
    
    Browser -->|Dodawanie waypointa: POST /api/waypoints| HTTP
    HTTP -->|Aktualizacja localWaypointsJson| MC
    MC -->|Wysyła w payloadzie| SSE_Srv
