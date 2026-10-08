/* eslint-disable react/no-unknown-property */
import { useRef, useEffect, forwardRef } from 'react';
import { Canvas, useFrame, useThree, ThreeEvent } from '@react-three/fiber';
import { EffectComposer, wrapEffect } from '@react-three/postprocessing';
import { Effect } from 'postprocessing';
import * as THREE from 'three';

export type DitherVariant = 'waves' | 'ocean';

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

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  uv -= 0.5;
  uv.x *= resolution.x / resolution.y;
  float f = pattern(uv);

  // Wave-dent mouse interaction: waves mode only.
  if (sceneMode == 0 && enableMouseInteraction == 1) {
    vec2 mouseNDC = (mousePos / resolution - 0.5) * vec2(1.0, -1.0);
    mouseNDC.x *= resolution.x / resolution.y;
    float dist = length(uv - mouseNDC);
    float effect = 1.0 - smoothstep(0.0, mouseRadius, dist);
    f -= 0.5 * effect;
  }

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
`;

const ditherFragmentShader = `
precision highp float;
uniform float colorNum;
uniform float pixelSize;
const float bayerMatrix8x8[64] = float[64](
  0.0/64.0, 48.0/64.0, 12.0/64.0, 60.0/64.0,  3.0/64.0, 51.0/64.0, 15.0/64.0, 63.0/64.0,
  32.0/64.0,16.0/64.0, 44.0/64.0, 28.0/64.0, 35.0/64.0,19.0/64.0, 47.0/64.0, 31.0/64.0,
  8.0/64.0, 56.0/64.0,  4.0/64.0, 52.0/64.0, 11.0/64.0,59.0/64.0,  7.0/64.0, 55.0/64.0,
  40.0/64.0,24.0/64.0, 36.0/64.0, 20.0/64.0, 43.0/64.0,27.0/64.0, 39.0/64.0, 23.0/64.0,
  2.0/64.0, 50.0/64.0, 14.0/64.0, 62.0/64.0,  1.0/64.0,49.0/64.0, 13.0/64.0, 61.0/64.0,
  34.0/64.0,18.0/64.0, 46.0/64.0, 30.0/64.0, 33.0/64.0,17.0/64.0, 45.0/64.0, 29.0/64.0,
  10.0/64.0,58.0/64.0,  6.0/64.0, 54.0/64.0,  9.0/64.0,57.0/64.0,  5.0/64.0, 53.0/64.0,
  42.0/64.0,26.0/64.0, 38.0/64.0, 22.0/64.0, 41.0/64.0,25.0/64.0, 37.0/64.0, 21.0/64.0
);

vec3 dither(vec2 uv, vec3 color) {
  vec2 scaledCoord = floor(uv * resolution / pixelSize);
  int x = int(mod(scaledCoord.x, 8.0));
  int y = int(mod(scaledCoord.y, 8.0));
  float threshold = bayerMatrix8x8[y * 8 + x] - 0.25;
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
}

const BOAT_X_CLAMP = 0.62;
const SAIL_LERP = 0.045;
const WIND_ACCEL = 0.00055;
const WIND_DRAG = 0.982;

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
}: DitheredWavesProps) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const mouseRef = useRef(new THREE.Vector2());
  /** Normalized wind target −1…1 from window pointer X (ocean only). */
  const windTargetRef = useRef(0);
  const hasPointerRef = useRef(false);
  const sailLeanRef = useRef(0);
  const velocityRef = useRef(0);
  const boatXRef = useRef(0);
  const { viewport, size, gl } = useThree();
  const isOcean = variant === 'ocean';
  const sceneMode = isOcean ? 1 : 0;

  // Three.js ShaderMaterial clones uniforms on init — keep a stable source object
  // and always mutate materialRef.current.uniforms in useFrame (not this ref).
  const initialUniforms = useRef<WaveUniforms>({
    time: new THREE.Uniform(0),
    resolution: new THREE.Uniform(new THREE.Vector2(1, 1)),
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
  });

  useEffect(() => {
    const dpr = gl.getPixelRatio();
    const newWidth = Math.floor(size.width * dpr);
    const newHeight = Math.floor(size.height * dpr);
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

  const prevColor = useRef([...waveColor]);
  useFrame(({ clock }) => {
    const mat = materialRef.current;
    if (!mat) return;
    const u = mat.uniforms as WaveUniforms;

    const t = clock.getElapsedTime();
    if (!disableAnimation) {
      u.time.value = t;
    }

    u.waveSpeed.value = waveSpeed;
    u.waveFrequency.value = waveFrequency;
    u.waveAmplitude.value = waveAmplitude;
    u.sceneMode.value = sceneMode;

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

      <EffectComposer>
        <RetroEffect colorNum={colorNum} pixelSize={pixelSize} />
      </EffectComposer>

      {!isOcean && (
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
  /** `ocean` = horizon water + mouse-wind sailboat (homepage hero). Default `waves`. */
  variant?: DitherVariant;
  className?: string;
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
  className,
}: DitherProps) {
  // Ocean wind uses a window listener — keep canvas non-interactive so CTAs stay clickable.
  const canvasPointerEvents =
    variant === 'ocean' ? 'none' : enableMouseInteraction ? 'auto' : 'none';

  return (
    <Canvas
      className={className}
      style={{ width: '100%', height: '100%', pointerEvents: canvasPointerEvents }}
      camera={{ position: [0, 0, 6] }}
      dpr={1}
      frameloop="always"
      gl={{ antialias: true, preserveDrawingBuffer: true, alpha: true }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
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
      />
    </Canvas>
  );
}
