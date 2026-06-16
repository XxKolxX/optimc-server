# Instrukcja Wdrożenia - Serwer Coop Relay i Mapy w Chmurze 24/7 (BEZ KARTY PŁATNICZEJ)

Ten folder zawiera kompletny kod serwera pośredniczącego (relay) oraz strony mapy dla modyfikacji **OptiMC**. Możesz go uruchomić **całkowicie za darmo w chmurze (24/7) bez podawania żadnych danych karty płatniczej** na dwa sposoby, lub **lokalnie na swoim komputerze**.

---

## ☁️ Metoda 1: Render.com (Zalecana - Brak Karty, Bardzo Proste)

Render to popularna platforma, która umożliwia bezpłatne uruchomienie aplikacji Node.js bez podawania karty płatniczej. Jedynym minusem jest to, że darmowe aplikacje przechodzą w stan uśpienia po 15 minutach braku ruchu. Pierwsze wejście po przerwie wybudza serwer przez około 50 sekund, potem działa błyskawicznie.

### Krok 1: Przygotowanie Kodu na GitHubie
1. Zaloguj się na swoje darmowe konto na portalu **[GitHub](https://github.com/)** (założenie konta jest darmowe i nie wymaga karty).
2. Stwórz nowe repozytorium (np. o nazwie `optimc-server`).
3. Prześlij zawartość tego folderu (`coop-server/`) do swojego repozytorium na GitHubie (na samej górze powinny być pliki `server.js`, `package.json` oraz folder `web/`).

### Krok 2: Wdrożenie na Render.com
1. Zarejestruj się na stronie **[Render.com](https://render.com/)**, wybierając rejestrację przez konto GitHub (**"Sign up with GitHub"**). Karta nie jest wymagana!
2. W panelu głównym kliknij przycisk **"New"** (w prawym górnym rogu) i wybierz **"Web Service"**.
3. Połącz swoje konto GitHub i wybierz stworzone wcześniej repozytorium `optimc-server`.
4. Skonfiguruj ustawienia:
   - **Name**: `optimc-server` (lub dowolna inna nazwa)
   - **Runtime**: `Node`
   - **Build Command**: `npm install` (lub zostaw puste)
   - **Start Command**: `node server.js`
   - **Instance Type**: Wybierz **Free** (Darmowy)
5. Kliknij **"Deploy Web Service"** na dole strony.
6. Budowanie i uruchamianie potrwa około 2 minuty. Gdy status zmieni się na **Live**, u góry po lewej stronie zobaczysz darmowy adres URL, np.:
   `https://optimc-server-xxxx.onrender.com`

---

## ☁️ Metoda 2: Hugging Face Spaces (Działa 24/7 bez uśpienia - Brak Karty!)

Hugging Face pozwala na hostowanie kontenerów Docker całkowicie za darmo. Usługa działa 24/7 bez przechodzenia w stan uśpienia i **nie wymaga podawania karty kredytowej!**

### Krok 1: Założenie konta i Spaces
1. Załóż darmowe konto na stronie **[Hugging Face](https://huggingface.co/)** (bez podawania karty).
2. Kliknij na swój awatar w prawym górnym rogu i wybierz **"New Space"**.
3. Skonfiguruj Space:
   - **Space name**: `optimc-server` (lub dowolna nazwa)
   - **License**: zostaw puste
   - **Select the Space SDK**: Wybierz **Docker** (to bardzo ważne!)
   - **Docker template**: Wybierz **Blank**
   - **Space hardware**: Wybierz **Cpu basic (Free)**
   - **Space visibility**: Ustaw na **Public** (aby mod mógł wysyłać pakiety)
4. Kliknij przycisk **"Create Space"** na dole.

### Krok 2: Wrzucenie plików bezpośrednio przez przeglądarkę
1. Po utworzeniu Space, wejdź w zakładkę **"Files"** (obok zakładki "App").
2. Kliknij przycisk **"Add file"** -> **"Upload files"**.
3. Przeciągnij i upuść pliki `server.js` oraz `package.json` z tego folderu i kliknij **"Commit changes..."** na dole.
4. Następnie wgraj folder `web` (Hugging Face pozwala na wgrywanie całych folderów przez przeciągnięcie ich do okna przeglądarki) i zatwierdź zmiany.
5. Serwer automatycznie rozpozna plik `package.json`, zbuduje aplikację Docker i ją uruchomi. Status zmieni się na **Running**.
6. Adres URL Twojego serwera będzie wyglądał następująco:
   `https://<twój-username>-<nazwa-space>.hf.space`
   *(Możesz sprawdzić dokładny adres klikając w menu z trzema kropkami w prawym górnym rogu na Hugging Face i wybierając "Embed this Space" -> skopiuj link z pola "Direct URL").*

---

## 💻 Metoda 3: Uruchomienie lokalne na własnym komputerze

Jeśli wolisz odpalić serwer lokalnie bez korzystania z chmury, upewnij się, że masz zainstalowany program **Node.js**:

1. Otwórz konsolę w tym folderze (`coop-server/`).
2. Uruchom serwer komendą:
   ```bash
   node server.js
   ```
3. Serwer uruchomi się na porcie `3000` (dostępny pod adresem `http://localhost:3000`).
4. Aby Twój znajomy mógł się połączyć bez grzebania w routerze, udostępnij ten port za pomocą darmowej komendy tunelującej w osobnym oknie konsoli:
   - **Opcja A (przez SSH, wbudowane w Windows)**:
     ```bash
     ssh -R 80:localhost:3000 play@localhost.run
     ```
     (po zatwierdzeniu otrzymasz w konsoli adres publiczny HTTP, np. `https://xxx.localhost.run`).
   - **Opcja B (przez Localtunnel)**:
     ```bash
     npx localtunnel --port 3000
     ```
     (otrzymasz adres publiczny typu `https://xxx.loca.lt`).

---

## 🎮 Konfiguracja w Modzie OptiMC

Gdy już posiadasz swój adres URL w chmurze (np. z Render lub Hugging Face) lub z tunelu:

1. Wejdź na mapę w grze (pod adresem `http://localhost:9000`).
2. Przejdź do zakładki **Ustawienia**.
3. W polu **Serwer udostępniania** wklej swój adres URL (np. `https://optimc-server-xxxx.onrender.com/` lub `https://username-space.hf.space/` - upewnij się, że kończy się ukośnikiem `/`).
4. **Zapisz** ustawienia.
5. Mod automatycznie przyspieszy wysyłanie pozycji do **500ms** (ponieważ nie korzystacie już z ograniczonego publicznego serwera ntfy).
6. Wyślij ten sam adres URL swojemu koledze, aby wpisał go u siebie w modzie.
7. **Podgląd w chmurze**: Możecie teraz obaj otworzyć bezpośrednio adres serwera w przeglądarce, dopisując na końcu parametry, np.:
   `https://twoja-domena.onrender.com/?topic=omc_skrot_sha256`
   aby widzieć mapę świata i pozycję bez włączania lokalnego serwera portu `9000`!
   *(Kod kanału `omc_skrot_sha256` możecie skopiować klikając przycisk "Kopiuj Link do Udostępnienia" w zakładce Ustawienia).*
