const MODEL = /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Anthropic|Perplexity|Google-Extended|Bytespider|Amazonbot|meta-externalagent|cohere|YouBot|Phind|DuckAssist|CCBot|Applebot-Extended/i;
const UNFURL = /Slackbot|Twitterbot|facebookexternalhit|Facebot|Discordbot|TelegramBot|WhatsApp|LinkedInBot|Iframely|embedly|Pinterest|vkShare/i;
const BROWSER = /Mozilla\/|AppleWebKit|Chrome\/|Firefox\/|Safari\//i;

const BC_PCT_ZONES = { "America/Vancouver": true, "Canada/Pacific": true };
const BC_PCT_FROM = Date.UTC(2026, 2, 8, 10, 0);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ABBR_ZONES = {
  pst: ["America/Los_Angeles"], pdt: ["America/Los_Angeles"], pt: ["America/Los_Angeles"],
  pct: ["America/Vancouver"],
  est: ["America/New_York", "America/Toronto"], edt: ["America/New_York", "America/Toronto"], et: ["America/New_York", "America/Toronto"],
  cst: ["America/Chicago", "America/Winnipeg"], cdt: ["America/Chicago", "America/Winnipeg"], ct: ["America/Chicago", "America/Winnipeg"],
  mst: ["America/Denver", "America/Phoenix", "America/Edmonton"], mdt: ["America/Denver", "America/Edmonton"], mt: ["America/Denver", "America/Edmonton"],
  gmt: ["Europe/London", "Etc/UTC"], bst: ["Europe/London"], utc: ["Etc/UTC"], z: ["Etc/UTC"],
  cet: ["Europe/Paris", "Europe/Berlin", "Europe/Amsterdam", "Europe/Rome", "Europe/Madrid", "Europe/Zurich", "Europe/Vienna", "Europe/Prague", "Europe/Warsaw", "Europe/Stockholm", "Europe/Oslo", "Europe/Copenhagen"],
  cest: ["Europe/Paris", "Europe/Berlin", "Europe/Amsterdam", "Europe/Rome", "Europe/Madrid"],
  jst: ["Asia/Tokyo"], kst: ["Asia/Seoul"], ist: ["Asia/Kolkata"], hkt: ["Asia/Hong_Kong"], sgt: ["Asia/Singapore"],
  aest: ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane"],
  aedt: ["Australia/Sydney", "Australia/Melbourne"], awst: ["Australia/Perth"], nzst: ["Pacific/Auckland"],
  hst: ["Pacific/Honolulu"], akst: ["America/Anchorage"], akdt: ["America/Anchorage"]
};

const API_ORIGIN = "https://api.forwardslashdot.com";
// Same rows as services/domain-checker/app/endings.py. First paint uses this.
// /api/endings then replaces it once stored checks from that country are enough to move the row.
const ENDING_GLOBAL = [".com", ".net", ".org", ".io", ".co", ".ai"];
const ENDING_SEED = {
  CA: [".ca", ".com", ".net", ".org", ".io", ".ai"],
  AU: [".com.au", ".net.au", ".org.au", ".com", ".net", ".io"],
  GB: [".uk", ".co.uk", ".com", ".org", ".io", ".ai"],
  DE: [".de", ".com", ".net", ".org", ".eu", ".io"],
  FR: [".fr", ".com", ".eu", ".net", ".org", ".io"],
  NL: [".nl", ".com", ".eu", ".net", ".org", ".io"],
  ES: [".es", ".com", ".net", ".org", ".eu", ".io"],
  MX: [".mx", ".com.mx", ".com", ".net", ".org", ".io"],
  IN: [".in", ".co.in", ".com", ".net", ".org", ".io"],
  SG: [".sg", ".com.sg", ".com", ".net", ".org", ".io"],
  CH: [".ch", ".com", ".net", ".org", ".io", ".ai"],
  ID: [".id", ".com", ".net", ".org", ".io", ".ai"],
  PH: [".ph", ".com.ph", ".com", ".net", ".org", ".io"],
  MY: [".my", ".com", ".net", ".org", ".io", ".ai"],
  PE: [".pe", ".com.pe", ".com", ".net", ".org", ".io"]
};

function visitorCountry(request, url) {
  const query = String((url && url.searchParams.get("region")) || (url && url.searchParams.get("country")) || "").trim().toUpperCase();
  const code = query === "UK" ? "GB" : query;
  if (/^[A-Z]{2}$/.test(code)) return code;
  const header = String((request.headers.get("cf-ipcountry") || "")).trim().toUpperCase();
  if (header === "UK") return "GB";
  if (/^[A-Z]{2}$/.test(header)) return header;
  return "";
}

function seededRow(country) {
  return (ENDING_SEED[country] || ENDING_GLOBAL).slice();
}
const DISCOVERY = {
  "/.well-known/mcp.json": API_ORIGIN + "/.well-known/mcp.json",
  "/.well-known/api-catalog": API_ORIGIN + "/.well-known/api-catalog",
  "/openapi.json": API_ORIGIN + "/openapi.json"
};

let catalogCache = null;
let stableCache = null;

const CRAWLER = /bot|crawler|spider|slurp|bingpreview|duckduckbot|baiduspider|yandex|semrush|ahrefs|petalbot|googlebot|adsbot|mediapartners|facebookexternal|embedly|quora|pinterest|redditbot|applebot/i;

function areaFor(path) {
  if (path === "/instantdomainsearch" || path.startsWith("/instantdomainsearch/")) return "instant_domain_search";
  if (path === "/worldtimeconverter" || path.startsWith("/worldtimeconverter/") || path === "/time") {
    return "world_time_converter";
  }
  return "";
}

async function visitorHash(ip, ua, day) {
  const data = new TextEncoder().encode(day + "\n" + ip + "\n" + ua);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(function (b) {
    return b.toString(16).padStart(2, "0");
  }).join("").slice(0, 32);
}

async function noteModel(request, area) {
  const ua = request.headers.get("user-agent") || "";
  if (!ua || UNFURL.test(ua)) return;
  const dest = request.headers.get("sec-fetch-dest") || "";
  const mode = request.headers.get("sec-fetch-mode") || "";
  const model = MODEL.test(ua) || (!dest && !mode && !BROWSER.test(ua));
  if (!model) return;
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("cf-connecting-ip") || "";
  const country = request.headers.get("cf-ipcountry") || "";
  const visitor = await visitorHash(ip, ua, day);
  const hit = new URL(API_ORIGIN + "/api/hit");
  hit.searchParams.set("area", area);
  hit.searchParams.set("actor", "llm");
  hit.searchParams.set("visitor", visitor);
  hit.searchParams.set("day", day);
  if (/^[A-Za-z0-9]{2}$/.test(country) || country === "T1") hit.searchParams.set("country", country);
  await fetch(hit, { method: "GET" });
}

