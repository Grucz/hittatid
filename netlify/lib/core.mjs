// Hitta tid: gemensam logik för API och städning.
// Lagring: Netlify Blobs (en butik, "hittatid"), stark konsistens.
//
// Nyckelstruktur:
//   poll/{id}                     omröstningens inställningar och tider
//   resp/{id}/{respId}            ett svar i läget "hitta gemensam tid"
//   seat/{id}/{slotId}/{n}        en bokad plats i läget "boka tid" (n = platsnummer)
//   who/{id}/{personKey}/{n}      spärr för max antal bokningar per person
//   booking/{id}/{bookingId}      bokningens uppgifter (pekar på seat och who)

import crypto from "node:crypto";

export const TZ = "Europe/Stockholm";
const STORE_NAME = "hittatid";

let storePromise = null;
export async function getDataStore() {
  if (globalThis.__HITTATID_TEST_STORE__) return globalThis.__HITTATID_TEST_STORE__;
  if (!storePromise) {
    storePromise = import("@netlify/blobs").then(({ getStore }) =>
      getStore({ name: STORE_NAME, consistency: "strong" })
    );
  }
  return storePromise;
}

export function env(name) {
  let v = "";
  try { v = globalThis.Netlify?.env?.get?.(name) || ""; } catch { v = ""; }
  return v || process.env[name] || "";
}

// ---------- små hjälpare ----------

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function randomId(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

export function fail(message, status = 400) {
  return json({ error: message }, status);
}

function str(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(v) {
  return EMAIL_RE.test(v);
}

// ---------- tidszon ----------

function tzOffsetMs(ts) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - ts;
}

// Lokal tid i Stockholm -> Date (UTC)
export function localToUtc(date, time) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let guess = naive;
  for (let i = 0; i < 3; i++) guess = naive - tzOffsetMs(guess);
  return new Date(guess);
}

const WEEKDAYS = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

export function formatOption(opt) {
  const [y, m, d] = opt.date.split("-").map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  let s = `${wd} ${d} ${MONTHS[m - 1]} ${y}`;
  if (opt.start) s += `, kl. ${opt.start}${opt.end ? "–" + opt.end : ""}`;
  return s;
}

function sortOptions(list) {
  return list.sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")));
}

// ---------- validering vid skapande ----------

