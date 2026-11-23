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
  AU: [".au", ".com.au", ".com", ".net", ".io", ".org"],
  GB: [".uk", ".co.uk", ".com", ".org", ".io", ".ai"],
  DE: [".de", ".com", ".net", ".org", ".eu", ".io"],
  FR: [".fr", ".com", ".eu", ".net", ".org", ".io"],
  NL: [".nl", ".com", ".eu", ".net", ".org", ".io"],
  ES: [".es", ".com", ".net", ".org", ".eu", ".io"],
  IT: [".it", ".com", ".net", ".org", ".eu", ".io"],
  MX: [".mx", ".com.mx", ".com", ".net", ".org", ".io"],
  IN: [".in", ".co.in", ".com", ".net", ".org", ".io"],
  SG: [".sg", ".com.sg", ".com", ".net", ".org", ".io"],
  NZ: [".nz", ".co.nz", ".com", ".net", ".org", ".io"],
  IE: [".ie", ".com", ".net", ".org", ".eu", ".io"],
  SE: [".se", ".com", ".net", ".org", ".eu", ".io"],
  NO: [".no", ".com", ".net", ".org", ".eu", ".io"],
  DK: [".dk", ".com", ".net", ".org", ".eu", ".io"],
  FI: [".fi", ".com", ".net", ".org", ".eu", ".io"],
  CH: [".ch", ".com", ".net", ".org", ".io", ".ai"],
  AT: [".at", ".com", ".net", ".org", ".eu", ".io"],
  BE: [".be", ".com", ".net", ".org", ".eu", ".io"],
  PL: [".pl", ".com", ".net", ".org", ".eu", ".io"],
  PT: [".pt", ".com", ".net", ".org", ".eu", ".io"],
  BR: [".br", ".com.br", ".com", ".net", ".org", ".io"],
  JP: [".jp", ".com", ".net", ".org", ".io", ".ai"],
  KR: [".kr", ".com", ".net", ".org", ".io", ".ai"],
  CN: [".cn", ".com", ".net", ".org", ".io", ".ai"],
  HK: [".hk", ".com", ".net", ".org", ".io", ".ai"],
  TW: [".tw", ".com", ".net", ".org", ".io", ".ai"],
  ID: [".id", ".com", ".net", ".org", ".io", ".ai"],
  PH: [".ph", ".com.ph", ".com", ".net", ".org", ".io"],
  MY: [".my", ".com", ".net", ".org", ".io", ".ai"],
  ZA: [".co.za", ".com", ".net", ".org", ".io", ".ai"],
  AE: [".ae", ".com", ".net", ".org", ".io", ".ai"],
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

