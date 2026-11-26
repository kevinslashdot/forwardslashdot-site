/**
 * Panorama modals, sheets & rich overlays:
 * Showcase, Hotspot/Infospot/Video/CTA/PDF editor & card, Interactive Floor Plan with FOV radar,
 * Share/QR Studio/Embed/Password/Edit-Link, Tour Settings & Branding/Loading Animation,
 * Engagement Analytics Dashboard, Auth & Plans/Quotas.
 */

import { formatBytes, formatDuration, renderQrCanvas, downloadQrPng, MAX_PDF_BYTES, MAX_PLAN_BYTES } from "./media.js";

export function tapVerb() {
  return matchMedia("(pointer: coarse)").matches ? "Tap" : "Click";
}

export function safeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return s;
  return "";
}

export function parseVideoEmbed(url) {
  const clean = safeUrl(url);
  if (!clean) return null;
  let m = clean.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) return { type: "iframe", src: `https://www.youtube-nocookie.com/embed/${m[1]}?rel=0` };
  m = clean.match(/vimeo\.com\/(?:video\/)?(\d{6,12})/);
  if (m) return { type: "iframe", src: `https://player.vimeo.com/video/${m[1]}` };
  return { type: "video", src: clean };
}

export function hotspotIconSvg(icon, heading = 0) {
  const rot = icon === "arrow" || icon === "chevron" || icon === "walk" ? ` style="transform:rotate(${Number(heading) || 0}deg)"` : "";
  const map = {
    dot: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.2" fill="currentColor"/></svg>`,
    arrow: `<svg viewBox="0 0 16 16"${rot}><path d="M8 2.5 L13 8.2 H9.7 V13.5 H6.3 V8.2 H3 Z" fill="currentColor"/></svg>`,
    chevron: `<svg viewBox="0 0 16 16"${rot}><path d="M3.5 10.2 L8 5.2 L12.5 10.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    walk: `<svg viewBox="0 0 16 16"${rot}><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4.4 L10.6 8.5 H5.4 Z" fill="currentColor"/></svg>`,
    info: `<svg viewBox="0 0 16 16"><circle cx="8" cy="4.6" r="1.2" fill="currentColor"/><rect x="7" y="7" width="2" height="5.2" rx="1" fill="currentColor"/></svg>`,
    pin: `<svg viewBox="0 0 16 16"><path d="M8 14s4.5-4.3 4.5-8a4.5 4.5 0 1 0-9 0c0 3.7 4.5 8 4.5 8z" fill="currentColor"/><circle cx="8" cy="6" r="1.6" fill="#fff"/></svg>`,
    video: `<svg viewBox="0 0 16 16"><path d="M5.5 3.6 L12.8 8 L5.5 12.4 Z" fill="currentColor"/></svg>`,
    link: `<svg viewBox="0 0 16 16"><path d="M6.4 9.6 L9.6 6.4 M7.2 4.4 L8.8 2.8 a2.8 2.8 0 0 1 4 4 l-1.6 1.6 M8.8 11.6 l-1.6 1.6 a2.8 2.8 0 0 1-4-4 l1.6-1.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    pdf: `<svg viewBox="0 0 16 16"><path d="M4.2 2.2h5.2l2.4 2.4v9.2H4.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6 8.6h4M6 11h2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
  };
  return map[icon] || map.dot;
}

export function field(label, value, attrs) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement(attrs && attrs.area ? "textarea" : "input");
  input.className = "field";
  input.value = value == null ? "" : String(value);
  if (attrs) {
    const { area, ...rest } = attrs;
    Object.assign(input, rest);
  }
  wrap.appendChild(input);
  return { wrap, input };
}