export function validateNewPoll(body) {
  const mode = body.mode === "slots" ? "slots" : body.mode === "poll" ? "poll" : null;
  if (!mode) return { error: "Välj typ: hitta gemensam tid eller boka tid." };

  const title = str(body.title, 140);
  if (!title) return { error: "Ange en rubrik." };

  const f = body.fields && typeof body.fields === "object" ? body.fields : { name: true };
  const fields = { name: Boolean(f.name), email: Boolean(f.email), phone: Boolean(f.phone) };
  if (!fields.name && !fields.email && !fields.phone) return { error: "Välj minst en uppgift som deltagarna ska lämna." };
  const wantsEmail = fields.email;

  const rawOptions = Array.isArray(body.options) ? body.options : [];
  const maxOptions = mode === "slots" ? 400 : 100;
  if (rawOptions.length === 0) return { error: "Lägg till minst en tid." };
  if (rawOptions.length > maxOptions) return { error: `Högst ${maxOptions} tider.` };

  const seen = new Set();
  const options = [];
  for (const o of rawOptions) {
    const date = str(o?.date, 10);
    const start = str(o?.start, 5);
    const end = str(o?.end, 5);
    if (!DATE_RE.test(date)) return { error: "Ett av datumen är ogiltigt." };
    if (start && !TIME_RE.test(start)) return { error: "En av starttiderna är ogiltig." };
    if (end && !TIME_RE.test(end)) return { error: "En av sluttiderna är ogiltig." };
    if (end && !start) return { error: "En sluttid saknar starttid." };
    if (start && end && end <= start) return { error: `Sluttiden måste vara efter starttiden (${date} ${start}).` };
    if (mode === "slots" && !start) return { error: "I läget boka tid måste varje tid ha en starttid." };
    const key = `${date}|${start}|${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ id: randomId(6), date, start, end });
  }
  sortOptions(options);

  const settings = {
    fields,
    emailConfirm: Boolean(body.emailConfirm) && wantsEmail,
    showOthers: mode === "poll" ? body.showOthers !== false : Boolean(body.showOthers),
    allowMaybe: mode === "poll" ? body.allowMaybe !== false : false,
    capacity: mode === "slots" ? clampInt(body.capacity, 1, 500, 1) : null,
    maxPerPerson: mode === "slots" ? clampInt(body.maxPerPerson, 0, 400, 1) : null, // 0 = obegränsat
    deadline: DATE_RE.test(str(body.deadline, 10)) ? str(body.deadline, 10) : "",
    retentionDays: [7, 30, 90, 365].includes(Number(body.retentionDays)) ? Number(body.retentionDays) : 30,
  };

  const lastDate = options[options.length - 1].date;
  const deleteAt = new Date(localToUtc(lastDate, "23:59").getTime() + settings.retentionDays * 86400000).toISOString();

  return {
    poll: {
      mode,
      title,
      description: str(body.description, 2000),
      location: str(body.location, 200),
      organizer: str(body.organizer, 120),
      options,
      settings,
      status: "open",
      finalOptionId: null,
      createdAt: new Date().toISOString(),
      deleteAt,
    },
  };
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function isClosed(poll) {
  if (poll.status === "closed") return true;
  if (poll.mode === "poll" && poll.finalOptionId) return true;
  if (poll.settings.deadline) {
    const end = localToUtc(poll.settings.deadline, "23:59").getTime() + 59000;
    if (Date.now() > end) return true;
  }
  return false;
}

// Vilka uppgifter deltagarna ska lämna. Äldre omröstningar har "collect" i stället för "fields".
export function fieldsOf(settings) {
  if (settings.fields) return settings.fields;
  const c = settings.collect || "name";
  return { name: c !== "email", email: c !== "name", phone: false };
}

export function normalizePhone(v) {
  return String(v || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
}

// Kontrollerar namn, e-post och telefon utifrån omröstningens inställning
export function validateIdentity(poll, body) {
  const fields = fieldsOf(poll.settings);
  const name = str(body.name, 100);
  const email = str(body.email, 200).toLowerCase();
  const phone = str(body.phone, 40);
  if (fields.name && !name) return { error: "Ange ditt namn." };
  if (fields.email && !isEmail(email)) return { error: "Ange en giltig e-postadress." };
  if (fields.phone) {
    if (!/^[\d\s+\-()]+$/.test(phone) || normalizePhone(phone).replace("+", "").length < 7) {
      return { error: "Ange ett giltigt telefonnummer." };
    }
  }
  return {
    name: fields.name ? name : "",
    email: fields.email ? email : "",
    phone: fields.phone ? phone : "",
  };
}

// Det som identifierar en person: e-post i första hand, sedan telefon, sist namn
export function personKey(identity) {
  const base = identity.email || normalizePhone(identity.phone) || (identity.name || "").toLowerCase().replace(/\s+/g, " ");
  return hash(base).slice(0, 24);
}

// ---------- läsning ----------

export async function loadPoll(store, id) {
  if (!/^[A-Za-z0-9]{6,20}$/.test(id)) return null;
  return store.get(`poll/${id}`, { type: "json" });
}

export async function loadResponses(store, id) {
  const { blobs } = await store.list({ prefix: `resp/${id}/` });
  const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return items.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function loadBookings(store, id) {
  const { blobs } = await store.list({ prefix: `booking/${id}/` });
  const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return items.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function seatCounts(store, id) {
  const { blobs } = await store.list({ prefix: `seat/${id}/` });
  const counts = {};
  for (const b of blobs) {
    const slotId = b.key.split("/")[2];
    counts[slotId] = (counts[slotId] || 0) + 1;
  }
  return counts;
}

// Sammanställning per tid för läget "hitta gemensam tid"
export function tally(poll, responses) {
  const t = {};
  for (const o of poll.options) t[o.id] = { yes: 0, maybe: 0, no: 0 };
  for (const r of responses) {
    for (const [optId, a] of Object.entries(r.answers || {})) {
      if (!t[optId]) continue;
      if (a === "y") t[optId].yes++;
      else if (a === "m") t[optId].maybe++;
      else t[optId].no++;
    }
  }
  return t;
}

// ---------- radering ----------

export async function deletePollData(store, id) {
  for (const prefix of [`resp/${id}/`, `seat/${id}/`, `who/${id}/`, `booking/${id}/`]) {
    const { blobs } = await store.list({ prefix });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
  }
  await store.delete(`poll/${id}`);
}

// ---------- kalenderfil (.ics) ----------

function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsEscape(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsFold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 74) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildIcs(poll, opt, uidSuffix = "") {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hitta tid//SV",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${poll.id}-${opt.id}${uidSuffix}@hitta-tid`,
    `DTSTAMP:${icsDate(new Date())}`,
  ];
  if (opt.start) {
    const start = localToUtc(opt.date, opt.start);
    const end = opt.end ? localToUtc(opt.date, opt.end) : new Date(start.getTime() + 3600000);
    lines.push(`DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`);
  } else {
    const d = opt.date.replace(/-/g, "");
    const [y, m, day] = opt.date.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10).replace(/-/g, "");
    lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`);
  }
  lines.push(`SUMMARY:${icsEscape(poll.title)}`);
  if (poll.description) lines.push(`DESCRIPTION:${icsEscape(poll.description)}`);
  if (poll.location) lines.push(`LOCATION:${icsEscape(poll.location)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

// ---------- e-post via Resend ----------

export function emailAvailable() {
  return Boolean(env("RESEND_API_KEY") && env("MAIL_FROM"));
}

export async function sendMail({ to, subject, html, text, attachments }) {
  if (!emailAvailable() || !to) return { sent: false };
  if (globalThis.__HITTATID_TEST_MAIL__) {
    globalThis.__HITTATID_TEST_MAIL__.push({ to, subject, text, attachments });
    return { sent: true };
  }
  const payload = { from: env("MAIL_FROM"), to: [to], subject, html, text };
  const replyTo = env("MAIL_REPLY_TO");
  if (replyTo) payload.reply_to = replyTo;
  if (attachments?.length) payload.attachments = attachments;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("Resend svarade", res.status, await res.text());
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    console.error("E-post kunde inte skickas", err);
    return { sent: false };
  }
}

export function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function mailLayout(title, bodyHtml) {
  return `<!doctype html><html lang="sv"><body style="margin:0;background:#f6f3ef;font-family:Helvetica,Arial,sans-serif;color:#2b2522">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<div style="background:#ffffff;border-radius:10px;padding:28px 24px;border-top:4px solid #8a1e2c">
<h1 style="font-size:20px;margin:0 0 16px;color:#2b2522">${escapeHtml(title)}</h1>
${bodyHtml}
</div></div></body></html>`;
}

export function icsAttachment(poll, opt, suffix) {
  return {
    filename: "kalender.ics",
    content: Buffer.from(buildIcs(poll, opt, suffix), "utf8").toString("base64"),
    content_type: "text/calendar; charset=utf-8",
  };
}
