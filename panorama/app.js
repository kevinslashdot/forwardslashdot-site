/**
 * Panorama main application controller:
 * Studio Dashboard, 360° Viewer & Editor HUD, Non-Destructive Scene Swap,
 * Progressive CDN Loading, Custom Loaders, Analytics Beacon, and Auth/Routing.
 */

import {
  HOME_FOV, clamp, gradeOf, createViewerEngine, paintSampleScene, paintSampleFloorPlan
} from "./gl.js";
import {
  MAX_IMAGE_BYTES, formatBytes, validatePanoramaFile, decodeFile, thumbOf,
  idbLoad, idbSaveMeta, idbSaveScene, idbDeleteScene,
  uploadProgressiveAssets, loadSceneProgressive, computeAutoEnhance, upscaleScene2x,
  ensureSceneBlob, prefetchScene, previewUrl, isServerBacked, isAbortError
} from "./media.js";
import {
  safeUrl, hotspotIconSvg, field, createSheetManager, pdfDownloadHref,
  openShowcaseOverlay, showSpotCard, openSpotEditor, openFloorPlanSheet,
  openShareSheet, openTourSettingsSheet, openAnalyticsSheet, openPlansSheet
} from "./sheets.js";

const STORAGE = "forwardslashdot-panorama";
const params = new URLSearchParams(location.search);
const isEmbed = params.get("embed") === "1";
const initialSceneParam = params.get("scene") || "";

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const stage = $("stage");
const heroEl = $("hero");
const libraryEl = $("library");
const albumsEl = $("albums");
const endedEl = $("ended");
const chrome = $("chrome");
const statusEl = $("status");
const libStatusEl = $("library-status");
const nameTourEl = $("name-tour");
const nameSceneEl = $("name-scene");
const noteEl = $("note");
const hintEl = $("hint");
const liveEl = $("live");
const toastEl = $("toast");
const fileInput = $("file");
const extraFileInput = $("extra-file");
const chooseBtn = $("choose");
const sampleBtn = $("sample");
const accountBtn = $("account");
const plansBtn = $("plans-btn");
const doneBtn = $("done");
const shareBtn = $("share");
const fullBtn = $("full");
const motionBtn = $("motion");
const vrBtn = $("vr-btn");
const vrExitBtn = $("vr-exit");
const showcaseBtn = $("showcase-btn");
const dialBtn = $("dial");
const dialRotor = $("dial-rotor");
const spinToggleBtn = $("spin-toggle");
const pointBtn = $("point");
const adjustBtn = $("adjust");
const mapBtn = $("map");
const docsBtn = $("docs-btn");
const addBtn = $("add");
const moreBtn = $("more");
const dockEl = $("dock");
const stripEl = $("strip");
const spotsEl = $("spots");
const horizonEl = $("horizon");
const noteCard = $("note-card");
const adjustPanel = $("adjust-panel");
const rollInput = $("roll");
const veil = $("veil");
const theme = $("theme");
const loaderEl = $("loader");
const loaderLogo = $("loader-logo");
const loaderAnim = $("loader-anim");
const loaderText = $("loader-text");

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = matchMedia("(pointer: coarse)").matches;

let collections = [];
let folders = [];
let sceneMap = new Map();
let openFolderId = null;
let searchQuery = "";
let filterMode = "all";
let librarySelecting = false;
let librarySelected = new Set();
let albumDrag = null;
let albumMoved = false;

let currentCollectionId = null;
let currentSceneId = null;
let publicTour = null;
let account = null;
let viewing = false;
let pointMode = false;
let movingSpot = null;
let draggingSpot = null;
let generation = 0;
let dragDepth = 0;
let moved = false;
let hideTimer = 0;
let toastTimer = 0;
let extraPick = null;
let beatTimer = 0;
let beatLastAt = 0;
let dragSamples = [];
let sceneAbort = null;

const uid = () => crypto.randomUUID();

function prettyName(name) {
  return String(name || "").replace(/\.[^.]+$/, "") || name || "Scene";
}

function displayTitle(name) {
  const clean = prettyName(name).replace(/\s+/g, " ").trim();
  if (!clean || /^[A-Za-z0-9_-]{18,}$/.test(clean)) return "Untitled";
  return clean;
}

let keyboardNav = false;

function toast(text, opts = {}) {
  if (!text) return;
  const action = opts.action;
  liveEl.textContent = action ? `${text}. ${action.label} available.` : text;
  toastEl.textContent = "";
  const msg = document.createElement("span");
  msg.textContent = text;
  toastEl.appendChild(msg);
  toastEl.classList.toggle("has-action", !!action);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      clearTimeout(toastTimer);
      toastEl.classList.remove("is-open", "has-action");
      Promise.resolve(action.fn()).catch((err) => toast(err.message || "Couldn't undo."));
    });
    toastEl.appendChild(btn);
  }
  toastEl.classList.add("is-open");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-open", "has-action"), action ? 5000 : 2600);
}

function tapVerb() {
  return coarse ? "Tap" : "Click";
}

function showError(message) {
  if (viewing) toast(message);
  else {
    statusEl.textContent = message;
    if (libStatusEl) libStatusEl.textContent = message;
  }
}

function clearErrors() {
  statusEl.textContent = "";
  if (libStatusEl) libStatusEl.textContent = "";
}

function editTokens() {
  try { return JSON.parse(localStorage.getItem("pano-edits") || "{}"); }
  catch (err) { return {}; }
}

function rememberEdit(id, token) {
  const all = editTokens();
  all[id] = token;
  try { localStorage.setItem("pano-edits", JSON.stringify(all)); } catch (err) { /* private mode */ }
}

function getEditToken(id) {
  return editTokens()[id] || "";
}

// Guest uploads get a server-issued id, and scenes whose id is taken elsewhere are renamed.
function remoteId(col) {
  return col.remoteId || col.id;
}

function remoteSceneId(col, sid) {
  return (col.remoteScenes && col.remoteScenes[sid]) || sid;
}

function adoptRemote(col, data) {
  if (data.id && data.id !== col.id) col.remoteId = data.id;
  if (data.sceneIds && Object.keys(data.sceneIds).length) {
    col.remoteScenes = { ...(col.remoteScenes || {}), ...data.sceneIds };
  }
}

function collectionById(id) {
  return collections.find((c) => c.id === id) || null;
}

function currentCollection() {
  return collectionById(currentCollectionId);
}

function currentScene() {
  return sceneMap.get(currentSceneId) || null;
}

function currentCaps() {
  if (account && account.limits) return account.limits;
  return {
    plan: "guest",
    label: "Quick Upload",
    published: 3,
    scenes: 15,
    bytes: MAX_IMAGE_BYTES,
    monthly: 5 * 1024 * 1024 * 1024,
    commercial: false,
    customBranding: false,
    customQr: false,
    aiUpscale: false,
    sceneSwap: false
  };
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    credentials: "same-origin",
    headers: {
      ...(opts.json ? { "content-type": "application/json" } : {}),
      ...(opts.headers || {})
    },
    body: opts.json ? JSON.stringify(opts.json) : opts.body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const text = typeof data.error === "string" ? data.error : "";
    throw new Error(text || (res.status === 503 ? "Service unavailable right now. Try again shortly." : "Something went wrong."));
  }
  return data;
}

/* ---------- Engine & Sheet Manager ---------- */
const engine = createViewerEngine({
  canvas,
  dialRotor,
  getScene: currentScene,
  getSpinSpeed: () => {
    const col = currentCollection();
    return col ? Number(col.spin) || 0 : 0;
  },
  onToast: toast,
  onFrameDrawn: ({ stereo, viewport }) => {
    const vis = stereo ? "hidden" : "";
    if (spotsEl && spotsEl.style.visibility !== vis) spotsEl.style.visibility = vis;
    if (!stereo) placeSpots(viewport);
  },
  onContextRestored: (restored) => {
    if (!restored && currentSceneId) showScene(currentSceneId, { silent: true });
  },
  onVrChange: (active) => {
    vrBtn.setAttribute("aria-pressed", active ? "true" : "false");
    vrExitBtn.hidden = !active;
    if (active) {
      chrome.classList.remove("is-on");
      chrome.inert = true;
    } else if (viewing) {
      showChrome(true);
    }
  }
});

const sheets = createSheetManager({
  sheetBack: $("sheet-back"),
  sheetEl: $("sheet"),
  sheetTitle: $("sheet-title"),
  sheetBody: $("sheet-body"),
  noteCard,
  lightbox: $("lightbox"),
  lightboxImg: $("lightbox-img"),
  onShowChrome: showChrome,
  isViewing: () => viewing
});

function pickExtra(accept, fn) {
  extraPick = fn;
  extraFileInput.accept = accept;
  extraFileInput.value = "";
  extraFileInput.click();
}

/* ---------- Custom Loading Animation Overlay ---------- */
function showLoader(opts = {}) {
  const style = opts.loaderStyle || "spinner";
  const bg = opts.loaderBg || "#14110e";
  const fg = opts.loaderColor || "#f6f1e8";
  const text = opts.loaderText || "Loading 360° scene…";
  loaderEl.style.setProperty("--loader-bg", bg);
  loaderEl.style.setProperty("--loader-fg", fg);
  if (opts.logoUrl) {
    loaderLogo.src = opts.logoUrl;
    loaderLogo.hidden = false;
  } else {
    loaderLogo.hidden = true;
  }
  loaderAnim.innerHTML = "";
  if (style === "pulse") {
    loaderAnim.innerHTML = `<div class="loader-pulse"></div>`;
  } else if (style === "bar") {
    loaderAnim.innerHTML = `<div class="loader-bar-wrap"><div class="loader-bar-fill"></div></div>`;
  } else if (style === "fade") {
    loaderAnim.innerHTML = `<div class="loader-fade-mark">/.</div>`;
  } else {
    loaderAnim.innerHTML = `<div class="loader-spinner"></div>`;
  }
  loaderText.textContent = text;
  loaderEl.hidden = false;
}

function hideLoader() {
  loaderEl.hidden = true;
}

function previewLoader(opts) {
  showLoader(opts);
  setTimeout(hideLoader, 1800);
}

/* ---------- Chrome Visibility ---------- */
function hintSeen() {
  try { return localStorage.getItem(STORAGE) === "1"; } catch (err) { return true; }
}

function markHint() {
  try { localStorage.setItem(STORAGE, "1"); } catch (err) { /* ignore */ }
}

function showChrome(sticky) {
  chrome.hidden = false;
  if ($("sheet-back").hidden) chrome.inert = false;
  requestAnimationFrame(() => {
    chrome.classList.add("is-on");
    clearTimeout(hideTimer);
    if (!sticky && !reduce) {
      hideTimer = setTimeout(() => {
        if (keyboardNav) return;
        if (document.activeElement && chrome.contains(document.activeElement)) return;
        hideChrome();
      }, 2800);
    }
  });
}

function hideChrome() {
  chrome.classList.remove("is-on");
  chrome.inert = true;
  if (!hintEl.hidden && !pointMode) markHint();
  hintEl.hidden = true;
  setBarExtra(false);
}

