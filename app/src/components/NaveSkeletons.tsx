/**
 * Design-system skeleton primitives for Nave loading states.
 *
 * Every skeleton uses the same shimmer animation defined via CSS keyframes
 * in index.css (`@keyframes nave-shimmer`). Skeletons match the exact
 * dimensions and border-radius of the real cards/rows they replace so
 * the layout doesn't shift when data arrives.
 */

/* ── Base shimmer bar ──────────────────────────────────────── */
function Bar({
  w = '100%',
  h = '14px',
  r = '6px',
  className = '',
}: {
  w?: string;
  h?: string;
  r?: string;
  className?: string;
}) {
  return (
    <div
      className={`nave-shimmer ${className}`}
      style={{
        width: w,
        height: h,
        borderRadius: r,
        backgroundColor: 'hsl(var(--surface-2))',
      }}
    />
  );
}

/* ── Metric card skeleton ──────────────────────────────────── */
export function MetricSkeleton() {
  return (
    <div
      className="nave-card p-4 space-y-2.5"
      style={{ minHeight: '88px' }}
    >
      <Bar w="55%" h="10px" />
      <Bar w="40%" h="24px" r="8px" />
      <Bar w="30%" h="10px" />
    </div>
  );
}

/* ── Chart card skeleton (full-width area chart placeholder) ─ */
export function ChartSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="nave-card overflow-hidden">
      <div
        className="flex items-center justify-between px-5 py-4 border-b"
        style={{ borderColor: 'hsl(var(--border))' }}
      >
        <div className="space-y-1.5">
          <Bar w="110px" h="14px" />
          <Bar w="70px" h="10px" />
        </div>
        <Bar w="60px" h="14px" />
      </div>
      <div className="p-5">
        <div
          className="nave-shimmer"
          style={{
            width: '100%',
            height: `${height}px`,
            borderRadius: '12px',
            backgroundColor: 'hsl(var(--surface-1))',
          }}
        />
      </div>
    </div>
  );
}

/* ── Row skeleton (single table/list row) ──────────────────── */
export function RowSkeleton({ cols = 3 }: { cols?: number }) {
  return (
    <div
      className="flex items-center gap-4 px-5 py-3.5"
      style={{ borderBottom: '1px solid hsl(var(--border))' }}
    >
      <div
        className="w-6 h-6 rounded-full nave-shimmer flex-shrink-0"
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      />
      {Array.from({ length: cols }).map((_, i) => (
        <Bar
          key={i}
          w={i === 0 ? '40%' : i === 1 ? '25%' : '15%'}
          h="12px"
        />
      ))}
    </div>
  );
}

/* ── Table skeleton (header + N rows) ──────────────────────── */
export function TableSkeleton({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="nave-card overflow-hidden">
      <div
        className="flex items-center justify-between px-5 py-4 border-b"
        style={{ borderColor: 'hsl(var(--border))' }}
      >
        <Bar w="120px" h="14px" />
        <Bar w="50px" h="12px" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <RowSkeleton key={i} cols={cols} />
      ))}
    </div>
  );
}

/* ── Card skeleton (generic card with heading + body) ──────── */
export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="nave-card p-5 space-y-3">
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg nave-shimmer flex-shrink-0"
          style={{ backgroundColor: 'hsl(var(--surface-2))' }}
        />
        <div className="space-y-1.5 flex-1">
          <Bar w="60%" h="14px" />
          <Bar w="40%" h="10px" />
        </div>
      </div>
      {Array.from({ length: lines }).map((_, i) => (
        <Bar key={i} w={`${80 - i * 12}%`} h="12px" />
      ))}
    </div>
  );
}