function formatTime(hour, minute) {
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 || 12;
  const m = String(minute).padStart(2, "0");
  return h + ":" + m + " " + suffix;
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
  const places = cities.map((city) => {
    const parts = partsInZone(instant, city.zone);
    const delta = Math.round((Date.UTC(parts.year, parts.month - 1, parts.day) - anchorDay) / 86400000);
    return { city, parts, delta };
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
    return formatTime(place.parts.hour, place.parts.minute) + " " + place.city.city + (extra ? " " + extra : "");
  }).join(" · ");
  const shown = partsInZone(instant, anchor.zone);
  return { line, places, anchor, year: shown.year, month: shown.month, day: shown.day, minutes: shown.hour * 60 + shown.minute };
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
  const rows = places.length
    ? places.map((place) => ({
      time: formatTime(place.parts.hour, place.parts.minute),
      city: place.city.city,
      extra: dayText(place.delta)
    }))
    : [{ time: "One day", city: "across cities", extra: "" }];
  const block = rows.length * 108;
  const top = Math.max(150, (630 - block) / 2 + 36);
  const body = rows.map((row, index) => {
    const y = top + index * 108;
    return `<circle cx="92" cy="${y - 8}" r="16" fill="#5c97b4"/>
      <circle cx="86" cy="${y - 12}" r="7" fill="#f3eadc"/>
      <text x="128" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="42" font-weight="600" fill="#1c1917">${escapeXml(row.time)}</text>
      <text x="390" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="42" font-weight="600" fill="#1c1917">${escapeXml(row.city)}${row.extra ? `<tspan font-size="26" font-weight="560" fill="#c47b62">  ${escapeXml(row.extra)}</tspan>` : ""}</text>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f7f1e8"/>
  <text x="72" y="78" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="600" fill="#7c736a">/. World Time Converter</text>
  ${body}
  <text x="72" y="584" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#7c736a">forwardslashdot.com/worldtimeconverter</text>
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

function searchCopy(comparison) {
  const anchorPlace = comparison.places.find((place) => keyOf(place.city) === keyOf(comparison.anchor)) || comparison.places[0];
  const time = formatTime(anchorPlace.parts.hour, anchorPlace.parts.minute);
  const title = "What time is " + time + " in " + comparison.anchor.city + "?";
  const others = comparison.places.filter((place) => keyOf(place.city) !== keyOf(comparison.anchor)).map((place) => {
    const extra = dayText(place.delta);
    return formatTime(place.parts.hour, place.parts.minute) + (extra ? " " + extra : "") + " in " + place.city.city;
  });
  let description = time + " in " + comparison.anchor.city + ".";
  if (others.length === 1) description = time + " in " + comparison.anchor.city + " is " + others[0] + ".";
  else if (others.length > 1) description = time + " in " + comparison.anchor.city + " is " + others.slice(0, -1).join(", ") + " and " + others[others.length - 1] + ".";
  return { title, description };
}

function injectPreview(html, title, description, image, canonical) {
  let next = html;
  next = next.replace(/<title>[^<]*<\/title>/, "<title>" + escapeXml(title) + "</title>");
  next = next.replace(/name="description" content="[^"]*"/, 'name="description" content="' + escapeXml(description) + '"');
  next = next.replace(/property="og:title" content="[^"]*"/, 'property="og:title" content="' + escapeXml(title) + '"');
  next = next.replace(/property="og:description" content="[^"]*"/, 'property="og:description" content="' + escapeXml(description) + '"');
  next = next.replace(/property="og:image" content="[^"]*"/, 'property="og:image" content="' + escapeXml(image) + '"');
  next = next.replace(/property="og:url" content="[^"]*"/, 'property="og:url" content="' + escapeXml(canonical) + '"');
  next = next.replace(/rel="canonical" href="[^"]*"/, 'rel="canonical" href="' + escapeXml(canonical) + '"');
  next = next.replace(/name="twitter:title" content="[^"]*"/, 'name="twitter:title" content="' + escapeXml(title) + '"');
  next = next.replace(/name="twitter:description" content="[^"]*"/, 'name="twitter:description" content="' + escapeXml(description) + '"');
  next = next.replace(/name="twitter:image" content="[^"]*"/, 'name="twitter:image" content="' + escapeXml(image) + '"');
  return next;
}

async function handleTime(request, env, url, path) {
  const catalog = await loadCatalog(request, env);
  const comparison = compareQuery(catalog, url.searchParams, Date.now());
  const origin = originOf(url);
  const wantsText = path === "/time.txt" || url.searchParams.get("format") === "txt";
  if (wantsText) {
    const body = comparison
      ? comparison.line + "\n" + pageUrl(origin, comparison) + "\n"
      : "Name the cities.\n" + origin + "/worldtimeconverter?cities=London,Tokyo&at=9am\n";
    return new Response(body, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" }
    });
  }
  if (path === "/time.svg") {
    return new Response(cardSvg(comparison), {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" }
    });
  }
  if (path === "/time") {
    const target = new URL(origin + "/worldtimeconverter");
    url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
    return Response.redirect(target.toString(), 302);
  }
  const asset = new URL("/worldtimeconverter/index.html", request.url);
  const response = await env.ASSETS.fetch(new Request(asset, { headers: request.headers }));
  if (!comparison) return response;
  const search = searchCopy(comparison);
  const canonical = pageUrl(origin, comparison);
  const html = injectPreview(
    await response.text(),
    search.title,
    search.description,
    origin + "/time.svg?" + url.searchParams.toString(),
    canonical
  );
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" }
  });
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
  html = html.replace(
    '<span id="tld-suffix-label">.com</span>',
    '<span id="tld-suffix-label">' + endings[0] + "</span>"
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

    if (path === "/stats" || path.startsWith("/stats/")) {
      return handleStats(request, env);
    }

    if (request.method === "GET" && DISCOVERY[path]) {
      return Response.redirect(DISCOVERY[path], 302);
    }

    try {
      if (path === "/worldtimeconverter" || path === "/time" || path === "/time.txt" || path === "/time.svg") {
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
