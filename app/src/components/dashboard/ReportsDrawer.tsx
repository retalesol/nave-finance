import { useState } from 'react';
import { createPortal } from 'react-dom';
import Fi from '../Fi';
import { type YearlyReportGroup, type MonthlyReport } from '../../hooks/useMonthlyReports';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function KvRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'green' | 'red';
}) {
  const color =
    tone === 'green'
      ? 'hsl(var(--success))'
      : tone === 'red'
        ? 'hsl(var(--destructive))'
        : 'hsl(var(--foreground))';
  return (
    <div
      className="flex items-center justify-between gap-5"
      style={{
        padding: '12px 0',
        borderBottom: '1px solid hsl(var(--surface-2))',
        fontSize: '13.5px',
      }}
    >
      <span style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
      <b
        style={{
          fontWeight: 500,
          textAlign: 'right',
          color,
        }}
      >
        {value}
      </b>
    </div>
  );
}

/* ── Report Modal (calm statement style matching demo.html) ── */
export function ReportModal({ report, onClose }: { report: MonthlyReport; onClose: () => void }) {
  const year = report.year;
  const monthName = MONTH_NAMES[report.month - 1] ?? `Month ${report.month}`;
  const netGain = report.capitalEnd - report.capitalStart;
  const totalActions =
    report.agentActionsCount + report.walletActionsCount + report.proposalsCount;

  function handleDownload() {
    const lines = [
      `NAVE — TREASURY STATEMENT`,
      `${monthName} ${year}`,
      ``,
      `Opening balance: $${report.capitalStart.toLocaleString()}`,
      `Yield earned: +$${report.yieldEarned.toLocaleString()}`,
      `Closing balance: $${report.capitalEnd.toLocaleString()}`,
      `Net treasury gain: +$${netGain.toLocaleString()}`,
      `Period return: ${report.returnPct >= 0 ? '+' : ''}${report.returnPct.toFixed(2)}%`,
      `Agent actions: ${report.agentActionsCount}`,
      `Wallet actions: ${report.walletActionsCount}`,
      `Proposals: ${report.proposalsCount}`,
      `Protocol fees: $${report.feesCollected.toLocaleString()}`,
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `nave-statement-${monthName.toLowerCase()}-${year}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-4 pt-[7vh]"
      style={{
        backgroundColor: 'rgba(17, 24, 39, 0.48)',
        backdropFilter: 'blur(3px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-[540px] mb-8 overflow-hidden flex flex-col"
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '18px',
          border: '1px solid hsl(var(--border))',
          boxShadow: '0 24px 70px -12px rgba(17, 24, 39, 0.35)',
        }}
      >
        {/* Modal Header */}
        <div
          className="flex items-start gap-3.5"
          style={{ padding: '20px 22px 0' }}
        >
          <div className="flex-1 min-w-0">
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '23px',
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
                margin: 0,
                color: 'hsl(var(--foreground))',
              }}
            >
              {monthName} {year} statement
            </h3>
            <div
              style={{
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
                marginTop: '4px',
                lineHeight: 1.5,
              }}
            >
              Treasury statement · {totalActions} recorded action{totalActions !== 1 ? 's' : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex items-center justify-center flex-shrink-0 transition-colors"
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              backgroundColor: 'hsl(var(--background))',
              border: '1px solid hsl(var(--surface-2))',
              color: 'hsl(var(--muted-foreground))',
              fontSize: '14px',
            }}
            aria-label="Close"
          >
            <Fi icon="xmark" style={{ fontSize: '14px' }} />
          </button>
        </div>

        {/* Statement Body */}
        <div style={{ padding: '18px 22px 22px' }}>
          <KvRow label="Opening balance" value={`$${report.capitalStart.toLocaleString()}`} />
          <KvRow
            label="Yield earned"
            value={`+$${report.yieldEarned.toLocaleString()}`}
            tone="green"
          />
          <KvRow label="Closing balance" value={`$${report.capitalEnd.toLocaleString()}`} />
          <KvRow
            label="Net treasury gain"
            value={`${netGain >= 0 ? '+' : ''}$${netGain.toLocaleString()}`}
            tone={netGain >= 0 ? 'green' : 'red'}
          />
          <KvRow
            label="Period return"
            value={`${report.returnPct >= 0 ? '+' : ''}${report.returnPct.toFixed(2)}%`}
            tone={report.returnPct >= 0 ? 'green' : 'red'}
          />
          <KvRow
            label="Activity"
            value={`${report.agentActionsCount} agent · ${report.walletActionsCount} wallet · ${report.proposalsCount} decisions`}
          />
          <KvRow
            label="Protocol fees"
            value={`$${report.feesCollected.toLocaleString()}`}
          />

          <div
            style={{
              marginTop: '14px',
              backgroundColor: 'hsl(var(--background))',
              border: '1px solid hsl(var(--surface-2))',
              borderRadius: '12px',
              padding: '13px 14px',
              fontSize: '13px',
              color: 'hsl(var(--muted-foreground))',
              lineHeight: 1.6,
            }}
          >
            Deposits and earnings are always shown separately, so growth is never confused with new money in.
          </div>

          <div
            className="flex items-center justify-end gap-2 flex-wrap"
            style={{
              marginTop: '20px',
              paddingTop: '16px',
              borderTop: '1px solid hsl(var(--surface-2))',
            }}
          >
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-[9px] font-semibold transition-colors"
              style={{
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
                backgroundColor: 'transparent',
              }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] font-semibold transition-colors"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--foreground))',
                color: '#ffffff',
              }}
            >
              <Fi icon="download" style={{ fontSize: '11px' }} />
              Export
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Reports Drawer (calm paper/hairline style) ─────────────── */
export default function ReportsDrawer({
  open,
  onClose,
  reports,
}: {
  open: boolean;
  onClose: () => void;
  reports: YearlyReportGroup[];
}) {
  const [openYears, setOpenYears] = useState<number[]>([]);
  const [activeReport, setActiveReport] = useState<MonthlyReport | null>(null);

  function toggleYear(y: number) {
    setOpenYears((prev) => (prev.includes(y) ? prev.filter((x) => x !== y) : [...prev, y]));
  }

  return createPortal(
    <>
      {open && (
        <div
          className="fixed inset-0 z-40"
          style={{
            backgroundColor: 'rgba(17, 24, 39, 0.32)',
            backdropFilter: 'blur(2px)',
          }}
          onClick={onClose}
        />
      )}

      <div
        className="fixed top-0 right-0 bottom-0 z-50 flex flex-col border-l w-full sm:w-[380px]"
        style={{
          backgroundColor: 'hsl(var(--background))',
          borderColor: 'hsl(var(--border))',
          boxShadow: 'var(--shadow-xl)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b flex-shrink-0"
          style={{ borderColor: 'hsl(var(--surface-2))' }}
        >
          <div>
            <div className="nave-label" style={{ marginBottom: '6px' }}>Reports</div>
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '26px',
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
                margin: 0,
                color: 'hsl(var(--foreground))',
              }}
            >
              Monthly statements,{' '}
              <em style={{ fontStyle: 'italic', color: 'hsl(var(--muted-foreground))' }}>
                ready to share.
              </em>
            </h2>
            <p
              style={{
                fontSize: '13px',
                color: 'hsl(var(--muted-foreground))',
                marginTop: '6px',
                lineHeight: 1.5,
              }}
            >
              One page per month — what came in, what was earned, what your agents did.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center flex-shrink-0 transition-colors"
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              backgroundColor: '#ffffff',
              border: '1px solid hsl(var(--border))',
              color: 'hsl(var(--muted-foreground))',
            }}
            aria-label="Close"
          >
            <Fi icon="xmark" style={{ fontSize: '13px' }} />
          </button>
        </div>

        {/* Year / Month list */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {reports.length === 0 && (
            <div style={{ padding: '32px 0' }}>
              <p
                style={{
                  fontSize: '13.5px',
                  color: 'hsl(var(--muted-foreground))',
                  lineHeight: 1.6,
                }}
              >
                No reports yet. Monthly statements are generated automatically as the treasury operates.
              </p>
            </div>
          )}
          {reports.map(({ year, months }) => {
            const expanded = openYears.includes(year) || openYears.length === 0;
            return (
              <div key={year} style={{ marginBottom: '18px' }}>
                <button
                  type="button"
                  onClick={() => toggleYear(year)}
                  className="w-full flex items-center justify-between py-2 border-b bg-transparent"
                  style={{
                    borderColor: 'hsl(var(--border))',
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  <span className="nave-label">{year}</span>
                  <div className="flex items-center gap-2">
                    <span
                      className="nave-mono"
                      style={{ fontSize: '11px', color: 'hsl(var(--faint))' }}
                    >
                      {months.length} statement{months.length !== 1 ? 's' : ''}
                    </span>
                    <Fi
                      icon={expanded ? 'chevron-up' : 'chevron-down'}
                      style={{ fontSize: '10px', color: 'hsl(var(--faint))' }}
                    />
                  </div>
                </button>

                {expanded && (
                  <div>
                    {months.map((m) => {
                      const monthLabel = MONTH_NAMES[m.month - 1] ?? `Month ${m.month}`;
                      return (
                        <button
                          type="button"
                          key={m.month}
                          onClick={() => setActiveReport(m)}
                          className="w-full flex items-start justify-between gap-3 text-left bg-transparent border-0 group cursor-pointer"
                          style={{
                            padding: '13px 0',
                            borderBottom: '1px solid hsl(var(--surface-2))',
                          }}
                        >
                          <div className="min-w-0">
                            <div
                              className="group-hover:text-brass transition-colors"
                              style={{
                                fontSize: '14px',
                                fontWeight: 500,
                                color: 'hsl(var(--foreground))',
                              }}
                            >
                              {monthLabel} {year}
                            </div>
                            <div
                              style={{
                                fontSize: '12.5px',
                                color: 'hsl(var(--muted-foreground))',
                                marginTop: '2px',
                              }}
                            >
                              +${m.yieldEarned.toLocaleString()} earned · {m.agentActionsCount} agent actions
                            </div>
                          </div>
                          <span
                            style={{
                              fontSize: '12px',
                              fontWeight: 600,
                              color: 'hsl(var(--success))',
                              whiteSpace: 'nowrap',
                              paddingTop: '2px',
                            }}
                          >
                            Ready ✓
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {activeReport && (
        <ReportModal
          report={activeReport}
          onClose={() => setActiveReport(null)}
        />
      )}
    </>,
    document.body,
  );
}
