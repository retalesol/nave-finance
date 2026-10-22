/**
 * Design-system skeleton primitives for Nave loading states.
 *
 * Every skeleton uses the same shimmer animation defined via CSS keyframes
 * in index.css (`@keyframes nave-shimmer`). Styled in the warm paper/hairline
 * aesthetic of demo.html.
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

/* ── Metric card skeleton (borderless stat) ────────────────── */
export function MetricSkeleton() {
  return (
    <div
      className="py-2 space-y-2"
      style={{ minHeight: '68px' }}
    >
      <Bar w="50%" h="10px" />
      <Bar w="40%" h="20px" r="6px" />
      <Bar w="60%" h="10px" />
    </div>
  );
}

/* ── Chart card skeleton (hairline section placeholder) ────── */
export function ChartSkeleton({ height = 180 }: { height?: number }) {
  return (
    <div
      className="py-6 border-t"
      style={{ borderColor: 'hsl(var(--surface-2))' }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="space-y-1.5">
          <Bar w="110px" h="14px" />
        </div>
        <Bar w="80px" h="14px" />
      </div>
      <div
        className="nave-shimmer"
        style={{
          width: '100%',
          height: `${height}px`,
          borderRadius: '10px',
          backgroundColor: 'hsl(var(--surface-1))',
        }}
      />
    </div>
  );
}

/* ── Row skeleton (single table/list row) ──────────────────── */
export function RowSkeleton({ cols = 3 }: { cols?: number }) {
  return (
    <div
      className="flex items-center gap-4 py-3.5"
      style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}
    >
      <div
        className="w-2 h-2 rounded-full nave-shimmer flex-shrink-0"
        style={{ backgroundColor: 'hsl(var(--border-strong))' }}
      />
      {Array.from({ length: cols }).map((_, i) => (
        <Bar
          key={i}
          w={i === 0 ? '45%' : i === 1 ? '30%' : '15%'}
          h="12px"
        />
      ))}
    </div>
  );
}

/* ── Table skeleton (header + N rows) ──────────────────────── */
export function TableSkeleton({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div
      className="py-5 border-t"
      style={{ borderColor: 'hsl(var(--surface-2))' }}
    >
      <div
        className="flex items-center justify-between pb-3 border-b"
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

/* ── Card skeleton (generic hairline section with heading + body) ── */
export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div
      className="py-5 border-t space-y-3"
      style={{ borderColor: 'hsl(var(--surface-2))' }}
    >
      <div className="space-y-1.5">
        <Bar w="45%" h="14px" />
        <Bar w="30%" h="10px" />
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
    <div
      className="py-5 border-t space-y-4"
      style={{ borderColor: 'hsl(var(--surface-2))' }}
    >
      <Bar w="80px" h="10px" />
      <div className="space-y-2.5">
        <Bar w="100%" h="10px" />
        <Bar w="80%" h="10px" />
        <Bar w="60%" h="10px" />
      </div>
    </div>
  );
}

/* ── Agent card skeleton ──────────────────────────────────── */
export function AgentCardSkeleton() {
  return (
    <div
      className="py-4 border-b space-y-2"
      style={{ borderColor: 'hsl(var(--surface-2))' }}
    >
      <div className="flex items-center justify-between">
        <Bar w="140px" h="14px" />
        <Bar w="50px" h="12px" r="6px" />
      </div>
      <Bar w="75%" h="12px" />
    </div>
  );
}

/* ── Proposal card skeleton ───────────────────────────────── */
export function ProposalCardSkeleton() {
  return (
    <div
      className="py-4 border-b space-y-2.5"
      style={{ borderColor: 'hsl(var(--surface-2))' }}
    >
      <div className="flex items-center justify-between">
        <Bar w="65%" h="15px" />
        <Bar w="80px" h="12px" />
      </div>
      <Bar w="85%" h="12px" />
      <Bar w="45%" h="6px" r="99px" />
    </div>
  );
}

/* ── Full-page loading state (used inside NaveLayout) ─────── */
export function PageSkeleton({ variant = 'dashboard' }: { variant?: 'dashboard' | 'agent' | 'governance' | 'settings' }) {
  if (variant === 'agent') {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Bar w="80px" h="10px" />
            <Bar w="260px" h="28px" />
            <Bar w="340px" h="13px" />
          </div>
          <Bar w="90px" h="28px" r="99px" />
        </div>
        <div className="border-t pt-4" style={{ borderColor: 'hsl(var(--surface-2))' }}>
          {Array.from({ length: 4 }).map((_, i) => <AgentCardSkeleton key={i} />)}
        </div>
        <TableSkeleton rows={3} cols={3} />
      </div>
    );
  }

  if (variant === 'governance') {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Bar w="80px" h="10px" />
            <Bar w="240px" h="28px" />
            <Bar w="300px" h="13px" />
          </div>
          <Bar w="130px" h="36px" r="9px" />
        </div>
        <div className="border-t pt-2" style={{ borderColor: 'hsl(var(--surface-2))' }}>
          {Array.from({ length: 3 }).map((_, i) => <ProposalCardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  if (variant === 'settings') {
    return (
      <div className="space-y-5 animate-fade-in">
        <div className="space-y-2">
          <Bar w="70px" h="10px" />
          <Bar w="180px" h="28px" />
          <Bar w="260px" h="13px" />
        </div>
        <CardSkeleton lines={4} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={2} />
      </div>
    );
  }

  // dashboard default
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Bar w="90px" h="10px" />
          <Bar w="240px" h="28px" />
          <Bar w="320px" h="13px" />
        </div>
        <Bar w="130px" h="36px" r="9px" />
      </div>
      <div className="py-4 space-y-2">
        <Bar w="90px" h="10px" />
        <Bar w="200px" h="48px" r="8px" />
        <Bar w="220px" h="12px" />
      </div>
      <ChartSkeleton />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {Array.from({ length: 3 }).map((_, i) => <MetricSkeleton key={i} />)}
      </div>
      <TableSkeleton rows={4} />
    </div>
  );
}
