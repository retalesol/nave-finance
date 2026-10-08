import { NavLink } from 'react-router-dom';

import alignmentDoc from '../../docs/ALIGNMENT_VERIFICATION.md?raw';
import betaLaunchDoc from '../../docs/BETA_LAUNCH.md?raw';
import devnetGateDoc from '../../docs/DEVNET_E2E_GATE.md?raw';
import fineTuningDoc from '../../docs/FINE_TUNING.md?raw';
import systemStatusDoc from '../../docs/FINAL_SYSTEM_STATUS_2026-05-31.md?raw';
import reconciliationDoc from '../../docs/RECONCILIATION.md?raw';
import rlsDoc from '../../docs/RLS.md?raw';
import introductionDoc from '../../docs/portal/introduction.md?raw';
import tokenomicsDoc from '../../docs/portal/tokenomics.md?raw';
import gettingStartedDoc from '../../docs/portal/getting-started.md?raw';
import usingNaveDoc from '../../docs/portal/using-nave.md?raw';
import faqDoc from '../../docs/portal/faq.md?raw';
import treasuryOperationsDoc from '../../docs/portal/treasury-operations.md?raw';
import constitutionPolicyDoc from '../../docs/portal/constitution-and-policy.md?raw';
import riskControlsDoc from '../../docs/portal/risk-and-controls.md?raw';
import architectureDoc from '../../docs/portal/architecture.md?raw';
import integrationDoc from '../../docs/portal/integration.md?raw';
import contributingDoc from '../../docs/portal/contributing.md?raw';
import investmentOverviewDoc from '../../docs/portal/investment-overview.md?raw';
import productMaturityDoc from '../../docs/portal/product-maturity.md?raw';
import securityTrustDoc from '../../docs/portal/security-and-trust.md?raw';

export interface DocsSection {
  id: string;
  title: string;
  icon: string;
  description: string;
}

export interface DocsEntry {
  slug: string;
  title: string;
  description: string;
  sectionId: DocsSection['id'];
  content: string;
}

export const DOCS_SECTIONS: DocsSection[] = [
  {
    id: 'overview',
    title: 'Overview',
    icon: 'book-open',
    description: 'Orientation, principles, and current status.',
  },
  {
    id: 'users',
    title: 'For Users',
    icon: 'circle-user',
    description: 'Connect a wallet, explore treasuries, and read the app.',
  },
  {
    id: 'fund-managers',
    title: 'For Fund Managers',
    icon: 'chart-line',
    description: 'Operate a treasury, set policy, and bound risk.',
  },
  {
    id: 'developers',
    title: 'For Developers',
    icon: 'code',
    description: 'Architecture, integration surfaces, and local setup.',
  },
  {
    id: 'investors',
    title: 'For Investors',
    icon: 'chart-pie',
    description: 'Thesis, product maturity, and the trust model.',
  },
  {
    id: 'architecture',
    title: 'Reference: Architecture',
    icon: 'diagram-project',
    description: 'Instruction-level alignment across app, signer, and contracts.',
  },
  {
    id: 'security',
    title: 'Reference: Security',
    icon: 'shield-check',
    description: 'Access controls and hardening guidance.',
  },
  {
    id: 'operations',
    title: 'Reference: Operations',
    icon: 'gear',
    description: 'Reconciliation controls.',
  },
  {
    id: 'ai-agents',
    title: 'Reference: AI Agents',
    icon: 'brain-circuit',
    description: 'Guardrail readiness and model governance posture.',
  },
  {
    id: 'launch',
    title: 'Reference: Launch',
    icon: 'rocket',
    description: 'Beta launch checklist and end-to-end gate evidence.',
  },
];

