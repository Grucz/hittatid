// Kör mot test/devserver.mjs. Se test/README.md.
const B = process.env.TEST_URL || "http://localhost:8888";
let fails = 0;
function check(cond, msg) { console.log((cond ? "OK   " : "FEL  ") + msg); if (!cond) fails++; }
async function call(path, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(B + "/api/" + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  let data; try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}
const future = (days) => { const d = new Date(Date.now() + days * 86400000); return d.toISOString().slice(0, 10); };

// --- skapa utan lösenord
let r = await call("polls", { method: "POST", body: { mode: "poll", title: "x", options: [{ date: future(3) }] } });
check(r.status === 403, "skapa utan lösenord nekas");
const PW = { "x-create-password": "hemligt" };

// --- omröstning
r = await call("polls", { method: "POST", headers: PW, body: {
  mode: "poll", title: "Ledningsgrupp", fields: { name: true, email: true }, emailConfirm: true, allowMaybe: true, showOthers: true,
  options: [{ date: future(5), start: "09:00", end: "10:00" }, { date: future(4), start: "13:00", end: "14:00" }, { date: future(6) }],
} });
check(r.status === 200 && r.data.id && r.data.adminKey, "skapa omröstning");
const P = r.data;
r = await call(`polls/${P.id}`);
check(r.data.options[0].date === future(4), "tider sorteras");
check(!("adminHash" in r.data), "adminhash läcker inte");
const [o1, o2, o3] = r.data.options;

r = await call(`polls/${P.id}/responses`, { method: "POST", body: { name: "Anna", email: "Anna@exempel.se", answers: { [o1.id]: "y", [o2.id]: "m" } } });
check(r.status === 200 && r.data.token, "svar 1");
const A = r.data;
r = await call(`polls/${P.id}/responses`, { method: "POST", body: { name: "Anna 2", email: "anna@exempel.se", answers: {} } });
check(r.status === 400, "samma e-post nekas: " + r.data.error);
r = await call(`polls/${P.id}/responses`, { method: "POST", body: { name: "", email: "b@exempel.se", answers: {} } });
check(r.status === 400, "namn saknas nekas");
r = await call(`polls/${P.id}/responses`, { method: "POST", body: { name: "Bo", email: "bo@exempel.se", answers: { [o1.id]: "y", [o3.id]: "y", [o2.id]: "zz" } } });
check(r.status === 200, "svar 2");
r = await call(`polls/${P.id}/responses/${A.id}?token=fel`);
check(r.status === 404, "fel token nekas");
r = await call(`polls/${P.id}/responses/${A.id}`, { method: "PUT", headers: { "x-edit-token": A.token }, body: { answers: { [o1.id]: "n", [o3.id]: "y" } } });
check(r.status === 200, "ändra svar");
r = await call(`polls/${P.id}`);
check(r.data.tally[o1.id].yes === 1 && r.data.tally[o3.id].yes === 2 && r.data.tally[o2.id].no === 2, "sammanställning stämmer");
check(r.data.responses.length === 2 && !("email" in r.data.responses[0]), "publik vy utan e-post");

r = await call(`polls/${P.id}/admin`, { headers: { "x-admin-key": "fel" } });
check(r.status === 403, "fel adminnyckel nekas");
r = await call(`polls/${P.id}/admin`, { headers: { "x-admin-key": P.adminKey } });
check(r.status === 200 && r.data.responses[0].email === "anna@exempel.se" && !("tokenHash" in r.data.responses[0]), "adminvy med e-post");

r = await call(`polls/${P.id}/admin`, { method: "POST", headers: { "x-admin-key": P.adminKey }, body: { action: "finalize", optionId: o3.id, notify: true } });
check(r.status === 200 && r.data.notified === 2, "bestäm tid och mejla 2");
r = await call(`polls/${P.id}/responses`, { method: "POST", body: { name: "Sen", email: "sen@exempel.se", answers: {} } });
check(r.status === 400, "stängd efter bestämd tid");
const ics = await fetch(`${B}/api/polls/${P.id}/ics/${o1.id}`).then((x) => x.text());
check(ics.includes("BEGIN:VEVENT") && /DTSTART:\d{8}T\d{6}Z/.test(ics), "ics med UTC-tid: " + (ics.match(/DTSTART:.*/) || [])[0]);
const icsDay = await fetch(`${B}/api/polls/${P.id}/ics/${o3.id}`).then((x) => x.text());
check(icsDay.includes("DTSTART;VALUE=DATE:"), "ics heldag");

// --- slottar, 1 plats, max 1 per person
r = await call("polls", { method: "POST", headers: PW, body: {
  mode: "slots", title: "Samtal", fields: { name: true }, capacity: 1, maxPerPerson: 1, emailConfirm: true,
  options: [{ date: future(2), start: "09:00", end: "09:30" }, { date: future(2), start: "09:30", end: "10:00" }, { date: future(2), start: "10:00", end: "10:30" }],
} });
const S = r.data;
r = await call(`polls/${S.id}`);
check(r.data.settings.emailConfirm === false && r.data.settings.fields.name === true, "e-postbekräftelse av när bara namn samlas in");
const [s1, s2, s3] = r.data.options;

// kapplöpning: 25 olika personer försöker ta samma tid samtidigt
const race = await Promise.all(Array.from({ length: 25 }, (_, i) => call(`polls/${S.id}/bookings`, { method: "POST", body: { slotId: s1.id, name: "Person " + i } })));
const wins = race.filter((x) => x.status === 200);
check(wins.length === 1, `kapplöpning: ${wins.length} vann, ${race.filter((x) => x.status === 409).length} fick fullbokad`);
const winnerName = "Person " + race.indexOf(wins[0]);
r = await call(`polls/${S.id}/bookings`, { method: "POST", body: { slotId: s2.id, name: winnerName.toUpperCase() } });
check(r.status === 400, "max en per person (skiftläge spelar ingen roll): " + r.data.error);
// förloraren ska kunna boka annan tid (spärren släppt)
r = await call(`polls/${S.id}/bookings`, { method: "POST", body: { slotId: s2.id, name: "Person " + race.findIndex((x) => x.status === 409) } });
check(r.status === 200, "förlorare kan boka annan tid");
const loserBooking = r.data;
r = await call(`polls/${S.id}`);
check(r.data.counts[s1.id] === 1 && r.data.counts[s2.id] === 1 && !r.data.counts[s3.id], "räkning per tid");
check(!r.data.names, "namn döljs när showOthers av");
// avboka och boka om
r = await call(`polls/${S.id}/bookings/${loserBooking.id}?token=${loserBooking.token}`, { method: "DELETE" });
check(r.status === 200, "avboka");
r = await call(`polls/${S.id}/bookings`, { method: "POST", body: { slotId: s2.id, name: "Ny person" } });
check(r.status === 200, "tiden ledig igen efter avbokning");
r = await call(`polls/${S.id}/bookings`, { method: "POST", body: { slotId: s3.id, name: "Person " + race.findIndex((x) => x.status === 409) } });
check(r.status === 200, "avbokad person kan boka igen");
r = await call(`polls/${S.id}/admin`, { headers: { "x-admin-key": S.adminKey } });
check(r.data.bookings.length === 3 && !("seatKey" in r.data.bookings[0]), "adminvy bokningar");
const delB = r.data.bookings[0];
r = await call(`polls/${S.id}/admin`, { method: "POST", headers: { "x-admin-key": S.adminKey }, body: { action: "deleteBooking", bookingId: delB.id } });
check(r.status === 200, "admin tar bort bokning");
r = await call(`polls/${S.id}`);
check(!r.data.counts[delB.slotId], "plats frigjord efter admin-borttagning");

// --- slottar, 3 platser, obegränsat, e-post, visa namn
r = await call("polls", { method: "POST", headers: PW, body: {
  mode: "slots", title: "Workshop", fields: { name: true, email: true }, capacity: 3, maxPerPerson: 0, emailConfirm: true, showOthers: true,
  options: [{ date: future(8), start: "13:00", end: "15:00" }, { date: future(9), start: "13:00", end: "15:00" }],
} });
const W = r.data;
r = await call(`polls/${W.id}`);
const [w1, w2] = r.data.options;
const race2 = await Promise.all(Array.from({ length: 10 }, (_, i) => call(`polls/${W.id}/bookings`, { method: "POST", body: { slotId: w1.id, name: "P" + i, email: `p${i}@x.se` } })));
check(race2.filter((x) => x.status === 200).length === 3, "3 platser: exakt 3 lyckas av 10");
const p0 = race2.findIndex((x) => x.status === 200);
r = await call(`polls/${W.id}/bookings`, { method: "POST", body: { slotId: w1.id, name: "P" + p0, email: `p${p0}@x.se` } });
check(r.status === 400, "samma person samma tid två gånger nekas");
r = await call(`polls/${W.id}/bookings`, { method: "POST", body: { slotId: w2.id, name: "P" + p0, email: `p${p0}@x.se` } });
check(r.status === 200, "obegränsat: samma person kan boka annan tid");
r = await call(`polls/${W.id}`);
check(r.data.names[w1.id].length === 3, "namn visas när showOthers på");
r = await call(`polls/${W.id}/bookings`, { method: "POST", body: { slotId: w1.id, name: "Z", email: "inte-epost" } });
check(r.status === 400, "ogiltig e-post nekas");

// --- validering
r = await call("polls", { method: "POST", headers: PW, body: { mode: "slots", title: "x", options: [{ date: future(1) }] } });
check(r.status === 400, "slottar utan starttid nekas");
r = await call("polls", { method: "POST", headers: PW, body: { mode: "poll", title: "x", options: [{ date: future(1), start: "10:00", end: "09:00" }] } });
check(r.status === 400, "sluttid före start nekas");
r = await call("polls", { method: "POST", headers: PW, body: { mode: "poll", title: "Gammal", options: [{ date: "2020-01-01" }], retentionDays: 7 } });
const old = r.data;
r = await call(`polls/${old.id}/responses`, { method: "POST", body: { name: "x" } });
check(r.status === 200, "svar på gammal (ingen svarsdag satt)");

// --- städning
await fetch(B + "/__cleanup");
r = await call(`polls/${old.id}`);
check(r.status === 404, "städning raderar utgången omröstning");
const keys = await fetch(B + "/__store").then((x) => x.json());
check(!keys.some((k) => k.includes(old.id)), "inga rester kvar efter städning");
r = await call(`polls/${P.id}`);
check(r.status === 200, "aktiv omröstning finns kvar");

// --- radera via admin
r = await call(`polls/${S.id}/admin`, { method: "DELETE", headers: { "x-admin-key": S.adminKey } });
const keys2 = await fetch(B + "/__store").then((x) => x.json());
check(r.status === 200 && !keys2.some((k) => k.includes(S.id)), "admin raderar allt");

const mail = await fetch(B + "/__mail").then((x) => x.json());
console.log("\nMejl:", mail.map((m) => `${m.to} | ${m.subject}${m.attachments ? " | bilaga" : ""}`).join("\n      "));


// --- telefon
let t = await call("polls", { method: "POST", headers: PW, body: { mode: "slots", title: "Tel", fields: { phone: true }, capacity: 2, maxPerPerson: 1,
  options: [{ date: future(3), start: "10:00" }, { date: future(3), start: "11:00" }] } });
const T = t.data;
t = await call(`polls/${T.id}`);
const [t1, t2] = t.data.options;
t = await call(`polls/${T.id}/bookings`, { method: "POST", body: { slotId: t1.id, phone: "abc" } });
check(t.status === 400, "ogiltigt telefonnummer nekas");
t = await call(`polls/${T.id}/bookings`, { method: "POST", body: { slotId: t1.id, phone: "070-123 45 67", name: "ska ignoreras" } });
check(t.status === 200, "bokning med telefon");
t = await call(`polls/${T.id}/bookings`, { method: "POST", body: { slotId: t2.id, phone: "0701234567" } });
check(t.status === 400, "samma nummer i annat format räknas som samma person");
t = await call(`polls/${T.id}/admin`, { headers: { "x-admin-key": T.adminKey } });
check(t.data.bookings[0].phone === "070-123 45 67" && t.data.bookings[0].name === "", "admin ser telefon, namn sparas inte");
t = await call(`polls/${T.id}`);
check(!JSON.stringify(t.data).includes("123 45"), "telefon syns inte publikt");
t = await call("polls", { method: "POST", headers: PW, body: { mode: "poll", title: "Inga fält", fields: {}, options: [{ date: future(3) }] } });
check(t.status === 400, "minst ett fält krävs");
t = await call("polls", { method: "POST", headers: PW, body: { mode: "poll", title: "Alla", fields: { name: true, email: true, phone: true }, options: [{ date: future(3) }] } });
const AL = t.data;
t = await call(`polls/${AL.id}/responses`, { method: "POST", body: { name: "Kim", email: "kim@x.se", answers: {} } });
check(t.status === 400, "telefon saknas när alla tre krävs");
t = await call(`polls/${AL.id}/responses`, { method: "POST", body: { name: "Kim", email: "kim@x.se", phone: "+46 70 111 22 33", answers: {} } });
check(t.status === 200, "svar med alla tre");
console.log(fails ? `\n${fails} FEL` : "\nAlla tester gick igenom");
process.exit(fails ? 1 : 0);