function setBarExtra(open) {
  const extra = $("bar-extra");
  const toggle = $("bar-more");
  if (!extra || !toggle) return;
  extra.classList.toggle("is-open", !!open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleChrome() {
  if (!viewing) return;
  if (chrome.classList.contains("is-on")) hideChrome();
  else showChrome(true);
}

/* ---------- Persistence Helpers ---------- */
async function saveMeta() {
  await idbSaveMeta(collections, folders);
}

async function saveScene(scene) {
  sceneMap.set(scene.id, scene);
  await idbSaveScene(scene);
}

function applySceneState(scene) {
  engine.orient.yaw = scene.orient?.yaw || 0;
  engine.orient.roll = scene.orient?.roll || 0;
  engine.orient.flipX = scene.orient?.flipX === -1 ? -1 : 1;
  engine.orient.flipY = scene.orient?.flipY === -1 ? -1 : 1;
  engine.opening.yaw = scene.opening?.yaw || 0;
  engine.opening.pitch = scene.opening?.pitch || 0;
  engine.opening.fov = scene.opening?.fov || HOME_FOV;
  syncAdjustSliders(scene);
}

function readSceneState(scene) {
  scene.orient = { yaw: engine.orient.yaw, roll: engine.orient.roll, flipX: engine.orient.flipX, flipY: engine.orient.flipY };
  scene.opening = { yaw: engine.opening.yaw, pitch: engine.opening.pitch, fov: engine.opening.fov };
}

async function persistCurrent() {
  const scene = currentScene();
  if (!scene || publicTour) return;
  readSceneState(scene);
  await saveScene(scene);
}

/* ---------- Studio Dashboard Rendering ---------- */
function maxImageBytes() {
  const caps = currentCaps();
  return Number((account && account.maxImageBytes) || caps.maxImageBytes || caps.bytes) || MAX_IMAGE_BYTES;
}

let heroPreviewState = "";

function scheduleHeroPreview() {
  if (heroPreviewState) return;
  heroPreviewState = "pending";
  const run = () => {
    if (heroEl.hidden || viewing) { heroPreviewState = ""; return; }
    try {
      paintHeroPreview();
      heroPreviewState = "done";
    } catch (err) {
      heroPreviewState = "failed";
    }
  };
  const idle = () => (window.requestIdleCallback ? requestIdleCallback(run, { timeout: 2500 }) : setTimeout(run, 400));
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
}

function paintHeroPreview() {
  const win = $("hero-preview");
  const out = $("hero-pano");
  if (!win || !out) return;
  const src = paintSampleScene(0);
  const band = { y: Math.round(src.height * 0.24), h: Math.round(src.height * 0.5) };
  const h = Math.min(480, Math.max(240, Math.round(win.clientHeight * Math.min(2, devicePixelRatio || 1))));
  const w = Math.round(h * (src.width / band.h));
  out.width = w * 2;
  out.height = h;
  const g = out.getContext("2d");
  const spots = [{ u: 0.73, v: 0.48 }, { u: 0.5, v: 0.49 }];
  for (let i = 0; i < 2; i += 1) {
    g.drawImage(src, 0, band.y, src.width, band.h, i * w, 0, w, h);
    spots.forEach((s) => {
      const x = i * w + s.u * w;
      const y = ((s.v * src.height - band.y) / band.h) * h;
      const r = h * 0.045;
      g.beginPath(); g.arc(x, y, r * 1.8, 0, Math.PI * 2); g.fillStyle = "rgba(255,255,255,0.28)"; g.fill();
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill();
    });
  }
  win.classList.add("is-ready");
}

function renderQuotaStrip() {
  const strip = $("quota-strip");
  if (!account) { strip.hidden = true; return; }
  strip.hidden = false;
  const caps = currentCaps();
  const tierEl = $("dash-tier");
  tierEl.textContent = caps.label || "Free";
  tierEl.className = "tier-chip" + (caps.plan !== "free" ? " is-pro" : "");
  $("dash-commercial").hidden = !caps.commercial;

  const used = account.usage || 0;
  const monthly = caps.monthly || 10 * 1024 * 1024 * 1024;
  const bwPct = Math.min(100, Math.round((used / Math.max(1, monthly)) * 100));
  $("dash-bw-text").textContent = `${formatBytes(used)} / ${formatBytes(monthly)}`;
  const bwFill = $("dash-bw-fill");
  bwFill.style.width = bwPct + "%";
  bwFill.className = "meter-fill" + (bwPct >= 95 ? " is-full" : bwPct >= 75 ? " is-warn" : "");

  const pub = account.published || collections.filter((c) => c.slug).length;
  const pubCap = caps.published || 10;
  const pubPct = Math.min(100, Math.round((pub / Math.max(1, pubCap)) * 100));
  $("dash-pub-text").textContent = `${pub} / ${pubCap} · ${caps.scenes} scenes/tour`;
  const pubFill = $("dash-pub-fill");
  pubFill.style.width = pubPct + "%";
  pubFill.className = "meter-fill" + (pubPct >= 95 ? " is-full" : pubPct >= 75 ? " is-warn" : "");
}

function renderHome() {
  const bar = $("library-bar");
  if (publicTour) {
    if (bar) bar.hidden = true;
    document.body.classList.remove("has-library-bar");
    return;
  }
  const has = collections.length > 0 || !!account;
  heroEl.hidden = has;
  libraryEl.hidden = !has;
  endedEl.hidden = true;
  if (!has) scheduleHeroPreview();
  accountBtn.textContent = account ? `${account.email} · ${currentCaps().label}` : "Sign In";
  renderQuotaStrip();

  const openFolder = folders.find((f) => f.id === openFolderId) || null;
  if (!openFolder) openFolderId = null;
  libraryEl.classList.toggle("is-selecting", librarySelecting);
  $("library-back").hidden = !openFolderId;

  const selectedCount = librarySelected.size;
  const titleEl = $("library-title");
  titleEl.textContent = librarySelecting && selectedCount
    ? `${selectedCount} Selected`
    : (openFolder ? (openFolder.title || "Folder") : (account ? "Studio Dashboard" : "Quick Uploads"));
  titleEl.classList.toggle("is-rename", !!openFolder && !librarySelecting);

  const selectBtn = $("library-select");
  selectBtn.hidden = !collections.length;
  selectBtn.textContent = librarySelecting ? "Done" : "Select";

  const selectedTours = [...librarySelected].map(collectionById).filter(Boolean);
  const showBar = librarySelecting && selectedCount > 0;
  bar.hidden = !showBar;
  document.body.classList.toggle("has-library-bar", showBar);
  $("library-share").hidden = selectedTours.length !== 1;
  $("library-duplicate").hidden = selectedTours.length !== 1;
  $("library-folder").hidden = selectedTours.length < 2;
  $("library-remove").hidden = !openFolderId || !selectedTours.length;
  $("library-delete").hidden = !selectedCount;

  albumsEl.innerHTML = "";
  const q = searchQuery.trim().toLowerCase();

  const matchesFilter = (c) => {
    if (filterMode === "published" && !c.slug) return false;
    if (filterMode === "draft" && c.slug) return false;
    if (q && !(c.title || "").toLowerCase().includes(q) && !(c.folder || "").toLowerCase().includes(q)) return false;
    return true;
  };

  if (!openFolderId && !q && filterMode === "all") {
    folders.forEach((folder) => {
      const inside = collections.filter((c) => c.folderId === folder.id);
      if (!inside.length) return;
      const firstScene = sceneMap.get(inside[0].sceneIds?.[0]);
      const thumb = (firstScene && firstScene.thumb)
        || (inside[0].coverSceneId ? `/panorama/api/media/${inside[0].coverSceneId}/preview` : "");
      albumsEl.appendChild(buildAlbumCard({
        id: folder.id,
        kind: "folder",
        label: folder.title || "Folder",
        subtitle: inside.length === 1 ? "1 tour" : `${inside.length} tours`,
        thumb,
        badges: [],
        onOpen: () => {
          openFolderId = folder.id;
          librarySelecting = false;
          librarySelected.clear();
          renderHome();
        }
      }));
    });
  }

  const loose = collections.filter((c) => !c.folderId || !folders.some((f) => f.id === c.folderId));
  const list = (openFolderId ? collections.filter((c) => c.folderId === openFolderId) : (q || filterMode !== "all" ? collections : loose))
    .filter(matchesFilter);

  if (!list.length && !albumsEl.children.length) {
    const empty = document.createElement("div");
    empty.className = "info-box is-empty";
    const head = document.createElement("strong");
    head.textContent = collections.length ? "No matching tours" : "Your studio is ready";
    const p = document.createElement("p");
    p.className = "sub";
    p.textContent = collections.length
      ? "Try clearing your search or filter."
      : `Upload 360° photos from your 360 camera or phone (2:1 ratio, JPG, PNG or WebP up to ${formatBytes(maxImageBytes())}), or open the interactive sample tour.`;
    empty.append(head, p);
    albumsEl.appendChild(empty);
    return;
  }

  list.forEach((col) => {
    const firstScene = sceneMap.get(col.sceneIds?.[0]);
    const count = col.sceneIds?.length || col.sceneCount || 0;
    const thumb = (firstScene && firstScene.thumb)
      || (col.coverSceneId ? `/panorama/api/media/${col.coverSceneId}/preview` : "");
    const badges = [];
    if (col.slug) badges.push({ text: "Live", live: true });
    if (col.locked) badges.push({ text: "Locked" });
    if (col.commercial) badges.push({ text: "Commercial" });
    const viewsText = col.views ? ` · ${col.views} views` : "";
    albumsEl.appendChild(buildAlbumCard({
      id: col.id,
      kind: "tour",
      label: displayTitle(col.title),
      subtitle: `${count === 1 ? "1 scene" : `${count} scenes`}${viewsText}`,
      thumb,
      badges,
      collection: col,
      onOpen: () => openCollection(col.id)
    }));
  });
}

function buildAlbumCard(item) {
  const card = document.createElement("article");
  const selected = librarySelected.has(item.id);
  card.className = "album" + (item.kind === "folder" ? " is-folder" : "") + (selected ? " is-selected" : "");
  card.dataset.id = item.id;
  card.dataset.kind = item.kind;

  const open = document.createElement("button");
  open.className = "album-open";
  open.type = "button";

  const stack = document.createElement("span");
  stack.className = "album-stack";
  stack.innerHTML = `<span class="album-back back-a"></span><span class="album-back back-b"></span><span class="album-cover"></span>`;
  const cover = stack.querySelector(".album-cover");
  if (item.thumb) {
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.src = item.thumb;
    img.onerror = () => img.remove();
    cover.appendChild(img);
  }
  if (item.badges && item.badges.length) {
    const bw = document.createElement("span");
    bw.className = "album-badges";
    item.badges.forEach((b) => {
      const s = document.createElement("span");
      s.className = "album-badge" + (b.live ? " is-live" : "");
      s.textContent = b.text;
      bw.appendChild(s);
    });
    cover.appendChild(bw);
  }

  const meta = document.createElement("span");
  meta.className = "album-meta";
  const strong = document.createElement("strong");
  strong.textContent = item.label;
  const em = document.createElement("em");
  em.textContent = item.subtitle;
  meta.append(strong, em);
  open.append(stack, meta);
  open.setAttribute("aria-label", `${item.kind === "folder" ? "Open folder" : "Open tour"} ${item.label}, ${item.subtitle}${(item.badges || []).length ? ", " + item.badges.map((b) => b.text).join(", ") : ""}`);

  let menuBtn = null;
  if (item.kind === "tour" && item.collection) {
    menuBtn = document.createElement("button");
    menuBtn.className = "album-menu-btn";
    menuBtn.type = "button";
    menuBtn.setAttribute("aria-label", `Actions for ${item.label}`);
    menuBtn.setAttribute("aria-haspopup", "dialog");
    menuBtn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.4" cy="8" r="1.15" fill="currentColor"/><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="12.6" cy="8" r="1.15" fill="currentColor"/></svg>`;
    menuBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openTourQuickMenu(item.collection);
    });
  }

  const check = document.createElement("button");
  check.className = "album-check";
  check.type = "button";
  check.setAttribute("aria-label", "Select " + item.label);
  check.setAttribute("aria-pressed", selected ? "true" : "false");
  check.addEventListener("pointerdown", (e) => e.stopPropagation());
  check.addEventListener("click", (e) => {
    e.stopPropagation();
    librarySelecting = true;
    toggleLibrarySelect(item.id);
  });

  open.addEventListener("dragstart", (e) => e.preventDefault());
  open.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    albumDrag = { id: item.id, kind: item.kind, x: e.clientX, y: e.clientY, card, handle: open, pointerId: e.pointerId, thumb: item.thumb || "" };
  });
  open.addEventListener("click", () => {
    if (albumMoved) return;
    if (librarySelecting) { toggleLibrarySelect(item.id); return; }
    item.onOpen();
  });

  card.append(open, check);
  if (menuBtn) card.appendChild(menuBtn);
  return card;
}

function openTourQuickMenu(col) {
  const node = document.createElement("div");
  const links = document.createElement("div");
  links.className = "row-links";
  const add = (label, fn, danger = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (danger) b.className = "is-danger";
    b.addEventListener("click", () => { sheets.closeSheets(); fn(); });
    links.appendChild(b);
  };
  add("Open in 360° Editor", () => openCollection(col.id));
  add("Share, QR Code & Embed", () => { currentCollectionId = col.id; openShareSheet(sheetCtx()); });
  add("Tour Settings, Branding & PDFs", () => { currentCollectionId = col.id; openTourSettingsSheet(sheetCtx(), col); });
  add("Engagement Analytics", () => openAnalyticsSheet(sheetCtx(), col));
  add("Duplicate Tour", () => duplicateTour(col));
  add("Delete Tour", () => confirmDeleteCollections([col]), true);
  node.appendChild(links);
  sheets.openSheet(displayTitle(col.title), node);
}

function toggleLibrarySelect(id) {
  if (librarySelected.has(id)) librarySelected.delete(id);
  else librarySelected.add(id);
  if (!librarySelected.size) librarySelecting = false;
  renderHome();
}

function pruneFolders() {
  folders = folders.filter((f) => collections.some((c) => c.folderId === f.id));
}

function nextFolderTitle() {
  const names = new Set(folders.map((f) => f.title));
  if (!names.has("Folder")) return "Folder";
  let n = 2;
  while (names.has("Folder " + n)) n += 1;
  return "Folder " + n;
}

function groupTours(sourceId, targetId, sourceKind, targetKind) {
  if (sourceId === targetId || (sourceKind === "folder" && targetKind === "folder")) return;
  let folderObj = null;
  if (sourceKind === "folder") {
    folderObj = folders.find((f) => f.id === sourceId);
    const tour = collectionById(targetId);
    if (tour && folderObj) { tour.folderId = folderObj.id; tour.folder = folderObj.title; }
  } else if (targetKind === "folder") {
    folderObj = folders.find((f) => f.id === targetId);
    const tour = collectionById(sourceId);
    if (tour && folderObj) { tour.folderId = folderObj.id; tour.folder = folderObj.title; }
  } else {
    const source = collectionById(sourceId);
    const target = collectionById(targetId);
    if (!source || !target) return;
    folderObj = folders.find((f) => f.id === target.folderId);
    if (!folderObj) {
      folderObj = { id: uid(), title: nextFolderTitle() };
      folders.unshift(folderObj);
      target.folderId = folderObj.id;
      target.folder = folderObj.title;
    }
    source.folderId = folderObj.id;
    source.folder = folderObj.title;
  }
  pruneFolders();
  librarySelecting = false;
  librarySelected.clear();
  saveMeta();
  renderHome();
  toast(folderObj ? `Grouped into "${folderObj.title}"` : "Grouped");
}

function dropTargetAt(x, y, sourceId) {
  for (const el of document.elementsFromPoint(x, y)) {
    const album = el.closest && el.closest(".album");
    if (album && album.dataset.id !== sourceId) return album;
  }
  return null;
}

