# `_shared/` — foundation for the Nave homepage demos

Vanilla, no build step. Everything here is plain `<script>`/`<link>` includes, so a demo
page can either reference these files or inline them wholesale.

| File | What it is |
| --- | --- |
| `dither.js` | `NaveDither` — vanilla WebGL1 port of `app/src/components/Dither.tsx` (fbm Perlin water + Bayer 8×8 ordered dither) in a single fragment pass, plus `ocean`, `waves`, `isolines` modes, pointer dent, directional light, lighthouse beam, palette mapping, lerped `set()`. |
| `demo-base.css` | Design tokens from `app/src/index.css` as CSS variables, resets, `.text-display`, `.nave-label`, `.nave-section-label`, `.nave-card`, `.nave-btn*`, `.nave-dither-layer`, hero + scroll-reveal keyframes, reduced-motion fallbacks. |
| `reveal.js` | `NaveReveal.init(selector)` scroll reveal and `NaveScroll.{progress, pinProgress, pageProgress, onScroll, remap, ease}` for driving uniforms from scroll. |
| `copy.js` | `NAVE_COPY` — every string on the live homepage (`Index.tsx`, mainnet variants, `$19 NAVE`). |
| `scaffold.html` | Smoke test / reference: full-viewport ocean hero + contained waves card, real copy, scroll-driven uniform example. Copy from it freely. |

## Include

```html
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="_shared/demo-base.css" />
...
<script src="_shared/copy.js"></script>
<script src="_shared/reveal.js"></script>
<script src="_shared/dither.js"></script>
```

Serve the folder (`python3 -m http.server 4173` from `design/homepage-demos`, or `npx -y serve design/homepage-demos -l 4173`) and open `http://127.0.0.1:4173/_shared/scaffold.html`. Plain `file://` also works for the scripts, but the IDE browser tool refuses `file://` URLs.

## NaveDither

```js
var sea = NaveDither.mount('#canvas-or-container', NAVE_COPY.ditherPresets.hero); // ocean, 2px, 5 levels
sea.set({ pixelSize: 6, colorNum: 2 });                 // snap
sea.set({ pixelSize: 2, colorNum: 5 }, { lerp: 0.06 }); // ease (per-frame factor, 60fps-normalised)
sea.set({ paletteA: NaveDither.hex('#0B1220'), paletteB: NaveDither.hex('#F7F5F0') });
sea.get('boatX'); sea.pause(); sea.resume(); sea.destroy();
```

`mount(target, options)` accepts a `<canvas>`, a selector, or a container element (a 100%×100% canvas is appended). The instance exposes `set`, `get`, `pause`, `resume`, `render`, `destroy`, `isReducedMotion()`, `canvas`, `gl`, `time`, `options`, `supported`.

Pipeline per pixel block: `f = pattern(uv)` → pointer dent → directional light → scene shaping (`ocean` / `isolines`) → beam → boat silhouette → `v*gain + bayer/levels - bias` → quantise to `colorNum` levels → `mix(paletteA, paletteB, level)`. With the default black→white palette the output is bit-for-bit the same greys as the live site (0, .25, .5, .75, 1).

### Options (all live-settable through `set()`)

| Option | Default | Notes |
| --- | --- | --- |
| **Behaviour** | | JS-side, not uniforms |
| `timeScale` | `1` | multiplies dt; `0` freezes the water but keeps rendering on demand |
| `reducedMotion` | `'auto'` | `true` / `false` / `'auto'` (media query). Freezes time + boat physics; `set()` still re-renders once |
| `autoWind` | `true` | ocean: boat drifts with pointer-X wind exactly like `Dither.tsx`. Set `false` to drive `boatX`/`sailLean`/`boatBob` yourself |
| `trackPointer` | `true` | window `pointermove` → `pointer` uniform (canvas px) and wind target |
| `dpr` | `1` | backing-store scale; keep at 1 so blocks are crisp and cheap |
| `paused` | `false` | start paused |
| `onFrame` | `null` | `fn(instance, dt, time)` each frame before render — handy for per-frame scroll coupling |
| **Noise** | | |
| `waveSpeed` | `0.08` | hero uses 0.08, tokenomics card 0.06 |
| `waveFrequency` | `3` | fbm lacunarity |
| `waveAmplitude` | `0.3` | fbm gain (card: 0.28) |
| `scroll` | `0` | generic 0..1; pans the noise by `scroll * scrollParallax` |
| `scrollParallax` | `0` | vertical pan distance in uv units (0.3–0.6 feels like rising through water) |
| **Dither** | | |
| `pixelSize` | `2` | block size in px, 1..12 |
| `colorNum` | `5` | quantisation levels, 2..8 |
| `gain` | `0.86` | pre-dither multiplier (= `waveColor` brightness in `Dither.tsx`; card used 0.82) |
| `bias` | `0.2` | subtracted before quantising. Lower → brighter |
| `paletteA` | `[0,0,0]` | RGB 0..1 for level 0 (use `NaveDither.hex('#0B1220')`) |
| `paletteB` | `[1,1,1]` | RGB 0..1 for level 1 |
| **Scene** | | |
| `sceneMode` | `'ocean'` | `'waves'` (0) / `'ocean'` (1) / `'isolines'` (2) |
| `waterLine` | `-0.16` | ocean horizon in uv, -0.5 (bottom) .. 0.5 (top) |
| `boatX` | `0` | aspect-corrected uv; ±0.62 is the physics clamp |
| `sailLean` | `0` | -1..1 |
| `boatBob` | `0` | uv offset |
| `boatOpacity` | `1` | 0 hides the boat (fade it in when surfacing) |
| `isoLevels` | `6` | isolines: number of stepped bands |
| `isoLineWidth` | `0.06` | isolines: contour thickness as a fraction of a band |
| `isoLineValue` | `0` | isolines: value painted on the contour (0 = paletteA) |
| **Pointer dent** | | |
| `pointer` | offscreen | `[x, y]` canvas px, y down. Auto-set when `trackPointer` |
| `mouseRadius` | `0` | radius in uv; `0` disables (hero on the live site has it off; card used 0.25) |
| `mouseStrength` | `0.5` | how much the dent lowers the value |
| **Light & beam** | | |
| `lightAngle` | `0` | radians; directional shading from the fbm gradient (costs 2 extra fbm samples) |
| `lightStrength` | `0` | `0` disables; 0.2–0.4 is plenty |
| `beamOrigin` | `[0.5,0.5]` | normalised canvas coords, y down |
| `beamAngle` | `0` | radians, 0 = +x, counter-clockwise (screen-up is positive y) |
| `beamWidth` | `0.5` | full wedge angle in radians |
| `beamStrength` | `0` | value added inside the wedge; `0` disables |
| `beamReach` | `1.5` | distance (uv units; 1 = viewport height) at which the beam fades out |

