import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { getAccount } from '@solana/spl-token';
import { useAccount, useSignMessage } from 'wagmi';
import { encodeAbiParameters, type Address, parseUnits } from 'viem';
import Fi from '../Fi';
import { toast } from '../../hooks/use-toast';
import { Section, Notice } from '../calm';
import NaveModal from '../NaveModal';
import { useDaoRegistry } from '../../hooks/useDaoRegistry';
import { useDaoMembership } from '../../hooks/useDaoMembership';
import { useTokenRegistry } from '../../hooks/useTokenRegistry';
import { useSendTransaction } from '../../hooks/useSendTransaction';
import { useChain } from '../../hooks/useChain';
import {
  chainKindFromAddress,
  type EvmChainId,
  isTreasuryOpsFamily,
} from '../../lib/chain/types';
import {
  buildRecordMoonlightRequestEvm,
  buildSetMoonlightRecipientEvm,
  buildExecuteMoonlightDistributionEvm,
  buildFinalizeMoonlightEvm,
  buildRestoreDaoEvm,
  buildCreateProposalEvm,
  buildApproveErc20Evm,
  buildWithdrawFromStrategyEvm,
  resolveEvmMinOut,
} from '../../lib/evm/writers';
import {
  fetchMoonlightStakeEvm,
  fetchNaveStakeConfigEvm,
  fetchDaoContracts,
} from '../../lib/evm/readers';
import {
  buildCreateProposal,
  buildRecordMoonlightRequest,
  buildSetMoonlightDistribution,
  buildExecuteMoonlightDistribution,
  buildFinalizeMoonlight,
  buildRestoreDao,
} from '../../lib/transactionBuilders';
import { getDaoLifecyclePDA, getDaoStakeLockPDA, getProposalPDA } from '../../lib/pdaDerivation';
import { fetchTreasuryVault } from '../../lib/onChainFetcher';
import { getNavePrograms } from '../../lib/naveProgram';
import { naveBaseUnitsToUi } from '../../lib/naveStakeOracle';
import {
  SOLANA_NAVE_MINT,
  SOLANA_NETWORK,
} from '../../lib/programConfig';
import {
  MAINNET_DEFAULT_VOTING_PERIOD_SECONDS,
  MAINNET_MOONLIGHT_VOTING_PERIOD_SECONDS,
  votingPeriodForNetwork,
} from '../../lib/actionDelays';
import { withdrawStrategyViaProxyEvm } from '../../lib/edgeFunctionClient';
import { useExecutionPipeline } from '../../hooks/useExecutionPipeline';
import { useProposals } from '../../hooks/useProposals';
import { ExecutionStatus, ProposalType } from '../../lib/onChainTypes';

const MOONLIGHT_REQUEST_TYPE = 9;
const MOONLIGHT_DISTRIBUTION_TYPE = 10;
const ZERO_PUBKEY = '11111111111111111111111111111111';

function nonZeroMoonlightKey(k: string | null | undefined): string | null {
  return k && k !== ZERO_PUBKEY ? k : null;
}

interface MoonlightLifecycle {
  exists: boolean;
  status: number;
  initiatedBy: string | null;
  recipient: string | null;
  requestProposal: string | null;
  distributionProposal: string | null;
}

interface MoonlightStake {
  exists: boolean;
  lockedAmount: bigint;
  status: number;
  naveMint: string | null;
}

const MOONLIGHT_STATUS_LABELS = ['Active', 'Moonlight requested', 'Distribution pending', 'Distributing', 'Moonlighted'] as const;

export function MoonlightStageBadge({ status }: { status: number }) {
  const color = status === 0 ? 'hsl(var(--success))' : status === 4 ? 'hsl(var(--destructive))' : 'hsl(var(--brass))';
  return (
    <span
      style={{ fontSize: '12px', fontWeight: 600, color }}
    >
      {MOONLIGHT_STATUS_LABELS[status] ?? 'Unknown'}
    </span>
  );
}

/**
 * Founder/operator unwind of an executed EVM strategy request.
 * Prefers in-wallet Executive `sendEvm`; otherwise founder challenge →
 * `evm-strategy-withdraw` → signer `/relay-evm` (custodied Executive).
 */
