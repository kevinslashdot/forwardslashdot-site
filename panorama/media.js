/**
 * Panorama media validation, IndexedDB storage, progressive 4x2 CDN tiling,
 * AI 2x super-resolution upscaling, auto-enhance, and customizable QR Code PNG export.
 */

import { gradeOf, deviceTextureCap, isConstrainedDevice } from "./gl.js";

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
export const MAX_PLAN_BYTES = 10 * 1024 * 1024;
export const TILE_COLS = 4;
export const TILE_ROWS = 2;
export const TILE_COUNT = TILE_COLS * TILE_ROWS;

const PROPRIETARY_EXT = /\.(insv|insp|360|lrv|dng|raw|cr2|cr3|nef|arw|orf|rw2|heic|heif|tif|tiff|psd|mp4|mov|exr|hdr)$/i;
const ALLOWED_EXT = /\.(jpe?g|png|webp)$/i;
const ALLOWED_MIME = /^image\/(jpeg|png|webp)$/i;

export function formatBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + " KB";
  if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1) + " MB";
  const gb = value / (1024 * 1024 * 1024);
  return (gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10) + " GB";
}

export function formatDuration(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function pixelSize(source) {
  return {
    width: source.naturalWidth || source.width || 0,
    height: source.naturalHeight || source.height || 0
  };
}

function u16(view, offset, little) {
  return view.getUint16(offset, !!little);
}

function jpegSize(b, view) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x00 || marker === 0xff) { i += 1; continue; }
    const len = u16(view, i + 2, false);
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return { height: u16(view, i + 5, false), width: u16(view, i + 7, false) };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(b, view) {
  if (b.length < 30) return null;
  const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (tag === "VP8X") {
    return {
      width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
    };
  }
  if (tag === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: u16(view, 26, true) & 0x3fff, height: u16(view, 28, true) & 0x3fff };
  }
  if (tag === "VP8L" && b[20] === 0x2f) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

export async function readImageSize(file) {
  const len = Math.min(file.size, 2 * 1024 * 1024);
  const buf = await file.slice(0, len).arrayBuffer();
  const b = new Uint8Array(buf);
  const view = new DataView(buf);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (b.length >= 16 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
    return webpSize(b, view);
  }
  if (b[0] === 0xff && b[1] === 0xd8) return jpegSize(b, view);
  return null;
}

/**
 * Validates file type, proprietary raw camera format rejection, 25 MB limit, and 2:1 aspect ratio.
 */
export async function validatePanoramaFile(file, maxBytes = MAX_IMAGE_BYTES) {
  const name = file && file.name ? file.name : "File";
  if (!file) return { ok: false, error: "No file selected." };
  if (PROPRIETARY_EXT.test(name)) {
    return {
      ok: false,
      error: `${name} is a proprietary or raw camera format. Convert/export it as a 2:1 JPG, PNG, or WebP (up to ${formatBytes(maxBytes)}) first.`
    };
  }
  const mimeOk = file.type ? ALLOWED_MIME.test(file.type) : ALLOWED_EXT.test(name);
  if (!mimeOk) {
    return {
      ok: false,
      error: `${name} isn't supported. Upload 2:1 JPG, PNG, or WebP images (up to ${formatBytes(maxBytes)}).`
    };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      error: `${name} is ${formatBytes(file.size)}. Maximum file size is ${formatBytes(maxBytes)} per image.`
    };
  }
  if (typeof file.slice === "function") {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const isJpg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const isPng = head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const isWebp = head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
    if (!isJpg && !isPng && !isWebp) {
      return {
        ok: false,
        error: `${name} is not a valid JPG, PNG, or WebP image. Export your 360° photo as an equirectangular 2:1 JPG, PNG, or WebP.`
      };
    }
  }
  const dims = await readImageSize(file).catch(() => null);
  if (dims && dims.width && dims.height) {
    const ratio = dims.width / dims.height;
    if (ratio < 1.9 || ratio > 2.1) {
      return {
        ok: false,
        error: `${name} is ${dims.width}×${dims.height} (${ratio.toFixed(2)}:1). Equirectangular 360° panoramas require a 2:1 aspect ratio — export in equirectangular format first.`
      };
    }
  }
  return { ok: true, dims };
}

function closeSource(source) {
  if (source && typeof source.close === "function") source.close();
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw abortError();
}

export function isAbortError(err) {
  return !!err && err.name === "AbortError";
}

function loadImageUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = url;
  });
}