/* ---------- Uploading, Validation & Sample Interactive Tour ---------- */
async function ingest(files) {
  clearErrors();
  const raw = [...(files || [])];
  if (!raw.length) return;

  const caps = currentCaps();
  const adding = viewing && currentCollectionId && !publicTour;
  let collection = adding ? currentCollection() : null;
  const createdNew = !collection;
  if (!collection) {
    collection = {
      id: uid(),
      title: displayTitle(raw[0].name),
      blurb: "",
      linkLabel: "",
      linkUrl: "",
      slug: "",
      folder: openFolderId ? (folders.find((f) => f.id === openFolderId)?.title || "") : "",
      folderId: openFolderId || "",
      commercial: !!caps.commercial,
      branding: {},
      attachments: [],
      gallery: [],
      pins: [],
      spin: 0,
      contact: {},
      editors: [],
      sceneIds: []
    };
  }

  let addedAny = false;
  let firstNew = null;
  const skipped = [];
  const notes = [];
  const maxBytes = maxImageBytes();
  const sizeText = formatBytes(maxBytes);
  const reasonOf = (text) => {
    const t = String(text || "");
    if (/proprietary|raw camera/i.test(t)) return "unsupported camera format";
    if (/isn't supported/i.test(t)) return "not JPG, PNG or WebP";
    if (/maximum file size|exceeds/i.test(t)) return `over ${sizeText}`;
    if (/2:1|aspect/i.test(t)) return "not 2:1";
    return "couldn't be read";
  };

  for (const file of raw) {
    if (collection.sceneIds.length >= caps.scenes) {
      notes.push(account
        ? `Your ${caps.label} plan supports up to ${caps.scenes} scenes per tour.`
        : `Quick upload supports up to 15 photos without an account. Sign in for up to 250 scenes per tour.`);
      break;
    }
    if (file.size > maxBytes) {
      skipped.push({ name: file.name, reason: `over ${sizeText}` });
      continue;
    }
    const check = await validatePanoramaFile(file);
    if (!check.ok) {
      skipped.push({ name: file.name, reason: reasonOf(check.error) });
      continue;
    }

    const token = ++generation;
    chooseBtn.disabled = true;
    chooseBtn.textContent = "Processing…";
    try {
      const limit = engine.maxTextureSize();
      const decoded = await decodeFile(file, limit);
      const ratio = decoded.original.width / Math.max(1, decoded.original.height);
      if (ratio < 1.9 || ratio > 2.1) {
        if (decoded.source.close) decoded.source.close();
        skipped.push({ name: file.name, reason: "not 2:1" });
        continue;
      }
      if (token !== generation && !firstNew) {
        if (decoded.source.close) decoded.source.close();
        continue;
      }
      const scene = {
        id: uid(),
        collectionId: collection.id,
        title: displayTitle(file.name),
        blob: file,
        thumb: thumbOf(decoded.source),
        width: decoded.original.width,
        height: decoded.original.height,
        orient: { yaw: 0, roll: 0, flipX: 1, flipY: 1 },
        opening: { yaw: 0, pitch: 0, fov: HOME_FOV },
        hotspots: [],
        bright: 0,
        contrast: 1,
        grade: {},
        upscaled: false
      };
      collection.sceneIds.push(scene.id);
      await saveScene(scene);
      addedAny = true;

      if (!firstNew) {
        firstNew = scene;
        if (createdNew) collections.unshift(collection);
        currentCollectionId = collection.id;
        currentSceneId = scene.id;
        engine.uploadTexture(decoded.source);
        applySceneState(scene);
        present(collection, scene);
      } else if (decoded.source.close) {
        decoded.source.close();
      }
    } catch (err) {
      if (err && err.message === "no-webgl") {
        notes.push("Your browser can't display 360° photos here (WebGL is turned off or unsupported).");
        break;
      }
      skipped.push({ name: file.name, reason: "couldn't be read" });
    }
  }

  chooseBtn.disabled = false;
  chooseBtn.textContent = "Upload 360° Photos";

  if (addedAny) {
    await saveMeta();
    paintStrip();
    paintSpotButtons();
    renderHome();
    if (!account && !skipped.length && !notes.length) toast(`Added (${collection.sceneIds.length} / 15 quick-upload photos)`);
  }
  const help = {
    "not 2:1": "Use a 360° photo from your 360 camera or phone (2:1 ratio, e.g. 6000×3000).",
    "not JPG, PNG or WebP": "Export it as JPG, PNG or WebP first.",
    "unsupported camera format": "Export it from your camera app as a JPG first.",
    "couldn't be read": "Try exporting it again as a JPG."
  };
  const parts = [];
  if (skipped.length === 1) {
    const s = skipped[0];
    parts.push(`${s.name} was skipped (${s.reason}). ${help[s.reason] || `Each photo must be ${sizeText} or smaller.`}`);
  } else if (skipped.length > 1) {
    const shown = skipped.slice(0, 5).map((s) => `${s.name} (${s.reason})`).join(", ");
    const more = skipped.length > 5 ? ` and ${skipped.length - 5} more` : "";
    parts.push(`${skipped.length} files skipped: ${shown}${more}.`);
  }
  parts.push(...notes);
  if (parts.length) showError(parts.join(" "));
}

async function openSampleTour() {
  clearErrors();
  sampleBtn.disabled = true;
  try {
    engine.maxTextureSize();
    const c1 = paintSampleScene(0);
    const c2 = paintSampleScene(1);
    const [b1, b2] = await Promise.all([
      new Promise((r) => c1.toBlob(r, "image/jpeg", 0.9)),
      new Promise((r) => c2.toBlob(r, "image/jpeg", 0.9))
    ]);
    const colId = uid();
    const s1Id = uid();
    const s2Id = uid();
    const planUrl = paintSampleFloorPlan();
    const planBlob = await (await fetch(planUrl)).blob();

    const s1 = {
      id: s1Id,
      collectionId: colId,
      title: "Sunlit Atrium",
      blob: new File([b1], "sunlit-atrium.jpg", { type: "image/jpeg" }),
      thumb: thumbOf(c1),
      width: 2048,
      height: 1024,
      orient: { yaw: 0, roll: 0, flipX: 1, flipY: 1 },
      opening: { yaw: 0, pitch: 0, fov: HOME_FOV },
      hotspots: [
        { id: uid(), u: 0.73, v: 0.48, kind: "scene", title: "Step out to Terrace Lounge", target: s2Id, icon: "arrow", color: "#ffffff", size: "m", motion: "pulse", hover: "scale", heading: 0 },
        { id: uid(), u: 0.5, v: 0.49, kind: "note", title: "Architectural Atrium", body: "Double-height limestone archways oriented toward natural afternoon light. Try Enhance → AI 2× Upscale or Floor Plan below.", icon: "info", color: "#c98470", size: "m", motion: "still", hover: "glow", heading: 0 }
      ],
      bright: 0,
      contrast: 1,
      grade: {},
      upscaled: false
    };
    const s2 = {
      id: s2Id,
      collectionId: colId,
      title: "Terrace Lounge",
      blob: new File([b2], "terrace-lounge.jpg", { type: "image/jpeg" }),
      thumb: thumbOf(c2),
      width: 2048,
      height: 1024,
      orient: { yaw: 0, roll: 0, flipX: 1, flipY: 1 },
      opening: { yaw: 0, pitch: 0, fov: HOME_FOV },
      hotspots: [
        { id: uid(), u: 0.22, v: 0.49, kind: "scene", title: "Return to Sunlit Atrium", target: s1Id, icon: "walk", color: "#ffffff", size: "m", motion: "pulse", hover: "scale", heading: 0 }
      ],
      bright: 0,
      contrast: 1,
      grade: {},
      upscaled: false
    };
    const col = {
      id: colId,
      title: "Atrium Residence Tour",
      blurb: "Interactive 2-scene 360° sample tour featuring scene navigation hotspots, creator infospots, and a pinned floor plan.",
      linkLabel: "Book a Private Walkthrough",
      linkUrl: "https://www.forwardslashdot.com/panorama",
      slug: "",
      folder: "",
      folderId: "",
      commercial: false,
      branding: {},
      attachments: [],
      gallery: [],
      plan: planUrl,
      planBlob,
      hasPlan: true,
      pins: [
        { id: uid(), kind: "scene", sceneId: s1Id, x: 0.31, y: 0.52 },
        { id: uid(), kind: "scene", sceneId: s2Id, x: 0.72, y: 0.52 },
        { id: uid(), kind: "info", sceneId: "", title: "South Courtyard", body: "Panoramic sunset exposure from the elevated terrace.", x: 0.55, y: 0.78 }
      ],
      spin: 0.04,
      contact: { name: "Studio Concierge", role: "Panorama Showcase", email: "hello@forwardslashdot.com" },
      editors: [],
      sceneIds: [s1Id, s2Id]
    };
    collections.unshift(col);
    await saveScene(s1);
    await saveScene(s2);
    await saveMeta();
    currentCollectionId = colId;
    publicTour = null;
    await showScene(s1Id);
    toast("Interactive sample tour ready");
  } catch (err) {
    showError("Couldn't open sample tour: " + (err.message || "WebGL unavailable."));
  } finally {
    sampleBtn.disabled = false;
  }
}

/* ---------- Scene Image Swap ---------- */
async function swapSceneImage(file) {
  if (!account) {
    openSignIn("Sign in to replace a scene's photo and keep its hotspots.");
    return;
  }
  const scene = currentScene();
  const collection = currentCollection();
  if (!scene || !collection || !file) return;

  const check = await validatePanoramaFile(file);
  if (!check.ok) { toast(check.error); return; }

  try {
    const decoded = await decodeFile(file, engine.maxTextureSize());
    const ratio = decoded.original.width / Math.max(1, decoded.original.height);
    if (ratio < 1.9 || ratio > 2.1) {
      if (decoded.source.close) decoded.source.close();
      toast("That photo isn't a full 360° (it needs a 2:1 ratio).");
      return;
    }
    scene.blob = file;
    scene.originalBlob = null;
    scene.upscaled = false;
    scene.thumb = thumbOf(decoded.source);
    scene.width = decoded.original.width;
    scene.height = decoded.original.height;
    engine.uploadTexture(decoded.source);
    await saveScene(scene);
    paintStrip();
    syncAdjustSliders(scene);

    // Sync swapped media + progressive CDN tiles if tour is already in cloud
    if (collection.slug) {
      await fetch(`/panorama/api/media/${scene.id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": file.type || "image/jpeg",
          "x-pano-width": String(scene.width),
          "x-pano-height": String(scene.height)
        },
        body: file
      });
      uploadProgressiveAssets(scene.id, file, "");
    }
    const count = (scene.hotspots || []).length;
    toast(`Scene image replaced — ${count} hotspot${count === 1 ? "" : "s"} preserved`);
  } catch (err) {
    toast("Couldn't replace scene image.");
  }
}

/* ---------- Viewer Presentation & Scene Switching ---------- */
function syncViewerChrome(collection, scene) {
  const isPub = !!publicTour;
  doneBtn.hidden = isEmbed;
  nameTourEl.textContent = displayTitle(collection.title);
  nameSceneEl.textContent = (collection.sceneIds?.length > 1 && scene) ? `· ${scene.title}` : "";

  pointBtn.hidden = isPub;
  adjustBtn.hidden = isPub;
  addBtn.hidden = isPub;
  moreBtn.hidden = isPub;
  setEditDock(isPub ? false : dockEl.classList.contains("is-editing"), isPub);

  const hasPlan = !!(collection.plan || collection.hasPlan);
  mapBtn.hidden = isPub && !hasPlan;

  const hasDocs = !!(collection.attachments && collection.attachments.length);
  docsBtn.hidden = !hasDocs;

  const hasSpin = Math.abs(Number(collection.spin) || 0) > 0.005;
  spinToggleBtn.hidden = !hasSpin;
  spinToggleBtn.setAttribute("aria-pressed", !engine.isSpinPaused() ? "true" : "false");

  // Branding & Watermark enforcement
  const ownerIsPaid = isPub
    ? (collection.ownerPlan === "pro" || collection.ownerPlan === "business")
    : currentCaps().customBranding;
  const branding = collection.branding || {};
  const hideWm = ownerIsPaid && !!branding.hideWatermark;
  const hasLogo = ownerIsPaid && !!collection.logoUrl;

  const publicMark = $("public-mark");
  const logoLink = $("tour-logo-link");
  const logoImg = $("tour-logo");

  if (hasLogo) {
    logoImg.src = collection.logoUrl;
    logoLink.href = safeUrl(branding.logoUrl) || "#";
    logoLink.style.pointerEvents = safeUrl(branding.logoUrl) ? "auto" : "none";
    logoLink.hidden = false;
  } else {
    logoLink.hidden = true;
  }
  // Free & Guest tours always display platform branding in viewer
  publicMark.hidden = isPub ? hideWm : (!collection.slug || hideWm);
}

function present(collection, scene) {
  viewing = true;
  document.body.classList.add("is-viewing");
  theme.setAttribute("content", "#14110e");
  stage.hidden = true;
  syncViewerChrome(collection, scene);
  noteEl.hidden = true;
  hintEl.textContent = pointMode ? `${tapVerb()} anywhere to drop a hotspot` : "Drag to look around";
  hintEl.hidden = !pointMode && hintSeen();
  engine.resize();
  engine.resetView();
  showChrome(true);
  paintStrip();
  paintSpotButtons();
}

async function showScene(id, opts = {}) {
  const scene = sceneMap.get(id);
  const collection = currentCollection();
  if (!scene || !collection) return;
  noteCard.hidden = true;
  const token = ++generation;
  if (sceneAbort) sceneAbort.abort();
  const ctrl = new AbortController();
  sceneAbort = ctrl;
  const local = !publicTour;
  engine.setActive(true);

  const ownerPaid = publicTour
    ? (collection.ownerPlan === "pro" || collection.ownerPlan === "business")
    : currentCaps().customBranding;
  const loaderOpts = ownerPaid ? {
    ...(collection.branding || {}),
    logoUrl: collection.logoUrl || "",
    loaderText: (collection.branding && collection.branding.loaderText) || `Loading ${scene.title}…`
  } : { loaderStyle: "spinner", loaderText: `Loading ${scene.title}…` };

  if (!opts.silent && !scene.blob && !(local && scene.thumb)) showLoader(loaderOpts);

  try {
    const limit = engine.maxTextureSize();
    let firstPaint = true;
    await loadSceneProgressive(scene, limit, async (source, isFinal) => {
      if (token !== generation) {
        if (source.close) source.close();
        return;
      }
      if (isFinal && !firstPaint) {
        await engine.whenSettled(1500);
        if (token !== generation) {
          if (source.close) source.close();
          return;
        }
      }
      engine.uploadTexture(source, { fade: firstPaint && viewing });
      if (firstPaint) {
        firstPaint = false;
        if (currentSceneId && currentSceneId !== scene.id) flushBeat();
        currentSceneId = scene.id;
        applySceneState(scene);
        present(collection, scene);
        hideLoader();
        if (publicTour) sendBeat({ ms: 0, sceneId: scene.id, sceneView: true });
      } else if (isFinal) {
        paintStrip();
      }
    }, { signal: ctrl.signal, local });

    if (token === generation) prefetchNeighbors(scene);
  } catch (err) {
    if (token !== generation || isAbortError(err)) return;
    hideLoader();
    showError(err.message || "That scene didn't load.");
  }
}

function prefetchNeighbors(scene) {
  const collection = currentCollection();
  const ids = collection ? collection.sceneIds || [] : [];
  const at = ids.indexOf(scene.id);
  const linked = (scene.hotspots || []).filter((h) => h.kind === "scene" && h.target).map((h) => h.target);
  const adjacent = at >= 0 ? [ids[at + 1], ids[at - 1]] : [];
  [...new Set([...linked, ...adjacent])]
    .map((tid) => tid && tid !== scene.id && sceneMap.get(tid))
    .filter((next) => next && isServerBacked(next))
    .slice(0, 3)
    .forEach(prefetchScene);
}

function closeView() {
  flushBeat();
  clearInterval(beatTimer);
  const wasPublic = !!publicTour;
  generation += 1;
  if (sceneAbort) sceneAbort.abort();
  sceneAbort = null;
  viewing = false;
  pointMode = false;
  movingSpot = null;
  document.body.classList.remove("is-viewing", "is-dragging", "is-placing");
  theme.setAttribute("content", "#f7f1e8");
  engine.stopInertia();
  engine.stopMotion(motionBtn);
  engine.exitVR();
  engine.pointers.clear();
  engine.setActive(false);
  setAdjust(false);
  sheets.closeSheets();
  hideLoader();
  chrome.classList.remove("is-on");
  chrome.hidden = true;
  chrome.inert = true;
  spotsEl.innerHTML = "";

  if (fullscreenOn()) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }

  if (wasPublic) {
    const col = currentCollection();
    stage.hidden = false;
    heroEl.hidden = true;
    libraryEl.hidden = true;
    endedEl.hidden = false;
    $("ended-title").textContent = col ? col.title : "Panorama";
    $("ended-lead").textContent = (col && col.blurb) || "Interactive 360° virtual tour.";
    const link = $("ended-link");
    if (col && safeUrl(col.linkUrl)) {
      link.hidden = false;
      link.href = safeUrl(col.linkUrl);
      link.textContent = col.linkLabel || "Open link";
    } else {
      link.hidden = true;
    }
    return;
  }

  stage.hidden = false;
  renderHome();
}

/* ---------- Scene Strip ---------- */
function paintStrip() {
  const collection = currentCollection();
  const ids = collection ? collection.sceneIds || [] : [];
  const show = ids.length > 1;
  stripEl.hidden = !show;
  stripEl.innerHTML = "";
  if (!show) return;

  ids.forEach((id) => {
    const scene = sceneMap.get(id);
    if (!scene) return;
    const btn = document.createElement("button");
    btn.className = "strip-item";
    btn.type = "button";
    btn.title = publicTour ? scene.title : `${scene.title} (Drag onto 360° view to link)`;
    btn.setAttribute("aria-label", scene.title);
    if (id === currentSceneId) btn.setAttribute("aria-current", "true");
    const thumbSrc = scene.thumb || (publicTour || isServerBacked(scene) ? previewUrl(scene) : "");
    if (thumbSrc) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = thumbSrc;
      img.onerror = () => img.remove();
      btn.appendChild(img);
    }
    const cap = document.createElement("span");
    cap.className = "strip-caption";
    cap.textContent = scene.title;
    btn.appendChild(cap);
    btn.draggable = !publicTour;
    btn.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/pano-scene", id);
      e.dataTransfer.effectAllowed = "copy";
    });
    btn.addEventListener("click", () => showScene(id));
    stripEl.appendChild(btn);
  });
}

/* ---------- Hotspots Rendering & Drag-to-Reposition ---------- */
function paintSpotButtons() {
  const scene = currentScene();
  spotsEl.innerHTML = "";
  if (!scene) return;
  (scene.hotspots || []).forEach((spot) => {
    const btn = document.createElement("button");
    btn.className = "spot" + (pointMode && !publicTour ? " is-editing" : "");
    btn.type = "button";
    btn.dataset.u = String(spot.u);
    btn.dataset.v = String(spot.v);
    btn.dataset.id = spot.id;
    btn.dataset.size = spot.size || "m";
    btn.dataset.motion = spot.motion || "still";
    btn.dataset.hover = spot.hover || "scale";

    const marker = document.createElement("span");
    marker.className = "spot-marker";
    marker.style.setProperty("--spot-color", spot.color || "#ffffff");
    // Contrast icon color automatically on dark marker colors
    const colHex = (spot.color || "#ffffff").replace("#", "");
    if (colHex.length === 6) {
      const r = parseInt(colHex.slice(0, 2), 16), g = parseInt(colHex.slice(2, 4), 16), b = parseInt(colHex.slice(4, 6), 16);
      marker.style.color = (r * 0.299 + g * 0.587 + b * 0.114) < 145 ? "#ffffff" : "#1c1917";
    }
    marker.innerHTML = hotspotIconSvg(spot.icon || (spot.kind === "scene" ? "arrow" : "info"), spot.heading || 0);

    const lbl = document.createElement("span");
    lbl.className = "spot-label";
    lbl.textContent = spot.title || (spot.kind === "scene" ? "Scene" : "Details");
    btn.append(marker, lbl);

    // Drag hotspot directly on canvas in edit mode
    btn.addEventListener("pointerdown", (e) => {
      if (publicTour || !pointMode || e.button !== 0) return;
      e.stopPropagation();
      draggingSpot = { spot, btn, startX: e.clientX, startY: e.clientY, moved: false };
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    btn.addEventListener("pointermove", (e) => {
      if (!draggingSpot || draggingSpot.spot !== spot) return;
      if (Math.hypot(e.clientX - draggingSpot.startX, e.clientY - draggingSpot.startY) > 5) {
        draggingSpot.moved = true;
      }
      if (draggingSpot.moved) {
        const uv = engine.uvAt(e.clientX, e.clientY);
        spot.u = uv.u; spot.v = uv.v;
        btn.dataset.u = String(uv.u); btn.dataset.v = String(uv.v);
        placeSpots();
      }
    });
    btn.addEventListener("pointerup", (e) => {
      if (!draggingSpot || draggingSpot.spot !== spot) return;
      const wasMoved = draggingSpot.moved;
      draggingSpot = null;
      if (wasMoved) {
        e.stopPropagation();
        persistCurrent();
        toast("Hotspot repositioned");
      }
    });

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (draggingSpot && draggingSpot.moved) return;
      handleSpotClick(spot);
    });
    spotsEl.appendChild(btn);
  });
  placeSpots();
}

function placeSpots(vp = engine.viewport()) {
  if (!spotsEl) return;
  for (const el of spotsEl.children) {
    const p = engine.projectUv(Number(el.dataset.u), Number(el.dataset.v), vp);
    const vis = p ? "" : "hidden";
    if (el.style.visibility !== vis) el.style.visibility = vis;
    if (!p) continue;
    el.style.transform = `translate3d(${(vp.left + p.x).toFixed(1)}px, ${(vp.top + p.y).toFixed(1)}px, 0) translate(-50%, -50%)`;
  }
}

function handleSpotClick(spot) {
  const collection = currentCollection();
  if (publicTour) {
    sendBeat({ ms: 0, sceneId: currentSceneId, spotId: spot.id });
  }
  if (!publicTour && pointMode) {
    openSpotEditor(sheetCtx(), spot);
    return;
  }
  if (spot.kind === "scene" && spot.target) {
    showScene(spot.target);
  } else if (spot.kind === "link" && safeUrl(spot.url)) {
    window.open(safeUrl(spot.url), "_blank", "noopener");
  } else if (spot.kind === "pdf") {
    const att = (collection?.attachments || []).find((a) => a.id === spot.fileId) || (collection?.attachments || [])[0];
    if (att && pdfDownloadHref(collection, att)) {
      const a = document.createElement("a");
      a.href = pdfDownloadHref(collection, att);
      a.download = att.name || "document.pdf";
      a.click();
      toast(`Downloading ${att.name}`);
    } else {
      showSpotCard(sheetCtx(), spot, collection);
    }
  } else {
    showSpotCard(sheetCtx(), spot, collection);
  }
}

function placeSpotAt(clientX, clientY) {
  const scene = currentScene();
  if (!scene || publicTour) return;
  const uv = engine.uvAt(clientX, clientY);
  if (movingSpot) {
    movingSpot.u = uv.u;
    movingSpot.v = uv.v;
    movingSpot = null;
    setPointMode(false);
    persistCurrent();
    paintSpotButtons();
    toast("Hotspot moved");
    return;
  }
  const col = currentCollection();
  const otherId = (col?.sceneIds || []).find((id) => id !== scene.id) || "";
  const spot = {
    id: uid(),
    u: uv.u,
    v: uv.v,
    kind: otherId ? "scene" : "note",
    title: otherId ? (sceneMap.get(otherId)?.title || "Next Scene") : "Infospot",
    body: "",
    url: "",
    ctaLabel: "",
    target: otherId,
    fileId: "",
    icon: otherId ? "arrow" : "info",
    color: "#ffffff",
    size: "m",
    motion: "still",
    hover: "scale",
    heading: 0
  };
  scene.hotspots = scene.hotspots || [];
  scene.hotspots.push(spot);
  persistCurrent();
  paintSpotButtons();
  openSpotEditor(sheetCtx(), spot);
}

function dropSceneLink(sceneId, x, y) {
  const scene = currentScene();
  if (!scene || publicTour || sceneId === scene.id) return;
  const uv = engine.uvAt(x, y);
  const other = sceneMap.get(sceneId);
  const spot = {
    id: uid(),
    u: uv.u,
    v: uv.v,
    kind: "scene",
    title: other ? other.title : "Next Scene",
    body: "",
    url: "",
    ctaLabel: "",
    target: sceneId,
    fileId: "",
    icon: "arrow",
    color: "#ffffff",
    size: "m",
    motion: "pulse",
    hover: "scale",
    heading: 0
  };
  scene.hotspots = scene.hotspots || [];
  scene.hotspots.push(spot);
  persistCurrent();
  paintSpotButtons();
  openSpotEditor(sheetCtx(), spot);
}

function setPointMode(on) {
  if (on) { sheets.closeSheets(); setAdjust(false); }
  pointMode = !!on;
  document.body.classList.toggle("is-placing", pointMode);
  pointBtn.setAttribute("aria-pressed", pointMode ? "true" : "false");
  hintEl.hidden = !pointMode;
  const verb = tapVerb();
  hintEl.textContent = movingSpot
    ? `${verb} where this hotspot should sit, or press Add at center`
    : `${verb} anywhere to add a hotspot, or press Add at center · Drag markers to move them`;
  paintSpotButtons();
  if (viewing) showChrome(true);
}

function placeSpotAtCenter() {
  const r = canvas.getBoundingClientRect();
  placeSpotAt(r.left + r.width / 2, r.top + r.height / 2);
}

function setEditDock(on, hide = false) {
  const toggle = $("edit-toggle");
  if (!toggle) return;
  toggle.hidden = hide;
  dockEl.classList.toggle("is-editing", !!on);
  toggle.setAttribute("aria-pressed", on ? "true" : "false");
}

/* ---------- Enhance, Sharpness & AI 2x Upscaling Panel ---------- */
function syncAdjustSliders(scene) {
  if (!scene) return;
  const g = gradeOf(scene);
  const deg = Math.round((scene.orient?.roll || 0) * 180 / Math.PI * 10) / 10;
  const set = (id, val, label) => {
    const el = $(id);
    if (el) el.value = String(val);
    const vEl = $("val-" + id);
    if (vEl) vEl.textContent = label != null ? label : String(val);
  };
  set("roll", deg, `${deg}°`);
  set("exposure", Math.round((g.exposure / 2) * 100));
  set("highlights", Math.round(g.highlights * 100));
  set("shadows", Math.round(g.shadows * 100));
  set("bright", Math.round((scene.bright || 0) * 100));
  set("contrast", Math.round((scene.contrast == null ? 1 : scene.contrast) * 100));
  set("black", Math.round((g.black / 0.4) * 100));
  set("saturation", Math.round(g.saturation * 100));
  set("warmth", Math.round(g.warmth * 100));
  set("sharpness", Math.round(g.sharpness * 100));

  const w = scene.width || 2048;
  const h = scene.height || 1024;
  const targetW = Math.min(8192, w * 2);
  const targetH = Math.min(4096, h * 2);
  $("upscale-meta").textContent = scene.upscaled
    ? `2× Upscaled (${w}×${h})`
    : `Current: ${w}×${h} → Target: ${targetW}×${targetH}`;
  $("upscale-btn").disabled = targetW <= w;
  $("upscale-btn").textContent = scene.upscaled ? "Upscaled 2×" : "Upscale 2×";
  $("upscale-revert").hidden = !scene.originalBlob;
}

function setAdjust(on) {
  if (on) { sheets.closeSheets(); setPointMode(false); }
  adjustBtn.setAttribute("aria-pressed", on ? "true" : "false");
  adjustPanel.hidden = !on;
  horizonEl.hidden = !on;
  if (on) {
    showChrome(true);
    syncAdjustSliders(currentScene());
  }
}

/* ---------- Cloud Publishing, Hydrating & Duplication ---------- */
async function publishTour(collection) {
  if (!collection.sceneIds || !collection.sceneIds.length) {
    throw new Error("Add at least one 360° photo before sharing.");
  }
  const caps = currentCaps();
  if (collection.sceneIds.length > caps.scenes) {
    throw new Error(account
      ? `Your ${caps.label} plan supports up to ${caps.scenes} scenes per tour.`
      : `Quick upload holds up to 15 photos. Sign in for larger tours.`);
  }
  for (const sid of collection.sceneIds) {
    const s = sceneMap.get(sid);
    if (s && s.blob && s.blob.size > MAX_IMAGE_BYTES) {
      throw new Error(`${s.title} exceeds the 30 MB image limit.`);
    }
  }

  const payload = {
    id: collection.id,
    title: collection.title,
    blurb: collection.blurb || "",
    linkLabel: collection.linkLabel || "",
    linkUrl: collection.linkUrl || "",
    folder: collection.folder || "",
    commercial: !!collection.commercial,
    branding: collection.branding || {},
    pins: collection.pins || [],
    spin: collection.spin || 0,
    contact: collection.contact || {},
    editors: collection.editors || [],
    gallery: (collection.gallery || []).map((g) => g.id),
    scenes: collection.sceneIds.map((id, index) => {
      const s = sceneMap.get(id);
      return {
        id,
        title: s.title,
        sort: index,
        opening: s.opening,
        orient: s.orient,
        hotspots: s.hotspots || [],
        width: s.width || 0,
        height: s.height || 0,
        bright: s.bright || 0,
        contrast: s.contrast == null ? 1 : s.contrast,
        grade: gradeOf(s),
        upscaled: !!s.upscaled
      };
    })
  };

  let token = "";
  let slug = "";
  let url = "";
  let editUrl = collection.editUrl || "";

  if (!account) {
    token = getEditToken(collection.id);
    if (token && collection.slug) {
      const updated = await api(`/panorama/api/guest/${remoteId(collection)}`, {
        method: "PUT",
        json: payload,
        headers: { "x-pano-edit": token }
      });
      adoptRemote(collection, { sceneIds: updated.sceneIds });
    } else {
      const created = await api("/panorama/api/guest", { method: "POST", json: payload });
      token = created.editToken;
      rememberEdit(collection.id, token);
      collection.remoteScenes = {};
      adoptRemote(collection, created);
    }
    await saveMeta();

    for (const sid of collection.sceneIds) {
      const s = sceneMap.get(sid);
      if (s && !s.blob) await ensureSceneBlob(s);
      if (!s || !s.blob) continue;
      const rid = remoteSceneId(collection, sid);
      const res = await fetch(`/panorama/api/media/${rid}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": s.blob.type || "image/jpeg",
          "x-pano-edit": token,
          "x-pano-width": String(s.width || 0),
          "x-pano-height": String(s.height || 0)
        },
        body: s.blob
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Photo upload failed.");
      await uploadProgressiveAssets(rid, s.blob, token);
    }

    await uploadExtras(collection, token);
    const pub = await api(`/panorama/api/guest/${remoteId(collection)}/publish`, {
      method: "POST",
      headers: { "x-pano-edit": token }
    });
    slug = pub.slug;
    url = pub.url;
    editUrl = pub.edit;
    collection.editUrl = editUrl;
  } else {
    const saved = await api("/panorama/api/collections", { method: "PUT", json: payload });
    adoptRemote(collection, { sceneIds: saved.sceneIds });
    for (const sid of collection.sceneIds) {
      const s = sceneMap.get(sid);
      if (s && !s.blob) await ensureSceneBlob(s);
      if (!s || !s.blob) continue;
      const rid = remoteSceneId(collection, sid);
      const res = await fetch(`/panorama/api/media/${rid}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": s.blob.type || "image/jpeg",
          "x-pano-width": String(s.width || 0),
          "x-pano-height": String(s.height || 0),
          "x-pano-upscaled": s.upscaled ? "1" : "0"
        },
        body: s.blob
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Photo upload failed.");
      await uploadProgressiveAssets(rid, s.blob, "");
    }
    await uploadExtras(collection, "");
    const pub = await api(`/panorama/api/collections/${collection.id}/publish`, { method: "POST" });
    slug = pub.slug;
    url = pub.url;
  }

  collection.slug = slug;
  await saveMeta();
  renderHome();
  return { slug, url, edit: editUrl };
}

async function uploadExtras(collection, token) {
  const base = token
    ? `/panorama/api/guest/${remoteId(collection)}`
    : `/panorama/api/collections/${collection.id}`;
  const headers = token ? { "x-pano-edit": token } : {};

  if (collection.planBlob) {
    await fetch(`${base}/plan`, { method: "PUT", credentials: "same-origin", headers, body: collection.planBlob });
  }
  for (const att of collection.attachments || []) {
    if (!att.blob) continue;
    await fetch(`${base}/attachments`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { ...headers, "x-pano-id": att.id, "x-pano-name": att.name || "Document.pdf", "content-type": "application/pdf" },
      body: att.blob
    });
  }
  for (const item of collection.gallery || []) {
    if (!item.blob) continue;
    await fetch(`${base}/gallery`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { ...headers, "x-pano-id": item.id, "content-type": item.blob.type || "image/jpeg" },
      body: item.blob
    });
  }
  if (collection.logoBlob && currentCaps().customBranding) {
    await fetch(`${base}/logo`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { ...headers, "content-type": collection.logoBlob.type || "image/png" },
      body: collection.logoBlob
    });
  }
}

async function unpublishTour(collection) {
  await api(`/panorama/api/collections/${collection.id}/publish`, { method: "DELETE" });
  collection.slug = "";
  await saveMeta();
  renderHome();
  toast("Share link disabled");
}

async function duplicateTour(source) {
  if (!source) return;
  const copyId = uid();
  const copy = {
    ...source,
    id: copyId,
    title: `${displayTitle(source.title)} Copy`,
    slug: "",
    editUrl: "",
    views: 0,
    locked: false,
    sceneIds: [],
    pins: (source.pins || []).map((p) => ({ ...p, id: uid() })),
    attachments: (source.attachments || []).map((a) => ({ ...a })),
    gallery: (source.gallery || []).map((g) => ({ ...g })),
    branding: { ...(source.branding || {}) },
    contact: { ...(source.contact || {}) }
  };

  if (source.remote && !source.sceneIds.length && account) {
    try {
      const serverCopy = await api(`/panorama/api/collections/${source.id}/duplicate`, { method: "POST" });
      copy.id = serverCopy.id;
      copy.remote = true;
      copy.sceneCount = (serverCopy.scenes || []).length;
      collections.unshift(copy);
      await saveMeta();
      renderHome();
      toast("Tour duplicated");
      return;
    } catch (err) { /* fallback */ }
  }

  const map = {};
  for (const id of source.sceneIds || []) {
    const s = sceneMap.get(id);
    if (!s) continue;
    const next = {
      ...s,
      id: uid(),
      collectionId: copyId,
      hotspots: (s.hotspots || []).map((h) => ({ ...h, id: uid() })),
      grade: { ...(s.grade || {}) }
    };
    map[id] = next.id;
    copy.sceneIds.push(next.id);
    await saveScene(next);
  }
  copy.sceneIds.forEach((id) => {
    const s = sceneMap.get(id);
    (s.hotspots || []).forEach((h) => { if (map[h.target]) h.target = map[h.target]; });
  });
  copy.pins = copy.pins.map((p) => ({ ...p, sceneId: map[p.sceneId] || p.sceneId }));
  collections.unshift(copy);
  await saveMeta();
  renderHome();
  toast("Tour duplicated");
}

function confirmDeleteCollections(tours) {
  const unique = [...new Map(tours.map((t) => [t.id, t])).values()];
  if (!unique.length) return;
  const node = document.createElement("div");
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = unique.length === 1
    ? `Delete "${displayTitle(unique[0].title)}"? Any published link and cloud media will be removed permanently.`
    : `Delete ${unique.length} tours and all associated shared links permanently?`;
  const err = document.createElement("p");
  err.className = "sub error-text";
  err.setAttribute("role", "alert");
  const go = document.createElement("button");
  go.className = "primary danger";
  go.type = "button";
  go.textContent = unique.length === 1 ? "Delete Tour" : `Delete ${unique.length} Tours`;
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Deleting…";
    err.textContent = "";
    const failed = await deleteCollections(unique);
    if (!failed.length) return;
    go.disabled = false;
    go.textContent = "Try Again";
    err.textContent = failed.length === 1
      ? `Couldn't delete "${displayTitle(failed[0].title)}". Check your connection and try again.`
      : `Couldn't delete ${failed.length} tours. Check your connection and try again.`;
    unique.splice(0, unique.length, ...failed);
  });
  const cancel = document.createElement("button");
  cancel.className = "linkish";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => sheets.closeSheets());
  node.append(sub, err, go, cancel);
  sheets.openSheet(unique.length === 1 ? "Delete Tour" : "Delete Tours", node, { initialFocus: cancel });
}

async function deleteRemote(col) {
  const token = getEditToken(col.id);
  let url = "";
  let headers = {};
  if (account) url = `/panorama/api/collections/${col.id}`;
  else if (token) {
    url = `/panorama/api/guest/${remoteId(col)}`;
    headers = { "x-pano-edit": token };
  }
  if (!url) return true;
  try {
    const res = await fetch(url, { method: "DELETE", credentials: "same-origin", headers });
    return res.ok || res.status === 404;
  } catch (err) {
    return false;
  }
}

async function deleteCollections(tours) {
  const results = await Promise.all(tours.map(deleteRemote));
  const done = tours.filter((_, i) => results[i]);
  const failed = tours.filter((_, i) => !results[i]);
  for (const col of done) {
    for (const sid of col.sceneIds || []) {
      sceneMap.delete(sid);
      await idbDeleteScene(sid);
    }
  }
  if (done.length) {
    const gone = new Set(done.map((t) => t.id));
    collections = collections.filter((c) => !gone.has(c.id));
    pruneFolders();
    if (openFolderId && !folders.some((f) => f.id === openFolderId)) openFolderId = null;
    gone.forEach((id) => librarySelected.delete(id));
    if (!failed.length) {
      librarySelected.clear();
      librarySelecting = false;
    }
    await saveMeta();
    if (viewing && gone.has(currentCollectionId)) { sheets.closeSheets(); closeView(); }
    else renderHome();
    toast(done.length === 1 ? "Tour deleted" : `Deleted ${done.length} tours`);
  }
  if (!failed.length) sheets.closeSheets();
  return failed;
}

async function hydrateRemote(col) {
  const data = await api(`/panorama/api/collections/${col.id}`, {});
  Object.assign(col, {
    title: data.title || col.title,
    blurb: data.blurb || "",
    linkLabel: data.linkLabel || "",
    linkUrl: data.linkUrl || "",
    slug: data.slug || col.slug,
    folder: data.folder || "",
    commercial: !!data.commercial,
    branding: data.branding || {},
    attachments: data.attachments || [],
    contact: data.contact || {},
    editors: data.editors || [],
    pins: data.pins || [],
    hasPlan: !!data.hasPlan,
    spin: data.spin || 0,
    locked: !!data.locked,
    logoUrl: data.logo ? `/panorama/api/logo/${col.id}` : "",
    gallery: (data.gallery || []).map((gid) => ({ id: gid, url: `/panorama/api/gallery/${col.id}/${gid}` })),
    remote: false,
    sceneIds: []
  });
  for (const s of data.scenes || []) {
    const res = await fetch(`/panorama/api/media/${s.id}`, { credentials: "same-origin" });
    if (!res.ok) continue;
    const blob = await res.blob();
    const record = {
      id: s.id,
      collectionId: col.id,
      title: s.title,
      blob: new File([blob], (s.title || "Scene") + ".jpg", { type: blob.type || "image/jpeg" }),
      thumb: "",
      width: s.width,
      height: s.height,
      orient: s.orient,
      opening: s.opening,
      hotspots: s.hotspots || [],
      bright: s.bright || 0,
      contrast: s.contrast == null ? 1 : s.contrast,
      grade: s.grade || {},
      upscaled: !!s.upscaled,
      tiles: s.tiles || 0
    };
    await saveScene(record);
    col.sceneIds.push(s.id);
  }
  await saveMeta();
}

async function openCollection(id) {
  const col = collectionById(id);
  if (!col) return;
  if (col.remote && !(col.sceneIds && col.sceneIds.length)) {
    showLoader({ loaderStyle: "spinner", loaderText: `Opening ${col.title}…` });
    try { await hydrateRemote(col); }
    catch (err) { hideLoader(); toast(err.message || "Couldn't open tour."); return; }
  }
  if (!col.sceneIds || !col.sceneIds.length) { hideLoader(); toast("This tour has no scenes."); return; }
  currentCollectionId = id;
  publicTour = null;
  await showScene(col.sceneIds[0]);
}

/* ---------- Analytics Heartbeat + Reliable sendBeacon Flush ---------- */
function sendBeat(payload) {
  if (!publicTour || !publicTour.slug) return;
  fetch(`/panorama/api/v/${encodeURIComponent(publicTour.slug)}/beat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(() => {});
}

function flushBeat() {
  if (!publicTour || !publicTour.slug || !beatLastAt) return;
  const elapsed = Math.min(60000, Date.now() - beatLastAt);
  beatLastAt = Date.now();
  if (elapsed < 500) return;
  const url = `/panorama/api/v/${encodeURIComponent(publicTour.slug)}/beat`;
  const data = JSON.stringify({ ms: elapsed, sceneId: currentSceneId || "" });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([data], { type: "application/json" }));
  } else {
    sendBeat({ ms: elapsed, sceneId: currentSceneId || "" });
  }
}

function startBeat() {
  clearInterval(beatTimer);
  beatLastAt = Date.now();
  beatTimer = setInterval(() => {
    if (document.hidden || !publicTour) { beatLastAt = Date.now(); return; }
    const elapsed = Math.min(60000, Date.now() - beatLastAt);
    beatLastAt = Date.now();
    sendBeat({ ms: elapsed, sceneId: currentSceneId || "" });
  }, 15000);
}

/* ---------- Public Viewer, Guest Edit Link & Auth Flows ---------- */
function askPassword(slug, meta = {}) {
  const node = document.createElement("div");
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = `Enter the password to view "${meta.title || "this private virtual tour"}".`;
  const input = document.createElement("input");
  input.className = "field";
  input.type = "password";
  input.placeholder = "Password";
  input.autocomplete = "current-password";
  input.setAttribute("aria-label", "Tour password");
  const go = document.createElement("button");
  go.className = "primary light";
  go.type = "button";
  go.textContent = "Unlock Tour";
  const err = document.createElement("p");
  err.className = "sub error-text";
  err.setAttribute("role", "alert");
  err.hidden = true;

  async function submit() {
    go.disabled = true;
    err.hidden = true;
    try {
      await api(`/panorama/api/v/${encodeURIComponent(slug)}/unlock`, { method: "POST", json: { password: input.value } });
      sheets.closeSheets();
      loadPublic(slug);
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message || "Incorrect password.";
      go.disabled = false;
    }
  }
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  node.append(sub, input, go, err);
  stage.hidden = false;
  sheets.openSheet("Password Protected Tour", node);
}

async function loadPublic(slug) {
  publicTour = { slug };
  heroEl.hidden = true;
  libraryEl.hidden = true;
  accountBtn.hidden = true;
  plansBtn.hidden = true;
  showLoader({ loaderStyle: "spinner", loaderText: "Opening 360° virtual tour…" });

  try {
    const data = await api(`/panorama/api/v/${encodeURIComponent(slug)}`, {});
    if (data.locked) {
      hideLoader();
      askPassword(slug, data);
      return;
    }
    const collection = {
      id: "public",
      title: data.title,
      blurb: data.blurb || "",
      linkLabel: data.linkLabel || "",
      linkUrl: data.linkUrl || "",
      slug,
      sceneIds: (data.scenes || []).map((s) => s.id),
      pins: data.pins || [],
      hasPlan: !!data.hasPlan,
      spin: data.spin || 0,
      attachments: data.attachments || [],
      contact: data.contact || {},
      branding: data.branding || {},
      ownerPlan: data.ownerPlan || "free",
      commercial: !!data.commercial,
      logoUrl: data.logo ? `/panorama/api/logo/${encodeURIComponent(slug)}` : "",
      gallery: (data.gallery || []).map((gid) => ({ id: gid, url: `/panorama/api/gallery/${encodeURIComponent(slug)}/${gid}` }))
    };
    collections = [collection];
    currentCollectionId = collection.id;
    sceneMap = new Map();
    for (const s of data.scenes || []) {
      sceneMap.set(s.id, {
        id: s.id,
        title: s.title,
        blob: null,
        thumb: "",
        width: s.width,
        height: s.height,
        orient: s.orient,
        opening: s.opening,
        hotspots: s.hotspots || [],
        bright: s.bright || 0,
        contrast: s.contrast == null ? 1 : s.contrast,
        grade: s.grade || {},
        tiles: s.tiles || 0,
        upscaled: !!s.upscaled
      });
    }
    startBeat();
    const startId = (initialSceneParam && sceneMap.has(initialSceneParam))
      ? initialSceneParam
      : collection.sceneIds[0];
    await showScene(startId);
  } catch (err) {
    hideLoader();
    publicTour = null;
    endedEl.hidden = false;
    $("ended-title").textContent = "This tour isn't available.";
    $("ended-lead").textContent = err.message || "The link may have expired or been unpublished.";
  }
}

async function loadEdit(token) {
  await loadLibrary();
  const data = await api("/panorama/api/edit", { headers: { "x-pano-edit": token } });
  rememberEdit(data.id, token);
  if (location.hash.startsWith("#edit=") || location.pathname.startsWith("/panorama/e/")) history.replaceState(null, "", "/panorama/");
  const col = {
    id: data.id,
    title: data.title,
    blurb: data.blurb || "",
    linkLabel: data.linkLabel || "",
    linkUrl: data.linkUrl || "",
    slug: data.slug || "",
    editUrl: `${location.origin}/panorama/#edit=${encodeURIComponent(token)}`,
    sceneIds: [],
    pins: data.pins || [],
    hasPlan: !!data.hasPlan,
    spin: data.spin || 0,
    attachments: data.attachments || [],
    contact: data.contact || {},
    branding: data.branding || {},
    locked: !!data.locked,
    gallery: (data.gallery || []).map((gid) => ({ id: gid, url: `/panorama/api/gallery/${data.id}/${gid}` }))
  };
  for (const s of data.scenes || []) {
    const res = await fetch(`/panorama/api/media/${s.id}`, { headers: { "x-pano-edit": token } });
    if (!res.ok) continue;
    const blob = await res.blob();
    const record = {
      id: s.id,
      collectionId: col.id,
      title: s.title,
      blob: new File([blob], (s.title || "Scene") + ".jpg", { type: blob.type || "image/jpeg" }),
      thumb: "",
      width: s.width,
      height: s.height,
      orient: s.orient,
      opening: s.opening,
      hotspots: s.hotspots || [],
      bright: s.bright || 0,
      contrast: s.contrast == null ? 1 : s.contrast,
      grade: s.grade || {},
      tiles: s.tiles || 0
    };
    await saveScene(record);
    col.sceneIds.push(s.id);
  }
  const idx = collections.findIndex((c) => c.id === col.id);
  if (idx >= 0) collections[idx] = col;
  else collections.unshift(col);
  await saveMeta();
  currentCollectionId = col.id;
  renderHome();
  if (col.sceneIds[0]) await showScene(col.sceneIds[0]);
  toast("Opened private edit link");
}

function openSignIn(reason) {
  const node = document.createElement("div");
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = reason || "No password needed — we'll email you a 6-digit code. Signing in saves your tours to your account, lets you replace a photo without losing its hotspots, and unlocks more tours and storage.";
  const email = field("Email Address", localStorage.getItem("pano-email") || "", { type: "email", autocomplete: "email", placeholder: "you@company.com" });
  const go = document.createElement("button");
  go.className = "primary light";
  go.type = "button";
  go.textContent = "Email Me a Code";
  const err = document.createElement("p");
  err.className = "sub error-text";
  err.setAttribute("role", "alert");
  err.hidden = true;
  async function send() {
    const value = email.input.value.trim().toLowerCase();
    if (!value || !value.includes("@")) {
      err.hidden = false; err.textContent = "Enter your email address, like you@company.com.";
      email.input.focus();
      return;
    }
    go.disabled = true; go.textContent = "Sending…"; err.hidden = true;
    try {
      await api("/panorama/api/auth/send", { method: "POST", json: { email: value } });
      localStorage.setItem("pano-email", value);
      openCode(value);
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      go.disabled = false; go.textContent = "Email Me a Code";
    }
  }
  go.addEventListener("click", send);
  email.input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  node.append(sub, email.wrap, go, err);
  sheets.openSheet("Sign In", node, { initialFocus: email.input });
}

function openCode(email) {
  const node = document.createElement("div");
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = `Enter the 6-digit code we emailed to ${email}, or ${tapVerb().toLowerCase()} the button in that email. It can take a minute to arrive — check spam too.`;
  const input = document.createElement("input");
  input.className = "code-input";
  input.inputMode = "numeric";
  input.autocomplete = "one-time-code";
  input.maxLength = 6;
  input.setAttribute("aria-label", "6-digit sign-in code");
  const go = document.createElement("button");
  go.className = "primary light";
  go.type = "button";
  go.textContent = "Verify & Sign In";
  const err = document.createElement("p");
  err.className = "sub error-text";
  err.setAttribute("role", "alert");
  err.hidden = true;

  const links = document.createElement("div");
  links.className = "button-row";
  const resend = document.createElement("button");
  resend.className = "linkish";
  resend.type = "button";
  const other = document.createElement("button");
  other.className = "linkish";
  other.type = "button";
  other.textContent = "Use a different email";
  other.addEventListener("click", () => openSignIn());
  links.append(resend, other);

  let wait = 60;
  let tick = 0;
  const countdown = () => {
    clearInterval(tick);
    wait = 60;
    resend.disabled = true;
    resend.textContent = `Resend code in ${wait}s`;
    tick = setInterval(() => {
      if (!resend.isConnected) { clearInterval(tick); return; }
      wait -= 1;
      if (wait > 0) { resend.textContent = `Resend code in ${wait}s`; return; }
      clearInterval(tick);
      resend.disabled = false;
      resend.textContent = "Resend code";
    }, 1000);
  };
  resend.addEventListener("click", async () => {
    resend.disabled = true;
    resend.textContent = "Sending…";
    err.hidden = true;
    try {
      await api("/panorama/api/auth/send", { method: "POST", json: { email } });
      liveEl.textContent = `New code sent to ${email}.`;
      countdown();
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      resend.disabled = false; resend.textContent = "Resend code";
    }
  });
  countdown();

  async function submit() {
    go.disabled = true; err.hidden = true;
    try {
      const data = await api("/panorama/api/auth/code", { method: "POST", json: { email, code: input.value } });
      account = { email: data.email, plan: data.plan, limits: data.limits, usage: 0, published: 0 };
      localStorage.setItem("pano-auth", String(Date.now()));
      await refreshMe();
      sheets.closeSheets();
      renderHome();
      toast("Signed in");
    } catch (e) {
      err.hidden = false; err.textContent = e.message; go.disabled = false;
    }
  }
  go.addEventListener("click", submit);
  input.addEventListener("input", () => { if (input.value.replace(/\D/g, "").length === 6) submit(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  node.append(sub, input, go, err, links);
  sheets.openSheet("Check Your Email", node, { initialFocus: input });
}

function openConfirm(token) {
  const email = localStorage.getItem("pano-email");
  const node = document.createElement("div");
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = email ? `Confirm sign-in as ${email}.` : "Press the button below to finish signing in.";
  const go = document.createElement("button");
  go.className = "primary light";
  go.type = "button";
  go.textContent = "Confirm Sign In";
  const err = document.createElement("p");
  err.className = "sub error-text";
  err.setAttribute("role", "alert");
  err.hidden = true;
  go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = "Signing in…";
    try {
      await api("/panorama/api/auth/link", { method: "POST", json: { token } });
      localStorage.setItem("pano-auth", String(Date.now()));
      history.replaceState(null, "", "/panorama/");
      await refreshMe();
      await loadLibrary();
      sheets.closeSheets();
      toast("Signed in");
    } catch (e) {
      err.hidden = false; err.textContent = e.message; go.disabled = false; go.textContent = "Confirm Sign In";
    }
  });
  node.append(sub, go, err);
  heroEl.hidden = true;
  libraryEl.hidden = true;
  sheets.openSheet("Sign In to Panorama", node);
}

function openAccount() {
  if (!account) { openSignIn(); return; }
  const caps = currentCaps();
  const node = document.createElement("div");
  const who = document.createElement("p");
  who.className = "sub";
  who.textContent = account.email;
  const box = document.createElement("div");
  box.className = "info-box";
  const head = document.createElement("div");
  head.className = "box-head";
  const name = document.createElement("strong");
  name.textContent = `${caps.label} Plan`;
  const chip = document.createElement("span");
  chip.className = "tier-chip" + (caps.commercial ? " is-ok" : "");
  chip.textContent = caps.commercial ? "Commercial use OK" : "Personal use";
  head.append(name, chip);
  const usage = document.createElement("ul");
  usage.className = "tier-list";
  [
    `Viewing traffic this month: ${formatBytes(account.usage || 0)} of ${formatBytes(caps.monthly)}`,
    `Published tours: ${account.published || 0} of ${caps.published}`,
    `Up to ${caps.scenes} photos per tour, ${formatBytes(maxImageBytes())} each`
  ].forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    usage.appendChild(li);
  });
  box.append(head, usage);
  node.append(who, box);
  const plans = document.createElement("button");
  plans.className = "primary light";
  plans.type = "button";
  plans.textContent = "Manage Plan & Quotas";
  plans.addEventListener("click", () => openPlansSheet(sheetCtx()));
  const out = document.createElement("button");
  out.className = "linkish";
  out.type = "button";
  out.textContent = "Sign Out";
  out.addEventListener("click", async () => {
    await api("/panorama/api/auth/out", { method: "POST" }).catch(() => {});
    account = null;
    sheets.closeSheets();
    renderHome();
    toast("Signed out");
  });
  node.append(plans, out);
  sheets.openSheet("Account", node);
}