export function EvmStrategyWithdrawSection({
  daoAddress,
  proposalCount,
}: {
  daoAddress: string;
  proposalCount: number;
}) {
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { evmChainId, chainFamily } = useChain();
  const tx = useSendTransaction();
  const pipeline = useExecutionPipeline(daoAddress, proposalCount);
  const [index, setIndex] = useState('');
  const [amount, setAmount] = useState('');
  const [decimals, setDecimals] = useState('6');
  const [minOutQuote, setMinOutQuote] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const executed = useMemo(
    () => pipeline.completedExecutions.filter((e) => e.status === ExecutionStatus.Executed && e.amount > 0),
    [pipeline.completedExecutions],
  );

  async function handleWithdraw() {
    if (!evmAddress || !evmChainId || (!isTreasuryOpsFamily(chainFamily))) {
      toast({ variant: 'destructive', title: 'Connect founder wallet', description: 'Ethereum, Base, or Robinhood wallet required.' });
      return;
    }
    const idx = Number(index);
    if (!Number.isFinite(idx) || idx < 0) {
      toast({ variant: 'destructive', title: 'Invalid request index' });
      return;
    }
    let amountBase: bigint;
    try {
      amountBase = parseUnits(amount.trim() || '0', Number(decimals) || 6);
    } catch {
      toast({ variant: 'destructive', title: 'Invalid amount' });
      return;
    }
    if (amountBase <= 0n) {
      toast({ variant: 'destructive', title: 'Amount must be positive' });
      return;
    }

    let minOut: bigint;
    try {
      const quoted = minOutQuote.trim() ? BigInt(minOutQuote.trim()) : undefined;
      minOut = resolveEvmMinOut(evmChainId as EvmChainId, quoted);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'minOut required',
        description: err instanceof Error ? err.message : 'Provide a positive off-chain quote on mainnet.',
      });
      return;
    }

    setBusy(true);
    try {
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio?.execution) {
        toast({ variant: 'destructive', title: 'Execution contract unresolved' });
        return;
      }

      // Try direct Executive wallet first (quiet — most founders are not the EOA).
      const built = buildWithdrawFromStrategyEvm(evmChainId, trio.execution, idx, amountBase, minOut);
      const direct = await tx.sendEvm(built, { successLabel: `Strategy withdraw #${idx}`, quietToast: true });
      if (direct.status === 'success') {
        toast({ title: 'Strategy withdraw submitted' });
        pipeline.refetch();
        return;
      }

      const { data, error } = await withdrawStrategyViaProxyEvm(
        daoAddress,
        evmAddress,
        (m) => signMessageAsync({ message: m }),
        {
          chainId: evmChainId,
          chain: chainFamily,
          executionAddress: trio.execution,
          index: idx,
          amount: amountBase.toString(),
          minOut: minOut.toString(),
        },
      );
      if (error || !data?.success) {
        toast({
          variant: 'destructive',
          title: 'Withdraw failed',
          description: error || direct.error || 'Executive relay rejected the withdraw.',
        });
        return;
      }
      toast({ title: 'Strategy withdraw submitted', description: data.tx_hash ? `Tx ${data.tx_hash.slice(0, 10)}…` : undefined });
      pipeline.refetch();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Withdraw failed',
        description: err instanceof Error ? err.message : 'Unexpected error',
      });
    } finally {
      setBusy(false);
    }
  }

  if (chainKindFromAddress(daoAddress) !== 'evm') return null;

  return (
    <Section
      title="Advanced — strategy withdraw"
      action={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="hover:underline underline-offset-4"
          style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      }
    >
      {!open ? (
        <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', margin: 0, lineHeight: 1.55 }}>
          Unwind an executed strategy request via the Executive agent.
        </p>
      ) : (
        <div className="space-y-3">
          <p style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))', margin: 0, lineHeight: 1.55 }}>
            Unwind an executed strategy request. On mainnet, set a positive minOut (underlying base units) from an off-chain quote.
            Uses the Executive agent (connected wallet or custodied relay).
          </p>
          {executed.length > 0 && (
            <div className="space-y-1">
              {executed.slice(0, 8).map((e) => (
                <button
                  key={e.proposal}
                  type="button"
                  onClick={() => setIndex(e.proposal)}
                  className="w-full text-left py-2 border-b text-xs"
                  style={{ borderColor: 'hsl(var(--surface-2))', color: 'hsl(var(--foreground))' }}
                >
                  #{e.proposal} · {e.protocolName} · amount {e.amount}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs space-y-1">
              <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>Request index</span>
              <input value={index} onChange={(e) => setIndex(e.target.value)} className="w-full px-3 py-2 rounded-[10px] border text-sm bg-white" style={{ borderColor: 'hsl(var(--border))' }} placeholder="0" />
            </label>
            <label className="text-xs space-y-1">
              <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>Token decimals</span>
              <input value={decimals} onChange={(e) => setDecimals(e.target.value)} className="w-full px-3 py-2 rounded-[10px] border text-sm bg-white" style={{ borderColor: 'hsl(var(--border))' }} />
            </label>
            <label className="text-xs space-y-1 col-span-2">
              <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>Amount (human)</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full px-3 py-2 rounded-[10px] border text-sm bg-white" style={{ borderColor: 'hsl(var(--border))' }} placeholder="100.0" />
            </label>
            <label className="text-xs space-y-1 col-span-2">
              <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>minOut quote (base units, required on mainnet)</span>
              <input value={minOutQuote} onChange={(e) => setMinOutQuote(e.target.value)} className="w-full px-3 py-2 rounded-[10px] border text-sm bg-white" style={{ borderColor: 'hsl(var(--border))' }} placeholder="0 on testnet" />
            </label>
          </div>
          <button
            type="button"
            disabled={busy || tx.status === 'signing'}
            onClick={() => void handleWithdraw()}
            className="px-4 py-2 rounded-[9px] border font-semibold"
            style={{ fontSize: '13px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))', opacity: busy ? 0.6 : 1 }}
          >
            {busy ? 'Submitting…' : 'Withdraw from strategy'}
          </button>
        </div>
      )}
    </Section>
  );
}

/** EVM moonlighting wizard over NaveDaoStake (mirrors Solana lifecycle stages). */
export function EvmMoonlightSection({ daoAddress, first = false }: { daoAddress: string; first?: boolean }) {
  const navigate = useNavigate();
  const { isFounder } = useDaoMembership();
  const { address: evmAddress } = useAccount();
  const { evmChainId, chainFamily } = useChain();
  const { dao } = useDaoRegistry(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const tx = useSendTransaction();
  const votingTokenCandidate =
    dao?.governanceType === 'token'
      ? (tokenRegistry.tokens[0]?.mint ?? null)
      : null;
  const resolvedVotingMint: Address = (
    votingTokenCandidate && /^0x[0-9a-fA-F]{40}$/.test(votingTokenCandidate)
      ? votingTokenCandidate
      : `0x${'0'.repeat(40)}`
  ) as Address;
  const [status, setStatus] = useState(0);
  const [stakeAmount, setStakeAmount] = useState(0n);
  const [recipient, setRecipient] = useState('');
  const [requestIdx, setRequestIdx] = useState('');
  const [distIdx, setDistIdx] = useState('');
  const [module, setModule] = useState<string | null>(null);
  const [governor, setGovernor] = useState<string | null>(null);
  const [stakeToken, setStakeToken] = useState<string | null>(null);
  const [requiredStake, setRequiredStake] = useState(0n);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const proposalTotal = (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);
  const { passedProposals } = useProposals(daoAddress, proposalTotal);
  const passedRequestProp = useMemo(
    () => passedProposals.find((p) => p.proposalType === ProposalType.MoonlightRequest),
    [passedProposals],
  );
  const passedDistProp = useMemo(
    () => passedProposals.find((p) => p.proposalType === ProposalType.MoonlightDistribution),
    [passedProposals],
  );

  useEffect(() => {
    if (passedRequestProp != null && !requestIdx) {
      setRequestIdx(String(passedRequestProp.index));
    }
  }, [passedRequestProp, requestIdx]);

  useEffect(() => {
    if (passedDistProp != null && !distIdx) {
      setDistIdx(String(passedDistProp.index));
    }
  }, [passedDistProp, distIdx]);

  const load = useCallback(async () => {
    if (!evmChainId) return;
    try {
      const [cfg, stake, trio] = await Promise.all([
        fetchNaveStakeConfigEvm(evmChainId),
        fetchMoonlightStakeEvm(evmChainId, daoAddress),
        fetchDaoContracts(evmChainId, daoAddress),
      ]);
      setModule(cfg?.module ?? null);
      setStakeToken(cfg?.token ?? null);
      setRequiredStake(cfg?.amount ?? 0n);
      setGovernor(trio?.governor ?? null);
      if (stake) {
        setStatus(stake.moonlightStatus);
        setStakeAmount(stake.amount);
        if (stake.recipient && stake.recipient !== `0x${'0'.repeat(40)}`) {
          setRecipient(stake.recipient);
        }
      } else {
        setStatus(0);
        setStakeAmount(0n);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load moonlight state');
    }
  }, [daoAddress, evmChainId]);

  useEffect(() => { void load(); }, [load]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  if (!evmChainId || (!isTreasuryOpsFamily(chainFamily))) {
    return (
      <Section first={first} title="Moonlight DAO">
        <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
          Connect Ethereum, Base, or Robinhood to manage moonlighting.
        </p>
      </Section>
    );
  }

  if (!module) {
    return (
      <Section first={first} title="Moonlight DAO">
        <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
          The moonlight module is not configured on this chain yet.
          An existing locked stake cannot be returned until it is set. New treasuries do not lock NAVE.
        </p>
      </Section>
    );
  }

  if (!isFounder) {
    return (
      <Section first={first} title="Moonlight DAO">
        <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
          Only the founder wallet on this chain can moonlight this treasury.
        </p>
      </Section>
    );
  }

  return (
    <Section
      first={first}
      title="Wind down & moonlight"
      action={<MoonlightStageBadge status={status} />}
    >
      <div className="space-y-4">
        <div
          className="rounded-[12px] border"
          style={{
            backgroundColor: '#FFF9F8',
            borderColor: '#F2C7C2',
            padding: '14px',
          }}
        >
          <h3 style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '14px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Moonlight DAO
          </h3>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: '5px 0 12px' }}>
            EVM wind-down via NaveDaoStake: create a MoonlightRequest proposal, record it, set a recipient,
            pass a MoonlightDistribution proposal, execute stake release, then finalize. Deposit and new
            strategy requests are blocked on-chain while moonlighting.
          </p>
          {stakeAmount > 0n && (
            <div className="flex items-center justify-between pt-3 mb-3 border-t" style={{ borderColor: '#F2C7C2' }}>
              <span style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>Locked wNAVE stake</span>
              <span className="nave-mono" style={{ fontSize: '13px', fontWeight: 600 }}>{stakeAmount.toString()} base units</span>
            </div>
          )}
          {status === 0 && (
            <button
              type="button"
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 rounded-[9px] border font-semibold"
              style={{
                padding: '8px 14px',
                fontSize: '13px',
                backgroundColor: '#ffffff',
                borderColor: '#E5A49E',
                color: '#B42318',
              }}
              onClick={() => void run('begin', async () => {
                if (!governor) throw new Error('Governor not resolved');
                const built = buildCreateProposalEvm(evmChainId, governor, {
                  title: 'Moonlight request',
                  description: `Wind down ${dao?.name ?? 'this DAO'}`,
                  payload: '0x' as `0x${string}`,
                  proposalType: 9,
                  votingPeriodSeconds: votingPeriodForNetwork(MAINNET_DEFAULT_VOTING_PERIOD_SECONDS, { kind: 'evm', chainId: evmChainId }),
                  votingMint: resolvedVotingMint,
                });
                const outcome = await tx.sendEvm(built, { successLabel: 'Moonlight request created' });
                if (outcome.status === 'error') throw new Error(outcome.error ?? 'Proposal failed');
                setNotice('Vote on the MoonlightRequest in Governance, then record it below.');
                navigate('/decisions');
              })}
            >
              {busy === 'begin' ? 'Submitting…' : 'Begin Moonlighting…'}
            </button>
          )}
        </div>

        {error && <Notice tone="red"><span style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }}>{error}</span></Notice>}
        {notice && <Notice tone="brass"><span style={{ fontSize: '13px' }}>{notice}</span></Notice>}

        {status === 0 && (
          <div className="pt-3 space-y-2.5" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <label className="block" style={{ fontSize: '12.5px', fontWeight: 600 }}>Passed MoonlightRequest proposal index</label>
            <input className="w-full px-3 py-2.5 rounded-[10px] border text-sm bg-white" style={{ borderColor: 'hsl(var(--border))' }} value={requestIdx} onChange={(e) => setRequestIdx(e.target.value)} placeholder="e.g. 0" />
            <button
              type="button"
              disabled={!!busy}
              className="px-3.5 py-2 rounded-[9px] border font-semibold text-sm bg-white"
              style={{ borderColor: 'hsl(var(--border))' }}
              onClick={() => void run('record', async () => {
                if (!governor || !module) throw new Error('Module/governor missing');
                const idx = Number(requestIdx);
                if (!Number.isFinite(idx)) throw new Error('Enter proposal index');
                const built = buildRecordMoonlightRequestEvm(evmChainId, module, daoAddress, governor, idx);
                const outcome = await tx.sendEvm(built, { successLabel: 'Moonlight request recorded' });
                if (outcome.status === 'error') throw new Error(outcome.error ?? 'Record failed');
                setNotice('Moonlight recorded — deposits and new strategies are blocked on-chain.');
              })}
            >
              Record moonlight request
            </button>
          </div>
        )}

        {(status === 1 || status === 2) && (
          <div className="pt-3 space-y-2.5" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <label className="block" style={{ fontSize: '12.5px', fontWeight: 600 }}>Distribution recipient (0x…)</label>
            <input className="w-full px-3 py-2.5 rounded-[10px] border text-sm nave-mono bg-white" style={{ borderColor: 'hsl(var(--border))' }} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
            {status === 1 && (
              <button
                type="button"
                disabled={!!busy}
                className="px-4 py-2 rounded-[9px] font-semibold text-sm"
                style={{ backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
                onClick={() => void run('recipient', async () => {
                  if (!module) throw new Error('Module missing');
                  const built = buildSetMoonlightRecipientEvm(evmChainId, module, daoAddress, recipient);
                  const outcome = await tx.sendEvm(built, { successLabel: 'Recipient set' });
                  if (outcome.status === 'error') throw new Error(outcome.error ?? 'Set recipient failed');
                  if (!governor) throw new Error('Governor missing');
                  const payload = encodeAbiParameters([{ type: 'address' }], [recipient as Address]);
                  const prop = buildCreateProposalEvm(evmChainId, governor, {
                    title: 'Moonlight distribution',
                    description: `Distribute stake to ${recipient}`,
                    payload,
                    proposalType: 10,
                    votingPeriodSeconds: votingPeriodForNetwork(MAINNET_DEFAULT_VOTING_PERIOD_SECONDS, { kind: 'evm', chainId: evmChainId }),
                    votingMint: resolvedVotingMint,
                  });
                  await tx.sendEvm(prop, { successLabel: 'Distribution proposal created' });
                  setNotice('Vote on the MoonlightDistribution proposal, then execute below.');
                  navigate('/decisions');
                })}
              >
                Set recipient + create distribution proposal
              </button>
            )}
            {status === 2 && (
              <>
                <input className="w-full px-3 py-2.5 rounded-[10px] border text-sm bg-white" style={{ borderColor: 'hsl(var(--border))' }} value={distIdx} onChange={(e) => setDistIdx(e.target.value)} placeholder="Passed distribution proposal index" />
                <button
                  type="button"
                  disabled={!!busy}
                  className="px-4 py-2 rounded-[9px] font-semibold text-sm"
                  style={{ backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
                  onClick={() => void run('execute', async () => {
                    if (!module || !governor) throw new Error('Module/governor missing');
                    const idx = Number(distIdx);
                    if (!Number.isFinite(idx)) throw new Error('Enter proposal index');
                    const built = buildExecuteMoonlightDistributionEvm(evmChainId, module, daoAddress, governor, idx);
                    const outcome = await tx.sendEvm(built, { successLabel: 'Stake released' });
                    if (outcome.status === 'error') throw new Error(outcome.error ?? 'Execute failed');
                    setNotice('Stake released. Transfer remaining ERC-20/NFT assets via Governance, then finalize.');
                  })}
                >
                  Execute distribution
                </button>
              </>
            )}
          </div>
        )}

        {status === 3 && (
          <button
            type="button"
            disabled={!!busy}
            className="px-4 py-2 rounded-[9px] text-sm font-semibold"
            style={{ backgroundColor: 'hsl(var(--destructive))', color: '#ffffff' }}
            onClick={() => void run('finalize', async () => {
              if (!module) throw new Error('Module missing');
              const built = buildFinalizeMoonlightEvm(evmChainId, module, daoAddress);
              const outcome = await tx.sendEvm(built, { successLabel: 'DAO moonlighted' });
              if (outcome.status === 'error') throw new Error(outcome.error ?? 'Finalize failed');
              setNotice('DAO moonlighted. The founder can reopen it without a new stake.');
            })}
          >
            Finalize moonlight
          </button>
        )}

        {status === 4 && stakeToken && (
          <button
            type="button"
            disabled={!!busy || !evmAddress}
            className="px-4 py-2 rounded-[9px] text-sm font-semibold"
            style={{ backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
            onClick={() => void run('restore', async () => {
              if (!module || !stakeToken) throw new Error('Module/token missing');
              const amount = requiredStake > 0n ? requiredStake : stakeAmount;
              if (amount === 0n) throw new Error('No stake amount configured');
              const approve = buildApproveErc20Evm(evmChainId, stakeToken, module, amount);
              const restore = buildRestoreDaoEvm(evmChainId, module, daoAddress, amount, 0n);
              const outcome = await tx.sendEvm([approve, restore], { successLabel: 'DAO restored' });
              if (outcome.status === 'error') throw new Error(outcome.error ?? 'Restore failed');
              setNotice('DAO restored to Active. Re-enable agents explicitly if needed.');
            })}
          >
            Restake & restore DAO
          </button>
        )}
      </div>
    </Section>
  );
}

export default function MoonlightSection({ daoAddress, first = false }: { daoAddress: string; first?: boolean }) {
  const navigate = useNavigate();
  const { publicKey } = useWallet();
  const { dao } = useDaoRegistry(daoAddress);
  const tokenRegistry = useTokenRegistry(daoAddress);
  const tx = useSendTransaction();

  const walletStr = publicKey?.toBase58() ?? null;
  const isSolanaDao = chainKindFromAddress(daoAddress) === 'solana';
  const founder = (dao as { onChainData?: { founder?: string }; creatorWallet?: string } | null)?.onChainData?.founder ?? dao?.creatorWallet ?? null;
  const isFounder = !!walletStr && !!founder && founder === walletStr;
  const isTokenGov = dao?.governanceType === 'token';

  const [lifecycle, setLifecycle] = useState<MoonlightLifecycle | null>(null);
  const [stake, setStake] = useState<MoonlightStake | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Dialog states
  const [showConfirmBegin, setShowConfirmBegin] = useState(false);
  const [showRecordDialog, setShowRecordDialog] = useState(false);
  const [showDistDialog, setShowDistDialog] = useState(false);
  const [requestProposalIdx, setRequestProposalIdx] = useState('');
  const [recipient, setRecipient] = useState('');
  const [distProposalIdx, setDistProposalIdx] = useState('');

  const status = lifecycle?.status ?? 0;
  const isDriver = !!walletStr && !!lifecycle?.initiatedBy && lifecycle.initiatedBy === walletStr;
  const nextProposalIndex =
    typeof dao?.nextProposalIndex === 'number'
      ? dao.nextProposalIndex
      : (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);
  const proposalTotal = (dao?.proposalCount ?? 0) + (dao?.archivedProposalCount ?? 0);
  const { passedProposals } = useProposals(daoAddress, proposalTotal);
  const passedRequestProp = useMemo(
    () => passedProposals.find((p) => p.proposalType === ProposalType.MoonlightRequest),
    [passedProposals],
  );
  const passedDistProp = useMemo(
    () => passedProposals.find((p) => p.proposalType === ProposalType.MoonlightDistribution),
    [passedProposals],
  );

  useEffect(() => {
    if (passedRequestProp != null && !requestProposalIdx) {
      setRequestProposalIdx(String(passedRequestProp.index + 1));
    }
  }, [passedRequestProp, requestProposalIdx]);

  useEffect(() => {
    if (passedDistProp != null && !distProposalIdx) {
      setDistProposalIdx(String(passedDistProp.index + 1));
    }
  }, [passedDistProp, distProposalIdx]);

  const loadState = useCallback(async () => {
    if (!daoAddress || !isSolanaDao) return;
    setLoading(true);
    try {
      const { core } = getNavePrograms();
      const daoPubkey = new PublicKey(daoAddress);
      const [lcPda] = getDaoLifecyclePDA(daoPubkey);
      const [lockPda] = getDaoStakeLockPDA(daoPubkey);
      const [lc, lock] = await Promise.all([
        core.account.daoLifecycle.fetchNullable(lcPda),
        core.account.daoStakeLock.fetchNullable(lockPda),
      ]);
      setLifecycle(
        lc
          ? {
              exists: true,
              status: Number(lc.status),
              initiatedBy: nonZeroMoonlightKey((lc.initiatedBy as PublicKey).toBase58()),
              recipient: nonZeroMoonlightKey((lc.recipient as PublicKey).toBase58()),
              requestProposal: nonZeroMoonlightKey((lc.requestProposal as PublicKey).toBase58()),
              distributionProposal: nonZeroMoonlightKey((lc.distributionProposal as PublicKey).toBase58()),
            }
          : { exists: false, status: 0, initiatedBy: null, recipient: null, requestProposal: null, distributionProposal: null },
      );
      setStake(
        lock
          ? {
              exists: true,
              lockedAmount: BigInt((lock.lockedAmount as { toString: () => string }).toString()),
              status: Number(lock.status),
              naveMint: (lock.naveMint as PublicKey).toBase58(),
            }
          : { exists: false, lockedAmount: 0n, status: 0, naveMint: null },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load moonlight state');
    } finally {
      setLoading(false);
    }
  }, [daoAddress, isSolanaDao]);

  useEffect(() => { void loadState(); }, [loadState]);

  async function resolveDaoTokenMint(daoPubkey: PublicKey): Promise<PublicKey> {
    if (isTokenGov && tokenRegistry.tokens[0]?.mint) return new PublicKey(tokenRegistry.tokens[0].mint);
    const vault = await fetchTreasuryVault(daoPubkey);
    if (!vault?.vaultTokenAccount) throw new Error('Treasury vault is not initialized for this DAO yet.');
    const { core } = getNavePrograms();
    const acct = await getAccount(core.provider.connection, new PublicKey(vault.vaultTokenAccount));
    return acct.mint;
  }

  function resetMessages() { setError(null); setNotice(null); }

  async function run(label: string, fn: () => Promise<void>) {
    resetMessages();
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
      void loadState();
    }
  }

  function handleCreateRequestProposal() {
    void run('create-request', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      const daoPubkey = new PublicKey(daoAddress);
      const daoTokenMint = await resolveDaoTokenMint(daoPubkey);
      const result = await buildCreateProposal(
        daoPubkey, nextProposalIndex, publicKey,
        { title: 'Moonlight request', description: `Approve winding down ${dao?.name ?? 'this DAO'} (moonlight). Passing halts agents and unlocks the distribution wizard for the proposal creator.`, payload: [], proposalType: MOONLIGHT_REQUEST_TYPE, votingPeriodSeconds: votingPeriodForNetwork(MAINNET_MOONLIGHT_VOTING_PERIOD_SECONDS, { kind: 'solana', network: SOLANA_NETWORK }) },
        daoTokenMint,
      );
      const outcome = await tx.send(result, { successLabel: 'Moonlight request proposal created', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Proposal creation failed');
      setNotice(`Moonlight request proposal #${nextProposalIndex + 1} created. Vote on it in Governance — once it passes, record it below.`);
      setShowConfirmBegin(false);
      navigate('/decisions');
    });
  }

  function handleRecordRequest() {
    void run('record', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      const idx = Number.parseInt(requestProposalIdx.replace(/^#?p?/i, ''), 10);
      if (!Number.isFinite(idx) || idx < 1) throw new Error('Enter the passed request proposal number (e.g. 3).');
      const daoPubkey = new PublicKey(daoAddress);
      const [requestProposal] = getProposalPDA(daoPubkey, idx - 1);
      const result = await buildRecordMoonlightRequest(daoPubkey, publicKey, requestProposal);
      const outcome = await tx.send(result, { successLabel: 'Moonlight request recorded', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Recording failed');
      setNotice('Moonlight request recorded. Agents are halted. Continue the wind-down below.');
      setShowRecordDialog(false);
      setRequestProposalIdx('');
    });
  }

  function handleSetDistributionAndProposal() {
    void run('set-dist', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      let recipientKey: PublicKey;
      try { recipientKey = new PublicKey(recipient.trim()); }
      catch { throw new Error('Enter a valid recipient wallet address.'); }
      const daoPubkey = new PublicKey(daoAddress);
      const setResult = await buildSetMoonlightDistribution(daoPubkey, publicKey, recipientKey);
      const setOutcome = await tx.send(setResult, { successLabel: 'Recipient set', quietMock: true });
      if (setOutcome.status === 'error') throw new Error(setOutcome.error ?? 'Set recipient failed');
      const daoTokenMint = await resolveDaoTokenMint(daoPubkey);
      const payload = Array.from(recipientKey.toBytes());
      const propResult = await buildCreateProposal(
        daoPubkey, nextProposalIndex, publicKey,
        { title: 'Moonlight distribution', description: `Approve distributing all assets and the staked NAVE of ${dao?.name ?? 'this DAO'} to ${recipient.trim()}.`, payload, proposalType: MOONLIGHT_DISTRIBUTION_TYPE, votingPeriodSeconds: votingPeriodForNetwork(MAINNET_MOONLIGHT_VOTING_PERIOD_SECONDS, { kind: 'solana', network: SOLANA_NETWORK }) },
        daoTokenMint,
      );
      const propOutcome = await tx.send(propResult, { successLabel: 'Distribution proposal created', quietMock: true });
      if (propOutcome.status === 'error') throw new Error(propOutcome.error ?? 'Distribution proposal failed');
      setNotice(`Distribution proposal #${nextProposalIndex + 1} created. Vote on it in Governance — once it passes, execute the distribution below.`);
      setShowDistDialog(false);
      setRecipient('');
      navigate('/decisions');
    });
  }

  function handleExecuteDistribution() {
    void run('execute', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      const recipientStr = lifecycle?.recipient;
      if (!recipientStr) throw new Error('No approved recipient on record.');
      const idx = Number.parseInt(distProposalIdx.replace(/^#?p?/i, ''), 10);
      if (!Number.isFinite(idx) || idx < 1) throw new Error('Enter the passed distribution proposal number.');
      const daoPubkey = new PublicKey(daoAddress);
      const [distributionProposal] = getProposalPDA(daoPubkey, idx - 1);
      const naveMint = stake?.naveMint ? new PublicKey(stake.naveMint) : SOLANA_NAVE_MINT;
      const result = await buildExecuteMoonlightDistribution(daoPubkey, publicKey, naveMint, new PublicKey(recipientStr), distributionProposal);
      const outcome = await tx.send(result, { successLabel: 'Distribution executed', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Execution failed');
      setNotice('Distribution executed. Any locked NAVE stake has been released. Distribute remaining SOL/SPL assets via Governance, then finalize.');
    });
  }

  function handleFinalize() {
    void run('finalize', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      const daoPubkey = new PublicKey(daoAddress);
      const result = await buildFinalizeMoonlight(daoPubkey, publicKey);
      const outcome = await tx.send(result, { successLabel: 'DAO moonlighted', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Finalize failed');
      setNotice('DAO moonlighted — it is now hidden from participants. Only the founder can reopen it, and reopening does not require a new stake.');
    });
  }

  function handleRestore() {
    void run('restore', async () => {
      if (!publicKey || !daoAddress) throw new Error('Connect your Solana wallet.');
      if (!isFounder) throw new Error('Only the founder can reopen this DAO.');
      const daoPubkey = new PublicKey(daoAddress);
      const result = await buildRestoreDao(daoPubkey, publicKey);
      const outcome = await tx.send(result, { successLabel: 'DAO restored', quietMock: true });
      if (outcome.status === 'error') throw new Error(outcome.error ?? 'Restore failed');
      setNotice('DAO restored to Active. Reopening did not move NAVE. Re-enable agents explicitly if needed.');
    });
  }

  if (!isSolanaDao) {
    return <EvmMoonlightSection daoAddress={daoAddress} first={first} />;
  }

  return (
    <Section
      first={first}
      title="Wind down & moonlight"
      action={lifecycle ? <MoonlightStageBadge status={status} /> : undefined}
    >
      <div className="space-y-4">
        <div
          className="rounded-[12px] border"
          style={{
            backgroundColor: '#FFF9F8',
            borderColor: '#F2C7C2',
            padding: '14px',
          }}
        >
          <h3 style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '14px', fontWeight: 600, color: 'hsl(var(--foreground))' }}>
            Moonlight DAO
          </h3>
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: '5px 0 12px' }}>
            Wind a DAO down through governance: an approved request halts agents, then assets are distributed to an approved recipient. An existing locked NAVE stake, if this treasury has one, is returned with that distribution. New treasuries have nothing to return. The DAO stays hidden until the founder reopens it, which does not require a new stake.
          </p>
          {stake?.exists && stake.status !== 1 && (
            <div className="flex items-center justify-between pt-3 mb-3 border-t" style={{ borderColor: '#F2C7C2' }}>
              <span style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>Existing locked NAVE</span>
              <span className="nave-mono" style={{ fontSize: '13px', fontWeight: 600 }}>
                {naveBaseUnitsToUi(stake.lockedAmount.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 })} NAVE
              </span>
            </div>
          )}
          {status === 0 && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => setShowConfirmBegin(true)}
                disabled={!walletStr || !!busy}
                className="inline-flex items-center gap-1.5 rounded-[9px] border font-semibold"
                style={{
                  padding: '8px 14px',
                  fontSize: '13px',
                  backgroundColor: '#ffffff',
                  borderColor: '#E5A49E',
                  color: '#B42318',
                  opacity: !walletStr || !!busy ? 0.5 : 1,
                  cursor: !walletStr || !!busy ? 'not-allowed' : 'pointer',
                }}
              >
                {busy === 'create-request' ? 'Submitting…' : 'Begin Moonlighting…'}
              </button>
              {isFounder && (
                <button
                  type="button"
                  onClick={() => setShowRecordDialog(true)}
                  className="hover:underline underline-offset-4"
                  style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', fontWeight: 500 }}
                >
                  Record approved request
                </button>
              )}
            </div>
          )}
        </div>

        {/* Error / notice banners */}
        {error && (
          <Notice tone="red">
            <span style={{ fontSize: '13px', color: 'hsl(var(--destructive))' }}>{error}</span>
          </Notice>
        )}
        {notice && (
          <Notice tone="brass">
            <span style={{ fontSize: '13px' }}>{notice}</span>
          </Notice>
        )}

        {loading && !lifecycle && (
          <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>Loading moonlight state…</p>
        )}

        {/* Stage 1 — Moonlight Requested: set distribution */}
        {status === 1 && (
          <div className="pt-3 space-y-3" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: 0 }}>
              Before moonlighting, withdraw all assets from treasury via Governance transfer proposals, then set the distribution recipient below.
            </p>
            {isDriver ? (
              <button
                type="button"
                onClick={() => setShowDistDialog(true)}
                disabled={!!busy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: '#ffffff',
                }}
              >
                Set Distribution Wallet &amp; Create Proposal →
              </button>
            ) : (
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
                Waiting on the proposal creator{lifecycle?.initiatedBy ? ` (${lifecycle.initiatedBy.slice(0, 4)}…${lifecycle.initiatedBy.slice(-4)})` : ''} to set the recipient.
              </p>
            )}
          </div>
        )}

        {/* Stage 2 — Distribution pending: execute */}
        {status === 2 && (
          <div className="pt-3 space-y-3" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid hsl(var(--surface-2))' }}>
              <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>Approved recipient</span>
              <span className="nave-mono" style={{ fontSize: '12.5px', fontWeight: 500 }}>
                {lifecycle?.recipient ? `${lifecycle.recipient.slice(0, 6)}…${lifecycle.recipient.slice(-6)}` : '—'}
              </span>
            </div>
            {isDriver && (
              <div className="space-y-2.5">
                <input
                  value={distProposalIdx}
                  onChange={(e) => setDistProposalIdx(e.target.value)}
                  placeholder="Passed distribution proposal # (e.g. 4)"
                  className="w-full px-3 py-2.5 rounded-[10px] border outline-none"
                  style={{ fontSize: '13.5px', fontFamily: 'var(--font-mono)', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                />
                <button
                  type="button"
                  onClick={handleExecuteDistribution}
                  disabled={!!busy || !distProposalIdx.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold"
                  style={{
                    fontSize: '13px',
                    backgroundColor: 'hsl(var(--foreground))',
                    color: '#ffffff',
                    opacity: !!busy || !distProposalIdx.trim() ? 0.5 : 1,
                  }}
                >
                  {busy === 'execute' ? 'Executing…' : 'Execute distribution'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Stage 3 — Distributing: finalize */}
        {status === 3 && (
          <div className="pt-3 space-y-3" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
              Distribution is complete. Any locked NAVE stake has been released. Distribute remaining SOL, SPL tokens, and NFTs via recipient-bound Transfer proposals in Governance, then finalize.
            </p>
            {(isFounder || isDriver) && (
              <button
                type="button"
                onClick={handleFinalize}
                disabled={!!busy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--destructive))',
                  color: '#ffffff',
                }}
              >
                {busy === 'finalize' ? 'Finalizing…' : 'Finalize & Hide DAO'}
              </button>
            )}
          </div>
        )}

        {/* Stage 4 — Moonlighted */}
        {status === 4 && (
          <div className="pt-3 space-y-3" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
              This DAO is moonlighted and hidden from participants. Only the founder can reopen it, and reopening does not require a new stake.
            </p>
            {isFounder && (
              <button
                type="button"
                onClick={handleRestore}
                disabled={!!busy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-[9px] font-semibold"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: '#ffffff',
                }}
              >
                {busy === 'restore' ? 'Reopening…' : 'Reopen DAO'}
              </button>
            )}
          </div>
        )}

        {/* Confirm begin dialog */}
        <NaveModal
          open={showConfirmBegin}
          onClose={() => setShowConfirmBegin(false)}
          title="Begin Moonlighting?"
          maxWidth={440}
        >
          <div style={{ padding: '18px 22px 22px' }}>
            <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.65, margin: '0 0 18px' }}>
              This will create a governance proposal to wind down <strong>{dao?.name ?? 'this DAO'}</strong>. Once the proposal passes and is recorded by the founder, agents are halted and the distribution process begins.
            </p>
            <div className="flex justify-end gap-2 pt-4" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
              <button
                type="button"
                onClick={() => setShowConfirmBegin(false)}
                className="px-3.5 py-2 rounded-[9px] border font-semibold"
                style={{ fontSize: '13px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateRequestProposal}
                disabled={busy === 'create-request'}
                className="px-3.5 py-2 rounded-[9px] font-semibold"
                style={{ fontSize: '13px', backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
              >
                {busy === 'create-request' ? 'Submitting…' : 'Create Proposal'}
              </button>
            </div>
          </div>
        </NaveModal>

        {/* Record request dialog */}
        <NaveModal
          open={showRecordDialog}
          onClose={() => setShowRecordDialog(false)}
          title="Record Approved Request"
          subtitle="Enter the proposal number of the passed moonlight request (founder only)."
          maxWidth={440}
        >
          <div style={{ padding: '18px 22px 22px' }}>
            <input
              value={requestProposalIdx}
              onChange={(e) => setRequestProposalIdx(e.target.value)}
              placeholder="Proposal number (e.g. 3)"
              className="w-full px-3 py-2.5 rounded-[10px] border outline-none mb-4"
              style={{ fontSize: '13.5px', fontFamily: 'var(--font-mono)', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            />
            <div className="flex justify-end gap-2 pt-4" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
              <button
                type="button"
                onClick={() => setShowRecordDialog(false)}
                className="px-3.5 py-2 rounded-[9px] border font-semibold"
                style={{ fontSize: '13px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRecordRequest}
                disabled={!!busy || !requestProposalIdx.trim()}
                className="px-3.5 py-2 rounded-[9px] font-semibold"
                style={{ fontSize: '13px', backgroundColor: 'hsl(var(--foreground))', color: '#ffffff', opacity: !!busy || !requestProposalIdx.trim() ? 0.45 : 1 }}
              >
                {busy === 'record' ? 'Recording…' : 'Record'}
              </button>
            </div>
          </div>
        </NaveModal>

        {/* Distribution wallet dialog */}
        <NaveModal
          open={showDistDialog}
          onClose={() => setShowDistDialog(false)}
          title="Set Distribution Wallet"
          maxWidth={440}
        >
          <div style={{ padding: '18px 22px 22px' }}>
            <p style={{ fontSize: '13.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: '0 0 14px' }}>
              Enter the wallet that will receive the treasury assets. If this treasury still has a locked NAVE stake, that stake is released to the same recipient. This creates a binding distribution proposal that DAO members must vote on.
            </p>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Recipient wallet address"
              className="w-full px-3 py-2.5 rounded-[10px] border outline-none mb-4"
              style={{ fontSize: '13.5px', fontFamily: 'var(--font-mono)', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            />
            <div className="flex justify-end gap-2 pt-4" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
              <button
                type="button"
                onClick={() => setShowDistDialog(false)}
                className="px-3.5 py-2 rounded-[9px] border font-semibold"
                style={{ fontSize: '13px', backgroundColor: '#ffffff', borderColor: 'hsl(var(--border))' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSetDistributionAndProposal}
                disabled={!!busy || !recipient.trim()}
                className="px-3.5 py-2 rounded-[9px] font-semibold"
                style={{ fontSize: '13px', backgroundColor: 'hsl(var(--foreground))', color: '#ffffff', opacity: !!busy || !recipient.trim() ? 0.45 : 1 }}
              >
                {busy === 'set-dist' ? 'Submitting…' : 'Set & Create Proposal'}
              </button>
            </div>
          </div>
        </NaveModal>
      </div>
    </Section>
  );
}
