/* WebGL2 renderer: source image + 3D LUT + per-LUT adjustments -> 2D canvas. */
class Renderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 16;
    const gl = this.gl = this.canvas.getContext('webgl2', {
      antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is required');

    const vs = `#version 300 es
    out vec2 vUv;
    void main(){
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      vUv = vec2(p.x, 1.0 - p.y);
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;

    const fs = `#version 300 es
    precision highp float; precision highp sampler3D;
    uniform sampler2D uSrc; uniform sampler3D uLut;
    uniform bool uHasLut, uPost;
    uniform vec3 uDmin, uDmax; uniform float uSize;
    uniform vec2 uUvScale;
    uniform float uIntensity, uExposure, uContrast, uSat, uTemp, uTint, uHue, uShadows, uHighlights, uFade, uGamma;
    in vec2 vUv; out vec4 o;

    vec3 lutSample(vec3 c){
      vec3 t = clamp((c - uDmin) / (uDmax - uDmin), 0.0, 1.0);
      t = t * (uSize - 1.0) / uSize + 0.5 / uSize;
      return texture(uLut, t).rgb;
    }
    vec3 adjust(vec3 c){
      c = clamp(c, 0.0, 1.0);
      c = pow(pow(c, vec3(2.2)) * exp2(uExposure), vec3(1.0 / 2.2));
      c = (c - 0.5) * (1.0 + uContrast) + 0.5;
      c *= vec3(1.0 + 0.22 * uTemp + 0.06 * uTint, 1.0 - 0.14 * uTint, 1.0 - 0.22 * uTemp + 0.06 * uTint);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = vec3(l) + (c - vec3(l)) * (1.0 + uSat);
      if (uHue != 0.0) {
        float a = radians(uHue), cs = cos(a), sn = sin(a);
        mat3 m = mat3(
          0.299 + 0.701*cs + 0.168*sn, 0.299 - 0.299*cs - 0.328*sn, 0.299 - 0.3*cs + 1.25*sn,
          0.587 - 0.587*cs + 0.33*sn,  0.587 + 0.413*cs + 0.035*sn, 0.587 - 0.588*cs - 1.05*sn,
          0.114 - 0.114*cs - 0.497*sn, 0.114 - 0.114*cs + 0.292*sn, 0.114 + 0.886*cs - 0.203*sn);
        c = m * c;
      }
      c = clamp(c, 0.0, 1.0);
      c += uShadows * 0.25 * (1.0 - c) * (1.0 - c);
      c += uHighlights * 0.25 * c * c;
      c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / (1.0 + uGamma * 0.8)));
      c = c * (1.0 - uFade * 0.14) + uFade * 0.14;
      return clamp(c, 0.0, 1.0);
    }
    void main(){
      vec2 uv = (vUv - 0.5) * uUvScale + 0.5;
      vec3 c = texture(uSrc, uv).rgb;
      vec3 base = adjust(c), graded = base;
      if (uHasLut) graded = uPost ? adjust(lutSample(clamp(c,0.0,1.0))) : lutSample(base);
      o = vec4(mix(base, graded, uIntensity), 1.0);
    }`;

    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = this.prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(prog, i).name; this.u[nm] = gl.getUniformLocation(prog, nm); }

    this.srcTex = null; this.srcW = 1; this.srcH = 1;
    this.dummy = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.dummy);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.ctxCache = new WeakMap();
  }

  setSource(drawable, w, h) {
    const gl = this.gl;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    const t = this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, drawable);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.srcW = w; this.srcH = h;
  }

  lutTexture(lut) {
    if (lut._tex) return lut._tex;
    const gl = this.gl, s = lut.size;
    const t = lut._tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, s, s, s, 0, gl.RGBA, gl.FLOAT, lut.data);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    return t;
  }
  freeLut(lut) { if (lut._tex) { this.gl.deleteTexture(lut._tex); lut._tex = null; } }

  /** Render into a 2D `target` canvas at w x h. `aspect` = tile aspect (cover-crop of the source). */
  render(target, w, h, p, lut, aspect) {
    const gl = this.gl, u = this.u;
    if (!this.srcTex) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.srcTex); gl.uniform1i(u.uSrc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut ? this.lutTexture(lut) : this.dummy); gl.uniform1i(u.uLut, 1);
    gl.uniform1i(u.uHasLut, lut ? 1 : 0);
    gl.uniform1i(u.uPost, p.post ? 1 : 0);
    gl.uniform3fv(u.uDmin, lut ? lut.dmin : [0, 0, 0]);
    gl.uniform3fv(u.uDmax, lut ? lut.dmax : [1, 1, 1]);
    gl.uniform1f(u.uSize, lut ? lut.size : 1);
    const sa = this.srcW / this.srcH, ta = aspect || sa;
    gl.uniform2f(u.uUvScale, ta > sa ? 1 : ta / sa, ta > sa ? sa / ta : 1);
    gl.uniform1f(u.uIntensity, p.intensity);
    gl.uniform1f(u.uExposure, p.exposure);
    gl.uniform1f(u.uContrast, p.contrast);
    gl.uniform1f(u.uSat, p.saturation);
    gl.uniform1f(u.uTemp, p.temperature);
    gl.uniform1f(u.uTint, p.tint);
    gl.uniform1f(u.uHue, p.hue);
    gl.uniform1f(u.uShadows, p.shadows);
    gl.uniform1f(u.uHighlights, p.highlights);
    gl.uniform1f(u.uFade, p.fade);
    gl.uniform1f(u.uGamma, p.gamma);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (target.width !== w || target.height !== h) { target.width = w; target.height = h; }
    let ctx = this.ctxCache.get(target);
    if (!ctx) { ctx = target.getContext('2d'); this.ctxCache.set(target, ctx); }
    ctx.drawImage(this.canvas, 0, 0);
  }
}
