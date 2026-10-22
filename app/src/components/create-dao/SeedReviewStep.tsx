import { useState } from 'react';
import { formatUnits } from 'viem';
import Fi from '../Fi';
import {
  type PolicyState,
  PROTOCOLS_SOLANA,
  PROTOCOLS_EVM,
  RISK_PRESETS,
} from '../ConstitutionStep';
import {
  SOLANA_NETWORK,
  chainDisplayLabel,
  TOKEN_MINT_FEE_SOL,
  AGENT_WALLET_TOTAL_SEED_SOL,
  defaultGuardianThreshold,
} from '../../lib/programConfig';
import { formatDaoSlugLabel } from '../../lib/daoSlug';
import {
  type DAOConfig,
  treasuryNativeLabel,
  previewGuardianCount,
} from './CreateDaoHelpers';

export default function SeedReviewStep({
  config,
  policy,
  seedAmount,
  setSeedAmount,
  onDeploy,
  deploying,
  evmFormationFeeWei,
  evmFormationFeeLoading,
}: {
  config: DAOConfig;
  policy: PolicyState;
  seedAmount: string;
  setSeedAmount: (v: string) => void;
  onDeploy: () => void;
  deploying: boolean;
  evmFormationFeeWei?: bigint | null;
  evmFormationFeeLoading?: boolean;
}) {
  const [showCostDetails, setShowCostDetails] = useState(false);
  const isSolana = config.chain === 'solana';
  const chainLabel = chainDisplayLabel(config.chain);
  const isTokenGov = config.governanceType === 'token';
  const isNewToken = config.tokenMode === 'new';
  const nativeUnit = treasuryNativeLabel(config.chain);
  const seedDepositCopy = config.chain === 'arc'
    ? 'Arc treasuries hold 6-decimal ERC-20 USDC (deposited from Assets after creation); native gas USDC is not attached to createDao, and the seed amount sets your initial agent threshold.'
    : `Deposited into your ${chainLabel} vault as native ${nativeUnit} — not a protocol fee.`;

  const seedNum = parseFloat(seedAmount);
  const validSeed = !isNaN(seedNum) && seedNum >= 0;
  const deployBlocked = deploying || !validSeed;

  const presetLabel = RISK_PRESETS.find((r) => r.id === policy.riskPreset)?.label ?? policy.riskPreset;
  const approvedProtocols = (isSolana ? PROTOCOLS_SOLANA : PROTOCOLS_EVM)
    .filter((p) => policy.approvedProtocols[p.key])
    .map((p) => p.label);

  // Per-network native cost rows (Solana). Formation has no protocol fee.
  const isMainnet = SOLANA_NETWORK === 'mainnet';
  const agentSeedSol = AGENT_WALLET_TOTAL_SEED_SOL;
  const rentSol = 0.015;
  const gasSol = 0.001;
  const totalFeesSol = agentSeedSol + rentSol + gasSol + (isNewToken ? TOKEN_MINT_FEE_SOL : 0);
  const totalCostSol = totalFeesSol + (validSeed ? seedNum : 0);

  const costSummaryText = isSolana
    ? `Network gas & rent only · ~${(validSeed ? totalCostSol : totalFeesSol).toFixed(3)} SOL`
    : evmFormationFeeLoading
      ? 'Loading…'
      : evmFormationFeeWei != null && evmFormationFeeWei > 0n
        ? `Network gas + formation (~${parseFloat(formatUnits(evmFormationFeeWei, 18)).toFixed(4)} ${nativeUnit})`
        : `Network gas only · ~0.003 ${nativeUnit}`;

  const kvRows: { label: string; value: string; mono?: boolean }[] = [
    { label: 'Name', value: config.name || '—' },
    ...(config.slug ? [{ label: 'Home', value: formatDaoSlugLabel(config.slug), mono: true }] : []),
    {
      label: 'Governance',
      value: isTokenGov
        ? 'Token-Based'
        : `Authorized Wallets · ${defaultGuardianThreshold(previewGuardianCount(config), isSolana ? 0 : 1)} of ${previewGuardianCount(config)} guardians`,
    },
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
      {/* Treasury seed input */}
      <div style={{ marginBottom: '20px' }}>
        <label className="block" style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'hsl(var(--foreground))' }}>
          Initial treasury deposit <span style={{ fontWeight: 400, color: 'hsl(var(--faint))' }}>(optional)</span>
        </label>
        <div
          className="flex items-center rounded-[10px] border overflow-hidden"
          style={{ borderColor: 'hsl(var(--border))', backgroundColor: '#ffffff' }}
        >
          <input
            type="number"
            min="0"
            step="0.01"
            value={seedAmount}
            onChange={(e) => setSeedAmount(e.target.value)}
            placeholder="0.0"
            className="flex-1 min-w-0 outline-none"
            style={{ padding: '11px 13px', fontSize: '14.5px', fontFamily: 'var(--font-mono)', backgroundColor: 'transparent', color: 'hsl(var(--foreground))' }}
          />
          <span
            className="px-3.5 py-2.5 border-l nave-mono flex-shrink-0"
            style={{ fontSize: '13px', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))', backgroundColor: 'hsl(var(--background))' }}
          >
            {nativeUnit}
          </span>
        </div>
        <div style={{ fontSize: '12.5px', color: 'hsl(var(--faint))', marginTop: '7px', lineHeight: 1.5 }}>
          {isSolana
            ? 'Deposited into your vault as wSOL — not a protocol fee. Enter 0 to start empty.'
            : `${seedDepositCopy} Enter 0 to start empty.`}
        </div>
      </div>

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

      {/* Cost breakdown toggle */}
      <div>
        <button
          type="button"
          onClick={() => setShowCostDetails((v) => !v)}
          className="flex items-center gap-1.5 hover:underline underline-offset-4"
          style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
        >
          <Fi icon={showCostDetails ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px' }} />
          {showCostDetails ? 'Hide cost details' : 'Cost details'}
        </button>
        {showCostDetails && (
          <div className="mt-3 pt-3 space-y-2" style={{ borderTop: '1px solid hsl(var(--surface-2))', fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
            {isSolana ? (
              <>
                <div className="flex justify-between">
                  <span>Agent wallet seeding (4×)</span>
                  <span className="nave-mono">{agentSeedSol.toFixed(isMainnet ? 1 : 2)} SOL</span>
                </div>
                <div className="flex justify-between">
                  <span>Rent (accounts)</span>
                  <span className="nave-mono">~0.015 SOL</span>
                </div>
                {isNewToken && (
                  <div className="flex justify-between">
                    <span>Token mint fee</span>
                    <span className="nave-mono">{TOKEN_MINT_FEE_SOL.toFixed(2)} SOL</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Network gas</span>
                  <span className="nave-mono">~0.001 SOL</span>
                </div>
                <div className="flex justify-between">
                  <span>Initial treasury deposit</span>
                  <span className="nave-mono">{validSeed ? `${seedNum.toFixed(4)} SOL` : '0 SOL'}</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-between">
                  <span>Protocol formation fee</span>
                  <span className="nave-mono">0 {nativeUnit}</span>
                </div>
                <div className="flex justify-between">
                  <span>Initial treasury deposit</span>
                  <span className="nave-mono">{validSeed ? `${seedNum.toFixed(4)} ${nativeUnit}` : `0 ${nativeUnit}`}</span>
                </div>
              </>
            )}
          </div>
        )}
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
          disabled={deployBlocked}
          className="btn-brass w-full sm:w-auto justify-center"
          style={{
            padding: '10px 20px',
            fontSize: '13.5px',
            opacity: deployBlocked ? 0.45 : 1,
            cursor: deployBlocked ? 'not-allowed' : 'pointer',
          }}
        >
          Launch treasury
        </button>
        {!validSeed && (
          <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '8px' }}>
            Enter a seed amount (0 is valid) to continue
          </p>
        )}
      </div>
    </div>
  );
}
