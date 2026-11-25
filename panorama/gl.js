/**
 * Panorama WebGL 360° equirectangular renderer, sharpness & color shader,
 * WebXR / stereo VR engine, camera inertia/gyro/keyboard, and 2-scene sample generator.
 */

export const HOME_FOV = 72;
export const MIN_FOV = 28;
export const MAX_FOV = 105;
export const MAX_PITCH = 85 * Math.PI / 180;

const FADE_MS = 300;
const IS_IOS = typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// iOS/iPadOS Safari rejects canvases and textures above ~16.7 MP.
export function isConstrainedDevice() {
  if (IS_IOS) return true;
  if (typeof matchMedia !== "function" || typeof screen === "undefined") return false;
  return matchMedia("(pointer: coarse)").matches && Math.min(screen.width || 0, screen.height || 0) <= 600;
}

export function deviceTextureCap() {
  return isConstrainedDevice() ? 4096 : 8192;
}

export function gradeOf(scene) {
  const g = (scene && scene.grade) || {};
  return {
    exposure: Number(g.exposure) || 0,
    highlights: Number(g.highlights) || 0,
    shadows: Number(g.shadows) || 0,
    black: Number(g.black) || 0,
    saturation: g.saturation == null ? 1 : Number(g.saturation),
    warmth: Number(g.warmth) || 0,
    sharpness: Number(g.sharpness) || 0
  };
}

const VERT = `
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
uniform sampler2D uTex;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform vec2 uOffset;
uniform vec2 uTexel;
uniform float uClampU;
uniform float uPrevClampU;
uniform float uMix;
uniform float uFov;
uniform float uYaw;
uniform float uPitch;
uniform float uRoll;
uniform vec2 uFlip;
uniform float uBright;
uniform float uContrast;
uniform float uExposure;
uniform float uHighlights;
uniform float uShadows;
uniform float uBlack;
uniform float uSaturation;
uniform float uWarmth;
uniform float uSharpness;
uniform float uBypassGrade;
uniform float uEncode;
uniform float uXR;
uniform mat4 uInvVP;

float wrapU(float x, float h) {
  x = fract(x);
  return h > 0.0 ? clamp(x, h, 1.0 - h) : x;
}

vec4 tex(sampler2D s, vec2 uv, vec2 gx, vec2 gy) {
#ifdef USE_GRAD
  return TEXGRAD(s, uv, gx, gy);
#else
  return TEX(s, uv);
#endif
}

vec3 sampleEqui(vec2 uv, vec2 gx, vec2 gy) {
  vec3 c = tex(uTex, vec2(wrapU(uv.x, uClampU), uv.y), gx, gy).rgb;
  if (uSharpness > 0.005 && uBypassGrade < 0.5) {
    float u0 = wrapU(uv.x, uClampU);
    vec3 blur = (
      tex(uTex, vec2(wrapU(uv.x + uTexel.x, uClampU), uv.y), gx, gy).rgb +
      tex(uTex, vec2(wrapU(uv.x - uTexel.x, uClampU), uv.y), gx, gy).rgb +
      tex(uTex, vec2(u0, clamp(uv.y + uTexel.y, 0.001, 0.999)), gx, gy).rgb +
      tex(uTex, vec2(u0, clamp(uv.y - uTexel.y, 0.001, 0.999)), gx, gy).rgb
    ) * 0.25;
    c = c + (c - blur) * (uSharpness * 1.15);
  }
  return c;
}

void main() {
  vec2 ndc = (gl_FragCoord.xy - uOffset) / uRes * 2.0 - 1.0;
  float aspect = uRes.x / max(1.0, uRes.y);
  float t = tan(uFov * 0.5);
  vec3 dir;
  if (uXR > 0.5) {
    vec4 farP = uInvVP * vec4(ndc, 1.0, 1.0);
    dir = normalize(farP.xyz / farP.w);
    float cr = cos(uRoll), sr = sin(uRoll);
    dir = vec3(dir.x * cr - dir.y * sr, dir.x * sr + dir.y * cr, dir.z);
    float cy = cos(uYaw), sy = sin(uYaw);
    dir = vec3(dir.x * cy + dir.z * sy, dir.y, -dir.x * sy + dir.z * cy);
  } else {
    dir = normalize(vec3(ndc.x * aspect * t, ndc.y * t, -1.0));
    float cr = cos(uRoll), sr = sin(uRoll);
    dir = vec3(dir.x * cr - dir.y * sr, dir.x * sr + dir.y * cr, dir.z);
    float cp = cos(uPitch), sp = sin(uPitch);
    dir = vec3(dir.x, dir.y * cp - dir.z * sp, dir.y * sp + dir.z * cp);
    float cy = cos(uYaw), sy = sin(uYaw);
    dir = vec3(dir.x * cy + dir.z * sy, dir.y, -dir.x * sy + dir.z * cy);
  }
  dir.x *= uFlip.x;
  dir.y *= uFlip.y;
  float lon = atan(dir.z, dir.x);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(lon / 6.28318530718 + 0.75, 0.5 - lat / 3.14159265359);
  vec2 gx = vec2(0.0);
  vec2 gy = vec2(0.0);
#ifdef USE_GRAD
  gx = dFdx(uv);
  gy = dFdy(uv);
  gx.x -= floor(gx.x + 0.5);
  gy.x -= floor(gy.x + 0.5);
#endif
  vec3 color = sampleEqui(uv, gx, gy);
  if (uMix < 0.999) {
    vec3 before = tex(uPrev, vec2(wrapU(uv.x, uPrevClampU), uv.y), gx, gy).rgb;
    color = mix(before, color, uMix);
  }
  if (uBypassGrade < 0.5) {
    color *= exp2(uExposure);
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float shadowW = pow(1.0 - clamp(luma, 0.0, 1.0), 2.0);
    float highW = pow(clamp(luma, 0.0, 1.0), 2.0);
    color += uShadows * shadowW * 0.55;
    color += uHighlights * highW * 0.35;
    color = (color - 0.5) * uContrast + 0.5 + uBright;
    color = (color - uBlack) / max(0.05, 1.0 - uBlack);
    float gray = dot(max(color, 0.0), vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(gray), color, uSaturation);
    color *= vec3(1.0 + uWarmth * 0.18, 1.0 + uWarmth * 0.04, 1.0 - uWarmth * 0.22);
  }
  color = clamp(color, 0.0, 1.0);
  if (uEncode > 0.5) {
    vec3 lo = color * 12.92;
    vec3 hi = 1.055 * pow(color, vec3(0.416666667)) - 0.055;
    color = mix(lo, hi, step(vec3(0.0031308), color));
  }
  FRAG_OUT = vec4(color, 1.0);
}
`;

