# Hitta tid

Eget verktyg för två saker:

1. **Hitta gemensam tid.** Du föreslår tider, deltagarna svarar Ja, Om det behövs eller Nej, och du ser vilken tid som passar flest.
2. **Boka tid.** Du lägger ut tider (med valfritt antal platser per tid) och deltagarna bokar själva, först till kvarn.

Byggt för Netlify: statiska sidor i `public/`, serverlogik i Netlify Functions och data i Netlify Blobs. Ingen Supabase och inget annat betalt.

## Mappar

| Sökväg | Innehåll |
|---|---|
| `public/index.html` | Startsidan där du skapar |
| `public/p/index.html` | Deltagarsidan (`/p/?id=...`) |
| `public/admin/index.html` | Administrationen (`/admin/#id=...&key=...`) |
| `public/style.css` | All stil. Färger och typsnitt överst i filen |
| `public/common.js` | Hjälpfunktioner. Etiketten "Om det behövs" ändras här (`MAYBE_LABEL`) |
| `netlify/functions/api.mjs` | API:t |
| `netlify/functions/cleanup.mjs` | Raderar utgångna omröstningar en gång per dygn |
| `netlify/lib/core.mjs` | Gemensam logik: lagring, kalenderfil, e-post |

## Publicera

1. Lägg mappens innehåll i ett nytt GitHub-repo.
2. Skapa en ny webbplats i Netlify från repot. Inga bygginställningar behövs, `netlify.toml` sköter det.
3. Lägg in miljövariabler under *Site configuration > Environment variables* (se nedan) och gör en ny deploy.

## Miljövariabler

| Variabel | Krävs | Vad den gör |
|---|---|---|
| `CREATE_PASSWORD` | Rekommenderas starkt | Lösenord som krävs för att skapa. Utan den kan vem som helst som hittar sidan skapa omröstningar |
| `RESEND_API_KEY` | Bara för e-post | API-nyckel från Resend |
| `MAIL_FROM` | Bara för e-post | Avsändare, t.ex. `Samarbetsbolaget <boka@samarbetsbolaget.se>` |
| `MAIL_REPLY_TO` | Valfri | Adress som svar på mejlen går till |
| `SITE_URL` | Valfri | Egen adress i länkar i mejl, om du kopplar en egen domän |

Utan `RESEND_API_KEY` och `MAIL_FROM` fungerar allt utom e-postbekräftelser. Kryssrutan för bekräftelse visas då som avstängd.

## E-post via Resend

Resends gratisplan räcker för 100 mejl per dygn och 3 000 per månad. För att få skicka från din egen domän:

1. Skapa konto på resend.com och lägg till domänen (t.ex. `samarbetsbolaget.se`).
2. Resend visar några DNS-poster. Eftersom domänens DNS ligger hos Netlify lägger du in dem under *Domains > samarbetsbolaget.se > DNS records*.
3. När Resend visar domänen som verifierad: skapa en API-nyckel och lägg in den som `RESEND_API_KEY`.

## Personuppgifter

- När du skapar kryssar du i vilka uppgifter deltagarna ska lämna: namn, e-post och/eller telefon.
- E-post och telefon visas aldrig för andra deltagare, bara för dig i administrationen.
- Allt raderas automatiskt 7, 30, 90 eller 365 dagar efter sista tiden (du väljer), eller direkt när du klickar Radera.
- Data ligger i Netlify Blobs. Netlify är ett amerikanskt bolag, vilket kan behöva nämnas i din integritetspolicy.

## Kontakta deltagarna utan e-posttjänst

I administrationen finns knappen **Mejla deltagarna**. Den öppnar ditt eget mejlprogram med alla adresser i hemlig kopia och en färdig text (med länk till kalenderfil när tiden är bestämd). Där finns också knappar för att kopiera alla e-postadresser eller telefonnummer.

## Kända begränsningar i första versionen

- Tider går inte att ändra efter att omröstningen skapats.
- Den som bokat eller svarat kan ändra eller avboka från samma webbläsare, eller via länken i bekräftelsemejlet. Utan e-post och i en annan webbläsare behöver du ta bort bokningen åt dem.
- Deltagare får inget mejl om du tar bort deras bokning.