async function pullLibrary() {
  if (!account) return;
  const data = await api("/panorama/api/library", {});
  let changed = false;
  for (const t of data.tours || []) {
    const existing = collectionById(t.id);
    if (existing) {
      existing.views = t.views || existing.views || 0;
      existing.locked = !!t.locked;
      existing.commercial = !!t.commercial;
      if (t.folder && !existing.folder) existing.folder = t.folder;
      continue;
    }
    let folderId = "";
    if (t.folder) {
      let f = folders.find((x) => x.title === t.folder);
      if (!f) { f = { id: uid(), title: t.folder }; folders.push(f); }
      folderId = f.id;
    }
    collections.push({
      id: t.id,
      title: t.title || "Untitled",
      blurb: t.blurb || "",
      linkLabel: t.linkLabel || "",
      linkUrl: t.linkUrl || "",
      slug: t.slug || "",
      views: t.views || 0,
      locked: !!t.locked,
      folder: t.folder || "",
      folderId,
      commercial: !!t.commercial,
      branding: t.branding || {},
      attachments: t.attachments || [],
      sceneCount: t.sceneCount || 0,
      coverSceneId: t.coverSceneId || "",
      hasPlan: !!t.hasPlan,
      sceneIds: [],
      remote: true,
      contact: t.contact || {},
      editors: t.editors || [],
      pins: [],
      spin: 0
    });
    changed = true;
  }
  if (changed) await saveMeta();
  renderHome();
}

