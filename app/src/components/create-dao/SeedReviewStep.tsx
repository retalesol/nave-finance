import { formatUnits } from 'viem';
import {
  type PolicyState,
  PROTOCOLS_SOLANA,
  PROTOCOLS_EVM,
  RISK_PRESETS,
  isBridgeAdapterKey,
} from '../ConstitutionStep';
import {
  chainDisplayLabel,
  TOKEN_MINT_FEE_SOL,
  AGENT_WALLET_TOTAL_SEED_SOL,
} from '../../lib/programConfig';
import {
  type DAOConfig,
  treasuryNativeLabel,
} from './CreateDaoHelpers';

export default function SeedReviewStep({
  config,
  policy,
  onDeploy,
  deploying,
  evmFormationFeeWei,
  evmFormationFeeLoading,
}: {
  config: DAOConfig;
  policy: PolicyState;
  seedAmount?: string;
  setSeedAmount?: (v: string) => void;
  onDeploy: () => void;
  deploying: boolean;
  evmFormationFeeWei?: bigint | null;
  evmFormationFeeLoading?: boolean;
}) {
  const isSolana = config.chain === 'solana';
  const chainLabel = chainDisplayLabel(config.chain);
  const isTokenGov = config.governanceType === 'token';
  const isNewToken = config.tokenMode === 'new';
  const nativeUnit = treasuryNativeLabel(config.chain);

  const presetLabel = RISK_PRESETS.find((r) => r.id === policy.riskPreset)?.label ?? policy.riskPreset;
  const approvedProtocols = (isSolana ? PROTOCOLS_SOLANA : PROTOCOLS_EVM)
    .filter((p) => !isBridgeAdapterKey(p.key) && policy.approvedProtocols[p.key])
    .map((p) => p.label);

  // Per-network native cost summary. Formation has no protocol fee.
  const agentSeedSol = AGENT_WALLET_TOTAL_SEED_SOL;
  const rentSol = 0.015;
  const gasSol = 0.001;
  const totalFeesSol = agentSeedSol + rentSol + gasSol + (isNewToken ? TOKEN_MINT_FEE_SOL : 0);

  const costSummaryText = isSolana
    ? `Network gas & rent only · ~${totalFeesSol.toFixed(3)} SOL`
    : evmFormationFeeLoading
      ? 'Loading…'
      : evmFormationFeeWei != null && evmFormationFeeWei > 0n
        ? `Network gas + formation (~${parseFloat(formatUnits(evmFormationFeeWei, 18)).toFixed(4)} ${nativeUnit})`
        : `Network gas only · ~0.003 ${nativeUnit}`;

  const purposeLabel = config.treasuryPurpose || 'Creators & fans';
  const govLabel = isTokenGov ? 'Token holders vote' : 'People vote';

  const kvRows: { label: string; value: string; mono?: boolean }[] = [
    { label: 'Name', value: config.name || '—' },
    { label: 'Home', value: `nave.finance/${config.slug || '—'}`, mono: true },
    { label: 'Type', value: `${purposeLabel} · ${govLabel}` },
    { label: 'Network', value: chainLabel },
    {
      label: 'Rules',
      value: `${presetLabel} · ${policy.minStablecoin}% safe · up to ${policy.maxDeployment}% working${approvedProtocols.length ? ` · ${approvedProtocols.join(', ')}` : ''}`,
    },
    { label: 'Team', value: 'Coordinator, Investor, Guardrail, Watcher' },
    { label: 'Cost', value: costSummaryText },
  ];

  return (
    <div className="space-y-6">
      {/* Hairline KV summary rows matching #view-create */}
      <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
        {kvRows.map(({ label, value, mono }) => (
          <div
            key={label}
            className="flex justify-between gap-5 py-3"
            style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: '13.5px' }}
          >
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
            <strong
              className={mono ? 'nave-mono' : ''}
              style={{
                fontWeight: 500,
                textAlign: 'right',
                color: 'hsl(var(--foreground))',
                fontSize: mono ? '12.5px' : '13.5px',
              }}
            >
              {value}
            </strong>
          </div>
        ))}
      </div>

      {isNewToken && (
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
          <strong style={{ color: 'hsl(var(--foreground))' }}>{config.newTokenName || 'Your token'}</strong> will be created with the treasury as its mint authority. Manage it from the Tokens page after deployment.
        </p>
      )}

      <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
        {isSolana
          ? 'Your wallet will prompt you up to 3 times — Foundation, Governance, then Activate & Ratify. Afterwards: add funds, invite members, and your agents begin within the rules.'
          : 'Creates the treasury, its rules, its agents and its voting together. Afterwards: add funds, invite members, and your agents begin within the rules.'}
      </p>

      {/* Deploy button */}
      <div className="pt-2">
        <button
          type="button"
          onClick={onDeploy}
          disabled={deploying}
          className="btn-brass w-full sm:w-auto justify-center"
          style={{
            padding: '10px 20px',
            fontSize: '13.5px',
            opacity: deploying ? 0.45 : 1,
            cursor: deploying ? 'not-allowed' : 'pointer',
          }}
        >
          Launch treasury
        </button>
      </div>
    </div>
  );
}