function loadImageElement(blob) {
  const url = URL.createObjectURL(blob);
  return loadImageUrl(url).finally(() => URL.revokeObjectURL(url));
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function scaleSource(source, limit) {
  const size = pixelSize(source);
  if (size.width <= limit && size.height <= limit) return source;
  const s = limit / Math.max(size.width, size.height);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(size.width * s));
  c.height = Math.max(1, Math.round(size.height * s));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, c.width, c.height);
  closeSource(source);
  return c;
}

export async function decodeFile(file, limit = deviceTextureCap()) {
  limit = Math.min(limit, deviceTextureCap());
  const original = await readImageSize(file).catch(() => null);
  let scaled = false;
  let source;
  const opts = { imageOrientation: "from-image" };
  if (original && (original.width > limit || original.height > limit)) {
    const s = limit / Math.max(original.width, original.height);
    opts.resizeWidth = Math.max(1, Math.round(original.width * s));
    opts.resizeHeight = Math.max(1, Math.round(original.height * s));
    opts.resizeQuality = "high";
    scaled = true;
  }
  try {
    source = await createImageBitmap(file, opts);
  } catch (err) {
    try { source = await createImageBitmap(file); }
    catch (again) { source = await loadImageElement(file); }
  }
  const before = pixelSize(source);
  source = scaleSource(source, limit);
  const shown = pixelSize(source);
  if (shown.width < before.width - 1) scaled = true;
  return { source, original: original || before, shown, scaled };
}

export function thumbOf(source) {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 320;
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.74);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function thumbOfBlob(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { resizeWidth: 640, resizeHeight: 320, resizeQuality: "medium" });
  } catch (err) {
    bmp = await createImageBitmap(blob).catch(() => loadImageElement(blob));
  }
  const c = makeCanvas(640, 320);
  c.getContext("2d").drawImage(bmp, 0, 0, 640, 320);
  closeSource(bmp);
  const out = c.convertToBlob
    ? await c.convertToBlob({ type: "image/jpeg", quality: 0.74 })
    : await canvasToBlob(c, "image/jpeg", 0.74);
  return blobToDataUrl(out);
}

/* ---------- IndexedDB Persistence ---------- */
const DB_NAME = "forwardslashdot-panorama-library";
const DB_VERSION = 2;
const BLOB_LRU_MAX = 3;

