import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { signMessage as signEvmMessage } from '@wagmi/core';
import type { Address } from 'viem';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { registerDao } from '../lib/edgeFunctionClient';
import { NaveTreasuryAbi } from '../lib/evm/contracts';
import { fetchFactoryAddressEvm, publicClientForChain } from '../lib/evm/readers';
import {
  ACTIVATION_FEE_WEI,
  ARC_TESTNET_USDC,
  buildActivateDaoEvm,
  buildApproveErc20Evm,
  buildSetLinkedTreasuryEvm,
  buildSetPolicyParametersEvm,
  buildSetReviewWindowEvm,
  factorySupportsCrossChain,
  readHomeCreationImpls,
  type CrossChainImpls,
  type EvmBuildResult,
  readActivationFeeQuote,
  type EvmCreateDaoParams,
} from '../lib/evm/writers';
import { wagmiConfig } from '../lib/evm/wagmi';
import {
  evmChainIdFor,
  evmTarget,
  isEvmChainId,
  USER_CHAINS,
  type EvmChainFamily,
  type EvmChainId,
} from '../lib/chain/types';
import {
  FROZEN_PERFORMANCE_FEE_BPS,
  MANAGEMENT_FEE_BPS_FROZEN,
  MANAGEMENT_FEE_BPS_NORMAL,
  PERFORMANCE_FEE_BPS,
} from '../lib/programConfig';

const FEE_COPY =
  'Activation sends 0.001 ETH plus gas to protocol revenue. On Arc the fee is the USDC equivalent of 0.001 ETH, because gas there is USDC.';

interface Props {
  homeChainId: number;
  treasury: string;
  slug: string;
  name: string;
  description?: string;
}

/**
 * After a home-chain create, deploy the same treasury address on the other
 * EVM networks. The salt is the founder and the slug. Old factories that still
 * mix chain id into the salt cannot be moved; the panel says so.
 */