function permanentRule(zone, utcMs) {
  if (BC_PCT_ZONES[zone] && utcMs >= BC_PCT_FROM) return { offset: -420, abbr: "PCT" };
  return null;
}

function partsFromOffset(utcMs, offset, abbr) {
  const date = new Date(utcMs + offset * 60000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: WEEKDAYS[date.getUTCDay()],
    abbr
  };
}

function partsInZone(utcMs, timeZone) {
  const fixed = permanentRule(timeZone, utcMs);
  if (fixed) return partsFromOffset(utcMs, fixed.offset, fixed.abbr);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    timeZoneName: "short"
  });
  const bag = {};
  fmt.formatToParts(new Date(utcMs)).forEach((part) => { bag[part.type] = part.value; });
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    weekday: bag.weekday,
    abbr: bag.timeZoneName || ""
  };
}

function tzOffset(utcMs, timeZone) {
  const fixed = permanentRule(timeZone, utcMs);
  if (fixed) return fixed.offset;
  const parts = partsInZone(utcMs, timeZone);
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUTC - utcMs) / 60000);
}

function civilToInstant(year, month, day, minutes, timeZone) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffset(utc, timeZone);
  let instant = utc - offset * 60000;
  const offset2 = tzOffset(instant, timeZone);
  if (offset2 !== offset) instant = utc - offset2 * 60000;
  return instant;
}

function formatTime(hour, minute, hour24) {
  const m = String(minute).padStart(2, "0");
  if (hour24) return String(hour).padStart(2, "0") + ":" + m;
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 || 12;
  return h + ":" + m + " " + suffix;
}

const CARD_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WORKER_ZONE_ABBR = {
  "Asia/Tokyo": { 540: "JST" }, "Asia/Seoul": { 540: "KST" },
  "Asia/Kolkata": { 330: "IST" }, "Asia/Calcutta": { 330: "IST" },
  "Asia/Singapore": { 480: "SGT" }, "Asia/Hong_Kong": { 480: "HKT" },
  "Asia/Shanghai": { 480: "CST" }, "Asia/Dubai": { 240: "GST" },
  "Europe/London": { 0: "GMT", 60: "BST" },
  "Europe/Paris": { 60: "CET", 120: "CEST" }, "Europe/Berlin": { 60: "CET", 120: "CEST" },
  "Europe/Amsterdam": { 60: "CET", 120: "CEST" }, "Europe/Rome": { 60: "CET", 120: "CEST" },
  "Europe/Madrid": { 60: "CET", 120: "CEST" }, "Europe/Zurich": { 60: "CET", 120: "CEST" },
  "Australia/Sydney": { 600: "AEST", 660: "AEDT" }, "Australia/Melbourne": { 600: "AEST", 660: "AEDT" },
  "Australia/Perth": { 480: "AWST" }, "Pacific/Auckland": { 720: "NZST", 780: "NZDT" }
};

function friendlyWorkerAbbr(zone, rawAbbr, offset) {
  if (rawAbbr && !/^(GMT|UTC)[+-]/i.test(rawAbbr)) return rawAbbr;
  const map = WORKER_ZONE_ABBR[zone];
  if (map && map[offset]) return map[offset];
  return rawAbbr || "";
}

function classifyPeriod(minute, workStart, workEnd) {
  const m = ((minute % 1440) + 1440) % 1440;
  const covers = (val, s, e) => {
    let x = val;
    if (x < s) x += 1440;
    else if (x >= s + 1440) x -= 1440;
    return s <= x && x < e;
  };
  if (covers(m, workStart, workEnd)) return "work";
  if (covers(m, workStart - 120, workStart) || covers(m, workEnd, workEnd + 120)) return "edge";
  return "night";
}

function dayText(delta) {
  if (delta === 1) return "tomorrow";
  if (delta === -1) return "yesterday";
  return "";
}

function zoneOk(zone) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return true;
  } catch (err) {
    return false;
  }
}

function zoneLabel(zone) {
  return zone.split("/").pop().replaceAll("_", " ");
}

function parseToken(catalog, token) {
  token = token.trim();
  if (!token) return null;
  const at = token.lastIndexOf("@");
  if (at > 0) {
    const bits = token.slice(at + 1).split("_");
    const lat = Number(bits[0]);
    const lon = Number(bits[1]);
    if (bits.length === 2 && isFinite(lat) && isFinite(lon)) token = token.slice(0, at);
  }
  if (token.includes("~")) {
    const index = token.indexOf("~");
    const city = token.slice(0, index);
    const zone = token.slice(index + 1);
    if (!zoneOk(zone)) return null;
    const known = catalog.find((item) => item.city === city && item.zone === zone);
    return known
      ? { city: known.city, region: known.region, zone: known.zone }
      : { city, region: zoneLabel(zone), zone };
  }
  const folded = token.toLowerCase();
  const byCity = catalog.find((item) => item.city.toLowerCase() === folded);
  if (byCity) return { city: byCity.city, region: byCity.region, zone: byCity.zone };
  const byAlias = catalog.find((item) => (item.aliases || []).some((alias) => alias.toLowerCase() === folded));
  if (byAlias) return { city: byAlias.city, region: byAlias.region, zone: byAlias.zone };
  const zones = ABBR_ZONES[folded.replace(/\s+/g, "")];
  if (zones) {
    const matches = catalog.filter((item) => zones.includes(item.zone));
    matches.sort((a, b) => (b.popular === true) - (a.popular === true) || a.city.localeCompare(b.city));
    if (matches[0]) return { city: matches[0].city, region: matches[0].region, zone: matches[0].zone };
  }
  if (zoneOk(token)) {
    const known = catalog.find((item) => item.zone === token);
    return known
      ? { city: known.city, region: known.region, zone: known.zone }
      : { city: zoneLabel(token), region: token, zone: token };
  }
  return null;
}

function parseCityList(catalog, raw) {
  const bits = String(raw || "").split(",");
  const cities = [];
  let index = 0;
  while (index < bits.length && cities.length < 8) {
    const one = bits[index].trim();
    const two = index + 1 < bits.length ? one + ", " + bits[index + 1].trim() : "";
    const pair = two ? parseToken(catalog, two) : null;
    if (pair) {
      cities.push(pair);
      index += 2;
      continue;
    }
    const single = parseToken(catalog, one);
    if (single) cities.push(single);
    index += 1;
  }
  return cities;
}

