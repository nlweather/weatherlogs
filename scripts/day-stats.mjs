// Turns one day of readings (from Ecowitt or Weather Underground) into one small record of daily stats.
//
// This is the same logic the web page uses for its "By day" view, written for Node and always working in
// metric units. If you change how a statistic is worked out in weather-station.html, change it here too
// and bump RECORD_VERSION so the history files get rebuilt.

export const RECORD_VERSION = 1;

/* ---------- humidex and wind chill (Environment and Climate Change Canada formulas) ---------- */
const HUMIDEX_MIN_TEMP = 18;   // outdoor humidex is only reported from this temperature (same rule as the page)

export function humidexNumber(tC, tdC) {
  if (tC === null || tdC === null || Number.isNaN(tC) || Number.isNaN(tdC)) return undefined;
  const e = 6.11 * Math.exp(5417.7530 * (1 / 273.15 - 1 / (tdC + 273.15)));
  const h = tC + 0.5555 * (e - 10.0);
  return tC >= HUMIDEX_MIN_TEMP && h - tC >= 1 ? h : null;          // null = "N/A" (rule says don't report)
}

export function windChillNumber(tC, vKmh) {
  if (tC === null || vKmh === null || Number.isNaN(tC) || Number.isNaN(vKmh)) return undefined;
  if (!(tC <= 0 && vKmh > 0)) return null;
  if (vKmh >= 5) {
    const v16 = Math.pow(vKmh, 0.16);
    return 13.12 + 0.6215 * tC - 11.37 * v16 + 0.3965 * tC * v16;
  }
  return tC + ((-1.59 + 0.1345 * tC) / 5) * vKmh;
}

const numOrNull = v => (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) ? null : Number(v);

/* ---------- Ecowitt: walk the reply into { path, unit, list } columns ---------- */
export function walkHistory(node, path, out) {
  if (!node || typeof node !== "object") return;
  if (node.list && typeof node.list === "object" && !Array.isArray(node.list)) { out.push({ path, unit: node.unit || "", list: node.list }); return; }
  Object.entries(node).forEach(([k, v]) => walkHistory(v, path.concat(k), out));
}

// Add calculated outdoor humidex and wind chill columns (as strings, rounded, "N/A" where they don't apply)
export function addEcowittDerived(found) {
  const find = (g, k) => found.find(f => f.path.length > 1 && f.path[0] === g && f.path[1] === k);
  const oT = find("outdoor", "temperature"), oD = find("outdoor", "dew_point"), wS = find("wind", "wind_speed");
  const out = found.filter(f => !(f.path.length > 1 && (f.path[0] === "outdoor" || f.path[0] === "indoor") && /^(feels_like|app_temp)/.test(f.path[1])));
  const c = f => v => { const n = numOrNull(v); if (n === null) return null; return /F|℉/i.test(f.unit) ? (n - 32) * 5 / 9 : n; };
  if (oT && oD) {
    const list = {}, tc = c(oT), dc = c({ unit: oD.unit || oT.unit });
    Object.keys(oT.list).forEach(k => {
      if (oD.list[k] === undefined) return;
      const r = humidexNumber(tc(oT.list[k]), dc(oD.list[k]));
      if (r !== undefined) list[k] = r === null ? "N/A" : String(Math.round(r));
    });
    out.push({ path: ["outdoor", "humidex"], unit: "", list });
  }
  if (oT && wS) {
    const list = {}, tc = c(oT);
    Object.keys(oT.list).forEach(k => {
      if (wS.list[k] === undefined) return;
      const w = numOrNull(wS.list[k]);
      const u = (wS.unit || "").toLowerCase();
      const kmh = w === null ? null : u.includes("km") ? w : u.includes("mph") || u.includes("mi") ? w * 1.609344 : u.includes("m/s") ? w * 3.6 : null;
      const r = windChillNumber(tc(oT.list[k]), kmh);
      if (r !== undefined) list[k] = r === null ? "N/A" : String(Math.round(r));
    });
    out.push({ path: ["outdoor", "wind_chill"], unit: "", list });
  }
  return out;
}

/* ---------- Weather Underground: observations -> columns ---------- */
export function wuColumns(obs) {
  const block = o => o.metric || o.metric_si || o.uk_hybrid || o.imperial || {};
  const col = (path, where, key) => {
    const list = {};
    obs.forEach(o => {
      const v = where === "t" ? o[key] : block(o)[key];
      if (v !== null && v !== undefined && v !== "" && o.epoch) list[String(o.epoch)] = v;
    });
    return Object.keys(list).length ? { path, unit: "", list } : null;
  };
  const found = [
    col(["Temperature", "High"], "b", "tempHigh"), col(["Temperature", "Low"], "b", "tempLow"),
    col(["Dew point", "High"], "b", "dewptHigh"), col(["Dew point", "Low"], "b", "dewptLow"),
    col(["Humidity", "High"], "t", "humidityHigh"), col(["Humidity", "Low"], "t", "humidityLow"),
    col(["Wind speed", "Average"], "b", "windspeedAvg"), col(["Wind gust", "High"], "b", "windgustHigh"),
    col(["Wind direction", "Average"], "t", "winddirAvg"),
    col(["Pressure", "Max"], "b", "pressureMax"), col(["Pressure", "Min"], "b", "pressureMin"),
    col(["Rain", "Rate"], "b", "precipRate"), col(["Rain", "Total"], "b", "precipTotal"),
    col(["UV index", "High"], "t", "uvHigh")
  ].filter(Boolean);
  // Humidex and wind chill from each reading's average temperature, dew point and wind speed
  const hx = {}, wc = {};
  obs.forEach(o => {
    const b = block(o);
    if (!o.epoch || b.tempAvg === null || b.tempAvg === undefined) return;
    const k = String(o.epoch), t = Number(b.tempAvg);
    if (b.dewptAvg !== null && b.dewptAvg !== undefined) {
      const r = humidexNumber(t, Number(b.dewptAvg));
      if (r !== undefined) hx[k] = r === null ? "N/A" : String(Math.round(r));
    }
    if (b.windspeedAvg !== null && b.windspeedAvg !== undefined) {
      const r = windChillNumber(t, Number(b.windspeedAvg));
      if (r !== undefined) wc[k] = r === null ? "N/A" : String(Math.round(r));
    }
  });
  if (Object.keys(hx).length) found.push({ path: ["Humidex"], unit: "", list: hx });
  if (Object.keys(wc).length) found.push({ path: ["Wind chill"], unit: "", list: wc });
  return found;
}