export default function ActivateTreasuryChains({ homeChainId, treasury, slug, name, description }: Props) {
  const { address: connected } = useAccount();
  const tx = useSendTransaction();
  const [busyChain, setBusyChain] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [activated, setActivated] = useState<Record<number, boolean>>({});
  const [supported, setSupported] = useState<boolean | null>(null);
  const [creationImpls, setCreationImpls] = useState<CrossChainImpls | null>(null);

  const homeOk = isEvmChainId(homeChainId);
  const home = homeOk ? evmTarget(homeChainId) : null;
  const network = home?.isTestnet ? 'testnet' : 'mainnet';
  const targets = USER_CHAINS.filter((family): family is EvmChainFamily => family !== 'solana' && family !== home?.family)
    .flatMap((family) => {
      if (family === 'arc' && network !== 'testnet') return [];
      try {
        return [evmChainIdFor(family, network)];
      } catch {
        return [];
      }
    });

  useEffect(() => {
    if (!homeOk) return;
    let cancelled = false;
    void (async () => {
      const factory = await fetchFactoryAddressEvm(homeChainId);
      if (!factory) {
        if (!cancelled) setSupported(false);
        return;
      }
      const ok = await factorySupportsCrossChain(homeChainId, factory);
      if (cancelled) return;
      setSupported(ok);
      if (!ok) return;
      const client = publicClientForChain(homeChainId);
      try {
        const founder = await client.readContract({
          address: treasury as Address,
          abi: NaveTreasuryAbi,
          functionName: 'founder',
        }) as Address;
        const impls = await readHomeCreationImpls(homeChainId, treasury as Address);
        const predictAbi = [{
          type: 'function',
          name: 'predictCrossChainAddresses',
          stateMutability: 'view',
          inputs: [
            { name: 'founder', type: 'address' },
            { name: 'slug', type: 'string' },
            { name: 'treasuryImpl', type: 'address' },
            { name: 'governorImpl', type: 'address' },
            { name: 'executionImpl', type: 'address' },
          ],
          outputs: [
            { name: 'treasury', type: 'address' },
            { name: 'governor', type: 'address' },
            { name: 'execution', type: 'address' },
          ],
        }] as const;
        let predictedTreasury: Address | null = null;
        if (impls) {
          try {
            const predicted = await client.readContract({
              address: factory,
              abi: predictAbi,
              functionName: 'predictCrossChainAddresses',
              args: [founder, slug, impls.treasury, impls.governor, impls.execution],
            }) as readonly [Address, Address, Address];
            predictedTreasury = predicted[0];
            setCreationImpls(impls);
          } catch {
            predictedTreasury = null;
          }
        }
        if (!predictedTreasury) {
          const predicted = await client.readContract({
            address: factory,
            abi: [{
              type: 'function',
              name: 'predictCrossChainAddresses',
              stateMutability: 'view',
              inputs: [
                { name: 'founder', type: 'address' },
                { name: 'slug', type: 'string' },
              ],
              outputs: [
                { name: 'treasury', type: 'address' },
                { name: 'governor', type: 'address' },
                { name: 'execution', type: 'address' },
              ],
            }],
            functionName: 'predictCrossChainAddresses',
            args: [founder, slug],
          }) as readonly [Address, Address, Address];
          predictedTreasury = predicted[0];
          setCreationImpls(null);
        }
        if (predictedTreasury.toLowerCase() !== treasury.toLowerCase()) {
          setSupported(false);
          setCreationImpls(null);
          setNote('This treasury was created with implementations that are not on the other chains, so its address cannot be reused.');
        }
      } catch {
        /* prediction is optional; activation still checks the factory */
      }
      const next: Record<number, boolean> = {};
      await Promise.all(targets.map(async (chainId) => {
        try {
          const code = await publicClientForChain(chainId).getBytecode({ address: treasury as Address });
          next[chainId] = !!code && code !== '0x';
        } catch {
          next[chainId] = false;
        }
      }));
      if (!cancelled) setActivated(next);
    })();
    return () => { cancelled = true; };
    // targets is derived from props; listing it would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeChainId, treasury, slug, homeOk]);

  async function readHomeParams(founder: Address): Promise<EvmCreateDaoParams> {
    const client = publicClientForChain(homeChainId as EvmChainId);
    const treasuryAddr = treasury as Address;
    const [onchainName, privacyMode, quorumBps, governanceType, revenue, guardianResult] = await Promise.all([
      client.readContract({ address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'name' }),
      client.readContract({ address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'privacyMode' }),
      client.readContract({ address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'quorumBps' }),
      client.readContract({ address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'governanceType' }),
      client.readContract({ address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'protocolRevenueWallet' }),
      client.readContract({ address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'getGuardians' }),
    ]);
    const agents = await Promise.all([0, 1, 2, 3].map((role) =>
      client.readContract({
        address: treasuryAddr,
        abi: NaveTreasuryAbi,
        functionName: 'agent',
        args: [role],
      }) as Promise<readonly [Address, boolean]>,
    ));
    const [guardianWallets, guardianThreshold] = guardianResult as readonly [readonly Address[], number];
    return {
      name: (onchainName as string) || name,
      privacyMode: Number(privacyMode),
      guardianWallets: [...guardianWallets],
      guardianThreshold: Number(guardianThreshold),
      agentAuthorities: agents.map((a) => a[0]) as [Address, Address, Address, Address],
      managementFeeBps: MANAGEMENT_FEE_BPS_NORMAL,
      performanceFeeBps: PERFORMANCE_FEE_BPS,
      frozenManagementFeeBps: MANAGEMENT_FEE_BPS_FROZEN,
      frozenPerformanceFeeBps: FROZEN_PERFORMANCE_FEE_BPS,
      protocolRevenueWallet: (revenue as Address) || founder,
      quorumBps: Number(quorumBps),
      governanceType: Number(governanceType),
    };
  }

  async function activate(chainId: EvmChainId) {
    setError('');
    setNote('');
    if (!connected) {
      setError('Connect the founder wallet to activate this treasury.');
      return;
    }
    const factory = await fetchFactoryAddressEvm(chainId);
    if (!factory) {
      setError('That chain does not have a Nave factory yet.');
      return;
    }
    const sameFactory = await factorySupportsCrossChain(chainId, factory);
    if (!sameFactory) {
      setError('That chain is still on the older factory. Same-address activation needs the deterministic factory.');
      return;
    }
    setBusyChain(chainId);
    try {
      const params = await readHomeParams(connected);
      const quote = await readActivationFeeQuote(chainId, factory);
      const steps: EvmBuildResult[] = [];
      if (chainId === 5042002 && quote.arcUsdcAmount > 0n) {
        steps.push(buildApproveErc20Evm(chainId, ARC_TESTNET_USDC, factory, quote.arcUsdcAmount));
      }
      const value = chainId === 5042002 ? 0n : (quote.nativeWei || ACTIVATION_FEE_WEI);
      steps.push(buildActivateDaoEvm(chainId, params, slug, value, factory, creationImpls ?? undefined));
      const outcome = await tx.sendEvm(steps, { successLabel: 'Treasury activated', quietToast: true });
      if (outcome.status !== 'success') {
        setError(outcome.error || 'Activation did not confirm.');
        return;
      }
      const linked = await linkSister(chainId);
      const policyCopied = await copyPolicy(chainId);
      const family = evmTarget(chainId).family;
      const { error: registerError } = await registerDao({
        dao_address: treasury,
        creator_wallet: connected,
        name: params.name || name,
        slug,
        description,
        governance_type: params.governanceType === 1 ? 'token' : 'wallet',
        authorized_wallets: params.guardianWallets,
        privacy_enabled: params.privacyMode !== 0,
        chain: family,
        chain_id: chainId,
      }, (message) => signEvmMessage(wagmiConfig, { message }));
      if (registerError) {
        setNote(`Activated on-chain. Saving it to your treasury list failed: ${registerError}`);
      } else if (!linked) {
        setNote(`${evmTarget(chainId).label} is active at the same address. Linking it for Ethereum yield still needs a founder signature.`);
      } else if (!policyCopied) {
        setNote(`${evmTarget(chainId).label} is active at the same address. Review window and policy still need a founder signature on that chain.`);
      } else {
        setNote(`${evmTarget(chainId).label} is active at the same address.`);
      }
      setActivated((prev) => ({ ...prev, [chainId]: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed.');
    } finally {
      setBusyChain(null);
    }
  }

  async function linkSister(chainId: EvmChainId): Promise<boolean> {
    const built = [
      buildSetLinkedTreasuryEvm(homeChainId as EvmChainId, treasury, chainId, treasury),
      buildSetLinkedTreasuryEvm(chainId, treasury, homeChainId, treasury),
    ];
    if (built.some((step) => !step.request)) return false;
    const outcome = await tx.sendEvm(built, { successLabel: 'Chains linked', quietToast: true });
    return outcome.status === 'success';
  }

  async function copyPolicy(chainId: EvmChainId): Promise<boolean> {
    const homeClient = publicClientForChain(homeChainId as EvmChainId);
    const treasuryAddr = treasury as Address;
    try {
      const [review, policy, freq] = await Promise.all([
        homeClient.readContract({ address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'reviewWindowSecs' }),
        homeClient.readContract({ address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'policyBps' }),
        homeClient.readContract({ address: treasuryAddr, abi: NaveTreasuryAbi, functionName: 'rebalanceFrequencySecs' }),
      ]);
      const [reserve, deployed, liquidity] = policy as readonly [number, number, number];
      const built = [
        buildSetReviewWindowEvm(chainId, treasury, review as bigint),
        buildSetPolicyParametersEvm(chainId, treasury, Number(reserve), Number(deployed), Number(liquidity), freq as bigint),
      ];
      const outcome = await tx.sendEvm(built, { successLabel: 'Constitution copied', quietToast: true });
      return outcome.status === 'success';
    } catch {
      return false;
    }
  }

  if (!homeOk) return null;

  return (
    <div className="mt-6" style={{ borderTop: '1px solid hsl(var(--surface-2))', paddingTop: 16 }}>
      <div className="nave-label" style={{ marginBottom: 8 }}>Activate on another chain</div>
      <p style={{ fontSize: 13.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.55, margin: '0 0 12px' }}>
        {FEE_COPY} Guardians, agents, and quorum are copied from {home?.label}. Venue allowlists stay per chain, because those contracts are not the same address.
      </p>
      {supported === false && !note && (
        <p style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))', marginBottom: 8 }}>
          Same-address activation is available once this chain is on the deterministic factory.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {targets.map((chainId) => {
          const label = evmTarget(chainId).label;
          const done = activated[chainId];
          return (
            <button
              key={chainId}
              type="button"
              disabled={done || busyChain !== null || supported === false}
              onClick={() => { void activate(chainId); }}
              className="px-3 py-1.5 rounded-full border font-semibold"
              style={{
                fontSize: 12.5,
                borderColor: 'hsl(var(--border))',
                backgroundColor: done ? 'hsl(var(--foreground))' : '#ffffff',
                color: done ? '#ffffff' : 'hsl(var(--foreground))',
                opacity: busyChain !== null && busyChain !== chainId ? 0.6 : 1,
              }}
            >
              {done ? `${label} active` : busyChain === chainId ? `Activating ${label}…` : label}
            </button>
          );
        })}
      </div>
      {note && <p style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', marginTop: 10 }}>{note}</p>}
      {error && <p style={{ fontSize: 12.5, color: 'hsl(var(--destructive))', marginTop: 10 }}>{error}</p>}
    </div>
  );
}
