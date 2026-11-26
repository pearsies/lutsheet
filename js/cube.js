/* .cube LUT parsing + a set of procedurally generated demo looks.
   Works in the browser (global `Cube`) and in node (module.exports). */
const Cube = (() => {
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

  /** Parse an Adobe/Resolve .cube file. Returns {size,data(RGBA float),dmin,dmax,title}. */
  function parse(text) {
    let size3 = 0, size1 = 0, title = '';
    let dmin = [0, 0, 0], dmax = [1, 1, 1];
    let data = null, n = 0;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln || ln[0] === '#') continue;
      const c = ln.charCodeAt(0);
      if ((c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43) {
        if (!data) {
          const cnt = size3 ? size3 ** 3 : size1;
          if (!cnt) throw new Error('LUT size missing');
          data = new Float32Array(cnt * 3);
        }
        const p = ln.split(/\s+/);
        data[n++] = +p[0]; data[n++] = +p[1]; data[n++] = +p[2];
        continue;
      }
      const [key, ...rest] = ln.split(/\s+/);
      switch (key) {
        case 'LUT_3D_SIZE': size3 = +rest[0]; break;
        case 'LUT_1D_SIZE': size1 = +rest[0]; break;
        case 'DOMAIN_MIN': dmin = rest.slice(0, 3).map(Number); break;
        case 'DOMAIN_MAX': dmax = rest.slice(0, 3).map(Number); break;
        case 'TITLE': title = rest.join(' ').replace(/"/g, ''); break;
      }
    }
    if (!data || n < data.length) throw new Error('LUT data incomplete');

    if (size3) {
      const out = new Float32Array(size3 ** 3 * 4);
      for (let i = 0, j = 0, k = 0; i < size3 ** 3; i++) {
        out[j++] = data[k++]; out[j++] = data[k++]; out[j++] = data[k++]; out[j++] = 1;
      }
      return { size: size3, data: out, dmin, dmax, title, kind: '3D' };
    }
    // 1D LUT -> bake to a 33^3 cube
    const S = 33, N = size1, out = new Float32Array(S ** 3 * 4);
    const samp = (ch, t) => {
      const x = clamp(t) * (N - 1), i0 = Math.floor(x), i1 = Math.min(N - 1, i0 + 1), f = x - i0;
      return data[i0 * 3 + ch] * (1 - f) + data[i1 * 3 + ch] * f;
    };
    let j = 0;
    for (let b = 0; b < S; b++) for (let g = 0; g < S; g++) for (let r = 0; r < S; r++) {
      out[j++] = samp(0, r / (S - 1)); out[j++] = samp(1, g / (S - 1)); out[j++] = samp(2, b / (S - 1)); out[j++] = 1;
    }
    return { size: S, data: out, dmin, dmax, title, kind: '1D' };
  }

  /** Serialise a generated look to .cube text. */
  function toCube(look) {
    const { size, data, name } = look;
    const out = [`TITLE "${name}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
    for (let i = 0; i < size ** 3; i++)
      out.push(`${data[i * 4].toFixed(6)} ${data[i * 4 + 1].toFixed(6)} ${data[i * 4 + 2].toFixed(6)}`);
    return out.join('\n') + '\n';
  }

  // ---------- demo looks ----------
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
  const sat = (c, s) => { const l = lum(c); return c.map(v => l + (v - l) * s); };
  const curve = (x, k) => { x = clamp(x); return x < 0.5 ? 0.5 * Math.pow(2 * x, k) : 1 - 0.5 * Math.pow(2 * (1 - x), k); };
  const contrast = (c, k) => c.map(v => curve(v, k));
  const split = (c, sh, hi, amt = 1) => {
    const w = smooth(lum(c));
    return c.map((v, i) => v + (mix(sh[i], hi[i], w)) * amt);
  };
  const lift = (c, black, white) => c.map(v => black + v * (white - black));
  const mul = (c, m) => c.map((v, i) => v * m[i]);

  const LOOKS = {
    'Teal & Orange': c => split(sat(contrast(c, 1.25), 1.12), [-0.05, 0.02, 0.075], [0.075, 0.02, -0.06]),
    'Bleach Bypass': c => { const l = lum(c); return contrast(c.map(v => mix(v, l, 0.5)), 1.45); },
    'Warm Film': c => split(lift(contrast(sat(c, 0.94), 1.15), 0.03, 0.97), [0.0, 0.015, 0.01], [0.05, 0.02, -0.04]),
    'Cool Noir': c => split(contrast(sat(c, 0.3), 1.35), [-0.02, 0.0, 0.05], [-0.01, 0.01, 0.04]),
    'Faded Matte': c => lift(sat(c, 0.85), 0.09, 0.93),
    'Golden Hour': c => contrast(mul(c, [1.1, 1.0, 0.82]), 1.1),
    'Hard B&W': c => { const l = curve(lum(c), 1.7); return [l, l, l]; },
    'Soft B&W': c => { const l = lift([lum(c)], 0.04, 0.96)[0]; return [l, l, l]; },
    'Sepia': c => { const l = lum(c); return [l * 1.07, l * 0.76, l * 0.46].map(v => clamp(v)); },
    'Cross Process': c => sat([curve(c[0], 1.55), curve(c[1], 1.1), 0.12 + 0.8 * c[2]], 1.25),
    'Vivid Pop': c => contrast(sat(c, 1.55), 1.15),
    'Moonlight': c => mul(sat(c, 0.7), [0.82, 0.93, 1.12]),
    'Cyber Dusk': c => split(contrast(sat(c, 1.2), 1.2), [-0.03, -0.03, 0.12], [0.1, 0.03, 0.1]),
    'Emerald Shadows': c => split(contrast(c, 1.1), [-0.04, 0.05, 0.02], [0.05, 0.03, -0.03]),
    'Portra Skin': c => split(lift(sat(c, 0.9), 0.025, 0.985), [0.0, 0.01, 0.015], [0.045, 0.015, -0.02]),
    'Infrared Pink': c => [c[0] * 0.5 + c[1] * 0.7, c[1] * 0.35 + c[0] * 0.15, c[2] * 0.8 + c[0] * 0.3].map(v => clamp(v)),
  };

  function demoLooks(size = 33) {
    return Object.entries(LOOKS).map(([name, fn]) => {
      const data = new Float32Array(size ** 3 * 4);
      let j = 0;
      for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
        const o = fn([r / (size - 1), g / (size - 1), b / (size - 1)]);
        data[j++] = clamp(o[0]); data[j++] = clamp(o[1]); data[j++] = clamp(o[2]); data[j++] = 1;
      }
      return { name, size, data, dmin: [0, 0, 0], dmax: [1, 1, 1], kind: '3D', demo: true };
    });
  }

  return { parse, toCube, demoLooks };
})();
if (typeof module !== 'undefined') module.exports = Cube;