async function refreshMe() {
  try {
    const data = await api("/panorama/api/me", {});
    account = data.user ? {
      email: data.user.email,
      plan: data.user.plan,
      limits: data.limits,
      usage: data.usage || 0,
      published: data.published || 0
    } : null;
    if (account) pullLibrary().catch(() => {});
  } catch (err) {
    account = null;
  }
  renderHome();
}

async function loadLibrary() {
  const loaded = await idbLoad();
  collections = loaded.collections;
  folders = loaded.folders;
  sceneMap = new Map(loaded.scenes.map((s) => [s.id, s]));
  renderHome();
}

/* ---------- More Tools Menu inside Viewer ---------- */
function openToolsMenu() {
  if (publicTour) return;
  const col = currentCollection();
  const scene = currentScene();
  if (!col) return;
  const node = document.createElement("div");
  const links = document.createElement("div");
  links.className = "row-links";
  const row = (label, badge, fn, danger = false) => {
    const b = document.createElement("button");
    b.type = "button";
    if (danger) b.className = "is-danger";
    const s = document.createElement("span");
    s.textContent = label;
    b.appendChild(s);
    if (badge) {
      const chip = document.createElement("span");
      chip.className = "tier-chip is-dark";
      chip.textContent = badge;
      b.appendChild(chip);
    }
    b.addEventListener("click", () => { sheets.closeSheets(); fn(); });
    links.appendChild(b);
  };

  row("Tour Settings, Branding & PDFs", currentCaps().customBranding ? "Pro" : "", () => openTourSettingsSheet(sheetCtx(), col));
  row("Swap Current Scene Image", account ? "Keeps Hotspots" : "Account", () => {
    if (!account) { openSignIn("Sign in to replace a scene's photo and keep its hotspots."); return; }
    pickExtra("image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp", swapSceneImage);
  });
  row("Set Current View as Opening Angle", "", async () => {
    engine.opening.yaw = engine.view.yaw;
    engine.opening.pitch = engine.view.pitch;
    engine.opening.fov = engine.view.fov;
    await persistCurrent();
    toast("Opening camera angle saved");
  });
  if (scene) {
    row("Rename Current Scene", "", () => {
      const n = document.createElement("div");
      const f = field("Scene Title", scene.title);
      const sv = document.createElement("button");
      sv.className = "primary light"; sv.type = "button"; sv.textContent = "Save";
      sv.addEventListener("click", async () => {
        scene.title = f.input.value.trim() || "Scene";
        await saveScene(scene);
        syncViewerChrome(col, scene);
        paintStrip();
        sheets.closeSheets();
        toast("Scene renamed");
      });
      n.append(f.wrap, sv);
      sheets.openSheet("Rename Scene", n);
    });
  }
  row("Engagement Analytics", col.slug ? "Live" : "", () => openAnalyticsSheet(sheetCtx(), col));
  row("Duplicate Tour", "", () => duplicateTour(col));
  if (scene && (col.sceneIds || []).length > 1) {
    row("Remove Current Scene from Tour", "", async () => {
      col.sceneIds = col.sceneIds.filter((id) => id !== scene.id);
      col.pins = (col.pins || []).filter((p) => p.sceneId !== scene.id);
      sceneMap.delete(scene.id);
      await idbDeleteScene(scene.id);
      await saveMeta();
      await showScene(col.sceneIds[0]);
      toast("Scene removed");
    }, true);
  }
  row("Delete Tour", "", () => confirmDeleteCollections([col]), true);

  node.appendChild(links);
  sheets.openSheet("Tour Tools", node);
}