/* ---------- the daily record ---------- */
const parseTs = k => /^\d+$/.test(k) ? Number(k) * 1000 : Date.parse(String(k).replace(" ", "T"));
const r2 = n => Math.round(n * 100) / 100;

// source: "Ecowitt" or "Weather Underground". Returns null when there's nothing usable in the day.
export function computeRecord(found, source, date) {
  const wu = source === "Weather Underground";
  const index = new Map(found.map(f => [f.path.join("|"), f]));
  const get = p => index.get(p.join("|"));
  const series = f => !f ? [] : Object.entries(f.list)
    .map(([k, v]) => [parseTs(k), (v === null || v === undefined || v === "") ? NaN : Number(v)])
    .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .sort((a, b) => a[0] - b[0]);

  let rg = "rainfall";
  if (!wu) {
    const top = g => { const sr = series(get([g, "daily"])); return sr.length ? Math.max(...sr.map(p => p[1])) : -1; };
    if (top("rainfall_piezo") > top("rainfall")) rg = "rainfall_piezo";
  }
  const P = wu ? {
    hi: ["Temperature", "High"], lo: ["Temperature", "Low"], hx: ["Humidex"], wc: ["Wind chill"],
    dHi: ["Dew point", "High"], dLo: ["Dew point", "Low"], rHi: ["Humidity", "High"], rLo: ["Humidity", "Low"],
    ws: ["Wind speed", "Average"], wg: ["Wind gust", "High"], uv: ["UV index", "High"],
    pt: ["Rain", "Total"], pr: ["Rain", "Rate"], bHi: ["Pressure", "Max"], bLo: ["Pressure", "Min"], dir: ["Wind direction", "Average"]
  } : {
    hi: ["outdoor", "temperature"], lo: ["outdoor", "temperature"], hx: ["outdoor", "humidex"], wc: ["outdoor", "wind_chill"],
    dHi: ["outdoor", "dew_point"], dLo: ["outdoor", "dew_point"], rHi: ["outdoor", "humidity"], rLo: ["outdoor", "humidity"],
    ws: ["wind", "wind_speed"], wg: ["wind", "wind_gust"], uv: ["solar_and_uvi", "uvi"],
    pt: [rg, "daily"], pr: [rg, "rain_rate"], bHi: ["pressure", "relative"], bLo: ["pressure", "relative"], dir: ["wind", "wind_direction"]
  };

  // earliest time wins on ties, like the page
  const extreme = (path, mode) => {
    const sr = series(get(path));
    if (!sr.length) return undefined;
    let best = sr[0];
    sr.forEach(p => { if (mode === "max" ? p[1] > best[1] : p[1] < best[1]) best = p; });
    return [r2(best[1]), best[0]];
  };
  const r = {};
  const put = (k, v) => { if (v !== undefined) r[k] = v; };
  put("hi", extreme(P.hi, "max")); put("lo", extreme(P.lo, "min"));
  put("hx", extreme(P.hx, "max")); put("wc", extreme(P.wc, "min"));
  put("dh", extreme(P.dHi, "max")); put("dl", extreme(P.dLo, "min"));
  put("rh", extreme(P.rHi, "max")); put("rl", extreme(P.rLo, "min"));
  put("bh", extreme(P.bHi, "max")); put("bl", extreme(P.bLo, "min"));
  put("wg", extreme(P.wg, "max"));
  put("uv", extreme(P.uv, "max")); put("pr", extreme(P.pr, "max"));

  const wsr = series(get(P.ws));
  if (wsr.length) r.ws = r2(wsr.reduce((a, p) => a + p[1], 0) / wsr.length);

  // precipitation: day's largest running total, and when it started and stopped rising
  const tsr = series(get(P.pt));
  if (tsr.length) {
    let first = null, last = null, prev = 0;
    tsr.forEach(([t, v]) => { if (v > prev + 1e-9) { if (first === null) first = t; last = t; } prev = v; });
    r.pt = [r2(Math.max(...tsr.map(p => p[1]))), first, last];
  }

  // mean humidex / wind chill over the readings where they apply
  [["hm", P.hx], ["cm", P.wc]].forEach(([k, path]) => {
    const sr = series(get(path));
    if (sr.length) r[k] = r2(sr.reduce((a, p) => a + p[1], 0) / sr.length);
  });

  // wind direction as a sum of unit vectors, so months can be averaged properly
  const dsr = series(get(P.dir)).filter(p => p[1] >= 0 && p[1] <= 360);
  if (dsr.length) {
    r.dv = [
      Math.round(dsr.reduce((a, p) => a + Math.sin(p[1] * Math.PI / 180), 0) * 1e4) / 1e4,
      Math.round(dsr.reduce((a, p) => a + Math.cos(p[1] * Math.PI / 180), 0) * 1e4) / 1e4,
      dsr.length
    ];
  }
  if (!Object.keys(r).length) return null;
  return { d: date, s: wu ? "W" : "E", r };
}
