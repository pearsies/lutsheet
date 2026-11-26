(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
let uidN = 0;

/* ------------------------------------------------------------------ settings model */
const CONTROLS = [
  { k: 'intensity',   l: 'Intensity',   min: 0,    max: 100, step: 1,    def: 100, u: '%', g: 'look' },
  { k: 'exposure',    l: 'Exposure',    min: -3,   max: 3,   step: 0.05, def: 0,   u: ' ev', g: 'look' },
  { k: 'contrast',    l: 'Contrast',    min: -100, max: 100, step: 1,    def: 0,   g: 'look' },
  { k: 'saturation',  l: 'Saturation',  min: -100, max: 100, step: 1,    def: 0,   g: 'look' },
  { k: 'temperature', l: 'Temperature', min: -100, max: 100, step: 1,    def: 0,   g: 'colour' },
  { k: 'tint',        l: 'Tint',        min: -100, max: 100, step: 1,    def: 0,   g: 'colour' },
  { k: 'hue',         l: 'Hue shift',   min: -180, max: 180, step: 1,    def: 0,   u: '°', g: 'colour' },
  { k: 'fade',        l: 'Fade',        min: 0,    max: 100, step: 1,    def: 0,   g: 'colour' },
  { k: 'shadows',     l: 'Shadows',     min: -100, max: 100, step: 1,    def: 0,   g: 'tone' },
  { k: 'highlights',  l: 'Highlights',  min: -100, max: 100, step: 1,    def: 0,   g: 'tone' },
  { k: 'gamma',       l: 'Gamma',       min: -100, max: 100, step: 1,    def: 0,   g: 'tone' },
];
const defaults = () => { const o = { order: 'post' }; CONTROLS.forEach(c => o[c.k] = c.def); return o; };

/* ------------------------------------------------------------------ state */
const state = {
  src: null,               // {name,kind,w,h,canvas,video?,bitmap?}
  luts: [],
  master: defaults(),
  view: { tile: 300, aspect: 'source', labels: true, original: true },
  exp: { w: 720, cols: 0, fmt: 'png', labels: true, original: true, starred: false },
  filter: '', sort: 'name', showHidden: false,
  current: null,           // inspector lut id
};
const renderer = (() => { try { return new Renderer(); } catch (e) { alert('lutsheet needs WebGL2.\n' + e.message); throw e; } })();

/* ------------------------------------------------------------------ small UI factories */
const fmtVal = (c, v) => (c.min < 0 && v > 0 ? '+' : '') + (c.step < 1 ? v.toFixed(2) : Math.round(v)) + (c.u || '');

function makeSlider(c, get, set) {
  const w = document.createElement('label');
  w.className = 'sl';
  w.innerHTML = `<span class="n" title="double-click to reset">${c.l}</span><span class="v"></span><input type="range" min="${c.min}" max="${c.max}" step="${c.step}">`;
  const inp = w.querySelector('input'), v = w.querySelector('.v');
  w.sync = () => { const x = get(); inp.value = x; v.textContent = fmtVal(c, +x); inp.style.setProperty('--p', ((x - c.min) / (c.max - c.min) * 100) + '%'); };
  inp.addEventListener('input', () => { set(parseFloat(inp.value)); w.sync(); });
  w.querySelector('.n').addEventListener('dblclick', () => { set(c.def); w.sync(); });
  w.sync();
  return w;
}
function makeSeg(host, opts, get, set) {
  host.classList.add('seg');
  const bs = opts.map(([val, label]) => {
    const b = document.createElement('button'); b.textContent = label; b.type = 'button';
    b.onclick = () => { set(val); sync(); };
    host.appendChild(b); return [val, b];
  });
  const sync = () => bs.forEach(([val, b]) => b.classList.toggle('on', String(val) === String(get())));
  sync(); host.sync = sync; return host;
}
function makeToggle(host, label, get, set) {
  const l = document.createElement('label'); l.className = 'tog';
  l.innerHTML = `<input type="checkbox"><i></i><span>${label}</span>`;
  const i = l.querySelector('input'); i.checked = get();
  i.onchange = () => set(i.checked);
  host.appendChild(l); return l;
}
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms); }
const tick = () => new Promise(r => setTimeout(r, 0));
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const canvasBlob = (cv, type, q) => new Promise(r => cv.toBlob(r, type, q));