let dbPromise = null;
let blobKeysLoaded = false;
let pinnedSceneId = "";
const blobKeys = new Set();
const storedBlobs = new Map();
const remoteBlobs = new WeakMap();
const blobLru = [];

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const base = req.result;
      const tx = req.transaction;
      if (!base.objectStoreNames.contains("meta")) base.createObjectStore("meta");
      const scenes = base.objectStoreNames.contains("scenes") ? tx.objectStore("scenes") : base.createObjectStore("scenes");
      if (base.objectStoreNames.contains("blobs")) return;
      const blobs = base.createObjectStore("blobs");
      if (!e.oldVersion) return;
      scenes.openCursor().onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) return;
        const rec = cursor.value;
        if (rec && (rec.blob || rec.originalBlob)) {
          blobs.put({ blob: rec.blob || null, originalBlob: rec.originalBlob || null }, cursor.key);
          const meta = { ...rec };
          delete meta.blob;
          delete meta.originalBlob;
          cursor.update(meta);
        }
        cursor.continue();
      };
    };
    req.onsuccess = () => {
      const base = req.result;
      base.onversionchange = () => { base.close(); dbPromise = null; };
      base.onclose = () => { dbPromise = null; };
      resolve(base);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

export async function idbLoad() {
  try {
    const base = await openDb();
    const tx = base.transaction(["meta", "scenes", "blobs"], "readonly");
    const [meta, scenes, keys] = await Promise.all([
      reqDone(tx.objectStore("meta").get("library")),
      reqDone(tx.objectStore("scenes").getAll()),
      reqDone(tx.objectStore("blobs").getAllKeys())
    ]);
    blobKeys.clear();
    (keys || []).forEach((k) => blobKeys.add(k));
    blobKeysLoaded = true;
    return {
      collections: (meta && meta.collections) || [],
      folders: (meta && meta.folders) || [],
      scenes: scenes || []
    };
  } catch (err) {
    return { collections: [], folders: [], scenes: [] };
  }
}

export async function idbLoadBlob(sceneId) {
  if (blobKeysLoaded && !blobKeys.has(sceneId)) return null;
  const base = await openDb();
  const rec = await reqDone(base.transaction("blobs", "readonly").objectStore("blobs").get(sceneId));
  if (!rec) return null;
  storedBlobs.set(sceneId, { blob: rec.blob || null, originalBlob: rec.originalBlob || null });
  return rec;
}

export async function idbSaveMeta(collections, folders) {
  const base = await openDb();
  const tx = base.transaction("meta", "readwrite");
  tx.objectStore("meta").put({ collections, folders }, "library");
  await txDone(tx);
}

export async function idbSaveScene(scene) {
  const base = await openDb();
  const meta = { ...scene };
  delete meta.blob;
  delete meta.originalBlob;
  const blob = scene.blob || null;
  const originalBlob = scene.originalBlob || null;
  const known = storedBlobs.get(scene.id);
  const writeBlob = !!blob && (!known || known.blob !== blob || known.originalBlob !== originalBlob);
  const tx = base.transaction(writeBlob ? ["scenes", "blobs"] : ["scenes"], "readwrite");
  tx.objectStore("scenes").put(meta, scene.id);
  if (writeBlob) {
    tx.objectStore("blobs").put({ blob, originalBlob }, scene.id);
    storedBlobs.set(scene.id, { blob, originalBlob });
  }
  try {
    await txDone(tx);
  } catch (err) {
    if (writeBlob && storedBlobs.get(scene.id)?.blob === blob) storedBlobs.delete(scene.id);
    throw err;
  }
  if (writeBlob) blobKeys.add(scene.id);
}

export async function idbDeleteScene(sceneId) {
  storedBlobs.delete(sceneId);
  blobKeys.delete(sceneId);
  try {
    const base = await openDb();
    const tx = base.transaction(["scenes", "blobs"], "readwrite");
    tx.objectStore("scenes").delete(sceneId);
    tx.objectStore("blobs").delete(sceneId);
    await txDone(tx);
  } catch (err) { /* ignore */ }
}

function canEvictBlob(scene) {
  if (!scene.blob) return false;
  const known = storedBlobs.get(scene.id);
  if (known && known.blob === scene.blob && known.originalBlob === (scene.originalBlob || null)) return true;
  return remoteBlobs.get(scene) === scene.blob && !scene.originalBlob;
}

function touchBlob(scene) {
  const at = blobLru.indexOf(scene);
  if (at >= 0) blobLru.splice(at, 1);
  blobLru.push(scene);
  while (blobLru.length > BLOB_LRU_MAX) {
    const idx = blobLru.findIndex((s) => s !== scene && s.id !== pinnedSceneId && canEvictBlob(s));
    if (idx < 0) break;
    const [old] = blobLru.splice(idx, 1);
    delete old.blob;
    delete old.originalBlob;
  }
}

/** Restores scene.blob / scene.originalBlob from IndexedDB when they were not loaded or were evicted. */
export async function ensureSceneBlob(scene) {
  if (!scene) return false;
  if (!scene.blob) {
    const rec = await idbLoadBlob(scene.id).catch(() => null);
    if (rec && rec.blob && !scene.blob) {
      scene.blob = rec.blob;
      if (!scene.originalBlob) scene.originalBlob = rec.originalBlob || null;
    }
  }
  if (scene.blob) touchBlob(scene);
  return !!scene.blob;
}

export function isServerBacked(scene) {
  return !!scene && !scene.blob && !blobKeys.has(scene.id);
}

/* ---------- Progressive Partitioned 4x2 CDN Loading ---------- */
function mediaVersion(scene) {
  return scene.width ? `?v=${scene.width}x${scene.height}` : "";
}

export function mediaUrl(scene) {
  return `/panorama/api/media/${scene.id}${mediaVersion(scene)}`;
}

export function previewUrl(scene) {
  return `/panorama/api/media/${scene.id}/preview${mediaVersion(scene)}`;
}

export function tileUrl(scene, idx) {
  return `/panorama/api/media/${scene.id}/tile/${idx}${mediaVersion(scene)}`;
}

function canvasToBlob(canvas, type = "image/jpeg", quality = 0.86) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function buildProgressiveAssets(blob) {
  const bmp = await createImageBitmap(blob).catch(() => loadImageElement(blob));
  const { width, height } = pixelSize(bmp);

  // Fast-start 1024x512 preview (~40-70 KB)
  const pCanvas = document.createElement("canvas");
  pCanvas.width = Math.min(1024, width);
  pCanvas.height = Math.min(512, height);
  pCanvas.getContext("2d").drawImage(bmp, 0, 0, pCanvas.width, pCanvas.height);
  const preview = await canvasToBlob(pCanvas, "image/jpeg", 0.72);

  // Partition full resolution (capped at 6144x3072 for fast parallel CDN streaming)
  const maxW = Math.min(width, 6144);
  const maxH = Math.round(maxW / 2);
  const tw = Math.ceil(maxW / TILE_COLS);
  const th = Math.ceil(maxH / TILE_ROWS);
  const tiles = [];
  const tCanvas = document.createElement("canvas");
  tCanvas.width = tw;
  tCanvas.height = th;
  const tCtx = tCanvas.getContext("2d");

  for (let row = 0; row < TILE_ROWS; row++) {
    for (let col = 0; col < TILE_COLS; col++) {
      const sx = (col / TILE_COLS) * width;
      const sy = (row / TILE_ROWS) * height;
      const sw = width / TILE_COLS;
      const sh = height / TILE_ROWS;
      tCtx.clearRect(0, 0, tw, th);
      tCtx.drawImage(bmp, sx, sy, sw, sh, 0, 0, tw, th);
      tiles.push(await canvasToBlob(tCanvas, "image/jpeg", 0.88));
    }
  }
  closeSource(bmp);
  return { preview, tiles, width, height };
}

export async function uploadProgressiveAssets(sceneId, blob, editToken) {
  try {
    const { preview, tiles } = await buildProgressiveAssets(blob);
    const baseHeaders = editToken ? { "x-pano-edit": editToken } : {};
    const tasks = [];
    if (preview) {
      tasks.push(fetch(`/panorama/api/media/${sceneId}/preview`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "image/jpeg", ...baseHeaders },
        body: preview
      }));
    }
    tiles.forEach((tileBlob, idx) => {
      if (!tileBlob) return;
      tasks.push(fetch(`/panorama/api/media/${sceneId}/tile/${idx}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "image/jpeg", "x-pano-tiles": String(tiles.length), ...baseHeaders },
        body: tileBlob
      }));
    });
    await Promise.allSettled(tasks);
  } catch (err) {
    /* Non-fatal: full original scene media is already uploaded */
  }
}

function fetchBlob(url, opts) {
  return fetch(url, opts).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
}

async function fetchTile(scene, idx, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.signal && opts.signal.aborted) return null;
    const blob = await fetchBlob(tileUrl(scene, idx), opts);
    if (blob) return blob;
  }
  return null;
}

async function decodeTile(blob, w, h, resize) {
  let out;
  try {
    out = await createImageBitmap(blob, resize ? { resizeWidth: w, resizeHeight: h, resizeQuality: "high" } : undefined);
  } catch (err) {
    out = await loadImageElement(blob);
  }
  const size = pixelSize(out);
  if (size.width === w && size.height === h) return out;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(out, 0, 0, w, h);
  closeSource(out);
  return c;
}

// Each tile is decoded at its exact slot size so the engine can texSubImage2D
// it into one allocation without stitching a full-size canvas.
async function decodeTiles(blobs, limit, signal) {
  let dims = await readImageSize(blobs[0]).catch(() => null);
  if (!dims || !dims.width || !dims.height) {
    const probe = await createImageBitmap(blobs[0]).catch(() => loadImageElement(blobs[0]));
    dims = pixelSize(probe);
    closeSource(probe);
  }
  const fullW = Math.floor(Math.min(limit, dims.width * TILE_COLS) / TILE_COLS) * TILE_COLS;
  const fullH = fullW / 2;
  const dw = fullW / TILE_COLS;
  const dh = fullH / TILE_ROWS;
  const resize = dims.width !== dw || dims.height !== dh;
  const settled = await Promise.allSettled(blobs.map((b) => decodeTile(b, dw, dh, resize)));
  const tiles = settled.map((r) => (r.status === "fulfilled" ? r.value : null));
  if (tiles.some((t) => !t) || (signal && signal.aborted)) {
    tiles.forEach(closeSource);
    checkAbort(signal);
    return null;
  }
  return {
    tiles,
    cols: TILE_COLS,
    rows: TILE_ROWS,
    width: fullW,
    height: fullH,
    close() { tiles.forEach(closeSource); }
  };
}

/**
 * Progressive loader. Stages are awaited so callers can defer the final upload.
 * 1) Local scenes paint scene.thumb immediately, then decode the stored blob.
 * 2) Remote scenes fetch the preview -> onStage(previewSource, false), then all
 *    8 tiles in parallel -> onStage(tileSet, true).
 * 3) Falls back to the full /panorama/api/media/:id image if tiles are missing.
 * Rejects with an AbortError once `signal` aborts.
 */
export async function loadSceneProgressive(scene, limit, onStage, { signal = null, local = false } = {}) {
  pinnedSceneId = scene.id;
  limit = Math.min(limit || deviceTextureCap(), deviceTextureCap());

  if (local) {
    if (scene.thumb) {
      const thumb = await loadImageUrl(scene.thumb).catch(() => null);
      checkAbort(signal);
      if (thumb) await onStage(thumb, false, null);
    }
    await ensureSceneBlob(scene);
    checkAbort(signal);
  }

  if (scene.blob) {
    touchBlob(scene);
    const decoded = await decodeFile(scene.blob, limit);
    if (signal && signal.aborted) { closeSource(decoded.source); throw abortError(); }
    await onStage(decoded.source, true, decoded);
    return;
  }

  const fetchOpts = { credentials: "same-origin", signal };
  const previewPromise = fetchBlob(previewUrl(scene), fetchOpts);
  const paintPreview = async (blob) => {
    const dec = await decodeFile(blob, limit).catch(() => null);
    if (!dec) return;
    if (signal && signal.aborted) { closeSource(dec.source); throw abortError(); }
    await onStage(dec.source, false, dec);
  };

  if (scene.tiles >= TILE_COUNT) {
    const tilePromises = Array.from({ length: TILE_COUNT }, (_, idx) => fetchTile(scene, idx, fetchOpts));
    const pBlob = await previewPromise;
    checkAbort(signal);
    if (pBlob) await paintPreview(pBlob);

    const tileBlobs = await Promise.all(tilePromises);
    checkAbort(signal);
    if (tileBlobs.every(Boolean)) {
      const set = await decodeTiles(tileBlobs, limit, signal);
      if (set) {
        if (!scene.thumb && pBlob) scene.thumb = await thumbOfBlob(pBlob).catch(() => scene.thumb);
        if (signal && signal.aborted) { set.close(); throw abortError(); }
        await onStage(set, true, {
          original: { width: scene.width || set.width, height: scene.height || set.height },
          shown: { width: set.width, height: set.height },
          scaled: false
        });
        return;
      }
    }
  }

  const pBlob = await previewPromise;
  checkAbort(signal);
  if (pBlob) await paintPreview(pBlob);
  let res;
  try {
    res = await fetch(mediaUrl(scene), fetchOpts);
  } catch (err) {
    checkAbort(signal);
    throw new Error("That photo didn't load.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "That photo didn't load.");
  }
  const blob = await res.blob();
  checkAbort(signal);
  const file = new File([blob], (scene.title || "Scene") + ".jpg", { type: blob.type || "image/jpeg" });
  scene.blob = file;
  remoteBlobs.set(scene, file);
  touchBlob(scene);
  const decoded = await decodeFile(file, limit);
  if (signal && signal.aborted) { closeSource(decoded.source); throw abortError(); }
  if (!scene.thumb) {
    if (pBlob) scene.thumb = await thumbOfBlob(pBlob).catch(() => thumbOf(decoded.source));
    else scene.thumb = thumbOf(decoded.source);
  }
  await onStage(decoded.source, true, decoded);
}

const prefetched = new Set();

/** Warms the HTTP cache for a server-backed scene's preview and tiles at low priority. */
export function prefetchScene(scene) {
  if (!isServerBacked(scene)) return;
  const key = scene.id + mediaVersion(scene);
  if (prefetched.has(key)) return;
  prefetched.add(key);
  const opts = { credentials: "same-origin", priority: "low" };
  const urls = [previewUrl(scene)];
  if (scene.tiles >= TILE_COUNT) {
    for (let i = 0; i < TILE_COUNT; i++) urls.push(tileUrl(scene, i));
  }
  urls.forEach((url) => {
    fetch(url, opts).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => prefetched.delete(key));
  });
}

/* ---------- Auto Enhance (Lighting, Color Balance & Sharpness) ---------- */
// `file` may be a Blob or an image URL (e.g. scene.thumb).
export async function computeAutoEnhance(file, textureIsLinear) {
  const w = 256, h = 128;
  let bmp;
  if (typeof file === "string") {
    bmp = await loadImageUrl(file);
  } else {
    try {
      bmp = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: "low" });
    } catch (err) {
      bmp = await createImageBitmap(file).catch(() => loadImageElement(file));
    }
  }
  const c = makeCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  closeSource(bmp);
  const data = g.getImageData(0, 0, w, h).data;
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const lums = [];
  let rSum = 0, bSum = 0, n = 0;
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i] / 255, gv = data[i + 1] / 255, b = data[i + 2] / 255;
    const rl = textureIsLinear ? lin(r) : r;
    const gl = textureIsLinear ? lin(gv) : gv;
    const bl = textureIsLinear ? lin(b) : b;
    lums.push(rl * 0.2126 + gl * 0.7152 + bl * 0.0722);
    rSum += rl; bSum += bl; n += 1;
  }
  lums.sort((a, b) => a - b);
  const pct = (p) => lums[Math.min(lums.length - 1, Math.max(0, Math.floor(p * (lums.length - 1))))];
  const black = pct(0.02);
  const white = pct(0.98);
  const mid = Math.max(0.02, pct(0.5));
  const spread = Math.max(0.08, white - black);

  return {
    bright: 0,
    contrast: Math.max(0.85, Math.min(1.45, 0.62 / spread)),
    grade: {
      exposure: Math.max(-1.6, Math.min(1.6, Math.log2(0.22 / mid) * 0.65)),
      highlights: white > 0.92 ? -0.18 : 0.05,
      shadows: black < 0.06 ? 0.22 : 0.05,
      black: Math.max(0, Math.min(0.22, black * 0.6)),
      saturation: 1.08,
      warmth: Math.max(-0.5, Math.min(0.5, ((bSum - rSum) / Math.max(1, n)) * 1.1)),
      sharpness: 0.42
    }
  };
}

/* ---------- AI 2x Super-Resolution Upscaler ---------- */
// sharpenStrip, runSharpen and upscaleWorkerMain are serialized into an inline
// worker, so they must not reference anything outside their own bodies.
function sharpenStrip(d, width, first, last) {
  const copy = new Uint8ClampedArray(d);
  const stride = width * 4;
  for (let y = first; y < last; y++) {
    const row = y * stride;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x * 4;
      for (let c = 0; c < 3; c++) {
        const center = copy[i + c];
        const avg = (copy[i - 4 + c] + copy[i + 4 + c] + copy[i - stride + c] + copy[i + stride + c]) * 0.25;
        const diff = center - avg;
        if (Math.abs(diff) > 6) d[i + c] = Math.max(0, Math.min(255, center + diff * 0.52));
      }
    }
  }
}

async function runSharpen(ctx, width, height, pause) {
  const stripH = 256;
  for (let sy = 0; sy < height; sy += stripH) {
    const y0 = Math.max(0, sy - 1);
    const y1 = Math.min(height, sy + stripH + 1);
    const last = Math.min(sy + stripH, height - 1) - y0;
    if (last <= 1) continue;
    const img = ctx.getImageData(0, y0, width, y1 - y0);
    sharpenStrip(img.data, width, 1, last);
    ctx.putImageData(img, 0, y0, 0, 1, width, last - 1);
    if (pause) await pause();
  }
}

function upscaleWorkerMain() {
  self.onmessage = async (e) => {
    const { bitmap, targetW, targetH, maxBytes } = e.data;
    try {
      const mid = new OffscreenCanvas(Math.round(bitmap.width * 1.414), Math.round(bitmap.height * 1.414));
      const midCtx = mid.getContext("2d");
      midCtx.imageSmoothingEnabled = true;
      midCtx.imageSmoothingQuality = "high";
      midCtx.drawImage(bitmap, 0, 0, mid.width, mid.height);
      bitmap.close();
      const out = new OffscreenCanvas(targetW, targetH);
      const ctx = out.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(mid, 0, 0, targetW, targetH);
      mid.width = 1;
      mid.height = 1;
      self.postMessage({ type: "progress", pct: 70, msg: "Reconstructing fine edge details…" });
      await runSharpen(ctx, targetW, targetH, null);
      self.postMessage({ type: "progress", pct: 90, msg: "Encoding high-resolution 360° image…" });
      let quality = 0.92;
      let blob = await out.convertToBlob({ type: "image/jpeg", quality });
      while (blob && blob.size > maxBytes && quality > 0.72) {
        quality -= 0.06;
        blob = await out.convertToBlob({ type: "image/jpeg", quality });
      }
      self.postMessage({ type: "done", blob });
    } catch (err) {
      self.postMessage({ type: "error", message: String((err && err.message) || err) });
    }
  };
}

function canUseUpscaleWorker() {
  return typeof Worker === "function" && typeof OffscreenCanvas === "function" &&
    typeof OffscreenCanvas.prototype.convertToBlob === "function";
}

function upscaleInWorker(bitmap, targetW, targetH, onProgress) {
  return new Promise((resolve, reject) => {
    const src = `${sharpenStrip.toString()}\n${runSharpen.toString()}\n(${upscaleWorkerMain.toString()})();`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    let worker;
    const finish = () => {
      if (worker) worker.terminate();
      URL.revokeObjectURL(url);
    };
    try {
      worker = new Worker(url);
    } catch (err) {
      finish();
      reject(err);
      return;
    }
    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "progress") {
        onProgress && onProgress(msg.pct, msg.msg);
      } else if (msg.type === "done" && msg.blob) {
        finish();
        resolve(msg.blob);
      } else {
        finish();
        reject(new Error(msg.message || "worker"));
      }
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error((e && e.message) || "worker"));
    };
    worker.postMessage({ bitmap, targetW, targetH, maxBytes: MAX_IMAGE_BYTES }, [bitmap]);
  });
}

async function upscaleOnMainThread(bmp, targetW, targetH, onProgress) {
  const midCanvas = document.createElement("canvas");
  midCanvas.width = Math.round(bmp.width * 1.414);
  midCanvas.height = Math.round(bmp.height * 1.414);
  const midCtx = midCanvas.getContext("2d");
  midCtx.imageSmoothingEnabled = true;
  midCtx.imageSmoothingQuality = "high";
  midCtx.drawImage(bmp, 0, 0, midCanvas.width, midCanvas.height);
  closeSource(bmp);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = targetW;
  outCanvas.height = targetH;
  const ctx = outCanvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(midCanvas, 0, 0, targetW, targetH);
  midCanvas.width = 1;
  midCanvas.height = 1;

  onProgress && onProgress(70, "Reconstructing fine edge details…");
  await runSharpen(ctx, targetW, targetH, () => new Promise((r) => setTimeout(r, 0)));

  onProgress && onProgress(90, "Encoding high-resolution 360° image…");
  let quality = 0.92;
  let blob = await canvasToBlob(outCanvas, "image/jpeg", quality);
  while (blob && blob.size > MAX_IMAGE_BYTES && quality > 0.72) {
    quality -= 0.06;
    blob = await canvasToBlob(outCanvas, "image/jpeg", quality);
  }
  return blob;
}

export async function upscaleScene2x(scene, { account, onProgress }) {
  if (!scene || !scene.blob) throw new Error("No scene image loaded to upscale.");
  onProgress && onProgress(10, "Checking resolution…");

  // Try cloud super-resolution endpoint if authenticated & synced
  if (account) {
    try {
      const res = await fetch(`/panorama/api/scenes/${scene.id}/upscale`, {
        method: "POST",
        credentials: "same-origin"
      });
      if (res.ok) {
        const info = await res.json().catch(() => ({}));
        if (info.mode === "cloud") {
          onProgress && onProgress(80, "Downloading cloud 2× result…");
          const mediaRes = await fetch(`/panorama/api/media/${scene.id}`, { credentials: "same-origin" });
          if (mediaRes.ok) {
            const blob = await mediaRes.blob();
            const dims = await readImageSize(blob).catch(() => null);
            return {
              blob: new File([blob], (scene.title || "Scene") + "-2x.jpg", { type: blob.type || "image/jpeg" }),
              width: dims ? dims.width : (scene.width || 2048) * 2,
              height: dims ? dims.height : (scene.height || 1024) * 2
            };
          }
        }
      }
    } catch (err) {
      /* Continue with built-in edge-directed GPU/Canvas 2x super-resolution */
    }
  }

  const cap = deviceTextureCap();
  const dims = await readImageSize(scene.blob).catch(() => null);
  if (dims && dims.width && isConstrainedDevice() && dims.width * 2 > cap) {
    throw new Error(`2× upscaling would exceed this device's ${cap}px image limit. Upscale from a desktop browser instead.`);
  }

  onProgress && onProgress(25, "Decoding source panorama…");
  const decode = () => createImageBitmap(scene.blob).catch(() => loadImageElement(scene.blob));
  let bmp = await decode();
  const srcW = bmp.width || bmp.naturalWidth;
  const srcH = bmp.height || bmp.naturalHeight;
  if (isConstrainedDevice() && srcW * 2 > cap) {
    closeSource(bmp);
    throw new Error(`2× upscaling would exceed this device's ${cap}px image limit. Upscale from a desktop browser instead.`);
  }
  const targetW = Math.min(cap, Math.round(srcW * 2));
  const targetH = Math.min(cap / 2, Math.round(srcH * 2));
  if (targetW <= srcW) {
    closeSource(bmp);
    throw new Error(`Already at maximum ${cap === 8192 ? "8K" : cap + "px"} resolution (${srcW}×${srcH}).`);
  }

  // Two-stage progressive upsampling (1.41x -> 2x) preserves sharper edges than single-pass
  onProgress && onProgress(45, `Upsampling ${srcW}×${srcH} → ${targetW}×${targetH}…`);
  let blob = null;
  if (canUseUpscaleWorker() && typeof ImageBitmap !== "undefined" && bmp instanceof ImageBitmap) {
    blob = await upscaleInWorker(bmp, targetW, targetH, onProgress).catch(() => null);
    if (!blob) {
      closeSource(bmp);
      bmp = await decode();
    }
  }
  if (!blob) blob = await upscaleOnMainThread(bmp, targetW, targetH, onProgress);
  if (!blob) throw new Error("Upscaling failed.");
  onProgress && onProgress(100, "2× Super-Resolution complete");
  return {
    blob: new File([blob], (scene.title || "Scene") + "-2x.jpg", { type: "image/jpeg" }),
    width: targetW,
    height: targetH
  };
}

/* ---------- Customizable QR Code Canvas & PNG Export ---------- */
export async function renderQrCanvas(canvas, url, opts = {}) {
  if (typeof window.qrcode !== "function") return;
  const fg = opts.fg || "#1c1917";
  const bg = opts.bg || "#ffffff";
  const pattern = opts.pattern || "square";
  const logoSrc = opts.logoSrc || "";
  const size = opts.size || 420;

  // Use H (30%) error correction when embedding a brand logo so QR stays 100% scannable
  const ec = logoSrc ? "H" : "M";
  const qr = window.qrcode(0, ec);
  qr.addData(url);
  qr.make();

  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const cell = size / total;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  const isFinder = (r, c) =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

  const centerMin = logoSrc ? Math.floor(n * 0.36) : -1;
  const centerMax = logoSrc ? Math.ceil(n * 0.64) : -1;

  ctx.fillStyle = fg;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      if (logoSrc && r >= centerMin && r <= centerMax && c >= centerMin && c <= centerMax) continue;
      const x = (c + quiet) * cell;
      const y = (r + quiet) * cell;
      if (isFinder(r, c) || pattern === "square") {
        ctx.fillRect(x, y, Math.ceil(cell), Math.ceil(cell));
      } else if (pattern === "dots") {
        ctx.beginPath();
        ctx.arc(x + cell / 2, y + cell / 2, cell * 0.44, 0, Math.PI * 2);
        ctx.fill();
      } else if (pattern === "diamond") {
        ctx.beginPath();
        ctx.moveTo(x + cell / 2, y + cell * 0.05);
        ctx.lineTo(x + cell * 0.95, y + cell / 2);
        ctx.lineTo(x + cell / 2, y + cell * 0.95);
        ctx.lineTo(x + cell * 0.05, y + cell / 2);
        ctx.closePath();
        ctx.fill();
      } else if (pattern === "rounded") {
        const rad = cell * 0.32;
        const pad = cell * 0.06;
        const w = cell - pad * 2;
        ctx.beginPath();
        ctx.roundRect(x + pad, y + pad, w, w, rad);
        ctx.fill();
      }
    }
  }

  if (logoSrc) {
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = "anonymous";
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = logoSrc;
      });
      const box = size * 0.24;
      const bx = (size - box) / 2;
      const by = (size - box) / 2;
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(bx - 6, by - 6, box + 12, box + 12, 16);
      ctx.fill();
      const aspect = img.width / Math.max(1, img.height);
      let dw = box, dh = box;
      if (aspect > 1) dh = box / aspect;
      else dw = box * aspect;
      ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
    } catch (err) { /* ignore broken logo */ }
  }
}

export async function downloadQrPng(url, opts, filename = "panorama-qr.png") {
  const c = document.createElement("canvas");
  await renderQrCanvas(c, url, { ...opts, size: 1024 });
  const png = await canvasToBlob(c, "image/png");
  if (!png) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(png);
  a.download = filename.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