function parseLooseTime(value) {
  const text = String(value || "").trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (minute > 59 || hour > 24) return null;
  if (match[3] === "pm" && hour < 12) hour += 12;
  if (match[3] === "am" && hour === 12) hour = 0;
  if (match[3] === "am" && hour > 12) return null;
  if (!match[3] && hour === 24) hour = 0;
  if (!match[3] && hour > 23) return null;
  return hour * 60 + minute;
}

function keyOf(city) {
  return city.city + "~" + city.zone;
}

function compareQuery(catalog, params, nowMs) {
  const cities = parseCityList(catalog, params.get("cities") || "");
  if (!cities.length) return null;
  let anchor = cities[0];
  if (params.get("anchor")) {
    const parsed = parseToken(catalog, params.get("anchor"));
    const found = parsed && cities.find((city) => keyOf(city) === keyOf(parsed));
    if (found) anchor = found;
  }
  const at = params.get("at") || "";
  let year;
  let month;
  let day;
  let minutes;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) {
    const date = at.slice(0, 10).split("-").map(Number);
    const time = at.slice(11, 16).split(":").map(Number);
    year = date[0];
    month = date[1];
    day = date[2];
    minutes = Math.max(0, Math.min(1439, time[0] * 60 + time[1]));
  } else {
    const now = partsInZone(nowMs, anchor.zone);
    year = now.year;
    month = now.month;
    day = now.day;
    const loose = parseLooseTime(at);
    minutes = loose == null ? now.hour * 60 + now.minute : loose;
  }
  const instant = civilToInstant(year, month, day, minutes, anchor.zone);
  const anchorParts = partsInZone(instant, anchor.zone);
  const anchorDay = Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day);
  const hour24 = params.get("fmt") === "24";
  let workStart = 9 * 60;
  let workEnd = 17 * 60;
  const workParam = params.get("work") || "";
  const wm = workParam.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (wm) {
    const ws = Number(wm[1]) * 60 + Number(wm[2]);
    const we = Number(wm[3]) * 60 + Number(wm[4]);
    if (we > ws && we <= 1440) { workStart = ws; workEnd = we; }
  }
  const places = cities.map((city) => {
    const parts = partsInZone(instant, city.zone);
    const off = tzOffset(instant, city.zone);
    parts.abbr = friendlyWorkerAbbr(city.zone, parts.abbr, off);
    const delta = Math.round((Date.UTC(parts.year, parts.month - 1, parts.day) - anchorDay) / 86400000);
    const period = classifyPeriod(parts.hour * 60 + parts.minute, workStart, workEnd);
    return { city, parts, delta, period };
  });
  const ordered = [];
  places.forEach((place) => {
    if (keyOf(place.city) === keyOf(anchor)) ordered.push(place);
  });
  places.forEach((place) => {
    if (keyOf(place.city) !== keyOf(anchor)) ordered.push(place);
  });
  const line = ordered.map((place) => {
    const extra = dayText(place.delta);
    return formatTime(place.parts.hour, place.parts.minute, hour24) + " " + place.city.city + (extra ? " " + extra : "");
  }).join(" · ");
  const shown = partsInZone(instant, anchor.zone);
  const dateLabel = shown.weekday.slice(0, 3) + ", " + CARD_MONTHS[shown.month - 1] + " " + shown.day + ", " + shown.year;
  return { line, places, anchor, year: shown.year, month: shown.month, day: shown.day, minutes: shown.hour * 60 + shown.minute, dateLabel, hour24 };
}

