/*!
 * NaveDither — vanilla WebGL port of app/src/components/Dither.tsx
 * ---------------------------------------------------------------------------
 * fbm Perlin water -> ordered Bayer 8x8 dither, in ONE fragment pass (the wave
 * value is evaluated once per pixel block, then quantised). No Three.js, no
 * postprocessing, no bundler. Exposes a single global: `NaveDither`.
 *
 * USAGE
 *   <canvas id="sea"></canvas>
 *   <script src="_shared/dither.js"></script>
 *   <script>
 *     var sea = NaveDither.mount('#sea', { sceneMode: 'ocean', colorNum: 5, pixelSize: 2 });
 *     sea.set({ pixelSize: 6, colorNum: 2 });                 // snap
 *     sea.set({ pixelSize: 2, colorNum: 5 }, { lerp: 0.06 }); // ease toward target
 *     sea.set({ paletteA: NaveDither.hex('#0B1220'), paletteB: NaveDither.hex('#F7F5F0') });
 *     sea.pause(); sea.resume(); sea.destroy();
 *   </script>
 *
 * mount(target, options) — target is a <canvas>, a selector, or any container
 * element (a 100%x100% canvas is created inside). Returns an instance with:
 *   set(values, { lerp })  live-update any option below (lerp = per-frame
 *                          factor 0..1, normalised to 60fps; omit to snap)
 *   get(key)               current (possibly mid-lerp) value
 *   pause() / resume()     stop / start the rAF loop
 *   destroy()              remove listeners, lose the GL context
 *   canvas, gl, time, options, supported (false if WebGL unavailable)
 *
 * OPTIONS (all live-settable via set(); defaults in brackets)
 *   Behaviour (JS-side, not uniforms)
 *     timeScale      [1]        multiplies dt; 0 freezes the water
 *     reducedMotion  ['auto']   true | false | 'auto' (prefers-reduced-motion).
 *                               True freezes time + boat physics; still re-renders on set()
 *     autoWind       [true]     ocean mode: boat drifts with pointer-X wind (port of Dither.tsx).
 *                               Set false to drive boatX / sailLean / boatBob yourself
 *     trackPointer   [true]     window pointermove -> `pointer` uniform (canvas px) + wind
 *     dpr            [1]        device pixel ratio for the backing store (1 recommended)
 *     paused         [false]    start paused (same as calling pause())
 *     onFrame        [null]     fn(instance, dt, time) called every frame (before render)
 *   Noise
 *     waveSpeed      [0.08]     time multiplier inside pattern()
 *     waveFrequency  [3]        fbm lacunarity
 *     waveAmplitude  [0.3]      fbm gain per octave
 *     scroll         [0]        generic 0..1; shifts noise space by scroll*scrollParallax
 *     scrollParallax [0]        how far `scroll` pans the water vertically (uv units)
 *   Dither
 *     pixelSize      [2]        block size in canvas px (1..12 sensible)
 *     colorNum       [5]        quantisation levels (2..8)
 *     gain           [0.86]     pre-dither multiplier (== waveColor brightness in Dither.tsx)
 *     bias           [0.2]      subtracted before quantisation (Dither.tsx: 0.2)
 *     paletteA       [[0,0,0]]  RGB 0..1 for level 0  (final = mix(paletteA, paletteB, level))
 *     paletteB       [[1,1,1]]  RGB 0..1 for level 1
 *   Scene
 *     sceneMode      ['ocean']  'waves' | 'ocean' | 'isolines'  (or 0 | 1 | 2)
 *     waterLine      [-0.16]    ocean horizon in uv (-0.5 bottom .. 0.5 top)
 *     boatX          [0]        boat x in aspect-corrected uv (±0.62 typical)
 *     sailLean       [0]        -1..1, sail shears toward wind
 *     boatBob        [0]        vertical bob offset (uv)
 *     boatOpacity    [1]        0 hides the boat
 *     isoLevels      [6]        isolines: number of stepped bands
 *     isoLineWidth   [0.06]     isolines: band-fraction thickness of contour lines
 *     isoLineValue   [0]        isolines: value painted on contour lines (0 = paletteA)
 *   Pointer dent (ripple)
 *     pointer        [offscreen] [x, y] in canvas px, y down (CSS coords * dpr)
 *     mouseRadius    [0]        dent radius in uv; 0 disables
 *     mouseStrength  [0.5]      how much the dent lowers the value
 *   Light + beam
 *     lightAngle     [0]        radians; directional shading from the fbm gradient
 *     lightStrength  [0]        0 disables (keep <= 0.5)
 *     beamOrigin     [[0.5,0.5]] normalised canvas coords (0..1, y down)
 *     beamAngle      [0]        radians, 0 = +x, counter-clockwise
 *     beamWidth      [0.5]      full wedge angle in radians
 *     beamStrength   [0]        value added inside the wedge; 0 disables
 *     beamReach      [1.5]      distance (uv units) at which the beam fades out
 *
 * Coordinates: shader uv = (frag/resolution - 0.5), x scaled by aspect, y UP
 * (GL convention; waterLine -0.16 is below centre). `pointer` and `beamOrigin`
 * are given in CSS-style y-DOWN coordinates and flipped inside the shader.
 */
