# lutsheet

Drop in **one frame** (image, video or still) and a **folder of LUTs** → get a grid comparing them all,
with per-LUT and master controls, and a one-click contact-sheet export.

Off-black / off-white bento UI, set in Satoshi Light.

## Run it

No build step. Open `index.html` directly, or serve the folder:

```bash
python3 -m http.server 5173   # then visit http://localhost:5173
```

Needs a modern browser with WebGL2 (Chrome, Edge, Safari, Firefox). Everything runs locally; nothing is uploaded.

## Use it

- **Drop anywhere**: an image/video, `.cube` files, or whole folders (subfolders included).
- **Video**: scrub to any frame; ◀ ▶ step a frame at a time.
- **Click a tile** to inspect: before/after split, and per-LUT sliders — intensity, exposure, contrast,
  saturation, temperature, tint, hue, fade, shadows, highlights, gamma — plus whether adjustments run
  *before* or *after* the LUT. Double-click a slider label to reset it. `←` `→` browse, `Esc` closes, `R` resets.
- **Master** sliders stack on top of every LUT. **Apply to all** copies one look's settings to every LUT.
- Star / hide tiles, filter and sort, change tile size and shape (source, 16:9, 1:1, 4:5, 2.39).
- **Export** a contact sheet (PNG/JPG, up to ~16k px), save a full-resolution graded frame, or
  save/load a **recipe** (JSON of all settings, matched by LUT name).
- **Demo looks** adds 16 generated LUTs; `node tools/make-sample-luts.js` writes them to `samples/luts/` as `.cube` files.

Supports 3D `.cube` (any size, custom `DOMAIN_MIN/MAX`) and 1D `.cube` (baked to 33³).
LUTs are applied to the sRGB-encoded image, so log footage needs a conversion LUT first (or use exposure/contrast).

## Font

Satoshi loads from Fontshare. For offline use see [fonts/README.md](fonts/README.md).

## Layout

```
index.html  css/style.css
js/cube.js      .cube parser + demo looks
js/gl.js        WebGL2 renderer (3D LUT texture + adjustments)
js/app.js       state, grid, inspector, export
```

MIT licensed.