// mode 2: WebGL2 textureGrad, 1: WebGL1 + EXT_shader_texture_lod, 0: implicit mips.
function shaderSources(mode) {
  if (mode === 2) {
    return {
      vert: "#version 300 es\nin vec2 aPos;" + VERT,
      frag: "#version 300 es\nprecision highp float;\n#define USE_GRAD 1\n#define TEX(s, uv) texture(s, uv)\n" +
        "#define TEXGRAD(s, uv, gx, gy) textureGrad(s, uv, gx, gy)\nout vec4 fragOut;\n#define FRAG_OUT fragOut\n" + FRAG
    };
  }
  const head = mode === 1
    ? "#extension GL_OES_standard_derivatives : enable\n#extension GL_EXT_shader_texture_lod : enable\nprecision highp float;\n" +
      "#define USE_GRAD 1\n#define TEXGRAD(s, uv, gx, gy) texture2DGradEXT(s, uv, gx, gy)\n"
    : "precision highp float;\n";
  return {
    vert: "attribute vec2 aPos;" + VERT,
    frag: head + "#define TEX(s, uv) texture2D(s, uv)\n#define FRAG_OUT gl_FragColor\n" + FRAG
  };
}

function matMul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function matInv(m) {
  const o = new Float32Array(16);
  o[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  o[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  o[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  o[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  o[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  o[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  o[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  o[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  o[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  o[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  o[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  o[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  o[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  o[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  o[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  o[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  let det = m[0] * o[0] + m[1] * o[4] + m[2] * o[8] + m[3] * o[12];
  if (!det) return m;
  det = 1 / det;
  for (let i = 0; i < 16; i++) o[i] *= det;
  return o;
}

function quatYXZ(x, y, z) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3
  };
}

function qmul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function qrotate(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx)
  };
}

function deviceLook(alpha, beta, gamma) {
  const deg = Math.PI / 180;
  const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  let q = quatYXZ(beta * deg, alpha * deg, -gamma * deg);
  q = qmul(q, { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
  const half = -ang * deg / 2;
  q = qmul(q, { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) });
  const f = qrotate(q, { x: 0, y: 0, z: -1 });
  return { yaw: Math.atan2(-f.x, -f.z), pitch: Math.asin(clamp(f.y, -1, 1)) };
}

function isPow2(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

function closeSource(source) {
  if (source && typeof source.close === "function") source.close();
}

export function createViewerEngine({ canvas, dialRotor, onFrameDrawn, getScene, getSpinSpeed, onToast, onContextRestored, onVrChange }) {
  const view = { yaw: 0, pitch: 0, fov: HOME_FOV };
  const orient = { yaw: 0, roll: 0, flipX: 1, flipY: 1 };
  const opening = { yaw: 0, pitch: 0, fov: HOME_FOV };
  const motion = { on: false, baseSet: false, last: null, timer: 0, yawOffset: 0, pitchOffset: 0 };
  const held = new Set();
  const pointers = new Map();
  const box = { left: 0, top: 0, width: 0, height: 0 };

  let gl = null;
  let program = null;
  let uniforms = null;
  let isGL2 = false;
  let useSrgb = false;
  let aniso = null;
  let anisoMax = 1;
  let lost = false;
  let maxTex = 0;
  let cur = null;
  let prev = null;
  let fadeStart = 0;
  let kept = null;
  let inertia = { yaw: 0, pitch: 0, on: false };
  let raf = 0;
  let lastFrame = 0;
  let dirty = false;
  let active = true;
  let lowDpr = false;
  let dprTimer = 0;
  let stereo = false;
  let spinPaused = false;
  let bypassGrade = false;
  let xrSession = null;
  let xrRef = null;

  function measure() {
    box.width = canvas.clientWidth;
    box.height = canvas.clientHeight;
    box.left = canvas.offsetLeft || 0;
    box.top = canvas.offsetTop || 0;
  }

  function viewport() {
    if (!box.width) measure();
    return box;
  }

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { measure(); kick(); }).observe(canvas);
  } else {
    window.addEventListener("resize", () => { measure(); kick(); });
  }

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || "shader";
      gl.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  }

  function buildProgram(mode) {
    const src = shaderSources(mode);
    const vs = compile(gl.VERTEX_SHADER, src.vert);
    const fs = compile(gl.FRAGMENT_SHADER, src.frag);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p) || "link";
      gl.deleteProgram(p);
      throw new Error(log);
    }
    return p;
  }

  function ensureGL() {
    if (gl) return gl;
    if (lost) throw new Error("context-lost");
    const opts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
    const ctx = canvas.getContext("webgl2", opts) || canvas.getContext("webgl", opts);
    if (!ctx) throw new Error("no-webgl");
    gl = ctx;
    try {
      isGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
      useSrgb = isGL2 && "drawingBufferColorSpace" in gl;
      if (useSrgb) gl.drawingBufferColorSpace = "srgb";
      let mode = isGL2 ? 2 : 0;
      if (!isGL2 && gl.getExtension("OES_standard_derivatives") && gl.getExtension("EXT_shader_texture_lod")) mode = 1;
      try {
        program = buildProgram(mode);
      } catch (err) {
        if (mode !== 1) throw err;
        program = buildProgram(0);
      }
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      aniso = gl.getExtension("EXT_texture_filter_anisotropic");
      anisoMax = aniso ? Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1) : 1;
      const loc = (name) => gl.getUniformLocation(program, name);
      uniforms = {
        tex: loc("uTex"),
        prev: loc("uPrev"),
        res: loc("uRes"),
        offset: loc("uOffset"),
        texel: loc("uTexel"),
        clampU: loc("uClampU"),
        prevClampU: loc("uPrevClampU"),
        mix: loc("uMix"),
        fov: loc("uFov"),
        yaw: loc("uYaw"),
        pitch: loc("uPitch"),
        roll: loc("uRoll"),
        flip: loc("uFlip"),
        bright: loc("uBright"),
        contrast: loc("uContrast"),
        exposure: loc("uExposure"),
        highlights: loc("uHighlights"),
        shadows: loc("uShadows"),
        black: loc("uBlack"),
        saturation: loc("uSaturation"),
        warmth: loc("uWarmth"),
        sharpness: loc("uSharpness"),
        bypass: loc("uBypassGrade"),
        encode: loc("uEncode"),
        xr: loc("uXR"),
        inv: loc("uInvVP")
      };
      gl.uniform1i(uniforms.tex, 0);
      gl.uniform1i(uniforms.prev, 1);
    } catch (err) {
      gl = null;
      program = null;
      uniforms = null;
      throw err;
    }
    return gl;
  }

  function maxTextureSize() {
    if (!maxTex) {
      ensureGL();
      maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096, deviceTextureCap());
    }
    return maxTex;
  }

  function sizeOf(source) {
    return {
      w: Math.max(1, source.naturalWidth || source.width || 1),
      h: Math.max(1, source.naturalHeight || source.height || 1)
    };
  }

  // ImageBitmaps ignore UNPACK_FLIP_Y_WEBGL, so every source is uploaded
  // top-row-first and the shader samples v = 0 at the north pole.
  function fillTexture(source, w, h) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const put = (internal) => {
      gl.getError();
      if (source.tiles) {
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        if (gl.getError() !== gl.NO_ERROR) return false;
        const dw = w / source.cols;
        const dh = h / source.rows;
        source.tiles.forEach((tile, i) => {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, (i % source.cols) * dw, Math.floor(i / source.cols) * dh, gl.RGBA, gl.UNSIGNED_BYTE, tile);
        });
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, gl.RGBA, gl.UNSIGNED_BYTE, source);
      }
      return gl.getError() === gl.NO_ERROR;
    };
    if (useSrgb && put(gl.SRGB8_ALPHA8)) return true;
    if (!put(gl.RGBA)) throw new Error("That photo is too large for this device's graphics memory.");
    return false;
  }

  function applyParams(w, h) {
    const npot = !isGL2 && !(isPow2(w) && isPow2(h));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, npot ? gl.CLAMP_TO_EDGE : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    if (npot) return 0.5 / w;
    gl.getError();
    gl.generateMipmap(gl.TEXTURE_2D);
    if (gl.getError() === gl.NO_ERROR) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, anisoMax);
    }
    return 0;
  }

  function keep(source) {
    if (kept && kept !== source) closeSource(kept);
    kept = source || null;
  }

  function dropPrev() {
    if (prev && gl && !lost) gl.deleteTexture(prev.tex);
    prev = null;
  }

  function release() {
    dropPrev();
    if (cur && gl && !lost) gl.deleteTexture(cur.tex);
    cur = null;
    keep(null);
  }

  // The engine owns `source` afterwards; it is kept for context restore and
  // closed when replaced. `source` may be a tile set { tiles, cols, rows, width, height }.
  function uploadTexture(source, opts = {}) {
    if (!source) return;
    active = true;
    if (lost) { keep(source); return; }
    ensureGL();
    const { w, h } = sizeOf(source);
    const fade = !!opts.fade && !!cur && !prefersReducedMotion();
    const created = fade || !cur;
    const texture = created ? gl.createTexture() : cur.tex;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    let linear;
    try {
      linear = fillTexture(source, w, h);
    } catch (err) {
      if (created) gl.deleteTexture(texture);
      closeSource(source);
      throw err;
    }
    const clampU = applyParams(w, h);
    if (fade) {
      dropPrev();
      prev = cur;
      fadeStart = performance.now();
    }
    cur = { tex: texture, w, h, clampU, linear };
    keep(source);
    kick();
  }

  function resize() {
    const dpr = lowDpr ? 1 : Math.min(2, window.devicePixelRatio || 1);
    const vp = viewport();
    const w = Math.max(1, Math.round(vp.width * dpr));
    const h = Math.max(1, Math.round(vp.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      dirty = true;
    }
  }

  function fadeMix(now) {
    if (!prev) return 1;
    const t = clamp((now - fadeStart) / FADE_MS, 0, 1);
    if (t >= 1) dropPrev();
    return t;
  }

  function bindTextures(mix) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prev ? prev.tex : null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cur.tex);
    gl.uniform1f(uniforms.mix, mix);
    gl.uniform1f(uniforms.clampU, cur.clampU);
    gl.uniform1f(uniforms.prevClampU, prev ? prev.clampU : 0);
  }

  function paintUniforms() {
    const scene = getScene ? getScene() : null;
    const grade = gradeOf(scene);
    gl.uniform2f(uniforms.texel, 1 / Math.max(1, cur.w), 1 / Math.max(1, cur.h));
    gl.uniform1f(uniforms.fov, view.fov * Math.PI / 180);
    gl.uniform1f(uniforms.pitch, view.pitch);
    gl.uniform1f(uniforms.roll, orient.roll);
    gl.uniform2f(uniforms.flip, orient.flipX, orient.flipY);
    gl.uniform1f(uniforms.bright, scene && scene.bright ? scene.bright : 0);
    gl.uniform1f(uniforms.contrast, scene && scene.contrast != null ? scene.contrast : 1);
    gl.uniform1f(uniforms.exposure, grade.exposure);
    gl.uniform1f(uniforms.highlights, grade.highlights);
    gl.uniform1f(uniforms.shadows, grade.shadows);
    gl.uniform1f(uniforms.black, grade.black);
    gl.uniform1f(uniforms.saturation, grade.saturation);
    gl.uniform1f(uniforms.warmth, grade.warmth);
    gl.uniform1f(uniforms.sharpness, grade.sharpness);
    gl.uniform1f(uniforms.bypass, bypassGrade ? 1 : 0);
    gl.uniform1f(uniforms.encode, cur.linear ? 1 : 0);
  }

  function draw(now) {
    if (!gl || !cur || lost) return;
    resize();
    gl.useProgram(program);
    bindTextures(fadeMix(now));
    paintUniforms();
    gl.uniform1f(uniforms.xr, 0);
    if (stereo) {
      const half = Math.floor(canvas.width / 2);
      gl.viewport(0, 0, half, canvas.height);
      gl.uniform2f(uniforms.offset, 0, 0);
      gl.uniform2f(uniforms.res, half, canvas.height);
      gl.uniform1f(uniforms.yaw, view.yaw + orient.yaw - 0.045);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.viewport(half, 0, canvas.width - half, canvas.height);
      gl.uniform2f(uniforms.offset, half, 0);
      gl.uniform2f(uniforms.res, canvas.width - half, canvas.height);
      gl.uniform1f(uniforms.yaw, view.yaw + orient.yaw + 0.045);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.offset, 0, 0);
      gl.uniform2f(uniforms.res, canvas.width, canvas.height);
      gl.uniform1f(uniforms.yaw, view.yaw + orient.yaw);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (dialRotor) dialRotor.style.transform = `rotate(${(view.yaw * 180 / Math.PI).toFixed(1)}deg)`;
    if (onFrameDrawn) onFrameDrawn({ stereo, yaw: view.yaw, viewport: box });
    dirty = false;
  }

  function activeSpin() {
    if (spinPaused || prefersReducedMotion()) return 0;
    return getSpinSpeed ? Number(getSpinSpeed()) || 0 : 0;
  }

  function needsFrame() {
    return active && !lost && (dirty || !!prev || inertia.on || held.size > 0 || motion.on || activeSpin() !== 0);
  }

  function markMoving() {
    if ((window.devicePixelRatio || 1) <= 1) return;
    if (!lowDpr) { lowDpr = true; dirty = true; }
    clearTimeout(dprTimer);
    dprTimer = setTimeout(() => { lowDpr = false; kick(); }, 200);
  }

  function shift(dyaw, dpitch) {
    if (motion.on && motion.baseSet) {
      motion.yawOffset -= dyaw;
      motion.pitchOffset -= dpitch;
    }
    view.yaw += dyaw;
    view.pitch = clamp(view.pitch + dpitch, -MAX_PITCH, MAX_PITCH);
    dirty = true;
  }

  function nudge(dyaw, dpitch) {
    shift(dyaw, dpitch);
    markMoving();
  }

  function step(dt) {
    let dyaw = 0;
    let dpitch = 0;
    if (held.has("left")) dyaw += 1;
    if (held.has("right")) dyaw -= 1;
    if (held.has("up")) dpitch += 1;
    if (held.has("down")) dpitch -= 1;
    if (dyaw || dpitch) {
      const speed = (held.has("shift") ? 1.45 : 0.62) * (view.fov / HOME_FOV);
      nudge(dyaw * speed * dt, dpitch * speed * dt);
    }
    if (inertia.on) {
      nudge(inertia.yaw * dt, inertia.pitch * dt);
      const decay = Math.exp(-3.4 * dt);
      inertia.yaw *= decay;
      inertia.pitch *= decay;
      if (Math.hypot(inertia.yaw, inertia.pitch) < 0.02) inertia.on = false;
    }
    const spin = activeSpin();
    if (spin && !pointers.size && !held.size) shift(spin * dt, 0);
  }

  function frame(now) {
    raf = 0;
    if (!active || lost) return;
    const dt = Math.min(0.05, lastFrame ? (now - lastFrame) / 1000 : 0.016);
    lastFrame = now;
    step(dt);
    if (dirty || prev) draw(now);
    if (needsFrame()) raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (!active || lost) return;
    dirty = true;
    if (!raf) {
      lastFrame = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    dirty = false;
  }

  function setActive(on) {
    active = !!on;
    if (active) { kick(); return; }
    stopLoop();
    inertia.on = false;
    held.clear();
    clearTimeout(dprTimer);
    lowDpr = false;
    release();
  }

  function isInteracting() {
    return pointers.size > 0 || inertia.on || held.size > 0;
  }

  function whenSettled(maxMs = 1500) {
    const start = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        if (!isInteracting() || performance.now() - start >= maxMs) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  function angAt(clientX, clientY, fov) {
    const vp = viewport();
    const ndcX = ((clientX - vp.left) / Math.max(1, vp.width)) * 2 - 1;
    const ndcY = 1 - ((clientY - vp.top) / Math.max(1, vp.height)) * 2;
    const aspect = vp.width / Math.max(1, vp.height);
    const t = Math.tan((fov * Math.PI / 180) * 0.5);
    return { x: Math.atan(ndcX * aspect * t), y: Math.atan(ndcY * t) };
  }

  function zoomToward(clientX, clientY, nextFov) {
    const applied = clamp(nextFov, MIN_FOV, MAX_FOV);
    const before = angAt(clientX, clientY, view.fov);
    const after = angAt(clientX, clientY, applied);
    inertia.on = false;
    view.fov = applied;
    nudge(after.x - before.x, before.y - after.y);
    kick();
  }

  function resetView() {
    inertia.on = false;
    if (motion.on && motion.last) {
      motion.yawOffset = motion.last.yaw;
      motion.pitchOffset = motion.last.pitch;
      motion.baseSet = true;
    }
    view.yaw = opening.yaw;
    view.pitch = opening.pitch;
    view.fov = opening.fov;
    kick();
  }

  function projectUv(u, v, vp = viewport()) {
    const TAU = Math.PI * 2;
    const lon = (u - 0.75) * TAU;
    const lat = (v - 0.5) * Math.PI;
    let x = Math.cos(lat) * Math.cos(lon) * orient.flipX;
    let y = Math.sin(lat) * orient.flipY;
    const z = Math.cos(lat) * Math.sin(lon);
    const yaw = view.yaw + orient.yaw;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const y2 = y * cp + z1 * sp;
    const z2 = -y * sp + z1 * cp;
    const cr = Math.cos(orient.roll), sr = Math.sin(orient.roll);
    const x3 = x1 * cr + y2 * sr;
    const y3 = -x1 * sr + y2 * cr;
    if (z2 >= -0.05) return null;
    const aspect = vp.width / Math.max(1, vp.height);
    const t = Math.tan((view.fov * Math.PI / 180) * 0.5);
    const ndcX = x3 / (-z2) / (aspect * t);
    const ndcY = y3 / (-z2) / t;
    if (ndcX < -1.2 || ndcX > 1.2 || ndcY < -1.2 || ndcY > 1.2) return null;
    return {
      x: (ndcX * 0.5 + 0.5) * vp.width,
      y: (0.5 - ndcY * 0.5) * vp.height
    };
  }

  function uvAt(clientX, clientY) {
    const vp = viewport();
    const ndcX = ((clientX - vp.left) / Math.max(1, vp.width)) * 2 - 1;
    const ndcY = 1 - ((clientY - vp.top) / Math.max(1, vp.height)) * 2;
    const aspect = vp.width / Math.max(1, vp.height);
    const t = Math.tan((view.fov * Math.PI / 180) * 0.5);
    let x = ndcX * aspect * t, y = ndcY * t, z = -1;
    const len = Math.hypot(x, y, z);
    x /= len; y /= len; z /= len;
    const cr = Math.cos(orient.roll), sr = Math.sin(orient.roll);
    const x1 = x * cr - y * sr;
    const y1 = x * sr + y * cr;
    const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    let y2 = y1 * cp - z * sp;
    const z2 = y1 * sp + z * cp;
    const yaw = view.yaw + orient.yaw;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let x3 = x1 * cy + z2 * sy;
    const z3 = -x1 * sy + z2 * cy;
    x3 *= orient.flipX;
    y2 *= orient.flipY;
    const lon = Math.atan2(z3, x3);
    const lat = Math.asin(clamp(y2, -1, 1));
    return {
      u: ((lon / (Math.PI * 2) + 0.75) % 1 + 1) % 1,
      v: lat / Math.PI + 0.5
    };
  }

  function onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    const look = deviceLook(e.alpha || 0, e.beta, e.gamma);
    motion.last = look;
    if (!motion.baseSet) {
      motion.yawOffset = look.yaw - view.yaw;
      motion.pitchOffset = look.pitch - view.pitch;
      motion.baseSet = true;
      clearTimeout(motion.timer);
      return;
    }
    view.yaw = look.yaw - motion.yawOffset;
    view.pitch = clamp(look.pitch - motion.pitchOffset, -MAX_PITCH, MAX_PITCH);
    markMoving();
    kick();
  }

  async function toggleMotion(btn) {
    if (motion.on) {
      motion.on = false;
      motion.baseSet = false;
      window.removeEventListener("deviceorientation", onOrientation);
      if (btn) btn.setAttribute("aria-pressed", "false");
      clearTimeout(motion.timer);
      return false;
    }
    try {
      const Req = window.DeviceOrientationEvent;
      if (Req && typeof Req.requestPermission === "function") {
        const state = await Req.requestPermission();
        if (state !== "granted") {
          onToast && onToast("Gyroscope permission was denied.");
          return false;
        }
      }
    } catch (err) {
      onToast && onToast("Gyroscope isn't available on this device.");
      return false;
    }
    motion.on = true;
    motion.baseSet = false;
    if (btn) btn.setAttribute("aria-pressed", "true");
    window.addEventListener("deviceorientation", onOrientation);
    clearTimeout(motion.timer);
    motion.timer = setTimeout(() => {
      if (motion.on && !motion.baseSet) {
        motion.on = false;
        if (btn) btn.setAttribute("aria-pressed", "false");
        window.removeEventListener("deviceorientation", onOrientation);
        onToast && onToast("No gyroscope sensor detected.");
      }
    }, 1800);
    kick();
    return true;
  }

  function stopMotion(btn) {
    if (!motion.on) return;
    motion.on = false;
    motion.baseSet = false;
    window.removeEventListener("deviceorientation", onOrientation);
    if (btn) btn.setAttribute("aria-pressed", "false");
    clearTimeout(motion.timer);
  }

  function onXRFrame(time, xrFrame) {
    const session = xrSession;
    if (!session) return;
    session.requestAnimationFrame(onXRFrame);
    const pose = xrFrame.getViewerPose(xrRef);
    const layer = session.renderState.baseLayer;
    if (!pose || !layer || !cur || !gl || lost) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.useProgram(program);
    bindTextures(fadeMix(time));
    paintUniforms();
    gl.uniform1f(uniforms.xr, 1);
    gl.uniform1f(uniforms.yaw, orient.yaw);
    for (const xrView of pose.views) {
      const vp = layer.getViewport(xrView);
      const rot = Float32Array.from(xrView.transform.matrix);
      rot[12] = 0; rot[13] = 0; rot[14] = 0;
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      gl.uniform2f(uniforms.offset, vp.x, vp.y);
      gl.uniform2f(uniforms.res, vp.width, vp.height);
      gl.uniformMatrix4fv(uniforms.inv, false, matMul(rot, matInv(xrView.projectionMatrix)));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.uniform1f(uniforms.xr, 0);
  }

  async function toggleVR() {
    if (xrSession) {
      await xrSession.end().catch(() => {});
      return;
    }
    if (stereo) {
      stereo = false;
      onVrChange && onVrChange(false);
      kick();
      onToast && onToast("Exited VR mode");
      return;
    }
    if (navigator.xr && gl) {
      try {
        if (await navigator.xr.isSessionSupported("immersive-vr")) {
          if (gl.makeXRCompatible) await gl.makeXRCompatible();
          const session = await navigator.xr.requestSession("immersive-vr");
          await session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
          xrRef = await session.requestReferenceSpace("local");
          xrSession = session;
          onVrChange && onVrChange(true);
          session.addEventListener("end", () => {
            xrSession = null;
            xrRef = null;
            onVrChange && onVrChange(false);
            kick();
          });
          session.requestAnimationFrame(onXRFrame);
          onToast && onToast("WebXR Headset VR active");
          return;
        }
      } catch (err) {
        /* Fallback to stereo split-screen VR */
      }
    }
    stereo = true;
    onVrChange && onVrChange(true);
    kick();
    onToast && onToast("Split-screen VR mode active (Press Esc to exit)");
  }

  function exitVR() {
    if (xrSession) xrSession.end().catch(() => {});
    if (stereo) {
      stereo = false;
      onVrChange && onVrChange(false);
      kick();
    }
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lost = true;
    stopLoop();
    gl = null; program = null; uniforms = null; cur = null; prev = null;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    lost = false;
    gl = null;
    let restored = false;
    if (kept && active) {
      const source = kept;
      kept = null;
      try {
        uploadTexture(source);
        restored = true;
      } catch (err) {
        restored = false;
      }
    }
    onContextRestored && onContextRestored(restored);
  });

  return {
    view, orient, opening, pointers, held,
    ensureGL, maxTextureSize, uploadTexture, resize() { measure(); resize(); }, kick, nudge,
    angAt, zoomToward, resetView, projectUv, uvAt, viewport,
    toggleMotion, stopMotion, toggleVR, exitVR,
    setActive, isInteracting, whenSettled,
    setInertia(v) { inertia = v; },
    stopInertia() { inertia.on = false; },
    isLinear() { return !!(cur && cur.linear); },
    isVR() { return stereo || !!xrSession; },
    setBypassGrade(v) { bypassGrade = !!v; kick(); },
    setSpinPaused(v) { spinPaused = !!v; if (!spinPaused) kick(); },
    isSpinPaused() { return spinPaused; }
  };
}

/**
 * Generates two distinct 2048x1024 equirectangular 360° architectural sample scenes
 * so visitors can try a real multi-scene interactive tour with hotspots immediately.
 */
export function paintSampleScene(variant = 0) {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 1024;
  const g = c.getContext("2d");
  const w = c.width, h = c.height;

  const isTerrace = variant === 1;
  const sky = g.createLinearGradient(0, 0, 0, h * 0.52);
  if (isTerrace) {
    sky.addColorStop(0, "#243b55");
    sky.addColorStop(0.5, "#6c8aa6");
    sky.addColorStop(0.85, "#e6b89c");
    sky.addColorStop(1, "#f7dcc4");
  } else {
    sky.addColorStop(0, "#7fa2b8");
    sky.addColorStop(0.45, "#d8cec0");
    sky.addColorStop(1, "#f7efe6");
  }
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h * 0.52);

  const ground = g.createLinearGradient(0, h * 0.5, 0, h);
  if (isTerrace) {
    ground.addColorStop(0, "#d8c3ad");
    ground.addColorStop(0.28, "#8c725e");
    ground.addColorStop(1, "#3f332b");
  } else {
    ground.addColorStop(0, "#efe2d1");
    ground.addColorStop(0.24, "#d3bba2");
    ground.addColorStop(1, "#746050");
  }
  g.fillStyle = ground;
  g.fillRect(0, h * 0.5, w, h * 0.5);

  const haze = g.createLinearGradient(0, h * 0.4, 0, h * 0.6);
  haze.addColorStop(0, "rgba(255, 246, 235, 0)");
  haze.addColorStop(0.5, isTerrace ? "rgba(247, 214, 184, 0.55)" : "rgba(255, 248, 240, 0.6)");
  haze.addColorStop(1, "rgba(255, 246, 235, 0)");
  g.fillStyle = haze;
  g.fillRect(0, h * 0.4, w, h * 0.2);

  // Sun / golden hour glow
  const sunX = isTerrace ? w * 0.34 : w * 0.6;
  const sunY = isTerrace ? h * 0.42 : h * 0.33;
  const glow = g.createRadialGradient(sunX, sunY, 4, sunX, sunY, w * 0.17);
  glow.addColorStop(0, isTerrace ? "rgba(255, 212, 160, 0.96)" : "rgba(255, 238, 200, 0.95)");
  glow.addColorStop(0.3, "rgba(244, 184, 118, 0.36)");
  glow.addColorStop(1, "rgba(244, 184, 118, 0)");
  g.fillStyle = glow;
  g.beginPath();
  g.arc(sunX, sunY, w * 0.17, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff6e6";
  g.beginPath();
  g.arc(sunX, sunY, w * 0.017, 0, Math.PI * 2);
  g.fill();

  // Floor tile grid lines for spatial depth cues
  g.strokeStyle = isTerrace ? "rgba(255, 240, 224, 0.12)" : "rgba(60, 45, 34, 0.09)";
  g.lineWidth = 2;
  for (let i = 1; i <= 6; i++) {
    const y = h * 0.5 + Math.pow(i / 6, 1.7) * h * 0.45;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  for (let i = 0; i < 16; i++) {
    const x = (i / 16) * w;
    g.beginPath(); g.moveTo(x, h * 0.5); g.lineTo(x, h); g.stroke();
  }

  function arch(cx, light, shade, scale = 1) {
    const bw = w * 0.032 * scale;
    const peak = h * (0.35 + (1 - scale) * 0.06);
    const foot = h * 0.5;
    const fill = g.createLinearGradient(cx - bw, 0, cx + bw, 0);
    fill.addColorStop(0, shade);
    fill.addColorStop(0.45, light);
    fill.addColorStop(1, shade);
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(cx - bw / 2, foot);
    g.lineTo(cx - bw / 2, peak + bw / 2);
    g.arc(cx, peak + bw / 2, bw / 2, Math.PI, 0);
    g.lineTo(cx + bw / 2, foot);
    g.closePath();
    g.fill();
    g.fillStyle = "rgba(32, 24, 18, 0.14)";
    g.beginPath();
    g.ellipse(cx, foot + 5, bw * 0.72, 9, 0, 0, Math.PI * 2);
    g.fill();
  }

  if (isTerrace) {
    arch(w * 0.5, "#e6d8c8", "#a89582", 1.15);
    arch(w * 0.68, "#4c6b78", "#2b3e47", 0.92);
    arch(w * 0.22, "#c87f64", "#7e4635", 0.95);
    arch(w * 0.86, "#d9c5af", "#8e7966", 0.85);
  } else {
    arch(w * 0.5, "#f7f2ea", "#dfd1bf", 1.1);
    arch(w * 0.73, "#c98470", "#8d4e40", 1.0);
    arch(w * 0.27, "#3c4658", "#232a36", 1.0);
    arch(w * 0.1, "#dfd3c4", "#a99a89", 0.82);
  }
  return c;
}

export function paintSampleFloorPlan() {
  const c = document.createElement("canvas");
  c.width = 960;
  c.height = 600;
  const g = c.getContext("2d");
  g.fillStyle = "#f4ede3";
  g.fillRect(0, 0, 960, 600);
  g.strokeStyle = "#2b2622";
  g.lineWidth = 6;
  g.strokeRect(80, 90, 440, 420);
  g.strokeRect(520, 140, 360, 320);
  g.fillStyle = "#ebe0d0";
  g.fillRect(83, 93, 434, 414);
  g.fillStyle = "#e3d6c4";
  g.fillRect(523, 143, 354, 314);
  // Doorway gap
  g.fillStyle = "#ebe0d0";
  g.fillRect(514, 260, 12, 80);
  g.fillStyle = "#5c534b";
  g.font = "600 24px -apple-system, BlinkMacSystemFont, sans-serif";
  g.fillText("SUNLIT ATRIUM", 200, 150);
  g.fillText("TERRACE LOUNGE", 595, 200);
  g.font = "500 15px -apple-system, BlinkMacSystemFont, sans-serif";
  g.fillStyle = "#7c736a";
  g.fillText("Sample Floor Plan · Click pins to jump between 360° scenes", 240, 560);
  return c.toDataURL("image/jpeg", 0.88);
}