Helpers: `NaveDither.hex('#C9A24A')` → `[r,g,b]`, `NaveDither.mix(a, b, t)`, `NaveDither.defaults`, `NaveDither.FRAG` (the shader source, if you want to inline or fork it).

## Scroll-driven uniforms (recipe)

```js
var sea = NaveDither.mount('#sea', { sceneMode: 'ocean', pixelSize: 8, colorNum: 2, timeScale: 0.2,
  paletteA: NaveDither.hex('#06111C'), paletteB: NaveDither.hex('#0B1220') });
var deep = NaveDither.hex('#0B1220'), paper = NaveDither.hex('#FAF8F3'), gold = NaveDither.hex('#C9A24A');

NaveScroll.onScroll(function () {
  var p = NaveScroll.pageProgress();                  // or progress(sectionEl) / pinProgress(sectionEl)
  var e = NaveScroll.ease.inOut(p);
  sea.set({
    pixelSize: NaveScroll.lerp(8, 2, e),
    colorNum: Math.round(NaveScroll.lerp(2, 6, e)),
    timeScale: NaveScroll.lerp(0.2, 1, e),
    scroll: p,
    paletteB: p < 0.8 ? NaveDither.mix(deep, paper, e) : NaveDither.mix(paper, gold, (p - 0.8) / 0.2),
    boatOpacity: NaveScroll.remap(p, 0.85, 1, 0, 1),
    beamAngle: performance.now() * 0.0004              // or do this in onFrame for a smooth sweep
  }, { lerp: 0.12 });                                   // lerp smooths scroll jitter
});
```

- `NaveScroll.progress(el)` is 0 when `el`'s top enters at the viewport bottom and 1 when its bottom leaves at the top. `progress(el, { start: 0, end: 0 })` = 0 while el's top is at the viewport top, 1 once it has scrolled out (used in `scaffold.html`).
- `NaveScroll.pinProgress(el)` is for tall sections with a `position: sticky` child (Concept B's pinned route): 0 when the section top hits the viewport top, 1 when its bottom hits the viewport bottom.
- Per-frame coupling (e.g. a continuously rotating beam) belongs in `onFrame: function (inst, dt, t) { inst.set({ beamAngle: t * 0.4 }); }`.
- `set()` is cheap (no GL calls until the next frame); call it every scroll tick.

## Scroll reveal

Add `.sr-hidden` (or `data-reveal="scale|left|right"`) to blocks and `.sr-stagger` to a grid whose children should cascade, then `NaveReveal.init('.sr-hidden')`. Reduced motion shows everything immediately.

## Gotchas

- **Blocks live on the device-pixel grid.** The Bayer index is `floor(gl_FragCoord / pixelSize)`, so any CSS `transform: scale()` or non-1:1 canvas sizing blurs the dots. Keep the canvas at CSS size with `dpr: 1` (the live site also renders at DPR 1). `background-clip: text` over a canvas is fine; scaling the canvas is not.
- **WebGL1 cannot index a `const float[64]` with a runtime index**, so the matrix is computed procedurally (`bayer8(vec2(y, x))`). It was verified against the `Dither.tsx` table for all 64 cells, so the pattern is identical.
- **The boat drifts.** With `autoWind: true` the boat follows pointer-X wind and will slowly travel to ±0.62 if the pointer sits at a screen edge (same physics as the live site). If you need it anchored, set `autoWind: false` and drive `boatX` yourself; `sailLean` still accepts -1..1.
- **Opacity + multiply is part of the look.** The live hero is the canvas at `opacity: .38; mix-blend-mode: multiply` over white plus a radial white vignette (`.nave-dither-layer` + `.hero-vignette` in the scaffold). Dark concepts should drop the multiply and render the canvas opaque with a dark `paletteA`.
- **Quantised output only has `colorNum` colours between `paletteA` and `paletteB`.** A third colour (gold) is a palette swap or a second canvas, not a third uniform.
- **`lightStrength` triples the noise cost** (two extra `pattern()` evaluations). Keep it off unless a concept needs it; `beam` is cheap.
- **Reduced motion** (`prefers-reduced-motion`) freezes time and boat physics and stops the rAF loop when idle; `set()` still redraws once, so scroll-driven palettes continue to work without motion.
- **The hero stats values in `NAVE_COPY.hero.stats` are placeholders** (the site pulls them from Supabase). Labels, and every other string, are verbatim.
- The IDE browser tool rejects `file://` and would not open a tab in this session; `npx serve` launched from the tool shell got reaped. `python3 -m http.server` kept in a background shell + Playwright from `app/node_modules` was the reliable way to screenshot.