function sheetCtx() {
  return {
    sheets,
    noteCard,
    engine,
    api,
    account,
    folders,
    sceneMap,
    isPublic: !!publicTour,
    currentCollection,
    currentScene,
    currentSceneId,
    saveMeta,
    persistCurrent,
    paintSpotButtons,
    showScene,
    pickExtra,
    previewLoader,
    getEditToken,
    publishTour,
    unpublishTour,
    deleteCollection: (col) => confirmDeleteCollections([col]),
    openSignIn,
    refreshMe,
    openPlansModal: () => openPlansSheet(sheetCtx()),
    openTourSettings: (col) => openTourSettingsSheet(sheetCtx(), col),
    openSpotEditor: (spot) => openSpotEditor(sheetCtx(), spot),
    startMoveSpot: (spot) => { movingSpot = spot; setPointMode(true); },
    onTourUpdated: () => {
      const col = currentCollection();
      if (col && viewing) {
        syncViewerChrome(col, currentScene());
        engine.kick();
      }
      renderHome();
    },
    toast
  };
}

/* ---------- Fullscreen Helper ---------- */
function fullscreenOn() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

function syncFull() {
  const on = !!fullscreenOn();
  fullBtn.setAttribute("aria-pressed", on ? "true" : "false");
  fullBtn.classList.toggle("is-full", on);
}

