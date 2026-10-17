/* eslint-disable react/no-unknown-property */
import { useRef, useEffect, useState, forwardRef } from 'react';
import { Canvas, useFrame, useThree, ThreeEvent } from '@react-three/fiber';
import { EffectComposer, wrapEffect } from '@react-three/postprocessing';
import { Effect } from 'postprocessing';
import * as THREE from 'three';

export type DitherVariant = 'waves' | 'ocean' | 'isolines';

const waveVertexShader = `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 modelPosition = modelMatrix * vec4(position, 1.0);
  vec4 viewPosition = viewMatrix * modelPosition;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const waveFragmentShader = `
precision highp float;
uniform vec2 resolution;
uniform float time;
uniform float waveSpeed;
uniform float waveFrequency;
uniform float waveAmplitude;
uniform vec3 waveColor;
uniform vec2 mousePos;
uniform int enableMouseInteraction;
uniform float mouseRadius;
uniform int sceneMode;
uniform float boatX;
uniform float sailLean;
uniform float boatBob;
uniform float lightAngle;
uniform float lightStrength;
uniform float isoLevels;
uniform float isoLineWidth;
uniform float isoLineValue;
uniform float scroll;
uniform float scrollParallax;
uniform float paletteEnabled;
uniform float pixelSize;
uniform float colorNum;
uniform float ditherGain;
uniform float ditherBias;
uniform vec3 paletteA;
uniform vec3 paletteB;
uniform sampler2D markMap;
uniform float markEnabled;
uniform float markAspect;

vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec2 fade(vec2 t) { return t*t*t*(t*(t*6.0-15.0)+10.0); }

float cnoise(vec2 P) {
  vec4 Pi = floor(P.xyxy) + vec4(0.0,0.0,1.0,1.0);
  vec4 Pf = fract(P.xyxy) - vec4(0.0,0.0,1.0,1.0);
  Pi = mod289(Pi);
  vec4 ix = Pi.xzxz;
  vec4 iy = Pi.yyww;
  vec4 fx = Pf.xzxz;
  vec4 fy = Pf.yyww;
  vec4 i = permute(permute(ix) + iy);
  vec4 gx = fract(i * (1.0/41.0)) * 2.0 - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx = gx - tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g00,g00), dot(g01,g01), dot(g10,g10), dot(g11,g11)));
  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 fade_xy = fade(Pf.xy);
  vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), fade_xy.x);
  return 2.3 * mix(n_x.x, n_x.y, fade_xy.y);
}

const int OCTAVES = 4;
float fbm(vec2 p) {
  float value = 0.0;
  float amp = 1.0;
  float freq = waveFrequency;
  for (int i = 0; i < OCTAVES; i++) {
    value += amp * abs(cnoise(p));
    p *= freq;
    amp *= waveAmplitude;
  }
  return value;
}

