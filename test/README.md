# Tester

Testerna kör hela verktyget lokalt i Node.js (version 18 eller senare). Ingen Netlify-anslutning och inga installerade paket behövs: lagringen byts ut mot en minneslagring och inga riktiga mejl skickas.

Starta testservern från projektmappen:

```
CREATE_PASSWORD=hemligt RESEND_API_KEY=test MAIL_FROM=test node test/devserver.mjs . 8888
```

Kör API-testerna i ett annat terminalfönster:

```
node test/apitest.mjs
```

Resultatet visar en rad per kontroll (OK eller FEL) och avslutas med "Alla tester gick igenom". Skriptet returnerar felkod 1 om något test misslyckas.

Variablerna `RESEND_API_KEY` och `MAIL_FROM` behövs för att testa e-postflödet. Med testservern fångas mejlen i stället för att skickas, och de syns på `http://localhost:8888/__mail`.

Webbsidorna kan provas på `http://localhost:8888/` medan testservern körs. Testservern sätter samma säkerhetsrubriker som `netlify.toml`.