export const DOCS_ENTRIES: DocsEntry[] = [
  {
    slug: 'introduction',
    title: 'Introduction',
    description: 'Start here for context, principles, and scope.',
    sectionId: 'overview',
    content: introductionDoc,
  },
  {
    slug: 'tokenomics',
    title: 'Tokenomics & Bridge',
    description: '$NAVE, the DAO-formation stake, the cross-chain bridge, and the devnet faucet.',
    sectionId: 'overview',
    content: tokenomicsDoc,
  },
  {
    slug: 'system-status',
    title: 'Final System Status',
    description: 'Current cross-repo status snapshot and blockers.',
    sectionId: 'overview',
    content: systemStatusDoc,
  },
  {
    slug: 'getting-started',
    title: 'Getting Started',
    description: 'From a fresh wallet to a live treasury in minutes.',
    sectionId: 'users',
    content: gettingStartedDoc,
  },
  {
    slug: 'using-nave',
    title: 'Using Nave',
    description: 'A screen-by-screen tour of the application.',
    sectionId: 'users',
    content: usingNaveDoc,
  },
  {
    slug: 'faq',
    title: 'FAQ & Glossary',
    description: 'Common questions and plain-language definitions.',
    sectionId: 'users',
    content: faqDoc,
  },
  {
    slug: 'treasury-operations',
    title: 'Treasury Operations',
    description: 'The operating lifecycle of a Nave treasury.',
    sectionId: 'fund-managers',
    content: treasuryOperationsDoc,
  },
  {
    slug: 'constitution-and-policy',
    title: 'Constitution & Policy',
    description: 'Authoring the on-chain rulebook and policy engine.',
    sectionId: 'fund-managers',
    content: constitutionPolicyDoc,
  },
  {
    slug: 'risk-and-controls',
    title: 'Risk & Controls',
    description: 'How autonomy is bounded by layered controls.',
    sectionId: 'fund-managers',
    content: riskControlsDoc,
  },
  {
    slug: 'architecture',
    title: 'Architecture',
    description: 'How the four layers of Nave fit together.',
    sectionId: 'developers',
    content: architectureDoc,
  },
  {
    slug: 'integration',
    title: 'Integration',
    description: 'Connecting to on-chain and off-chain surfaces.',
    sectionId: 'developers',
    content: integrationDoc,
  },
  {
    slug: 'contributing',
    title: 'Contributing',
    description: 'Run Nave locally and the conventions to follow.',
    sectionId: 'developers',
    content: contributingDoc,
  },
  {
    slug: 'investment-overview',
    title: 'Investment Overview',
    description: 'Thesis, market, and what is differentiated.',
    sectionId: 'investors',
    content: investmentOverviewDoc,
  },
  {
    slug: 'product-maturity',
    title: 'Product Maturity',
    description: 'Honest current state and the path to mainnet.',
    sectionId: 'investors',
    content: productMaturityDoc,
  },
  {
    slug: 'security-and-trust',
    title: 'Security & Trust',
    description: 'How Nave earns trust, and its honest limitations.',
    sectionId: 'investors',
    content: securityTrustDoc,
  },
  {
    slug: 'alignment',
    title: 'Alignment Verification',
    description: 'Frontend, signer, and contract instruction alignment.',
    sectionId: 'architecture',
    content: alignmentDoc,
  },
  {
    slug: 'rls',
    title: 'Row-Level Security',
    description: 'RLS matrix and access policies by table and role.',
    sectionId: 'security',
    content: rlsDoc,
  },
  {
    slug: 'reconciliation',
    title: 'Treasury Reconciliation',
    description: 'Accounting invariants, sources of truth, and alerting.',
    sectionId: 'operations',
    content: reconciliationDoc,
  },
  {
    slug: 'fine-tuning',
    title: 'Agent Fine-Tuning',
    description: 'Guardrails, eval harness, and go/no-go criteria.',
    sectionId: 'ai-agents',
    content: fineTuningDoc,
  },
  {
    slug: 'beta-launch',
    title: 'Beta Launch Checklist',
    description: 'Go/no-go checks and deployment verification steps.',
    sectionId: 'launch',
    content: betaLaunchDoc,
  },
  {
    slug: 'devnet-gate',
    title: 'Devnet E2E Gate',
    description: 'Canonical technical gate and execution evidence.',
    sectionId: 'launch',
    content: devnetGateDoc,
  },
];

export const DOCS_BY_SLUG = DOCS_ENTRIES.reduce<Record<string, DocsEntry>>((acc, entry) => {
  acc[entry.slug] = entry;
  return acc;
}, {});

export const DOCS_ENTRIES_BY_SECTION = DOCS_SECTIONS.map((section) => ({
  section,
  entries: DOCS_ENTRIES.filter((entry) => entry.sectionId === section.id),
}));

export function getDocBySlug(slug?: string) {
  if (!slug) {
    return null;
  }

  return DOCS_BY_SLUG[slug] ?? null;
}

interface DocsSidebarProps {
  currentSlug: string;
}

export default function DocsSidebar({ currentSlug }: DocsSidebarProps) {
  return (
    <aside
      className="shrink-0"
      style={{
        width: '240px',
        borderRight: '1px solid hsl(var(--border))',
        backgroundColor: 'hsl(var(--surface-1))',
      }}
    >
      <div
        style={{
          position: 'sticky',
          top: '72px',
          padding: '20px 16px 24px',
        }}
      >
        {DOCS_ENTRIES_BY_SECTION.map(({ section, entries }) => (
          <div key={section.id} style={{ marginBottom: '24px' }}>
            <p className="nave-label" style={{ marginBottom: '9px' }}>
              {section.title}
            </p>
            <div className="space-y-1">
              {entries.map((entry) => {
                const isActive = currentSlug === entry.slug;
                return (
                  <NavLink
                    key={entry.slug}
                    to={`/docs/${entry.slug}`}
                    className="block"
                    style={{
                      padding: '8px 10px',
                      paddingLeft: isActive ? '12px' : '10px',
                      borderLeft: isActive
                        ? '2px solid hsl(var(--foreground))'
                        : '2px solid transparent',
                      color: isActive
                        ? 'hsl(var(--foreground))'
                        : 'hsl(var(--muted-foreground))',
                      fontFamily: 'var(--font-body)',
                      fontSize: '14px',
                      lineHeight: 1.35,
                      transition: 'color var(--duration-fast) var(--ease-ui)',
                    }}
                  >
                    {entry.title}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
