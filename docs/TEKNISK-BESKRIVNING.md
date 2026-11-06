# Hitta tid: teknisk beskrivning för granskning

Version 0.4, november 2026. Dokumentet beskriver arkitektur, datahantering, säkerhet och kända begränsningar, som underlag för IT-granskning och för beslut om driftmiljö.

## 1. Vad verktyget gör

Hitta tid är ett internt verktyg för att boka möten, i två lägen:

| Läge | Funktion |
|---|---|
| Hitta gemensam tid | Arrangören föreslår tider. Deltagarna svarar Ja, Om det behövs eller Nej. Arrangören väljer sedan en tid. |
| Boka tid | Arrangören lägger ut tider med ett antal platser per tid. Deltagarna bokar själva, först till kvarn. |

Deltagare behöver inget konto. Arrangören väljer per omröstning om deltagarna ska lämna namn, e-post och/eller telefon.

## 2. Arkitektur

| Del | Teknik | Filer |
|---|---|---|
| Webbsidor | Statisk HTML, CSS och vanlig JavaScript (inga ramverk, inget byggsteg) | `public/` |
| Server (API) | En Netlify Function (Node.js, ES-moduler) som svarar på `/api/*` | `netlify/functions/api.mjs` |
| Gemensam logik | Validering, lagring, kalenderfil, e-post | `netlify/lib/core.mjs` |
| Städning | Schemalagd Netlify Function som körs en gång per dygn | `netlify/functions/cleanup.mjs` |
| Lagring | Netlify Blobs (nyckel/värde-lagring), stark konsistens | |
| Driftkonfiguration | Publiceringsmapp, funktioner, säkerhetsrubriker | `netlify.toml` |

**Beroenden:** ett enda npm-paket, `@netlify/blobs`. Sidorna laddar inga externa skript, typsnitt, bilder eller analysverktyg och sätter inga cookies.

### API

| Metod och adress | Behörighet | Funktion |
|---|---|---|
| `GET /api/config` | Öppen | Talar om ifall lösenord krävs och om e-post är inställt |
| `POST /api/polls` | Lösenord (`x-create-password`) | Skapar en omröstning, returnerar id och administratörsnyckel |
| `GET /api/polls/{id}` | Länken | Offentlig vy, utan e-post och telefon |
| `GET /api/polls/{id}/ics/{tid}` | Länken | Kalenderfil (.ics) |
| `POST /api/polls/{id}/responses` | Länken | Lämnar svar |
| `GET` och `PUT /api/polls/{id}/responses/{svar}` | Personlig nyckel | Läser eller ändrar eget svar |
| `POST /api/polls/{id}/bookings` | Länken | Bokar en plats |
| `GET` och `DELETE /api/polls/{id}/bookings/{bokning}` | Personlig nyckel | Läser eller avbokar egen bokning |
| `GET`, `POST` och `DELETE /api/polls/{id}/admin` | Administratörsnyckel (`x-admin-key`) | Full vy, stänga, välja tid, ta bort svar, radera allt |

### Lagringsnycklar

| Nyckel | Innehåll |
|---|---|
| `poll/{id}` | Inställningar, tider, hash av administratörsnyckel, raderingsdatum |
| `resp/{id}/{svar}` | Ett svar: uppgifter, svar per tid, hash av personlig nyckel |
| `booking/{id}/{bokning}` | En bokning: uppgifter, vald tid, hash av personlig nyckel |
| `seat/{id}/{tid}/{n}` | Markering för upptagen plats nummer n |
| `who/{id}/{personnyckel}/...` | Spärrar mot dubbelsvar och för max antal bokningar per person |

Dubbelbokning förhindras med villkorliga skrivningar (`onlyIfNew`), så att två samtidiga bokningar av sista platsen inte båda lyckas. Det är testat med 25 samtidiga försök.

## 3. Personuppgifter

| Fråga | Svar |
|---|---|
| Vilka uppgifter? | Namn, e-post och telefon, beroende på arrangörens val. Inga andra uppgifter samlas in. |
| Vem ser dem? | Arrangören ser allt i administrationen. Andra deltagare kan se namn, om arrangören har valt det. E-post och telefon skickas aldrig till andra deltagare, vilket de automatiska testerna kontrollerar. |
| Var lagras de? | I Netlify Blobs. Netlify är ett amerikanskt bolag. **Vilken region data lagras i har jag inte kunnat bekräfta.** Det behöver kontrolleras med Netlify och vägas in i bedömningen av tredjelandsöverföring. |
| Hur länge? | Arrangören väljer 7, 30, 90 eller 365 dagar efter sista tiden. Därefter raderar städfunktionen allt som hör till omröstningen. Arrangören kan också radera allt direkt. |
| Loggar | Netlifys funktionsloggar registrerar anrop och fel. Koden skriver inte ut personuppgifter i loggen. |
| E-post | Avstängd i nuvarande drift. Om tjänsten Resend aktiveras (miljövariabler) blir Resend ytterligare ett personuppgiftsbiträde. Annars skickar arrangören mejl från sitt eget mejlprogram. |
| Lagring i webbläsaren | `localStorage` sparar arrangörens lösenord för att skapa och administratörslänkar, deltagarens nycklar för att ändra eget svar och senast angivna namn, e-post och telefon. Allt finns bara i den egna webbläsaren. Se avsnitt 6. |

