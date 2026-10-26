import { useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import NaveEmptyState from '../../components/NaveEmptyState';
import { useDaoContext } from '../../hooks/useDaoContext';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { useDaoRegistry } from '../../hooks/useDaoRegistry';
import { isMockDaoAddress } from '../../lib/mockData';
import {
  enablePayForTreasury,
  fetchPayAccess,
  fetchPayBooks,
  fetchPaySubscription,
  PAY_GUARDIAN_GAP,
  payErrorCode,
  payErrorMessage,
} from '../../lib/pay/api';
import { PAY_NAV, payNavLabel } from '../../lib/pay/nav';
import NotFound from '../NotFound';
import BankPage from './BankPage';
import BillsPage from './BillsPage';
import CashLedgerPage from './CashLedgerPage';
import CustomersPage from './CustomersPage';
import InvoicesPage from './InvoicesPage';
import JournalPage from './JournalPage';
import { PayPage, PayWork } from './PayDesk';
import PayHome from './PayHome';
import PayNetworkBar from './PayNetworkBar';
import PayNotBuilt from './PayNotBuilt';
import SubscribePage from './SubscribePage';
import PayrollPage from './PayrollPage';
import ReportsPage from './ReportsPage';
import TransactionsPage from './TransactionsPage';
import TreasuryActivityPage from './TreasuryActivityPage';
import VendorsPage from './VendorsPage';

function pathKey(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function payArea(pathname: string): 'home' | 'customers' | 'invoices' | 'vendors' | 'bills' | 'transactions' | 'ledger' | 'activity' | 'payroll' | 'bank' | 'reports' | 'journal' | 'soon' | 'missing' {
  const path = pathKey(pathname);
  if (path === '/pay') return 'home';
  if (path === '/pay/bank' || path.startsWith('/pay/bank/')) return 'bank';
  if (path === '/pay/customers' || path.startsWith('/pay/customers/')) return 'customers';
  if (path === '/pay/invoices' || path.startsWith('/pay/invoices/')) return 'invoices';
  if (path === '/pay/payroll' || path.startsWith('/pay/payroll/')) return 'payroll';
  if (path === '/pay/vendors' || path.startsWith('/pay/vendors/')) return 'vendors';
  if (path === '/pay/bills' || path.startsWith('/pay/bills/')) return 'bills';
  if (path === '/pay/transactions' || path.startsWith('/pay/transactions/')) return 'transactions';
  if (path === '/pay/ledger' || path.startsWith('/pay/ledger/')) return 'ledger';
  if (path === '/pay/activity') return 'activity';
  if (path === '/pay/reports' || path.startsWith('/pay/reports/')) return 'reports';
  if (path === '/pay/journal' || path.startsWith('/pay/journal/')) return 'journal';
  if (PAY_NAV.some((item) => item.path === path)) return 'soon';
  return 'missing';
}

export default function PaySection() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { daoAddress } = useDaoContext();
  const { dao, loading: daoLoading } = useDaoRegistry(daoAddress);
  const membership = useDaoMembership();
  const [turningOn, setTurningOn] = useState(false);
  const [turnOnError, setTurnOnError] = useState<string | null>(null);

  const treasuryGroupId = dao?.treasuryGroupId ?? null;
  const isMock = isMockDaoAddress(daoAddress);
  const path = pathKey(location.pathname);
  const area = payArea(path);

  const accessQuery = useQuery({
    queryKey: ['payAccess', treasuryGroupId, membership.walletStr],
    enabled: !!treasuryGroupId && !isMock,
    queryFn: () => fetchPayAccess(treasuryGroupId as string, membership.walletStr),
  });

  const booksReady = !!treasuryGroupId && accessQuery.data?.enabled === true && accessQuery.data?.can_operate === true;
  const subscriptionQuery = useQuery({
    queryKey: ['paySubscription', treasuryGroupId, membership.walletStr],
    enabled: booksReady,
    queryFn: () => fetchPaySubscription(treasuryGroupId as string, membership.walletStr),
  });
  const booksQuery = useQuery({
    queryKey: ['payBooks', treasuryGroupId, membership.walletStr],
    enabled: booksReady,
    queryFn: () => fetchPayBooks(treasuryGroupId as string),
  });

  if (!daoAddress) {
    return (
      <PayFrame label="Nave Pay" title="Choose a treasury.">
        <p style={bodyStyle}>
          Nave Pay keeps one set of books for a treasury. Pick one in the sidebar. The network pill stays with the treasury and does not choose the books.
        </p>
        <div style={{ marginTop: '18px' }}>
          <NaveEmptyState
            icon="landmark"
            title="No treasury selected"
            description="Books follow the treasury you have open, across every chain in that treasury."
            action={{ label: 'All treasuries', onClick: () => navigate('/treasuries') }}
          />
        </div>
      </PayFrame>
    );
  }

  if (area === 'missing') return <NotFound />;

  if ((daoLoading && !dao) || (accessQuery.isLoading && !accessQuery.data && !isMock)) {
    return (
      <PayFrame label="Nave Pay" title="Loading books.">
        <p style={bodyStyle}>Checking whether Pay is on for this treasury.</p>
      </PayFrame>
    );
  }

  if (!isMock && !treasuryGroupId) {
    return (
      <PayFrame label="Nave Pay" title="This treasury is not registered.">
        <p style={bodyStyle}>
          Pay needs the treasury’s registry record before it can create books. Open a treasury that has finished registration.
        </p>
      </PayFrame>
    );
  }

  if (accessQuery.isError) {
    return (
      <PayFrame label="Nave Pay" title="Books could not be loaded.">
        <p style={bodyStyle}>
          {accessQuery.error instanceof Error ? accessQuery.error.message : 'The books service did not respond.'}
        </p>
      </PayFrame>
    );
  }

  const enabled = isMock ? false : accessQuery.data?.enabled === true;
  const canOperate = isMock ? false : accessQuery.data?.can_operate === true;
  const canTurnOn = membership.isFounder || membership.isGuardian;

  if (!enabled) {
    const daoName = dao?.name && dao.name !== 'Unknown DAO' ? dao.name : 'this treasury';
    return (
      <PayPage
        kicker="Nave Pay"
        title="Turn on books for this treasury."
        purpose={`This creates one set of books for ${daoName}. The legal name starts as ${daoName}. Address and EIN stay blank until you fill them in. $49 a month after the books exist.`}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
          <PayWork title="Collect" detail="Invoice customers and get paid in USDC to the treasury." action="Invoices" />
          <PayWork title="Pay" detail="Record vendor bills, then propose the payment." action="Bills" />
          <PayWork title="Close" detail="Cash, journal, payroll, and reports stay with the treasury." action="Books" />
        </div>
        {isMock && (
          <p style={bodyStyle}>
            This demo treasury is not in the registry, so Pay cannot be turned on here.
          </p>
        )}
        {turnOnError && (
          <p style={{ ...bodyStyle, color: '#B42318' }}>{turnOnError}</p>
        )}
        <div>
          {canTurnOn && !isMock ? (
            <button
              type="button"
              disabled={turningOn || !treasuryGroupId}
              onClick={() => {
                if (!treasuryGroupId) return;
                if (
                  accessQuery.data?.can_operate === false &&
                  membership.isGuardian &&
                  !membership.isFounder
                ) {
                  setTurnOnError(PAY_GUARDIAN_GAP);
                  return;
                }
                setTurnOnError(null);
                setTurningOn(true);
                void enablePayForTreasury(treasuryGroupId, membership.walletStr)
                  .then(async () => {
                    await queryClient.invalidateQueries({ queryKey: ['payAccess', treasuryGroupId] });
                    await queryClient.invalidateQueries({ queryKey: ['payBooks', treasuryGroupId] });
                  })
                  .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : 'enable_failed';
                    const code = payErrorCode(message);
                    setTurnOnError(
                      payErrorMessage(code, membership.isGuardian && !membership.isFounder),
                    );
                  })
                  .finally(() => setTurningOn(false));
              }}
              style={primaryButton}
            >
              {turningOn ? 'Turning on…' : 'Turn on Nave Pay'}
            </button>
          ) : (
            <p style={{ ...bodyStyle, margin: 0 }}>
              Only a founder or guardian can turn on Nave Pay for this treasury.
            </p>
          )}
        </div>
      </PayPage>
    );
  }

  if (!canOperate) {
    const guardianGap = membership.isGuardian || membership.isFounder;
    return (
      <PayFrame label="Nave Pay" title={guardianGap ? 'This wallet cannot open the books.' : 'Books are limited to operators.'}>
        <p style={bodyStyle}>
          {guardianGap
            ? 'Pay is on for this treasury. The database allows the founder and wallets on the treasury’s authorized list. On-chain guardians are not stored in Postgres, so a guardian who is not also one of those wallets cannot read the books.'
            : 'Nave Pay books are for the founder, guardians, and treasury operators. Token holders do not get books access.'}
        </p>
      </PayFrame>
    );
  }

  if (booksQuery.isLoading && !booksQuery.data) {
    return (
      <PayFrame label="Nave Pay" title="Loading books.">
        <p style={bodyStyle}>Opening the books for this treasury.</p>
      </PayFrame>
    );
  }

  if (booksQuery.isError || !booksQuery.data) {
    return (
      <PayFrame label="Nave Pay" title="Books could not be loaded.">
        <p style={bodyStyle}>
          {booksQuery.error instanceof Error ? booksQuery.error.message : 'The books rows were not readable for this wallet.'}
        </p>
      </PayFrame>
    );
  }

  if (subscriptionQuery.isLoading && !subscriptionQuery.data) {
    return (
      <PayFrame label="Nave Pay" title="Loading books.">
        <p style={bodyStyle}>Checking the Nave Pay subscription.</p>
      </PayFrame>
    );
  }

  if (!subscriptionQuery.data?.usable) {
    return (
      <SubscribePage
        treasuryGroupId={treasuryGroupId as string}
        daoAddress={daoAddress}
        status={subscriptionQuery.data ?? null}
      />
    );
  }

  const page = (() => {
  if (area === 'soon') {
    return <PayNotBuilt title={payNavLabel(path)} />;
  }

  if (area === 'payroll') {
    return <PayrollPage treasuryGroupId={treasuryGroupId as string} />;
  }

  if (area === 'customers') {
    return <CustomersPage treasuryGroupId={treasuryGroupId as string} />;
  }

  if (area === 'invoices') {
    return <InvoicesPage treasuryGroupId={treasuryGroupId as string} snapshot={booksQuery.data} />;
  }

  if (area === 'vendors') {
    return <VendorsPage treasuryGroupId={treasuryGroupId as string} />;
  }

  if (area === 'bills') {
    return <BillsPage treasuryGroupId={treasuryGroupId as string} />;
  }

  if (area === 'transactions') {
    return <TransactionsPage treasuryGroupId={treasuryGroupId as string} />;
  }

  if (area === 'ledger') {
    return <CashLedgerPage treasuryGroupId={treasuryGroupId as string} />;
  }

  if (area === 'bank') {
    return <BankPage treasuryGroupId={treasuryGroupId as string} />;
  }

  if (area === 'activity') {
    return <TreasuryActivityPage treasuryGroupId={treasuryGroupId as string} />;
  }

  if (area === 'reports') {
    return <ReportsPage treasuryGroupId={treasuryGroupId as string} />;
  }

  if (area === 'journal') {
    return <JournalPage treasuryGroupId={treasuryGroupId as string} />;
  }

  return <PayHome snapshot={booksQuery.data} treasuryGroupId={treasuryGroupId as string} />;
  })();

  return (
    <>
      <PayNetworkBar addresses={booksQuery.data.addresses} />
      {page}
    </>
  );
}

function PayFrame({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="animate-fade-in">
      <div className="nave-label" style={{ marginBottom: '10px' }}>{label}</div>
      <h1 style={titleStyle}>{title}</h1>
      {children}
    </div>
  );
}

const titleStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 400,
  fontSize: '34px',
  lineHeight: 1.1,
  letterSpacing: '-0.02em',
  margin: '0 0 12px',
  color: '#111827',
};

const bodyStyle: CSSProperties = {
  fontSize: '14.5px',
  lineHeight: 1.6,
  color: '#6B7280',
  margin: 0,
  maxWidth: '560px',
};

const primaryButton: CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  borderRadius: '9px',
  padding: '8px 14px',
  border: '1px solid #111827',
  backgroundColor: '#111827',
  color: '#ffffff',
};