/* ── Donut / small panel skeleton ─────────────────────────── */
export function PanelSkeleton() {
  return (
    <div className="nave-card p-5 space-y-4">
      <Bar w="80px" h="10px" />
      <div className="flex items-center gap-4">
        <div
          className="nave-shimmer flex-shrink-0"
          style={{
            width: '100px',
            height: '100px',
            borderRadius: '50%',
            backgroundColor: 'hsl(var(--surface-2))',
          }}
        />
        <div className="space-y-2 flex-1">
          <Bar w="100%" h="10px" />
          <Bar w="80%" h="10px" />
          <Bar w="60%" h="10px" />
        </div>
      </div>
    </div>
  );
}

/* ── Agent card skeleton ──────────────────────────────────── */
export function AgentCardSkeleton() {
  return (
    <div className="nave-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg nave-shimmer"
            style={{ backgroundColor: 'hsl(var(--surface-2))' }}
          />
          <div className="space-y-1.5">
            <Bar w="110px" h="14px" />
            <Bar w="80px" h="10px" />
          </div>
        </div>
        <Bar w="50px" h="20px" r="10px" />
      </div>
      <div className="space-y-1.5 pt-1">
        <Bar w="90%" h="10px" />
        <Bar w="75%" h="10px" />
        <Bar w="85%" h="10px" />
        <Bar w="65%" h="10px" />
      </div>
      <div
        className="flex items-center gap-4 pt-3 border-t"
        style={{ borderColor: 'hsl(var(--border))' }}
      >
        <Bar w="60px" h="10px" />
        <Bar w="60px" h="10px" />
        <Bar w="40px" h="10px" />
      </div>
    </div>
  );
}

/* ── Proposal card skeleton ───────────────────────────────── */
export function ProposalCardSkeleton() {
  return (
    <div
      className="p-5 rounded-xl border space-y-3"
      style={{
        backgroundColor: 'hsl(var(--surface-0))',
        borderColor: 'hsl(var(--border))',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bar w="50px" h="20px" r="10px" />
          <Bar w="60px" h="20px" r="10px" />
        </div>
        <Bar w="90px" h="10px" />
      </div>
      <Bar w="80%" h="16px" />
      <Bar w="100%" h="10px" />
      <Bar w="60%" h="10px" />
      <div className="flex gap-3 pt-2">
        <Bar w="30%" h="8px" />
        <Bar w="30%" h="8px" />
      </div>
    </div>
  );
}

/* ── Full-page loading state (used inside NaveLayout) ─────── */
export function PageSkeleton({ variant = 'dashboard' }: { variant?: 'dashboard' | 'agent' | 'governance' | 'settings' }) {
  if (variant === 'agent') {
    return (
      <div className="p-6 space-y-6 animate-fade-in">
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <Bar w="260px" h="24px" />
            <Bar w="340px" h="12px" />
          </div>
          <Bar w="140px" h="36px" r="8px" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <MetricSkeleton key={i} />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <AgentCardSkeleton key={i} />)}
        </div>
        <TableSkeleton rows={4} cols={3} />
      </div>
    );
  }

  if (variant === 'governance') {
    return (
      <div className="p-6 space-y-5 animate-fade-in">
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <Bar w="200px" h="24px" />
            <Bar w="280px" h="12px" />
          </div>
          <Bar w="130px" h="36px" r="8px" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => <MetricSkeleton key={i} />)}
        </div>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <ProposalCardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  if (variant === 'settings') {
    return (
      <div className="p-6 space-y-5 animate-fade-in">
        <div className="space-y-1.5">
          <Bar w="160px" h="24px" />
          <Bar w="250px" h="12px" />
        </div>
        <CardSkeleton lines={4} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={2} />
      </div>
    );
  }

  // dashboard default
  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Bar w="200px" h="22px" />
          <Bar w="150px" h="12px" />
        </div>
        <div className="flex gap-2">
          <Bar w="100px" h="36px" r="8px" />
          <Bar w="80px" h="36px" r="8px" />
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <MetricSkeleton key={i} />)}
      </div>
      <ChartSkeleton />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartSkeleton height={140} />
        <PanelSkeleton />
      </div>
      <TableSkeleton rows={4} />
    </div>
  );
}