float pattern(vec2 p) {
  vec2 p2 = p - time * waveSpeed;
  return fbm(p + fbm(p2));
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdEllipse(vec2 p, vec2 r) {
  return (length(p / r) - 1.0) * min(r.x, r.y);
}

// Soft triangle SDF for the sail (a, b, c = vertices).
float sdTriangle(vec2 p, vec2 a, vec2 b, vec2 c) {
  vec2 e0 = b - a;
  vec2 e1 = c - b;
  vec2 e2 = a - c;
  vec2 v0 = p - a;
  vec2 v1 = p - b;
  vec2 v2 = p - c;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(
    vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
    vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
    vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

// Pure-float 8x8 Bayer threshold (matches the 64-entry matrix bit-for-bit
// while avoiding GLSL ES 3.00 array constructors and dynamic array indexing so
// the shader compiles cleanly on both WebGL1 and WebGL2 drivers).
float bayer8x8(vec2 p) {
  vec2 p0 = mod(floor(p), 2.0);
  vec2 p1 = floor(mod(floor(p), 4.0) * 0.5);
  vec2 p2 = floor(mod(floor(p), 8.0) * 0.25);
  float d0 = 2.0 * abs(p0.x - p0.y) + p0.x;
  float d1 = 2.0 * abs(p1.x - p1.y) + p1.x;
  float d2 = 2.0 * abs(p2.x - p2.y) + p2.x;
  return (16.0 * d0 + 4.0 * d1 + d2) / 64.0;
}

// Scalar Bayer quantise, then a two-stop palette. Same matrix and threshold
// as RetroEffect below. Only the palette branch calls this — waves/ocean keep
// the postprocess pass so Bridge is unchanged.
float quantizeScalar(float value) {
  vec2 block = floor(gl_FragCoord.xy / max(pixelSize, 1.0));
  float threshold = bayer8x8(block) - 0.25;
  float levels = max(colorNum, 2.0) - 1.0;
  float c = value * ditherGain + threshold / levels;
  c = clamp(c - ditherBias, 0.0, 1.0);
  return floor(c * levels + 0.5) / levels;
}

void main() {
  vec2 safeRes = max(resolution.xy, vec2(1.0));
  vec2 uv = gl_FragCoord.xy / safeRes;
  uv -= 0.5;
  uv.x *= safeRes.x / safeRes.y;

  // Palette mode samples once per Bayer block, in the same pass as quantise,
  // so values outside 0..1 (contour lines, bright fbm) are not clamped by the
  // intermediate render target. waves/ocean leave uv untouched.
  vec2 sampleUv = uv;
  if (paletteEnabled > 0.5) {
    vec2 block = floor(gl_FragCoord.xy / max(pixelSize, 1.0));
    vec2 sc = (block + 0.5) * max(pixelSize, 1.0);
    sampleUv = sc / safeRes - 0.5;
    sampleUv.x *= safeRes.x / safeRes.y;
  }
  if (scrollParallax != 0.0) {
    sampleUv += vec2(0.0, scroll * scrollParallax);
  }

  float f = pattern(sampleUv);

  // Wave-dent mouse interaction: waves mode only.
  if (sceneMode == 0 && enableMouseInteraction == 1) {
    vec2 mouseNDC = (mousePos / safeRes - 0.5) * vec2(1.0, -1.0);
    mouseNDC.x *= safeRes.x / safeRes.y;
    float dist = length(uv - mouseNDC);
    float effect = 1.0 - smoothstep(0.0, mouseRadius, dist);
    f -= 0.5 * effect;
  }

  // Directional light from the fbm gradient. lightStrength 0 skips it.
  if (lightStrength > 0.0) {
    float e = 0.012;
    vec2 g = vec2(pattern(sampleUv + vec2(e, 0.0)) - f, pattern(sampleUv + vec2(0.0, e)) - f) / e;
    vec2 Ldir = vec2(cos(lightAngle), sin(lightAngle));
    float gm = length(g);
    if (gm > 0.0001) f += lightStrength * dot(g / gm, Ldir) * min(gm * 0.15, 1.0);
  }

  // Isolines and explicit palettes. waves (0) and ocean (1) without a palette
  // fall through to the original color path below.
  if (paletteEnabled > 0.5 || sceneMode == 2) {
    float v = f;
    if (sceneMode == 2) {
      float n = max(isoLevels, 1.0);
      float s = f * n;
      float band = floor(s) / n;
      float fr = fract(s);
      float isoEdge = min(fr, 1.0 - fr);
      float line = 1.0 - smoothstep(0.0, max(isoLineWidth, 0.0001), isoEdge);
      v = mix(band, isoLineValue, line);
    }
    // Homepage sail: the mark is the same grey/white field, lifted so the
    // cloth reads pale, with the live contour lines still running through it.
    if (markEnabled > 0.5) {
      float heave = sin(time * 0.52) * 0.02;
      float sway = sin(time * 0.24) * 0.012;
      float lean = sin(time * 0.36) * 0.045;
      vec2 p = sampleUv - vec2(sway, heave);
      p.x += lean * p.y;
      float markH = 0.68;
      float markW = markH * markAspect;
      vec2 mu = vec2(p.x / markW + 0.5, p.y / markH + 0.5);
      float mark = 0.0;
      if (mu.x > 0.0 && mu.x < 1.0 && mu.y > 0.0 && mu.y < 1.0) {
        mark = texture2D(markMap, mu).a;
      }
      float inside = smoothstep(0.55, 0.9, mark);
      float markEdge = smoothstep(0.28, 0.55, mark) * (1.0 - smoothstep(0.72, 0.95, mark));
      float body = 0.84 + 0.08 * sin(time * 0.7 + mu.y * 5.0);
      float cloth = mix(body, clamp(v, 0.0, 1.0), 0.16);
      v = mix(v, cloth, inside);
      v = mix(v, 0.05, markEdge);
    }
    if (paletteEnabled > 0.5) {
      float q = quantizeScalar(v);
      gl_FragColor = vec4(mix(paletteA, paletteB, q), 1.0);
    } else {
      gl_FragColor = vec4(mix(vec3(0.0), waveColor, v), 1.0);
    }
  } else {
  vec3 col = mix(vec3(0.0), waveColor, f);

  if (sceneMode == 1) {
    // Soft horizon: water in lower ~55–65%, quieter sky above (below vignette core).
    float waterLine = -0.16;
    float waterMask = 1.0 - smoothstep(waterLine - 0.10, waterLine + 0.14, uv.y);
    float skyF = f * 0.14 + 0.88;
    float waterF = clamp(f * 1.05 + 0.10 * step(0.50, f), 0.0, 1.0);
    float sceneF = mix(skyF, waterF, waterMask);
    col = mix(vec3(0.0), waveColor, sceneF);

    // Silhouette boat riding the water line — sized for Bayer (detail dies small).
    float bx = boatX;
    float by = waterLine + boatBob - 0.015;
    vec2 local = uv - vec2(bx, by);

    float hull = sdEllipse(local - vec2(0.0, -0.016), vec2(0.11, 0.028));
    float mast = sdBox(local - vec2(0.0, 0.06), vec2(0.006, 0.075));

    // Sail leans toward wind: tip shears with sailLean.
    float lean = clamp(sailLean, -1.0, 1.0) * 0.07;
    vec2 sailA = vec2(0.005, 0.012);
    vec2 sailB = vec2(0.005, 0.125);
    vec2 sailC = abs(lean) < 0.01
      ? vec2(0.095, 0.06)
      : vec2(0.005 + 0.085 * sign(lean) + lean * 1.1, 0.06);
    float sail = sdTriangle(local, sailA, sailB, sailC);

    float boatMask = 1.0 - smoothstep(0.0, 0.005, min(min(hull, mast), sail));
    // Keep sail/mast visible above the waterline; only soft-clip far into the sky.
    float boatSkyFade = 1.0 - smoothstep(waterLine + 0.14, waterLine + 0.24, uv.y);
    vec3 boatCol = waveColor * 0.12;
    col = mix(col, boatCol, boatMask * boatSkyFade);
  }

  gl_FragColor = vec4(col, 1.0);
  }
}
`;

const ditherFragmentShader = `
precision highp float;
uniform float colorNum;
uniform float pixelSize;

float bayer8x8(vec2 p) {
  vec2 p0 = mod(floor(p), 2.0);
  vec2 p1 = floor(mod(floor(p), 4.0) * 0.5);
  vec2 p2 = floor(mod(floor(p), 8.0) * 0.25);
  float d0 = 2.0 * abs(p0.x - p0.y) + p0.x;
  float d1 = 2.0 * abs(p1.x - p1.y) + p1.x;
  float d2 = 2.0 * abs(p2.x - p2.y) + p2.x;
  return (16.0 * d0 + 4.0 * d1 + d2) / 64.0;
}

vec3 dither(vec2 uv, vec3 color) {
  vec2 scaledCoord = floor(uv * resolution / max(pixelSize, 1.0));
  float threshold = bayer8x8(scaledCoord) - 0.25;
  float step = 1.0 / (colorNum - 1.0);
  color += threshold * step;
  float bias = 0.2;
  color = clamp(color - bias, 0.0, 1.0);
  return floor(color * (colorNum - 1.0) + 0.5) / (colorNum - 1.0);
}

void mainImage(in vec4 inputColor, in vec2 uv, out vec4 outputColor) {
  vec2 normalizedPixelSize = pixelSize / resolution;
  vec2 uvPixel = normalizedPixelSize * floor(uv / normalizedPixelSize);
  vec4 color = texture2D(inputBuffer, uvPixel);
  color.rgb = dither(uv, color.rgb);
  outputColor = color;
}
`;

class RetroEffectImpl extends Effect {
  private uniformMap: Map<string, THREE.Uniform<number>>;

  constructor() {
    const uniformMap = new Map<string, THREE.Uniform<number>>([
      ['colorNum', new THREE.Uniform(4.0)],
      ['pixelSize', new THREE.Uniform(2.0)],
    ]);
    super('RetroEffect', ditherFragmentShader, { uniforms: uniformMap });
    this.uniformMap = uniformMap;
  }

  set colorNum(value: number) {
    this.uniformMap.get('colorNum')!.value = value;
  }

  get colorNum(): number {
    return this.uniformMap.get('colorNum')!.value;
  }

  set pixelSize(value: number) {
    this.uniformMap.get('pixelSize')!.value = value;
  }

  get pixelSize(): number {
    return this.uniformMap.get('pixelSize')!.value;
  }
}

const WrappedRetroEffect = wrapEffect(RetroEffectImpl);

const RetroEffect = forwardRef<RetroEffectImpl, { colorNum: number; pixelSize: number }>(
  (props, ref) => {
    const { colorNum, pixelSize } = props;
    return <WrappedRetroEffect ref={ref} colorNum={colorNum} pixelSize={pixelSize} />;
  },
);

RetroEffect.displayName = 'RetroEffect';

interface WaveUniforms {
  [key: string]: THREE.Uniform<unknown>;
  time: THREE.Uniform<number>;
  resolution: THREE.Uniform<THREE.Vector2>;
  waveSpeed: THREE.Uniform<number>;
  waveFrequency: THREE.Uniform<number>;
  waveAmplitude: THREE.Uniform<number>;
  waveColor: THREE.Uniform<THREE.Color>;
  mousePos: THREE.Uniform<THREE.Vector2>;
  enableMouseInteraction: THREE.Uniform<number>;
  mouseRadius: THREE.Uniform<number>;
  sceneMode: THREE.Uniform<number>;
  boatX: THREE.Uniform<number>;
  sailLean: THREE.Uniform<number>;
  boatBob: THREE.Uniform<number>;
  lightAngle: THREE.Uniform<number>;
  lightStrength: THREE.Uniform<number>;
  isoLevels: THREE.Uniform<number>;
  isoLineWidth: THREE.Uniform<number>;
  isoLineValue: THREE.Uniform<number>;
  scroll: THREE.Uniform<number>;
  scrollParallax: THREE.Uniform<number>;
  paletteEnabled: THREE.Uniform<number>;
  pixelSize: THREE.Uniform<number>;
  colorNum: THREE.Uniform<number>;
  ditherGain: THREE.Uniform<number>;
  ditherBias: THREE.Uniform<number>;
  paletteA: THREE.Uniform<THREE.Color>;
  paletteB: THREE.Uniform<THREE.Color>;
  markMap: THREE.Uniform<THREE.Texture>;
  markEnabled: THREE.Uniform<number>;
  markAspect: THREE.Uniform<number>;
}

interface DitheredWavesProps {
  waveSpeed: number;
  waveFrequency: number;
  waveAmplitude: number;
  waveColor: [number, number, number];
  colorNum: number;
  pixelSize: number;
  disableAnimation: boolean;
  enableMouseInteraction: boolean;
  mouseRadius: number;
  variant: DitherVariant;
  paletteA: [number, number, number] | null;
  paletteB: [number, number, number] | null;
  gain: number;
  bias: number;
  lightAngle: number;
  lightStrength: number;
  tiltWithPointer: boolean;
  isoLevels: number;
  isoLineWidth: number;
  isoLineValue: number;
  scroll: number;
  scrollRef: { current: number } | null;
  scrollParallax: number;
  showMark: boolean;
}

const MARK_PLACEHOLDER = (() => {
  const data = new Uint8Array([0, 0, 0, 0]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
})();

const BOAT_X_CLAMP = 0.62;
const SAIL_LERP = 0.045;
const WIND_ACCEL = 0.00055;
const WIND_DRAG = 0.982;

function angleDelta(target: number, current: number) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function DitheredWaves({
  waveSpeed,
  waveFrequency,
  waveAmplitude,
  waveColor,
  colorNum,
  pixelSize,
  disableAnimation,
  enableMouseInteraction,
  mouseRadius,
  variant,
  paletteA,
  paletteB,
  gain,
  bias,
  lightAngle,
  lightStrength,
  tiltWithPointer,
  isoLevels,
  isoLineWidth,
  isoLineValue,
  scroll,
  scrollRef,
  scrollParallax,
  showMark,
}: DitheredWavesProps) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const mouseRef = useRef(new THREE.Vector2());
  /** Normalized wind target −1…1 from window pointer X (ocean only). */
  const windTargetRef = useRef(0);
  const hasPointerRef = useRef(false);
  const sailLeanRef = useRef(0);
  const velocityRef = useRef(0);
  const boatXRef = useRef(0);
  const lightAngleRef = useRef(lightAngle);
  const lightStrengthRef = useRef(lightStrength);
  const smoothAngleRef = useRef(lightAngle);
  const smoothStrengthRef = useRef(lightStrength);
  const markTextureRef = useRef<THREE.Texture | null>(null);
  const { viewport, size, gl } = useThree();
  const isOcean = variant === 'ocean';
  const sceneMode = variant === 'ocean' ? 1 : variant === 'isolines' ? 2 : 0;
  const paletteOn = paletteA != null && paletteB != null;

  // Three.js ShaderMaterial clones uniforms on init — keep a stable source object
  // and always mutate materialRef.current.uniforms in useFrame (not this ref).
  const initialUniforms = useRef<WaveUniforms>({
    time: new THREE.Uniform(0),
    resolution: new THREE.Uniform(
      new THREE.Vector2(
        Math.max(1, Math.floor(size.width * gl.getPixelRatio())),
        Math.max(1, Math.floor(size.height * gl.getPixelRatio())),
      ),
    ),
    waveSpeed: new THREE.Uniform(waveSpeed),
    waveFrequency: new THREE.Uniform(waveFrequency),
    waveAmplitude: new THREE.Uniform(waveAmplitude),
    waveColor: new THREE.Uniform(new THREE.Color(...waveColor)),
    mousePos: new THREE.Uniform(new THREE.Vector2(0, 0)),
    enableMouseInteraction: new THREE.Uniform(enableMouseInteraction ? 1 : 0),
    mouseRadius: new THREE.Uniform(mouseRadius),
    sceneMode: new THREE.Uniform(sceneMode),
    boatX: new THREE.Uniform(0),
    sailLean: new THREE.Uniform(0),
    boatBob: new THREE.Uniform(0),
    lightAngle: new THREE.Uniform(0),
    lightStrength: new THREE.Uniform(0),
    isoLevels: new THREE.Uniform(isoLevels),
    isoLineWidth: new THREE.Uniform(isoLineWidth),
    isoLineValue: new THREE.Uniform(isoLineValue),
    scroll: new THREE.Uniform(0),
    scrollParallax: new THREE.Uniform(0),
    paletteEnabled: new THREE.Uniform(paletteOn ? 1 : 0),
    pixelSize: new THREE.Uniform(pixelSize),
    colorNum: new THREE.Uniform(colorNum),
    ditherGain: new THREE.Uniform(gain),
    ditherBias: new THREE.Uniform(bias),
    paletteA: new THREE.Uniform(new THREE.Color(...(paletteA ?? [0, 0, 0]))),
    paletteB: new THREE.Uniform(new THREE.Color(...(paletteB ?? waveColor))),
    markMap: new THREE.Uniform(MARK_PLACEHOLDER),
    markEnabled: new THREE.Uniform(0),
    markAspect: new THREE.Uniform(597 / 722),
  });

  useEffect(() => {
    const dpr = gl.getPixelRatio();
    const newWidth = Math.max(1, Math.floor(size.width * dpr));
    const newHeight = Math.max(1, Math.floor(size.height * dpr));
    const mat = materialRef.current;
    if (!mat) return;
    const currentRes = mat.uniforms.resolution.value as THREE.Vector2;
    if (currentRes.x !== newWidth || currentRes.y !== newHeight) {
      currentRes.set(newWidth, newHeight);
    }
  }, [size, gl]);

  // Ocean wind: listen on window so the hero canvas can stay pointer-events: none.
  useEffect(() => {
    if (!isOcean || disableAnimation) return;
    const onMove = (e: PointerEvent) => {
      const w = window.innerWidth || 1;
      windTargetRef.current = Math.max(-1, Math.min(1, (e.clientX / w) * 2 - 1));
      hasPointerRef.current = true;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [isOcean, disableAnimation]);

  // Directional light follows the pointer over this canvas. Reduced motion
  // (disableAnimation) skips the listener; useFrame also forces strength to 0.
  useEffect(() => {
    if (!tiltWithPointer || disableAnimation) return;
    lightAngleRef.current = lightAngle;
    lightStrengthRef.current = lightStrength;
    const canvas = gl.domElement;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const ang = Math.atan2(-(e.clientY - cy), e.clientX - cx);
      const dist = Math.min(1, Math.hypot(e.clientX - cx, e.clientY - cy) / Math.max(r.width, 1));
      lightAngleRef.current = ang;
      lightStrengthRef.current = 0.08 + 0.14 * dist;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [tiltWithPointer, disableAnimation, gl, lightAngle, lightStrength]);

  useEffect(() => {
    if (!showMark) {
      markTextureRef.current = null;
      return;
    }
    let disposed = false;
    const loader = new THREE.TextureLoader();
    loader.load('/brand/nave-mark.png', (texture) => {
      if (disposed) {
        texture.dispose();
        return;
      }
      texture.flipY = true;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      markTextureRef.current = texture;
    });
    return () => {
      disposed = true;
      markTextureRef.current?.dispose();
      markTextureRef.current = null;
    };
  }, [showMark]);

  const prevColor = useRef([...waveColor]);
  useFrame(({ clock, size: frameSize, gl: frameGl }) => {
    const mat = materialRef.current;
    if (!mat) return;
    const u = mat.uniforms as WaveUniforms;

    const dpr = frameGl.getPixelRatio();
    const resW = Math.max(1, Math.floor(frameSize.width * dpr));
    const resH = Math.max(1, Math.floor(frameSize.height * dpr));
    const currentRes = u.resolution.value as THREE.Vector2;
    if (currentRes.x !== resW || currentRes.y !== resH) {
      currentRes.set(resW, resH);
    }

    const t = clock.getElapsedTime();
    if (!disableAnimation) {
      u.time.value = t;
    }

    u.waveSpeed.value = waveSpeed;
    u.waveFrequency.value = waveFrequency;
    u.waveAmplitude.value = waveAmplitude;
    u.sceneMode.value = sceneMode;
    u.isoLevels.value = isoLevels;
    u.isoLineWidth.value = isoLineWidth;
    u.isoLineValue.value = isoLineValue;
    u.scrollParallax.value = scrollParallax;
    u.pixelSize.value = pixelSize;
    u.colorNum.value = colorNum;
    u.ditherGain.value = gain;
    u.ditherBias.value = bias;
    u.paletteEnabled.value = paletteOn ? 1 : 0;
    const markTexture = markTextureRef.current;
    if (showMark && markTexture) {
      const image = markTexture.image as { width?: number; height?: number } | undefined;
      if (image?.width && image?.height) u.markAspect.value = image.width / image.height;
      u.markMap.value = markTexture;
      u.markEnabled.value = 1;
    } else {
      u.markEnabled.value = 0;
      u.markMap.value = MARK_PLACEHOLDER;
    }
    u.scroll.value = scrollRef ? scrollRef.current : scroll;
    if (paletteA) (u.paletteA.value as THREE.Color).setRGB(paletteA[0], paletteA[1], paletteA[2]);
    if (paletteB) (u.paletteB.value as THREE.Color).setRGB(paletteB[0], paletteB[1], paletteB[2]);

    if (disableAnimation) {
      u.lightAngle.value = lightAngle;
      u.lightStrength.value = 0;
    } else if (tiltWithPointer) {
      smoothAngleRef.current += angleDelta(lightAngleRef.current, smoothAngleRef.current) * 0.12;
      smoothStrengthRef.current += (lightStrengthRef.current - smoothStrengthRef.current) * 0.12;
      u.lightAngle.value = smoothAngleRef.current;
      u.lightStrength.value = smoothStrengthRef.current;
    } else {
      u.lightAngle.value = lightAngle;
      u.lightStrength.value = lightStrength;
    }

    if (!prevColor.current.every((v, i) => v === waveColor[i])) {
      (u.waveColor.value as THREE.Color).set(...waveColor);
      prevColor.current = [...waveColor];
    }

    u.enableMouseInteraction.value = enableMouseInteraction ? 1 : 0;
    u.mouseRadius.value = mouseRadius;

    if (enableMouseInteraction && !isOcean) {
      (u.mousePos.value as THREE.Vector2).copy(mouseRef.current);
    }

    if (isOcean) {
      if (disableAnimation) {
        u.boatX.value = boatXRef.current;
        u.sailLean.value = sailLeanRef.current;
        u.boatBob.value = 0;
      } else {
        const windTarget = hasPointerRef.current
          ? windTargetRef.current
          : Math.sin(t * 0.25) * 0.35;
        sailLeanRef.current += (windTarget - sailLeanRef.current) * SAIL_LERP;
        velocityRef.current += sailLeanRef.current * WIND_ACCEL;
        velocityRef.current *= WIND_DRAG;
        boatXRef.current += velocityRef.current;
        boatXRef.current = Math.max(-BOAT_X_CLAMP, Math.min(BOAT_X_CLAMP, boatXRef.current));
        u.boatX.value = boatXRef.current;
        u.sailLean.value = sailLeanRef.current;
        u.boatBob.value = Math.sin(t * 1.1) * 0.012;
      }
    }
  });

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!enableMouseInteraction || isOcean) return;
    const rect = gl.domElement.getBoundingClientRect();
    const dpr = gl.getPixelRatio();
    mouseRef.current.set((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
  };

  return (
    <>
      <mesh scale={[viewport.width, viewport.height, 1]}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          ref={materialRef}
          vertexShader={waveVertexShader}
          fragmentShader={waveFragmentShader}
          uniforms={initialUniforms.current}
        />
      </mesh>

      {!paletteOn && (
        <EffectComposer>
          <RetroEffect colorNum={colorNum} pixelSize={pixelSize} />
        </EffectComposer>
      )}

      {!isOcean && variant !== 'isolines' && (
        <mesh
          onPointerMove={handlePointerMove}
          position={[0, 0, 0.01]}
          scale={[viewport.width, viewport.height, 1]}
          visible={false}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>
      )}
    </>
  );
}

export interface DitherProps {
  waveSpeed?: number;
  waveFrequency?: number;
  waveAmplitude?: number;
  waveColor?: [number, number, number];
  colorNum?: number;
  pixelSize?: number;
  disableAnimation?: boolean;
  enableMouseInteraction?: boolean;
  mouseRadius?: number;
  /**
   * `waves` = full-frame fbm (default, Bridge sea).
   * `ocean` = horizon water + mouse-wind sailboat.
   * `isolines` = stepped contour bands.
   */
  variant?: DitherVariant;
  /**
   * Two-stop palette applied after scalar Bayer quantise. Both stops are
   * required. Omit them and waves/ocean keep the legacy per-channel dither
   * (black through `waveColor`), which is what Bridge and the supply card use.
   */
  paletteA?: [number, number, number];
  paletteB?: [number, number, number];
  /** Pre-quantise multiplier. Used only when a palette is set. Default 1. */
  gain?: number;
  /** Subtracted before quantise. Used only when a palette is set. Default 0.2. */
  bias?: number;
  /** Radians. Directional shading is off when `lightStrength` is 0. */
  lightAngle?: number;
  /** 0 disables directional light. Also forced off when `disableAnimation` is set. */
  lightStrength?: number;
  /** Pointer position over the canvas tilts the light. Skipped when animation is disabled. */
  tiltWithPointer?: boolean;
  isoLevels?: number;
  isoLineWidth?: number;
  isoLineValue?: number;
  /** 0..1 pan of noise space. Prefer `scrollRef` when this changes every frame. */
  scroll?: number;
  scrollRef?: { current: number } | null;
  /** How far `scroll` shifts noise vertically, in uv units. 0 leaves sampling unchanged. */
  scrollParallax?: number;
  /** Draw the sail mark in the centre of an isoline field, in the same dither. */
  showMark?: boolean;
  /** Mount WebGL immediately without waiting for IntersectionObserver (used for above-the-fold hero). */
  eager?: boolean;
  className?: string;
}

const BAYER_8X8 = [
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
].map((v) => v / 64 - 0.25);

function Dither2DFallback({
  variant,
  paletteA,
  paletteB,
  waveColor,
  colorNum,
  pixelSize,
  gain,
  bias,
  isoLevels,
  isoLineWidth,
  isoLineValue,
  waveSpeed,
  waveFrequency,
  waveAmplitude,
  disableAnimation,
  showMark,
}: {
  variant: DitherVariant;
  paletteA: [number, number, number] | null;
  paletteB: [number, number, number] | null;
  waveColor: [number, number, number];
  colorNum: number;
  pixelSize: number;
  gain: number;
  bias: number;
  isoLevels: number;
  isoLineWidth: number;
  isoLineValue: number;
  waveSpeed: number;
  waveFrequency: number;
  waveAmplitude: number;
  disableAnimation: boolean;
  showMark: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let markAlpha: Uint8ClampedArray | null = null;
    let markW = 0;
    let markH = 0;

    if (showMark) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const off = document.createElement('canvas');
        off.width = 120;
        off.height = Math.max(1, Math.round((120 * img.height) / Math.max(1, img.width)));
        const octx = off.getContext('2d');
        if (octx) {
          octx.drawImage(img, 0, 0, off.width, off.height);
          const data = octx.getImageData(0, 0, off.width, off.height).data;
          const alpha = new Uint8ClampedArray(off.width * off.height);
          for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
          markAlpha = alpha;
          markW = off.width;
          markH = off.height;
        }
      };
      img.src = '/brand/nave-mark.png';
    }

    const colA = paletteA ?? [0, 0, 0];
    const colB = paletteB ?? waveColor;
    const levels = Math.max(colorNum, 2) - 1;
    const px = Math.max(1, Math.round(pixelSize));
    const start = performance.now();

    const noise2d = (x: number, y: number) => {
      const s1 = Math.sin(x * 1.7 + y * 2.3) * Math.cos(x * 1.1 - y * 1.9);
      const s2 = Math.sin(x * 3.1 - y * 2.7 + 1.4) * Math.cos(x * 2.5 + y * 3.3);
      return Math.abs(s1) * 0.65 + Math.abs(s2) * 0.35;
    };

    const fbm = (x: number, y: number) => {
      let val = 0;
      let amp = 1;
      let fx = x;
      let fy = y;
      for (let i = 0; i < 3; i++) {
        val += amp * noise2d(fx, fy);
        fx *= waveFrequency;
        fy *= waveFrequency;
        amp *= waveAmplitude;
      }
      return val;
    };

    const draw = (now: number) => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width / px));
      const h = Math.max(1, Math.floor(rect.height / px));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const imgData = ctx.createImageData(w, h);
      const out = imgData.data;
      const t = disableAnimation ? 0 : ((now - start) / 1000) * waveSpeed;
      const aspect = w / h;
      const nIso = Math.max(isoLevels, 1);

      for (let by = 0; by < h; by++) {
        const uy = -(by / h - 0.5);
        for (let bx = 0; bx < w; bx++) {
          const ux = (bx / w - 0.5) * aspect;
          const p2 = fbm(ux - t, uy - t);
          let v = fbm(ux + p2 * 0.4, uy + p2 * 0.4);
          if (variant === 'isolines') {
            const s = v * nIso;
            const band = Math.floor(s) / nIso;
            const fr = s - Math.floor(s);
            const edge = Math.min(fr, 1 - fr);
            const line = edge < isoLineWidth ? 1 - edge / Math.max(isoLineWidth, 0.0001) : 0;
            v = band + (isoLineValue - band) * line;
          }
          if (showMark && markAlpha && markW > 0 && markH > 0) {
            const mH = 0.68;
            const mW = mH * (markW / markH);
            const mx = ux / mW + 0.5;
            const my = 1 - (uy / mH + 0.5);
            if (mx > 0 && mx < 1 && my > 0 && my < 1) {
              const ix = Math.min(markW - 1, Math.floor(mx * markW));
              const iy = Math.min(markH - 1, Math.floor(my * markH));
              const a = markAlpha[iy * markW + ix] / 255;
              if (a > 0.5) {
                v = 0.84;
              } else if (a > 0.25) {
                v = 0.05;
              }
            }
          }
          const threshold = BAYER_8X8[(by & 7) * 8 + (bx & 7)];
          let c = v * gain + threshold / levels - bias;
          if (c < 0) c = 0;
          else if (c > 1) c = 1;
          const q = Math.floor(c * levels + 0.5) / levels;
          const idx = (by * w + bx) * 4;
          out[idx] = Math.round((colA[0] + (colB[0] - colA[0]) * q) * 255);
          out[idx + 1] = Math.round((colA[1] + (colB[1] - colA[1]) * q) * 255);
          out[idx + 2] = Math.round((colA[2] + (colB[2] - colA[2]) * q) * 255);
          out[idx + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      if (!disableAnimation) {
        raf = window.requestAnimationFrame(draw);
      }
    };

    draw(performance.now());
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [
    variant,
    paletteA,
    paletteB,
    waveColor,
    colorNum,
    pixelSize,
    gain,
    bias,
    isoLevels,
    isoLineWidth,
    isoLineValue,
    waveSpeed,
    waveFrequency,
    waveAmplitude,
    disableAnimation,
    showMark,
  ]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        imageRendering: 'pixelated',
        pointerEvents: 'none',
      }}
    />
  );
}

function isWebGLAvailable(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return true;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export default function Dither({
  waveSpeed = 0.05,
  waveFrequency = 3,
  waveAmplitude = 0.3,
  waveColor = [0.5, 0.5, 0.5],
  colorNum = 4,
  pixelSize = 2,
  disableAnimation = false,
  enableMouseInteraction = true,
  mouseRadius = 1,
  variant = 'waves',
  paletteA,
  paletteB,
  gain = 1,
  bias = 0.2,
  lightAngle = 0,
  lightStrength = 0,
  tiltWithPointer = false,
  isoLevels = 6,
  isoLineWidth = 0.06,
  isoLineValue = 0,
  scroll = 0,
  scrollRef = null,
  scrollParallax = 0,
  showMark = false,
  eager = false,
  className,
}: DitherProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(eager);
  const [use2DFallback, setUse2DFallback] = useState(() => !isWebGLAvailable());
  const [canvasKey, setCanvasKey] = useState(0);

  useEffect(() => {
    if (eager) {
      setInView(true);
      return;
    }
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setInView(entry.isIntersecting);
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [eager]);

  // Ocean wind and the hero light use a window listener — keep those canvases
  // non-interactive so CTAs stay clickable.
  const canvasPointerEvents =
    variant === 'ocean' || tiltWithPointer
      ? 'none'
      : enableMouseInteraction
        ? 'auto'
        : 'none';

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      {inView &&
        (use2DFallback ? (
          <Dither2DFallback
            variant={variant}
            paletteA={paletteA ?? null}
            paletteB={paletteB ?? null}
            waveColor={waveColor}
            colorNum={colorNum}
            pixelSize={pixelSize}
            gain={gain}
            bias={bias}
            isoLevels={isoLevels}
            isoLineWidth={isoLineWidth}
            isoLineValue={isoLineValue}
            waveSpeed={waveSpeed}
            waveFrequency={waveFrequency}
            waveAmplitude={waveAmplitude}
            disableAnimation={disableAnimation}
            showMark={showMark}
          />
        ) : (
          <Canvas
            key={canvasKey}
            style={{ width: '100%', height: '100%', pointerEvents: canvasPointerEvents }}
            camera={{ position: [0, 0, 6] }}
            dpr={1}
            frameloop="always"
            gl={{ antialias: true, preserveDrawingBuffer: true, alpha: true }}
            onCreated={({ gl }) => {
              gl.setClearColor(0x000000, 0);
              const dom = gl.domElement;
              const onLost = (e: Event) => {
                e.preventDefault();
                window.setTimeout(() => {
                  try {
                    if (gl.getContext().isContextLost()) {
                      setUse2DFallback(true);
                    } else {
                      setCanvasKey((k) => k + 1);
                    }
                  } catch {
                    setUse2DFallback(true);
                  }
                }, 400);
              };
              const onRestored = () => {
                setCanvasKey((k) => k + 1);
              };
              dom.addEventListener('webglcontextlost', onLost, false);
              dom.addEventListener('webglcontextrestored', onRestored, false);
            }}
          >
            <DitheredWaves
              waveSpeed={waveSpeed}
              waveFrequency={waveFrequency}
              waveAmplitude={waveAmplitude}
              waveColor={waveColor}
              colorNum={colorNum}
              pixelSize={pixelSize}
              disableAnimation={disableAnimation}
              enableMouseInteraction={enableMouseInteraction}
              mouseRadius={mouseRadius}
              variant={variant}
              paletteA={paletteA ?? null}
              paletteB={paletteB ?? null}
              gain={gain}
              bias={bias}
              lightAngle={lightAngle}
              lightStrength={lightStrength}
              tiltWithPointer={tiltWithPointer}
              isoLevels={isoLevels}
              isoLineWidth={isoLineWidth}
              isoLineValue={isoLineValue}
              scroll={scroll}
              scrollRef={scrollRef}
              scrollParallax={scrollParallax}
              showMark={showMark}
            />
          </Canvas>
        ))}
    </div>
  );
}
