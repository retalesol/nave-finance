/**
 * 24×24 Bayer glyphs for the homepage. Silhouette edges stay solid;
 * the interior is shaded top-left to bottom-right and ordered-dithered.
 * Other pages keep the Fi icon font.
 */

const N = 24;
const B4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function len(x: number, y: number) {
  return Math.sqrt(x * x + y * y);
}

function circle(px: number, py: number, cx: number, cy: number, r: number) {
  return len(px - cx, py - cy) - r;
}

function ellipse(px: number, py: number, cx: number, cy: number, rx: number, ry: number) {
  return (len((px - cx) / rx, (py - cy) / ry) - 1) * Math.min(rx, ry);
}

function box(px: number, py: number, x0: number, y0: number, x1: number, y1: number) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2;
  const hy = (y1 - y0) / 2;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  return len(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function seg(px: number, py: number, ax: number, ay: number, bx: number, by: number, w: number) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return len(pax - bax * h, pay - bay * h) - w;
}

function poly(px: number, py: number, v: Array<[number, number]>) {
  let d = Infinity;
  let s = 1;
  const n = v.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ex = v[j][0] - v[i][0];
    const ey = v[j][1] - v[i][1];
    const wx = px - v[i][0];
    const wy = py - v[i][1];
    const h = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * h;
    const by = wy - ey * h;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= v[i][1];
    const c2 = py < v[j][1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

function U(...args: number[]) {
  let m = Infinity;
  for (const value of args) m = Math.min(m, value);
  return m;
}

function S(a: number, b: number) {
  return Math.max(a, -b);
}

function I(a: number, b: number) {
  return Math.max(a, b);
}

function plus(px: number, py: number, cx: number, cy: number, r: number, w: number) {
  return U(box(px, py, cx - w, cy - r, cx + w, cy + r), box(px, py, cx - r, cy - w, cx + r, cy + w));
}

const shapes: Record<string, (x: number, y: number) => number> = {
  book: (x, y) =>
    U(
      poly(x, y, [[3, 4.5], [11.2, 6.5], [11.2, 20], [3, 18]]),
      poly(x, y, [[21, 4.5], [12.8, 6.5], [12.8, 20], [21, 18]]),
      seg(x, y, 12, 6.5, 12, 20, 0.5),
    ),
  'share-nodes': (x, y) =>
    U(
      circle(x, y, 6, 12, 3.4),
      circle(x, y, 18, 5.5, 3.4),
      circle(x, y, 18, 18.5, 3.4),
      seg(x, y, 6, 12, 18, 5.5, 1.0),
      seg(x, y, 6, 12, 18, 18.5, 1.0),
    ),
  desktop: (x, y) => U(box(x, y, 2, 3.5, 22, 16.5), box(x, y, 10.5, 16.5, 13.5, 19.5), box(x, y, 6, 19.5, 18, 21.5)),
  shield: (x, y) => poly(x, y, [[12, 2], [21, 5.5], [21, 12], [12, 22], [3, 12], [3, 5.5]]),
  database: (x, y) => {
    const body = U(ellipse(x, y, 12, 6, 9, 3.2), box(x, y, 3, 6, 21, 18), ellipse(x, y, 12, 18, 9, 3.2));
    return S(body, U(box(x, y, 3, 10.4, 21, 11.3), box(x, y, 3, 14.4, 21, 15.3)));
  },
  'layer-group': (x, y) =>
    U(
      poly(x, y, [[12, 2.5], [21, 7.5], [12, 12.5], [3, 7.5]]),
      seg(x, y, 3, 12, 12, 17, 1.0),
      seg(x, y, 12, 17, 21, 12, 1.0),
      seg(x, y, 3, 16.5, 12, 21.5, 1.0),
      seg(x, y, 12, 21.5, 21, 16.5, 1.0),
    ),
  crown: (x, y) =>
    U(poly(x, y, [[3, 19], [3, 7.5], [8, 12], [12, 4], [16, 12], [21, 7.5], [21, 19]]), box(x, y, 3, 17, 21, 20.5)),
  'money-bill-wave': (x, y) => U(S(box(x, y, 2, 6, 22, 18), circle(x, y, 12, 12, 3.8)), circle(x, y, 12, 12, 1.8)),
  eye: (x, y) => {
    const lens = I(circle(x, y, 12, 3.5, 11.8), circle(x, y, 12, 20.5, 11.8));
    return U(S(lens, circle(x, y, 12, 12, 3.8)), circle(x, y, 12, 12, 1.9));
  },
  gear: (x, y) => {
    const dx = x - 12;
    const dy = y - 12;
    const r = len(dx, dy);
    const th = Math.atan2(dy, dx);
    const tooth = Math.cos(th * 8) > 0 ? 9.8 : 7.6;
    return Math.max(r - tooth, 3.4 - r);
  },
  code: (x, y) =>
    U(
      seg(x, y, 9, 5, 3, 12, 1.3),
      seg(x, y, 3, 12, 9, 19, 1.3),
      seg(x, y, 15, 5, 21, 12, 1.3),
      seg(x, y, 21, 12, 15, 19, 1.3),
      seg(x, y, 13.8, 4, 10.2, 20, 1.0),
    ),
  users: (x, y) => {
    const p1 = U(circle(x, y, 9, 7.5, 3.5), I(circle(x, y, 9, 19.5, 7), y - 19.5));
    const p2 = U(circle(x, y, 17.5, 8.5, 2.8), I(circle(x, y, 17.5, 19.5, 5.4), y - 19.5));
    return U(p1, S(p2, p1 - 1.4));
  },
  gamepad: (x, y) => {
    const pad = U(box(x, y, 3, 8, 21, 17), circle(x, y, 6.5, 16, 3.2), circle(x, y, 17.5, 16, 3.2));
    return S(pad, U(plus(x, y, 7.5, 12.5, 2.4, 0.8), circle(x, y, 15.6, 11.3, 1.1), circle(x, y, 18.6, 13.7, 1.1)));
  },
  landmark: (x, y) =>
    U(
      poly(x, y, [[12, 2], [22, 8.5], [2, 8.5]]),
      box(x, y, 2, 19, 22, 22),
      box(x, y, 3, 9.5, 5.5, 18),
      box(x, y, 8.2, 9.5, 10.7, 18),
      box(x, y, 13.3, 9.5, 15.8, 18),
      box(x, y, 18.5, 9.5, 21, 18),
    ),
  globe: (x, y) =>
    U(
      S(circle(x, y, 12, 12, 10), circle(x, y, 12, 12, 8.4)),
      S(ellipse(x, y, 12, 12, 4.6, 10), ellipse(x, y, 12, 12, 3.0, 8.4)),
      box(x, y, 2, 11.2, 22, 12.8),
    ),
  'wand-magic-sparkles': (x, y) => {
    const star = U(poly(x, y, [[18, 1.5], [19.6, 4.4], [22.5, 6], [19.6, 7.6], [18, 10.5], [16.4, 7.6], [13.5, 6], [16.4, 4.4]]));
    return U(seg(x, y, 4, 20, 14.5, 9.5, 1.6), star, plus(x, y, 5, 5.5, 2.2, 0.6), plus(x, y, 20.5, 15.5, 1.8, 0.6));
  },
  ship: (x, y) =>
    U(
      poly(x, y, [[2, 15], [22, 15], [19, 21], [5, 21]]),
      box(x, y, 11.4, 3, 12.6, 15),
      poly(x, y, [[12.8, 4], [12.8, 13.2], [20.5, 13.2]]),
      poly(x, y, [[11.2, 6.5], [11.2, 13.2], [5.5, 13.2]]),
    ),
  signal: (x, y) =>
    U(box(x, y, 2.5, 17, 6, 21.5), box(x, y, 7.5, 13, 11, 21.5), box(x, y, 12.5, 8.5, 16, 21.5), box(x, y, 17.5, 3, 21, 21.5)),
  coins: (x, y) => {
    let stack = U(ellipse(x, y, 9.5, 9, 7.5, 3), box(x, y, 2, 9, 17, 17), ellipse(x, y, 9.5, 17, 7.5, 3));
    stack = S(stack, box(x, y, 2, 12.6, 17, 13.4));
    return U(stack, S(ellipse(x, y, 17.5, 7, 4.5, 2.2), ellipse(x, y, 17.5, 7, 3.1, 1.2)));
  },
};

const cache = new Map<string, string>();

export function glyphPath(name: string) {
  const cached = cache.get(name);
  if (cached) return cached;
  const f = shapes[name] ?? shapes.shield;
  let d = '';
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const sd = f(x + 0.5, y + 0.5);
      if (sd > 0.15) continue;
      const on = sd > -1.7 ? true : 0.95 - 0.68 * ((x + y) / (2 * N - 2)) > (B4[y % 4][x % 4] + 0.5) / 16;
      if (on) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  cache.set(name, d);
  return d;
}

export default function DitherGlyph({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={small ? 'home-glyph sm' : 'home-glyph'} aria-hidden>
      <svg viewBox="0 0 24 24">
        <path fill="currentColor" d={glyphPath(name)} />
      </svg>
    </span>
  );
}
