// Hitta tid: gemensamma hjälpfunktioner för sidorna

// Etiketten för det tredje svarsalternativet. Ändra här om du vill kalla det något annat.
window.MAYBE_LABEL = "Om det behövs";

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch("/api/" + path, opts);
  } catch {
    throw new Error("Ingen kontakt med servern. Kontrollera uppkopplingen och försök igen.");
  }
  let data = {};
  try { data = await res.json(); } catch { /* tomt svar */ }
  if (!res.ok) {
    const err = new Error(data.error || "Något gick fel.");
    err.status = res.status;
    throw err;
  }
  return data;
}

// Vilka uppgifter deltagarna ska lämna (äldre omröstningar har "collect")
function fieldsOf(settings) {
  if (settings.fields) return settings.fields;
  const c = settings.collect || "name";
  return { name: c !== "email", email: c !== "name", phone: false };
}

function whoText(r) {
  return [r.name, r.email, r.phone].filter(Boolean).join(", ");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const WD_SHORT = ["sön", "mån", "tis", "ons", "tors", "fre", "lör"];
const WD_LONG = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
const MON = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];
const MON_LONG = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

function parseDate(d) {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function fmtDay(d, long = false) {
  const dt = parseDate(d);
  const thisYear = new Date().getFullYear();
  const y = dt.getUTCFullYear();
  if (long) return `${WD_LONG[dt.getUTCDay()]} ${dt.getUTCDate()} ${MON_LONG[dt.getUTCMonth()]}${y !== thisYear ? " " + y : ""}`;
  return `${WD_SHORT[dt.getUTCDay()]} ${dt.getUTCDate()} ${MON[dt.getUTCMonth()]}${y !== thisYear ? " " + y : ""}`;
}

function fmtTime(o) {
  if (!o.start) return "Hela dagen";
  return o.end ? `${o.start}–${o.end}` : o.start;
}

function fmtOption(o, long = false) {
  return `${fmtDay(o.date, long)}, ${o.start ? "kl. " + fmtTime(o) : "hela dagen"}`;
}

function groupByDate(options) {
  const map = new Map();
  for (const o of options) {
    if (!map.has(o.date)) map.set(o.date, []);
    map.get(o.date).push(o);
  }
  return map;
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch { /* ignorera */ }
    t.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "Kopierad";
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}

function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c ?? "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(";")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addMinutes(time, mins) {
  const [h, m] = time.split(":").map(Number);
  const t = h * 60 + m + mins;
  if (t >= 24 * 60) return null;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
