import { forwardRef, useLayoutEffect, useRef, type CSSProperties } from 'react';
import Fi from '../Fi';
import NaveMark from '../NaveMark';
import AppBreadcrumb from '../AppBreadcrumb';
import { appBreadcrumbs } from '../../lib/breadcrumbs';
import { PAY_NAV_PRIMARY } from '../../lib/pay/nav';
import type { WalkthroughStep } from './steps';
import WalkthroughPages from './WalkthroughPages';

const PAPER = '#FAF8F3';
const INK = '#111827';
const MUTED = '#6B7280';
const FAINT = '#9CA3AF';
const HAIRLINE = '#EFEAE0';
const LINE = '#E7E2D6';
const BRASS = '#B9974F';

const NAVE_NAV = [
  { label: 'Overview', path: '/overview' },
  { label: 'Money', path: '/money' },
  { label: 'Agents', path: '/agents' },
  { label: 'Decisions', path: '/decisions' },
  { label: 'Rules', path: '/rules' },
  { label: 'Bridge', path: '/bridge' },
  { label: 'Stake', path: '/stake' },
  { label: 'Settings', path: '/settings' },
] as const;

function iconButtonStyle(): CSSProperties {
  return {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    border: `1px solid ${LINE}`,
    background: '#fff',
    color: INK,
    display: 'grid',
    placeItems: 'center',
    fontSize: '15px',
    flexShrink: 0,
    padding: 0,
  };
}

type StageProps = {
  step: WalkthroughStep;
  ended: boolean;
  brandReveal: 'full' | 'mark' | 'none';
};