/* ------------------------------------------------------------------ effective params */
function effective(lut) {
  const s = lut.settings, m = state.master;
  return {
    intensity: clamp(s.intensity / 100 * m.intensity / 100, 0, 1),
    exposure: s.exposure + m.exposure,
    contrast: (s.contrast + m.contrast) / 100,
    saturation: (s.saturation + m.saturation) / 100,
    temperature: (s.temperature + m.temperature) / 100,
    tint: (s.tint + m.tint) / 100,
    hue: s.hue + m.hue,
    fade: clamp((s.fade + m.fade) / 100, 0, 1),
    shadows: (s.shadows + m.shadows) / 100,
    highlights: (s.highlights + m.highlights) / 100,
    gamma: (s.gamma + m.gamma) / 100,
    post: s.order === 'post',
  };
}
const NEUTRAL = { intensity: 1, exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, hue: 0, fade: 0, shadows: 0, highlights: 0, gamma: 0, post: true };

function tileAspect() {
  if (state.view.aspect === 'source') return state.src ? state.src.w / state.src.h : 16 / 9;
  return parseFloat(state.view.aspect);
}

/* ------------------------------------------------------------------ source loading */
const PREVIEW_MAX = 2048;
function scaledCanvas(drawable, w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
  const ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable, 0, 0, cv.width, cv.height);
  return cv;
}
function applySource(src) {
  state.src = src;
  renderer.setSource(src.canvas, src.canvas.width, src.canvas.height);
  $('#srcStatus').innerHTML = `<b>${escapeHtml(src.name)}</b> · ${src.w}×${src.h}${src.kind === 'video' ? ' · video' : ''}`;
  $('#vidCtl').hidden = src.kind !== 'video';
  updateAspectVar();
  refresh();
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadSource(file) {
  try {
    if (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) return await loadVideo(file);
    const bmp = await createImageBitmap(file);
    applySource({ name: file.name, kind: 'image', w: bmp.width, h: bmp.height, canvas: scaledCanvas(bmp, bmp.width, bmp.height, PREVIEW_MAX), bitmap: bmp });
  } catch (e) { console.error(e); toast('Could not read that image/video'); }
}
let vidSlider;
function loadVideo(file) {
  return new Promise((resolve) => {
    if (state.src && state.src.video) URL.revokeObjectURL(state.src.video.src);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
    v.onerror = () => { toast('This browser cannot decode that video'); resolve(); };
    v.onloadeddata = () => {
      const src = { name: file.name, kind: 'video', w: v.videoWidth, h: v.videoHeight, video: v, canvas: scaledCanvas(v, v.videoWidth, v.videoHeight, PREVIEW_MAX) };
      vidSlider.set(Math.min(v.duration * 0.2, 2), v.duration);
      v.currentTime = Math.min(v.duration * 0.2, 2);
      applySource(src);
      resolve();
    };
    v.onseeked = () => {
      if (!state.src || state.src.video !== v) return;
      state.src.canvas = scaledCanvas(v, v.videoWidth, v.videoHeight, PREVIEW_MAX);
      renderer.setSource(state.src.canvas, state.src.canvas.width, state.src.canvas.height);
      $('#vidTime').textContent = timecode(v.currentTime);
      markAllDirty(); renderInspector();
    };
  });
}
const timecode = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

function sampleCanvas() {
  const W = 1600, H = 900, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  let g = c.createLinearGradient(0, 0, 0, H * 0.62);
  g.addColorStop(0, '#2d5bb8'); g.addColorStop(0.55, '#8fb7e6'); g.addColorStop(1, '#f6d7a8');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(1150, 420, 10, 1150, 420, 260);
  g.addColorStop(0, '#fff6d8'); g.addColorStop(0.25, 'rgba(255,214,140,.9)'); g.addColorStop(1, 'rgba(255,190,110,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const hill = (col, base, amp, f, ph) => { c.fillStyle = col; c.beginPath(); c.moveTo(0, H); for (let x = 0; x <= W; x += 10) c.lineTo(x, base + Math.sin(x * f + ph) * amp + Math.sin(x * f * 2.3 + ph) * amp * 0.35); c.lineTo(W, H); c.fill(); };
  hill('#7aa36a', 520, 40, 0.004, 1); hill('#3f7a4a', 600, 46, 0.006, 3); hill('#24523a', 690, 38, 0.009, 5);
  c.fillStyle = '#b5513a'; c.fillRect(250, 540, 130, 90);
  c.fillStyle = '#6b2f27'; c.beginPath(); c.moveTo(235, 545); c.lineTo(315, 480); c.lineTo(395, 545); c.fill();
  const skin = ['#f2c9a8', '#d99a73', '#a86a4a', '#6d4128'];
  skin.forEach((col, i) => { c.fillStyle = col; c.beginPath(); c.arc(760 + i * 120, 640, 46, 0, 7); c.fill(); });
  const patches = ['#e32b2b', '#f08a1c', '#f5d21b', '#3aa84a', '#1ea7b5', '#2a58c9', '#7a3fb8', '#d6389a', '#ffffff', '#bdbdbd', '#7a7a7a', '#2a2a2a'];
  const pw = W / patches.length;
  patches.forEach((col, i) => { c.fillStyle = col; c.fillRect(i * pw, H - 120, pw, 120); });
  for (let i = 0; i < 16; i++) { const v = Math.round(i / 15 * 255); c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(i * (W / 16), H - 160, W / 16, 40); }
  return cv;
}

/* ------------------------------------------------------------------ LUT loading */
async function addParsedLuts(items) {
  for (const it of items) {
    state.luts.push({
      id: 'l' + (++uidN), name: it.name, path: it.path || it.name, size: it.size, data: it.data, dmin: it.dmin, dmax: it.dmax,
      kind: it.kind, settings: defaults(), starred: false, hidden: false, order: state.luts.length,
    });
  }
  refresh();
}
async function handleFiles(files) {
  files = [...files];
  const cubes = files.filter(f => /\.cube$/i.test(f.name));
  const media = files.find(f => f.type.startsWith('image/') || f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|png|jpe?g|webp|tiff?|gif|avif)$/i.test(f.name));
  if (media) await loadSource(media);
  if (cubes.length) {
    const parsed = []; let bad = 0;
    for (let i = 0; i < cubes.length; i++) {
      if (i % 4 === 0) { toast(`Reading LUTs… ${i}/${cubes.length}`, 1500); await tick(); }
      try {
        const r = Cube.parse(await cubes[i].text());
        parsed.push({ ...r, name: cubes[i].name.replace(/\.cube$/i, ''), path: cubes[i].webkitRelativePath || cubes[i].name });
      } catch (e) { bad++; console.warn(cubes[i].name, e); }
    }
    parsed.sort((a, b) => natural.compare(a.name, b.name));
    await addParsedLuts(parsed);
    toast(`${parsed.length} LUT${parsed.length === 1 ? '' : 's'} loaded${bad ? ` · ${bad} skipped` : ''}`);
  } else if (!media) toast('Nothing usable in that drop (looking for images, video or .cube)');
}
async function readEntry(entry, out) {
  if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
  else if (entry.isDirectory) {
    const rd = entry.createReader(); let batch;
    do { batch = await new Promise((res, rej) => rd.readEntries(res, rej)); for (const e of batch) await readEntry(e, out); } while (batch.length);
  }
}
async function onDrop(e) {
  e.preventDefault(); $('#veil').classList.remove('on'); dragDepth = 0;
  const entries = [...(e.dataTransfer.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.length) { const out = []; for (const en of entries) await readEntry(en, out); handleFiles(out); }
  else handleFiles(e.dataTransfer.files);
}
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#veil').classList.add('on'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#veil').classList.remove('on'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', onDrop);

/* ------------------------------------------------------------------ grid */
const grid = $('#grid');
const tiles = new Map();   // id -> tile obj
const io = new IntersectionObserver((es) => {
  es.forEach(e => { const t = e.target._tile; if (t) { t.visible = e.isIntersecting; if (t.visible && t.dirty) schedule(); } });
}, { root: $('#stage'), rootMargin: '400px' });

function visibleLuts() {
  const q = state.filter.trim().toLowerCase();
  let l = state.luts.filter(x => (state.showHidden || !x.hidden) && (!q || x.name.toLowerCase().includes(q)));
  if (state.sort === 'name') l.sort((a, b) => natural.compare(a.name, b.name));
  else if (state.sort === 'starred') l.sort((a, b) => (b.starred - a.starred) || natural.compare(a.name, b.name));
  else l.sort((a, b) => a.order - b.order);
  return l;
}
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.9 6.4 20l1.3-6.2L3 9.5l6.3-.7z" stroke-linejoin="round"/></svg>';
const EYE = '<svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg>';

function buildTile(lut) {
  const f = document.createElement('figure');
  f.className = 'tile' + (lut ? '' : ' orig'); f.tabIndex = 0;
  f.innerHTML = `<div class="ph"><canvas></canvas>${lut ? `<div class="acts"><button data-a="star" title="Star">${STAR}</button><button data-a="hide" title="Hide">${EYE}</button></div>` : ''}</div>
    <figcaption><span class="nm"></span><span class="mt"></span></figcaption>`;
  const t = { el: f, canvas: f.querySelector('canvas'), lut, dirty: true, visible: false };
  f._tile = t;
  const nm = f.querySelector('.nm');
  nm.textContent = lut ? lut.name : 'Original';
  nm.title = lut ? lut.path : '';
  f.querySelector('.mt').textContent = lut ? `${lut.size}³${lut.kind === '1D' ? ' · 1D' : ''}` : 'untouched';
  if (lut) {
    nm.classList.toggle('star', lut.starred);
    const sb = f.querySelector('[data-a=star]'); sb.classList.toggle('on', lut.starred);
    f.addEventListener('click', (e) => {
      const a = e.target.closest('button');
      if (a && a.dataset.a === 'star') { lut.starred = !lut.starred; if (state.sort === 'starred') buildGrid(); else { nm.classList.toggle('star', lut.starred); sb.classList.toggle('on', lut.starred); } return; }
      if (a && a.dataset.a === 'hide') { lut.hidden = !lut.hidden; refresh(); return; }
      openInspector(lut.id);
    });
    f.addEventListener('keydown', e => { if (e.key === 'Enter') openInspector(lut.id); });
  }
  io.observe(f);
  return t;
}
function buildGrid() {
  io.disconnect(); grid.textContent = ''; tiles.clear();
  if (!state.src) return;
  if (state.view.original) { const t = buildTile(null); tiles.set('orig', t); grid.appendChild(t.el); }
  const list = visibleLuts();
  const frag = document.createDocumentFragment();
  list.forEach(l => { const t = buildTile(l); if (l.hidden) t.el.style.opacity = .45; tiles.set(l.id, t); frag.appendChild(t.el); });
  grid.appendChild(frag);
  $('#shown').textContent = state.luts.length ? `${list.length} / ${state.luts.length}` : '';
  schedule();
}
function updateAspectVar() { document.documentElement.style.setProperty('--ar', tileAspect()); }
function refresh() {
  updateAspectVar();
  buildGrid();
  const n = state.luts.length, hid = state.luts.filter(l => l.hidden).length;
  $('#lutCount').textContent = n;
  $('#hiddenNote').textContent = hid ? ` · ${hid} hidden` : '';
  $('#unhideAll').hidden = !hid;
  // empty state
  const empty = $('#empty');
  const need = !state.src && !n ? 0 : !state.src ? 1 : !n ? 2 : 3;
  empty.hidden = need === 3;
  empty.classList.toggle('slim', need !== 0);
  $('#emptyTitle').textContent = ['Drop a frame and a folder of LUTs', 'Now drop a frame', 'Now drop your LUT folder'][need] || '';
  $('#emptyText').innerHTML = ['Anywhere on this page. Images, video, <b>.cube</b> files, or whole folders.',
    'An image, a video, or a still — or hit “Use sample”.', 'Any folder of <b>.cube</b> files — or try “Demo looks”.'][need] || '';
}
function markAllDirty() { tiles.forEach(t => t.dirty = true); schedule(); }
function markDirty(id) { const t = tiles.get(id); if (t) { t.dirty = true; schedule(); } }

let raf = 0;
function schedule() { if (!raf) raf = requestAnimationFrame(pump); }
function pump() {
  raf = 0; const t0 = performance.now(); let more = false;
  const ar = tileAspect();
  for (const t of tiles.values()) {
    if (!t.dirty || !t.visible) continue;
    if (performance.now() - t0 > 12) { more = true; break; }
    const w = clamp(Math.round(t.canvas.clientWidth * dpr()), 64, 1200), h = Math.round(w / ar);
    renderer.render(t.canvas, w, h, t.lut ? effective(t.lut) : NEUTRAL, t.lut, ar);
    t.dirty = false;
  }
  if (more) schedule();
}
let rzT;
new ResizeObserver(() => { clearTimeout(rzT); rzT = setTimeout(markAllDirty, 120); }).observe(grid);

/* ------------------------------------------------------------------ inspector */
const insp = $('#insp'), pv = $('#pv');
let splitPct = 50;
const inSliders = [];
function curLut() { return state.luts.find(l => l.id === state.current); }
function openInspector(id) {
  state.current = id; insp.hidden = false; document.body.style.overflow = 'hidden';
  requestAnimationFrame(syncInspector);
}
function closeInspector() { insp.hidden = true; state.current = null; document.body.style.overflow = ''; }
function syncInspector() {
  const l = curLut(); if (!l) return;
  $('#inName').textContent = l.name;
  $('#inMeta').textContent = `${l.size}³ ${l.kind} LUT · ${l.path}`;
  const list = visibleLuts(), i = list.findIndex(x => x.id === l.id);
  $('#inIdx').textContent = `${i + 1} / ${list.length}`;
  $('#inStar').textContent = l.starred ? 'Unstar' : 'Star';
  $('#inHide').textContent = l.hidden ? 'Unhide' : 'Hide';
  inSliders.forEach(s => s.sync()); $('#orderSeg').sync();
  fitPreview(); renderInspector(true);
}
function fitPreview() {
  if (!state.src) return;
  const wrap = $('#pvWrap'), ar = state.src.w / state.src.h;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
  pv.style.width = Math.floor(w) + 'px'; pv.style.height = Math.floor(h) + 'px';
}
function renderInspector(both) {
  const l = curLut(); if (!l || insp.hidden) return;
  const ar = state.src.w / state.src.h;
  const w = clamp(Math.round(pv.clientWidth * dpr()), 64, 2000), h = Math.round(w / ar);
  renderer.render($('#pvLut'), w, h, effective(l), l, ar);
  if (both) renderer.render($('#pvOrig'), w, h, NEUTRAL, null, ar);
}
function navInspector(d) {
  const list = visibleLuts(), i = list.findIndex(x => x.id === state.current);
  if (!list.length) return;
  state.current = list[(i + d + list.length) % list.length].id; syncInspector();
}
function setSplit(clientX) { const r = pv.getBoundingClientRect(); splitPct = clamp((clientX - r.left) / r.width * 100, 0, 100); pv.style.setProperty('--s', splitPct + '%'); }
$('#split').addEventListener('pointerdown', e => { e.target.setPointerCapture?.(e.pointerId); $('#split').setPointerCapture(e.pointerId); $('#split')._d = true; });
$('#split').addEventListener('pointermove', e => { if ($('#split')._d) setSplit(e.clientX); });
$('#split').addEventListener('pointerup', () => $('#split')._d = false);
pv.addEventListener('pointerdown', e => { if (e.target.closest('#split')) return; setSplit(e.clientX); $('#split')._d = true; $('#split').setPointerCapture(e.pointerId); });
window.addEventListener('resize', () => { if (!insp.hidden) { fitPreview(); renderInspector(true); } });
window.addEventListener('keydown', e => {
  if (insp.hidden || e.target.matches('input')) return;
  if (e.key === 'Escape') closeInspector();
  else if (e.key === 'ArrowRight') navInspector(1);
  else if (e.key === 'ArrowLeft') navInspector(-1);
  else if (e.key.toLowerCase() === 'r') $('#inReset').click();
});
$('#inClose').onclick = closeInspector;
$('#inPrev').onclick = () => navInspector(-1);
$('#inNext').onclick = () => navInspector(1);
$('#inReset').onclick = () => { const l = curLut(); l.settings = defaults(); markDirty(l.id); syncInspector(); };
$('#inApplyAll').onclick = () => { const s = curLut().settings; state.luts.forEach(l => l.settings = { ...s }); markAllDirty(); toast('Applied to all LUTs'); };
$('#inStar').onclick = () => { const l = curLut(); l.starred = !l.starred; syncInspector(); buildGrid(); };
$('#inHide').onclick = () => { const l = curLut(); l.hidden = !l.hidden; if (l.hidden && !state.showHidden) { const list = visibleLuts(); const nxt = list.find(x => x.id !== l.id); if (nxt) { state.current = nxt.id; refresh(); syncInspector(); return; } closeInspector(); } refresh(); syncInspector(); };
$('#inSave').onclick = async () => {
  const l = curLut(); if (!l) return;
  const blob = await renderFull(l);
  download(blob, `${state.src.name.replace(/\.[^.]+$/, '')}_${l.name}.png`);
};

async function fullSourceCanvas() {
  const s = state.src, MAX = 8192;
  if (s.kind === 'image') return scaledCanvas(s.bitmap, s.w, s.h, MAX);
  return scaledCanvas(s.video, s.w, s.h, MAX);
}
async function renderFull(lut) {
  toast('Rendering full resolution…', 1800); await tick();
  const full = await fullSourceCanvas();
  renderer.setSource(full, full.width, full.height);
  const out = document.createElement('canvas');
  renderer.render(out, full.width, full.height, effective(lut), lut, full.width / full.height);
  const blob = await canvasBlob(out, 'image/png');
  renderer.setSource(state.src.canvas, state.src.canvas.width, state.src.canvas.height);
  return blob;
}

/* ------------------------------------------------------------------ export contact sheet */
async function exportSheet() {
  if (!state.src) return toast('Load a frame first');
  let list = visibleLuts();
  if (state.exp.starred && list.some(l => l.starred)) list = list.filter(l => l.starred);
  const items = [...(state.exp.original ? [null] : []), ...list];
  if (!items.length) return toast('Nothing to export yet');
  toast('Building sheet…', 5000); await tick();
  await document.fonts.load('300 20px "Satoshi Local"').catch(() => {});
  await document.fonts.load('300 20px Satoshi').catch(() => {});
  const ar = tileAspect(), E = state.exp;
  const cols = E.cols || Math.min(items.length, Math.max(2, Math.round(Math.sqrt(items.length * 1.5))));
  const rows = Math.ceil(items.length / cols);
  let tw = E.w;
  const dims = (tw) => { const pad = Math.round(tw * 0.045), th = Math.round(tw / ar), lh = E.labels ? Math.round(tw * 0.1) : 0, head = Math.round(tw * 0.22);
    return { pad, th, lh, head, W: pad + cols * (tw + pad), H: head + rows * (th + lh + pad) + pad }; };
  let d = dims(tw);
  while ((d.W > 16000 || d.H > 16000 || d.W * d.H > 200e6) && tw > 120) { tw = Math.round(tw * 0.9); d = dims(tw); }
  const sheet = document.createElement('canvas'); sheet.width = d.W; sheet.height = d.H;
  const c = sheet.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--bg').trim(), ink = css.getPropertyValue('--ink').trim(), ink3 = css.getPropertyValue('--ink3').trim(), card = css.getPropertyValue('--card').trim();
  c.fillStyle = bg; c.fillRect(0, 0, d.W, d.H);
  const font = (px) => `300 ${px}px "Satoshi Local", Satoshi, sans-serif`;
  c.fillStyle = ink; c.font = font(Math.round(tw * 0.085)); c.textBaseline = 'alphabetic';
  c.fillText(state.src.name.replace(/\.[^.]+$/, ''), d.pad, d.pad + tw * 0.09);
  c.fillStyle = ink3; c.font = font(Math.round(tw * 0.04));
  c.fillText(`${list.length} LUT${list.length === 1 ? '' : 's'} · lutsheet`, d.pad, d.pad + tw * 0.09 + tw * 0.07);
  const tmp = document.createElement('canvas');
  for (let i = 0; i < items.length; i++) {
    if (i % 3 === 0) await tick();
    const col = i % cols, row = Math.floor(i / cols);
    const x = d.pad + col * (tw + d.pad), y = d.head + row * (d.th + d.lh + d.pad);
    const lut = items[i];
    renderer.render(tmp, tw, d.th, lut ? effective(lut) : NEUTRAL, lut, ar);
    c.save(); c.beginPath(); c.roundRect(x, y, tw, d.th, tw * 0.025); c.clip(); c.drawImage(tmp, x, y); c.restore();
    if (E.labels) { c.fillStyle = ink; c.font = font(Math.round(tw * 0.05)); c.fillText(lut ? lut.name : 'Original', x + 2, y + d.th + tw * 0.07, tw - 4); }
  }
  const isJpg = E.fmt === 'jpg';
  const blob = await canvasBlob(sheet, isJpg ? 'image/jpeg' : 'image/png', 0.93);
  download(blob, `lutsheet_${state.src.name.replace(/\.[^.]+$/, '')}.${isJpg ? 'jpg' : 'png'}`);
  toast(`Exported ${d.W}×${d.H}`);
}

/* ------------------------------------------------------------------ recipes */
function saveRecipe() {
  const rec = { app: 'lutsheet', version: 1, master: state.master, luts: state.luts.map(l => ({ name: l.name, settings: l.settings, starred: l.starred, hidden: l.hidden })) };
  download(new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' }), 'lutsheet-recipe.json');
}
async function loadRecipe(file) {
  try {
    const rec = JSON.parse(await file.text());
    if (rec.app !== 'lutsheet') throw 0;
    state.master = { ...defaults(), ...rec.master };
    let hit = 0;
    for (const r of rec.luts || []) { const l = state.luts.find(x => x.name === r.name); if (l) { l.settings = { ...defaults(), ...r.settings }; l.starred = !!r.starred; l.hidden = !!r.hidden; hit++; } }
    masterSliders.forEach(s => s.sync()); refresh(); toast(`Recipe applied to ${hit} LUT${hit === 1 ? '' : 's'}`);
  } catch { toast('Not a lutsheet recipe'); }
}

/* ------------------------------------------------------------------ wire up UI */
// master + inspector sliders
const MASTER_KEYS = ['intensity', 'exposure', 'contrast', 'saturation', 'temperature', 'tint'];
const masterSliders = CONTROLS.filter(c => MASTER_KEYS.includes(c.k)).map(c => makeSlider(c, () => state.master[c.k], v => { state.master[c.k] = v; markAllDirty(); }));
masterSliders.forEach(s => $('#masterSliders').appendChild(s));
CONTROLS.forEach(c => {
  const s = makeSlider(c, () => (curLut() || { settings: defaults() }).settings[c.k], v => { const l = curLut(); l.settings[c.k] = v; markDirty(l.id); renderInspector(false); });
  inSliders.push(s); $('#g' + c.g[0].toUpperCase() + c.g.slice(1)).appendChild(s);
});
makeSeg($('#orderSeg'), [['pre', 'before LUT'], ['post', 'after LUT']], () => (curLut() || { settings: defaults() }).settings.order, v => { const l = curLut(); l.settings.order = v; markDirty(l.id); renderInspector(false); });
$('#masterReset').onclick = () => { state.master = defaults(); masterSliders.forEach(s => s.sync()); markAllDirty(); };

// video scrubber
vidSlider = (() => {
  const c = { l: 'Time', min: 0, max: 1, step: 0.01, def: 0 };
  const el = makeSlider(c, () => (state.src && state.src.video ? state.src.video.currentTime : 0), v => { if (state.src && state.src.video) state.src.video.currentTime = v; });
  el.querySelector('.v').remove(); $('#vidSlider').appendChild(el);
  return { set(t, dur) { const i = el.querySelector('input'); i.max = dur; i.value = t; el.sync(); } };
})();
const stepVid = (d) => { const v = state.src && state.src.video; if (v) { v.currentTime = clamp(v.currentTime + d / 24, 0, v.duration); const i = $('#vidSlider input'); i.value = v.currentTime; i.style.setProperty('--p', (v.currentTime / v.duration * 100) + '%'); } };
$('#stepBack').onclick = () => stepVid(-1); $('#stepFwd').onclick = () => stepVid(1);
$('#vidSlider input').addEventListener('input', () => { const i = $('#vidSlider input'); i.style.setProperty('--p', (i.value / i.max * 100) + '%'); });

// view
$('#viewSliders').appendChild(makeSlider({ l: 'Tile size', min: 160, max: 640, step: 10, def: 300, u: 'px' }, () => state.view.tile, v => { state.view.tile = v; document.documentElement.style.setProperty('--tile', v + 'px'); }));
makeSeg($('#aspectSeg'), [['source', 'Source'], ['1.7778', '16:9'], ['1', '1:1'], ['0.8', '4:5'], ['2.39', '2.39']], () => state.view.aspect, v => { state.view.aspect = v; updateAspectVar(); markAllDirty(); });
makeToggle($('#viewToggles'), 'Show original first', () => state.view.original, v => { state.view.original = v; buildGrid(); });
makeSeg($('#sortSeg'), [['name', 'A–Z'], ['load', 'Loaded'], ['starred', 'Starred']], () => state.sort, v => { state.sort = v; buildGrid(); });
$('#filter').addEventListener('input', e => { state.filter = e.target.value; buildGrid(); });

// export
makeSeg($('#expW'), [[480, '480'], [720, '720'], [1080, '1080'], [1600, '1600']], () => state.exp.w, v => state.exp.w = v);
makeSeg($('#expCols'), [[0, 'Auto'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [8, '8']], () => state.exp.cols, v => state.exp.cols = v);
makeSeg($('#expFmt'), [['png', 'PNG'], ['jpg', 'JPG']], () => state.exp.fmt, v => state.exp.fmt = v);
makeToggle($('#expToggles'), 'Labels', () => state.exp.labels, v => state.exp.labels = v);
makeToggle($('#expToggles'), 'Include original', () => state.exp.original, v => state.exp.original = v);
makeToggle($('#expToggles'), 'Starred only (if any)', () => state.exp.starred, v => state.exp.starred = v);
$('#exportBtn').onclick = exportSheet;
$('#saveRecipe').onclick = saveRecipe;
$('#loadRecipe').onclick = () => $('#fRecipe').click();
$('#fRecipe').onchange = e => { if (e.target.files[0]) loadRecipe(e.target.files[0]); e.target.value = ''; };

// pickers
$('#pickSrc').onclick = () => $('#fSrc').click();
$('#pickDir').onclick = () => $('#fDir').click();
$('#pickCubes').onclick = () => $('#fCubes').click();
for (const id of ['fSrc', 'fDir', 'fCubes']) $('#' + id).onchange = e => { handleFiles(e.target.files); e.target.value = ''; };
$('#sampleBtn').onclick = () => { const cv = sampleCanvas(); applySource({ name: 'sample.png', kind: 'image', w: cv.width, h: cv.height, canvas: cv, bitmap: cv }); };
$('#demoBtn').onclick = async () => { await addParsedLuts(Cube.demoLooks()); toast('16 demo looks added'); };
$('#clearLuts').onclick = () => { state.luts.forEach(l => renderer.freeLut(l)); state.luts = []; refresh(); };
$('#unhideAll').onclick = () => { state.luts.forEach(l => l.hidden = false); refresh(); };

// theme
const setTheme = (t) => { document.documentElement.dataset.theme = t; $('#themeBtn').textContent = t === 'dark' ? 'off-white' : 'off-black'; try { localStorage.setItem('lutsheet-theme', t); } catch {} };
$('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
try { setTheme(localStorage.getItem('lutsheet-theme') || 'light'); } catch { setTheme('light'); }

refresh();
window.lutsheet = { state, handleFiles, renderer };
})();
