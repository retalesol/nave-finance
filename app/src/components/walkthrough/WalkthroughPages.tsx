import Dashboard from '../../pages/Dashboard';
import Assets from '../../pages/Assets';
import Agent from '../../pages/Agent';
import Governance from '../../pages/Governance';
import PolicyEngine from '../../pages/PolicyEngine';
import BridgePage from '../../pages/BridgePage';
import Settings from '../../pages/Settings';
import PayHome from '../../pages/pay/PayHome';
import { MOCK_DAO_ADDRESS } from '../../lib/mockData';
import type { PayBooksSnapshot } from '../../lib/pay/api';
import type { PayActivity, PayInvoice } from '../../lib/pay/booksApi';
import type { PayBill } from '../../lib/pay/payablesApi';
import type { WalkthroughPageId } from './steps';

const PAY_SNAPSHOT: PayBooksSnapshot = {
  company: {
    legal_name: 'Nave Test DAO',
    address: '',
    ein: '',
    email: '',
    wire_instructions: '',
    ach_instructions: '',
    invoice_prefix: 'INV',
    invoice_next_number: 105,
    invoice_terms_days: 30,
    default_notes: '',
    default_terms: '',
    logo_url: '',
  },
  addresses: [
    {
      chain: 'solana',
      chain_id: null,
      address: MOCK_DAO_ADDRESS,
      dao_onchain_address: MOCK_DAO_ADDRESS,
    },
  ],
  cashAccount: { code: '1200', name: 'Digital assets' },
};

const PAY_PREVIEW: {
  invoices: PayInvoice[];
  bills: PayBill[];
  activity: PayActivity[];
} = {
  invoices: [
    {
      id: 'preview-inv-104',
      number: 'INV-104',
      status: 'sent',
      total_cents: 240_000,
      due_date: '2026-12-18',
      customer: { name: 'Northwind', email: '' },
      payments: [],
    } as unknown as PayInvoice,
    {
      id: 'preview-inv-105',
      number: 'INV-105',
      status: 'sent',
      total_cents: 180_000,
      due_date: '2026-12-28',
      customer: { name: 'Harbor Co', email: '' },
      payments: [],
    } as unknown as PayInvoice,
  ],
  bills: [
    {
      id: 'preview-bill-1',
      ref: '1042',
      status: 'open',
      amount_cents: 118_000,
      due_date: '2026-12-20',
      vendor: { name: 'Studio rent', payment_address: '' },
      payments: [],
    } as unknown as PayBill,
  ],
  activity: [
    {
      id: 'preview-act-1',
      kind: 'payment',
      summary: 'Northwind paid INV-103 · $1,800 USDC',
      created_at: '2026-10-22T15:00:00.000Z',
    },
  ],
};

export default function WalkthroughPages({ page }: { page: WalkthroughPageId }) {
  if (page === 'overview') return <Dashboard />;
  if (page === 'money') return <Assets />;
  if (page === 'agents') return <Agent />;
  if (page === 'decisions') return <Governance />;
  if (page === 'rules') return <PolicyEngine />;
  if (page === 'bridge') return <BridgePage mode="bridge" />;
  if (page === 'stake') return <BridgePage mode="stake" />;
  if (page === 'settings') return <Settings />;
  return (
    <PayHome
      snapshot={PAY_SNAPSHOT}
      treasuryGroupId="walkthrough-preview"
      preview={PAY_PREVIEW}
    />
  );
}
