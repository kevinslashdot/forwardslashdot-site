/**
 * Panorama accounts, library, progressive CDN media, analytics, and public tours.
 * Magic link matches the mihom pattern: the email carries a code and a button.
 * Opening the link only shows a confirm page. The token is spent when the button is pressed.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const HOURLY_CAP = 5;
const GUEST_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const GUEST_SCENES = 15;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const KV_MAX_BYTES = 25 * 1024 * 1024;
const GUEST_STORAGE_BYTES = 500 * 1024 * 1024;
const PBKDF2_ITERATIONS = 100000;
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const SEND_IP_LIMIT = 20;
const BEAT_LIMIT = 120;
const EDGE_TTL = 300;
// The ES modules aren't fingerprinted, so a cached copy must never be mixed with a newer sibling.
const STATIC_CACHE = "public, max-age=0, must-revalidate";
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_PLAN_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_TILES = 16;
const FROM = "login@forwardslashdot.com";
const RESEND_FROM = "Panorama <login@mail.forwardslashdot.com>";

const TIERS = {
  guest: {
    plan: "guest",
    label: "Quick Upload",
    published: 3,
    scenes: GUEST_SCENES,
    bytes: MAX_IMAGE_BYTES,
    monthly: 5 * 1024 * 1024 * 1024,
    commercial: false,
    customBranding: false,
    customQr: false,
    aiUpscale: false,
    sceneSwap: false,
    retentionDays: 90
  },
  free: {
    plan: "free",
    label: "Free",
    published: 10,
    scenes: 30,
    bytes: MAX_IMAGE_BYTES,
    monthly: 10 * 1024 * 1024 * 1024,
    commercial: false,
    customBranding: false,
    customQr: false,
    aiUpscale: true,
    sceneSwap: true,
    retentionDays: 0
  },
  pro: {
    plan: "pro",
    label: "Pro",
    published: 100,
    scenes: 100,
    bytes: MAX_IMAGE_BYTES,
    monthly: 100 * 1024 * 1024 * 1024,
    commercial: true,
    customBranding: true,
    customQr: true,
    aiUpscale: true,
    sceneSwap: true,
    retentionDays: 0
  },
  business: {
    plan: "business",
    label: "Business",
    published: 500,
    scenes: 250,
    bytes: MAX_IMAGE_BYTES,
    monthly: 500 * 1024 * 1024 * 1024,
    commercial: true,
    customBranding: true,
    customQr: true,
    aiUpscale: true,
    sceneSwap: true,
    retentionDays: 0
  }
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin"
};

const INFO_JSON = "(case when json_valid(info) then info else '{}' end)";
const ATTACH_JSON = "(case when json_valid(attachments) then attachments else '[]' end)";
const GALLERY_JSON = `coalesce(case when json_type(${INFO_JSON}, '$.gallery') = 'array' then json_extract(${INFO_JSON}, '$.gallery') end, '[]')`;

const SCHEMA_PATCH = [
  "create table if not exists attempts (key text primary key, n integer not null default 0, reset_at integer not null)",
  "create index if not exists attempts_reset_idx on attempts (reset_at)",
  "create table if not exists collection_editors (collection_id text not null, email text not null, primary key (collection_id, email))",
  "create index if not exists collection_editors_email_idx on collection_editors (email)",
  "create table if not exists billing (user_id text primary key, customer_id text, subscription_id text, plan text, updated_at integer not null)",
  "create index if not exists billing_customer_idx on billing (customer_id)",
  "create index if not exists collections_user_idx on collections (user_id)",
  "create index if not exists collections_edit_idx on collections (edit_hash)",
  "create index if not exists collections_guest_ip_idx on collections (guest, ip_hash)",
  "create index if not exists collections_guest_exp_idx on collections (guest, expires_at)",
  "create index if not exists sessions_user_idx on sessions (user_id)",
  "create index if not exists sessions_expires_idx on sessions (expires_at)",
  "create index if not exists codes_expires_idx on codes (expires_at)",
  "create index if not exists scenes_collection_idx on scenes (collection_id, sort)"
];

const json = (data, status = 200, extra) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    ...SECURITY_HEADERS,
    ...(extra || {})
  }
});

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const isUuid = (s) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);

let schemaReady = null;

function ensureSchema(env) {
  if (!schemaReady) {
    const db = env.PANORAMA_DB;
    schemaReady = db.batch(SCHEMA_PATCH.map((sql) => db.prepare(sql))).catch((err) => {
      schemaReady = null;
      console.error("panorama schema patch failed", err);
    });
  }
  return schemaReady;
}

function later(ctx, promise) {
  const guarded = Promise.resolve(promise).catch((err) => console.error("panorama background task failed", err));
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(guarded);
    return undefined;
  }
  return guarded;
}

function decodePart(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    return null;
  }
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "local";
}

function mbText(bytes) {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

function maxImageBytes(env) {
  return env.PANORAMA_MEDIA ? MAX_IMAGE_BYTES : KV_MAX_BYTES;
}

function hasStorage(env) {
  return !!(env.PANORAMA_MEDIA || env.PANORAMA_KV);
}

function parseRange(header) {
  const match = String(header || "").match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) return { suffix: Number(match[2]) };
  const offset = Number(match[1]);
  if (!match[2]) return { offset };
  const end = Number(match[2]);
  if (end < offset) return null;
  return { offset, length: end - offset + 1 };
}

async function mediaPut(env, key, buf, contentType) {
  if (env.PANORAMA_MEDIA) {
    await env.PANORAMA_MEDIA.put(key, buf, contentType ? { httpMetadata: { contentType } } : undefined);
    return;
  }
  if (!env.PANORAMA_KV) throw new Error("panorama storage missing");
  await env.PANORAMA_KV.put(key, buf);
}

async function mediaGet(env, key, rangeHeader) {
  if (env.PANORAMA_MEDIA) {
    const range = parseRange(rangeHeader);
    let obj = null;
    try {
      obj = await env.PANORAMA_MEDIA.get(key, range ? { range } : undefined);
    } catch (err) {
      if (!range) throw err;
      obj = await env.PANORAMA_MEDIA.get(key);
    }
    if (obj) {
      const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "";
      if (range && obj.range && obj.size) {
        const start = range.suffix != null ? Math.max(0, obj.size - range.suffix) : Math.min(range.offset, obj.size - 1);
        const end = range.length != null ? Math.min(obj.size - 1, start + range.length - 1) : obj.size - 1;
        return { body: obj.body, size: obj.size, length: end - start + 1, start, end, partial: true, type, ranged: true };
      }
      return { body: obj.body, size: obj.size, length: obj.size, type, ranged: true };
    }
  }
  if (!env.PANORAMA_KV) return null;
  const buf = await env.PANORAMA_KV.get(key, { type: "arrayBuffer" });
  return buf ? { body: buf, buf, size: buf.byteLength, length: buf.byteLength, type: "" } : null;
}

async function mediaBuffer(obj) {
  if (obj.buf) return obj.buf;
  obj.buf = await new Response(obj.body).arrayBuffer();
  return obj.buf;
}

function mediaDiscard(obj) {
  if (obj && !obj.buf && obj.body && typeof obj.body.cancel === "function") obj.body.cancel().catch(() => {});
}

async function mediaExists(env, key) {
  if (env.PANORAMA_MEDIA && await env.PANORAMA_MEDIA.head(key)) return true;
  if (!env.PANORAMA_KV) return false;
  const stream = await env.PANORAMA_KV.get(key, { type: "stream" });
  if (!stream) return false;
  stream.cancel().catch(() => {});
  return true;
}

async function mediaCopy(env, from, to) {
  if (env.PANORAMA_MEDIA) {
    const obj = await env.PANORAMA_MEDIA.get(from);
    if (obj) {
      await env.PANORAMA_MEDIA.put(to, obj.body, { httpMetadata: obj.httpMetadata });
      return { size: obj.size };
    }
  }
  if (!env.PANORAMA_KV) return null;
  const stream = await env.PANORAMA_KV.get(from, { type: "stream" });
  if (!stream) return null;
  await env.PANORAMA_KV.put(to, stream);
  return { size: 0 };
}

async function mediaDelete(env, keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!list.length) return;
  const jobs = [];
  if (env.PANORAMA_MEDIA) {
    for (let i = 0; i < list.length; i += 1000) jobs.push(env.PANORAMA_MEDIA.delete(list.slice(i, i + 1000)));
  }
  if (env.PANORAMA_KV) {
    for (const key of list) jobs.push(env.PANORAMA_KV.delete(key));
  }
  await Promise.allSettled(jobs);
}

async function runPool(tasks, size) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < tasks.length) {
      const task = tasks[next++];
      try {
        await task();
      } catch (err) {
        failure = failure || err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  if (failure) throw failure;
}

function mediaHeaders(extra) {
  return { ...SECURITY_HEADERS, ...(extra || {}) };
}

function matchesEtag(request, etag) {
  const header = request.headers.get("if-none-match");
  if (!header || !etag) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((item) => {
    const value = item.trim();
    return value === "*" || value.replace(/^W\//, "") === bare;
  });
}

function notModified(headers) {
  const out = new Headers(headers);
  out.delete("content-type");
  out.delete("content-length");
  return new Response(null, { status: 304, headers: out });
}

function edgeCache() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

function edgeStore(ctx, request, buf, headers) {
  const cache = edgeCache();
  if (!cache || !ctx || typeof ctx.waitUntil !== "function") return;
  const stored = new Headers(headers);
  stored.set("cache-control", `public, max-age=${EDGE_TTL}`);
  ctx.waitUntil(cache.put(new Request(request.url), new Response(buf, { headers: stored })).catch(() => {}));
}

function contentDisposition(disp, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[%;]/g, "_") || "document.pdf";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${disp}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function hitLimit(env, key, max, windowMs) {
  const now = Date.now();
  try {
    const row = await env.PANORAMA_DB.prepare(
      `insert into attempts (key, n, reset_at) values (?, 1, ?)
       on conflict(key) do update set
         n = case when attempts.reset_at <= ? then 1 else attempts.n + 1 end,
         reset_at = case when attempts.reset_at <= ? then excluded.reset_at else attempts.reset_at end
       returning n`
    ).bind(key, now + windowMs, now, now).first();
    return !!row && row.n > max;
  } catch (err) {
    console.error("panorama rate limit failed", err);
    return false;
  }
}

const beatHits = new Map();

function beatAllowed(ip) {
  const now = Date.now();
  if (beatHits.size > 5000) {
    for (const [key, slot] of beatHits) if (slot.reset <= now) beatHits.delete(key);
  }
  const slot = beatHits.get(ip);
  if (!slot || slot.reset <= now) {
    beatHits.set(ip, { n: 1, reset: now + 60000 });
    return true;
  }
  slot.n += 1;
  return slot.n <= BEAT_LIMIT;
}

function safeUrl(raw, maxLen = 400) {
  const s = String(raw || "").trim().slice(0, maxLen);
  if (!s) return "";
  if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return s;
  return "";
}

function safeFilename(raw, fallback = "document.pdf") {
  const clean = String(raw || fallback)
    .replace(/[\r\n"\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || fallback;
}

function detectImageMime(buf, fallback = "image/jpeg") {
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 16));
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return /^image\/(jpeg|png|webp)$/.test(fallback) ? fallback : "image/jpeg";
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmac(secret, data) {
  if (!secret) throw new Error("panorama secret missing");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("pano-email-v1:" + secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

async function sha256(data) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

async function checkPassword(env, password, stored) {
  if (typeof stored !== "string" || !stored) return { ok: false };
  if (stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    const iterations = Number(parts[1]);
    if (parts.length !== 4 || !iterations || iterations > PBKDF2_ITERATIONS) return { ok: false };
    try {
      const hash = toBase64(await pbkdf2(password, fromBase64(parts[2]), iterations));
      return { ok: safeEqual(hash, parts[3]) };
    } catch (err) {
      return { ok: false };
    }
  }
  const legacy = await hmac(env.PANORAMA_SECRET, "pass:" + password);
  return { ok: safeEqual(legacy, stored), legacy: true };
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

async function verifyStripe(secret, header, raw) {
  let stamp = 0;
  const sigs = [];
  for (const part of String(header || "").split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === "t") stamp = Number(value);
    else if (name === "v1") sigs.push(value);
  }
  if (!stamp || !sigs.length || Math.abs(Date.now() / 1000 - stamp) > 300) return false;
  const expected = await hmacHex(secret, `${stamp}.${raw}`);
  return sigs.some((sig) => safeEqual(sig, expected));
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  const match = raw.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  if (!match) return "";
  return decodePart(match[1]) || "";
}

function cookieToken(request) {
  return readCookie(request, "pano_session");
}

function sessionCookie(token, maxAge, request) {
  const isHttps = !request || new URL(request.url).protocol === "https:";
  const secure = `HttpOnly; ${isHttps ? "Secure; " : ""}SameSite=Lax; Path=/`;
  if (!token) return `pano_session=; ${secure}; Max-Age=0`;
  return `pano_session=${encodeURIComponent(token)}; ${secure}; Max-Age=${maxAge}`;
}

async function userFromRequest(request, env) {
  const token = cookieToken(request);
  if (!token || !env.PANORAMA_DB) return null;
  const row = await env.PANORAMA_DB.prepare(
    `select u.id, u.email, u.plan from sessions s join users u on u.id = s.user_id
     where s.token_hash = ? and s.expires_at > ?`
  ).bind(await sha256(token), Date.now()).first();
  return row || null;
}

function normalizePlan(plan) {
  if (plan === "pro" || plan === "business" || plan === "free") return plan;
  return "free";
}

function planLimits(user) {
  if (!user || user.id === "guest") return TIERS.guest;
  return TIERS[normalizePlan(user.plan)] || TIERS.free;
}

function parseJson(text, fallback) {
  try {
    const val = JSON.parse(text || "");
    return val && typeof val === "object" ? val : fallback;
  } catch (err) {
    return fallback;
  }
}

function parseInfo(text) {
  return parseJson(text, {});
}

function parseBranding(text) {
  const b = parseJson(text, {});
  const loaderStyles = ["spinner", "pulse", "bar", "fade"];
  const qrPatterns = ["square", "rounded", "dots", "diamond"];
  const hex = (v, fb) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : fb);
  return {
    hideWatermark: !!b.hideWatermark,
    logoUrl: safeUrl(b.logoUrl, 240),
    loaderStyle: loaderStyles.includes(b.loaderStyle) ? b.loaderStyle : "spinner",
    loaderColor: hex(b.loaderColor, "#f6f1e8"),
    loaderBg: hex(b.loaderBg, "#14110e"),
    loaderText: String(b.loaderText || "").trim().slice(0, 60),
    qrFg: hex(b.qrFg, "#1c1917"),
    qrBg: hex(b.qrBg, "#ffffff"),
    qrPattern: qrPatterns.includes(b.qrPattern) ? b.qrPattern : "square",
    qrLogo: !!b.qrLogo
  };
}

function parseAttachments(row) {
  const list = parseJson(row && row.attachments, []);
  if (Array.isArray(list) && list.length) {
    return list
      .filter((a) => a && typeof a.id === "string" && typeof a.name === "string")
      .slice(0, MAX_ATTACHMENTS)
      .map((a) => ({ id: a.id, name: safeFilename(a.name), bytes: Number(a.bytes) || 0 }));
  }
  if (row && row.pdf_name) {
    return [{ id: "legacy", name: safeFilename(row.pdf_name), bytes: 0 }];
  }
  return [];
}

function isEditor(row, user) {
  if (!row || !user || !user.email) return false;
  const editors = parseInfo(row.info).editors || [];
  return editors.includes(String(user.email).toLowerCase());
}

function cleanContact(contact) {
  const source = contact || {};
  return {
    name: String(source.name || "").trim().slice(0, 80),
    role: String(source.role || "").trim().slice(0, 80),
    email: String(source.email || "").trim().slice(0, 80),
    phone: String(source.phone || "").trim().slice(0, 40),
    website: safeUrl(source.website, 200)
  };
}

function cleanEditors(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((item) => String(item || "").trim().toLowerCase()).filter(isEmail))].slice(0, 12);
}

function cleanIds(list) {
  return (Array.isArray(list) ? list : []).filter(isUuid).slice(0, 12);
}

function cleanHotspots(list) {
  if (!Array.isArray(list)) return [];
  const validKinds = ["note", "scene", "link", "video", "pdf"];
  const validIcons = ["dot", "arrow", "chevron", "walk", "info", "pin", "video", "link", "pdf"];
  const validSizes = ["s", "m", "l"];
  const validMotions = ["still", "pulse"];
  const validHovers = ["scale", "bounce", "glow", "ring", "none"];
  return list.slice(0, 50).map((spot) => {
    const s = spot || {};
    const color = typeof s.color === "string" && /^#[0-9a-f]{3,6}$/i.test(s.color.trim()) ? s.color.trim() : "#ffffff";
    return {
      id: typeof s.id === "string" && s.id.length <= 48 ? s.id : crypto.randomUUID(),
      u: Math.max(0, Math.min(1, Number(s.u) || 0.5)),
      v: Math.max(0, Math.min(1, Number(s.v) || 0.5)),
      kind: validKinds.includes(s.kind) ? s.kind : "note",
      title: String(s.title || "Point").trim().slice(0, 80) || "Point",
      body: String(s.body || "").trim().slice(0, 800),
      url: safeUrl(s.url, 400),
      ctaLabel: String(s.ctaLabel || "").trim().slice(0, 40),
      target: typeof s.target === "string" ? s.target.slice(0, 48) : "",
      fileId: typeof s.fileId === "string" ? s.fileId.slice(0, 48) : "",
      icon: validIcons.includes(s.icon) ? s.icon : "dot",
      color,
      size: validSizes.includes(s.size) ? s.size : "m",
      motion: validMotions.includes(s.motion) ? s.motion : "still",
      hover: validHovers.includes(s.hover) ? s.hover : "scale",
      heading: ((Number(s.heading) || 0) % 360 + 360) % 360
    };
  });
}

function cleanPins(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 60).map((pin) => {
    const p = pin || {};
    const kind = p.kind === "info" ? "info" : "scene";
    return {
      id: typeof p.id === "string" && p.id.length <= 48 ? p.id : crypto.randomUUID(),
      kind,
      sceneId: typeof p.sceneId === "string" ? p.sceneId.slice(0, 48) : "",
      title: String(p.title || "").trim().slice(0, 80),
      body: String(p.body || "").trim().slice(0, 400),
      x: Math.max(0, Math.min(1, Number(p.x) || 0.5)),
      y: Math.max(0, Math.min(1, Number(p.y) || 0.5)),
      heading: ((Number(p.heading) || 0) % 360 + 360) % 360
    };
  });
}

async function rememberPiece(env, collectionId, kind, pieceId, buf) {
  const now = Date.now();
  if (kind === "logo") {
    await mediaPut(env, `logo:${collectionId}`, buf, detectImageMime(buf, "image/png"));
    await env.PANORAMA_DB.prepare(
      `update collections set info = json_set(${INFO_JSON}, '$.logo', json('true')), updated_at = ? where id = ?`
    ).bind(now, collectionId).run();
    return true;
  }
  const key = `gallery:${collectionId}:${pieceId}`;
  await mediaPut(env, key, buf, detectImageMime(buf, "image/jpeg"));
  const res = await env.PANORAMA_DB.prepare(
    `update collections set info = json_set(${INFO_JSON}, '$.gallery', json(json_insert(${GALLERY_JSON}, '$[#]', ?))), updated_at = ?
     where id = ? and json_array_length(${GALLERY_JSON}) < 12
     and not exists (select 1 from json_each(${GALLERY_JSON}) g where g.value = ?)`
  ).bind(pieceId, now, collectionId, pieceId).run();
  if (res.meta && res.meta.changes > 0) return true;
  const present = await env.PANORAMA_DB.prepare(
    `select 1 as ok from collections c, json_each(${GALLERY_JSON}) g where c.id = ? and g.value = ?`
  ).bind(collectionId, pieceId).first();
  if (present) return true;
  await mediaDelete(env, key);
  return false;
}

async function addAttachment(env, collectionId, fileId, name, bytes) {
  const db = env.PANORAMA_DB;
  const entry = JSON.stringify({ id: fileId, name, bytes });
  const others = `(select coalesce(json_group_array(json(e.value)), json('[]')) from json_each(${ATTACH_JSON}) e where json_extract(e.value, '$.id') is not ?)`;
  const results = await db.batch([
    db.prepare(
      `update collections set attachments = json_insert(${others}, '$[#]', json(?)), updated_at = ?
       where id = ? and (select count(*) from json_each(${ATTACH_JSON}) e where json_extract(e.value, '$.id') is not ?) < ?`
    ).bind(fileId, entry, Date.now(), collectionId, fileId, MAX_ATTACHMENTS),
    db.prepare(
      `update collections set pdf_name = coalesce(json_extract(${ATTACH_JSON}, '$[0].name'), pdf_name)
       where id = ? and json_array_length(${ATTACH_JSON}) > 0 returning attachments, pdf_name`
    ).bind(collectionId)
  ]);
  const changed = !!(results[0].meta && results[0].meta.changes > 0);
  const row = results[1].results && results[1].results[0];
  return { ok: changed, attachments: parseAttachments(row) };
}

async function dropAttachment(env, collectionId, fileId) {
  const db = env.PANORAMA_DB;
  const results = await db.batch([
    db.prepare(
      `update collections set attachments = (select coalesce(json_group_array(json(e.value)), json('[]')) from json_each(${ATTACH_JSON}) e where json_extract(e.value, '$.id') is not ?), updated_at = ?
       where id = ?`
    ).bind(fileId, Date.now(), collectionId),
    db.prepare(
      `update collections set pdf_name = coalesce(json_extract(${ATTACH_JSON}, '$[0].name'), '')
       where id = ? returning attachments, pdf_name`
    ).bind(collectionId)
  ]);
  const row = results[1].results && results[1].results[0];
  return parseAttachments(row);
}

async function noteView(env, ownerId, bytes, caps) {
  if (!ownerId || ownerId === "guest" || !bytes) return true;
  const cap = (caps || TIERS.free).monthly;
  const month = new Date().toISOString().slice(0, 7);
  const db = env.PANORAMA_DB;
  try {
    const results = await db.batch([
      db.prepare("insert into usage (user_id, month, bytes) values (?, ?, 0) on conflict(user_id, month) do nothing").bind(ownerId, month),
      db.prepare("update usage set bytes = bytes + ? where user_id = ? and month = ? and bytes + ? <= ?").bind(bytes, ownerId, month, bytes, cap)
    ]);
    return !!(results[1].meta && results[1].meta.changes > 0);
  } catch (err) {
    console.error("panorama usage metering failed", err);
    return true;
  }
}

function mailBodies(code, link) {
  const subject = `${code} is your Panorama code`;
  const text = [
    "Sign in to Panorama",
    "",
    "Tap the link to open a page that asks you to confirm, or enter this code:",
    "",
    code,
    "",
    link,
    "",
    "It works once and expires in 10 minutes. If you didn't ask, you can ignore this email."
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f6f1e8;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#1c1917">
  <div style="display:none;max-height:0;overflow:hidden">Your Panorama code is ${code}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e8"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fffdf9;border-radius:24px">
  <tr><td style="padding:28px 28px 8px;font-size:22px;font-weight:600;letter-spacing:-0.03em">Panorama</td></tr>
  <tr><td style="padding:8px 28px 0;font-size:17px;line-height:1.4">Tap the button to sign in, or enter this code.</td></tr>
  <tr><td style="padding:22px 28px 0;font-size:40px;font-weight:600;letter-spacing:0.22em;font-variant-numeric:tabular-nums">${code}</td></tr>
  <tr><td style="padding:22px 28px 0"><a href="${link}" style="display:inline-block;background:#1c1917;color:#f7f3ec;text-decoration:none;border-radius:999px;padding:12px 22px;font-size:17px;font-weight:600">Sign In</a></td></tr>
  <tr><td style="padding:18px 28px 28px;font-size:13px;line-height:1.45;color:#7c736a">It works once and expires in 10 minutes. Opening the link does nothing until you press the button. If you didn't ask, ignore this email.</td></tr>
  </table></td></tr></table></body></html>`;
  return { subject, text, html };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response, attempt) {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 8000);
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 8000);
  }
  return Math.min(1000 * (2 ** attempt), 8000);
}

async function sendResend(env, to, subject, text, html, idempotencyKey, from) {
  let lastStatus = 0;
  let lastMessage = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: "Bearer " + env.RESEND_API_KEY,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        },
        body: JSON.stringify({
          from: from || RESEND_FROM,
          to: [to],
          subject,
          text,
          html
        })
      });
    } catch (err) {
      if (attempt === 2) throw new Error("resend network");
      await wait(1000 * (2 ** attempt));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body.id;
    lastStatus = res.status;
    lastMessage = String(body.message || (body.error && body.error.message) || body.name || "").slice(0, 180);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 2) throw new Error("resend " + res.status + " " + lastMessage);
    await wait(retryDelay(res, attempt));
  }
  throw new Error("resend " + lastStatus + " " + lastMessage);
}

async function deliver(env, to, subject, text, html, resendMessage) {
  if (env.RESEND_API_KEY && resendMessage) {
    try {
      await sendResend(env, to, subject, text, html, resendMessage.idempotencyKey, RESEND_FROM);
      return;
    } catch (err) {
      const message = String(err && err.message || "");
      if (/resend 403/.test(message) || /not verified|associated domain/i.test(message)) {
        await sendResend(env, to, subject, text, html, resendMessage.idempotencyKey + "-sandbox", "Panorama <onboarding@resend.dev>");
        return;
      }
      throw err;
    }
  }
  throw new Error("mail-unconfigured");
}

async function sendCode(request, env, email) {
  if (!env.PANORAMA_SECRET || !env.PANORAMA_DB) return json({ error: "Sign-in isn't available right now." }, 503);
  const ipHash = await sha256(clientIp(request));
  if (await hitLimit(env, `send:${ipHash}`, SEND_IP_LIMIT, 60 * 60 * 1000)) {
    return json({ error: "Too many sign-in emails from this network. Try again later." }, 429);
  }
  const now = Date.now();
  const last = await env.PANORAMA_DB.prepare(
    "select max(created_at) as t from codes where email = ?"
  ).bind(email).first();
  if (last && last.t && now - last.t < RESEND_MS) {
    return json({ error: "A new code can be sent once a minute. Use the latest one." }, 429);
  }
  const hour = await env.PANORAMA_DB.prepare(
    "select count(*) as n from codes where email = ? and created_at > ?"
  ).bind(email, now - 60 * 60 * 1000).first();
  if (hour && hour.n >= HOURLY_CAP) {
    return json({ error: "That's 5 codes this hour. Use the latest one, or try again later." }, 429);
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  const token = randomToken(32);
  const id = crypto.randomUUID();
  await env.PANORAMA_DB.prepare(
    "update codes set expires_at = ? where email = ? and used_at is null and expires_at > ?"
  ).bind(now, email, now).run();
  await env.PANORAMA_DB.prepare(
    `insert into codes (id, email, code_hash, link_hash, created_at, expires_at, attempts)
     values (?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    id,
    email,
    await hmac(env.PANORAMA_SECRET, `code:${email}:${code}`),
    await hmac(env.PANORAMA_SECRET, `link:${token}`),
    now,
    now + CODE_TTL_MS
  ).run();
  const origin = new URL(request.url).origin;
  const link = `${origin}/panorama/link?token_hash=${encodeURIComponent(token)}`;
  const mail = mailBodies(code, link);
  try {
    await deliver(env, email, mail.subject, mail.text, mail.html, {
      code,
      link,
      idempotencyKey: `panorama-sign-in/${id}`
    });
  } catch (err) {
    await env.PANORAMA_DB.prepare("delete from codes where id = ?").bind(id).run();
    const message = String(err && err.message || "");
    const missing = message === "mail-unconfigured" || /resend 401/.test(message) || /resend 403/.test(message);
    return json({
      error: missing
        ? "Sign-in email isn't set up on this site yet."
        : "We couldn't send the email. Try again in a minute."
    }, 503);
  }
  return json({ ok: true, email });
}

async function establishSession(env, email) {
  const now = Date.now();
  let user = await env.PANORAMA_DB.prepare(
    "select id, email, plan from users where email = ?"
  ).bind(email).first();
  if (!user) {
    const id = crypto.randomUUID();
    await env.PANORAMA_DB.prepare(
      "insert into users (id, email, plan, created_at) values (?, ?, 'free', ?)"
    ).bind(id, email, now).run();
    user = { id, email, plan: "free" };
  }
  const token = randomToken(32);
  await env.PANORAMA_DB.prepare(
    "insert into sessions (token_hash, user_id, expires_at) values (?, ?, ?)"
  ).bind(await sha256(token), user.id, now + SESSION_TTL_MS).run();
  return { token, user };
}

async function verifyCode(env, email, code) {
  const now = Date.now();
  const row = await env.PANORAMA_DB.prepare(
    `select id, code_hash, attempts from codes
     where email = ? and used_at is null and expires_at > ? and attempts < ?
     order by created_at desc limit 1`
  ).bind(email, now, MAX_ATTEMPTS).first();
  if (!row) return null;
  const expected = await hmac(env.PANORAMA_SECRET, `code:${email}:${code}`);
  if (!safeEqual(expected, row.code_hash)) {
    await env.PANORAMA_DB.prepare("update codes set attempts = attempts + 1 where id = ?").bind(row.id).run();
    return null;
  }
  const spent = await env.PANORAMA_DB.prepare(
    "update codes set used_at = ? where id = ? and used_at is null"
  ).bind(now, row.id).run();
  if (!spent.meta || spent.meta.changes < 1) return null;
  return establishSession(env, email);
}

async function verifyLink(env, token) {
  const now = Date.now();
  const hash = await hmac(env.PANORAMA_SECRET, `link:${token}`);
  const row = await env.PANORAMA_DB.prepare(
    `select id, email from codes
     where link_hash = ? and used_at is null and expires_at > ? and attempts < ? limit 1`
  ).bind(hash, now, MAX_ATTEMPTS).first();
  if (!row) return null;
  const spent = await env.PANORAMA_DB.prepare(
    "update codes set used_at = ? where id = ? and used_at is null"
  ).bind(now, row.id).run();
  if (!spent.meta || spent.meta.changes < 1) return null;
  return establishSession(env, row.email);
}

function parseGrade(text) {
  const grade = parseJson(text, {});
  const n = (value, min, max, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  };
  return {
    exposure: n(grade.exposure, -2, 2, 0),
    highlights: n(grade.highlights, -1, 1, 0),
    shadows: n(grade.shadows, -1, 1, 0),
    black: n(grade.black, 0, 0.6, 0),
    saturation: n(grade.saturation, 0, 2, 1),
    warmth: n(grade.warmth, -1, 1, 0),
    sharpness: n(grade.sharpness, 0, 2, 0)
  };
}

function gradeText(scene) {
  return JSON.stringify(parseGrade(JSON.stringify(scene && scene.grade || {})));
}

function sceneOut(row) {
  let hotspots = [];
  try { hotspots = JSON.parse(row.hotspots || "[]"); } catch (err) { hotspots = []; }
  const hotspotClicks = parseJson(row.hotspot_clicks, {});
  return {
    id: row.id,
    title: row.title,
    sort: row.sort,
    opening: { yaw: row.yaw, pitch: row.pitch, fov: row.fov },
    orient: { yaw: row.orient_yaw, roll: row.roll, flipX: row.flip_x, flipY: row.flip_y },
    hotspots,
    width: row.width,
    height: row.height,
    bytes: row.bytes || 0,
    views: row.views || 0,
    dwell: row.dwell_ms || 0,
    clicks: row.clicks || 0,
    hotspotClicks,
    tiles: row.tiles || 0,
    upscaled: !!row.upscaled,
    mime: row.mime || "image/jpeg",
    bright: row.bright || 0,
    contrast: row.contrast == null ? 1 : row.contrast,
    grade: parseGrade(row.grade)
  };
}

async function ownedCollection(env, user, id) {
  return env.PANORAMA_DB.prepare(
    "select * from collections where id = ? and user_id = ?"
  ).bind(id, user.id).first();
}

const SCENE_FIELDS = ["id", "title", "sort", "yaw", "pitch", "fov", "orient_yaw", "roll", "flip_x", "flip_y", "hotspots", "width", "height", "bright", "contrast", "grade", "upscaled"];

function sceneFieldsSql(fields) {
  return fields.map((field) => `json_extract(value, '$.${field}')`).join(", ");
}

function chunkByJson(items, limit = 800000) {
  const chunks = [];
  let current = [];
  let size = 2;
  for (const item of items) {
    const len = JSON.stringify(item).length + 1;
    if (current.length && size + len > limit) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function saveCollection(env, user, body, opts = {}) {
  const db = env.PANORAMA_DB;
  const now = Date.now();
  const guest = !!opts.guest;
  let id;
  let existing = null;
  if (guest) {
    id = opts.collectionId || crypto.randomUUID();
    if (opts.collectionId) {
      existing = await db.prepare("select * from collections where id = ? and guest = 1").bind(id).first();
      if (!existing) return { error: "That collection is gone.", status: 404 };
    }
  } else {
    id = isUuid(body.id) ? body.id : crypto.randomUUID();
    existing = await db.prepare("select * from collections where id = ?").bind(id).first();
    if (existing && (existing.guest || existing.user_id === "guest" || (existing.user_id !== user.id && !isEditor(existing, user)))) {
      return { error: "That collection is gone.", status: 404 };
    }
  }
  const ownerId = guest ? "guest" : (existing ? existing.user_id : user.id);
  const ownerRow = guest
    ? { id: "guest" }
    : (ownerId === user.id ? user : await db.prepare("select id, email, plan from users where id = ?").bind(ownerId).first());
  const caps = planLimits(ownerRow || { id: ownerId });
  if (Array.isArray(body.scenes) && body.scenes.length > caps.scenes) {
    if (guest) return { error: "Quick upload holds up to 15 photos. Sign in for larger tours.", status: 400 };
    const whose = ownerId === user.id ? "Your" : "The tour owner's";
    return { error: `${whose} ${caps.label} plan supports up to ${caps.scenes} scenes per tour.`, status: 402 };
  }
  const title = String(body.title || "Untitled").trim().slice(0, 80) || "Untitled";
  const blurb = String(body.blurb || "").trim().slice(0, 600);
  const linkLabel = String(body.linkLabel || "").trim().slice(0, 48);
  const linkUrl = safeUrl(body.linkUrl, 400);
  const folder = typeof body.folder === "string" ? body.folder.trim().slice(0, 60) : (existing ? (existing.folder || "") : "");
  const commercial = caps.commercial && body.commercial !== undefined
    ? (body.commercial ? 1 : 0)
    : (existing ? (existing.commercial || 0) : (caps.commercial ? 1 : 0));
  const brandingObj = body.branding
    ? parseBranding(JSON.stringify(body.branding))
    : parseBranding(existing && existing.branding);
  if (!caps.customBranding) {
    brandingObj.hideWatermark = false;
    brandingObj.loaderStyle = "spinner";
    brandingObj.loaderColor = "#f6f1e8";
    brandingObj.loaderBg = "#14110e";
    brandingObj.loaderText = "";
  }
  if (!caps.customQr) {
    brandingObj.qrFg = "#1c1917";
    brandingObj.qrBg = "#ffffff";
    brandingObj.qrPattern = "square";
    brandingObj.qrLogo = false;
  }
  const scenes = Array.isArray(body.scenes) ? body.scenes.slice(0, caps.scenes) : null;
  const statements = [];
  const remap = {};
  let removed = [];
  if (!existing) {
    statements.push(db.prepare(
      `insert into collections (id, user_id, title, blurb, link_label, link_url, slug, views, created_at, updated_at, folder, commercial, branding, guest, edit_hash, ip_hash, expires_at)
       values (?, ?, ?, ?, ?, ?, null, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, ownerId, title, blurb, linkLabel, linkUrl, now, now, folder, commercial, JSON.stringify(brandingObj),
      guest ? 1 : 0, opts.editHash || null, opts.ipHash || null, opts.expiresAt || null
    ));
  } else {
    statements.push(db.prepare(
      `update collections set title = ?, blurb = ?, link_label = ?, link_url = ?, folder = ?, commercial = ?, branding = ?, updated_at = ? where id = ?`
    ).bind(title, blurb, linkLabel, linkUrl, folder, commercial, JSON.stringify(brandingObj), now, id));
  }
  if (scenes) {
    const askedIds = scenes.map((scene) => (scene && isUuid(scene.id) ? scene.id : "")).filter(Boolean);
    const found = await db.prepare(
      "select id, collection_id, user_id, tiles from scenes where collection_id = ? or id in (select value from json_each(?))"
    ).bind(id, JSON.stringify(askedIds)).all();
    const known = new Map((found.results || []).map((row) => [row.id, row]));
    const canMove = !guest && ownerId === user.id;
    const keep = new Set();
    const sids = scenes.map((raw) => {
      const scene = raw || {};
      let sid = isUuid(scene.id) ? scene.id : crypto.randomUUID();
      const prior = known.get(sid);
      const foreign = prior && prior.collection_id !== id && !(canMove && prior.user_id === ownerId);
      if (keep.has(sid) || foreign) {
        const fresh = crypto.randomUUID();
        if (isUuid(scene.id) && !remap[scene.id]) remap[scene.id] = fresh;
        sid = fresh;
      }
      keep.add(sid);
      return sid;
    });
    const items = scenes.map((raw, i) => {
      const scene = raw || {};
      const opening = scene.opening || {};
      const orient = scene.orient || {};
      const spots = cleanHotspots(scene.hotspots).map((spot) => (remap[spot.target] ? { ...spot, target: remap[spot.target] } : spot));
      return {
        id: sids[i],
        title: String(scene.title || "Photo").slice(0, 80),
        sort: i,
        yaw: Number(opening.yaw) || 0,
        pitch: Number(opening.pitch) || 0,
        fov: Number(opening.fov) || 72,
        orient_yaw: Number(orient.yaw) || 0,
        roll: Number(orient.roll) || 0,
        flip_x: orient.flipX === -1 ? -1 : 1,
        flip_y: orient.flipY === -1 ? -1 : 1,
        hotspots: JSON.stringify(spots).slice(0, 40000),
        width: Number(scene.width) || 0,
        height: Number(scene.height) || 0,
        bright: Math.max(-0.4, Math.min(0.4, Number(scene.bright) || 0)),
        contrast: Math.max(0.6, Math.min(1.6, Number(scene.contrast) || 1)),
        grade: gradeText(scene),
        upscaled: scene.upscaled ? 1 : 0
      };
    });
    const updates = SCENE_FIELDS.filter((field) => field !== "id").map((field) => `${field} = excluded.${field}`).join(", ");
    for (const chunk of chunkByJson(items)) {
      statements.push(db.prepare(
        `insert into scenes (${SCENE_FIELDS.join(", ")}, collection_id, user_id, bytes, created_at)
         select ${sceneFieldsSql(SCENE_FIELDS)}, ?, ?, 0, ? from json_each(?) where true
         on conflict(id) do update set collection_id = excluded.collection_id, ${updates}
         where scenes.collection_id = excluded.collection_id or (? = 1 and scenes.user_id = excluded.user_id)`
      ).bind(id, ownerId, now, JSON.stringify(chunk), canMove ? 1 : 0));
    }
    removed = (found.results || []).filter((row) => row.collection_id === id && !keep.has(row.id));
    if (removed.length) {
      statements.push(db.prepare(
        "delete from scenes where collection_id = ? and id in (select value from json_each(?))"
      ).bind(id, JSON.stringify(removed.map((row) => row.id))));
    }
  }
  if (Array.isArray(body.pins)) {
    const cleaned = cleanPins(body.pins).map((pin) => (remap[pin.sceneId] ? { ...pin, sceneId: remap[pin.sceneId] } : pin));
    const pins = JSON.stringify(cleaned).slice(0, 16000);
    statements.push(db.prepare("update collections set pins = ? where id = ?").bind(pins, id));
  }
  if (body.spin != null) {
    const spin = Math.max(-0.6, Math.min(0.6, Number(body.spin) || 0));
    statements.push(db.prepare("update collections set spin = ? where id = ?").bind(spin, id));
  }
  const infoPairs = [];
  const infoArgs = [];
  if (body.contact) {
    infoPairs.push("'$.contact', json(?)");
    infoArgs.push(JSON.stringify(cleanContact(body.contact)));
  }
  const editors = !guest && Array.isArray(body.editors) ? cleanEditors(body.editors) : null;
  if (editors) {
    infoPairs.push("'$.editors', json(?)");
    infoArgs.push(JSON.stringify(editors));
  }
  if (Array.isArray(body.gallery)) {
    infoPairs.push("'$.gallery', json(?)");
    infoArgs.push(JSON.stringify(cleanIds(body.gallery)));
  }
  if (body.hasPlan === false) infoPairs.push("'$.plan', json('false')");
  if (infoPairs.length) {
    statements.push(db.prepare(
      `update collections set info = json_set(${INFO_JSON}, ${infoPairs.join(", ")}) where id = ?`
    ).bind(...infoArgs, id));
  }
  if (editors) {
    statements.push(db.prepare("delete from collection_editors where collection_id = ?").bind(id));
    if (editors.length) {
      statements.push(db.prepare(
        "insert or ignore into collection_editors (collection_id, email) select ?, value from json_each(?)"
      ).bind(id, JSON.stringify(editors)));
    }
  }
  await db.batch(statements);
  if (removed.length) {
    await Promise.allSettled(removed.map((row) => deleteSceneMedia(env, row.id, row.tiles || 0)));
  }
  return { id, remap };
}

async function ownerPlanOf(env, row) {
  if (!row || row.guest || row.user_id === "guest") return TIERS.guest;
  const owner = await env.PANORAMA_DB.prepare("select id, plan from users where id = ?").bind(row.user_id).first();
  return planLimits(owner || { id: row.user_id });
}

async function collectionPayload(env, row, publicView) {
  const scenes = await env.PANORAMA_DB.prepare(
    "select * from scenes where collection_id = ? order by sort, created_at"
  ).bind(row.id).all();
  const pins = parseJson(row.pins, []);
  const countries = parseJson(row.countries, {});
  const info = parseInfo(row.info);
  const ownerCaps = await ownerPlanOf(env, row);
  const branding = parseBranding(row.branding);
  const attachments = parseAttachments(row);
  let hasPlan = !!info.plan;
  if (!hasPlan && hasStorage(env) && (pins.length || !publicView)) {
    hasPlan = await mediaExists(env, `plan:${row.id}`);
  }
  const sceneList = (scenes.results || []).map(sceneOut);
  const payload = {
    id: publicView ? undefined : row.id,
    slug: row.slug,
    title: row.title,
    blurb: row.blurb,
    linkLabel: row.link_label,
    linkUrl: row.link_url,
    views: row.views,
    spin: row.spin || 0,
    pins: Array.isArray(pins) ? pins : [],
    hasPlan,
    pdfName: row.pdf_name || (attachments[0] ? attachments[0].name : ""),
    attachments,
    contact: info.contact || {},
    gallery: Array.isArray(info.gallery) ? info.gallery : [],
    logo: !!info.logo && ownerCaps.customBranding,
    branding: ownerCaps.customBranding ? branding : {
      hideWatermark: false,
      logoUrl: "",
      loaderStyle: "spinner",
      loaderColor: "#f6f1e8",
      loaderBg: "#14110e",
      loaderText: "",
      qrFg: "#1c1917",
      qrBg: "#ffffff",
      qrPattern: "square",
      qrLogo: false
    },
    ownerPlan: ownerCaps.plan,
    commercial: !!row.commercial && ownerCaps.commercial,
    folder: row.folder || "",
    scenes: publicView
      ? sceneList.map((s) => ({
          id: s.id,
          title: s.title,
          sort: s.sort,
          opening: s.opening,
          orient: s.orient,
          hotspots: s.hotspots,
          width: s.width,
          height: s.height,
          tiles: s.tiles,
          upscaled: s.upscaled,
          bright: s.bright,
          contrast: s.contrast,
          grade: s.grade
        }))
      : sceneList
  };
  if (!publicView) {
    payload.guest = !!row.guest;
    payload.expiresAt = row.expires_at || null;
    payload.lastViewedAt = row.last_viewed_at || null;
    payload.dwell = row.dwell_ms || 0;
    payload.countries = countries;
    payload.locked = !!row.password_hash;
    payload.editors = info.editors || [];
    payload.branding = branding;
    payload.logo = !!info.logo;
  }
  return payload;
}

function buildAnalytics(row, scenes) {
  const countries = parseJson(row.countries, {});
  const sceneStats = [];
  const hotspotStats = [];
  let totalClicks = 0;
  let totalSceneViews = 0;
  for (const s of scenes) {
    const hotspots = parseJson(s.hotspots, []);
    const hc = parseJson(s.hotspot_clicks, {});
    const clicks = s.clicks || 0;
    totalClicks += clicks;
    totalSceneViews += s.views || 0;
    sceneStats.push({
      id: s.id,
      title: s.title || "Scene",
      views: s.views || 0,
      dwell: s.dwell_ms || 0,
      clicks
    });
    for (const spot of Array.isArray(hotspots) ? hotspots : []) {
      const c = Number(hc[spot.id]) || 0;
      if (c > 0) {
        hotspotStats.push({
          id: spot.id,
          title: spot.title || "Point",
          kind: spot.kind || "note",
          sceneTitle: s.title || "Scene",
          clicks: c
        });
      }
    }
  }
  sceneStats.sort((a, b) => (b.views - a.views) || (b.dwell - a.dwell) || (b.clicks - a.clicks));
  hotspotStats.sort((a, b) => b.clicks - a.clicks);
  const locations = Object.entries(countries)
    .map(([code, count]) => ({ code, count: Number(count) || 0 }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
  const views = row.views || 0;
  const dwell = row.dwell_ms || 0;
  return {
    id: row.id,
    title: row.title,
    slug: row.slug || "",
    views,
    dwell,
    avgDwell: views > 0 ? Math.round(dwell / views) : 0,
    totalClicks,
    totalSceneViews,
    favoriteScene: sceneStats[0] || null,
    scenes: sceneStats,
    topHotspots: hotspotStats.slice(0, 12),
    locations,
    countries,
    guest: !!row.guest,
    expiresAt: row.expires_at || null,
    lastViewedAt: row.last_viewed_at || null
  };
}

const editLookups = new WeakMap();

function editCollection(request, env) {
  if (editLookups.has(request)) return editLookups.get(request);
  const token = request.headers.get("x-pano-edit") || "";
  const lookup = !token || !env.PANORAMA_SECRET
    ? Promise.resolve(null)
    : hmac(env.PANORAMA_SECRET, "edit:" + token).then((hash) => env.PANORAMA_DB.prepare(
      "select * from collections where edit_hash = ? and guest = 1"
    ).bind(hash).first());
  editLookups.set(request, lookup);
  return lookup;
}

async function gateName(slug) {
  return "pano_open_" + (await sha256("gate:" + slug)).slice(0, 8);
}

function gateCookie(name, slug, exp, sig, request) {
  const isHttps = !request || new URL(request.url).protocol === "https:";
  const secure = `HttpOnly; ${isHttps ? "Secure; " : ""}SameSite=Lax; Path=/`;
  return `${name}=${encodeURIComponent(slug + "." + exp + "." + sig)}; ${secure}; Max-Age=43200`;
}

async function gateOpen(request, env, row) {
  if (!row.password_hash) return true;
  if (!env.PANORAMA_SECRET || !row.slug) return false;
  const values = [readCookie(request, await gateName(row.slug)), readCookie(request, "pano_open")];
  for (const value of values) {
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== row.slug) continue;
    const exp = Number(parts[1]);
    if (!exp || exp < Date.now()) continue;
    const expect = await hmac(env.PANORAMA_SECRET, `gate:${row.slug}:${exp}`);
    if (safeEqual(parts[2], expect)) return true;
  }
  return false;
}

async function countView(env, row, request) {
  const now = Date.now();
  const raw = String((request.cf && request.cf.country) || request.headers.get("cf-ipcountry") || "");
  const country = /^[A-Z]{2}$/.test(raw) && raw !== "XX" && raw !== "T1" ? raw : "";
  const countries = "(case when json_valid(countries) then countries else '{}' end)";
  await env.PANORAMA_DB.prepare(
    `update collections set views = views + 1, last_viewed_at = ?,
     expires_at = case when guest = 1 then ? else expires_at end,
     countries = case when ? = '' then countries
       else json_set(${countries}, '$."' || ? || '"', coalesce(json_extract(${countries}, '$."' || ? || '"'), 0) + 1) end
     where id = ?`
  ).bind(now, now + GUEST_TTL_MS, country, country, country, row.id).run();
}

async function freshSlug(env) {
  for (let i = 0; i < 6; i++) {
    const slug = randomToken(9);
    const clash = await env.PANORAMA_DB.prepare("select id from collections where slug = ?").bind(slug).first();
    if (!clash) return slug;
  }
  return "";
}

function sceneMediaKeys(sceneId, tileCount = 0) {
  const keys = [`scene:${sceneId}`, `preview:${sceneId}`];
  const n = Math.min(MAX_TILES, Math.max(0, Number(tileCount) || 0));
  for (let i = 0; i < n; i++) keys.push(`tile:${sceneId}:${i}`);
  return keys;
}

async function deleteSceneMedia(env, sceneId, tileCount = 0) {
  await mediaDelete(env, sceneMediaKeys(sceneId, tileCount));
}

async function removeCollection(env, row) {
  const db = env.PANORAMA_DB;
  const scenes = await db.prepare("select id, tiles from scenes where collection_id = ?").bind(row.id).all();
  const keys = [`plan:${row.id}`, `pdf:${row.id}`, `logo:${row.id}`];
  for (const scene of scenes.results || []) keys.push(...sceneMediaKeys(scene.id, scene.tiles || 0));
  const info = parseInfo(row.info);
  for (const gid of Array.isArray(info.gallery) ? info.gallery : []) keys.push(`gallery:${row.id}:${gid}`);
  for (const file of parseAttachments(row)) {
    if (file.id && file.id !== "legacy") keys.push(`file:${row.id}:${file.id}`);
  }
  await mediaDelete(env, keys);
  await db.batch([
    db.prepare("delete from scenes where collection_id = ?").bind(row.id),
    db.prepare("delete from collection_editors where collection_id = ?").bind(row.id),
    db.prepare("delete from collections where id = ?").bind(row.id)
  ]);
  return keys.length + 2;
}

async function cleanupExpired(env) {
  const db = env.PANORAMA_DB;
  const now = Date.now();
  try {
    await db.batch([
      db.prepare("delete from codes where expires_at < ?").bind(now - 24 * 60 * 60 * 1000),
      db.prepare("delete from sessions where expires_at < ?").bind(now),
      db.prepare("delete from attempts where reset_at < ?").bind(now)
    ]);
  } catch (err) {
    console.error("panorama cleanup failed", err);
  }
}

export async function purgeExpiredGuests(env, opts = {}) {
  if (!env || !env.PANORAMA_DB) return 0;
  await ensureSchema(env);
  const max = Math.max(1, Math.min(200, Number(opts.max) || 25));
  const budget = 800;
  let removed = 0;
  let ops = 0;
  while (removed < max && ops < budget) {
    const limit = Math.min(25, max - removed);
    const expired = await env.PANORAMA_DB.prepare(
      "select * from collections where guest = 1 and expires_at is not null and expires_at < ? limit ?"
    ).bind(Date.now(), limit).all();
    const rows = expired.results || [];
    for (const row of rows) {
      ops += await removeCollection(env, row);
      removed += 1;
      if (ops >= budget) break;
    }
    if (rows.length < limit) break;
  }
  await cleanupExpired(env);
  return removed;
}

async function serveApp(request, env, noindex = true, referrer = "strict-origin-when-cross-origin") {
  const asset = new URL("/panorama/index.html", request.url);
  const res = await env.ASSETS.fetch(new Request(asset, { headers: request.headers }));
  const headers = new Headers(res.headers);
  if (noindex) headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", referrer);
  if (!noindex) {
    return new Response(res.body, { status: res.status, headers });
  }
  let html = await res.text();
  if (!/<meta name="robots"/i.test(html)) {
    html = html.replace("<head>", '<head>\n  <meta name="robots" content="noindex, nofollow" />');
  }
  return new Response(html, { status: res.status, headers });
}

function publicCacheHeader(versioned) {
  return versioned ? "public, max-age=31536000, immutable" : "public, max-age=86400, stale-while-revalidate=604800";
}

function mediaCacheHeader(collection, versioned) {
  if (!collection || !collection.slug) return "private, no-store";
  if (collection.password_hash) return "private, max-age=3600";
  return publicCacheHeader(versioned);
}

async function serveShell(request, env) {
  const res = await env.ASSETS.fetch(request);
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function serveStatic(request, env, pathname) {
  const res = await env.ASSETS.fetch(request);
  const type = res.headers.get("content-type") || "";
  if (res.status === 404 || (res.ok && /text\/html/i.test(type))) {
    return new Response("Not found.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS }
    });
  }
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  if (/\.(js|css)$/i.test(pathname) && (res.ok || res.status === 304)) headers.set("cache-control", STATIC_CACHE);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function needsSecret(path, request) {
  return request.headers.has("x-pano-edit")
    || path.startsWith("/panorama/api/auth/")
    || path.startsWith("/panorama/api/guest")
    || path === "/panorama/api/edit"
    || /\/(unlock|password)$/.test(path);
}

function isStorageRoute(path) {
  return /^\/panorama\/api\/(media|file|plan|gallery|logo)\//.test(path)
    || /^\/panorama\/api\/(collections|guest)\/[0-9a-f-]{36}\/(plan|file|attachments|gallery|logo|duplicate)(\/|$)/i.test(path);
}

function sceneEtag(scene, collection, part) {
  return `"${scene.id}-${part}-${scene.bytes || 0}-${scene.tiles || 0}-${collection.updated_at || 0}"`;
}

export async function handlePanorama(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  const isRead = request.method === "GET" || request.method === "HEAD";
  if (isRead && /^\/panorama\/(?!api\/).+\.(js|css|map)$/i.test(url.pathname)) {
    return serveStatic(request, env, url.pathname);
  }
  if (request.method === "GET" && (path === "/panorama/link" || path.startsWith("/panorama/v/") || path.startsWith("/panorama/e/"))) {
    return serveApp(request, env, true, path.startsWith("/panorama/e/") ? "no-referrer" : "strict-origin-when-cross-origin");
  }
  if (isRead && (path === "/panorama" || path === "/panorama/index.html")) return serveShell(request, env);
  if (!path.startsWith("/panorama/api/")) return null;
  if (!env.PANORAMA_DB) return json({ error: "Panorama storage isn't connected." }, 503);
  if (!env.PANORAMA_SECRET && needsSecret(path, request)) {
    return json({ error: "Panorama isn't fully configured yet." }, 503);
  }
  if (isStorageRoute(path) && !hasStorage(env)) return json({ error: "Photo storage isn't connected." }, 503);

  try {
    const db = env.PANORAMA_DB;
    const publicMedia = request.method === "GET" && /^\/panorama\/api\/media\/[0-9a-f-]{36}\/(preview|tile\/\d{1,2})$/i.test(path);
    if (publicMedia) {
      const cache = edgeCache();
      const hit = cache ? await cache.match(new Request(request.url)).catch(() => null) : null;
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set("cache-control", publicCacheHeader(!!url.searchParams.get("v")));
        if (matchesEtag(request, headers.get("etag"))) return notModified(headers);
        return new Response(hit.body, { status: 200, headers });
      }
    }

    await ensureSchema(env);

    if (request.method === "POST" && path === "/panorama/api/stripe/webhook") {
      if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Billing isn't configured." }, 503);
      const raw = await request.text();
      if (!(await verifyStripe(env.STRIPE_WEBHOOK_SECRET, request.headers.get("stripe-signature"), raw))) {
        return json({ error: "Invalid signature." }, 400);
      }
      const event = parseJson(raw, {});
      const obj = (event.data && event.data.object) || {};
      const customer = typeof obj.customer === "string" ? obj.customer : ((obj.customer && obj.customer.id) || "");
      if (event.type === "checkout.session.completed") {
        const ref = String(obj.client_reference_id || "").match(/^([0-9a-f-]{36})(?:_(pro|business))?$/i);
        const meta = obj.metadata || {};
        const plan = normalizePlan(meta.plan || (ref && ref[2]) || "");
        if (ref && plan !== "free") {
          const subscription = typeof obj.subscription === "string" ? obj.subscription : ((obj.subscription && obj.subscription.id) || null);
          await db.batch([
            db.prepare("update users set plan = ? where id = ?").bind(plan, ref[1]),
            db.prepare(
              `insert into billing (user_id, customer_id, subscription_id, plan, updated_at) values (?, ?, ?, ?, ?)
               on conflict(user_id) do update set customer_id = coalesce(excluded.customer_id, billing.customer_id),
               subscription_id = excluded.subscription_id, plan = excluded.plan, updated_at = excluded.updated_at`
            ).bind(ref[1], customer || null, subscription, plan, Date.now())
          ]);
        } else {
          console.error("panorama stripe checkout without a usable client_reference_id or plan", event.id);
        }
      } else if (event.type === "customer.subscription.deleted" && customer) {
        await db.batch([
          db.prepare("update users set plan = 'free' where id in (select user_id from billing where customer_id = ?)").bind(customer),
          db.prepare("update billing set plan = 'free', subscription_id = null, updated_at = ? where customer_id = ?").bind(Date.now(), customer)
        ]);
      }
      return json({ received: true });
    }

    if (request.method === "POST" && path === "/panorama/api/auth/send") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      if (!isEmail(email)) return json({ error: "That doesn't look like an email address." }, 400);
      return sendCode(request, env, email);
    }

    if (request.method === "POST" && path === "/panorama/api/auth/code") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").replace(/\D/g, "");
      if (!isEmail(email) || code.length !== 6) return json({ error: "Enter the 6-digit code." }, 400);
      const session = await verifyCode(env, email, code);
      if (!session) return json({ error: "That code didn't match. Try the latest email." }, 401);
      const limits = planLimits(session.user);
      return json(
        { ok: true, email: session.user.email, plan: limits.plan, limits },
        200,
        { "set-cookie": sessionCookie(session.token, SESSION_TTL_MS / 1000, request) }
      );
    }

    if (request.method === "POST" && path === "/panorama/api/auth/link") {
      const body = await request.json().catch(() => ({}));
      const token = String(body.token || "");
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return json({ error: "This link has expired." }, 400);
      const session = await verifyLink(env, token);
      if (!session) return json({ error: "This link has expired." }, 400);
      const limits = planLimits(session.user);
      return json(
        { ok: true, email: session.user.email, plan: limits.plan, limits },
        200,
        { "set-cookie": sessionCookie(session.token, SESSION_TTL_MS / 1000, request) }
      );
    }

    if (request.method === "POST" && path === "/panorama/api/auth/out") {
      const token = cookieToken(request);
      if (token) {
        await env.PANORAMA_DB.prepare("delete from sessions where token_hash = ?").bind(await sha256(token)).run();
      }
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0, request) });
    }

    if (request.method === "GET" && path === "/panorama/api/me") {
      const user = await userFromRequest(request, env);
      if (!user) return json({ user: null, tiers: TIERS, maxImageBytes: maxImageBytes(env) });
      const stats = await env.PANORAMA_DB.prepare(
        "select count(*) as total, sum(case when slug is not null then 1 else 0 end) as published, coalesce(sum(views), 0) as views from collections where user_id = ?"
      ).bind(user.id).first();
      const caps = planLimits(user);
      const month = new Date().toISOString().slice(0, 7);
      let used = 0;
      try {
        const usage = await env.PANORAMA_DB.prepare(
          "select bytes from usage where user_id = ? and month = ?"
        ).bind(user.id, month).first();
        used = usage && usage.bytes ? usage.bytes : 0;
      } catch (err) {
        used = 0;
      }
      return json({
        user: { email: user.email, plan: caps.plan },
        limits: { ...caps, bytes: Math.min(caps.bytes, maxImageBytes(env)) },
        maxImageBytes: Math.min(caps.bytes, maxImageBytes(env)),
        usage: used,
        published: stats && stats.published ? stats.published : 0,
        totalTours: stats && stats.total ? stats.total : 0,
        totalViews: stats && stats.views ? stats.views : 0,
        tiers: TIERS
      });
    }

    const user = await userFromRequest(request, env);

    if (request.method === "POST" && path === "/panorama/api/account/plan") {
      if (!user) return json({ error: "Sign in to manage your plan." }, 401);
      const body = await request.json().catch(() => ({}));
      const next = normalizePlan(body.plan);
      if (next !== "free" && env.ALLOW_SELF_SERVE_PLAN !== "true") {
        if (!env.STRIPE_CHECKOUT_URL) return json({ error: "Upgrades aren't available yet." }, 402);
        let target;
        try {
          target = new URL(env.STRIPE_CHECKOUT_URL);
        } catch (err) {
          console.error("panorama STRIPE_CHECKOUT_URL is not a valid URL");
          return json({ error: "Upgrades aren't available yet." }, 402);
        }
        target.searchParams.set("plan", next);
        target.searchParams.set("client_reference_id", `${user.id}_${next}`);
        if (user.email) target.searchParams.set("prefilled_email", user.email);
        return json({ checkoutUrl: target.toString(), plan: next });
      }
      await env.PANORAMA_DB.prepare("update users set plan = ? where id = ?").bind(next, user.id).run();
      const limits = TIERS[next];
      return json({ ok: true, plan: next, limits });
    }

    if (request.method === "GET" && path.startsWith("/panorama/api/v/")) {
      const slug = decodePart(path.slice("/panorama/api/v/".length).split("/")[0]);
      if (slug === null) return json({ error: "This link doesn't exist." }, 400);
      const row = await env.PANORAMA_DB.prepare(
        "select * from collections where slug = ?"
      ).bind(slug).first();
      if (!row) return json({ error: "This link doesn't exist." }, 404);
      if (row.guest && row.expires_at && row.expires_at < Date.now()) {
        await removeCollection(env, row);
        return json({ error: "This link expired after 90 days without a view." }, 404);
      }
      if (!(user && user.id === row.user_id)) {
        await later(ctx, countView(env, row, request));
        row.views += 1;
      }
      if (!(await gateOpen(request, env, row))) {
        const info = parseInfo(row.info);
        const ownerCaps = await ownerPlanOf(env, row);
        return json({
          locked: true,
          title: row.title,
          slug: row.slug,
          logo: !!info.logo && ownerCaps.customBranding,
          branding: ownerCaps.customBranding ? parseBranding(row.branding) : null
        });
      }
      const payload = await collectionPayload(env, row, true);
      if (row.password_hash) return json(payload, 200, { "cache-control": "private, no-store" });
      const etag = `W/"${row.id}-${row.updated_at || 0}-${payload.ownerPlan}-${payload.scenes.length}"`;
      const cacheHeaders = { "cache-control": "public, max-age=30, stale-while-revalidate=300", etag };
      if (matchesEtag(request, etag)) return notModified({ ...SECURITY_HEADERS, ...cacheHeaders });
      return json(payload, 200, cacheHeaders);
    }

    const beat = path.match(/^\/panorama\/api\/v\/([^/]+)\/beat$/);
    if (beat && request.method === "POST") {
      if (!beatAllowed(clientIp(request))) return json({ ok: true });
      const slug = decodePart(beat[1]);
      if (slug === null) return json({ error: "This link doesn't exist." }, 400);
      const row = await env.PANORAMA_DB.prepare("select id, slug, user_id, password_hash from collections where slug = ?").bind(slug).first();
      if (!row) return json({ ok: true });
      if (row.password_hash && !(await gateOpen(request, env, row))) return json({ error: "This tour is locked." }, 403);
      if (user && user.id === row.user_id) return json({ ok: true });
      const body = await request.json().catch(() => ({}));
      const ms = Math.max(0, Math.min(60000, Number(body.ms) || 0));
      const statements = [];
      if (ms) {
        statements.push(db.prepare("update collections set dwell_ms = dwell_ms + ? where id = ?").bind(ms, row.id));
      }
      const sceneId = typeof body.sceneId === "string" && isUuid(body.sceneId) ? body.sceneId : "";
      if (sceneId) {
        const viewInc = body.sceneView ? 1 : 0;
        const clickInc = body.spotId ? 1 : 0;
        const spot = typeof body.spotId === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(body.spotId) ? body.spotId : "";
        const clicks = "(case when json_valid(hotspot_clicks) then hotspot_clicks else '{}' end)";
        if (ms || viewInc || clickInc) {
          statements.push(db.prepare(
            `update scenes set dwell_ms = dwell_ms + ?, views = views + ?, clicks = clicks + ?,
             hotspot_clicks = case
               when ? = '' then hotspot_clicks
               when length(hotspot_clicks) > 8000 and json_extract(${clicks}, '$."' || ? || '"') is null then hotspot_clicks
               else json_set(${clicks}, '$."' || ? || '"', coalesce(json_extract(${clicks}, '$."' || ? || '"'), 0) + 1)
             end
             where id = ? and collection_id = ?`
          ).bind(ms, viewInc, clickInc, spot, spot, spot, spot, sceneId, row.id));
        }
      }
      if (statements.length) await db.batch(statements);
      return json({ ok: true });
    }

    const unlock = path.match(/^\/panorama\/api\/v\/([^/]+)\/unlock$/);
    if (unlock && request.method === "POST") {
      const slug = decodePart(unlock[1]);
      if (slug === null) return json({ error: "This link doesn't exist." }, 400);
      const ipHash = await sha256(clientIp(request));
      if (await hitLimit(env, `unlock:${ipHash}:${slug.slice(0, 64)}`, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)) {
        return json({ error: "Too many tries. Wait 15 minutes and try again." }, 429, { "retry-after": "900" });
      }
      const row = await env.PANORAMA_DB.prepare("select id, slug, password_hash from collections where slug = ?").bind(slug).first();
      if (!row || !row.password_hash) return json({ error: "This link doesn't exist." }, 404);
      const body = await request.json().catch(() => ({}));
      const password = String(body.password || "");
      const check = await checkPassword(env, password, row.password_hash);
      if (!check.ok) return json({ error: "That password didn't match." }, 401);
      if (check.legacy) {
        await later(ctx, hashPassword(password).then((next) => db.prepare(
          "update collections set password_hash = ? where id = ? and password_hash = ?"
        ).bind(next, row.id, row.password_hash).run()));
      }
      const exp = Date.now() + 12 * 60 * 60 * 1000;
      const sig = await hmac(env.PANORAMA_SECRET, `gate:${row.slug}:${exp}`);
      return json({ ok: true }, 200, { "set-cookie": gateCookie(await gateName(row.slug), row.slug, exp, sig, request) });
    }

    const sceneRow = async (sceneId) => {
      const row = await db.prepare(
        `select c.*, s.id as scene_id, s.tiles as scene_tiles, s.bytes as scene_bytes, s.mime as scene_mime, s.upscaled as scene_upscaled, u.plan as owner_plan
         from scenes s join collections c on c.id = s.collection_id left join users u on u.id = c.user_id where s.id = ?`
      ).bind(sceneId).first();
      if (!row) return null;
      return {
        collection: row,
        scene: { id: row.scene_id, tiles: row.scene_tiles || 0, bytes: row.scene_bytes || 0, mime: row.scene_mime, upscaled: row.scene_upscaled || 0 },
        plan: row.guest || row.user_id === "guest" ? TIERS.guest : planLimits({ id: row.user_id, plan: row.owner_plan })
      };
    };

    const readableScene = async (sceneId) => {
      const target = await sceneRow(sceneId);
      if (!target) return null;
      const collection = target.collection;
      const edit = request.headers.get("x-pano-edit") ? await editCollection(request, env) : null;
      const allowed = (collection.slug && await gateOpen(request, env, collection))
        || (user && user.id === collection.user_id)
        || (edit && edit.id === collection.id)
        || (user && isEditor(collection, user));
      return allowed ? target : null;
    };

    const versioned = !!url.searchParams.get("v");

    const mediaPreview = path.match(/^\/panorama\/api\/media\/([0-9a-f-]{36})\/preview$/i);
    if (mediaPreview && request.method === "GET") {
      const target = await readableScene(mediaPreview[1]);
      if (!target) return json({ error: "Missing preview." }, 404);
      const isPublic = !!target.collection.slug && !target.collection.password_hash;
      const etag = sceneEtag(target.scene, target.collection, "p");
      const headers = mediaHeaders({ "cache-control": mediaCacheHeader(target.collection, versioned), etag });
      if (matchesEtag(request, etag)) return notModified(headers);
      const obj = await mediaGet(env, `preview:${target.scene.id}`);
      if (!obj) return json({ error: "Missing preview." }, 404);
      const buf = await mediaBuffer(obj);
      headers["content-type"] = obj.type || detectImageMime(buf, "image/jpeg");
      if (isPublic) edgeStore(ctx, request, buf, headers);
      return new Response(buf, { headers });
    }

    const mediaTile = path.match(/^\/panorama\/api\/media\/([0-9a-f-]{36})\/tile\/(\d{1,2})$/i);
    if (mediaTile && request.method === "GET") {
      const idx = Number(mediaTile[2]);
      if (idx < 0 || idx >= MAX_TILES) return json({ error: "Invalid tile." }, 400);
      const target = await readableScene(mediaTile[1]);
      if (!target) return json({ error: "Missing tile." }, 404);
      const isPublic = !!target.collection.slug && !target.collection.password_hash;
      const etag = sceneEtag(target.scene, target.collection, "t" + idx);
      const headers = mediaHeaders({ "cache-control": mediaCacheHeader(target.collection, versioned), etag });
      if (matchesEtag(request, etag)) return notModified(headers);
      const obj = await mediaGet(env, `tile:${target.scene.id}:${idx}`);
      if (!obj) return json({ error: "Missing tile." }, 404);
      if (!(await noteView(env, target.collection.user_id, obj.length, target.plan))) {
        mediaDiscard(obj);
        return json({ error: "This tour has reached its monthly viewing quota." }, 402);
      }
      const buf = await mediaBuffer(obj);
      headers["content-type"] = obj.type || detectImageMime(buf, "image/jpeg");
      if (isPublic) edgeStore(ctx, request, buf, headers);
      return new Response(buf, { headers });
    }

    const media = path.match(/^\/panorama\/api\/media\/([0-9a-f-]{36})$/i);
    if (media && request.method === "GET") {
      const target = await readableScene(media[1]);
      if (!target) return json({ error: "Missing photo." }, 404);
      const etag = sceneEtag(target.scene, target.collection, "o");
      const headers = mediaHeaders({ "cache-control": mediaCacheHeader(target.collection, versioned), etag });
      if (matchesEtag(request, etag)) return notModified(headers);
      const obj = await mediaGet(env, `scene:${target.scene.id}`, request.headers.get("range"));
      if (!obj) return json({ error: "Missing photo." }, 404);
      if (!(await noteView(env, target.collection.user_id, obj.length, target.plan))) {
        mediaDiscard(obj);
        return json({ error: "This tour has reached its monthly viewing quota." }, 402);
      }
      headers["content-type"] = obj.buf ? detectImageMime(obj.buf, target.scene.mime || "image/jpeg") : (obj.type || target.scene.mime || "image/jpeg");
      if (obj.ranged) headers["accept-ranges"] = "bytes";
      if (obj.partial) {
        headers["content-range"] = `bytes ${obj.start}-${obj.end}/${obj.size}`;
        headers["content-length"] = String(obj.length);
        return new Response(obj.body, { status: 206, headers });
      }
      return new Response(obj.body, { headers });
    }

    const extraGet = path.match(/^\/panorama\/api\/(plan|file)\/([A-Za-z0-9_-]{6,36})(?:\/([A-Za-z0-9_-]{4,48}))?$/);
    if (extraGet && request.method === "GET") {
      const kind = extraGet[1];
      const ref = extraGet[2];
      const fileId = extraGet[3] || "";
      let row = await env.PANORAMA_DB.prepare("select * from collections where slug = ?").bind(ref).first();
      let allowed = row && await gateOpen(request, env, row);
      if (!row && isUuid(ref)) {
        row = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(ref).first();
        const edit = await editCollection(request, env);
        allowed = row && (
          (user && user.id === row.user_id)
          || (user && isEditor(row, user))
          || (edit && edit.id === row.id)
        );
      }
      if (!row || !allowed) return json({ error: "Missing file." }, 404);
      let key = `plan:${row.id}`;
      let name = safeFilename(row.pdf_name || "Guide.pdf");
      if (kind === "file") {
        const attachments = parseAttachments(row);
        const match = fileId ? attachments.find((a) => a.id === fileId) : attachments[0];
        if (match && match.id !== "legacy") {
          key = `file:${row.id}:${match.id}`;
          name = safeFilename(match.name);
        } else {
          key = `pdf:${row.id}`;
          if (match) name = safeFilename(match.name);
        }
      }
      const obj = await mediaGet(env, key, kind === "file" ? request.headers.get("range") : "");
      if (!obj) return json({ error: "Missing file." }, 404);
      if (!(await noteView(env, row.user_id, obj.length, await ownerPlanOf(env, row)))) {
        mediaDiscard(obj);
        return json({ error: "This tour has reached its monthly viewing quota." }, 402);
      }
      const disp = url.searchParams.get("download") === "1" ? "attachment" : "inline";
      const headers = mediaHeaders({ "cache-control": mediaCacheHeader(row, false) });
      if (kind === "file") {
        headers["content-type"] = "application/pdf";
        headers["content-security-policy"] = "sandbox";
        headers["content-disposition"] = contentDisposition(disp, name);
      } else {
        headers["content-type"] = detectImageMime(await mediaBuffer(obj), "image/jpeg");
      }
      if (obj.ranged) headers["accept-ranges"] = "bytes";
      if (obj.partial) {
        headers["content-range"] = `bytes ${obj.start}-${obj.end}/${obj.size}`;
        headers["content-length"] = String(obj.length);
        return new Response(obj.body, { status: 206, headers });
      }
      return new Response(obj.buf || obj.body, { headers });
    }

    const pieceGet = path.match(/^\/panorama\/api\/(gallery|logo)\/([A-Za-z0-9_-]{6,36})(?:\/([0-9a-f-]{36}))?$/i);
    if (pieceGet && request.method === "GET") {
      const ref = pieceGet[2];
      let row = await env.PANORAMA_DB.prepare("select * from collections where slug = ?").bind(ref).first();
      let allowed = row && await gateOpen(request, env, row);
      if (!row && isUuid(ref)) {
        row = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(ref).first();
        const edit = await editCollection(request, env);
        allowed = row && (
          (user && user.id === row.user_id)
          || (user && isEditor(row, user))
          || (edit && edit.id === row.id)
        );
      }
      if (!row || !allowed) return json({ error: "Missing file." }, 404);
      const key = pieceGet[1] === "logo" ? `logo:${row.id}` : `gallery:${row.id}:${pieceGet[3]}`;
      if (pieceGet[1] === "gallery" && !pieceGet[3]) return json({ error: "Missing file." }, 404);
      const obj = await mediaGet(env, key);
      if (!obj) return json({ error: "Missing file." }, 404);
      if (!(await noteView(env, row.user_id, obj.length, await ownerPlanOf(env, row)))) {
        mediaDiscard(obj);
        return json({ error: "This tour has reached its monthly viewing quota." }, 402);
      }
      const buf = await mediaBuffer(obj);
      return new Response(buf, {
        headers: mediaHeaders({
          "content-type": detectImageMime(buf, pieceGet[1] === "logo" ? "image/png" : "image/jpeg"),
          "cache-control": mediaCacheHeader(row, false)
        })
      });
    }

    if (request.method === "GET" && path === "/panorama/api/edit") {
      const edit = await editCollection(request, env);
      if (!edit) return json({ error: "This edit link doesn't exist." }, 404);
      if (edit.expires_at && edit.expires_at < Date.now()) {
        await removeCollection(env, edit);
        return json({ error: "This upload expired after 90 days without a view." }, 404);
      }
      return json(await collectionPayload(env, edit, false));
    }

    const canWriteScene = async (sceneId) => {
      const target = await sceneRow(sceneId);
      if (!target) return null;
      const collection = target.collection;
      if (user && !collection.guest && (collection.user_id === user.id || isEditor(collection, user))) return target;
      const edit = request.headers.get("x-pano-edit") ? await editCollection(request, env) : null;
      if (edit && edit.id === collection.id) return target;
      return null;
    };

    if (mediaPreview && request.method === "PUT") {
      const target = await canWriteScene(mediaPreview[1]);
      if (!target) return json({ error: "Save the tour before uploading preview media." }, 404);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 2 * 1024 * 1024) return json({ error: "Preview image is too large." }, 413);
      await mediaPut(env, `preview:${target.scene.id}`, buf, detectImageMime(buf, "image/jpeg"));
      return json({ ok: true, bytes: buf.byteLength });
    }

    if (mediaTile && request.method === "PUT") {
      const idx = Number(mediaTile[2]);
      if (idx < 0 || idx >= MAX_TILES) return json({ error: "Invalid tile index." }, 400);
      const target = await canWriteScene(mediaTile[1]);
      if (!target) return json({ error: "Save the tour before uploading tiles." }, 404);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 8 * 1024 * 1024) return json({ error: "Tile is too large." }, 413);
      await mediaPut(env, `tile:${target.scene.id}:${idx}`, buf, detectImageMime(buf, "image/jpeg"));
      const total = Math.min(MAX_TILES, Number(request.headers.get("x-pano-tiles")) || (idx + 1));
      const saved = await db.prepare(
        "update scenes set tiles = max(tiles, ?) where id = ? returning tiles"
      ).bind(total, target.scene.id).first();
      return json({ ok: true, idx, tiles: saved ? saved.tiles : total });
    }

    if (media && request.method === "PUT") {
      const target = await canWriteScene(media[1]);
      if (!target) return json({ error: "Save the tour before uploading photos." }, 404);
      const cap = Math.min(target.plan.bytes, maxImageBytes(env));
      const tooBig = json({ error: `Each image must be ${mbText(cap)} or smaller.` }, 413);
      if (Number(request.headers.get("content-length")) > cap) return tooBig;
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > cap) return tooBig;
      const collection = target.collection;
      if (collection.guest && collection.ip_hash) {
        const used = await db.prepare(
          `select coalesce(sum(s.bytes), 0) as n from scenes s join collections c on c.id = s.collection_id
           where c.guest = 1 and c.ip_hash = ? and s.id != ?`
        ).bind(collection.ip_hash, target.scene.id).first();
        if (used && used.n + buf.byteLength > GUEST_STORAGE_BYTES) {
          return json({ error: "Quick uploads from this network are limited to 500 MB. Sign in for more space." }, 413);
        }
      }
      const mime = detectImageMime(buf, request.headers.get("content-type") || "image/jpeg");
      const width = Number(request.headers.get("x-pano-width")) || 0;
      const height = Number(request.headers.get("x-pano-height")) || 0;
      const upscaled = request.headers.get("x-pano-upscaled") === "1" ? 1 : target.scene.upscaled;
      await mediaPut(env, `scene:${target.scene.id}`, buf, mime);
      await db.batch([
        db.prepare(
          `update scenes set bytes = ?, mime = ?, upscaled = ?,
           width = case when ? > 0 then ? else width end,
           height = case when ? > 0 then ? else height end
           where id = ?`
        ).bind(buf.byteLength, mime, upscaled, width, width, height, height, target.scene.id),
        db.prepare("update collections set updated_at = ? where id = ?").bind(Date.now(), collection.id)
      ]);
      return json({ ok: true, bytes: buf.byteLength, mime });
    }

    if (!user) {
      const edit = await editCollection(request, env);
      if (request.method === "POST" && path === "/panorama/api/guest") {
        if (!env.PANORAMA_SECRET) return json({ error: "Quick sharing isn't available right now." }, 503);
        await later(ctx, purgeExpiredGuests(env, { max: 25 }));
        const ipHash = await sha256(clientIp(request));
        const recent = await env.PANORAMA_DB.prepare(
          "select count(*) as n from collections where guest = 1 and ip_hash = ? and created_at > ?"
        ).bind(ipHash, Date.now() - 60 * 60 * 1000).first();
        if (recent && recent.n >= 5) return json({ error: "That's enough new quick links for this hour. Sign in for more." }, 429);
        const body = await request.json().catch(() => ({}));
        const token = randomToken(24);
        const saved = await saveCollection(env, { id: "guest" }, body, {
          guest: true,
          editHash: await hmac(env.PANORAMA_SECRET, "edit:" + token),
          ipHash,
          expiresAt: Date.now() + GUEST_TTL_MS
        });
        if (saved.error) return json({ error: saved.error }, saved.status);
        return json({ id: saved.id, editToken: token, sceneIds: saved.remap });
      }
      const guestUpdate = path.match(/^\/panorama\/api\/guest\/([0-9a-f-]{36})$/i);
      if (guestUpdate && request.method === "PUT" && edit && edit.id === guestUpdate[1]) {
        const body = await request.json().catch(() => ({}));
        const saved = await saveCollection(env, { id: "guest" }, body, { guest: true, collectionId: edit.id });
        if (saved.error) return json({ error: saved.error }, saved.status);
        await env.PANORAMA_DB.prepare("update collections set expires_at = ?, updated_at = ? where id = ?")
          .bind(Date.now() + GUEST_TTL_MS, Date.now(), edit.id).run();
        const fresh = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(edit.id).first();
        return json({ ...(await collectionPayload(env, fresh, false)), sceneIds: saved.remap });
      }
      const guestPublish = path.match(/^\/panorama\/api\/guest\/([0-9a-f-]{36})\/publish$/i);
      if (guestPublish && request.method === "POST" && edit && edit.id === guestPublish[1]) {
        const count = await env.PANORAMA_DB.prepare("select count(*) as n from scenes where collection_id = ?").bind(edit.id).first();
        if (!count || !count.n) return json({ error: "Add a photo before sharing a link." }, 400);
        let slug = edit.slug;
        if (!slug) {
          const next = await freshSlug(env);
          if (!next) return json({ error: "Couldn't make a link. Try again." }, 500);
          const claimed = await db.prepare(
            `update collections set slug = ?, expires_at = ?, updated_at = ? where id = ? and slug is null
             and (ip_hash is null or (select count(*) from collections g where g.guest = 1 and g.ip_hash = collections.ip_hash and g.slug is not null) < ?)`
          ).bind(next, Date.now() + GUEST_TTL_MS, Date.now(), edit.id, TIERS.guest.published).run();
          if (claimed.meta && claimed.meta.changes > 0) {
            slug = next;
          } else {
            const again = await db.prepare("select slug from collections where id = ?").bind(edit.id).first();
            slug = again && again.slug;
            if (!slug) {
              return json({ error: `Quick upload allows ${TIERS.guest.published} shared links at a time. Sign in to share more.` }, 402);
            }
          }
        }
        const origin = new URL(request.url).origin;
        return json({
          slug,
          url: `${origin}/panorama/v/${slug}`,
          edit: `${origin}/panorama/#edit=${encodeURIComponent(request.headers.get("x-pano-edit") || "")}`,
          expiresAt: Date.now() + GUEST_TTL_MS
        });
      }
      const guestPass = path.match(/^\/panorama\/api\/guest\/([0-9a-f-]{36})\/password$/i);
      if (guestPass && request.method === "POST" && edit && edit.id === guestPass[1]) {
        const body = await request.json().catch(() => ({}));
        const value = String(body.password || "");
        const hash = value ? await hashPassword(value) : null;
        await env.PANORAMA_DB.prepare("update collections set password_hash = ? where id = ?").bind(hash, edit.id).run();
        return json({ ok: true, locked: !!value });
      }
      const guestExtra = path.match(/^\/panorama\/api\/guest\/([0-9a-f-]{36})\/(plan|file|attachments)$/i);
      if (guestExtra && request.method === "PUT" && edit && edit.id === guestExtra[1]) {
        const buf = await request.arrayBuffer();
        const kind = guestExtra[2];
        const cap = kind === "plan" ? MAX_PLAN_BYTES : MAX_PDF_BYTES;
        if (!buf.byteLength || buf.byteLength > cap) return json({ error: "That file is too large." }, 413);
        if (kind === "plan") {
          await mediaPut(env, `plan:${edit.id}`, buf, detectImageMime(buf, "image/jpeg"));
          await db.prepare(`update collections set info = json_set(${INFO_JSON}, '$.plan', json('true')) where id = ?`).bind(edit.id).run();
          return json({ ok: true });
        }
        const name = safeFilename(request.headers.get("x-pano-name") || "Document.pdf");
        const fileId = isUuid(request.headers.get("x-pano-id")) ? request.headers.get("x-pano-id") : crypto.randomUUID();
        const key = `file:${edit.id}:${fileId}`;
        await mediaPut(env, key, buf, "application/pdf");
        const added = await addAttachment(env, edit.id, fileId, name, buf.byteLength);
        if (!added.ok) {
          await mediaDelete(env, key);
          return json({ error: `Up to ${MAX_ATTACHMENTS} PDF attachments per tour.` }, 400);
        }
        return json({ ok: true, id: fileId, name, bytes: buf.byteLength, attachments: added.attachments });
      }
      const guestAttachDel = path.match(/^\/panorama\/api\/guest\/([0-9a-f-]{36})\/attachments\/([A-Za-z0-9_-]{4,48})$/i);
      if (guestAttachDel && request.method === "DELETE" && edit && edit.id === guestAttachDel[1]) {
        const fileId = guestAttachDel[2];
        await mediaDelete(env, fileId === "legacy" ? `pdf:${edit.id}` : `file:${edit.id}:${fileId}`);
        return json({ ok: true, attachments: await dropAttachment(env, edit.id, fileId) });
      }
      const guestPiece = path.match(/^\/panorama\/api\/guest\/([0-9a-f-]{36})\/(gallery|logo)$/i);
      if (guestPiece && request.method === "PUT" && edit && edit.id === guestPiece[1]) {
        const kind = guestPiece[2];
        if (kind === "logo") return json({ error: "Custom brand logos are available on Pro and Business plans." }, 403);
        const buf = await request.arrayBuffer();
        const pieceId = String(request.headers.get("x-pano-id") || "");
        if (!isUuid(pieceId)) return json({ error: "That photo didn't upload." }, 400);
        if (!buf.byteLength || buf.byteLength > 4 * 1024 * 1024) return json({ error: "Gallery photos must be under 4 MB." }, 413);
        if (!(await rememberPiece(env, edit.id, kind, pieceId, buf))) return json({ error: "A tour holds up to 12 gallery photos." }, 400);
        return json({ ok: true });
      }
      const guestDelete = path.match(/^\/panorama\/api\/guest\/([0-9a-f-]{36})$/i);
      if (guestDelete && request.method === "DELETE" && edit && edit.id === guestDelete[1]) {
        await removeCollection(env, edit);
        return json({ ok: true });
      }
      return json({ error: "Sign in to continue." }, 401);
    }

    if (request.method === "GET" && path === "/panorama/api/library") {
      const owned = await env.PANORAMA_DB.prepare(
        `select c.id, c.title, c.blurb, c.link_label, c.link_url, c.slug, c.views, c.dwell_ms, c.password_hash,
                c.folder, c.commercial, c.branding, c.attachments, c.pdf_name, c.info, c.updated_at,
                (select count(*) from scenes s where s.collection_id = c.id) as scene_count,
                (select s.id from scenes s where s.collection_id = c.id order by s.sort, s.created_at limit 1) as cover_scene_id
         from collections c where c.user_id = ? order by c.updated_at desc limit 200`
      ).bind(user.id).all();
      const columns = `c.id, c.title, c.blurb, c.link_label, c.link_url, c.slug, c.views, c.dwell_ms, c.password_hash,
                c.folder, c.commercial, c.branding, c.attachments, c.pdf_name, c.info, c.updated_at,
                (select count(*) from scenes s where s.collection_id = c.id) as scene_count,
                (select s.id from scenes s where s.collection_id = c.id order by s.sort, s.created_at limit 1) as cover_scene_id`;
      const email = String(user.email || "").toLowerCase();
      let shared = [];
      try {
        const rows = await db.prepare(
          `select ${columns} from collection_editors e join collections c on c.id = e.collection_id
           where e.email = ? and c.user_id != ? order by c.updated_at desc limit 200`
        ).bind(email, user.id).all();
        shared = rows.results || [];
      } catch (err) {
        console.error("panorama editor index lookup failed", err);
      }
      if (!shared.length && email) {
        const scan = await db.prepare(
          `select ${columns} from collections c where c.user_id != ? and c.guest = 0 and c.info like ?`
        ).bind(user.id, "%" + email + "%").all();
        shared = (scan.results || []).filter((row) => isEditor(row, user));
        if (shared.length) {
          await later(ctx, db.batch(shared.map((row) => db.prepare(
            "insert or ignore into collection_editors (collection_id, email) values (?, ?)"
          ).bind(row.id, email))));
        }
      }
      const tours = [];
      const push = (row, role) => {
        const info = parseInfo(row.info);
        tours.push({
          id: row.id,
          title: row.title,
          blurb: row.blurb || "",
          linkLabel: row.link_label || "",
          linkUrl: row.link_url || "",
          slug: row.slug || "",
          views: row.views || 0,
          dwell: row.dwell_ms || 0,
          locked: !!row.password_hash,
          folder: row.folder || "",
          commercial: !!row.commercial,
          branding: parseBranding(row.branding),
          attachments: parseAttachments(row),
          sceneCount: row.scene_count || 0,
          coverSceneId: row.cover_scene_id || "",
          updatedAt: row.updated_at || 0,
          contact: info.contact || {},
          editors: info.editors || [],
          gallery: info.gallery || [],
          logo: !!info.logo,
          hasPlan: !!info.plan,
          role
        });
      };
      for (const row of owned.results || []) push(row, "owner");
      for (const row of shared) if (isEditor(row, user)) push(row, "editor");
      return json({ tours });
    }

    if (request.method === "PUT" && path === "/panorama/api/collections") {
      const body = await request.json().catch(() => ({}));
      const saved = await saveCollection(env, user, body);
      if (saved.error) return json({ error: saved.error }, saved.status);
      const row = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(saved.id).first();
      return json({ ...(await collectionPayload(env, row, false)), sceneIds: saved.remap });
    }

    const readCollection = path.match(/^\/panorama\/api\/collections\/([0-9a-f-]{36})$/i);
    if (readCollection && request.method === "GET") {
      const row = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(readCollection[1]).first();
      if (!row || (row.user_id !== user.id && !isEditor(row, user))) return json({ error: "That collection is gone." }, 404);
      return json(await collectionPayload(env, row, false));
    }

    const upscale = path.match(/^\/panorama\/api\/scenes\/([0-9a-f-]{36})\/upscale$/i);
    if (upscale && request.method === "POST") {
      const caps = planLimits(user);
      if (!caps.aiUpscale) return json({ error: "Sign in to use AI 2x upscaling." }, 402);
      const scene = await env.PANORAMA_DB.prepare("select * from scenes where id = ?").bind(upscale[1]).first();
      if (!scene) return json({ error: "Scene not found." }, 404);
      const owner = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(scene.collection_id).first();
      if (!owner || (owner.user_id !== user.id && !isEditor(owner, user))) {
        return json({ error: "Scene not found." }, 404);
      }
      if (env.UPSCALE_API_URL && hasStorage(env)) {
        const obj = await mediaGet(env, `scene:${scene.id}`);
        if (obj) {
          try {
            const upstream = await fetch(env.UPSCALE_API_URL, {
              method: "POST",
              headers: {
                "content-type": scene.mime || "image/jpeg",
                ...(env.UPSCALE_API_KEY ? { authorization: `Bearer ${env.UPSCALE_API_KEY}` } : {})
              },
              body: await mediaBuffer(obj),
              signal: AbortSignal.timeout(30000)
            });
            if (upstream.ok) {
              const out = await upstream.arrayBuffer();
              if (out.byteLength && out.byteLength <= maxImageBytes(env)) {
                await mediaPut(env, `scene:${scene.id}`, out, detectImageMime(out, scene.mime || "image/jpeg"));
                await db.batch([
                  db.prepare("update scenes set bytes = ?, upscaled = 1, width = width * 2, height = height * 2 where id = ?").bind(out.byteLength, scene.id),
                  db.prepare("update collections set updated_at = ? where id = ?").bind(Date.now(), owner.id)
                ]);
                return json({ ok: true, mode: "cloud", bytes: out.byteLength });
              }
            }
          } catch (err) {
            console.error("panorama cloud upscale failed", err);
          }
        }
      }
      return json({ ok: true, mode: "client", maxScale: 2 });
    }

    const publish = path.match(/^\/panorama\/api\/collections\/([0-9a-f-]{36})\/publish$/i);
    if (publish && request.method === "POST") {
      const row = await ownedCollection(env, user, publish[1]);
      if (!row) return json({ error: "That collection is gone." }, 404);
      const count = await env.PANORAMA_DB.prepare(
        "select count(*) as n from scenes where collection_id = ?"
      ).bind(row.id).first();
      if (!count || !count.n) return json({ error: "Add a photo before sharing a link." }, 400);
      if (!row.slug) {
        const caps = planLimits(user);
        const slug = await freshSlug(env);
        if (!slug) return json({ error: "Couldn't make a link. Try again." }, 500);
        const claimed = await db.prepare(
          `update collections set slug = ?, updated_at = ? where id = ? and user_id = ? and slug is null
           and (select count(*) from collections p where p.user_id = ? and p.slug is not null) < ?`
        ).bind(slug, Date.now(), row.id, user.id, user.id, caps.published).run();
        if (claimed.meta && claimed.meta.changes > 0) {
          row.slug = slug;
        } else {
          const again = await db.prepare("select slug from collections where id = ?").bind(row.id).first();
          if (!again || !again.slug) {
            return json({ error: `Your ${caps.label} plan includes ${caps.published} published tours. Upgrade or unpublish one to continue.` }, 402);
          }
          row.slug = again.slug;
        }
      }
      const origin = new URL(request.url).origin;
      return json({ slug: row.slug, url: `${origin}/panorama/v/${row.slug}` });
    }

    if (publish && request.method === "DELETE") {
      const row = await ownedCollection(env, user, publish[1]);
      if (!row) return json({ error: "That collection is gone." }, 404);
      await env.PANORAMA_DB.prepare("update collections set slug = null, updated_at = ? where id = ?").bind(Date.now(), row.id).run();
      return json({ ok: true });
    }

    const remove = path.match(/^\/panorama\/api\/collections\/([0-9a-f-]{36})$/i);
    if (remove && request.method === "DELETE") {
      const row = await ownedCollection(env, user, remove[1]);
      if (!row) return json({ error: "That collection is gone." }, 404);
      await removeCollection(env, row);
      return json({ ok: true });
    }

    const password = path.match(/^\/panorama\/api\/collections\/([0-9a-f-]{36})\/password$/i);
    if (password && request.method === "POST") {
      const row = await ownedCollection(env, user, password[1]);
      if (!row) return json({ error: "That collection is gone." }, 404);
      const body = await request.json().catch(() => ({}));
      const value = String(body.password || "");
      const hash = value ? await hashPassword(value) : null;
      await env.PANORAMA_DB.prepare("update collections set password_hash = ?, updated_at = ? where id = ?").bind(hash, Date.now(), row.id).run();
      return json({ ok: true, locked: !!value });
    }

    const attachment = path.match(/^\/panorama\/api\/collections\/([0-9a-f-]{36})\/(plan|file|attachments)$/i);
    if (attachment && request.method === "PUT") {
      const row = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(attachment[1]).first();
      if (!row || (row.user_id !== user.id && !isEditor(row, user))) return json({ error: "That collection is gone." }, 404);
      const buf = await request.arrayBuffer();
      const kind = attachment[2];
      const cap = kind === "plan" ? MAX_PLAN_BYTES : MAX_PDF_BYTES;
      if (!buf.byteLength || buf.byteLength > cap) return json({ error: "That file is too large." }, 413);
      if (kind === "plan") {
        await mediaPut(env, `plan:${row.id}`, buf, detectImageMime(buf, "image/jpeg"));
        await db.prepare(`update collections set info = json_set(${INFO_JSON}, '$.plan', json('true')), updated_at = ? where id = ?`)
          .bind(Date.now(), row.id).run();
        return json({ ok: true });
      }
      const name = safeFilename(request.headers.get("x-pano-name") || "Document.pdf");
      const fileId = isUuid(request.headers.get("x-pano-id")) ? request.headers.get("x-pano-id") : crypto.randomUUID();
      const key = `file:${row.id}:${fileId}`;
      await mediaPut(env, key, buf, "application/pdf");
      const added = await addAttachment(env, row.id, fileId, name, buf.byteLength);
      if (!added.ok) {
        await mediaDelete(env, key);
        return json({ error: `Up to ${MAX_ATTACHMENTS} PDF attachments per tour.` }, 400);
      }
      return json({ ok: true, id: fileId, name, bytes: buf.byteLength, attachments: added.attachments });
    }

    const attachDel = path.match(/^\/panorama\/api\/collections\/([0-9a-f-]{36})\/attachments\/([A-Za-z0-9_-]{4,48})$/i);
    if (attachDel && request.method === "DELETE") {
      const row = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(attachDel[1]).first();
      if (!row || (row.user_id !== user.id && !isEditor(row, user))) return json({ error: "That collection is gone." }, 404);
      const fileId = attachDel[2];
      await mediaDelete(env, fileId === "legacy" ? `pdf:${row.id}` : `file:${row.id}:${fileId}`);
      return json({ ok: true, attachments: await dropAttachment(env, row.id, fileId) });
    }

    const piecePut = path.match(/^\/panorama\/api\/collections\/([0-9a-f-]{36})\/(gallery|logo)$/i);
    if (piecePut && request.method === "PUT") {
      const row = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(piecePut[1]).first();
      if (!row || (row.user_id !== user.id && !isEditor(row, user))) return json({ error: "That collection is gone." }, 404);
      const kind = piecePut[2];
      const ownerCaps = await ownerPlanOf(env, row);
      if (kind === "logo" && !ownerCaps.customBranding) {
        return json({ error: "Custom brand logos require a Pro or Business plan." }, 402);
      }
      const buf = await request.arrayBuffer();
      const pieceId = String(request.headers.get("x-pano-id") || "");
      if (kind === "gallery" && !isUuid(pieceId)) return json({ error: "That photo didn't upload." }, 400);
      if (!buf.byteLength || buf.byteLength > 4 * 1024 * 1024) return json({ error: "That photo is too large (max 4 MB)." }, 413);
      if (!(await rememberPiece(env, row.id, kind, pieceId, buf))) return json({ error: "A tour holds up to 12 gallery photos." }, 400);
      return json({ ok: true });
    }

    const duplicate = path.match(/^\/panorama\/api\/collections\/([0-9a-f-]{36})\/duplicate$/i);
    if (duplicate && request.method === "POST") {
      const row = await ownedCollection(env, user, duplicate[1]);
      if (!row) return json({ error: "That collection is gone." }, 404);
      const copyId = crypto.randomUUID();
      const now = Date.now();
      const scenes = await env.PANORAMA_DB.prepare("select * from scenes where collection_id = ? order by sort, created_at").bind(row.id).all();
      const sceneList = scenes.results || [];
      const idMap = {};
      for (const s of sceneList) idMap[s.id] = crypto.randomUUID();

      const pins = parseJson(row.pins, []);
      const remappedPins = (Array.isArray(pins) ? pins : []).map((p) => ({
        ...p,
        id: crypto.randomUUID(),
        sceneId: idMap[p.sceneId] || p.sceneId
      }));

      const info = parseInfo(row.info);
      const newInfo = { ...info, gallery: [], logo: false };
      const attachments = parseAttachments(row);
      const gallerySlots = [];
      const attachSlots = [];
      const copied = [];
      const tasks = [];
      const copyTask = (from, to, done) => tasks.push(async () => {
        const result = await mediaCopy(env, from, to);
        if (!result) return;
        copied.push(to);
        if (done) done(result);
      });

      if (info.logo) copyTask(`logo:${row.id}`, `logo:${copyId}`, () => { newInfo.logo = true; });
      copyTask(`plan:${row.id}`, `plan:${copyId}`, () => { newInfo.plan = true; });
      (Array.isArray(info.gallery) ? info.gallery : []).forEach((gid, i) => {
        const ngid = crypto.randomUUID();
        copyTask(`gallery:${row.id}:${gid}`, `gallery:${copyId}:${ngid}`, () => { gallerySlots[i] = ngid; });
      });
      attachments.forEach((att, i) => {
        const nfid = crypto.randomUUID();
        const srcKey = att.id === "legacy" ? `pdf:${row.id}` : `file:${row.id}:${att.id}`;
        copyTask(srcKey, `file:${copyId}:${nfid}`, (result) => {
          attachSlots[i] = { id: nfid, name: att.name, bytes: att.bytes || result.size || 0 };
        });
      });
      for (const scene of sceneList) {
        const sid = idMap[scene.id];
        copyTask(`scene:${scene.id}`, `scene:${sid}`);
        copyTask(`preview:${scene.id}`, `preview:${sid}`);
        const tileN = Math.min(MAX_TILES, scene.tiles || 0);
        for (let i = 0; i < tileN; i++) copyTask(`tile:${scene.id}:${i}`, `tile:${sid}:${i}`);
      }

      const sceneItems = sceneList.map((scene) => {
        const spots = parseJson(scene.hotspots, []);
        const remappedSpots = (Array.isArray(spots) ? spots : []).map((sp) => ({
          ...sp,
          id: crypto.randomUUID(),
          target: idMap[sp.target] || sp.target
        }));
        return {
          id: idMap[scene.id],
          title: scene.title,
          sort: scene.sort,
          yaw: scene.yaw,
          pitch: scene.pitch,
          fov: scene.fov,
          orient_yaw: scene.orient_yaw,
          roll: scene.roll,
          flip_x: scene.flip_x,
          flip_y: scene.flip_y,
          hotspots: JSON.stringify(remappedSpots),
          width: scene.width,
          height: scene.height,
          bright: scene.bright || 0,
          contrast: scene.contrast == null ? 1 : scene.contrast,
          grade: scene.grade || "{}",
          upscaled: scene.upscaled || 0,
          bytes: scene.bytes || 0,
          tiles: scene.tiles || 0,
          mime: scene.mime || "image/jpeg"
        };
      });

      try {
        await runPool(tasks, 4);
        newInfo.gallery = gallerySlots.filter(Boolean);
        const newAttachments = attachSlots.filter(Boolean);
        const statements = [db.prepare(
          `insert into collections (id, user_id, title, blurb, link_label, link_url, slug, views, created_at, updated_at, pins, spin, pdf_name, info, folder, commercial, branding, attachments)
           values (?, ?, ?, ?, ?, ?, null, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          copyId,
          user.id,
          (row.title + " Copy").slice(0, 80),
          row.blurb || "",
          row.link_label || "",
          row.link_url || "",
          now,
          now,
          JSON.stringify(remappedPins),
          row.spin || 0,
          newAttachments[0] ? newAttachments[0].name : "",
          JSON.stringify(newInfo),
          row.folder || "",
          row.commercial || 0,
          row.branding || "{}",
          JSON.stringify(newAttachments)
        )];
        const fields = [...SCENE_FIELDS, "bytes", "tiles", "mime"];
        for (const chunk of chunkByJson(sceneItems)) {
          statements.push(db.prepare(
            `insert into scenes (${fields.join(", ")}, collection_id, user_id, created_at)
             select ${sceneFieldsSql(fields)}, ?, ?, ? from json_each(?)`
          ).bind(copyId, user.id, now, JSON.stringify(chunk)));
        }
        const editors = cleanEditors(info.editors);
        if (editors.length) {
          statements.push(db.prepare(
            "insert or ignore into collection_editors (collection_id, email) select ?, value from json_each(?)"
          ).bind(copyId, JSON.stringify(editors)));
        }
        await db.batch(statements);
      } catch (err) {
        await mediaDelete(env, copied);
        throw err;
      }
      const copy = await ownedCollection(env, user, copyId);
      return json(await collectionPayload(env, copy, false));
    }

    const activity = path.match(/^\/panorama\/api\/collections\/([0-9a-f-]{36})\/activity$/i);
    if (activity && request.method === "GET") {
      const row = await env.PANORAMA_DB.prepare("select * from collections where id = ?").bind(activity[1]).first();
      if (!row || (row.user_id !== user.id && !isEditor(row, user))) return json({ error: "That collection is gone." }, 404);
      const scenes = await env.PANORAMA_DB.prepare(
        "select id, title, views, dwell_ms, clicks, hotspots, hotspot_clicks from scenes where collection_id = ? order by sort, created_at"
      ).bind(row.id).all();
      return json(buildAnalytics(row, scenes.results || []));
    }

    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error("panorama api error", request.method, path, err);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
}
