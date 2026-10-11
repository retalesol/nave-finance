import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react';
import DitherGlyph from './DitherGlyph';
import { useAfterFirstPaint, usePrefersReducedMotion } from './useHomeMotion';
import { usePinProgress } from '../../hooks/usePinProgress';

const Dither = lazy(() => import('../Dither'));

const DEEP: [number, number, number] = [0x0b / 255, 0x12 / 255, 0x20 / 255];
const DEEP_DOT: [number, number, number] = [0x5b / 255, 0x6b / 255, 0x8c / 255];

const AGENTS = [
  {
    icon: 'crown',
    role: 'Executive Agent',
    tag: 'Strategic Coordinator',
    desc: 'Interprets governance proposals, coordinates treasury intent, validates constitutional alignment, and signs first multisig approval.',
  },
  {
    icon: 'money-bill-wave',
    role: 'Financial Agent',
    tag: 'Operations Layer',
    desc: 'Handles treasury execution, yield optimization, capital deployment, transaction preparation, and signs second multisig approval.',
  },
  {
    icon: 'eye',
    role: 'Operational Agent',
    tag: 'Safeguard Layer',
    desc: 'Enforces constitutional compliance, reviews all agent decisions, validates execution safety, and signs final multisig approval.',
  },
  {
    icon: 'gear',
    role: 'Oversight Agent',
    tag: 'Monitoring Layer',
    desc: 'Continuous treasury monitoring, accounting, analytics, optimization recommendations, suspicious activity detection, and emergency halt capabilities.',
  },
];

const STEPS = [
  { step: '01', label: 'Governance Vote', desc: 'DAO token holders approve proposal' },
  { step: '02', label: 'Executive Review', desc: 'Constitutional alignment validated, first signature' },
  { step: '03', label: 'Financial Execution', desc: 'Transaction prepared, profitability verified, second signature' },
  { step: '04', label: 'Operational Approval', desc: 'Compliance validated, final signature, treasury executes' },
];

const WP = [0.24, 0.45, 0.66, 0.87];
const HOLD = 0.05;

type Buoy = { x: number; y: number; above: boolean; y1: number; y2: number };