function pageUrl(origin, comparison) {
  const params = new URLSearchParams();
  params.set("cities", comparison.places.map((place) => keyOf(place.city)).join(","));
  params.set("anchor", keyOf(comparison.anchor));
  const hh = String(Math.floor(comparison.minutes / 60)).padStart(2, "0");
  const mm = String(comparison.minutes % 60).padStart(2, "0");
  const stamp = comparison.year + "-" + String(comparison.month).padStart(2, "0") + "-" + String(comparison.day).padStart(2, "0");
  params.set("at", stamp + "T" + hh + ":" + mm);
  return origin + "/worldtimeconverter?" + params.toString();
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cardSvg(comparison) {
  const places = (comparison ? comparison.places : []).slice(0, 4);
  const hour24 = !!(comparison && comparison.hour24);
  const dotColor = { work: "#34c759", edge: "#ff9500", night: "#8e8e93" };
  const rows = places.length
    ? places.map((place) => ({
      time: formatTime(place.parts.hour, place.parts.minute, hour24),
      city: place.city.city,
      abbr: place.parts.abbr || "",
      extra: dayText(place.delta),
      dot: dotColor[place.period] || "#34c759"
    }))
    : [{ time: "One day", city: "across cities", abbr: "", extra: "", dot: "#34c759" }];
  const dateText = comparison && comparison.dateLabel ? comparison.dateLabel : "";
  const rowH = 96;
  const block = rows.length * rowH;
  const top = Math.max(176, Math.round((630 - block) / 2) + 34);
  const body = rows.map((row, index) => {
    const y = top + index * rowH;
    const rule = index ? `<line x1="92" y1="${y - 54}" x2="1108" y2="${y - 54}" stroke="#e5e5ea" stroke-width="1"/>` : "";
    return `${rule}
      <circle cx="108" cy="${y - 12}" r="10" fill="${row.dot}"/>
      <text x="142" y="${y}" font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="40" font-weight="600" fill="#1d1d1f">${escapeXml(row.city)}${row.abbr ? `<tspan font-size="22" font-weight="500" fill="#6e6e73">  ${escapeXml(row.abbr)}</tspan>` : ""}${row.extra ? `<tspan font-size="22" font-weight="600" fill="#007aff">  ${escapeXml(row.extra)}</tspan>` : ""}</text>
      <text x="1096" y="${y}" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="42" font-weight="600" fill="#1d1d1f">${escapeXml(row.time)}</text>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f2f2f7"/>
  <text x="64" y="72" font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="24" font-weight="600" fill="#1d1d1f">/. <tspan fill="#6e6e73">World Time Converter</tspan></text>
  ${dateText ? `<text x="1136" y="72" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="22" font-weight="500" fill="#6e6e73">${escapeXml(dateText)}</text>` : ""}
  <rect x="64" y="106" width="1072" height="432" rx="26" fill="#ffffff" stroke="#e5e5ea" stroke-width="1.5"/>
  ${body}
  <circle cx="74" cy="580" r="6" fill="#34c759"/><text x="88" y="587" font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="18" fill="#6e6e73">Workday</text>
  <circle cx="192" cy="580" r="6" fill="#ff9500"/><text x="206" y="587" font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="18" fill="#6e6e73">Early or late</text>
  <circle cx="342" cy="580" r="6" fill="#8e8e93"/><text x="356" y="587" font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="18" fill="#6e6e73">Off hours</text>
  <text x="1136" y="587" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="19" fill="#6e6e73">forwardslashdot.com/worldtimeconverter</text>
</svg>`;
}

function originOf(url) {
  if (url.hostname === "forwardslashdot.com" || url.hostname === "www.forwardslashdot.com") {
    return "https://www.forwardslashdot.com";
  }
  return url.origin;
}

async function loadCatalog(request, env) {
  if (catalogCache) return catalogCache;
  const asset = new URL("/cities.json", request.url);
  const response = await env.ASSETS.fetch(new Request(asset, request));
  if (!response.ok) return [];
  catalogCache = await response.json();
  return catalogCache;
}

function isBrowserDocument(request) {
  const ua = request.headers.get("user-agent") || "";
  if (!ua || MODEL.test(ua) || UNFURL.test(ua) || CRAWLER.test(ua)) return false;
  if (!BROWSER.test(ua)) return false;
  const dest = request.headers.get("sec-fetch-dest") || "";
  const mode = request.headers.get("sec-fetch-mode") || "";
  if (!dest && !mode && !request.headers.get("sec-fetch-site")) return false;
  return dest === "document" || mode === "navigate";
}

async function loadStable(request, env) {
  if (stableCache) return stableCache;
  const catalog = await loadCatalog(request, env);
  const asset = new URL("/timezone-defaults.json", request.url);
  const response = await env.ASSETS.fetch(new Request(asset, request));
  const defaults = response.ok ? await response.json() : {};
  const zoneByCity = new Map();
  catalog.forEach((item) => {
    if (!zoneByCity.has(item.city)) zoneByCity.set(item.city, item.zone);
  });
  const sets = new Map();
  Object.keys(defaults).forEach((zone) => {
    const entry = defaults[zone];
    if (!entry || !entry.city || !Array.isArray(entry.compare)) return;
    const homeZone = zoneByCity.get(entry.city);
    if (!homeZone) return;
    const cities = [{ city: entry.city, zone: homeZone }];
    let complete = true;
    entry.compare.forEach((name) => {
      const cityZone = zoneByCity.get(name);
      if (!cityZone) complete = false;
      else cities.push({ city: name, zone: cityZone });
    });
    if (!complete) return;
    const key = cities.map(keyOf).join(",");
    if (!sets.has(key)) sets.set(key, cities);
  });
  stableCache = sets;
  return sets;
}

function stableUrl(origin, cities) {
  const params = new URLSearchParams();
  params.set("cities", cities.map(keyOf).join(","));
  params.set("anchor", keyOf(cities[0]));
  return origin + "/worldtimeconverter?" + params.toString();
}

function indexPolicy(origin, cities, params, sets) {
  const bare = origin + "/worldtimeconverter";
  if (params.get("cities") && !cities.length) return { canonical: bare, index: false };
  if (!cities.length) return { canonical: bare, index: true };
  const found = sets.get(cities.map(keyOf).join(","));
  const variant = ["at", "work", "dur", "fmt", "embed", "card", "format"].some((name) => params.get(name));
  const anchor = params.get("anchor");
  const anchorMoved = !!(found && anchor && anchor !== keyOf(found[0]));
  if (found && !variant && !anchorMoved) return { canonical: stableUrl(origin, found), index: true };
  if (found) return { canonical: stableUrl(origin, found), index: false };
  return { canonical: bare, index: false };
}

function applyIndexMeta(html, policy) {
  let next = html.replace(/rel="canonical" href="[^"]*"/, 'rel="canonical" href="' + escapeXml(policy.canonical) + '"');
  if (policy.index) return next.replace(/\n?\s*<meta name="robots" content="noindex">/, "");
  if (next.includes('name="robots"')) {
    return next.replace(/name="robots" content="[^"]*"/, 'name="robots" content="noindex"');
  }
  return next.replace("</title>", "</title>\n  <meta name=\"robots\" content=\"noindex\">");
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "vary": "sec-fetch-dest, sec-fetch-mode, user-agent"
    }
  });
}

function searchCopy(comparison) {
  const anchorPlace = comparison.places.find((place) => keyOf(place.city) === keyOf(comparison.anchor)) || comparison.places[0];
  const time = formatTime(anchorPlace.parts.hour, anchorPlace.parts.minute, comparison.hour24);
  const title = "What time is " + time + " in " + comparison.anchor.city + "?";
  const others = comparison.places.filter((place) => keyOf(place.city) !== keyOf(comparison.anchor)).map((place) => {
    const extra = dayText(place.delta);
    return formatTime(place.parts.hour, place.parts.minute, comparison.hour24) + (extra ? " " + extra : "") + " in " + place.city.city;
  });
  let description = time + " in " + comparison.anchor.city + ".";
  if (others.length === 1) description = time + " in " + comparison.anchor.city + " is " + others[0] + ".";
  else if (others.length > 1) description = time + " in " + comparison.anchor.city + " is " + others.slice(0, -1).join(", ") + " and " + others[others.length - 1] + ".";
  return { title, description, answer: answerLine(comparison) };
}

function answerLine(comparison) {
  return comparison.places.filter((place) => keyOf(place.city) !== keyOf(comparison.anchor)).map((place) => {
    const extra = place.delta === 0 ? "" : dayText(place.delta) + " ";
    return formatTime(place.parts.hour, place.parts.minute, comparison.hour24) + " " + extra + "in " + place.city.city;
  }).join(" · ");
}

function injectPreview(html, title, description, image, share) {
  let next = html;
  next = next.replace(/<title>[^<]*<\/title>/, "<title>" + escapeXml(title) + "</title>");
  next = next.replace(/name="description" content="[^"]*"/, 'name="description" content="' + escapeXml(description) + '"');
  next = next.replace(/property="og:title" content="[^"]*"/, 'property="og:title" content="' + escapeXml(title) + '"');
  next = next.replace(/property="og:description" content="[^"]*"/, 'property="og:description" content="' + escapeXml(description) + '"');
  next = next.replace(/property="og:image" content="[^"]*"/, 'property="og:image" content="' + escapeXml(image) + '"');
  next = next.replace(/property="og:url" content="[^"]*"/, 'property="og:url" content="' + escapeXml(share) + '"');
  next = next.replace(/name="twitter:title" content="[^"]*"/, 'name="twitter:title" content="' + escapeXml(title) + '"');
  next = next.replace(/name="twitter:description" content="[^"]*"/, 'name="twitter:description" content="' + escapeXml(description) + '"');
  next = next.replace(/name="twitter:image" content="[^"]*"/, 'name="twitter:image" content="' + escapeXml(image) + '"');
  return next;
}