async function toggleFull() {
  try {
    if (fullscreenOn()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    const el = document.documentElement;
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch (err) {
    toast("Fullscreen isn't available in this browser.");
  }
}

/* ---------- Pointer, Wheel, Keyboard & Drag-Drop Wiring ---------- */
canvas.addEventListener("pointerdown", (e) => {
  if (!viewing) return;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  const t = performance.now();
  engine.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t });
  engine.stopInertia();
  moved = false;
  document.body.classList.add("is-dragging");
  dragSamples = engine.pointers.size === 1 ? [{ t, yaw: 0, pitch: 0 }] : [];
  if (engine.pointers.size === 2) {
    const [a, b] = [...engine.pointers.values()];
    engine.pointers.pinch = Math.hypot(b.x - a.x, b.y - a.y);
    engine.pointers.fov = engine.view.fov;
  }
});

function releaseVelocity() {
  const n = dragSamples.length;
  if (n < 2) return null;
  const last = dragSamples[n - 1];
  if (performance.now() - last.t > 50) return null;
  let first = last;
  for (let i = n - 2; i >= 0; i--) {
    first = dragSamples[i];
    if (last.t - first.t >= 80) break;
  }
  const dt = (last.t - first.t) / 1000;
  if (dt < 0.008) return null;
  return {
    yaw: clamp((last.yaw - first.yaw) / dt, -2.6, 2.6),
    pitch: clamp((last.pitch - first.pitch) / dt, -2.6, 2.6)
  };
}

canvas.addEventListener("pointermove", (e) => {
  const prev = engine.pointers.get(e.pointerId);
  if (!prev) return;
  const now = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (Math.hypot(now.x - prev.x, now.y - prev.y) > 3) {
    if (!moved) { hintEl.hidden = true; markHint(); }
    moved = true;
  }
  engine.pointers.set(e.pointerId, now);
  if (engine.pointers.size >= 2) {
    dragSamples = [];
    const pts = [...engine.pointers.values()];
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    if (!engine.pointers.pinch) { engine.pointers.pinch = dist; engine.pointers.fov = engine.view.fov; }
    engine.zoomToward((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, engine.pointers.fov * (engine.pointers.pinch / Math.max(1, dist)));
    return;
  }
  const a0 = engine.angAt(prev.x, prev.y, engine.view.fov);
  const a1 = engine.angAt(now.x, now.y, engine.view.fov);
  const dyaw = a1.x - a0.x;
  const dpitch = a0.y - a1.y;
  if (!dragSamples.length) dragSamples.push({ t: prev.t, yaw: 0, pitch: 0 });
  const last = dragSamples[dragSamples.length - 1];
  dragSamples.push({ t: now.t, yaw: last.yaw + dyaw, pitch: last.pitch + dpitch });
  while (dragSamples.length > 16 || (dragSamples.length > 2 && now.t - dragSamples[0].t > 160)) dragSamples.shift();
  engine.nudge(dyaw, dpitch);
  engine.kick();
});

function endPointer(e) {
  if (!engine.pointers.has(e.pointerId)) return;
  engine.pointers.delete(e.pointerId);
  if (engine.pointers.size < 2) engine.pointers.pinch = 0;
  if (engine.pointers.size === 1) dragSamples = [];
  if (engine.pointers.size === 0) {
    document.body.classList.remove("is-dragging");
    const v = releaseVelocity();
    if (!reduce && moved && v && Math.hypot(v.yaw, v.pitch) > 0.2) {
      engine.setInertia({ yaw: v.yaw, pitch: v.pitch, on: true });
      engine.kick();
    }
    dragSamples = [];
    if (!moved && pointMode) placeSpotAt(e.clientX, e.clientY);
    else if (!moved) toggleChrome();
  }
}

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("gesturestart", (e) => e.preventDefault());
canvas.addEventListener("gesturechange", (e) => e.preventDefault());
canvas.addEventListener("lostpointercapture", (e) => { if (engine.pointers.has(e.pointerId)) endPointer(e); });
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("dblclick", (e) => {
  if (!viewing) return;
  engine.zoomToward(e.clientX, e.clientY, engine.view.fov < 46 ? HOME_FOV : engine.view.fov * 0.72);
});
canvas.addEventListener("wheel", (e) => {
  if (!viewing) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
  engine.zoomToward(e.clientX, e.clientY, engine.view.fov * Math.exp(e.deltaY * unit * (e.ctrlKey ? 0.007 : 0.0015)));
}, { passive: false });

window.addEventListener("pointerdown", () => { keyboardNav = false; }, true);

window.addEventListener("keydown", (e) => {
  const key = (e.key || "").toLowerCase();
  if (key === "escape") {
    if (!$("lightbox").hidden) { sheets.closeLightbox(); return; }
    if (!$("sheet-back").hidden) { sheets.closeSheets(); return; }
    if (!noteCard.hidden) { sheets.closeNoteCard(); return; }
  }
  if (!$("lightbox").hidden || !$("sheet-back").hidden) return;
  if (!viewing) return;
  if (!["shift", "control", "alt", "meta"].includes(key)) {
    keyboardNav = true;
    if (!chrome.classList.contains("is-on")) showChrome();
  }
  if (e.target && e.target.closest && e.target.closest("input, textarea, select")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const arrows = { arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down" };
  if (arrows[key]) {
    engine.held.add(arrows[key]);
    if (e.shiftKey) engine.held.add("shift");
    e.preventDefault();
    engine.kick();
    return;
  }
  if (e.key === "Shift") engine.held.add("shift");
  if (key === "+" || key === "=") { engine.zoomToward(innerWidth / 2, innerHeight / 2, engine.view.fov * 0.9); e.preventDefault(); }
  else if (key === "-" || key === "_") { engine.zoomToward(innerWidth / 2, innerHeight / 2, engine.view.fov / 0.9); e.preventDefault(); }
  else if (key === "0") engine.resetView();
  else if (key === "f") toggleFull();
  else if (key === "escape") {
    if (engine.isVR()) engine.exitVR();
    else if ($("bar-extra")?.classList.contains("is-open")) { setBarExtra(false); $("bar-more").focus(); }
    else if (!adjustPanel.hidden) setAdjust(false);
    else if (pointMode) setPointMode(false);
    else if (!fullscreenOn() && !isEmbed) closeView();
  }
});

window.addEventListener("keyup", (e) => {
  const key = e.key.toLowerCase();
  const arrows = { arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down" };
  if (arrows[key]) engine.held.delete(arrows[key]);
  if (e.key === "Shift") engine.held.delete("shift");
});

window.addEventListener("blur", () => engine.held.clear());
window.addEventListener("resize", () => { if (viewing) engine.kick(); });
document.addEventListener("fullscreenchange", syncFull);
document.addEventListener("webkitfullscreenchange", syncFull);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushBeat(); });
window.addEventListener("pagehide", flushBeat);

// Drag-and-drop file upload + scene-link drop
function hasFiles(e) {
  return !!(e.dataTransfer && e.dataTransfer.types && [...e.dataTransfer.types].includes("Files"));
}
window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth += 1; veil.hidden = false; } });
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types && [...e.dataTransfer.types].includes("text/pano-scene")) { e.preventDefault(); return; }
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) veil.hidden = true; });
window.addEventListener("dragend", () => { dragDepth = 0; veil.hidden = true; });
window.addEventListener("drop", (e) => {
  const sceneId = e.dataTransfer?.getData("text/pano-scene");
  if (sceneId) { e.preventDefault(); dragDepth = 0; veil.hidden = true; dropSceneLink(sceneId, e.clientX, e.clientY); return; }
  if (!hasFiles(e) && !e.dataTransfer?.files?.length) return;
  e.preventDefault(); dragDepth = 0; veil.hidden = true;
  ingest(e.dataTransfer.files);
});

// Dashboard drag-to-group albums
window.addEventListener("pointermove", (e) => {
  if (!albumDrag) return;
  if (!albumDrag.ghost && Math.hypot(e.clientX - albumDrag.x, e.clientY - albumDrag.y) < 8) return;
  if (!albumDrag.ghost) {
    albumMoved = true;
    try { albumDrag.handle.setPointerCapture(albumDrag.pointerId); } catch (err) { /* ignore */ }
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    if (albumDrag.thumb) { const img = document.createElement("img"); img.alt = ""; img.src = albumDrag.thumb; ghost.appendChild(img); }
    document.body.appendChild(ghost);
    albumDrag.ghost = ghost;
    albumDrag.card.classList.add("is-dragging-card");
  }
  albumDrag.ghost.style.left = e.clientX + "px";
  albumDrag.ghost.style.top = e.clientY + "px";
  document.querySelectorAll(".album.is-drop").forEach((el) => el.classList.remove("is-drop"));
  const target = dropTargetAt(e.clientX, e.clientY, albumDrag.id);
  if (target) target.classList.add("is-drop");
});

