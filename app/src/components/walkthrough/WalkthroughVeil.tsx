import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import Dither from '../Dither';
import NaveMark from '../NaveMark';
import { CAPTION_HEIGHT, placeCaption, type CaptionBox } from './placeCaption';
import type { WalkthroughStep } from './steps';

const PAPER: [number, number, number] = [0xfa / 255, 0xf8 / 255, 0xf3 / 255];
const INK: [number, number, number] = [0x11 / 255, 0x18 / 255, 0x27 / 255];

type Rect = { x: number; y: number; w: number; h: number };
type Dock = { x: number; y: number; flip: boolean };
type Pose = Dock & { bob: boolean };

const VEIL_ALPHA = 0.62;
const NARROW_QUERY = '(max-width: 899px)';
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener('change', onChange);
    setMatches(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function targetElement(root: HTMLElement, tourId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-tour="${tourId}"], [data-onboarding-id="${tourId}"]`);
}

function stepIds(step: Pick<WalkthroughStep, 'target' | 'parts'>): string[] {
  return step.parts && step.parts.length > 0 ? [...step.parts] : [step.target];
}

function revealTarget(root: HTMLElement, step: Pick<WalkthroughStep, 'target' | 'parts'>) {
  const scroller = root.querySelector('main');
  if (!scroller) return;
  const target = stepIds(step)
    .map((id) => targetElement(root, id))
    .find((el) => el && scroller.contains(el));
  if (!target) return;
  const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
  if (Math.abs(delta) > 2) scroller.scrollTop += delta;
}

function measureTarget(root: HTMLElement, step: Pick<WalkthroughStep, 'target' | 'parts' | 'roomy'>): Rect | null {
  revealTarget(root, step);
  const rootBox = root.getBoundingClientRect();
  const ids = stepIds(step);
  const elements = ids.map((id) => targetElement(root, id));
  if (elements.some((el) => !el)) return null;
  const boxes: DOMRect[] = [];
  for (const el of elements) {
    if (!el) continue;
    boxes.push(el.getBoundingClientRect());
    el.querySelectorAll<HTMLElement>('[data-tour-part]').forEach((part) => {
      boxes.push(part.getBoundingClientRect());
    });
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    if (box.width === 0 && box.height === 0) continue;
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  if (!Number.isFinite(left)) return null;
  const pad = step.roomy ? 14 : 8;
  let x = left - rootBox.left - pad;
  let y = top - rootBox.top - pad;
  let w = right - left + pad * 2;
  let h = bottom - top + pad * 2;
  const maxH = step.roomy ? rootBox.height - 36 : Math.min(rootBox.height - 24, 520);
  if (y < 8) {
    h -= 8 - y;
    y = 8;
  }
  if (h > maxH) h = maxH;
  if (x < 8) {
    w -= 8 - x;
    x = 8;
  }
  if (x + w > rootBox.width - 8) w = rootBox.width - 8 - x;
  if (w < 48 || h < 48) return null;
  return { x, y, w, h };
}

function shipHitsCaption(dock: Dock, caption: CaptionBox): boolean {
  const width = 72;
  const height = 86;
  const left = dock.x - width / 2;
  const top = dock.y - height / 2;
  return !(
    left + width < caption.left
    || caption.left + caption.width < left
    || top + height < caption.top
    || caption.top + CAPTION_HEIGHT < top
  );
}

function chooseDock(rect: Rect, from: Dock | null, caption: CaptionBox, vw: number, vh: number, roomy = false): Dock {
  if (roomy) {
    const boatX = clamp(caption.left + caption.width / 2, 96, Math.max(96, vw - 96));
    return {
      x: boatX,
      y: Math.max(64, caption.top - 86),
      flip: boatX > rect.x + rect.w / 2,
    };
  }
  const cy = rect.y + rect.h / 2;
  const cx = rect.x + rect.w / 2;
  const gap = 78;
  const sides: Dock[] = [
    { x: rect.x - gap, y: cy, flip: false },
    { x: rect.x + rect.w + gap, y: cy, flip: true },
  ];
  const vertical: Dock[] = [
    { x: cx, y: rect.y - gap, flip: from ? from.x < cx : false },
    { x: cx, y: rect.y + rect.h + gap, flip: from ? from.x < cx : false },
  ];
  const onScreen = (dock: Dock) => dock.x > 28 && dock.x < vw - 28 && dock.y > 28 && dock.y < vh - 28;
  const clear = (docks: Dock[]) => docks.filter((dock) => onScreen(dock) && !shipHitsCaption(dock, caption));
  const sidePool = clear(sides);
  const pool = sidePool.length ? sidePool : (clear(vertical).length ? clear(vertical) : (sides.filter(onScreen).length ? sides.filter(onScreen) : sides));
  if (!from) return pool[0];
  return [...pool].sort((a, b) => {
    const da = (a.x - from.x) ** 2 + (a.y - from.y) ** 2;
    const db = (b.x - from.x) ** 2 + (b.y - from.y) ** 2;
    return db - da;
  })[0];
}

function shipAboveCaption(caption: CaptionBox, vw: number, targetCx: number): Dock {
  const x = clamp(caption.left + caption.width / 2, 36, Math.max(36, vw - 36));
  return {
    x,
    y: Math.max(40, caption.top - 42),
    flip: x > targetCx,
  };
}

function parted(target: Rect, ease: number): Rect {
  const width = Math.max(3, target.w * ease);
  return {
    x: target.x + (target.w - width) / 2,
    y: target.y,
    w: width,
    h: target.h,
  };
}

function sailPoint(a: Dock, b: Dock, t: number): { x: number; y: number; tx: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const lift = Math.min(140, Math.max(56, len * 0.62));
  let px = -dy / len;
  let py = dx / len;
  if (py > 0) {
    px *= -1;
    py *= -1;
  }
  const cx = (a.x + b.x) / 2 + px * lift;
  const cy = (a.y + b.y) / 2 + py * lift;
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * cx + t * t * b.x,
    y: u * u * a.y + 2 * u * t * cy + t * t * b.y,
    tx: 2 * u * (cx - a.x) + 2 * t * (b.x - cx),
  };
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const n = (value: number) => value.toFixed(1);
  return [
    `M${n(x + rr)},${n(y)}`,
    `H${n(x + w - rr)}`,
    `A${n(rr)},${n(rr)} 0 0 1 ${n(x + w)},${n(y + rr)}`,
    `V${n(y + h - rr)}`,
    `A${n(rr)},${n(rr)} 0 0 1 ${n(x + w - rr)},${n(y + h)}`,
    `H${n(x + rr)}`,
    `A${n(rr)},${n(rr)} 0 0 1 ${n(x)},${n(y + h - rr)}`,
    `V${n(y + rr)}`,
    `A${n(rr)},${n(rr)} 0 0 1 ${n(x + rr)},${n(y)}Z`,
  ].join(' ');
}

function maskStyle(hole: Rect | null, width: number, height: number, radius = 16): CSSProperties {
  if (!hole || width < 2 || height < 2) return {};
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path fill="white" fill-rule="evenodd" d="M0,0H${width}V${height}H0Z ${roundedRect(hole.x, hole.y, hole.w, hole.h, radius)}"/></svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return {
    WebkitMaskImage: url,
    maskImage: url,
    WebkitMaskSize: '100% 100%',
    maskSize: '100% 100%',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
  };
}

const BOAT_W = 56;
const INTRO_W = 176;
const BOAT_SCALE = BOAT_W / INTRO_W;

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

function DitherSail({ width }: { width: number }) {
  const height = Math.round(width * (722 / 597));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const image = ctx.getImageData(0, 0, width, height);
      const data = image.data;
      const cell = width < 96 ? 1 : 2;
      for (let y = 0; y < height; y += cell) {
        for (let x = 0; x < width; x += cell) {
          const i = (y * width + x) * 4;
          const alpha = data[i + 3];
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          if (alpha > 190) {
            const threshold = BAYER[((Math.floor(y / cell)) & 7) * 8 + ((Math.floor(x / cell)) & 7)] / 64;
            const stitch = threshold > 0.58;
            r = stitch ? 72 : 8;
            g = stitch ? 84 : 14;
            b = stitch ? 108 : 26;
            a = 255;
          } else if (alpha > 24) {
            r = 11;
            g = 18;
            b = 32;
            a = 255;
          }
          for (let dy = 0; dy < cell; dy += 1) {
            for (let dx = 0; dx < cell; dx += 1) {
              const px = x + dx;
              const py = y + dy;
              if (px >= width || py >= height) continue;
              const j = (py * width + px) * 4;
              data[j] = r;
              data[j + 1] = g;
              data[j + 2] = b;
              data[j + 3] = a;
            }
          }
        }
      }
      ctx.putImageData(image, 0, 0);
    };
    img.src = '/brand/nave-mark.png';
    return () => {
      img.onload = null;
    };
  }, [width, height]);
  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      aria-hidden
      style={{ display: 'block', width, height }}
    />
  );
}

function darkDitherFill(): string {
  if (typeof document === 'undefined') return '#0B1220';
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '#0B1220';
  const image = ctx.createImageData(8, 8);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const ink = BAYER[y * 8 + x] > 30;
      const i = (y * 8 + x) * 4;
      image.data[i] = ink ? 7 : 86;
      image.data[i + 1] = ink ? 11 : 94;
      image.data[i + 2] = ink ? 20 : 112;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

const DARK_DITHER = darkDitherFill();

const Sea = memo(function Sea({ frozen }: { frozen: boolean }) {
  return (
    <Dither
      variant="waves"
      paletteA={PAPER}
      paletteB={INK}
      gain={0.9}
      bias={0.22}
      colorNum={4}
      pixelSize={3}
      waveSpeed={0.035}
      waveFrequency={2.8}
      waveAmplitude={0.34}
      enableMouseInteraction={false}
      disableAnimation={frozen}
      lightStrength={0}
      eager
    />
  );
});

function HomepageShip({ pose }: { pose: Pose }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        left: pose.x,
        top: pose.y,
        zIndex: 4,
        pointerEvents: 'none',
        transform: `translate(-50%, -62%) scaleX(${pose.flip ? -1 : 1})`,
      }}
    >
      <div className={pose.bob ? 'wt-bob' : undefined}>
        <DitherSail width={BOAT_W} />
      </div>
    </div>
  );
}

type BrandReveal = 'full' | 'mark' | 'none';
type OutroPhase = 'idle' | 'move' | 'blue' | 'word' | 'clear';
type Spot = { x: number; y: number; w: number; h: number };

type VeilProps = {
  stageRef: RefObject<HTMLDivElement | null>;
  step: WalkthroughStep;
  index: number;
  total: number;
  closing: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onReveal: (reveal: BrandReveal) => void;
  onClosed: () => void;
  /** Live treasury tour. Skip the boat prelude so the first step is immediate. */
  skipPrelude?: boolean;
};

function measureSpot(root: HTMLElement, id: string): Spot | null {
  const el = root.querySelector<HTMLElement>(`[data-tour="${id}"]`);
  if (!el) return null;
  const rootBox = root.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  return {
    x: box.left - rootBox.left,
    y: box.top - rootBox.top,
    w: box.width,
    h: box.height,
  };
}

export default function WalkthroughVeil({
  stageRef,
  step,
  index,
  total,
  closing,
  onBack,
  onNext,
  onSkip,
  onReveal,
  onClosed,
  skipPrelude = false,
}: VeilProps) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const reduce = useMediaQuery(REDUCE_QUERY);
  const [hole, setHole] = useState<Rect | null>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [pose, setPose] = useState<Pose | null>(null);
  const [caption, setCaption] = useState<CaptionBox | null>(null);
  const [veilOpacity, setVeilOpacity] = useState(1);
  const [fadeVeil, setFadeVeil] = useState(false);
  const [prelude, setPrelude] = useState<'blank' | 'setting' | 'fill' | 'fade' | 'gap' | 'boat' | 'hold' | 'travel' | 'done'>(
    reduce || skipPrelude ? 'done' : 'blank',
  );
  const [arrival, setArrival] = useState<Dock | null>(null);
  const [outro, setOutro] = useState<OutroPhase>('idle');
  const [brand, setBrand] = useState<Spot | null>(null);
  const [word, setWord] = useState<Spot | null>(null);
  const dockRef = useRef<Dock | null>(null);
  const playedRef = useRef<string | null>(null);
  const [readyTick, setReadyTick] = useState(0);

  useEffect(() => {
    const root = stageRef.current;
    if (!root || measureTarget(root, step)) return;
    let frames = 0;
    let frame = 0;
    const look = () => {
      frames += 1;
      if (measureTarget(root, step) || frames > 40) {
        setReadyTick((tick) => tick + 1);
        return;
      }
      frame = window.requestAnimationFrame(look);
    };
    frame = window.requestAnimationFrame(look);
    return () => window.cancelAnimationFrame(frame);
  }, [stageRef, step.id, step.target]);

  useEffect(() => {
    if (prelude !== 'travel') return;
    const id = window.setTimeout(() => setPrelude('done'), 3100);
    return () => window.clearTimeout(id);
  }, [prelude]);

  useEffect(() => {
    if (reduce || skipPrelude) {
      setPrelude('done');
      return;
    }
    const timers = [
      window.setTimeout(() => setPrelude('setting'), 2000),
      window.setTimeout(() => setPrelude('fill'), 5000),
      window.setTimeout(() => setPrelude('fade'), 8000),
      window.setTimeout(() => setPrelude('gap'), 11000),
      window.setTimeout(() => setPrelude('boat'), 13000),
      window.setTimeout(() => setPrelude('hold'), 16000),
      window.setTimeout(() => setPrelude('travel'), 18000),
    ];
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [reduce, skipPrelude]);

  useEffect(() => {
    if (prelude !== 'travel' || arrival) return;
    const id = window.setTimeout(() => setArrival({ x: 124, y: 148, flip: false }), 500);
    return () => window.clearTimeout(id);
  }, [prelude, arrival]);

  const onRevealRef = useRef(onReveal);
  const onClosedRef = useRef(onClosed);
  onRevealRef.current = onReveal;
  onClosedRef.current = onClosed;

  useEffect(() => {
    if (!closing) return;
    if (reduce) {
      onRevealRef.current('full');
      onClosedRef.current();
      return;
    }
    setOutro('move');
    const blue = window.setTimeout(() => {
      setOutro('blue');
      onRevealRef.current('mark');
    }, 1500);
    const named = window.setTimeout(() => {
      setOutro('word');
      onRevealRef.current('full');
    }, 2300);
    const clear = window.setTimeout(() => setOutro('clear'), 3100);
    const done = window.setTimeout(() => onClosedRef.current(), 4000);
    return () => {
      window.clearTimeout(blue);
      window.clearTimeout(named);
      window.clearTimeout(clear);
      window.clearTimeout(done);
    };
  }, [closing, reduce]);

  useLayoutEffect(() => {
    if (prelude === 'done') return;
    if (prelude === 'travel') return;
    const root = stageRef.current;
    if (!root) return;
    const place = () => {
      const rect = measureTarget(root, step);
      const vw = root.clientWidth;
      const vh = root.clientHeight;
      setFrame({ w: vw, h: vh });
      if (!rect) return;
      const captionBox = placeCaption(rect, vw, vh, narrow, step.roomy);
      setArrival(chooseDock(rect, null, captionBox, vw, vh, Boolean(step.roomy)));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [narrow, prelude, stageRef, step]);

  useLayoutEffect(() => {
    if (!closing) return;
    const root = stageRef.current;
    if (!root) return;
    setHole(null);
    setCaption(null);
    setBrand(measureSpot(root, 'tour-brand'));
    setWord(measureSpot(root, 'tour-brand-word'));
  }, [closing, stageRef]);

  useLayoutEffect(() => {
    if (prelude !== 'done' || closing) return;
    const root = stageRef.current;
    if (!root) return;
    const rect = measureTarget(root, step);
    if (!rect) return;
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    const captionBox = placeCaption(rect, vw, vh, narrow, step.roomy);
    setCaption(captionBox);
    setFrame({ w: vw, h: vh });

    const chosen = chooseDock(rect, dockRef.current, captionBox, vw, vh, Boolean(step.roomy));
    const toDock = dockRef.current ? chosen : { ...chosen, flip: false };
    const fromDock = dockRef.current;
    const fresh = playedRef.current !== step.id;
    if (fresh) playedRef.current = step.id;

    let raf = 0;
    let sailing = false;
    const parkAt = (box: CaptionBox, dock: Dock, width: number, bob: boolean, targetCx: number) => {
      const parked = narrow ? shipAboveCaption(box, width, targetCx) : dock;
      setPose({ ...parked, bob });
      dockRef.current = dock;
    };
    const park = (bob: boolean) => parkAt(captionBox, toDock, vw, bob, rect.x + rect.w / 2);

    const onResize = () => {
      if (sailing) return;
      const nextRoot = stageRef.current;
      if (!nextRoot) return;
      const next = measureTarget(nextRoot, step);
      if (!next) return;
      const nextVw = nextRoot.clientWidth;
      const nextVh = nextRoot.clientHeight;
      const nextCaption = placeCaption(next, nextVw, nextVh, narrow, step.roomy);
      const nextDock = chooseDock(next, dockRef.current, nextCaption, nextVw, nextVh, Boolean(step.roomy));
      setCaption(nextCaption);
      setFrame({ w: nextVw, h: nextVh });
      setHole(next);
      parkAt(nextCaption, nextDock, nextVw, !reduce, next.x + next.w / 2);
    };

    if (!fresh) {
      setHole(rect);
      setVeilOpacity(1);
      setFadeVeil(false);
      park(!reduce);
    } else if (reduce) {
      setHole(rect);
      setFadeVeil(false);
      setVeilOpacity(0);
      park(false);
      raf = window.requestAnimationFrame(() => {
        setFadeVeil(true);
        setVeilOpacity(1);
      });
    } else {
      const playShip = !narrow && fromDock != null;
      const start = performance.now();
      const travel = fromDock ? Math.hypot(toDock.x - fromDock.x, toDock.y - fromDock.y) : 0;
      const duration = Math.min(1500, Math.max(980, 700 + travel * 0.45));
      sailing = playShip;
      setFadeVeil(false);
      setVeilOpacity(1);
      setHole(parted(rect, 0.03));
      if (!playShip) park(true);

      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const ease = 1 - (1 - t) ** 3;
        setHole(parted(rect, Math.max(ease, 0.03)));
        if (playShip && fromDock) {
          const point = sailPoint(fromDock, toDock, ease);
          setPose({
            x: point.x,
            y: point.y,
            flip: t > 0.92 ? toDock.flip : point.tx < -0.5,
            bob: false,
          });
        }
        if (t < 1) {
          raf = window.requestAnimationFrame(tick);
          return;
        }
        sailing = false;
        setHole(rect);
        park(true);
      };
      raf = window.requestAnimationFrame(tick);
    }

    window.addEventListener('resize', onResize);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [closing, narrow, prelude, reduce, readyTick, stageRef, step.id, step.target, step.roomy]);

  const ghost: CSSProperties = {
    fontSize: '13px',
    fontWeight: 600,
    borderRadius: '9px',
    padding: '8px 14px',
    border: '1px solid #E7E2D6',
    background: '#fff',
    color: '#111827',
    cursor: 'pointer',
  };

  const seaOpacity = closing ? (outro === 'clear' ? 0 : 0.78) : (prelude === 'done' ? veilOpacity * VEIL_ALPHA : 1);
  const atLogo = outro !== 'idle';
  const logoScale = brand ? brand.w / BOAT_W : 0.46;

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30, pointerEvents: closing || prelude !== 'done' ? 'auto' : 'none' }}>
      <style>
        {`
          .wt-bob { animation: wt-bob 3.6s ease-in-out infinite; transform-origin: 50% 80%; }
          @keyframes wt-bob {
            0%, 100% { transform: translateY(0) rotate(-1.2deg); }
            50% { transform: translateY(-3px) rotate(1.2deg); }
          }
          .wt-nave-boat.nave-mark { width: 100%; height: 100%; color: #082B5B; }
          .wt-launch { opacity: 0; }
          .wt-launch.is-on { animation: wt-launch-in 1.4s ease forwards; }
          .wt-launch.is-held { opacity: 1; }
          .wt-launch.is-out { animation: wt-launch-out 3s linear forwards; }
          @keyframes wt-launch-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes wt-launch-out { from { opacity: 1; } to { opacity: 0; } }
          .wt-launch-title,
          .wt-await-title {
            margin: 0;
            font-family: var(--font-display);
            font-weight: 700;
            font-synthesis: weight;
            letter-spacing: -0.035em;
            white-space: nowrap;
            color: transparent;
            background-color: #0B1220;
            background-image: url(${DARK_DITHER});
            background-size: 32px 32px;
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            overflow: visible;
          }
          .wt-launch-title {
            font-size: clamp(96px, 12vw, 144px);
            line-height: 1.15;
            padding: 0.12em 0.04em 0.22em;
          }
          .wt-await-title {
            position: absolute;
            left: 50%;
            top: calc(46% + 108px);
            z-index: 2;
            transform: translateX(-50%);
            font-size: clamp(52px, 6.4vw, 78px);
            line-height: 1.15;
            padding: 0.1em 0.04em 0.18em;
            opacity: 0;
            pointer-events: none;
          }
          .wt-await-title.is-in { animation: wt-launch-in 3s ease forwards; }
          .wt-await-title.is-held { opacity: 1; }
          .wt-await-title.is-out { animation: wt-launch-out 3s linear forwards; }
          .wt-load {
            width: min(640px, 84vw);
            height: 28px;
            margin: 28px auto 0;
            overflow: hidden;
            background: transparent;
          }
          .wt-load-fill {
            width: 100%;
            height: 100%;
            transform-origin: left center;
            transform: scaleX(0);
            background-color: #0B1220;
            background-image: url(${DARK_DITHER});
            background-size: 32px 32px;
          }
          .wt-load-fill.is-filling { animation: wt-load 3s linear forwards; }
          .wt-load-fill.is-full { transform: scaleX(1); }
          @keyframes wt-load {
            from { transform: scaleX(0); }
            to { transform: scaleX(1); }
          }
          .wt-mark {
            position: absolute;
            left: 50%;
            top: 46%;
            z-index: 2;
            opacity: 0;
            pointer-events: none;
            transform: translate(-50%, -62%) scale(1);
            transform-origin: 50% 62%;
          }
          .wt-mark.is-in { animation: wt-boat-in 3s ease forwards; }
          .wt-mark.is-held { opacity: 1; }
          @keyframes wt-boat-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          .wt-mark.is-sailing { animation: wt-sail 3s cubic-bezier(0.45, 0, 0.2, 1) forwards; }
          @keyframes wt-sail {
            from { left: 50%; top: 46%; transform: translate(-50%, -62%) scale(1); opacity: 1; }
            to { left: var(--wt-to-x); top: var(--wt-to-y); transform: translate(-50%, -62%) scale(var(--wt-scale)); opacity: 1; }
          }
          @media (prefers-reduced-motion: reduce) {
            .wt-bob, .wt-load-fill, .wt-launch.is-on, .wt-launch.is-out, .wt-await-title.is-in, .wt-await-title.is-out, .wt-mark.is-in, .wt-mark.is-sailing { animation: none !important; }
          }
        `}
      </style>
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: '#FAF8F3',
          opacity: seaOpacity,
          transition: closing ? 'opacity 800ms ease' : (fadeVeil || prelude === 'done' ? 'opacity 640ms ease' : 'none'),
          ...maskStyle(hole, frame.w, frame.h),
        }}
      >
        <Sea frozen={reduce} />
      </div>
      {!closing && prelude === 'done' && pose ? <HomepageShip pose={pose} /> : null}
      {closing && pose && brand ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: atLogo ? brand.x + brand.w / 2 : pose.x,
            top: atLogo ? brand.y + brand.h / 2 : pose.y,
            zIndex: 5,
            pointerEvents: 'none',
            transform: atLogo
              ? `translate(-50%, -50%) scale(${logoScale})`
              : 'translate(-50%, -62%)',
            transformOrigin: '50% 50%',
            opacity: outro === 'idle' || outro === 'move' ? 1 : 0,
            transition: 'left 1.4s cubic-bezier(0.45, 0, 0.2, 1), top 1.4s cubic-bezier(0.45, 0, 0.2, 1), transform 1.4s cubic-bezier(0.45, 0, 0.2, 1), opacity 550ms ease',
          }}
        >
          <DitherSail width={BOAT_W} />
        </div>
      ) : null}
      {closing && brand ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: brand.x,
            top: brand.y,
            width: brand.w,
            height: brand.h,
            zIndex: 6,
            color: '#082B5B',
            opacity: outro === 'blue' || outro === 'word' || outro === 'clear' ? 1 : 0,
            transition: 'opacity 600ms ease',
            pointerEvents: 'none',
          }}
        >
          <NaveMark className="wt-nave-boat" />
        </div>
      ) : null}
      {closing && word ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: word.x,
            top: word.y,
            width: word.w,
            height: word.h,
            zIndex: 6,
            display: 'flex',
            alignItems: 'center',
            fontFamily: 'var(--font-display)',
            fontWeight: 400,
            fontSize: '18px',
            letterSpacing: '-0.02em',
            color: '#111827',
            opacity: outro === 'word' || outro === 'clear' ? 1 : 0,
            transition: 'opacity 500ms ease',
            pointerEvents: 'none',
          }}
        >
          Nave
        </div>
      ) : null}
      {prelude !== 'done' ? (
        <div role="status" aria-live="polite" style={{ position: 'absolute', inset: 0, zIndex: 6 }}>
          <div
            className={`wt-launch${prelude === 'setting' ? ' is-on' : ''}${prelude === 'fill' ? ' is-held' : ''}${prelude === 'fade' || prelude === 'gap' ? ' is-out' : ''}`}
            style={{
              position: 'absolute',
              left: '50%',
              top: '58%',
              width: 'min(1100px, calc(100% - 48px))',
              transform: 'translate(-50%, -50%)',
              textAlign: 'center',
              overflow: 'visible',
            }}
          >
            <p className="wt-launch-title">Setting Sail...</p>
            <div className="wt-load" aria-hidden>
              <div
                className={`wt-load-fill${prelude === 'fill' || prelude === 'fade' || prelude === 'gap' ? ' is-filling' : ''}${prelude === 'fade' || prelude === 'gap' ? ' is-full' : ''}`}
              />
            </div>
          </div>
          <p
            className={`wt-await-title${prelude === 'boat' ? ' is-in' : ''}${prelude === 'hold' ? ' is-held' : ''}${prelude === 'travel' ? ' is-out' : ''}`}
          >
            Treasury Awaits!
          </p>
          <div
            className={`wt-mark${prelude === 'boat' ? ' is-in' : ''}${prelude === 'hold' ? ' is-held' : ''}${prelude === 'travel' && arrival ? ' is-sailing' : ''}`}
            style={{
              ['--wt-to-x' as string]: `${arrival?.x ?? 120}px`,
              ['--wt-to-y' as string]: `${arrival?.y ?? 120}px`,
              ['--wt-scale' as string]: String(BOAT_SCALE),
            }}
            onAnimationEnd={(event) => {
              if (event.animationName === 'wt-sail') setPrelude('done');
            }}
          >
            <DitherSail width={INTRO_W} />
          </div>
        </div>
      ) : null}
      {!closing && prelude === 'done' && caption ? (
        <section
          aria-label="Walkthrough"
          style={{
            position: 'absolute',
            left: caption.left,
            top: caption.top,
            width: caption.width,
            zIndex: 3,
            pointerEvents: 'auto',
            background: '#fff',
            border: '1px solid #E7E2D6',
            borderRadius: '14px',
            boxShadow: '0 12px 40px rgba(17, 24, 39, 0.12)',
            padding: '14px 16px 16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <span style={{ fontSize: '12px', letterSpacing: '0.04em', color: '#B9974F', fontWeight: 600 }}>
              {index + 1} of {total}
            </span>
            <button
              type="button"
              onClick={onSkip}
              style={{
                background: 'transparent',
                border: 0,
                padding: 0,
                color: '#6B7280',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              Skip
            </button>
          </div>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 400,
              fontSize: '26px',
              letterSpacing: '-0.02em',
              lineHeight: 1.1,
              margin: '8px 0 0',
              color: '#111827',
            }}
          >
            {step.title}
          </h2>
          <p aria-live="polite" style={{ margin: '6px 0 0', fontSize: '14.5px', lineHeight: 1.5, color: '#6B7280' }}>
            {step.sentence}
          </p>
          <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
            <button type="button" onClick={onBack} disabled={index === 0} style={{ ...ghost, opacity: index === 0 ? 0.4 : 1, cursor: index === 0 ? 'default' : 'pointer' }}>
              Back
            </button>
            <button
              type="button"
              onClick={onNext}
              style={{
                ...ghost,
                marginLeft: 'auto',
                background: '#111827',
                borderColor: '#111827',
                color: '#fff',
              }}
            >
              {index >= total - 1 ? 'Done' : 'Next'}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