function injectBody(html, title, answer) {
  let next = html.replace(/<h1 class="ask" id="ask">[^<]*<\/h1>/, '<h1 class="ask" id="ask">' + escapeXml(title) + "</h1>");
  if (answer) {
    next = next.replace(/<p class="answer" id="answer"><\/p>/, '<p class="answer" id="answer">' + escapeXml(answer) + "</p>");
  }
  return next;
}

function publicUrl(origin, url) {
  const params = new URLSearchParams(url.searchParams);
  ["format", "embed", "card"].forEach((name) => params.delete(name));
  const query = params.toString();
  return origin + "/worldtimeconverter" + (query ? "?" + query : "");
}

const FONT = {
  "A": [14, 17, 17, 31, 17, 17, 17], "B": [30, 17, 17, 30, 17, 17, 30], "C": [14, 17, 16, 16, 16, 17, 14],
  "D": [30, 17, 17, 17, 17, 17, 30], "E": [31, 16, 16, 30, 16, 16, 31], "F": [31, 16, 16, 30, 16, 16, 16],
  "G": [14, 17, 16, 23, 17, 17, 14], "H": [17, 17, 17, 31, 17, 17, 17], "I": [14, 4, 4, 4, 4, 4, 14],
  "J": [7, 2, 2, 2, 2, 18, 12], "K": [17, 18, 20, 24, 20, 18, 17], "L": [16, 16, 16, 16, 16, 16, 31],
  "M": [17, 27, 21, 21, 17, 17, 17], "N": [17, 25, 21, 19, 17, 17, 17], "O": [14, 17, 17, 17, 17, 17, 14],
  "P": [30, 17, 17, 30, 16, 16, 16], "Q": [14, 17, 17, 17, 21, 18, 13], "R": [30, 17, 17, 30, 20, 18, 17],
  "S": [15, 16, 16, 14, 1, 1, 30], "T": [31, 4, 4, 4, 4, 4, 4], "U": [17, 17, 17, 17, 17, 17, 14],
  "V": [17, 17, 17, 17, 17, 10, 4], "W": [17, 17, 17, 21, 21, 21, 10], "X": [17, 17, 10, 4, 10, 17, 17],
  "Y": [17, 17, 10, 4, 4, 4, 4], "Z": [31, 1, 2, 4, 8, 16, 31],
  "a": [0, 0, 14, 1, 15, 17, 15], "b": [16, 16, 30, 17, 17, 17, 30], "c": [0, 0, 14, 16, 16, 17, 14],
  "d": [1, 1, 15, 17, 17, 17, 15], "e": [0, 0, 14, 17, 31, 16, 14], "f": [6, 8, 8, 28, 8, 8, 8],
  "g": [0, 0, 15, 17, 15, 1, 14], "h": [16, 16, 30, 17, 17, 17, 17], "i": [4, 0, 12, 4, 4, 4, 14],
  "j": [2, 0, 6, 2, 2, 18, 12], "k": [16, 16, 18, 20, 24, 20, 18], "l": [4, 4, 4, 4, 4, 4, 14],
  "m": [0, 0, 26, 21, 21, 21, 21], "n": [0, 0, 30, 17, 17, 17, 17], "o": [0, 0, 14, 17, 17, 17, 14],
  "p": [0, 0, 30, 17, 30, 16, 16], "q": [0, 0, 15, 17, 15, 1, 1], "r": [0, 0, 22, 24, 16, 16, 16],
  "s": [0, 0, 15, 16, 14, 1, 30], "t": [8, 8, 28, 8, 8, 9, 6], "u": [0, 0, 17, 17, 17, 17, 15],
  "v": [0, 0, 17, 17, 17, 10, 4], "w": [0, 0, 17, 17, 21, 21, 10], "x": [0, 0, 17, 10, 4, 10, 17],
  "y": [0, 0, 17, 17, 15, 1, 14], "z": [0, 0, 31, 2, 4, 8, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 1, 14],
  "/": [1, 2, 2, 4, 8, 8, 16], ".": [0, 0, 0, 0, 0, 12, 12], ":": [0, 12, 12, 0, 12, 12, 0],
  "-": [0, 0, 0, 31, 0, 0, 0], "+": [0, 4, 4, 31, 4, 4, 0], "'": [4, 4, 8, 0, 0, 0, 0], ",": [0, 0, 0, 0, 0, 4, 8]
};

function fillRect(buf, width, height, x, y, rw, rh, color) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + rw);
  const y1 = Math.min(height, y + rh);
  for (let py = y0; py < y1; py++) {
    let index = (py * width + x0) * 4;
    for (let px = x0; px < x1; px++) {
      buf[index] = color[0];
      buf[index + 1] = color[1];
      buf[index + 2] = color[2];
      buf[index + 3] = 255;
      index += 4;
    }
  }
}

function blendPixel(buf, width, height, px, py, color, alpha) {
  if (px < 0 || py < 0 || px >= width || py >= height || alpha <= 0) return;
  const i = (py * width + px) * 4;
  const a = Math.min(1, alpha);
  const inv = 1 - a;
  buf[i] = Math.round(buf[i] * inv + color[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * inv + color[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * inv + color[2] * a);
  buf[i + 3] = 255;
}

function fillCircle(buf, width, height, cx, cy, radius, color) {
  const pad = Math.ceil(radius) + 1;
  for (let py = Math.floor(cy - pad); py <= Math.ceil(cy + pad); py++) {
    for (let px = Math.floor(cx - pad); px <= Math.ceil(cx + pad); px++) {
      const dist = Math.hypot(px - cx, py - cy);
      if (dist <= radius - 0.5) fillRect(buf, width, height, px, py, 1, 1, color);
      else if (dist < radius + 0.5) blendPixel(buf, width, height, px, py, color, radius + 0.5 - dist);
    }
  }
}

function fillRoundRect(buf, width, height, x, y, rw, rh, r, color) {
  fillRect(buf, width, height, x + r, y, rw - 2 * r, rh, color);
  fillRect(buf, width, height, x, y + r, rw, rh - 2 * r, color);
  fillCircle(buf, width, height, x + r, y + r, r, color);
  fillCircle(buf, width, height, x + rw - r - 1, y + r, r, color);
  fillCircle(buf, width, height, x + r, y + rh - r - 1, r, color);
  fillCircle(buf, width, height, x + rw - r - 1, y + rh - r - 1, r, color);
}

function measureTextWidth(text, scale) {
  let cursor = 0;
  const folded = String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const ch of folded) {
    if (ch === " ") cursor += 3 * scale;
    else if (!FONT[ch]) cursor += 4 * scale;
    else cursor += 6 * scale;
  }
  return Math.max(0, cursor - scale);
}

function drawText(buf, width, height, x, y, text, scale, color) {
  let cursor = x;
  const folded = String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const r = Math.max(1, Math.floor(scale * 0.35));
  for (const ch of folded) {
    if (ch === " ") {
      cursor += 3 * scale;
      continue;
    }
    const rows = FONT[ch];
    if (!rows) {
      cursor += 4 * scale;
      continue;
    }
    for (let row = 0; row < rows.length; row++) {
      const bits = rows[row];
      for (let col = 0; col < 5; col++) {
        if (((bits >> (4 - col)) & 1) === 0) continue;
        const px = cursor + col * scale;
        const py = y + row * scale;
        fillRect(buf, width, height, px, py, scale, scale, color);
        if (scale >= 4) {
          blendPixel(buf, width, height, px - 1, py, color, 0.25);
          blendPixel(buf, width, height, px + scale, py, color, 0.25);
          blendPixel(buf, width, height, px, py + scale, color, 0.25);
        }
      }
    }
    cursor += 6 * scale;
  }
}

const PNG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = PNG_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = new TextEncoder().encode(type);
  const body = new Uint8Array(name.length + data.length);
  body.set(name, 0);
  body.set(data, name.length);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, pngCrc(body));
  return out;
}

