// Hitta tid: API (Netlify Function, svarar på /api/*)
import {
  getDataStore, env, randomId, hash, safeEqual, json, fail,
  validateNewPoll, validateIdentity, personKey, isClosed,
  loadPoll, loadResponses, loadBookings, seatCounts, tally, deletePollData,
  buildIcs, emailAvailable, sendMail, escapeHtml, mailLayout, icsAttachment, formatOption, localToUtc,
} from "../lib/core.mjs";

export default async (req) => {
  try {
    return await route(req);
  } catch (err) {
    console.error(err);
    return fail("Något gick fel på servern. Försök igen om en stund.", 500);
  }
};

export const config = { path: "/api/*" };

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function siteUrl(req) {
  return (env("SITE_URL") || env("URL") || new URL(req.url).origin).replace(/\/$/, "");
}

async function route(req) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const store = await getDataStore();

  // GET /api/config
  if (parts[0] === "config" && method === "GET") {
    return json({ emailAvailable: emailAvailable(), passwordRequired: Boolean(env("CREATE_PASSWORD")) });
  }

  if (parts[0] !== "polls") return fail("Okänd adress.", 404);

  // POST /api/polls
  if (parts.length === 1 && method === "POST") return createPoll(req, store);

  const id = parts[1];
  const poll = await loadPoll(store, id);
  if (!poll) return fail("Hittade ingen omröstning med den länken. Den kan ha raderats.", 404);
  poll.id = id;

  const sub = parts[2];

  if (!sub && method === "GET") return publicView(store, poll);

  if (sub === "ics" && method === "GET") {
    const opt = poll.options.find((o) => o.id === parts[3]);
    if (!opt) return fail("Tiden finns inte.", 404);
    return new Response(buildIcs(poll, opt), {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="${slug(poll.title)}.ics"`,
        "cache-control": "no-store",
      },
    });
  }

  if (sub === "responses") {
    if (poll.mode !== "poll") return fail("Fel typ av omröstning.");
    if (parts.length === 3 && method === "POST") return createResponse(req, store, poll);
    const respId = parts[3];
    if (respId && method === "GET") return getOwnResponse(url, store, poll, respId);
    if (respId && method === "PUT") return updateResponse(req, url, store, poll, respId);
  }

  if (sub === "bookings") {
    if (poll.mode !== "slots") return fail("Fel typ av omröstning.");
    if (parts.length === 3 && method === "POST") return createBooking(req, store, poll);
    const bookingId = parts[3];
    if (bookingId && method === "GET") return getOwnBooking(url, store, poll, bookingId);
    if (bookingId && method === "DELETE") return cancelBooking(url, store, poll, bookingId);
  }

  if (sub === "admin") {
    const key = req.headers.get("x-admin-key") || "";
    if (!key || !safeEqual(hash(key), poll.adminHash)) return fail("Fel administratörslänk.", 403);
    if (method === "GET") return adminView(store, poll);
    if (method === "POST") return adminAction(req, store, poll);
    if (method === "DELETE") {
      await deletePollData(store, id);
      return json({ ok: true });
    }
  }

  return fail("Okänd adress.", 404);
}

function slug(s) {
  return (s || "kalender").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "kalender";
}

// ---------- skapa ----------

async function createPoll(req, store) {
  const required = env("CREATE_PASSWORD");
  if (required && !safeEqual(req.headers.get("x-create-password") || "", required)) {
    return fail("Fel lösenord för att skapa.", 403);
  }
  const body = await readBody(req);
  const { poll, error } = validateNewPoll(body);
  if (error) return fail(error);
  if (poll.settings.emailConfirm && !emailAvailable()) poll.settings.emailConfirm = false;

  const adminKey = randomId(24);
  poll.adminHash = hash(adminKey);

  let id;
  for (let i = 0; i < 5; i++) {
    id = randomId(10);
    const { modified } = await store.setJSON(`poll/${id}`, poll, { onlyIfNew: true });
    if (modified) return json({ id, adminKey });
  }
  return fail("Kunde inte skapa omröstningen. Försök igen.", 500);
}

// ---------- publik vy ----------

function publicPoll(poll) {
  const { adminHash, ...rest } = poll;
  return { ...rest, closed: isClosed(poll), emailAvailable: emailAvailable() };
}

function displayName(r, index, collect) {
  if (collect === "email") return `Deltagare ${index + 1}`;
  return r.name || `Deltagare ${index + 1}`;
}

async function publicView(store, poll) {
  const out = publicPoll(poll);
  if (poll.mode === "poll") {
    const responses = await loadResponses(store, poll.id);
    out.tally = tally(poll, responses);
    out.responseCount = responses.length;
    if (poll.settings.showOthers) {
      out.responses = responses.map((r, i) => ({ id: r.id, name: displayName(r, i, poll.settings.collect), answers: r.answers }));
    }
  } else {
    out.counts = await seatCounts(store, poll.id);
    if (poll.settings.showOthers && poll.settings.collect !== "email") {
      const bookings = await loadBookings(store, poll.id);
      out.names = {};
      for (const b of bookings) (out.names[b.slotId] ||= []).push(b.name);
    }
  }
  return json(out);
}

// ---------- svar: hitta gemensam tid ----------

function cleanAnswers(poll, raw) {
  const answers = {};
  for (const o of poll.options) {
    let a = raw && typeof raw === "object" ? raw[o.id] : "n";
    if (a === "m" && !poll.settings.allowMaybe) a = "n";
    answers[o.id] = ["y", "m", "n"].includes(a) ? a : "n";
  }
  return answers;
}

function answersText(poll, answers) {
  const label = { y: "Ja", m: "Om det behövs", n: "Nej" };
  return poll.options.map((o) => `${formatOption(o)}: ${label[answers[o.id]]}`);
}

async function mailResponseConfirmation(req, poll, resp, token, isUpdate) {
  if (!poll.settings.emailConfirm || !resp.email) return;
  const link = `${siteUrl(req)}/p/?id=${poll.id}&svar=${resp.id}&nyckel=${token}`;
  const rows = answersText(poll, resp.answers);
  const html = mailLayout(poll.title, `
<p style="margin:0 0 12px">${isUpdate ? "Ditt ändrade svar är sparat." : "Tack, ditt svar är sparat."} Så här svarade du:</p>
<ul style="padding-left:18px;margin:0 0 16px">${rows.map((r) => `<li style="margin-bottom:4px">${escapeHtml(r)}</li>`).join("")}</ul>
<p style="margin:0 0 16px"><a href="${link}" style="color:#8a1e2c">Ändra ditt svar</a></p>
<p style="margin:0;color:#6b625d;font-size:13px">Du får det här mejlet eftersom du svarade på en omröstning${poll.organizer ? " från " + escapeHtml(poll.organizer) : ""}.</p>`);
  await sendMail({
    to: resp.email,
    subject: `${isUpdate ? "Ändrat svar" : "Ditt svar"}: ${poll.title}`,
    html,
    text: `${isUpdate ? "Ditt ändrade svar är sparat." : "Tack, ditt svar är sparat."}\n\n${rows.join("\n")}\n\nÄndra ditt svar: ${link}`,
  });
}

async function createResponse(req, store, poll) {
  if (isClosed(poll)) return fail("Omröstningen är stängd.");
  const body = await readBody(req);
  const identity = validateIdentity(poll, body);
  if (identity.error) return fail(identity.error);

  if (identity.email) {
    const { modified } = await store.setJSON(`who/${poll.id}/${personKey(identity)}/svar`, { at: new Date().toISOString() }, { onlyIfNew: true });
    if (!modified) return fail("Den här e-postadressen har redan svarat. Använd länken i bekräftelsen för att ändra svaret, eller hör av dig till arrangören.");
  }

  const token = randomId(24);
  const resp = {
    id: randomId(10),
    name: identity.name,
    email: identity.email,
    answers: cleanAnswers(poll, body.answers),
    tokenHash: hash(token),
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
  await store.setJSON(`resp/${poll.id}/${resp.id}`, resp);
  await mailResponseConfirmation(req, poll, resp, token, false);
  return json({ id: resp.id, token });
}

async function getOwnResponse(url, store, poll, respId) {
  const resp = await store.get(`resp/${poll.id}/${respId}`, { type: "json" });
  const token = url.searchParams.get("token") || "";
  if (!resp || !token || !safeEqual(hash(token), resp.tokenHash)) return fail("Svaret hittades inte.", 404);
  return json({ id: resp.id, name: resp.name, email: resp.email, answers: resp.answers });
}

async function updateResponse(req, url, store, poll, respId) {
  if (isClosed(poll)) return fail("Omröstningen är stängd och svar kan inte längre ändras.");
  const key = `resp/${poll.id}/${respId}`;
  const resp = await store.get(key, { type: "json" });
  const token = req.headers.get("x-edit-token") || url.searchParams.get("token") || "";
  if (!resp || !token || !safeEqual(hash(token), resp.tokenHash)) return fail("Svaret hittades inte.", 404);
  const body = await readBody(req);
  resp.answers = cleanAnswers(poll, body.answers);
  if (poll.settings.collect !== "email" && typeof body.name === "string" && body.name.trim()) resp.name = body.name.trim().slice(0, 100);
  resp.updatedAt = new Date().toISOString();
  await store.setJSON(key, resp);
  await mailResponseConfirmation(req, poll, resp, token, true);
  return json({ ok: true });
}

// ---------- bokningar: boka tid ----------

async function releaseClaims(store, keys) {
  await Promise.all(keys.map((k) => store.delete(k)));
}

async function createBooking(req, store, poll) {
  if (isClosed(poll)) return fail("Bokningen är stängd.");
  const body = await readBody(req);
  const slot = poll.options.find((o) => o.id === body.slotId);
  if (!slot) return fail("Tiden finns inte.");
  if (localToUtc(slot.date, slot.start).getTime() < Date.now()) return fail("Den tiden har redan passerat.");

  const identity = validateIdentity(poll, body);
  if (identity.error) return fail(identity.error);
  const pk = personKey(identity);
  const claimed = [];
  const now = new Date().toISOString();

  // Samma person kan inte boka samma tid två gånger
  const dupKey = `who/${poll.id}/${pk}/tid-${slot.id}`;
  const dup = await store.setJSON(dupKey, { at: now }, { onlyIfNew: true });
  if (!dup.modified) return fail("Du har redan bokat den här tiden.");
  claimed.push(dupKey);

  // Max antal bokningar per person (0 = obegränsat)
  const max = poll.settings.maxPerPerson;
  if (max > 0) {
    let got = null;
    for (let i = 0; i < max; i++) {
      const k = `who/${poll.id}/${pk}/n-${i}`;
      const r = await store.setJSON(k, { at: now }, { onlyIfNew: true });
      if (r.modified) { got = k; break; }
    }
    if (!got) {
      await releaseClaims(store, claimed);
      return fail(max === 1 ? "Du har redan bokat en tid. Avboka den först om du vill byta." : `Du har redan bokat ${max} tider, vilket är max.`);
    }
    claimed.push(got);
  }

  // Ta första lediga plats
  const bookingId = randomId(10);
  let seatKey = null;
  for (let n = 0; n < poll.settings.capacity; n++) {
    const k = `seat/${poll.id}/${slot.id}/${n}`;
    const r = await store.setJSON(k, { bookingId, at: now }, { onlyIfNew: true });
    if (r.modified) { seatKey = k; break; }
  }
  if (!seatKey) {
    await releaseClaims(store, claimed);
    return fail("Tiden hann bli fullbokad. Välj en annan tid.", 409);
  }

  const token = randomId(24);
  const booking = {
    id: bookingId,
    slotId: slot.id,
    name: identity.name,
    email: identity.email,
    seatKey,
    claimKeys: claimed,
    tokenHash: hash(token),
    createdAt: now,
  };
  await store.setJSON(`booking/${poll.id}/${bookingId}`, booking);

  if (poll.settings.emailConfirm && booking.email) {
    const link = `${siteUrl(req)}/p/?id=${poll.id}&bokning=${bookingId}&nyckel=${token}`;
    const when = formatOption(slot);
    const html = mailLayout(poll.title, `
<p style="margin:0 0 12px">Din bokning är bekräftad.</p>
<p style="margin:0 0 12px"><strong>${escapeHtml(when)}</strong>${poll.location ? "<br>" + escapeHtml(poll.location) : ""}</p>
<p style="margin:0 0 16px">Kalenderfilen i mejlet lägger in tiden i din kalender.</p>
<p style="margin:0 0 16px"><a href="${link}" style="color:#8a1e2c">Visa eller avboka</a></p>`);
    await sendMail({
      to: booking.email,
      subject: `Bokad: ${poll.title}, ${when}`,
      html,
      text: `Din bokning är bekräftad.\n\n${when}${poll.location ? "\n" + poll.location : ""}\n\nVisa eller avboka: ${link}`,
      attachments: [icsAttachment(poll, slot, "-" + bookingId)],
    });
  }

  return json({ id: bookingId, token, slotId: slot.id });
}

async function getOwnBooking(url, store, poll, bookingId) {
  const b = await store.get(`booking/${poll.id}/${bookingId}`, { type: "json" });
  const token = url.searchParams.get("token") || "";
  if (!b || !token || !safeEqual(hash(token), b.tokenHash)) return fail("Bokningen hittades inte. Den kan redan vara avbokad.", 404);
  return json({ id: b.id, slotId: b.slotId, name: b.name, email: b.email });
}

async function removeBooking(store, poll, b) {
  await releaseClaims(store, [b.seatKey, ...(b.claimKeys || [])]);
  await store.delete(`booking/${poll.id}/${b.id}`);
}

async function cancelBooking(url, store, poll, bookingId) {
  const b = await store.get(`booking/${poll.id}/${bookingId}`, { type: "json" });
  const token = url.searchParams.get("token") || "";
  if (!b || !token || !safeEqual(hash(token), b.tokenHash)) return fail("Bokningen hittades inte. Den kan redan vara avbokad.", 404);
  await removeBooking(store, poll, b);
  return json({ ok: true });
}

// ---------- administration ----------

async function adminView(store, poll) {
  const out = publicPoll(poll);
  if (poll.mode === "poll") {
    const responses = await loadResponses(store, poll.id);
    out.tally = tally(poll, responses);
    out.responses = responses.map(({ tokenHash, ...r }) => r);
  } else {
    const bookings = await loadBookings(store, poll.id);
    out.bookings = bookings.map(({ tokenHash, seatKey, claimKeys, ...b }) => b);
    out.counts = await seatCounts(store, poll.id);
  }
  return json(out);
}

async function adminAction(req, store, poll) {
  const body = await readBody(req);
  const save = () => {
    const { id, ...data } = poll;
    return store.setJSON(`poll/${id}`, data);
  };

  switch (body.action) {
    case "close":
      poll.status = "closed";
      await save();
      return json({ ok: true });
    case "open":
      poll.status = "open";
      await save();
      return json({ ok: true });
    case "finalize": {
      if (poll.mode !== "poll") return fail("Fel typ av omröstning.");
      const opt = poll.options.find((o) => o.id === body.optionId);
      if (!opt) return fail("Tiden finns inte.");
      poll.finalOptionId = opt.id;
      await save();
      let notified = 0;
      if (body.notify && emailAvailable()) {
        const responses = await loadResponses(store, poll.id);
        const when = formatOption(opt);
        const link = `${siteUrl(req)}/p/?id=${poll.id}`;
        for (const r of responses) {
          if (!r.email) continue;
          const html = mailLayout(poll.title, `
<p style="margin:0 0 12px">Tiden är bestämd:</p>
<p style="margin:0 0 12px"><strong>${escapeHtml(when)}</strong>${poll.location ? "<br>" + escapeHtml(poll.location) : ""}</p>
<p style="margin:0 0 16px">Kalenderfilen i mejlet lägger in tiden i din kalender.</p>
<p style="margin:0"><a href="${link}" style="color:#8a1e2c">Visa omröstningen</a></p>`);
          const res = await sendMail({
            to: r.email,
            subject: `Bestämd tid: ${poll.title}`,
            html,
            text: `Tiden är bestämd: ${when}${poll.location ? "\n" + poll.location : ""}\n\n${link}`,
            attachments: [icsAttachment(poll, opt, "")],
          });
          if (res.sent) notified++;
        }
      }
      return json({ ok: true, notified });
    }
    case "unfinalize":
      poll.finalOptionId = null;
      await save();
      return json({ ok: true });
    case "deleteResponse": {
      const key = `resp/${poll.id}/${body.responseId}`;
      const r = await store.get(key, { type: "json" });
      if (!r) return fail("Svaret finns inte.", 404);
      if (r.email) await store.delete(`who/${poll.id}/${personKey(r)}/svar`);
      await store.delete(key);
      return json({ ok: true });
    }
    case "deleteBooking": {
      const b = await store.get(`booking/${poll.id}/${body.bookingId}`, { type: "json" });
      if (!b) return fail("Bokningen finns inte.", 404);
      await removeBooking(store, poll, b);
      return json({ ok: true });
    }
    default:
      return fail("Okänd åtgärd.");
  }
}