## 4. Säkerhet

| Område | Lösning |
|---|---|
| Skapa omröstningar | Kräver ett gemensamt lösenord (`CREATE_PASSWORD`). Jämförs i konstant tid. |
| Administration | Varje omröstning får en slumpad nyckel på 24 tecken (ungefär 140 bitar). Servern sparar bara SHA-256-hashen. Nyckeln står i adressens #-del, som webbläsare inte skickar till servern eller i Referer. |
| Ändra eller avboka | En personlig slumpad nyckel per svar eller bokning, lagrad som hash. |
| Gissa länkar | Omröstnings-id är 10 slumpade tecken (ungefär 58 bitar). |
| Inskjuten kod (XSS) | All text från användare escapas innan den visas. |
| CSV-injektion | Celler som Excel kan tolka som formler får en apostrof först vid export. |
| Säkerhetsrubriker | Content-Security-Policy (bara egna källor, inga ramar, inga externa anrop), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, Permissions-Policy. |
| Indata | Längdbegränsning på alla fält, format för datum, tid, e-post och telefon, högst 100 tider per omröstning (400 i bokningsläget). |
| Sökmotorer | Alla sidor har `noindex`. |

## 5. Kända begränsningar och risker

| Punkt | Bedömning | Möjlig åtgärd |
|---|---|---|
| Ingen begränsning av antal anrop | Den som har en länk kan skicka många svar eller bokningar i följd. | Begränsning per IP-adress i driftmiljön, eller i koden. |
| Ett gemensamt lösenord för att skapa | Inga individuella konton, ingen spårbarhet för vem som skapade vad. | Inloggning via organisationens identitetslösning (t.ex. Entra ID) i den egna miljön. |
| Lösenordet sparas i webbläsaren | Det ligger i klartext i `localStorage` på arrangörens dator. | Kan tas bort så att lösenordet anges varje gång. |
| Administratörslänken är nyckeln | Den som får tag på länken kan se och radera allt. Länken kan inte bytas ut. | Hanteras som ett lösenord. |
| Content-Security-Policy tillåter inbäddade skript | Skripten ligger direkt i HTML-filerna (`'unsafe-inline'`). | Flytta skripten till egna filer och skärp policyn. |
| Ingen ändring av tider i efterhand | Funktionell begränsning. | |

## 6. Drift utanför Netlify

Koden är skriven för Netlify. Två delar är knutna dit: serverfunktionernas körmiljö och lagringen (Netlify Blobs). Allt annat är vanlig Node.js och statiska filer.

För att köra i en egen miljö behövs:

| Del | Ändring | Omfattning |
|---|---|---|
| Lagring | Byt `getDataStore()` i `netlify/lib/core.mjs` mot en annan lagring med samma fyra operationer: läsa, skriva (med villkoret "bara om ny"), radera och lista efter prefix. Till exempel en databas (PostgreSQL, SQL Server) eller filsystem. | Liten. Allt annat använder bara dessa fyra operationer. |
| Server | Funktionen använder webbstandardens `Request` och `Response`, och kan köras i en vanlig Node-server (Node 18 eller senare) eller som Azure Function. | Liten |
| Statiska filer | Mappen `public/` serveras som den är. Adresserna `/p/` och `/admin/` ska visa respektive `index.html`. | Ingen |
| Säkerhetsrubriker | Sätts i webbservern i stället för i `netlify.toml`. | Liten |
| Städning | Anropa städfunktionen en gång per dygn (cron eller schemalagd uppgift). | Liten |
| Miljövariabler | `CREATE_PASSWORD`, och vid e-post `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REPLY_TO`, `SITE_URL`. | Ingen |

Testservern i `test/devserver.mjs` visar hur det kan se ut. Den kör hela verktyget i en vanlig Node-server med lagringen utbytt mot en enkel minneslagring.

## 7. Tester

Se `test/README.md`. API-testerna täcker 50 fall, bland annat behörighet, validering, att e-post och telefon inte läcker i offentliga svar, samtidiga bokningar, avbokning, automatisk radering och kalenderfiler. Omvandlingen från svensk tid till UTC i kalenderfilerna har dessutom kontrollerats separat kring bytena till och från sommartid.

## 8. Versionshistorik

| Version | Datum | Ändring |
|---|---|---|
| 0.1 | 2026-10-17 | Första version |
| 0.2 | 2026-10-17 | Fritt val av tider, lösenordskontroll |
| 0.3 | 2026-10-18 | Telefon som valbar uppgift, knappen Mejla deltagarna |
| 0.3.1 | 2026-10-29 | Rättning: lagringens åtkomstnyckel hämtas per anrop (fel "Token expired") |
| 0.4 | 2026-11-06 | Skydd mot CSV-injektion, Content-Security-Policy och Permissions-Policy, tester i paketet |