async function cardPng(comparison) {
  const width = 1200;
  const height = 630;
  const bg = [242, 242, 247];
  const card = [255, 255, 255];
  const border = [224, 224, 230];
  const ink = [29, 29, 31];
  const soft = [110, 110, 115];
  const blue = [0, 122, 255];
  const dots = { work: [52, 199, 89], edge: [255, 149, 0], night: [142, 142, 147] };
  const buf = new Uint8Array(width * height * 4);
  fillRect(buf, width, height, 0, 0, width, height, bg);
  drawText(buf, width, height, 64, 46, "/. World Time Converter", 3, ink);
  if (comparison && comparison.dateLabel) {
    const dw = measureTextWidth(comparison.dateLabel, 3);
    drawText(buf, width, height, width - 64 - dw, 46, comparison.dateLabel, 3, soft);
  }
  fillRoundRect(buf, width, height, 62, 102, 1076, 436, 26, border);
  fillRoundRect(buf, width, height, 64, 104, 1072, 432, 24, card);
  const places = (comparison ? comparison.places : []).slice(0, 4);
  const hour24 = !!(comparison && comparison.hour24);
  const rows = places.length
    ? places.map((place) => ({
      time: formatTime(place.parts.hour, place.parts.minute, hour24),
      city: place.city.city,
      abbr: place.parts.abbr || "",
      extra: dayText(place.delta),
      dot: dots[place.period] || dots.work
    }))
    : [{ time: "One day", city: "across cities", abbr: "", extra: "", dot: dots.work }];
  const rowH = 96;
  const block = rows.length * rowH;
  const top = Math.max(138, Math.round(104 + (432 - block) / 2) + 26);
  rows.forEach((row, index) => {
    const y = top + index * rowH;
    if (index > 0) fillRect(buf, width, height, 96, y - 34, 1008, 1, border);
    fillCircle(buf, width, height, 110, y + 18, 11, row.dot);
    drawText(buf, width, height, 144, y, row.city, 5, ink);
    const cityW = measureTextWidth(row.city, 5);
    let subX = 144 + cityW + 18;
    if (row.abbr) {
      drawText(buf, width, height, subX, y + 10, row.abbr, 3, soft);
      subX += measureTextWidth(row.abbr, 3) + 16;
    }
    if (row.extra) {
      drawText(buf, width, height, subX, y + 10, row.extra, 3, blue);
    }
    const tw = measureTextWidth(row.time, 5);
    drawText(buf, width, height, 1096 - tw, y, row.time, 5, ink);
  });
  fillCircle(buf, width, height, 72, 578, 7, dots.work);
  drawText(buf, width, height, 88, 570, "Workday", 2, soft);
  fillCircle(buf, width, height, 200, 578, 7, dots.edge);
  drawText(buf, width, height, 216, 570, "Early/late", 2, soft);
  fillCircle(buf, width, height, 360, 578, 7, dots.night);
  drawText(buf, width, height, 376, 570, "Off hours", 2, soft);
  const foot = "forwardslashdot.com/worldtimeconverter";
  drawText(buf, width, height, width - 64 - measureTextWidth(foot, 2), 570, foot, 2, soft);
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 4 + 1);
    raw[start] = 0;
    raw.set(buf.subarray(y * width * 4, (y + 1) * width * 4), start + 1);
  }
  const zipped = new Uint8Array(await new Response(new Response(raw).body.pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", zipped), pngChunk("IEND", new Uint8Array())];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    png.set(part, offset);
    offset += part.length;
  });
  return png;
}

async function handleTime(request, env, url, path) {
  const origin = originOf(url);
  if (path === "/time") {
    const target = new URL(origin + "/worldtimeconverter");
    url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
    return Response.redirect(target.toString(), 302);
  }

  const wantsText = path === "/time.txt" || url.searchParams.get("format") === "txt";
  const wantsSvg = path === "/time.svg";
  const wantsPng = path === "/time.png";
  const browser = isBrowserDocument(request);
  let comparison = null;
  if (wantsText || wantsSvg || wantsPng || !browser) {
    const catalog = await loadCatalog(request, env);
    comparison = compareQuery(catalog, url.searchParams, Date.now());
  }
  if (wantsText) {
    const body = comparison
      ? comparison.line + "\n" + pageUrl(origin, comparison) + "\n"
      : "Name the cities.\n" + origin + "/worldtimeconverter?cities=London,Tokyo&at=9am\n";
    return new Response(body, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" }
    });
  }
  if (wantsSvg) {
    return new Response(cardSvg(comparison), {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" }
    });
  }
  if (wantsPng) {
    return new Response(await cardPng(comparison), {
      headers: { "content-type": "image/png", "cache-control": "public, max-age=300" }
    });
  }

  const asset = new URL("/worldtimeconverter/", request.url);
  let response = await env.ASSETS.fetch(new Request(asset, { headers: request.headers }));
  if ((response.status === 307 || response.status === 308) && response.headers.get("location")) {
    const nextAsset = new URL(response.headers.get("location"), request.url);
    response = await env.ASSETS.fetch(new Request(nextAsset, { headers: request.headers }));
  }
  if (!response.ok) return response;
  const queried = ["cities", "anchor", "at", "work", "dur", "embed", "card", "format"].some((name) => url.searchParams.has(name));
  if (browser && !queried) return response;

  const catalog = await loadCatalog(request, env);
  const sets = await loadStable(request, env);
  const cities = parseCityList(catalog, url.searchParams.get("cities") || "");
  const policy = indexPolicy(origin, cities, url.searchParams, sets);
  let html = await response.text();
  if (!browser && comparison) {
    const search = searchCopy(comparison);
    const image = origin + "/time.png" + (url.search || "");
    html = injectPreview(html, search.title, search.description, image, publicUrl(origin, url));
    html = injectBody(html, search.title, search.answer);
  }
  return htmlResponse(applyIndexMeta(html, policy));
}