window.addEventListener("pointerup", (e) => {
  if (!albumDrag) return;
  const dragged = albumDrag;
  const target = dragged.ghost ? dropTargetAt(e.clientX, e.clientY, dragged.id) : null;
  if (dragged.ghost && target && target.dataset.id) {
    groupTours(dragged.id, target.dataset.id, dragged.kind, target.dataset.kind);
  }
  if (dragged.ghost) dragged.ghost.remove();
  dragged.card.classList.remove("is-dragging-card");
  document.querySelectorAll(".album.is-drop").forEach((el) => el.classList.remove("is-drop"));
  albumDrag = null;
  if (dragged.ghost) setTimeout(() => { albumMoved = false; }, 320);
});

window.addEventListener("pointercancel", () => {
  if (!albumDrag) return;
  if (albumDrag.ghost) albumDrag.ghost.remove();
  albumDrag.card.classList.remove("is-dragging-card");
  document.querySelectorAll(".album.is-drop").forEach((el) => el.classList.remove("is-drop"));
  albumDrag = null; albumMoved = false;
});

/* ---------- UI Button Bindings ---------- */
chooseBtn.addEventListener("click", () => fileInput.click());
$("choose-more").addEventListener("click", () => fileInput.click());
sampleBtn.addEventListener("click", openSampleTour);
$("sample-more").addEventListener("click", openSampleTour);
accountBtn.addEventListener("click", openAccount);
plansBtn.addEventListener("click", () => openPlansSheet(sheetCtx()));
$("dash-upgrade").addEventListener("click", () => openPlansSheet(sheetCtx()));
doneBtn.addEventListener("click", closeView);
$("name").addEventListener("click", () => { const c = currentCollection(); if (c) openShowcaseOverlay(sheetCtx(), c); });
showcaseBtn.addEventListener("click", () => { const c = currentCollection(); if (c) openShowcaseOverlay(sheetCtx(), c); });
docsBtn.addEventListener("click", () => { const c = currentCollection(); if (c) openShowcaseOverlay(sheetCtx(), c); });
shareBtn.addEventListener("click", () => openShareSheet(sheetCtx()));
fullBtn.addEventListener("click", toggleFull);
motionBtn.addEventListener("click", () => engine.toggleMotion(motionBtn));
vrBtn.addEventListener("click", () => engine.toggleVR());
vrExitBtn.addEventListener("click", () => engine.exitVR());
dialBtn.addEventListener("click", () => engine.resetView());
spinToggleBtn.addEventListener("click", () => {
  engine.setSpinPaused(!engine.isSpinPaused());
  spinToggleBtn.setAttribute("aria-pressed", !engine.isSpinPaused() ? "true" : "false");
});
pointBtn.addEventListener("click", () => setPointMode(!pointMode));
adjustBtn.addEventListener("click", () => setAdjust(adjustPanel.hidden));
mapBtn.addEventListener("click", () => openFloorPlanSheet(sheetCtx(), !publicTour));
addBtn.addEventListener("click", () => fileInput.click());
moreBtn.addEventListener("click", openToolsMenu);
$("add-center").addEventListener("click", placeSpotAtCenter);
$("edit-toggle").addEventListener("click", () => {
  const on = !dockEl.classList.contains("is-editing");
  setEditDock(on);
  if (!on) { setPointMode(false); setAdjust(false); }
  showChrome(true);
});
$("bar-more").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = !$("bar-extra").classList.contains("is-open");
  setBarExtra(open);
  if (open) showChrome(true);
});
$("bar-extra").addEventListener("click", (e) => { if (e.target.closest("button")) setBarExtra(false); });
document.addEventListener("click", (e) => {
  if (!e.target.closest("#bar-extra, #bar-more")) setBarExtra(false);
});
$("hero-preview").addEventListener("click", openSampleTour);

fileInput.addEventListener("change", () => {
  const files = fileInput.files;
  if (files && files.length) ingest(files);
  fileInput.value = "";
});

extraFileInput.addEventListener("change", () => {
  const file = extraFileInput.files && extraFileInput.files[0];
  const fn = extraPick;
  extraPick = null;
  extraFileInput.value = "";
  if (file && fn) fn(file);
});

// Dashboard search, filters, folders & batch bar
$("library-search").addEventListener("input", (e) => { searchQuery = e.target.value; renderHome(); });
document.querySelectorAll(".filter-pills button").forEach((b) => {
  b.addEventListener("click", () => {
    filterMode = b.dataset.filter;
    document.querySelectorAll(".filter-pills button").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    renderHome();
  });
});
$("new-folder-btn").addEventListener("click", () => {
  const node = document.createElement("div");
  const f = field("Folder Name", nextFolderTitle());
  const sv = document.createElement("button");
  sv.className = "primary light"; sv.type = "button"; sv.textContent = "Create Folder";
  sv.addEventListener("click", async () => {
    const title = f.input.value.trim() || nextFolderTitle();
    folders.unshift({ id: uid(), title });
    await saveMeta();
    sheets.closeSheets();
    toast(`Created folder "${title}" — drag tours onto it`);
    renderHome();
  });
  node.append(f.wrap, sv);
  sheets.openSheet("New Folder", node);
});
$("library-back").addEventListener("click", () => { openFolderId = null; librarySelecting = false; librarySelected.clear(); renderHome(); });
$("library-select").addEventListener("click", () => { librarySelecting = !librarySelecting; if (!librarySelecting) librarySelected.clear(); renderHome(); });
$("library-title").addEventListener("click", () => {
  const folder = folders.find((f) => f.id === openFolderId);
  if (!folder || librarySelecting) return;
  const node = document.createElement("div");
  const f = field("Folder Name", folder.title);
  const sv = document.createElement("button");
  sv.className = "primary light"; sv.type = "button"; sv.textContent = "Save";
  sv.addEventListener("click", async () => {
    folder.title = f.input.value.trim() || "Folder";
    collections.forEach((c) => { if (c.folderId === folder.id) c.folder = folder.title; });
    await saveMeta();
    sheets.closeSheets();
    renderHome();
  });
  node.append(f.wrap, sv);
  sheets.openSheet("Rename Folder", node);
});
$("library-share").addEventListener("click", () => {
  const tour = [...librarySelected].map(collectionById).find(Boolean);
  if (tour) { currentCollectionId = tour.id; openShareSheet(sheetCtx()); }
});
$("library-duplicate").addEventListener("click", () => {
  const tour = [...librarySelected].map(collectionById).find(Boolean);
  if (tour) { librarySelecting = false; librarySelected.clear(); duplicateTour(tour); }
});
$("library-folder").addEventListener("click", async () => {
  const tours = [...librarySelected].map(collectionById).filter(Boolean);
  if (tours.length < 2) return;
  const folder = { id: uid(), title: nextFolderTitle() };
  folders.unshift(folder);
  tours.forEach((t) => { t.folderId = folder.id; t.folder = folder.title; });
  pruneFolders();
  librarySelected.clear(); librarySelecting = false;
  await saveMeta(); renderHome();
  toast(`Grouped into "${folder.title}"`);
});
$("library-remove").addEventListener("click", async () => {
  [...librarySelected].forEach((id) => {
    const t = collectionById(id);
    if (t) { t.folderId = ""; t.folder = ""; }
  });
  pruneFolders();
  librarySelected.clear(); librarySelecting = false;
  if (openFolderId && !folders.some((f) => f.id === openFolderId)) openFolderId = null;
  await saveMeta(); renderHome();
});
$("library-delete").addEventListener("click", () => {
  const tours = [];
  [...librarySelected].forEach((id) => {
    const t = collectionById(id);
    if (t) tours.push(t);
    collections.filter((c) => c.folderId === id).forEach((c) => tours.push(c));
  });
  confirmDeleteCollections(tours);
});

// Enhance Panel Controls (Lighting, Color, Sharpness, Auto Enhance, AI 2x Upscale, Orientation)
$("adjust-done").addEventListener("click", () => { setAdjust(false); persistCurrent(); });
const compareBtn = $("compare-btn");
compareBtn.addEventListener("pointerdown", () => engine.setBypassGrade(true));
compareBtn.addEventListener("pointerup", () => engine.setBypassGrade(false));
compareBtn.addEventListener("pointerleave", () => engine.setBypassGrade(false));

$("auto-grade").addEventListener("click", async () => {
  const scene = currentScene();
  if (!scene || !scene.blob) return;
  try {
    const res = await computeAutoEnhance(scene.blob, engine.isLinear());
    scene.bright = res.bright;
    scene.contrast = res.contrast;
    scene.grade = res.grade;
    syncAdjustSliders(scene);
    engine.kick();
    await persistCurrent();
    toast("Auto-enhanced lighting, color & sharpness");
  } catch (err) {
    toast("Couldn't auto-enhance this scene.");
  }
});

$("upscale-btn").addEventListener("click", async () => {
  const scene = currentScene();
  if (!scene || !scene.blob) return;
  const btn = $("upscale-btn");
  const meta = $("upscale-meta");
  btn.disabled = true;
  if (!scene.originalBlob) scene.originalBlob = scene.blob;
  try {
    const res = await upscaleScene2x(scene, {
      account,
      onProgress: (pct, msg) => { meta.textContent = `${pct}% · ${msg}`; }
    });
    scene.blob = res.blob;
    scene.width = res.width;
    scene.height = res.height;
    scene.upscaled = true;
    const decoded = await decodeFile(res.blob, engine.maxTextureSize());
    scene.thumb = thumbOf(decoded.source);
    engine.uploadTexture(decoded.source);
    await saveScene(scene);
    syncAdjustSliders(scene);
    paintStrip();
    toast(`Upscaled to ${res.width}×${res.height} (2× Super-Resolution)`);
  } catch (err) {
    toast(err.message || "Upscaling failed.");
    syncAdjustSliders(scene);
  }
});

$("upscale-revert").addEventListener("click", async () => {
  const scene = currentScene();
  if (!scene || !scene.originalBlob) return;
  scene.blob = scene.originalBlob;
  scene.originalBlob = null;
  scene.upscaled = false;
  const decoded = await decodeFile(scene.blob, engine.maxTextureSize());
  scene.width = decoded.original.width;
  scene.height = decoded.original.height;
  scene.thumb = thumbOf(decoded.source);
  engine.uploadTexture(decoded.source);
  await saveScene(scene);
  syncAdjustSliders(scene);
  paintStrip();
  toast("Reverted to original 1× resolution");
});

["exposure", "highlights", "shadows", "bright", "contrast", "black", "saturation", "warmth", "sharpness"].forEach((id) => {
  $(id).addEventListener("input", (e) => {
    const val = Number(e.target.value);
    const vEl = $("val-" + id);
    if (vEl) vEl.textContent = String(val);
    const scene = currentScene();
    if (!scene) return;
    scene.grade = gradeOf(scene);
    if (id === "bright") scene.bright = val / 100;
    else if (id === "contrast") scene.contrast = val / 100;
    else if (id === "exposure") scene.grade.exposure = (val / 100) * 2;
    else if (id === "black") scene.grade.black = (val / 100) * 0.4;
    else if (id === "saturation") scene.grade.saturation = val / 100;
    else if (id === "sharpness") scene.grade.sharpness = val / 100;
    else scene.grade[id] = val / 100;
    engine.kick();
  });
  $(id).addEventListener("change", () => persistCurrent());
});

rollInput.addEventListener("input", () => {
  let deg = Number(rollInput.value);
  if (Math.abs(deg) < 0.4) deg = 0;
  engine.orient.roll = deg * Math.PI / 180;
  $("val-roll").textContent = `${deg.toFixed(1)}°`;
  engine.kick();
});
rollInput.addEventListener("change", () => persistCurrent());

$("rotate").addEventListener("click", () => { engine.orient.yaw -= Math.PI / 2; engine.kick(); persistCurrent(); });
$("flipx").addEventListener("click", () => { engine.orient.flipX *= -1; engine.kick(); persistCurrent(); });
$("flipy").addEventListener("click", () => { engine.orient.flipY *= -1; engine.kick(); persistCurrent(); });
$("set-opening").addEventListener("click", async () => {
  engine.opening.yaw = engine.view.yaw;
  engine.opening.pitch = engine.view.pitch;
  engine.opening.fov = engine.view.fov;
  await persistCurrent();
  toast("Starting camera orientation saved");
});
$("orient-reset").addEventListener("click", () => {
  engine.orient.yaw = 0; engine.orient.roll = 0; engine.orient.flipX = 1; engine.orient.flipY = 1;
  const scene = currentScene();
  if (scene) { scene.bright = 0; scene.contrast = 1; scene.grade = {}; }
  syncAdjustSliders(scene || {});
  engine.kick();
  persistCurrent();
  toast("Adjustments reset");
});

if ("DeviceOrientationEvent" in window && (coarse || navigator.maxTouchPoints > 0)) motionBtn.hidden = false;
if (!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)) fullBtn.hidden = true;
window.addEventListener("storage", (e) => { if (e.key === "pano-auth") refreshMe(); });

/* ---------- Boot Routing ---------- */
const bootPath = location.pathname.replace(/\/$/, "");
const bootSlug = bootPath.startsWith("/panorama/v/") ? decodeURIComponent(bootPath.slice("/panorama/v/".length)) : "";
const bootHashEdit = (location.hash.match(/^#edit=([A-Za-z0-9_-]+)/) || [])[1] || "";
const bootEdit = bootHashEdit
  || (bootPath.startsWith("/panorama/e/") ? decodeURIComponent(bootPath.slice("/panorama/e/".length)) : "");
const bootToken = bootPath.endsWith("/panorama/link") ? params.get("token_hash") : "";

if (bootToken) openConfirm(bootToken);
else if (bootSlug) loadPublic(bootSlug);
else if (bootEdit) loadEdit(bootEdit).catch((err) => showError(err.message || "This edit link doesn't exist."));
else {
  refreshMe();
  loadLibrary();
}