const WalkthroughStage = forwardRef<HTMLDivElement, StageProps>(function WalkthroughStage(
  { step, ended, brandReveal },
  ref,
) {
  const mainRef = useRef<HTMLElement>(null);
  const product = ended ? 'nave' : step.product;
  const navPath = ended ? '/overview' : step.navPath;
  const inPay = product === 'pay';
  const showMenu = !ended && step.target === 'tour-product';
  const navItems = inPay ? PAY_NAV_PRIMARY : NAVE_NAV;
  const pageKey = ended ? 'overview' : step.page;
  const reveal = ended ? 'full' : brandReveal;

  useLayoutEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [pageKey]);

  return (
    <div
      ref={ref}
      data-walkthrough-beat={ended ? 'overview' : step.id}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        background: PAPER,
        color: INK,
        overflow: 'hidden',
      }}
    >
      <aside
        style={{
          position: 'relative',
          zIndex: 4,
          width: '210px',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          padding: '22px 18px',
          background: PAPER,
          borderRight: `1px solid ${HAIRLINE}`,
          overflow: 'visible',
        }}
      >
        <div data-tour="tour-product" style={{ position: 'relative' }}>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={showMenu}
            title="Switch product"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: 'transparent',
              border: 0,
              padding: 0,
              cursor: 'default',
              minWidth: 0,
            }}
          >
            <span
              data-tour="tour-brand"
              style={{
                display: 'inline-flex',
                opacity: reveal === 'none' ? 0 : 1,
                transition: 'opacity 600ms ease',
              }}
            >
              <NaveMark />
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                opacity: reveal === 'full' ? 1 : 0,
                transition: 'opacity 500ms ease',
              }}
            >
              <b
                data-tour="tour-brand-word"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 400,
                  fontSize: '18px',
                  letterSpacing: '-0.02em',
                  color: INK,
                  whiteSpace: 'nowrap',
                }}
              >
                {inPay ? 'Nave Pay' : 'Nave'}
              </b>
              <span style={{ color: MUTED, fontSize: '12px' }} aria-hidden>
                ⌄
              </span>
            </span>
          </button>
          {showMenu ? (
            <div
              data-tour-part
              style={{
                position: 'absolute',
                top: 'calc(100% + 10px)',
                left: 0,
                width: '268px',
                background: '#fff',
                border: `1px solid ${LINE}`,
                borderRadius: '12px',
                boxShadow: '0 12px 40px rgba(17, 24, 39, 0.08)',
                padding: '14px 14px 6px',
                zIndex: 5,
              }}
            >
              <div className="nave-label" style={{ marginBottom: '6px' }}>Switch product</div>
              <p style={{ fontSize: '12.5px', lineHeight: 1.5, color: MUTED, margin: '0 0 8px' }}>
                Nave runs the treasury. Nave Pay keeps the invoices and books.
              </p>
              {[
                { label: 'Nave', detail: 'Treasury', current: true },
                { label: 'Nave Pay', detail: 'Invoices and books', current: false },
              ].map((item) => (
                <div
                  key={item.label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 0',
                    borderTop: `1px solid ${HAIRLINE}`,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '14px', fontWeight: 500 }}>{item.label}</div>
                    <div style={{ fontSize: '12.5px', color: MUTED, marginTop: '2px' }}>{item.detail}</div>
                  </div>
                  <span style={{ fontSize: '12px', fontWeight: item.current ? 600 : 400, color: item.current ? '#2F7D4F' : MUTED }}>
                    {item.current ? 'Current' : 'Open →'}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: '28px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <span
            aria-hidden
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              display: 'grid',
              placeItems: 'center',
              background: '#F4F1EA',
              border: '1px solid #E7E2D6',
              color: MUTED,
              fontSize: 14,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            N
          </span>
          <span>
            <span style={{ display: 'block', fontSize: '13.5px', fontWeight: 600, lineHeight: 1.3 }}>Nave Test DAO</span>
            <span style={{ display: 'block', fontSize: '11.5px', color: FAINT, marginTop: 2 }}>Solana · nave.finance/nave ⌄</span>
          </span>
        </div>
        <div>
          <nav data-tour="tour-nav" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {navItems.map((item) => {
              const active = item.path === navPath;
              return (
                <div
                  key={item.path}
                  data-active={active ? 'true' : 'false'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '9px',
                    padding: '8px 10px',
                    borderRadius: '8px',
                    fontSize: '13.5px',
                    fontWeight: active ? 600 : 400,
                    color: active ? INK : MUTED,
                    background: active ? '#fff' : 'transparent',
                    boxShadow: active ? '0 1px 3px rgba(17, 24, 39, 0.05)' : 'none',
                  }}
                >
                  <span>{item.label}</span>
                  {item.path === '/agents' ? (
                    <span
                      title="Active"
                      style={{
                        marginLeft: 'auto',
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: '#2F7D4F',
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
            {inPay ? (
              <div style={{ marginTop: '8px', padding: '8px 10px', fontSize: '13px', color: MUTED }}>
                More books
              </div>
            ) : null}
          </nav>
        </div>
        {inPay ? null : (
          <div style={{ marginTop: '14px', padding: '8px 10px', fontSize: '13.5px', color: MUTED }}>
            + New treasury
          </div>
        )}

        <div
          style={{
            marginTop: 'auto',
            paddingTop: '18px',
            borderTop: `1px solid ${HAIRLINE}`,
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            fontSize: '12px',
            color: MUTED,
          }}
        >
          <span
            style={{
              width: '24px',
              height: '24px',
              borderRadius: '50%',
              background: BRASS,
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontSize: '9px',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            YO
          </span>
          <span style={{ lineHeight: 1.35 }}>
            <span style={{ color: MUTED }}>you.eth</span>
            <br />
            <span style={{ color: FAINT, fontSize: '11px' }}>Founder · connected</span>
          </span>
        </div>
      </aside>

      <div style={{ position: 'relative', zIndex: 1, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
            padding: '13px 32px',
            background: 'rgba(250, 248, 243, 0.9)',
            borderBottom: `1px solid ${HAIRLINE}`,
            flexShrink: 0,
          }}
        >
          <AppBreadcrumb crumbs={appBreadcrumbs(navPath)} />
          <div
            data-tour="tour-topbar"
            style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}
          >
            <button type="button" aria-label="Search" title="Search" style={iconButtonStyle()}>
              ⌕
            </button>
            <button type="button" aria-label="Notifications" title="Notifications" style={iconButtonStyle()}>
              <Fi icon="bell" style={{ fontSize: '14px' }} />
            </button>
            <button
              type="button"
              aria-label="Network"
              title="Network"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12.5px',
                color: MUTED,
                border: `1px solid ${LINE}`,
                background: '#fff',
                borderRadius: '99px',
                padding: '6px 11px',
              }}
            >
              <i style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#2F7D4F', display: 'inline-block' }} />
              Solana ⌄
            </button>
            <button
              type="button"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: '13px',
                fontWeight: 600,
                borderRadius: '9px',
                padding: '8px 14px',
                border: `1px solid ${LINE}`,
                background: '#fff',
                color: INK,
              }}
            >
              Add funds
            </button>
          </div>
        </header>
        <main ref={mainRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', background: PAPER }}>
          <div
            key={pageKey}
            className="wt-page"
            style={{
              maxWidth: inPay ? 1120 : 860,
              margin: '0 auto',
              padding: '28px 32px 140px',
            }}
          >
            <style>
              {`
                .wt-page { animation: wt-page-in 520ms ease; }
                @keyframes wt-page-in {
                  from { opacity: 0; transform: translateY(16px); }
                  to { opacity: 1; transform: none; }
                }
                @media (prefers-reduced-motion: reduce) {
                  .wt-page { animation: none; }
                }
              `}
            </style>
            <WalkthroughPages page={ended ? 'overview' : step.page} />
          </div>
        </main>
      </div>
    </div>
  );
});

export default WalkthroughStage;