export const ICONS = {
  close: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.2 L11.8 11.8 M11.8 4.2 L4.2 11.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  more: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.4" cy="8" r="1.15" fill="currentColor"/><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="12.6" cy="8" r="1.15" fill="currentColor"/></svg>`,
  check: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8.4 L6.6 11.4 L12.6 4.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  star: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6 L9.6 6.1 L13.3 6.5 L10.5 9 L11.3 12.7 L8 10.8 L4.7 12.7 L5.5 9 L2.7 6.5 L6.4 6.1 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`
};

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=\"hidden\"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex=\"-1\"])";

function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest("[hidden]") && el.getClientRects().length);
}

function trapTab(e, root) {
  if (e.key !== "Tab") return;
  const items = focusablesIn(root);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

function restoreFocus(el) {
  if (el && el.isConnected && typeof el.focus === "function" && !el.closest("[inert]")) {
    try { el.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
  }
}

export function createSheetManager({ sheetBack, sheetEl, sheetTitle, sheetBody, noteCard, lightbox, lightboxImg, onShowChrome, isViewing }) {
  const inertTargets = ["stage", "chrome", "spots"];
  let savedInert = null;
  let sheetReturn = null;
  let lightboxReturn = null;
  let noteReturn = null;

  function setBackgroundInert(on) {
    if (on && !savedInert) {
      savedInert = new Map();
      inertTargets.forEach((id) => {
        const el = document.getElementById(id);
        if (el) { savedInert.set(el, el.inert); el.inert = true; }
      });
    } else if (!on && savedInert) {
      savedInert.forEach((was, el) => { el.inert = was; });
      savedInert = null;
    }
  }

  function closeNoteCard() {
    if (noteCard.hidden) return;
    noteCard.hidden = true;
    const back = noteReturn;
    noteReturn = null;
    restoreFocus(back);
  }

  function openNoteCard(focusEl) {
    if (noteCard.hidden) noteReturn = document.activeElement;
    noteCard.hidden = false;
    setTimeout(() => (focusEl || noteCard).focus(), 30);
  }

  function closeSheets() {
    const wasOpen = !sheetBack.hidden;
    sheetBack.hidden = true;
    sheetEl.classList.remove("is-wide");
    noteCard.hidden = true;
    noteReturn = null;
    document.body.classList.remove("is-sheet");
    setBackgroundInert(false);
    if (wasOpen) {
      const back = sheetReturn;
      sheetReturn = null;
      restoreFocus(back);
    }
  }

  function openSheet(title, node, opts = {}) {
    if (sheetBack.hidden) {
      const active = document.activeElement;
      sheetReturn = active && active !== document.body && !sheetBack.contains(active) ? active : null;
    }
    sheetTitle.textContent = title;
    sheetBody.innerHTML = "";
    sheetBody.appendChild(node);
    sheetEl.classList.toggle("is-wide", !!opts.wide);
    sheetBack.hidden = false;
    document.body.classList.add("is-sheet");
    if (isViewing()) onShowChrome(true);
    setBackgroundInert(true);
    const focusable = opts.initialFocus || node.querySelector("input:not([type=\"hidden\"]), textarea, select, button") || document.getElementById("sheet-close");
    if (focusable) setTimeout(() => focusable.focus(), 30);
  }

  function currentTitle() {
    return sheetBack.hidden ? "" : sheetTitle.textContent;
  }

  function openLightbox(src, alt) {
    if (!src) return;
    lightboxReturn = document.activeElement;
    lightboxImg.src = src;
    lightboxImg.alt = alt || "Enlarged photo";
    lightbox.setAttribute("aria-label", alt ? `Photo: ${alt}` : "Photo viewer");
    lightbox.hidden = false;
    sheetBack.inert = true;
    const close = document.getElementById("lightbox-close");
    setTimeout(() => (close || lightbox).focus(), 30);
  }

  function closeLightbox() {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    lightboxImg.src = "";
    sheetBack.inert = false;
    const back = lightboxReturn;
    lightboxReturn = null;
    restoreFocus(back);
  }

  lightbox.addEventListener("click", closeLightbox);
  lightbox.addEventListener("keydown", (e) => trapTab(e, lightbox));
  sheetEl.addEventListener("keydown", (e) => trapTab(e, sheetEl));
  noteCard.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeNoteCard(); }
  });
  document.getElementById("sheet-close").addEventListener("click", closeSheets);
  sheetBack.addEventListener("click", (e) => { if (e.target === sheetBack) closeSheets(); });

  return { openSheet, closeSheets, openLightbox, closeLightbox, openNoteCard, closeNoteCard, currentTitle };
}

export function pdfDownloadHref(collection, att) {
  if (att.blob) {
    if (!att.blobUrl) att.blobUrl = URL.createObjectURL(att.blob);
    return att.blobUrl;
  }
  if (collection.slug) {
    return `/panorama/api/file/${encodeURIComponent(collection.slug)}/${encodeURIComponent(att.id)}?download=1`;
  }
  return "";
}

/* ---------- Showcase Overlay (Project Details, Gallery, PDFs, Contact, CTA) ---------- */
export function openShowcaseOverlay(ctx, collection) {
  const { sheets, openTourSettings, isPublic } = ctx;
  const node = document.createElement("div");

  if (collection.logoUrl) {
    const img = document.createElement("img");
    img.src = collection.logoUrl;
    img.alt = collection.title;
    img.className = "showcase-logo";
    node.appendChild(img);
  }

  const blurb = document.createElement("p");
  blurb.className = "sub";
  blurb.textContent = collection.blurb || "Interactive 360° virtual tour. Drag to look around, select hotspots for details, or switch to VR mode.";
  node.appendChild(blurb);

  // Image Gallery
  const gallery = (collection.gallery || []).filter((g) => g.url);
  if (gallery.length) {
    const sec = document.createElement("div");
    sec.className = "stat-section";
    sec.innerHTML = "<h3>Gallery</h3>";
    const row = document.createElement("div");
    row.className = "gallery-row";
    gallery.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gallery-thumb";
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = item.name || "Gallery photo";
      btn.appendChild(img);
      btn.setAttribute("aria-label", `View ${img.alt} larger`);
      btn.addEventListener("click", () => sheets.openLightbox(item.url, img.alt));
      row.appendChild(btn);
    });
    sec.appendChild(row);
    node.appendChild(sec);
  }

  // Downloadable PDF Attachments
  const attachments = collection.attachments || [];
  if (attachments.length) {
    const sec = document.createElement("div");
    sec.className = "stat-section";
    sec.innerHTML = "<h3>Downloadable Documents</h3>";
    const list = document.createElement("div");
    list.className = "attach-list";
    attachments.forEach((att) => {
      const href = pdfDownloadHref(collection, att);
      const item = document.createElement("div");
      item.className = "attach-item";
      const meta = document.createElement("div");
      meta.className = "attach-item-meta";
      const strong = document.createElement("strong");
      strong.textContent = att.name || "Document.pdf";
      const sp = document.createElement("span");
      sp.textContent = att.bytes ? `PDF · ${formatBytes(att.bytes)}` : "PDF Document";
      meta.append(strong, sp);
      const dl = document.createElement("a");
      dl.className = "attach-btn";
      dl.textContent = "Download";
      dl.href = href || "#";
      dl.download = att.name || "document.pdf";
      if (!href) { dl.classList.add("is-disabled"); dl.setAttribute("aria-disabled", "true"); }
      item.append(meta, dl);
      list.appendChild(item);
    });
    sec.appendChild(list);
    node.appendChild(sec);
  }

  // Contact Card (creator-authored contact & showcase info — no public comment threads)
  const c = collection.contact || {};
  if (c.name || c.role || c.email || c.phone || c.website) {
    const box = document.createElement("div");
    box.className = "info-box";
    const h = document.createElement("strong");
    h.className = "box-title";
    h.textContent = [c.name, c.role].filter(Boolean).join(" · ") || "Contact";
    box.appendChild(h);
    const links = document.createElement("div");
    links.className = "contact-links";
    if (c.email) {
      const a = document.createElement("a");
      a.href = `mailto:${c.email}`;
      a.textContent = c.email;
      links.appendChild(a);
    }
    if (c.phone) {
      const a = document.createElement("a");
      a.href = `tel:${c.phone.replace(/[^+\d]/g, "")}`;
      a.textContent = c.phone;
      links.appendChild(a);
    }
    if (safeUrl(c.website)) {
      const a = document.createElement("a");
      a.href = safeUrl(c.website);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = c.website.replace(/^https?:\/\//, "");
      links.appendChild(a);
    }
    box.appendChild(links);
    node.appendChild(box);
  }

  const ctaUrl = safeUrl(collection.linkUrl);
  if (ctaUrl) {
    const a = document.createElement("a");
    a.className = "primary light";
    a.href = ctaUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = collection.linkLabel || "Learn More";
    node.appendChild(a);
  }

  if (!isPublic) {
    const editBtn = document.createElement("button");
    editBtn.className = "linkish";
    editBtn.type = "button";
    editBtn.textContent = "Edit Showcase, Branding & PDFs";
    editBtn.addEventListener("click", () => openTourSettings(collection));
    node.appendChild(editBtn);
  }

  sheets.openSheet(collection.title || "Tour Showcase", node);
}

/* ---------- Hotspot / Infospot Viewer Card ---------- */
export function showSpotCard(ctx, spot, collection) {
  const { noteCard, openSpotEditor, isPublic, sheets } = ctx;
  noteCard.innerHTML = "";
  noteCard.setAttribute("role", "dialog");
  noteCard.setAttribute("aria-labelledby", "note-card-title");
  noteCard.tabIndex = -1;
  const head = document.createElement("div");
  head.className = "note-card-head";
  const strong = document.createElement("strong");
  strong.id = "note-card-title";
  strong.textContent = spot.title || "Details";
  const close = document.createElement("button");
  close.className = "note-card-close";
  close.type = "button";
  close.innerHTML = ICONS.close;
  close.setAttribute("aria-label", "Close details");
  close.addEventListener("click", (e) => { e.stopPropagation(); sheets.closeNoteCard(); });
  head.append(strong, close);
  noteCard.appendChild(head);

  if (spot.body) {
    const p = document.createElement("p");
    p.textContent = spot.body;
    noteCard.appendChild(p);
  }

  if (spot.kind === "video" && spot.url) {
    const parsed = parseVideoEmbed(spot.url);
    if (parsed && parsed.type === "iframe") {
      const iframe = document.createElement("iframe");
      iframe.className = "video-frame";
      iframe.src = parsed.src;
      iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";
      iframe.allowFullscreen = true;
      noteCard.appendChild(iframe);
    } else if (parsed) {
      const video = document.createElement("video");
      video.className = "video-frame";
      video.src = parsed.src;
      video.controls = true;
      video.playsInline = true;
      noteCard.appendChild(video);
    }
  }

  const actions = document.createElement("div");
  actions.className = "note-card-actions";
  if (spot.kind === "pdf") {
    const att = (collection.attachments || []).find((a) => a.id === spot.fileId) || (collection.attachments || [])[0];
    if (att) {
      const a = document.createElement("a");
      a.className = "primary is-compact";
      a.href = pdfDownloadHref(collection, att) || "#";
      a.download = att.name || "document.pdf";
      a.textContent = `Download ${att.name}`;
      actions.appendChild(a);
    }
  } else if (safeUrl(spot.url) && spot.kind !== "video") {
    const a = document.createElement("a");
    a.className = "primary is-compact";
    a.href = safeUrl(spot.url);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = spot.ctaLabel || "Open Link";
    actions.appendChild(a);
  }

  if (!isPublic) {
    const edit = document.createElement("button");
    edit.className = "secondary is-compact";
    edit.type = "button";
    edit.textContent = "Edit Hotspot";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      noteCard.hidden = true;
      openSpotEditor(spot);
    });
    actions.appendChild(edit);
  }

  if (actions.children.length) noteCard.appendChild(actions);
  sheets.openNoteCard(close);
}

/* ---------- Hotspot / Infospot Editor ---------- */
export function openSpotEditor(ctx, spot) {
  const { sheets, currentScene, currentCollection, sceneMap, persistCurrent, paintSpotButtons, startMoveSpot, toast } = ctx;
  const scene = currentScene();
  const collection = currentCollection();
  if (!scene || !collection) return;

  const draft = {
    icon: spot.icon || (spot.kind === "scene" ? "arrow" : "info"),
    color: spot.color || "#ffffff",
    size: spot.size || "m",
    motion: spot.motion || "still",
    hover: spot.hover || "scale",
    kind: spot.kind || "note",
    heading: Number(spot.heading) || 0
  };

  const node = document.createElement("div");
  const title = field("Label", spot.title || "");

  const seg = document.createElement("div");
  seg.className = "seg";
  const kinds = [["scene", "Scene Link"], ["note", "Infospot"], ["video", "Video"], ["link", "CTA"], ["pdf", "PDF"]];
  const bodyField = field("Annotation / Description", spot.body || "", { area: true, placeholder: "Highlight details about this object or space…" });
  const urlField = field("URL", spot.url || "", { placeholder: "https://youtube.com/watch?v=... or https://..." });
  const ctaField = field("CTA Button Text", spot.ctaLabel || "", { placeholder: "Book a Viewing" });

  const sceneWrap = document.createElement("label");
  sceneWrap.textContent = "Target Scene";
  const scenePick = document.createElement("select");
  scenePick.className = "field";
  (collection.sceneIds || []).forEach((id) => {
    if (id === scene.id) return;
    const other = sceneMap.get(id);
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = other ? other.title : "Scene";
    if (spot.target === id) opt.selected = true;
    scenePick.appendChild(opt);
  });
  if (!scenePick.children.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Add another scene to link to it";
    scenePick.appendChild(opt);
  }
  sceneWrap.appendChild(scenePick);

  const pdfWrap = document.createElement("label");
  pdfWrap.textContent = "Attached PDF Document";
  const pdfPick = document.createElement("select");
  pdfPick.className = "field";
  (collection.attachments || []).forEach((att) => {
    const opt = document.createElement("option");
    opt.value = att.id;
    opt.textContent = att.name;
    if (spot.fileId === att.id) opt.selected = true;
    pdfPick.appendChild(opt);
  });
  if (!pdfPick.children.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Upload a PDF in Tour Settings first";
    pdfPick.appendChild(opt);
  }
  pdfWrap.appendChild(pdfPick);

  const headingWrap = document.createElement("label");
  const headingLabel = document.createElement("span");
  headingLabel.textContent = `Marker Rotation (${draft.heading}°)`;
  const heading = document.createElement("input");
  heading.type = "range";
  heading.min = "0";
  heading.max = "360";
  heading.value = String(draft.heading);
  heading.addEventListener("input", () => {
    draft.heading = Number(heading.value) || 0;
    headingLabel.textContent = `Marker Rotation (${draft.heading}°)`;
    spot.heading = draft.heading;
    paintSpotButtons();
  });
  headingWrap.append(headingLabel, heading);

  function syncFields() {
    const k = draft.kind;
    sceneWrap.hidden = k !== "scene";
    headingWrap.hidden = k !== "scene";
    bodyField.wrap.hidden = k === "scene";
    urlField.wrap.hidden = k !== "link" && k !== "video" && k !== "note";
    urlField.wrap.firstChild.textContent = k === "video" ? "Video URL (YouTube, Vimeo, or MP4)" : (k === "note" ? "Optional Link URL" : "Destination URL");
    ctaField.wrap.hidden = k !== "link" && k !== "note";
    pdfWrap.hidden = k !== "pdf";
  }

  kinds.forEach(([k, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute("aria-pressed", draft.kind === k ? "true" : "false");
    btn.addEventListener("click", () => {
      draft.kind = k;
      [...seg.children].forEach((c) => c.setAttribute("aria-pressed", c === btn ? "true" : "false"));
      if (k === "scene" && draft.icon === "info") draft.icon = "arrow";
      if (k === "video") draft.icon = "video";
      if (k === "pdf") draft.icon = "pdf";
      syncFields();
    });
    seg.appendChild(btn);
  });
  syncFields();

  const iconLabel = document.createElement("label");
  iconLabel.textContent = "Icon";
  const icons = document.createElement("div");
  icons.className = "sizes";
  [["arrow", "Arrow"], ["chevron", "Chevron"], ["walk", "Walk"], ["dot", "Dot"], ["info", "Info"], ["pin", "Pin"], ["video", "Video"], ["link", "Link"], ["pdf", "PDF"]].forEach(([ic, lbl]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = lbl;
    b.setAttribute("aria-pressed", draft.icon === ic ? "true" : "false");
    b.addEventListener("click", () => {
      draft.icon = ic;
      [...icons.children].forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
    });
    icons.appendChild(b);
  });

  const colorLabel = document.createElement("label");
  colorLabel.textContent = "Marker Color";
  const swatches = document.createElement("div");
  swatches.className = "swatches";
  swatches.setAttribute("role", "group");
  swatches.setAttribute("aria-label", "Marker color");
  const customColor = document.createElement("input");
  customColor.type = "color";
  customColor.className = "color-input";
  customColor.setAttribute("aria-label", "Custom marker color");
  customColor.value = /^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : "#ffffff";
  customColor.addEventListener("input", () => {
    draft.color = customColor.value;
    swatches.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
  });
  [["#ffffff", "White"], ["#1c1917", "Charcoal"], ["#2f6f8f", "Ocean blue"], ["#c98470", "Terracotta"], ["#2e6b4e", "Forest green"], ["#d49b38", "Ochre"], ["#7c5cbf", "Violet"]].forEach(([col, colName]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.background = col;
    b.setAttribute("aria-label", colName);
    b.title = colName;
    b.setAttribute("aria-pressed", draft.color.toLowerCase() === col ? "true" : "false");
    b.addEventListener("click", () => {
      draft.color = col;
      customColor.value = col;
      swatches.querySelectorAll("button").forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
    });
    swatches.appendChild(b);
  });
  swatches.appendChild(customColor);

  const sizeLabel = document.createElement("label");
  sizeLabel.textContent = "Size & Hover Animation";
  const sizeRow = document.createElement("div");
  sizeRow.className = "sizes";
  [["s", "Small"], ["m", "Medium"], ["l", "Large"]].forEach(([sz, lbl]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = lbl;
    b.setAttribute("aria-pressed", draft.size === sz ? "true" : "false");
    b.addEventListener("click", () => {
      draft.size = sz;
      [...sizeRow.children].forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
    });
    sizeRow.appendChild(b);
  });

  const hoverRow = document.createElement("div");
  hoverRow.className = "sizes";
  [["scale", "Hover: Scale"], ["bounce", "Bounce"], ["glow", "Glow"], ["ring", "Ring"], ["none", "None"]].forEach(([hv, lbl]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = lbl;
    b.setAttribute("aria-pressed", draft.hover === hv ? "true" : "false");
    b.addEventListener("click", () => {
      draft.hover = hv;
      [...hoverRow.children].forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
    });
    hoverRow.appendChild(b);
  });

  const pulseBtn = document.createElement("button");
  pulseBtn.className = "linkish";
  pulseBtn.type = "button";
  const pulseText = () => (draft.motion === "pulse" ? "Idle pulse: On" : "Idle pulse: Off");
  pulseBtn.setAttribute("aria-pressed", draft.motion === "pulse" ? "true" : "false");
  pulseBtn.textContent = pulseText();
  pulseBtn.addEventListener("click", () => {
    draft.motion = draft.motion === "pulse" ? "still" : "pulse";
    pulseBtn.setAttribute("aria-pressed", draft.motion === "pulse" ? "true" : "false");
    pulseBtn.textContent = pulseText();
  });

  const moveBtn = document.createElement("button");
  moveBtn.className = "linkish";
  moveBtn.type = "button";
  moveBtn.textContent = "Reposition on 360° Scene";
  moveBtn.addEventListener("click", () => {
    sheets.closeSheets();
    startMoveSpot(spot);
  });

  const save = document.createElement("button");
  save.className = "primary light";
  save.type = "button";
  save.textContent = "Save Hotspot";
  save.addEventListener("click", async () => {
    spot.title = title.input.value.trim() || (draft.kind === "scene" ? "Next Scene" : "Details");
    spot.kind = draft.kind;
    spot.body = bodyField.input.value.trim();
    spot.url = safeUrl(urlField.input.value.trim());
    spot.ctaLabel = ctaField.input.value.trim();
    spot.target = scenePick.value || "";
    spot.fileId = pdfPick.value || "";
    spot.heading = draft.heading;
    spot.icon = draft.icon;
    spot.color = draft.color;
    spot.size = draft.size;
    spot.motion = draft.motion;
    spot.hover = draft.hover;
    await persistCurrent();
    paintSpotButtons();
    sheets.closeSheets();
    toast("Hotspot saved");
  });

  const del = document.createElement("button");
  del.className = "linkish is-danger";
  del.type = "button";
  del.textContent = "Delete Hotspot";
  del.addEventListener("click", async () => {
    const list = scene.hotspots || [];
    const index = list.findIndex((item) => item.id === spot.id);
    scene.hotspots = list.filter((item) => item.id !== spot.id);
    await persistCurrent();
    paintSpotButtons();
    sheets.closeSheets();
    toast("Hotspot deleted", {
      action: {
        label: "Undo",
        fn: async () => {
          if (currentScene() !== scene) { toast("Go back to that scene to undo."); return; }
          if (scene.hotspots.some((item) => item.id === spot.id)) return;
          scene.hotspots.splice(index < 0 ? scene.hotspots.length : index, 0, spot);
          await persistCurrent();
          paintSpotButtons();
          toast("Hotspot restored");
        }
      }
    });
  });

  node.append(
    title.wrap, seg, sceneWrap, headingWrap, bodyField.wrap, urlField.wrap, ctaField.wrap, pdfWrap,
    iconLabel, icons, colorLabel, swatches, sizeLabel, sizeRow, hoverRow, pulseBtn, moveBtn, save, del
  );
  sheets.openSheet("Edit Hotspot", node);
}

/* ---------- Interactive Floor Plan (Scenes + Infospots + Live FOV Radar) ---------- */
export function openFloorPlanSheet(ctx, editing) {
  const { sheets, currentCollection, currentSceneId, sceneMap, showScene, saveMeta, pickExtra, engine, toast } = ctx;
  const collection = currentCollection();
  if (!collection) return;

  let pinMode = "scene";
  const node = document.createElement("div");

  const src = collection.plan
    || (collection.hasPlan && collection.slug ? `/panorama/api/plan/${encodeURIComponent(collection.slug)}`
      : (collection.hasPlan && collection.id ? `/panorama/api/plan/${collection.id}` : ""));

  const verb = tapVerb();
  const removePins = async (keep, message) => {
    const before = (collection.pins || []).slice();
    const removedIds = new Set(before.filter((p) => !keep(p)).map((p) => p.id));
    if (!removedIds.size) return;
    collection.pins = before.filter(keep);
    await saveMeta();
    openFloorPlanSheet(ctx, true);
    toast(message, {
      action: {
        label: "Undo",
        fn: async () => {
          const nowIds = new Set((collection.pins || []).map((p) => p.id));
          const restored = before.filter((p) => removedIds.has(p.id) || nowIds.has(p.id));
          const added = (collection.pins || []).filter((p) => !before.some((b) => b.id === p.id));
          collection.pins = [...restored, ...added];
          await saveMeta();
          if (sheets.currentTitle() === "Interactive Floor Plan") openFloorPlanSheet(ctx, true);
          toast(removedIds.size === 1 ? "Pin restored" : "Pins restored");
        }
      }
    });
  };

  if (editing) {
    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = src
      ? `${verb} anywhere on the floor plan to pin the current scene or add an infospot. Shift-click a scene pin to remove it.`
      : "Upload a floor plan (.jpg, .jpeg, .png, .webp) and pin 360° scenes and infospots onto it.";
    node.appendChild(sub);

    if (src) {
      const modeSeg = document.createElement("div");
      modeSeg.className = "seg";
      [["scene", "Pin Current Scene"], ["info", "Pin Infospot"]].forEach(([m, lbl]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = lbl;
        b.setAttribute("aria-pressed", pinMode === m ? "true" : "false");
        b.addEventListener("click", () => {
          pinMode = m;
          [...modeSeg.children].forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
        });
        modeSeg.appendChild(b);
      });
      node.appendChild(modeSeg);
    }
  } else {
    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = `${verb} a numbered pin to jump to that scene, or an "i" pin for details.`;
    node.appendChild(sub);
  }

  const stage = document.createElement("div");
  stage.className = "plan-stage";
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "Interactive floor plan";
    stage.appendChild(img);

    const activeDeg = Math.round(((engine.view.yaw + engine.orient.yaw) * 180 / Math.PI) % 360);
    let sceneNum = 0;
    (collection.pins || []).forEach((pin) => {
      const btn = document.createElement("button");
      btn.type = "button";
      const isInfo = pin.kind === "info";
      if (!isInfo) sceneNum += 1;
      const isActive = !isInfo && pin.sceneId === currentSceneId;
      btn.className = "plan-pin" + (isActive ? " is-active" : "") + (isInfo ? " is-info" : "");
      btn.style.left = (pin.x * 100) + "%";
      btn.style.top = (pin.y * 100) + "%";
      const sceneObj = !isInfo ? sceneMap.get(pin.sceneId) : null;
      const tipText = isInfo ? (pin.title || "Info") : (sceneObj ? sceneObj.title : `Scene ${sceneNum}`);
      btn.textContent = isInfo ? "i" : String(sceneNum);
      btn.setAttribute("aria-label", isInfo ? `Info: ${tipText}` : `Go to ${tipText}${isActive ? " (current scene)" : ""}`);
      const tip = document.createElement("span");
      tip.setAttribute("aria-hidden", "true");
      tip.className = "plan-pin-tip";
      tip.textContent = tipText;
      btn.appendChild(tip);

      if (isActive) {
        const radar = document.createElement("span");
        radar.className = "plan-radar";
        radar.style.transform = `rotate(${-activeDeg}deg)`;
        btn.appendChild(radar);
      }

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isInfo) {
          infoBox.hidden = false;
          infoBox.innerHTML = "";
          const st = document.createElement("strong");
          st.textContent = pin.title || "Floor Plan Note";
          const p = document.createElement("p");
          p.className = "sub";
          p.textContent = pin.body || "";
          infoBox.append(st, p);
          if (editing) {
            const rm = document.createElement("button");
            rm.className = "attach-btn is-danger mt-sm";
            rm.type = "button";
            rm.textContent = "Remove Pin";
            rm.addEventListener("click", () => removePins((x) => x.id !== pin.id, "Pin removed"));
            infoBox.appendChild(rm);
          }
          return;
        }
        if (editing && e.shiftKey) {
          removePins((x) => x.id !== pin.id, "Scene pin removed");
          return;
        }
        sheets.closeSheets();
        if (pin.sceneId) showScene(pin.sceneId);
      });
      stage.appendChild(btn);
    });

    if (editing) {
      img.classList.add("is-placing");
      img.addEventListener("click", async (e) => {
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
        const y = Math.max(0.02, Math.min(0.98, (e.clientY - rect.top) / rect.height));
        collection.pins = collection.pins || [];
        if (pinMode === "info") {
          showPinForm(x, y);
          return;
        } else {
          collection.pins = collection.pins.filter((p) => p.kind === "info" || p.sceneId !== currentSceneId);
          collection.pins.push({ id: crypto.randomUUID(), kind: "scene", sceneId: currentSceneId, title: "", body: "", x, y });
        }
        await saveMeta();
        toast(pinMode === "info" ? "Floor plan infospot pinned" : "Scene pinned on floor plan");
        openFloorPlanSheet(ctx, true);
      });
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = "No floor plan uploaded yet.";
    stage.appendChild(empty);
  }
  node.appendChild(stage);

  const infoBox = document.createElement("div");
  infoBox.className = "info-box";
  infoBox.hidden = true;
  node.appendChild(infoBox);

  const pinForm = document.createElement("form");
  pinForm.className = "info-box";
  pinForm.hidden = true;
  const pinTitle = field("Infospot title", "Point of interest", { required: true, maxLength: 80 });
  const pinBody = field("Note (optional)", "", { area: true, maxLength: 600 });
  const pinActions = document.createElement("div");
  pinActions.className = "button-row";
  const pinSave = document.createElement("button");
  pinSave.className = "primary light is-compact";
  pinSave.type = "submit";
  pinSave.textContent = "Add Infospot";
  const pinCancel = document.createElement("button");
  pinCancel.className = "secondary is-compact";
  pinCancel.type = "button";
  pinCancel.textContent = "Cancel";
  pinActions.append(pinSave, pinCancel);
  pinForm.append(pinTitle.wrap, pinBody.wrap, pinActions);
  node.appendChild(pinForm);
  let pendingPin = null;
  let pendingMarker = null;

  function hidePinForm() {
    pinForm.hidden = true;
    pendingPin = null;
    if (pendingMarker) { pendingMarker.remove(); pendingMarker = null; }
  }

  function showPinForm(x, y) {
    pendingPin = { x, y };
    if (!pendingMarker) {
      pendingMarker = document.createElement("span");
      pendingMarker.className = "plan-pin is-info is-pending";
      pendingMarker.setAttribute("aria-hidden", "true");
      pendingMarker.textContent = "i";
      stage.appendChild(pendingMarker);
    }
    pendingMarker.style.left = (x * 100) + "%";
    pendingMarker.style.top = (y * 100) + "%";
    infoBox.hidden = true;
    pinForm.hidden = false;
    pinTitle.input.focus();
    pinTitle.input.select();
  }

  pinCancel.addEventListener("click", hidePinForm);
  pinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = pinTitle.input.value.trim();
    if (!title || !pendingPin) { pinTitle.input.focus(); return; }
    collection.pins = collection.pins || [];
    collection.pins.push({ id: crypto.randomUUID(), kind: "info", sceneId: "", title, body: pinBody.input.value.trim(), x: pendingPin.x, y: pendingPin.y });
    hidePinForm();
    await saveMeta();
    toast("Floor plan infospot pinned");
    openFloorPlanSheet(ctx, true);
  });

  if (editing) {
    const row = document.createElement("div");
    row.className = "button-row";
    const upload = document.createElement("button");
    upload.className = "primary light";
    upload.type = "button";
    upload.textContent = src ? "Replace Floor Plan" : "Upload Floor Plan (.jpg, .png, .webp)";
    upload.addEventListener("click", () => pickExtra("image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp", async (file) => {
      if (file.size > MAX_PLAN_BYTES) { toast("Floor plan must be under 10 MB."); return; }
      const bmp = await createImageBitmap(file);
      const c = document.createElement("canvas");
      const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      collection.plan = c.toDataURL("image/jpeg", 0.85);
      collection.planBlob = await (await fetch(collection.plan)).blob();
      collection.hasPlan = true;
      await saveMeta();
      toast("Floor plan uploaded");
      openFloorPlanSheet(ctx, true);
    }));
    row.appendChild(upload);
    if (src) {
      const clear = document.createElement("button");
      clear.className = "secondary";
      clear.type = "button";
      clear.textContent = "Clear Pins";
      clear.disabled = !(collection.pins || []).length;
      clear.addEventListener("click", () => removePins(() => false, "All pins cleared"));
      row.appendChild(clear);
    }
    node.appendChild(row);
  }

  sheets.openSheet("Interactive Floor Plan", node, { wide: true });
}

/* ---------- Share, QR Code Studio, HTML Embed & Access Controls ---------- */
export function openShareSheet(ctx) {
  const { sheets, currentCollection, currentSceneId, account, isPublic, publishTour, unpublishTour, deleteCollection, openPlansModal, saveMeta, toast } = ctx;
  const collection = currentCollection();
  if (!collection) return;

  const caps = (account && account.limits) || { plan: "guest", customQr: false, customBranding: false };
  const node = document.createElement("div");

  let activeTab = "link";
  const tabBar = document.createElement("div");
  tabBar.className = "seg";
  tabBar.setAttribute("role", "tablist");
  tabBar.setAttribute("aria-label", "Share options");
  const tabBody = document.createElement("div");
  tabBody.id = "share-panel";
  tabBody.setAttribute("role", "tabpanel");
  tabBody.tabIndex = 0;

  const selectTab = (b, focus) => {
    activeTab = b.dataset.tab;
    [...tabBar.children].forEach((c) => {
      const on = c === b;
      c.setAttribute("aria-selected", on ? "true" : "false");
      c.tabIndex = on ? 0 : -1;
    });
    tabBody.setAttribute("aria-labelledby", b.id);
    if (focus) b.focus();
    renderTab();
  };

  [["link", "Link & Access"], ["qr", "QR Code"], ["embed", "HTML Embed"]].forEach(([id, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.id = `share-tab-${id}`;
    b.dataset.tab = id;
    b.textContent = label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", "share-panel");
    b.setAttribute("aria-selected", id === activeTab ? "true" : "false");
    b.tabIndex = id === activeTab ? 0 : -1;
    b.addEventListener("click", () => selectTab(b, false));
    tabBar.appendChild(b);
  });
  tabBody.setAttribute("aria-labelledby", "share-tab-link");
  tabBar.addEventListener("keydown", (e) => {
    const tabs = [...tabBar.children];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(tabs[next], true);
  });
  node.append(tabBar, tabBody);

  let shareUrl = isPublic
    ? location.href.split("?")[0]
    : (collection.slug ? `${location.origin}/panorama/v/${collection.slug}` : "");
  let editUrl = collection.editUrl || "";
  let includeScene = false;
  let embedMode = "responsive";
  let embedClean = true;

  function effectiveUrl() {
    if (!shareUrl) return "";
    return includeScene && currentSceneId ? `${shareUrl}?scene=${encodeURIComponent(currentSceneId)}` : shareUrl;
  }

  async function ensurePublished(btn) {
    if (isPublic) return shareUrl;
    const prev = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
    try {
      const res = await publishTour(collection);
      shareUrl = res.url;
      editUrl = res.edit || collection.editUrl || "";
      return shareUrl;
    } catch (err) {
      toast(err.message || "Couldn't publish tour.");
      return "";
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prev; }
    }
  }

  function renderTab() {
    tabBody.innerHTML = "";
    const url = effectiveUrl();

    if (activeTab === "link") {
      const desc = document.createElement("p");
      desc.className = "sub";
      desc.textContent = isPublic
        ? "Opens in any desktop, phone, or VR browser — no app needed."
        : (account
          ? "Only people with the link can open it. It won't appear in search results."
          : "Quick upload: up to 15 photos, link-only (not in search results). Deleted after 90 days without a view.");
      tabBody.appendChild(desc);

      if (!isPublic) {
        const pubBtn = document.createElement("button");
        pubBtn.className = "primary light";
        pubBtn.type = "button";
        pubBtn.textContent = shareUrl ? "Sync Changes & Copy Share Link" : "Publish & Copy Share Link";
        pubBtn.addEventListener("click", async () => {
          const link = await ensurePublished(pubBtn);
          if (link) {
            await navigator.clipboard.writeText(effectiveUrl()).catch(() => {});
            toast("Share link copied");
            renderTab();
          }
        });
        tabBody.appendChild(pubBtn);
      }

      if (url) {
        const box = document.createElement("div");
        box.className = "info-box";
        box.innerHTML = `<div class="box-head">
          <strong class="box-title" id="share-url-label">Share link</strong>
          <span class="tier-chip is-dark">Link-only · Not in search</span>
        </div>`;
        const row = document.createElement("div");
        row.className = "copy-row";
        const inp = document.createElement("input");
        inp.className = "field";
        inp.readOnly = true;
        inp.value = url;
        inp.setAttribute("aria-labelledby", "share-url-label");
        const cp = document.createElement("button");
        cp.type = "button";
        cp.textContent = "Copy";
        cp.addEventListener("click", () => {
          navigator.clipboard.writeText(inp.value).then(() => toast("Link copied"));
        });
        row.append(inp, cp);
        box.appendChild(row);

        if ((collection.sceneIds || []).length > 1) {
          const chk = document.createElement("label");
          chk.className = "check-row";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = includeScene;
          cb.addEventListener("change", () => { includeScene = cb.checked; renderTab(); });
          chk.append(cb, document.createTextNode("Link directly to current scene"));
          box.appendChild(chk);
        }
        tabBody.appendChild(box);
      }

      if (!isPublic && !account && editUrl) {
        const gbox = document.createElement("div");
        gbox.className = "info-box is-warn";
        gbox.innerHTML = `<strong style="font-size:0.86rem;display:block">Private Edit Link (Save this!)</strong>
          <p class="sub" style="margin-top:0.2rem">Use this private link to modify or delete your quick upload before it expires after 90 days without a view.</p>`;
        const erow = document.createElement("div");
        erow.className = "copy-row";
        const einp = document.createElement("input");
        einp.className = "field";
        einp.readOnly = true;
        einp.value = editUrl;
        einp.setAttribute("aria-label", "Private edit link");
        const ecp = document.createElement("button");
        ecp.type = "button";
        ecp.textContent = "Copy";
        ecp.addEventListener("click", () => navigator.clipboard.writeText(editUrl).then(() => toast("Private edit link copied")));
        erow.append(einp, ecp);
        gbox.appendChild(erow);
        tabBody.appendChild(gbox);
      }

      if (!isPublic) {
        const pbox = document.createElement("div");
        pbox.className = "info-box";
        pbox.innerHTML = `<div class="box-head">
          <strong class="box-title">Password Protection</strong>
          <span class="tier-chip ${collection.locked ? "is-ok" : "is-dark"}">${collection.locked ? "Protected" : "Open Link"}</span>
        </div>`;
        const prow = document.createElement("div");
        prow.className = "copy-row";
        const pinp = document.createElement("input");
        pinp.className = "field";
        pinp.type = "password";
        pinp.autocomplete = "new-password";
        pinp.setAttribute("aria-label", collection.locked ? "New tour password (leave empty to remove)" : "Tour password");
        pinp.placeholder = collection.locked ? "New password (empty to remove)" : "Set tour password…";
        const pbtn = document.createElement("button");
        pbtn.type = "button";
        pbtn.textContent = collection.locked ? "Update" : "Lock";
        pbtn.addEventListener("click", async () => {
          if (!collection.slug) {
            const ok = await ensurePublished();
            if (!ok) return;
          }
          const token = ctx.getEditToken(collection.id);
          const ep = !account && token
            ? `/panorama/api/guest/${collection.remoteId || collection.id}/password`
            : `/panorama/api/collections/${collection.id}/password`;
          const res = await fetch(ep, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json", ...(token && !account ? { "x-pano-edit": token } : {}) },
            body: JSON.stringify({ password: pinp.value })
          });
          if (res.ok) {
            collection.locked = !!pinp.value;
            await saveMeta();
            toast(pinp.value ? "Password protection enabled" : "Password removed");
            renderTab();
          } else {
            toast("Couldn't update password.");
          }
        });
        prow.append(pinp, pbtn);
        pbox.appendChild(prow);
        tabBody.appendChild(pbox);

        if (account) {
          const ebox = document.createElement("div");
          ebox.className = "info-box";
          ebox.innerHTML = `<strong class="box-title" id="editors-label">Collaborators / Editors</strong>`;
          const erow = document.createElement("div");
          erow.className = "copy-row";
          const einp = document.createElement("input");
          einp.className = "field";
          einp.type = "email";
          einp.autocomplete = "email";
          einp.placeholder = "teammate@company.com";
          einp.setAttribute("aria-label", "Collaborator email address");
          const ebtn = document.createElement("button");
          ebtn.type = "button";
          ebtn.textContent = "Invite";
          ebtn.addEventListener("click", async () => {
            const email = einp.value.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { toast("Enter a valid email address."); return; }
            collection.editors = [...new Set([...(collection.editors || []), email])];
            await saveMeta();
            toast("Editor added — sync changes to share access");
            einp.value = "";
            renderTab();
          });
          erow.append(einp, ebtn);
          ebox.appendChild(erow);
          if ((collection.editors || []).length) {
            const p = document.createElement("p");
            p.className = "sub";
            p.textContent = "Editors: " + collection.editors.join(", ");
            ebox.appendChild(p);
          }
          tabBody.appendChild(ebox);
        }

        if (collection.slug) {
          const actions = document.createElement("div");
          actions.className = "row-links";
          if (account) {
            const stop = document.createElement("button");
            stop.type = "button";
            stop.textContent = "Unpublish Share Link";
            stop.addEventListener("click", () => {
              const confirmBox = document.createElement("div");
              confirmBox.className = "info-box is-warn";
              confirmBox.setAttribute("role", "group");
              confirmBox.setAttribute("aria-label", "Confirm unpublish");
              const msg = document.createElement("p");
              msg.className = "sub";
              msg.textContent = "Anyone with the current link, QR code, or embed will no longer be able to open this tour. You can publish again any time.";
              const btns = document.createElement("div");
              btns.className = "button-row";
              const yes = document.createElement("button");
              yes.type = "button";
              yes.className = "primary danger is-compact";
              yes.textContent = "Unpublish";
              const no = document.createElement("button");
              no.type = "button";
              no.className = "secondary is-compact";
              no.textContent = "Keep Published";
              no.addEventListener("click", () => { confirmBox.replaceWith(stop); stop.focus(); });
              yes.addEventListener("click", async () => {
                yes.disabled = true;
                try {
                  await unpublishTour(collection);
                  shareUrl = "";
                  renderTab();
                } catch (err) {
                  yes.disabled = false;
                  toast(err.message || "Couldn't unpublish tour.");
                }
              });
              btns.append(yes, no);
              confirmBox.append(msg, btns);
              stop.replaceWith(confirmBox);
              no.focus();
            });
            actions.appendChild(stop);
          } else {
            const del = document.createElement("button");
            del.type = "button";
            del.className = "is-danger";
            del.textContent = "Delete Quick Upload Immediately";
            del.addEventListener("click", () => deleteCollection(collection));
            actions.appendChild(del);
          }
          tabBody.appendChild(actions);
        }
      }
    }

    if (activeTab === "qr") {
      const b = collection.branding || {};
      const qrOpts = {
        fg: caps.customQr ? (b.qrFg || "#1c1917") : "#1c1917",
        bg: caps.customQr ? (b.qrBg || "#ffffff") : "#ffffff",
        pattern: caps.customQr ? (b.qrPattern || "square") : "square",
        logoSrc: caps.customQr && b.qrLogo && collection.logoUrl ? collection.logoUrl : ""
      };

      if (!url) {
        const p = document.createElement("p");
        p.className = "sub";
        p.textContent = "Publish your tour first to generate a downloadable PNG QR code.";
        const pub = document.createElement("button");
        pub.className = "primary light";
        pub.type = "button";
        pub.textContent = "Publish & Generate QR Code";
        pub.addEventListener("click", async () => {
          if (await ensurePublished(pub)) renderTab();
        });
        tabBody.append(p, pub);
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = "qr-preview-wrap";
      const canvas = document.createElement("canvas");
      canvas.className = "qr-canvas";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `QR code that opens ${url}`);
      const redraw = () => renderQrCanvas(canvas, url, { ...qrOpts, size: 420 });
      redraw();

      const dlBtn = document.createElement("button");
      dlBtn.className = "primary light";
      dlBtn.type = "button";
      dlBtn.textContent = "Download High-Res PNG (1024×1024)";
      dlBtn.addEventListener("click", async () => {
        await downloadQrPng(url, qrOpts, `${collection.title || "panorama"}-qr.png`);
        toast("QR code PNG downloaded");
      });
      wrap.append(canvas, dlBtn);
      tabBody.appendChild(wrap);

      const cust = document.createElement("div");
      cust.className = "info-box";
      cust.innerHTML = `<div class="box-head">
        <strong class="box-title">QR Code Customization</strong>
        <span class="tier-chip ${caps.customQr ? "is-ok" : "is-pro"}">${caps.customQr ? "Unlocked" : "Pro / Business"}</span>
      </div>`;

      const row = document.createElement("div");
      row.className = "field-row mt-sm";
      const fgWrap = document.createElement("label");
      fgWrap.className = "is-flush";
      fgWrap.textContent = "Dot Color";
      const fgInput = document.createElement("input");
      fgInput.type = "color";
      fgInput.className = "field color-field";
      fgInput.value = qrOpts.fg;
      fgInput.disabled = !caps.customQr;
      fgWrap.appendChild(fgInput);

      const bgWrap = document.createElement("label");
      bgWrap.className = "is-flush";
      bgWrap.textContent = "Background";
      const bgInput = document.createElement("input");
      bgInput.type = "color";
      bgInput.className = "field color-field";
      bgInput.value = qrOpts.bg;
      bgInput.disabled = !caps.customQr;
      bgWrap.appendChild(bgInput);
      row.append(fgWrap, bgWrap);

      const patWrap = document.createElement("div");
      patWrap.className = "sizes mt-sm";
      patWrap.setAttribute("role", "group");
      patWrap.setAttribute("aria-label", "QR dot pattern");
      [["square", "Square"], ["rounded", "Rounded"], ["dots", "Dots"], ["diamond", "Diamond"]].forEach(([pat, lbl]) => {
        const pb = document.createElement("button");
        pb.type = "button";
        pb.textContent = lbl;
        pb.disabled = !caps.customQr;
        pb.setAttribute("aria-pressed", qrOpts.pattern === pat ? "true" : "false");
        pb.addEventListener("click", () => {
          qrOpts.pattern = pat;
          collection.branding = { ...(collection.branding || {}), qrPattern: pat };
          [...patWrap.children].forEach((c) => c.setAttribute("aria-pressed", c === pb ? "true" : "false"));
          saveMeta();
          redraw();
        });
        patWrap.appendChild(pb);
      });

      fgInput.addEventListener("input", () => {
        qrOpts.fg = fgInput.value;
        collection.branding = { ...(collection.branding || {}), qrFg: fgInput.value };
        saveMeta(); redraw();
      });
      bgInput.addEventListener("input", () => {
        qrOpts.bg = bgInput.value;
        collection.branding = { ...(collection.branding || {}), qrBg: bgInput.value };
        saveMeta(); redraw();
      });

      cust.append(row, patWrap);

      if (caps.customQr) {
        const logoToggle = document.createElement("label");
        logoToggle.className = "check-row";
        const lcb = document.createElement("input");
        lcb.type = "checkbox";
        lcb.checked = !!qrOpts.logoSrc;
        lcb.disabled = !collection.logoUrl;
        lcb.addEventListener("change", () => {
          qrOpts.logoSrc = lcb.checked ? collection.logoUrl : "";
          collection.branding = { ...(collection.branding || {}), qrLogo: lcb.checked };
          saveMeta(); redraw();
        });
        logoToggle.append(lcb, document.createTextNode(collection.logoUrl ? "Embed tour brand logo in center" : "Upload a brand logo in Tour Settings to embed in QR"));
        cust.appendChild(logoToggle);
      } else if (!isPublic) {
        const up = document.createElement("button");
        up.className = "linkish";
        up.type = "button";
        up.textContent = "Upgrade to Pro for custom QR colors, dot patterns & brand logo";
        up.addEventListener("click", () => openPlansModal());
        cust.appendChild(up);
      }
      tabBody.appendChild(cust);
    }

    if (activeTab === "embed") {
      if (!url) {
        const p = document.createElement("p");
        p.className = "sub";
        p.textContent = "Publish your tour to get a copy-paste HTML embed snippet for external websites and CMS platforms.";
        const pub = document.createElement("button");
        pub.className = "primary light";
        pub.type = "button";
        pub.textContent = "Publish & Build Embed Code";
        pub.addEventListener("click", async () => {
          if (await ensurePublished(pub)) renderTab();
        });
        tabBody.append(p, pub);
        return;
      }

      const srcUrl = url + (url.includes("?") ? "&" : "?") + (embedClean ? "embed=1" : "");
      const cleanSrc = srcUrl.replace(/[?&]$/, "");
      const code = embedMode === "responsive"
        ? `<div style="position:relative;width:100%;aspect-ratio:16/9;border-radius:16px;overflow:hidden"><iframe src="${cleanSrc}" style="position:absolute;inset:0;width:100%;height:100%;border:0" allow="fullscreen; xr-spatial-tracking; gyroscope; accelerometer" allowfullscreen loading="lazy"></iframe></div>`
        : `<iframe src="${cleanSrc}" width="100%" height="540" style="border:0;border-radius:16px" allow="fullscreen; xr-spatial-tracking; gyroscope; accelerometer" allowfullscreen loading="lazy"></iframe>`;

      const modeSeg = document.createElement("div");
      modeSeg.className = "seg";
      [["responsive", "Responsive 16:9"], ["fixed", "Fixed Height (540px)"]].forEach(([m, lbl]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = lbl;
        b.setAttribute("aria-pressed", embedMode === m ? "true" : "false");
        b.addEventListener("click", () => { embedMode = m; renderTab(); });
        modeSeg.appendChild(b);
      });

      const cleanChk = document.createElement("label");
      cleanChk.className = "check-row";
      const ccb = document.createElement("input");
      ccb.type = "checkbox";
      ccb.checked = embedClean;
      ccb.addEventListener("change", () => { embedClean = ccb.checked; renderTab(); });
      cleanChk.append(ccb, document.createTextNode("Minimal controls (hides the back button)"));

      const pre = document.createElement("div");
      pre.className = "code-block";
      pre.setAttribute("role", "textbox");
      pre.setAttribute("aria-readonly", "true");
      pre.setAttribute("aria-label", "Embed code");
      pre.tabIndex = 0;
      pre.textContent = code;

      const copy = document.createElement("button");
      copy.className = "primary light";
      copy.type = "button";
      copy.textContent = "Copy HTML Embed Code";
      copy.addEventListener("click", () => {
        navigator.clipboard.writeText(code).then(() => toast("Embed HTML copied"));
      });

      const note = document.createElement("p");
      note.className = "sub";
      note.textContent = "We host the tour for you — nothing to install. Works in WordPress, Webflow, Squarespace, Wix, and custom HTML.";

      tabBody.append(modeSeg, cleanChk, pre, copy, note);
    }
  }

  renderTab();
  sheets.openSheet("Share & Export", node);
}

/* ---------- Tour Settings, Branding, Auto-Rotation, PDFs & Gallery ---------- */
export function openTourSettingsSheet(ctx, collection) {
  const { sheets, account, folders, saveMeta, pickExtra, previewLoader, openPlansModal, onTourUpdated, toast } = ctx;
  const caps = (account && account.limits) || { plan: "guest", commercial: false, customBranding: false };
  const b = {
    hideWatermark: false,
    logoUrl: "",
    loaderStyle: "spinner",
    loaderColor: "#f6f1e8",
    loaderBg: "#14110e",
    loaderText: "",
    ...(collection.branding || {})
  };
  const c = collection.contact || {};

  const node = document.createElement("div");
  const titleF = field("Tour Title", collection.title);
  const blurbF = field("Project Description", collection.blurb, { area: true, placeholder: "Describe the property, venue, or exhibition…" });
  const ctaRow = document.createElement("div");
  ctaRow.className = "field-row";
  const ctaLabelF = field("CTA Button Label", collection.linkLabel, { placeholder: "Schedule a Tour" });
  const ctaUrlF = field("CTA Button URL", collection.linkUrl, { placeholder: "https://" });
  ctaRow.append(ctaLabelF.wrap, ctaUrlF.wrap);

  const folderF = field("Folder / Group", collection.folder || "", { placeholder: "e.g. Commercial Listings" });

  const spinBox = document.createElement("div");
  spinBox.className = "info-box";
  const spinVal = document.createElement("span");
  const fmtSpin = (v) => (Math.abs(v) < 0.01 ? "Off" : `${v > 0 ? "CW" : "CCW"} · ${Math.round(Math.abs(v) * 100)}%`);
  spinVal.textContent = fmtSpin(collection.spin || 0);
  spinBox.innerHTML = `<div class="box-head"><strong class="box-title" id="spin-label">Default Auto-Rotation Speed</strong></div>`;
  spinBox.firstChild.appendChild(spinVal);
  const spinSlider = document.createElement("input");
  spinSlider.type = "range";
  spinSlider.setAttribute("aria-labelledby", "spin-label");
  spinSlider.min = "-0.45";
  spinSlider.max = "0.45";
  spinSlider.step = "0.03";
  spinSlider.value = String(collection.spin || 0);
  spinSlider.addEventListener("input", () => {
    const v = Number(spinSlider.value) || 0;
    spinVal.textContent = fmtSpin(Math.abs(v) < 0.02 ? 0 : v);
  });
  spinBox.appendChild(spinSlider);

  const contactRow1 = document.createElement("div");
  contactRow1.className = "field-row";
  const cName = field("Contact Name", c.name || "");
  const cRole = field("Company / Role", c.role || "");
  contactRow1.append(cName.wrap, cRole.wrap);
  const contactRow2 = document.createElement("div");
  contactRow2.className = "field-row";
  const cEmail = field("Contact Email", c.email || "");
  const cPhone = field("Contact Phone", c.phone || "");
  contactRow2.append(cEmail.wrap, cPhone.wrap);
  const cWeb = field("Contact Website", c.website || "", { placeholder: "https://" });

  const brandBox = document.createElement("div");
  brandBox.className = "info-box";
  brandBox.innerHTML = `<div class="box-head">
    <strong class="box-title">Commercial Usage &amp; Custom Branding</strong>
    <span class="tier-chip ${caps.customBranding ? "is-ok" : "is-pro"}">${caps.customBranding ? caps.label : "Pro / Business"}</span>
  </div>`;

  const commChk = document.createElement("label");
  commChk.className = "check-row";
  const commCb = document.createElement("input");
  commCb.type = "checkbox";
  commCb.checked = !!collection.commercial && caps.commercial;
  commCb.disabled = !caps.commercial;
  commChk.append(commCb, document.createTextNode("Enable Commercial Usage License"));

  const wmChk = document.createElement("label");
  wmChk.className = "check-row";
  const wmCb = document.createElement("input");
  wmCb.type = "checkbox";
  wmCb.checked = !!b.hideWatermark && caps.customBranding;
  wmCb.disabled = !caps.customBranding;
  wmChk.append(wmCb, document.createTextNode("Hide 'Powered by Panorama' platform branding"));

  const logoRow = document.createElement("div");
  logoRow.className = "button-row";
  const logoBtn = document.createElement("button");
  logoBtn.className = "secondary";
  logoBtn.type = "button";
  logoBtn.disabled = !caps.customBranding;
  logoBtn.textContent = collection.logoUrl ? "Replace Brand Logo" : "Upload Brand Logo";
  logoBtn.addEventListener("click", () => pickExtra("image/png,image/jpeg,image/webp", async (file) => {
    if (file.size > 4 * 1024 * 1024) { toast("Logo must be under 4 MB."); return; }
    collection.logoBlob = file;
    collection.logoUrl = URL.createObjectURL(file);
    await saveMeta();
    onTourUpdated();
    toast("Custom logo uploaded");
    openTourSettingsSheet(ctx, collection);
  }));
  logoRow.appendChild(logoBtn);

  const logoLinkF = field("Logo Click URL", b.logoUrl || "", { placeholder: "https://yourbrand.com", disabled: !caps.customBranding });

  const loaderLabel = document.createElement("label");
  loaderLabel.textContent = "Custom Loading Animation";
  const loaderSeg = document.createElement("div");
  loaderSeg.className = "seg";
  let loaderStyle = b.loaderStyle || "spinner";
  [["spinner", "Spinner"], ["pulse", "Pulse"], ["bar", "Progress Bar"], ["fade", "Brand Fade"]].forEach(([st, lbl]) => {
    const sb = document.createElement("button");
    sb.type = "button";
    sb.textContent = lbl;
    sb.disabled = !caps.customBranding;
    sb.setAttribute("aria-pressed", loaderStyle === st ? "true" : "false");
    sb.addEventListener("click", () => {
      loaderStyle = st;
      [...loaderSeg.children].forEach((ch) => ch.setAttribute("aria-pressed", ch === sb ? "true" : "false"));
    });
    loaderSeg.appendChild(sb);
  });

  const loaderColors = document.createElement("div");
  loaderColors.className = "field-row";
  const lBg = field("Loader Background", b.loaderBg, { type: "color", disabled: !caps.customBranding });
  const lFg = field("Loader Accent", b.loaderColor, { type: "color", disabled: !caps.customBranding });
  lBg.input.classList.add("color-field"); lFg.input.classList.add("color-field");
  loaderColors.append(lBg.wrap, lFg.wrap);
  const lText = field("Loader Caption", b.loaderText || "", { placeholder: "Loading virtual tour…", disabled: !caps.customBranding });

  const prevLoadBtn = document.createElement("button");
  prevLoadBtn.className = "linkish";
  prevLoadBtn.type = "button";
  prevLoadBtn.textContent = "Preview Loading Animation";
  prevLoadBtn.addEventListener("click", () => {
    previewLoader({
      loaderStyle,
      loaderBg: lBg.input.value,
      loaderColor: lFg.input.value,
      loaderText: lText.input.value.trim() || `Loading ${collection.title}…`,
      logoUrl: collection.logoUrl
    });
  });

  brandBox.append(commChk, wmChk, logoRow, logoLinkF.wrap, loaderLabel, loaderSeg, loaderColors, lText.wrap, prevLoadBtn);
  if (!caps.customBranding) {
    const up = document.createElement("button");
    up.className = "linkish";
    up.type = "button";
    up.textContent = "Upgrade to Pro or Business to unlock custom branding & commercial use";
    up.addEventListener("click", () => openPlansModal());
    brandBox.appendChild(up);
  }

  const pdfBox = document.createElement("div");
  pdfBox.className = "info-box";
  pdfBox.innerHTML = `<strong class="box-title">Downloadable PDF Attachments (up to 5)</strong>`;
  const pdfList = document.createElement("div");
  pdfList.className = "attach-list";
  const settingsTitle = "Tour Settings & Branding";
  (collection.attachments || []).forEach((att) => {
    const row = document.createElement("div");
    row.className = "attach-item";
    const meta = document.createElement("div");
    meta.className = "attach-item-meta";
    meta.innerHTML = `<strong></strong><span>${att.bytes ? formatBytes(att.bytes) : "PDF"}</span>`;
    meta.querySelector("strong").textContent = att.name;
    const rm = document.createElement("button");
    rm.className = "attach-btn is-danger";
    rm.type = "button";
    rm.textContent = "Remove";
    rm.setAttribute("aria-label", `Remove ${att.name}`);
    rm.addEventListener("click", async () => {
      const list = collection.attachments || [];
      const index = list.findIndex((x) => x.id === att.id);
      collection.attachments = list.filter((x) => x.id !== att.id);
      await saveMeta();
      onTourUpdated();
      openTourSettingsSheet(ctx, collection);
      toast(`Removed ${att.name}`, {
        action: {
          label: "Undo",
          fn: async () => {
            collection.attachments = collection.attachments || [];
            if (collection.attachments.some((x) => x.id === att.id)) return;
            collection.attachments.splice(index < 0 ? collection.attachments.length : index, 0, att);
            await saveMeta();
            onTourUpdated();
            if (sheets.currentTitle() === settingsTitle) openTourSettingsSheet(ctx, collection);
            toast(`Restored ${att.name}`);
          }
        }
      });
    });
    row.append(meta, rm);
    pdfList.appendChild(row);
  });
  const addPdfBtn = document.createElement("button");
  addPdfBtn.className = "secondary mt-sm";
  addPdfBtn.type = "button";
  addPdfBtn.textContent = "+ Attach PDF (Brochure, Specs, Pricing)";
  addPdfBtn.addEventListener("click", () => pickExtra("application/pdf,.pdf", async (file) => {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) { toast("Please select a PDF file."); return; }
    if (file.size > MAX_PDF_BYTES) { toast("PDF must be 15 MB or smaller."); return; }
    collection.attachments = collection.attachments || [];
    if (collection.attachments.length >= 5) { toast("Maximum 5 PDF attachments per tour."); return; }
    collection.attachments.push({ id: crypto.randomUUID(), name: file.name, bytes: file.size, blob: file, blobUrl: URL.createObjectURL(file) });
    await saveMeta();
    onTourUpdated();
    toast(`Attached ${file.name}`);
    openTourSettingsSheet(ctx, collection);
  }));
  pdfBox.append(pdfList, addPdfBtn);

  const galBox = document.createElement("div");
  galBox.className = "info-box";
  galBox.innerHTML = `<strong class="box-title">Showcase Photo Gallery (${(collection.gallery || []).length} / 8)</strong>`;
  const addGalBtn = document.createElement("button");
  addGalBtn.className = "secondary mt-sm";
  addGalBtn.type = "button";
  addGalBtn.textContent = "+ Add Gallery Photo";
  addGalBtn.addEventListener("click", () => pickExtra("image/jpeg,image/png,image/webp", async (file) => {
    if (file.size > 4 * 1024 * 1024) { toast("Gallery photo must be under 4 MB."); return; }
    collection.gallery = collection.gallery || [];
    if (collection.gallery.length >= 8) { toast("Maximum 8 gallery photos."); return; }
    collection.gallery.push({ id: crypto.randomUUID(), name: file.name, blob: file, url: URL.createObjectURL(file) });
    await saveMeta();
    toast("Gallery photo added");
    openTourSettingsSheet(ctx, collection);
  }));
  galBox.appendChild(addGalBtn);

  const save = document.createElement("button");
  save.className = "primary light";
  save.type = "button";
  save.textContent = "Save Tour Settings";
  save.addEventListener("click", async () => {
    collection.title = titleF.input.value.trim() || "Untitled Tour";
    collection.blurb = blurbF.input.value.trim();
    collection.linkLabel = ctaLabelF.input.value.trim();
    collection.linkUrl = safeUrl(ctaUrlF.input.value.trim());
    collection.folder = folderF.input.value.trim();
    const spinRaw = Number(spinSlider.value) || 0;
    collection.spin = Math.abs(spinRaw) < 0.02 ? 0 : spinRaw;
    collection.commercial = caps.commercial && commCb.checked;
    collection.contact = {
      name: cName.input.value.trim(),
      role: cRole.input.value.trim(),
      email: cEmail.input.value.trim(),
      phone: cPhone.input.value.trim(),
      website: safeUrl(cWeb.input.value.trim())
    };
    collection.branding = {
      ...(collection.branding || {}),
      hideWatermark: caps.customBranding && wmCb.checked,
      logoUrl: safeUrl(logoLinkF.input.value.trim()),
      loaderStyle,
      loaderBg: lBg.input.value,
      loaderColor: lFg.input.value,
      loaderText: lText.input.value.trim()
    };
    if (collection.folder) {
      let found = folders.find((f) => f.title === collection.folder);
      if (!found) {
        found = { id: crypto.randomUUID(), title: collection.folder };
        folders.unshift(found);
      }
      collection.folderId = found.id;
    } else {
      collection.folderId = "";
    }
    await saveMeta();
    onTourUpdated();
    sheets.closeSheets();
    toast("Tour settings saved");
  });

  node.append(titleF.wrap, blurbF.wrap, ctaRow, folderF.wrap, spinBox, contactRow1, contactRow2, cWeb.wrap, brandBox, pdfBox, galBox, save);
  sheets.openSheet("Tour Settings & Branding", node, { wide: true });
}

/* ---------- Tour & Engagement Analytics Modal ---------- */
export async function openAnalyticsSheet(ctx, collection) {
  const { sheets, api, account, sceneMap } = ctx;
  const node = document.createElement("div");

  if (!account) {
    node.innerHTML = `<p class="sub">Sign in and publish your tour to track interaction time, hotspot clicks, favorite scenes, and visitor locations.</p>`;
    sheets.openSheet("Engagement Analytics", node);
    return;
  }
  if (!collection.slug) {
    node.innerHTML = `<p class="sub">Publish this tour to start tracking views, interaction time, hotspot clicks, popular scenes, and visitor locations.</p>`;
    sheets.openSheet("Engagement Analytics", node);
    return;
  }

  node.innerHTML = `<p class="sub">Loading engagement metrics…</p>`;
  sheets.openSheet(`Analytics · ${collection.title}`, node, { wide: true });

  try {
    const data = await api(`/panorama/api/collections/${collection.id}/activity`, {});
    node.innerHTML = "";

    const kpi = document.createElement("div");
    kpi.className = "kpi-grid";
    [
      ["Total Views", String(data.views || 0)],
      ["Avg. Interaction", formatDuration(data.avgDwell || 0)],
      ["Total Time", formatDuration(data.dwell || 0)],
      ["Hotspot Clicks", String(data.totalClicks || 0)]
    ].forEach(([lbl, val]) => {
      const c = document.createElement("div");
      c.className = "kpi-card";
      c.innerHTML = `<span>${lbl}</span><strong>${val}</strong>`;
      kpi.appendChild(c);
    });
    node.appendChild(kpi);

    const sceneSec = document.createElement("div");
    sceneSec.className = "stat-section";
    sceneSec.innerHTML = `<h3>Popular &amp; Favorite Scenes</h3>`;
    const scenes = data.scenes || [];
    const maxScore = Math.max(1, ...scenes.map((s) => (s.views || 0) + (s.clicks || 0)));
    const sList = document.createElement("div");
    sList.className = "bar-list";
    if (!scenes.length) {
      sList.innerHTML = `<p class="sub">No scene data yet.</p>`;
    } else {
      scenes.forEach((s, idx) => {
        const score = (s.views || 0) + (s.clicks || 0);
        const row = document.createElement("div");
        const top = document.createElement("div");
        top.className = "bar-row-top";
        const left = document.createElement("span");
        left.className = "bar-label";
        if (idx === 0 && score > 0) {
          left.insertAdjacentHTML("afterbegin", ICONS.star);
          left.title = "Most popular scene";
        }
        left.append(s.title || (sceneMap.get(s.id)?.title) || "Scene");
        const right = document.createElement("span");
        right.textContent = `${s.views || 0} views · ${formatDuration(s.dwell || 0)} · ${s.clicks || 0} clicks`;
        top.append(left, right);
        const track = document.createElement("div");
        track.className = "bar-track";
        const fill = document.createElement("div");
        fill.className = "bar-fill";
        fill.style.width = `${Math.max(4, Math.round((score / maxScore) * 100))}%`;
        track.appendChild(fill);
        row.append(top, track);
        sList.appendChild(row);
      });
    }
    sceneSec.appendChild(sList);
    node.appendChild(sceneSec);

    if (data.topHotspots && data.topHotspots.length) {
      const hSec = document.createElement("div");
      hSec.className = "stat-section";
      hSec.innerHTML = `<h3>Top Hotspot Interactions</h3>`;
      const hList = document.createElement("div");
      hList.className = "bar-list";
      const maxC = Math.max(1, ...data.topHotspots.map((h) => h.clicks));
      data.topHotspots.forEach((h) => {
        const row = document.createElement("div");
        const top = document.createElement("div");
        top.className = "bar-row-top";
        const l = document.createElement("span"); l.textContent = `${h.title} (${h.sceneTitle})`;
        const r = document.createElement("span"); r.textContent = `${h.clicks} clicks`;
        top.append(l, r);
        const track = document.createElement("div"); track.className = "bar-track";
        const fill = document.createElement("div"); fill.className = "bar-fill"; fill.style.width = `${Math.max(6, Math.round((h.clicks / maxC) * 100))}%`;
        track.appendChild(fill);
        row.append(top, track);
        hList.appendChild(row);
      });
      hSec.appendChild(hList);
      node.appendChild(hSec);
    }

    const locSec = document.createElement("div");
    locSec.className = "stat-section";
    locSec.innerHTML = `<h3>Visitor Locations</h3>`;
    const regionNames = typeof Intl !== "undefined" && Intl.DisplayNames
      ? new Intl.DisplayNames(["en"], { type: "region" })
      : null;
    const locs = data.locations || [];
    if (!locs.length) {
      locSec.innerHTML += `<p class="sub">Visitor locations will appear after your tour receives visits.</p>`;
    } else {
      const totalLoc = Math.max(1, locs.reduce((sum, x) => sum + x.count, 0));
      const lList = document.createElement("div");
      lList.className = "bar-list";
      locs.slice(0, 10).forEach((loc) => {
        let name = loc.code;
        try { if (regionNames) name = regionNames.of(loc.code) || loc.code; } catch (e) { /* keep code */ }
        const pct = Math.round((loc.count / totalLoc) * 100);
        const row = document.createElement("div");
        const top = document.createElement("div");
        top.className = "bar-row-top";
        const l = document.createElement("span"); l.textContent = name;
        const r = document.createElement("span"); r.textContent = `${loc.count} (${pct}%)`;
        top.append(l, r);
        const track = document.createElement("div"); track.className = "bar-track";
        const fill = document.createElement("div"); fill.className = "bar-fill"; fill.style.width = `${Math.max(4, pct)}%`;
        track.appendChild(fill);
        row.append(top, track);
        lList.appendChild(row);
      });
      locSec.appendChild(lList);
    }
    node.appendChild(locSec);
  } catch (err) {
    node.innerHTML = "";
    const p = document.createElement("p");
    p.className = "sub error-text";
    p.setAttribute("role", "alert");
    p.textContent = err.message || "Couldn't load analytics.";
    node.appendChild(p);
  }
}

/* ---------- Plans & Quotas Comparison Modal ---------- */
export function openPlansSheet(ctx) {
  const { sheets, account, api, refreshMe, openSignIn, toast } = ctx;
  const currentPlan = account ? account.plan : "guest";
  const node = document.createElement("div");
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = "Every plan includes 360° photos up to 25 MB each (JPG, PNG or WebP, 2:1 ratio), VR viewing, hotspots, floor plans, and view counts.";
  node.appendChild(sub);

  const grid = document.createElement("div");
  grid.className = "tier-grid";

  const confirmBox = document.createElement("div");
  confirmBox.className = "info-box";
  confirmBox.hidden = true;

  const showConfirm = (p, trigger) => {
    confirmBox.innerHTML = "";
    confirmBox.hidden = false;
    const head = document.createElement("strong");
    head.className = "box-title";
    head.id = "plan-confirm-title";
    head.textContent = `Switch to ${p.name} (${p.price})?`;
    confirmBox.setAttribute("role", "group");
    confirmBox.setAttribute("aria-labelledby", head.id);
    const list = document.createElement("ul");
    list.className = "change-list";
    planChanges(currentPlan, p.id).forEach(([kind, text]) => {
      const li = document.createElement("li");
      li.className = kind === "lose" ? "is-lose" : "is-gain";
      li.textContent = text;
      list.appendChild(li);
    });
    const target = PLAN_CAPS[p.id];
    const warn = document.createElement("p");
    warn.className = "sub error-text";
    warn.hidden = !(account && (account.published || 0) > target.published);
    warn.textContent = `You have ${account.published || 0} published tours; ${p.name} allows ${target.published}. Unpublish some before switching.`;
    const err = document.createElement("p");
    err.className = "sub error-text";
    err.setAttribute("role", "alert");
    err.hidden = true;
    const btns = document.createElement("div");
    btns.className = "button-row";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "primary light is-compact";
    yes.textContent = `Confirm ${p.name}`;
    const no = document.createElement("button");
    no.type = "button";
    no.className = "secondary is-compact";
    no.textContent = "Cancel";
    no.addEventListener("click", () => { confirmBox.hidden = true; if (trigger) trigger.focus(); });
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      err.hidden = true;
      yes.textContent = "Updating…";
      try {
        const res = await api("/panorama/api/account/plan", { method: "POST", json: { plan: p.id } });
        if (res && res.checkoutUrl) { location.href = res.checkoutUrl; return; }
        await refreshMe();
        toast(`Plan updated to ${p.name}`);
        sheets.closeSheets();
      } catch (e) {
        err.textContent = e.message || "Couldn't update plan.";
        err.hidden = false;
        yes.disabled = false;
        yes.textContent = `Confirm ${p.name}`;
      }
    });
    btns.append(yes, no);
    confirmBox.append(head, list, warn, err, btns);
    no.focus();
  };

  PLAN_LIST.forEach((p) => {
    const isCurrent = currentPlan === p.id;
    const card = document.createElement("div");
    card.className = "tier-card" + (isCurrent ? " is-current" : "");
    const h3 = document.createElement("h3");
    const nameEl = document.createElement("span");
    nameEl.textContent = p.name;
    h3.appendChild(nameEl);
    if (isCurrent) h3.insertAdjacentHTML("beforeend", '<span class="tier-chip is-pro">Current</span>');
    const price = document.createElement("div");
    price.className = "tier-price";
    price.textContent = p.price;
    const ul = document.createElement("ul");
    ul.className = "tier-list";
    planItems(p.id).forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      ul.appendChild(li);
    });
    card.append(h3, price, ul);

    if (p.id === "guest") {
      if (!isCurrent) {
        const note = document.createElement("p");
        note.className = "tier-note";
        note.textContent = "For quick, one-off shares";
        card.appendChild(note);
      }
      grid.appendChild(card);
      return;
    }

    const btn = document.createElement("button");
    btn.className = (isCurrent ? "secondary" : "primary light") + " is-compact";
    btn.type = "button";
    btn.disabled = isCurrent;
    btn.textContent = isCurrent ? "Current Plan" : (account ? `Switch to ${p.name}` : `Sign In for ${p.name}`);
    btn.addEventListener("click", () => {
      if (!account) { openSignIn(`Sign in to activate the ${p.name} plan.`); return; }
      showConfirm(p, btn);
    });
    card.appendChild(btn);
    grid.appendChild(card);
  });
  node.append(grid, confirmBox);
  sheets.openSheet("Plans & Quotas", node, { wide: true });
}

const GB = 1024 * 1024 * 1024;
const PLAN_CAPS = {
  guest: { scenes: 15, published: 3, monthly: 5 * GB, commercial: false, customBranding: false, customQr: false, aiUpscale: false, sceneSwap: false },
  free: { scenes: 30, published: 10, monthly: 10 * GB, commercial: false, customBranding: false, customQr: false, aiUpscale: true, sceneSwap: true },
  pro: { scenes: 100, published: 100, monthly: 100 * GB, commercial: true, customBranding: true, customQr: true, aiUpscale: true, sceneSwap: true },
  business: { scenes: 250, published: 500, monthly: 500 * GB, commercial: true, customBranding: true, customQr: true, aiUpscale: true, sceneSwap: true }
};

const PLAN_LIST = [
  { id: "guest", name: "No account", price: "$0" },
  { id: "free", name: "Free", price: "$0/mo" },
  { id: "pro", name: "Pro", price: "$19/mo" },
  { id: "business", name: "Business", price: "$49/mo" }
];

const PLAN_FEATURES = [
  ["aiUpscale", "AI 2× upscaling"],
  ["sceneSwap", "Replace a scene photo, keep its hotspots"],
  ["commercial", "Commercial use license"],
  ["customBranding", "Your logo & loading screen, no Panorama badge"],
  ["customQr", "Custom QR colors, patterns & logo"]
];

function planItems(id) {
  const c = PLAN_CAPS[id];
  if (id === "guest") {
    return [`Up to ${c.scenes} photos per tour`, `${c.published} shared links`, "Unlisted links (not in search)", "Private edit link", "Deleted after 90 days without a view"];
  }
  const items = [`Up to ${c.scenes} scenes per tour`, `${c.published} published tours`, `${c.monthly / GB} GB viewing per month`];
  PLAN_FEATURES.forEach(([key, label]) => { if (c[key]) items.push(label); });
  if (!c.customBranding) items.push("Standard QR codes & embeds");
  return items;
}

function planChanges(fromId, toId) {
  const a = PLAN_CAPS[fromId] || PLAN_CAPS.free;
  const b = PLAN_CAPS[toId];
  const out = [];
  const num = (key, label, fmt = (v) => v) => {
    if (b[key] !== a[key]) out.push([b[key] > a[key] ? "gain" : "lose", `${label}: ${fmt(a[key])} → ${fmt(b[key])}`]);
  };
  num("scenes", "Scenes per tour");
  num("published", "Published tours");
  num("monthly", "Monthly viewing", (v) => `${v / GB} GB`);
  PLAN_FEATURES.forEach(([key, label]) => {
    if (b[key] && !a[key]) out.push(["gain", `Adds: ${label}`]);
    if (a[key] && !b[key]) out.push(["lose", `Removes: ${label}`]);
  });
  return out;
}
