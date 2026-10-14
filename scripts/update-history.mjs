// Builds and updates the daily-stats history files in data/ (one file per station).
//
//   node scripts/update-history.mjs            update every station in scripts/stations.json
//   node scripts/update-history.mjs --max 60   stop after 60 new days (handy for testing)
//   node scripts/update-history.mjs --station summerville
//
// Each station's keys come from environment variables named after its id (see README.md).
// A station is skipped, with a message, when its keys aren't set.
// Days already in the file are never fetched again. Today is never stored (it isn't finished yet).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { walkHistory, addEcowittDerived, wuColumns, computeRecord, RECORD_VERSION } from "./day-stats.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ECOWITT_FULL_DETAIL_DAYS = 90;      // newer days come from Ecowitt (5-minute data), older ones from Weather Underground
const ECOWITT_MAX_DAYS_BACK = 730;
const API_HISTORY = process.env.ECOWITT_HISTORY_URL || "https://api.ecowitt.net/api/v3/device/history";
const WU_HISTORY_ALL = process.env.WU_HISTORY_URL || "https://api.weather.com/v2/pws/history/all";
const CALLBACKS = ["all", "outdoor,indoor,solar_and_uvi,rainfall_piezo,rainfall,wind,pressure,battery"];
const GAP = { ecowitt: Number(process.env.ECOWITT_GAP_MS || 1200), wu: Number(process.env.WU_GAP_MS || 2100) };

const pad = n => String(n).padStart(2, "0");
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// requests to each service are spaced out; both limit how fast they can be called
const next = {};
async function throttle(kind) {
  const t = Math.max(Date.now(), next[kind] || 0);
  next[kind] = t + GAP[kind];
  if (t > Date.now()) await sleep(t - Date.now());
}

async function getJson(url, kind) {
  await throttle(kind);
  const res = await fetch(url);
  return res;
}