function easeInOut(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function pathD(w: number, h: number) {
  const P = (x: number, y: number) => `${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`;
  return (
    `M${P(0.03, 0.56)}` +
    ` C${P(0.14, 0.42)}, ${P(0.24, 0.62)}, ${P(0.36, 0.52)}` +
    ` C${P(0.48, 0.42)}, ${P(0.56, 0.62)}, ${P(0.66, 0.52)}` +
    ` C${P(0.78, 0.4)}, ${P(0.88, 0.58)}, ${P(0.97, 0.48)}`
  );
}

function lenAtX(path: SVGPathElement, length: number, x: number) {
  let lo = 0;
  let hi = length;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (path.getPointAtLength(mid).x < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function boatT(p: number, buoyLen: number[], length: number) {
  const keys: Array<[number, number]> = [[0.04, 0]];
  for (let i = 0; i < 4; i++) {
    const t = (buoyLen[i] ?? 0) / length;
    keys.push([WP[i], t], [WP[i] + HOLD, t]);
  }
  keys.push([1.01, (buoyLen[3] ?? 0) / length]);
  if (p <= keys[0][0]) return 0;
  for (let k = 0; k < keys.length - 1; k++) {
    if (p >= keys[k][0] && p < keys[k + 1][0]) {
      const u = (p - keys[k][0]) / (keys[k + 1][0] - keys[k][0]);
      return keys[k][1] + (keys[k + 1][1] - keys[k][1]) * easeInOut(u);
    }
  }
  return keys[keys.length - 1][1];
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 900px)').matches : false,
  );
  useLayoutEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export default function HomeRoute() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const showDither = useAfterFirstPaint();
  const narrow = useNarrow();
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dotsRef = useRef<SVGPathElement>(null);
  const doneRef = useRef<SVGPathElement>(null);
  const boatRef = useRef<SVGGElement>(null);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);
  const scrollRef = useRef(0);
  const progressRef = useRef(0);
  const geoRef = useRef({ length: 0, buoyLen: [0, 0, 0, 0] });
  const reachedRef = useRef(-1);
  const litKeyRef = useRef('');
  const [reached, setReached] = useState(-1);
  const [lit, setLit] = useState([false, false, false, false]);
  const [buoys, setBuoys] = useState<Buoy[]>([]);

  const applyRef = useRef<(p: number) => void>(() => {});
  applyRef.current = (p: number) => {
    const done = doneRef.current;
    const boat = boatRef.current;
    const { length, buoyLen } = geoRef.current;
    if (!done || !boat || length <= 1) return;
    const t = boatT(p, buoyLen, length);
    const along = t * length;
    const pt = done.getPointAtLength(along);
    const ahead = done.getPointAtLength(Math.min(length, along + 2));
    const back = done.getPointAtLength(Math.max(0, along - 2));
    const angle = (Math.atan2(ahead.y - back.y, ahead.x - back.x) * 180) / Math.PI;
    boat.setAttribute(
      'transform',
      `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)}) rotate(${(angle * 0.5).toFixed(1)})`,
    );
    boat.style.visibility = 'visible';
    done.style.strokeDasharray = `${length} ${length}`;
    done.style.strokeDashoffset = `${(length - along).toFixed(1)}`;

    let next = -1;
    for (let i = 0; i < 4; i++) if (p >= WP[i] - 0.012) next = i;
    if (next !== reachedRef.current) {
      reachedRef.current = next;
      setReached(next);
    }
    const litKey = `${p >= 0.05 ? 1 : 0}${next >= 0 ? 1 : 0}${next >= 1 ? 1 : 0}${next >= 2 ? 1 : 0}`;
    if (litKey !== litKeyRef.current) {
      litKeyRef.current = litKey;
      setLit([p >= 0.05, next >= 0, next >= 1, next >= 2]);
    }
  };

  const onProgress = useCallback((p: number) => {
    progressRef.current = p;
    scrollRef.current = p;
    applyRef.current(p);
  }, []);

  const sectionRef = usePinProgress<HTMLElement>(!narrow, onProgress);

  useLayoutEffect(() => {
    if (narrow) return;
    let cancel = false;
    const layout = () => {
      if (cancel) return;
      const stage = stageRef.current;
      const svg = svgRef.current;
      const dots = dotsRef.current;
      const done = doneRef.current;
      if (!stage || !svg || !dots || !done) return;
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (width < 10 || height < 10) return;
      const d = pathD(width, height);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      dots.setAttribute('d', d);
      done.setAttribute('d', d);
      const length = done.getTotalLength();
      if (!length) return;
      const stageRect = stage.getBoundingClientRect();
      const next: Buoy[] = [];
      const buoyLen = [0, 0, 0, 0];
      AGENTS.forEach((_, index) => {
        const card = cardRefs.current[index];
        if (!card) return;
        const cardRect = card.getBoundingClientRect();
        if (cardRect.width < 8) return;
        const cx = cardRect.left + cardRect.width / 2 - stageRect.left;
        const along = lenAtX(done, length, cx);
        const pt = done.getPointAtLength(along);
        buoyLen[index] = along;
        const above = index % 2 === 0;
        next.push({
          x: pt.x,
          y: pt.y,
          above,
          y1: pt.y + (above ? 10 : 44),
          y2: cardRect.top - stageRect.top - 10,
        });
      });
      if (next.length !== 4) return;
      geoRef.current = { length, buoyLen };
      setBuoys((prev) => {
        if (
          prev.length === next.length &&
          prev.every((buoy, index) => Math.abs(buoy.x - next[index].x) < 0.5 && Math.abs(buoy.y - next[index].y) < 0.5)
        ) {
          return prev;
        }
        return next;
      });
      applyRef.current(progressRef.current);
    };
    layout();
    const observer = new ResizeObserver(layout);
    if (stageRef.current) observer.observe(stageRef.current);
    document.fonts?.ready.then(() => layout());
    return () => {
      cancel = true;
      observer.disconnect();
    };
  }, [narrow]);

  useLayoutEffect(() => {
    if (!narrow) applyRef.current(progressRef.current);
  }, [narrow, buoys, reached, lit]);

  return (
    <section id="protocol" ref={sectionRef} className={`home-route home-deep${narrow ? ' is-unpinned' : ''}`}>
      <div className="home-route-stage" ref={stageRef}>
        <div className="home-route-sea" aria-hidden>
          {showDither && (
            <Suspense fallback={null}>
              <Dither
                variant="waves"
                paletteA={DEEP}
                paletteB={DEEP_DOT}
                gain={0.8}
                bias={0.22}
                colorNum={4}
                pixelSize={3}
                waveSpeed={0.05}
                waveFrequency={3}
                waveAmplitude={0.3}
                scrollRef={scrollRef}
                scrollParallax={0.35}
                disableAnimation={prefersReducedMotion}
                enableMouseInteraction={false}
                mouseRadius={0}
              />
            </Suspense>
          )}
        </div>
        <div className="home-route-vignette" aria-hidden />
        <svg className="home-route-chart" ref={svgRef} aria-hidden>
          <defs>
            <radialGradient id="home-glow-light">
              <stop offset="0" stopColor="#ECE7DB" stopOpacity="0.55" />
              <stop offset="0.5" stopColor="#ECE7DB" stopOpacity="0.12" />
              <stop offset="1" stopColor="#ECE7DB" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="home-glow-brass">
              <stop offset="0" stopColor="#C9A24A" stopOpacity="0.8" />
              <stop offset="0.45" stopColor="#C9A24A" stopOpacity="0.22" />
              <stop offset="1" stopColor="#C9A24A" stopOpacity="0" />
            </radialGradient>
          </defs>
          <path ref={dotsRef} className="course-dots" />
          <path ref={doneRef} className="course-done" />
          {buoys.map((buoy, index) => (
            <line
              key={`drop-${AGENTS[index].role}`}
              className="home-drop"
              x1={buoy.x}
              x2={buoy.x}
              y1={buoy.y1}
              y2={buoy.y2}
            />
          ))}
          {buoys.map((buoy, index) => (
            <g
              key={AGENTS[index].role}
              className={`home-buoy${index === 3 ? ' is-final' : ''}${index <= reached ? ' is-lit' : ''}`}
              transform={`translate(${buoy.x.toFixed(1)} ${buoy.y.toFixed(1)})`}
            >
              <circle className="glow" r="30" fill={`url(#${index === 3 ? 'home-glow-brass' : 'home-glow-light'})`} />
              <circle className="ring" r="6.5" />
              <circle className="dot" r="2.4" />
              <text className="lbl" x="0" y={buoy.above ? -20 : 28} textAnchor="middle">
                {AGENTS[index].role}
              </text>
              <text className="sub" x="0" y={buoy.above ? -33 : 41} textAnchor="middle">
                {AGENTS[index].tag}
              </text>
            </g>
          ))}
          <g ref={boatRef} className="home-boat">
            <g className="home-boat-bob">
              <path className="wake" d="M-34 7 Q-22 4 -14 7 T6 7" />
              <path className="hull" d="M-13 0 L13 0 L8 6 L-8 6 Z" />
              <path className="mast" d="M0 0 L0 -17" />
              <path className="sail" d="M1.5 -16 L1.5 -2 L12 -2 Z" />
              <path className="sail" d="M-1.5 -11 L-1.5 -2 L-8 -2 Z" opacity="0.7" />
            </g>
          </g>
        </svg>

        <div className="home-route-head">
          <div className="nave-section-label">Protocol Architecture</div>
          <h2 className="text-display">
            Multi-Agent Constitutional
            <br />
            <span className="home-ital">Treasury Governance</span>
          </h2>
          <p className="home-route-sub">
            Every Nave DAO operates through four permanent soulbound AI agents —
            identity-bound fiduciary operators acting under constitutional mandates.
          </p>
        </div>

        <aside className="home-route-flow">
          <div className="nave-label home-flow-label">
            <span>Execution Flow</span>
            <span>3-key multisig</span>
          </div>
          {STEPS.map((step, index) => (
            <div
              key={step.step}
              className={`home-flow-step${lit[index] ? ' is-lit' : ''}${index === 3 ? ' is-final' : ''}`}
            >
              <span className="pip" />
              <span className="n">{step.step}</span>
              <div>
                <div className="l">{step.label}</div>
                <div className="d">{step.desc}</div>
              </div>
            </div>
          ))}
        </aside>

        <div className="home-route-cards">
          {AGENTS.map((agent, index) => (
            <article
              key={agent.role}
              ref={(node) => {
                cardRefs.current[index] = node;
              }}
              className={`home-agent${index === reached ? ' is-active' : ''}${index < reached ? ' is-passed' : ''}${index === 3 ? ' is-final' : ''}`}
            >
              <div className="home-agent-top">
                <DitherGlyph name={agent.icon} small />
              </div>
              <div>
                <div className="home-agent-role">{agent.role}</div>
                <div className="home-agent-tag">{agent.tag}</div>
              </div>
              <p>{agent.desc}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