const STATS_COOKIE = "fwd_stats";
const STATS_MESSAGE = "fwd-stats-v1";

async function statsSignature(password) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(STATS_MESSAGE));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookieValue(header, name) {
  const parts = String(header || "").split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + "=")) return trimmed.slice(name.length + 1);
  }
  return "";
}

function sameSecret(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function statsPage(wrong) {
  const message = wrong
    ? "<p class=\"err\">Wrong password.</p>"
    : "<p class=\"lede\">Aggregates for this site. Enter the password to continue.</p>";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Stats — forwardslashdot</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f7; color: #1d1d1f; font-family: "SF Pro Display", "Helvetica Neue", Helvetica, sans-serif; }
    form { width: min(22rem, calc(100% - 2rem)); }
    h1 { font-size: 1.6rem; letter-spacing: -0.03em; margin: 0 0 0.4rem; }
    .lede, .err { color: #6e6e73; font-size: 0.95rem; line-height: 1.4; margin: 0 0 1rem; }
    .err { color: #c41e3a; }
    input { width: 100%; font: inherit; font-size: 1rem; padding: 0.75rem 0.85rem; border-radius: 0.7rem; border: 1px solid rgba(29,29,31,0.16); background: #fff; }
    button { margin-top: 0.75rem; font: inherit; font-weight: 600; border: 0; border-radius: 0.7rem; background: #1d1d1f; color: #fff; padding: 0.75rem 1rem; cursor: pointer; }
    a { color: #6e6e73; font-size: 0.85rem; }
  </style>
</head>
<body>
  <form method="post" action="/stats/login">
    <h1>Stats</h1>
    ${message}
    <input type="password" name="password" autocomplete="current-password" autofocus required />
    <button type="submit">Continue</button>
    <p><a href="/">← forwardslashdot</a></p>
  </form>
</body>
</html>`;
  return new Response(html, {
    status: wrong ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex"
    }
  });
}

async function statsUnlocked(request, password) {
  if (!password) return false;
  const expected = await statsSignature(password);
  const got = cookieValue(request.headers.get("cookie"), STATS_COOKIE);
  return sameSecret(got, expected);
}

function statsCookie(value) {
  return STATS_COOKIE + "=" + value + "; HttpOnly; Secure; SameSite=Lax; Path=/stats; Max-Age=1209600";
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const password = (env.STATS_PASSWORD || "").trim();
  if (!password) {
    return new Response("Stats is locked.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }

  if (request.method === "POST" && path === "/stats/login") {
    const form = await request.formData();
    const given = String(form.get("password") || "");
    if (!sameSecret(given, password)) return statsPage(true);
    const token = await statsSignature(password);
    return new Response(null, {
      status: 303,
      headers: { location: "/stats/", "set-cookie": statsCookie(token), "cache-control": "no-store" }
    });
  }

  if (request.method === "GET" && path === "/stats/logout") {
    return new Response(null, {
      status: 303,
      headers: {
        location: "/stats/",
        "set-cookie": STATS_COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=/stats; Max-Age=0",
        "cache-control": "no-store"
      }
    });
  }

  const unlocked = await statsUnlocked(request, password);
  if (request.method === "GET" && path === "/stats/data") {
    if (!unlocked) return new Response(JSON.stringify({ detail: "Stats password required" }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
    const upstream = await fetch("https://api.forwardslashdot.com/stats", {
      headers: { authorization: "Bearer " + password, accept: "application/json" },
      cf: { cacheTtl: 0 }
    });
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  if (!unlocked) return statsPage(false);

  const asset = await env.ASSETS.fetch(request);
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex");
  return new Response(asset.body, { status: asset.status, headers });
}

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const DOMAIN_AREAS = new Set(["instant_domain_search", "world_time_converter", "other"]);
const EDGE_CACHE_SECONDS = 120;

function hasDnsAnswer(msg) {
  return !!(msg && Array.isArray(msg.Answer) && msg.Answer.length);
}

// NS NXDOMAIN means the TLD has no such name. An NS answer means it is delegated.
// Anything else is inconclusive and the origin RDAP check should decide.
export function statusFromDns(ns, soa) {
  if (!ns || typeof ns.Status !== "number") return null;
  if (ns.Status === 3) return "available";
  if (ns.Status === 0 && hasDnsAnswer(ns)) return "registered";
  if (ns.Status !== 0) return null;
  if (!soa || typeof soa.Status !== "number") return null;
  if (soa.Status === 3) return "available";
  if (soa.Status === 0 && hasDnsAnswer(soa)) return "registered";
  return null;
}

function domainArea(raw) {
  const area = String(raw || "").trim();
  return DOMAIN_AREAS.has(area) ? area : "instant_domain_search";
}

async function dnsQuery(name, type) {
  const res = await fetch(
    "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(name) + "&type=" + type,
    { headers: { accept: "application/dns-json" } }
  );
  if (!res.ok) return null;
  return res.json();
}

async function edgeStatus(domain) {
  const ns = await dnsQuery(domain, "NS");
  if (ns && ns.Status === 3) return "available";
  if (ns && ns.Status === 0 && hasDnsAnswer(ns)) return "registered";
  const soa = ns && ns.Status === 0 ? await dnsQuery(domain, "SOA") : null;
  return statusFromDns(ns, soa);
}

function affiliateFields(env, domain, status) {
  if (status !== "available") return {};
  const base = String((env && env.AFFILIATE_BASE_URL) || "").trim();
  const param = String((env && env.AFFILIATE_PARAM_NAME) || "").trim();
  const id = String((env && env.AFFILIATE_ID) || "").trim();
  if (!base || !param || !id) return {};
  const query = new URLSearchParams({ domain: domain });
  query.set(param, id);
  const joiner = base.endsWith("?") || base.endsWith("&") ? "" : (base.includes("?") ? "&" : "?");
  return {
    affiliate_url: base + joiner + query.toString(),
    link_type: "affiliate",
    disclosure: "Affiliate disclosure: forwardslashdot.com may earn a commission if you register a domain through this link."
  };
}

function domainResponse(body, cacheSeconds) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheSeconds ? "public, max-age=15, s-maxage=" + cacheSeconds : "no-store",
      "x-domain-edge": "1"
    }
  });
}

function domainCacheKey(origin, domain) {
  return new Request(origin + "/api/domain?q=" + encodeURIComponent(domain), { method: "GET" });
}

function tallyDomain(ctx, domain, area, country) {
  let target = API_ORIGIN + "/api/domain?q=" + encodeURIComponent(domain) + "&area=" + encodeURIComponent(area);
  if (country) target += "&country=" + encodeURIComponent(country);
  const task = fetch(target, { cf: { cacheTtl: 0 } }).catch(function () {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(task);
}

async function proxyDomain(url) {
  const upstream = await fetch(API_ORIGIN + "/api/domain?" + url.searchParams.toString(), {
    cf: { cacheTtl: 0 }
  });
  const headers = new Headers(upstream.headers);
  headers.set("x-domain-edge", "origin");
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function handleDomain(request, env, ctx) {
  const url = new URL(request.url);
  const country = visitorCountry(request, url);
  if (country && !url.searchParams.get("country")) url.searchParams.set("country", country);
  const raw = (url.searchParams.get("q") || "").trim().toLowerCase();
  if (!raw || raw.includes(",")) return proxyDomain(url);
  if (!DOMAIN_RE.test(raw)) {
    return domainResponse({
      count: 1,
      results: [{ domain: raw, status: "invalid", source: null, cached: false }],
      batch_cap: 25,
      timing_ms: 0
    }, 0);
  }

  const started = Date.now();
  const area = domainArea(url.searchParams.get("area") || url.searchParams.get("source"));
  const warm = url.searchParams.get("warm") === "1";
  let cache = null;
  try { cache = caches.default; } catch (_) { cache = null; }
  const key = domainCacheKey(url.origin, raw);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const data = await hit.json();
        if (data.results && data.results[0]) data.results[0].cached = true;
        data.timing_ms = 0;
        if (!warm) tallyDomain(ctx, raw, area, country);
        return domainResponse(data, EDGE_CACHE_SECONDS);
      }
    } catch (_) {}
  }

  let status = null;
  try {
    status = await edgeStatus(raw);
  } catch (_) {
    status = null;
  }
  if (status !== "available" && status !== "registered") return proxyDomain(url);

  const body = {
    count: 1,
    results: [Object.assign({
      domain: raw,
      status: status,
      source: "dns",
      cached: false
    }, affiliateFields(env, raw, status))],
    batch_cap: 25,
    timing_ms: Date.now() - started
  };
  const response = domainResponse(body, EDGE_CACHE_SECONDS);
  if (cache && ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(key, response.clone()).catch(function () {}));
  }
  if (!warm) tallyDomain(ctx, raw, area, country);
  return response;
}

async function handleEndings(request, url, ctx) {
  const country = visitorCountry(request, url);
  const seed = seededRow(country);
  let cache = null;
  try { cache = caches.default; } catch (_) { cache = null; }
  const cacheKey = new Request(url.origin + "/api/endings?country=" + encodeURIComponent(country || "XX"), { method: "GET" });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (_) {}
  }
  let body = { country: country || "XX", endings: seed, source: "seed" };
  try {
    const upstream = await fetch(
      API_ORIGIN + "/api/endings?country=" + encodeURIComponent(country || "XX"),
      { cf: { cacheTtl: 0 } }
    );
    if (upstream.ok) {
      const data = await upstream.json();
      if (data && Array.isArray(data.endings) && data.endings.length) body = data;
    }
  } catch (_) {}
  const response = new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60"
    }
  });
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(function () {}));
  return response;
}

async function handleTlds(url, ctx) {
  let cache = null;
  try { cache = caches.default; } catch (_) { cache = null; }
  const cacheKey = new Request(url.origin + "/api/tlds", { method: "GET" });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (_) {}
  }
  let data = null;
  try {
    const upstream = await fetch(API_ORIGIN + "/api/tlds", { cf: { cacheTtl: 0 } });
    if (upstream.ok) data = await upstream.json();
  } catch (_) {}
  if (!data || !Array.isArray(data.endings) || data.endings.length < 100) {
    return new Response(JSON.stringify({ count: 0, endings: [], source: "namecheap" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  }
  const response = new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600"
    }
  });
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(function () {}));
  return response;
}

async function personalizedSearch(request, env, url) {
  const asset = await env.ASSETS.fetch(request);
  if (!asset.ok || !asset.headers.get("content-type") || asset.headers.get("content-type").indexOf("text/html") === -1) {
    return asset;
  }
  const endings = seededRow(visitorCountry(request, url));
  let html = await asset.text();
  html = html.replace(
    'var TLDS = [".com", ".net", ".org", ".io", ".co", ".ai"];',
    "var TLDS = " + JSON.stringify(endings) + ";"
  );
  const headers = new Headers(asset.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "private, no-store");
  return new Response(html, { status: asset.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;

    if (request.method === "GET" && path === "/api/domain") {
      return handleDomain(request, env, ctx);
    }

    if (request.method === "GET" && path === "/api/endings") {
      return handleEndings(request, url, ctx);
    }

    if (request.method === "GET" && path === "/api/tlds") {
      return handleTlds(url, ctx);
    }

    if (path === "/stats" || path.startsWith("/stats/")) {
      return handleStats(request, env);
    }

    if (request.method === "GET" && DISCOVERY[path]) {
      return Response.redirect(DISCOVERY[path], 302);
    }

    try {
      if (path === "/worldtimeconverter" || path === "/time" || path === "/time.txt" || path === "/time.svg" || path === "/time.png") {
        const area = areaFor(path);
        if (area) {
          const task = noteModel(request, area);
          if (ctx && ctx.waitUntil) ctx.waitUntil(task);
          else await task;
        }
        return await handleTime(request, env, url, path);
      }
    } catch (err) {
      /* Fall through to static assets if the preview cannot be built. */
    }

    const area = areaFor(path);
    if (request.method === "GET" && area) {
      const task = noteModel(request, area);
      if (ctx && ctx.waitUntil) ctx.waitUntil(task);
      else await task;
    }
    if (request.method === "GET" && path === "/instantdomainsearch") {
      return personalizedSearch(request, env, url);
    }
    return env.ASSETS.fetch(request);
  }
};