async function fetchEcowitt(st, date) {
  const daysAgo = Math.round((startOfToday() - new Date(date + "T00:00:00")) / 86400000);
  const cycle = daysAgo <= ECOWITT_FULL_DETAIL_DAYS ? "5min" : daysAgo <= 365 ? "30min" : "4hour";
  let lastErr = null;
  for (const cb of CALLBACKS) {
    const q = new URLSearchParams({
      application_key: st.ecowitt.appKey, api_key: st.ecowitt.apiKey, mac: st.ecowitt.mac,
      call_back: cb, cycle_type: cycle, start_date: `${date} 00:00:00`, end_date: `${date} 23:59:59`,
      temp_unitid: "1", pressure_unitid: "3", wind_speed_unitid: "7", rainfall_unitid: "12", solar_radiation_unitid: "16"
    });
    try {
      const res = await getJson(`${API_HISTORY}?${q}`, "ecowitt");
      if (!res.ok) throw new Error(`Ecowitt HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== 0) throw new Error(`Ecowitt said: ${json.msg || "unknown error"} (code ${json.code})`);
      const found = [];
      walkHistory(json.data, [], found);
      if (!found.length) { lastErr = null; continue; }
      return { found: addEcowittDerived(found), source: "Ecowitt" };
    } catch (err) { lastErr = err; }
  }
  if (lastErr) throw lastErr;
  return { found: [], source: "Ecowitt" };
}

async function fetchWU(st, date) {
  const q = new URLSearchParams({
    stationId: st.wu.stationId, format: "json", units: "m", date: date.replace(/-/g, ""),
    numericPrecision: "decimal", apiKey: st.wu.apiKey
  });
  const res = await getJson(`${WU_HISTORY_ALL}?${q}`, "wu");
  if (res.status === 204) return { found: [], source: "Weather Underground" };
  if (!res.ok) {
    let why = "";
    try { const j = await res.json(); why = (j && j.errors && j.errors[0] && j.errors[0].error && j.errors[0].error.message) || ""; } catch { /* ignore */ }
    throw new Error(`Weather Underground HTTP ${res.status}${why ? " - " + why.replace(/[.\s]+$/, "") : ""}`);
  }
  const json = await res.json();
  const obs = Array.isArray(json.observations) ? json.observations : [];
  return { found: obs.length ? wuColumns(obs) : [], source: "Weather Underground" };
}

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

// Same routing as the page: recent days from Ecowitt, older days from Weather Underground, with fallbacks
async function fetchDay(st, date) {
  const daysAgo = Math.round((startOfToday() - new Date(date + "T00:00:00")) / 86400000);
  const hasWU = !!(st.wu && st.wu.apiKey && st.wu.stationId);
  const hasEco = !!(st.ecowitt && st.ecowitt.appKey && st.ecowitt.apiKey && st.ecowitt.mac);
  if (!hasWU && !hasEco) throw new Error("no keys");
  if ((daysAgo <= ECOWITT_FULL_DETAIL_DAYS && hasEco) || !hasWU) return fetchEcowitt(st, date);
  const tooOld = daysAgo > ECOWITT_MAX_DAYS_BACK || !hasEco;
  try {
    const r = await fetchWU(st, date);
    if (r.found.length || tooOld) return r;
  } catch (err) {
    if (tooOld) throw err;
    console.warn(`  Weather Underground failed for ${date} (${err.message}), trying Ecowitt`);
  }
  return fetchEcowitt(st, date);
}

async function withRetry(fn, tries = 3) {
  let err;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) { err = e; if (i < tries) await sleep(3000 * i); }
  }
  throw err;
}

function stationFromEnv(s) {
  const P = s.id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const e = n => (process.env[`${P}_${n}`] || "").trim();
  return {
    ...s,
    ecowitt: { appKey: e("ECOWITT_APP_KEY"), apiKey: e("ECOWITT_API_KEY"), mac: e("ECOWITT_MAC") },
    wu: { apiKey: e("WU_API_KEY"), stationId: e("WU_STATION_ID") }
  };
}

async function loadFile(file) {
  try {
    const j = JSON.parse(await readFile(file, "utf8"));
    if (j.version === RECORD_VERSION && Array.isArray(j.days)) return j;
    console.log(`  ${path.basename(file)} was built with a different version; starting it again.`);
  } catch { /* new file */ }
  return { version: RECORD_VERSION, days: [] };
}

async function save(file, data) {
  data.days.sort((a, b) => a.d < b.d ? -1 : 1);
  data.updated = new Date().toISOString();
  await writeFile(file, JSON.stringify(data) + "\n");
}

async function updateStation(s, opts) {
  const st = stationFromEnv(s);
  const hasEco = st.ecowitt.appKey && st.ecowitt.apiKey && st.ecowitt.mac, hasWU = st.wu.apiKey && st.wu.stationId;
  if (!hasEco && !hasWU) { console.log(`${s.name}: no keys set (${s.id.toUpperCase()}_ECOWITT_* / _WU_*), skipping.`); return { ok: 0, failed: 0 }; }
  const file = path.join(process.env.DATA_DIR || path.join(ROOT, "data"), `history-${s.id}.json`);
  const data = await loadFile(file);
  const have = new Set(data.days.map(d => d.d));
  const todo = [];
  const end = startOfToday(); end.setDate(end.getDate() - 1);           // yesterday is the last finished day
  for (const d = new Date(s.historyStart + "T00:00:00"); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = dateStr(d);
    if (!have.has(ds)) todo.push(ds);
  }
  const batch = opts.max ? todo.slice(0, opts.max) : todo;
  console.log(`${s.name}: ${data.days.length} days stored, ${todo.length} to fetch${opts.max ? ` (doing ${batch.length})` : ""}.`);
  let ok = 0, failed = 0, since = 0;
  for (const ds of batch) {
    try {
      const res = await withRetry(() => fetchDay(st, ds));
      const rec = res.found.length ? computeRecord(res.found, res.source, ds) : null;
      const age = Math.round((startOfToday() - new Date(ds + "T00:00:00")) / 86400000);
      if (rec) data.days.push(rec);
      else if (age >= 3) data.days.push({ d: ds, none: true });          // confirmed empty; don't ask again
      ok++; since++;
      if (ok % 10 === 0) console.log(`  ${ds} (${ok} done)`);
    } catch (err) {
      failed++;
      console.warn(`  ${ds}: ${err.message}`);
    }
    if (since >= 20) { await save(file, data); since = 0; }          // keep progress if the run is cut short
  }
  await mkdir(path.dirname(file), { recursive: true });
  await save(file, data);
  console.log(`${s.name}: added ${ok} day${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed (they'll be tried again next run)` : ""}.`);
  return { ok, failed };
}

const args = process.argv.slice(2);
const opts = { max: 0, station: "" };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max") opts.max = Number(args[++i]) || 0;
  else if (args[i] === "--station") opts.station = args[++i] || "";
}
const stations = JSON.parse(await readFile(process.env.STATIONS_FILE || path.join(ROOT, "scripts", "stations.json"), "utf8"))
  .filter(s => !opts.station || s.id === opts.station);
let totalOk = 0, totalFailed = 0;
for (const s of stations) {
  const r = await updateStation(s, opts);
  totalOk += r.ok; totalFailed += r.failed;
}
// Fail the run (so GitHub emails you) only when nothing at all worked
if (totalFailed > 0 && totalOk === 0) process.exit(1);