(function (root) {
  'use strict';

  var VERT =
    'attribute vec2 a_pos;\n' +
    'void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }';

  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2  resolution;',
    'uniform float time;',
    'uniform float waveSpeed, waveFrequency, waveAmplitude;',
    'uniform float gain, bias, pixelSize, colorNum;',
    'uniform vec3  paletteA, paletteB;',
    'uniform float scroll, scrollParallax;',
    'uniform vec2  pointer;',
    'uniform float mouseRadius, mouseStrength;',
    'uniform int   sceneMode;',
    'uniform float waterLine, boatX, sailLean, boatBob, boatOpacity;',
    'uniform float lightAngle, lightStrength;',
    'uniform vec2  beamOrigin;',
    'uniform float beamAngle, beamWidth, beamStrength, beamReach;',
    'uniform float isoLevels, isoLineWidth, isoLineValue;',
    'const float PI = 3.14159265359;',
    '',
    '// --- Perlin noise (verbatim from Dither.tsx) -------------------------',
    'vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }',
    'vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }',
    'vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }',
    'vec2 fade(vec2 t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }',
    'float cnoise(vec2 P){',
    '  vec4 Pi = floor(P.xyxy) + vec4(0.0,0.0,1.0,1.0);',
    '  vec4 Pf = fract(P.xyxy) - vec4(0.0,0.0,1.0,1.0);',
    '  Pi = mod289(Pi);',
    '  vec4 ix = Pi.xzxz; vec4 iy = Pi.yyww; vec4 fx = Pf.xzxz; vec4 fy = Pf.yyww;',
    '  vec4 i = permute(permute(ix) + iy);',
    '  vec4 gx = fract(i * (1.0/41.0)) * 2.0 - 1.0;',
    '  vec4 gy = abs(gx) - 0.5;',
    '  vec4 tx = floor(gx + 0.5);',
    '  gx = gx - tx;',
    '  vec2 g00 = vec2(gx.x, gy.x); vec2 g10 = vec2(gx.y, gy.y);',
    '  vec2 g01 = vec2(gx.z, gy.z); vec2 g11 = vec2(gx.w, gy.w);',
    '  vec4 norm = taylorInvSqrt(vec4(dot(g00,g00), dot(g01,g01), dot(g10,g10), dot(g11,g11)));',
    '  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;',
    '  float n00 = dot(g00, vec2(fx.x, fy.x)); float n10 = dot(g10, vec2(fx.y, fy.y));',
    '  float n01 = dot(g01, vec2(fx.z, fy.z)); float n11 = dot(g11, vec2(fx.w, fy.w));',
    '  vec2 fade_xy = fade(Pf.xy);',
    '  vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), fade_xy.x);',
    '  return 2.3 * mix(n_x.x, n_x.y, fade_xy.y);',
    '}',
    'const int OCTAVES = 4;',
    'float fbm(vec2 p){',
    '  float value = 0.0; float amp = 1.0; float freq = waveFrequency;',
    '  for (int i = 0; i < OCTAVES; i++) { value += amp * abs(cnoise(p)); p *= freq; amp *= waveAmplitude; }',
    '  return value;',
    '}',
    'float pattern(vec2 p){ return fbm(p + fbm(p - time * waveSpeed)); }',
    '',
    '// --- SDFs for the boat (verbatim from Dither.tsx) ---------------------',
    'float sdBox(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }',
    'float sdEllipse(vec2 p, vec2 r){ return (length(p / r) - 1.0) * min(r.x, r.y); }',
    'float sdTriangle(vec2 p, vec2 a, vec2 b, vec2 c){',
    '  vec2 e0 = b - a, e1 = c - b, e2 = a - c;',
    '  vec2 v0 = p - a, v1 = p - b, v2 = p - c;',
    '  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);',
    '  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);',
    '  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);',
    '  float s = sign(e0.x * e2.y - e0.y * e2.x);',
    '  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),',
    '                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),',
    '                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));',
    '  return -sqrt(d.x) * sign(d.y);',
    '}',
    '',
    '// --- Bayer 8x8, procedural. bayer8(vec2(y,x)) reproduces the exact',
    '//     bayerMatrix8x8[y*8+x] table in Dither.tsx (verified for all 64 cells).',
    'float bayer2(vec2 a){ a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }',
    'float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }',
    'float bayer8(vec2 a){ return bayer4(0.5 * a) * 0.25 + bayer2(a); }',
    '',
    'void main(){',
    '  // One wave sample per pixelSize block (replaces the pixelate + dither passes).',
    '  vec2 block = floor(gl_FragCoord.xy / pixelSize);',
    '  vec2 sc = (block + 0.5) * pixelSize;',
    '  float aspect = resolution.x / resolution.y;',
    '  vec2 uv = sc / resolution - 0.5;',
    '  uv.x *= aspect;',
    '  vec2 nuv = uv + vec2(0.0, scroll * scrollParallax);',
    '  float f = pattern(nuv);',
    '',
    '  // Pointer dent (Dither.tsx wave-dent), any mode when mouseRadius > 0.',
    '  if (mouseRadius > 0.0) {',
    '    vec2 m = (pointer / resolution - 0.5) * vec2(1.0, -1.0);',
    '    m.x *= aspect;',
    '    float dist = length(uv - m);',
    '    f -= mouseStrength * (1.0 - smoothstep(0.0, mouseRadius, dist));',
    '  }',
    '',
    '  // Directional light: shade by the fbm gradient (two extra samples).',
    '  if (lightStrength > 0.0) {',
    '    float e = 0.012;',
    '    vec2 g = vec2(pattern(nuv + vec2(e, 0.0)) - f, pattern(nuv + vec2(0.0, e)) - f) / e;',
    '    vec2 L = vec2(cos(lightAngle), sin(lightAngle));',
    '    float gm = length(g);',
    '    if (gm > 1e-4) f += lightStrength * dot(g / gm, L) * min(gm * 0.15, 1.0);',
    '  }',
    '',
    '  float v = f;',
    '  float boatMask = 0.0;',
    '  if (sceneMode == 1) {',
    '    // Ocean: quiet sky above the waterline, lively water below.',
    '    float waterMask = 1.0 - smoothstep(waterLine - 0.10, waterLine + 0.14, uv.y);',
    '    float skyF = f * 0.14 + 0.88;',
    '    float waterF = clamp(f * 1.05 + 0.10 * step(0.50, f), 0.0, 1.0);',
    '    v = mix(skyF, waterF, waterMask);',
    '    // Silhouette sailboat riding the waterline.',
    '    vec2 local = uv - vec2(boatX, waterLine + boatBob - 0.015);',
    '    float hull = sdEllipse(local - vec2(0.0, -0.016), vec2(0.11, 0.028));',
    '    float mast = sdBox(local - vec2(0.0, 0.06), vec2(0.006, 0.075));',
    '    float lean = clamp(sailLean, -1.0, 1.0) * 0.07;',
    '    vec2 sailA = vec2(0.005, 0.012);',
    '    vec2 sailB = vec2(0.005, 0.125);',
    '    vec2 sailC = abs(lean) < 0.01 ? vec2(0.095, 0.06) : vec2(0.005 + 0.085 * sign(lean) + lean * 1.1, 0.06);',
    '    float sail = sdTriangle(local, sailA, sailB, sailC);',
    '    float boatSkyFade = 1.0 - smoothstep(waterLine + 0.14, waterLine + 0.24, uv.y);',
    '    boatMask = (1.0 - smoothstep(0.0, 0.005, min(min(hull, mast), sail))) * boatSkyFade * boatOpacity;',
    '  } else if (sceneMode == 2) {',
    '    // Isolines: stepped bathymetric bands with thin contour lines at the edges.',
    '    float n = max(isoLevels, 1.0);',
    '    float s = f * n;',
    '    float band = floor(s) / n;',
    '    float fr = fract(s);',
    '    float edge = min(fr, 1.0 - fr);',
    '    float line = 1.0 - smoothstep(0.0, max(isoLineWidth, 1e-4), edge);',
    '    v = mix(band, isoLineValue, line);',
    '  }',
    '',
    '  // Rotating beam: wedge of brightness from beamOrigin (lighthouse).',
    '  if (beamStrength > 0.0) {',
    '    vec2 o = (beamOrigin - 0.5) * vec2(1.0, -1.0);',
    '    o.x *= aspect;',
    '    vec2 d = uv - o;',
    '    float dist = length(d);',
    '    float diff = abs(mod(atan(d.y, d.x) - beamAngle + PI, 2.0 * PI) - PI);',
    '    float hw = beamWidth * 0.5;',
    '    float wedge = 1.0 - smoothstep(hw * 0.55, hw, diff);',
    '    float reach = 1.0 - smoothstep(0.0, max(beamReach, 1e-3), dist);',
    '    v += beamStrength * wedge * reach;',
    '  }',
    '',
    '  // Boat is a dark silhouette (Dither.tsx: waveColor * 0.12), applied after the beam.',
    '  v = mix(v, 0.12, boatMask);',
    '',
    '  // Ordered dither (Dither.tsx RetroEffect): threshold - 0.25, bias, quantise.',
    '  float thr = bayer8(mod(vec2(block.y, block.x), 8.0)) - 0.25;',
    '  float levels = max(colorNum, 2.0) - 1.0;',
    '  float c = v * gain + thr / levels;',
    '  c = clamp(c - bias, 0.0, 1.0);',
    '  float q = floor(c * levels + 0.5) / levels;',
    '  gl_FragColor = vec4(mix(paletteA, paletteB, q), 1.0);',
    '}'
  ].join('\n');

  // ---------------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------------
  var DEFAULTS = {
    timeScale: 1, reducedMotion: 'auto', autoWind: true, trackPointer: true, dpr: 1, onFrame: null, paused: false,
    waveSpeed: 0.08, waveFrequency: 3, waveAmplitude: 0.3,
    scroll: 0, scrollParallax: 0,
    pixelSize: 2, colorNum: 5, gain: 0.86, bias: 0.2,
    paletteA: [0, 0, 0], paletteB: [1, 1, 1],
    sceneMode: 1, waterLine: -0.16, boatX: 0, sailLean: 0, boatBob: 0, boatOpacity: 1,
    isoLevels: 6, isoLineWidth: 0.06, isoLineValue: 0,
    pointer: [-1e5, -1e5], mouseRadius: 0, mouseStrength: 0.5,
    lightAngle: 0, lightStrength: 0,
    beamOrigin: [0.5, 0.5], beamAngle: 0, beamWidth: 0.5, beamStrength: 0, beamReach: 1.5
  };

  // uniform name -> gl.uniform* suffix. Keys not listed here are JS-side only.
  var UNIFORMS = {
    waveSpeed: '1f', waveFrequency: '1f', waveAmplitude: '1f', scroll: '1f', scrollParallax: '1f',
    pixelSize: '1f', colorNum: '1f', gain: '1f', bias: '1f', paletteA: '3fv', paletteB: '3fv',
    sceneMode: '1i', waterLine: '1f', boatX: '1f', sailLean: '1f', boatBob: '1f', boatOpacity: '1f',
    isoLevels: '1f', isoLineWidth: '1f', isoLineValue: '1f',
    pointer: '2fv', mouseRadius: '1f', mouseStrength: '1f',
    lightAngle: '1f', lightStrength: '1f',
    beamOrigin: '2fv', beamAngle: '1f', beamWidth: '1f', beamStrength: '1f', beamReach: '1f'
  };
  var SCENE_MODES = { waves: 0, ocean: 1, isolines: 2 };
  var NO_LERP = { sceneMode: 1, pointer: 1 }; // always snap

  // Boat physics constants (Dither.tsx).
  var BOAT_X_CLAMP = 0.62, SAIL_LERP = 0.045, WIND_ACCEL = 0.00055, WIND_DRAG = 0.982;

  function normalise(key, value) {
    if (key === 'sceneMode' && typeof value === 'string') return SCENE_MODES[value] || 0;
    if (key === 'pixelSize') return Math.max(1, +value);
    if (key === 'colorNum') return Math.max(2, +value);
    return value;
  }
  function clone(v) { return Array.isArray(v) ? v.slice() : v; }
  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('NaveDither shader compile error:\n' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  // ---------------------------------------------------------------------------
  // Instance
  // ---------------------------------------------------------------------------
  function Instance(canvas, opts) {
    var self = this;
    this.canvas = canvas;
    this.options = {};
    this.time = 0;
    this.supported = true;
    this._cur = {}; this._tgt = {}; this._lerp = {};
    this._raf = 0; this._last = 0; this._dirty = true;
    this._paused = false; this._onscreen = true; this._docVisible = !document.hidden;
    this._windTarget = 0; this._hasPointer = false; this._velocity = 0;
    this._destroyed = false;

    var key;
    for (key in DEFAULTS) {
      var v = opts && opts[key] !== undefined ? opts[key] : DEFAULTS[key];
      v = normalise(key, v);
      this.options[key] = v;
      this._cur[key] = clone(v); this._tgt[key] = clone(v); this._lerp[key] = 0;
    }

    var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false }) ||
             canvas.getContext('experimental-webgl', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) { this.supported = false; return; }
    this.gl = gl;
    this._initGL();

    // Reduced motion (option or media query).
    this._mq = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    this._onMq = function () { self._dirty = true; self._kick(); };
    if (this._mq && this._mq.addEventListener) this._mq.addEventListener('change', this._onMq);

    // Listeners / observers.
    this._onResize = function () { self._resize(); };
    if (root.ResizeObserver) { this._ro = new ResizeObserver(this._onResize); this._ro.observe(canvas); }
    else root.addEventListener('resize', this._onResize);

    this._onVis = function () { self._docVisible = !document.hidden; self._kick(); };
    document.addEventListener('visibilitychange', this._onVis);

    if (root.IntersectionObserver) {
      this._io = new IntersectionObserver(function (entries) {
        self._onscreen = entries[entries.length - 1].isIntersecting; self._kick();
      }, { rootMargin: '120px' });
      this._io.observe(canvas);
    }

    this._onPointer = function (e) {
      if (!self.options.trackPointer) return;
      var r = canvas.getBoundingClientRect(), d = self.options.dpr;
      self._cur.pointer = self._tgt.pointer = [(e.clientX - r.left) * d, (e.clientY - r.top) * d];
      self._windTarget = Math.max(-1, Math.min(1, (e.clientX / (root.innerWidth || 1)) * 2 - 1));
      self._hasPointer = true;
      if (self._cur.mouseRadius > 0) { self._dirty = true; self._kick(); }
    };
    root.addEventListener('pointermove', this._onPointer, { passive: true });

    this._onLost = function (e) { e.preventDefault(); if (self._raf) { cancelAnimationFrame(self._raf); self._raf = 0; } };
    this._onRestored = function () { self._initGL(); self._dirty = true; self._kick(); };
    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);

    this._resize();
    if (!this.options.paused) this._kick();
  }

  Instance.prototype._initGL = function () {
    var gl = this.gl, prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('NaveDither link error: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // full-screen triangle
    var loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this._u = { resolution: gl.getUniformLocation(prog, 'resolution'), time: gl.getUniformLocation(prog, 'time') };
    for (var k in UNIFORMS) this._u[k] = gl.getUniformLocation(prog, k);
    this._prog = prog;
  };

  Instance.prototype._resize = function () {
    var c = this.canvas, d = this.options.dpr || 1;
    var w = Math.max(1, Math.floor((c.clientWidth || 1) * d));
    var h = Math.max(1, Math.floor((c.clientHeight || 1) * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (this.gl) this.gl.viewport(0, 0, w, h);
    this._dirty = true; this._kick();
  };

  Instance.prototype.isReducedMotion = function () {
    var rm = this.options.reducedMotion;
    return rm === true || (rm === 'auto' && !!(this._mq && this._mq.matches));
  };
  Instance.prototype._running = function () {
    return this.supported && !this._destroyed && !this._paused && this._onscreen && this._docVisible;
  };
  Instance.prototype._kick = function () {
    var self = this;
    if (this._raf || !this._running()) return;
    this._last = 0;
    this._raf = requestAnimationFrame(function (now) { self._tick(now); });
  };

  Instance.prototype._tick = function (now) {
    this._raf = 0;
    if (!this._running()) return;
    var dt = this._last ? Math.min((now - this._last) / 1000, 0.1) : 1 / 60;
    this._last = now;
    var reduced = this.isReducedMotion();
    var animating = !reduced && this.options.timeScale !== 0;

    if (!reduced) this.time += dt * this.options.timeScale;

    // Smooth value interpolation (per-frame factor normalised to 60fps).
    var lerping = false, k, key, cur, tgt, f, i, done;
    for (key in this._lerp) {
      if (!this._lerp[key]) continue;
      f = 1 - Math.pow(1 - this._lerp[key], dt * 60);
      cur = this._cur[key]; tgt = this._tgt[key]; done = true;
      if (Array.isArray(cur)) {
        for (i = 0; i < cur.length; i++) { cur[i] += (tgt[i] - cur[i]) * f; if (Math.abs(tgt[i] - cur[i]) > 1e-4) done = false; }
      } else {
        cur += (tgt - cur) * f; if (Math.abs(tgt - cur) > 1e-4) done = false; this._cur[key] = cur;
      }
      if (done) { this._cur[key] = clone(tgt); this._lerp[key] = 0; } else lerping = true;
    }

    // Ocean wind + boat physics (port of Dither.tsx useFrame).
    if (this.options.autoWind && this._cur.sceneMode === 1 && !reduced) {
      var wind = this._hasPointer ? this._windTarget : Math.sin(this.time * 0.25) * 0.35;
      var lean = this._cur.sailLean + (wind - this._cur.sailLean) * SAIL_LERP;
      this._velocity = (this._velocity + lean * WIND_ACCEL) * WIND_DRAG;
      var bx = Math.max(-BOAT_X_CLAMP, Math.min(BOAT_X_CLAMP, this._cur.boatX + this._velocity));
      this._cur.sailLean = this._tgt.sailLean = lean;
      this._cur.boatX = this._tgt.boatX = bx;
      this._cur.boatBob = this._tgt.boatBob = Math.sin(this.time * 1.1) * 0.012;
    }

    if (this.options.onFrame) this.options.onFrame(this, dt, this.time);

    if (animating || lerping || this._dirty) { this._render(); this._dirty = false; }
    if (animating || lerping) this._kick();
  };

  Instance.prototype._render = function () {
    var gl = this.gl, u = this._u, c = this._cur, key;
    gl.useProgram(this._prog);
    gl.uniform2f(u.resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.time, this.time);
    for (key in UNIFORMS) {
      if (!u[key]) continue;
      var t = UNIFORMS[key];
      if (t === '1f') gl.uniform1f(u[key], c[key]);
      else if (t === '1i') gl.uniform1i(u[key], c[key] | 0);
      else if (t === '2fv') gl.uniform2fv(u[key], c[key]);
      else gl.uniform3fv(u[key], c[key]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  /** set({ key: value, ... }, { lerp: 0..1 }) — lerp omitted/0 snaps immediately. */
  Instance.prototype.set = function (values, opts) {
    var lerp = (opts && opts.lerp) || 0, key, v;
    for (key in values) {
      if (!(key in DEFAULTS)) continue;
      v = normalise(key, values[key]);
      if (!(key in UNIFORMS)) {
        this.options[key] = v;
        if (key === 'dpr') this._resize();
        if (key === 'paused') { if (v) this.pause(); else this.resume(); }
        continue;
      }
      this.options[key] = clone(v);
      this._tgt[key] = clone(v);
      if (lerp > 0 && !NO_LERP[key] && typeof v !== 'boolean') { this._lerp[key] = Math.min(lerp, 1); }
      else { this._cur[key] = clone(v); this._lerp[key] = 0; }
    }
    this._dirty = true; this._kick();
    return this;
  };
  Instance.prototype.get = function (key) { return clone(this._cur[key] !== undefined ? this._cur[key] : this.options[key]); };
  Instance.prototype.pause = function () { this._paused = true; if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; } return this; };
  Instance.prototype.resume = function () { this._paused = false; this._dirty = true; this._kick(); return this; };
  Instance.prototype.render = function () { if (this.gl) this._render(); return this; };
  Instance.prototype.destroy = function () {
    this._destroyed = true; this.pause();
    if (this._ro) this._ro.disconnect(); else root.removeEventListener('resize', this._onResize);
    if (this._io) this._io.disconnect();
    if (this._mq && this._mq.removeEventListener) this._mq.removeEventListener('change', this._onMq);
    document.removeEventListener('visibilitychange', this._onVis);
    root.removeEventListener('pointermove', this._onPointer);
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    if (this.gl) { var ext = this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function mount(target, options) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('NaveDither.mount: target not found');
    var canvas = el;
    if (el.tagName !== 'CANVAS') {
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100%;height:100%;';
      el.appendChild(canvas);
    }
    return new Instance(canvas, options || {});
  }

  /** '#RRGGBB' | '#RGB' -> [r, g, b] in 0..1 */
  function hex(str) {
    var s = String(str).replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  /** Linear blend of two RGB arrays. */
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  root.NaveDither = {
    version: '1.0.0', mount: mount, hex: hex, mix: mix,
    defaults: DEFAULTS, uniforms: UNIFORMS, sceneModes: SCENE_MODES,
    FRAG: FRAG, VERT: VERT
  };
})(typeof window !== 'undefined' ? window : this);
