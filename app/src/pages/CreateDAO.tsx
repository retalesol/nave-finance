import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { useAccount, useSignMessage } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { getTransactionReceipt, readContract } from '@wagmi/core';
import { decodeEventLog, parseEther, parseUnits, type Address } from 'viem';
import { wagmiConfig } from '../lib/evm/wagmi';
import Fi from '../components/Fi';
import TreasuryDeployModal, { type DeployStep, type DeployStepStatus } from '../components/TreasuryDeployModal';
import ConstitutionStep, {
  type PolicyState,
  policyForChain,
  RISK_PRESETS,
  rebalanceFreqToSecs,
} from '../components/ConstitutionStep';
import {
  type DAOConfig,
  type SetupMode,
  DEFAULT_CONFIG,
  ADVANCED_STEPS,
  QUICK_STEPS,
  EVM_SUB_STEP_LABELS,
  SOLANA_SUB_STEP_LABELS,
  ZERO_EVM_ADDRESS,
  displayStepIndex,
  StepIndicator,
} from '../components/create-dao/CreateDaoHelpers';
import Step1 from '../components/create-dao/Step1';
import SeedReviewStep from '../components/create-dao/SeedReviewStep';
import { useDaoContext } from '../hooks/useDaoContext';
import { useChain } from '../hooks/useChain';
import { useSendTransaction } from '../hooks/useSendTransaction';
import { buildCreateDaoEvm, buildRegisterDaoTokenEvm, buildRegisterExternalDaoTokenEvm, type EvmCreateDaoParams } from '../lib/evm/writers';
import { NaveDAOFactoryAbi, NaveTreasuryAbi, Erc20Abi } from '../lib/evm/contracts';
import { fetchFormationFeeEvm, fetchFactoryAddressEvm } from '../lib/evm/readers';
import { ensureWalletOnChain } from '../lib/evm/ensureWalletChain';
import { toAddress } from '../lib/evm/addresses';
import { EVM_PROTOCOL_REVENUE_WALLET, SOLANA_NETWORK, activeEvmChainId, chainDisplayLabel, SYSTEM_CONFIDENCE_THRESHOLD } from '../lib/programConfig';
import { type ChainFamily, type DaoEvmChainFamily, type EvmChainId, evmActivationChainFamily, USER_CHAINS } from '../lib/chain/types';
import {
  buildInitializeDao,
  buildInitializeDaoExtensions,
  buildInitializeDaoGovernance,
  buildRegisterDaoToken,
  type InitializeDaoParams,
  type TransactionBuildResult,
} from '../lib/transactionBuilders';
import { getDaoRegistryPDA, getNaveGlobalConfigPDA, getVaultAuthorityPDA, getAgentSetPDA } from '../lib/pdaDerivation';
import { getNavePrograms } from '../lib/naveProgram';
import { generateAgentKeys, registerDao, generateEvmAgentKeys, bindEvmAgentKeys, setAgentsEnabledViaProxy, solanaAccessSigner } from '../lib/edgeFunctionClient';
import {
  runSolanaAutoActivation,
  type ActivationStepId,
} from '../lib/createDaoActivation';
import { runEvmActivation } from '../lib/createDaoActivationEvm';
import { uploadDaoLogo } from '../lib/uploadLogo';
import {
  MANAGEMENT_FEE_BPS_NORMAL,
  MANAGEMENT_FEE_BPS_FROZEN,
  PERFORMANCE_FEE_BPS,
  FROZEN_PERFORMANCE_FEE_BPS,
  TOKEN_MINT_FEE_ETH,
  AGENT_WALLET_SEED_SOL,
  AGENT_WALLET_TOTAL_SEED_SOL,
  DAO_FORMATION_FEE_SOL,
  TREASURY_SEED_SOL,
  NAVE_PROTOCOL_FEE_WALLET,
  defaultGuardianThreshold,
} from '../lib/programConfig';
import {
  savePendingDaoCreation,
  clearPendingDaoCreation,
  findPendingDaoCreationForWallet,
  type PendingDaoCreation,
} from '../lib/daoCreationRecovery';

/* ── Main page ───────────────────────────────────────────── */
export default function CreateDAO() {
  const navigate = useNavigate();
  const { connected, publicKey, signMessage } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const { setDaoAddress } = useDaoContext();
  const { setChainFamily, rememberDaoChain } = useChain();
  const { address: evmAddress, isConnected: evmConnected, chainId: connectedEvmChainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { signMessageAsync: signEvmMessage } = useSignMessage();
  const tx = useSendTransaction();
  const [setupMode, setSetupMode] = useState<SetupMode>('quick');
  const [step, setStep] = useState(0);
  // Launch create is Base. Solana and Ethereum stay on their non-create paths.
  const [config, setConfigState] = useState<DAOConfig>(() => ({
    ...DEFAULT_CONFIG,
    chain: 'base',
  }));
  // Constitution policy state — quick setup starts on the Conservative preset.
  const [policy, setPolicyState] = useState<PolicyState>(() => policyForChain('base', 'conservative'));
  // Treasury seed amount (native SOL or ETH as string). 0 is a valid seed and must not block Deploy.
  const [seedAmount, setSeedAmount] = useState<string>('0');
  const [deploying, setDeploying] = useState(false);
  const [deploySteps, setDeploySteps] = useState<DeployStep[]>([]);

  const DEPLOY_STEP_TEMPLATES_SOLANA = [
    { id: 'foundation', label: 'Sign 1 of 3 — Foundation' },
    { id: 'governance', label: 'Sign 2 of 3 — Governance' },
    { id: 'activate',   label: 'Sign 3 of 3 — Activate & Ratify' },
    { id: 'agents',     label: 'Starting agents…' },
  ] as const;

  const DEPLOY_STEP_TEMPLATES_EVM = [
    { id: 'create',   label: 'Sign 1 of 2 — Create Treasury' },
    { id: 'activate', label: 'Sign 2 of 2 — Activate & Ratify' },
    { id: 'agents',   label: 'Starting agents…' },
  ] as const;

  function initDeploySteps(isSolana: boolean) {
    const template = isSolana ? DEPLOY_STEP_TEMPLATES_SOLANA : DEPLOY_STEP_TEMPLATES_EVM;
    setDeploySteps(template.map((s) => ({ ...s, status: 'pending' as DeployStepStatus })));
  }

  function patchDeployStep(id: string, status: DeployStepStatus, detail?: string | null) {
    setDeploySteps((prev) =>
      prev.map((s) => (
        s.id === id
          ? { ...s, status, detail: detail === undefined ? s.detail : detail ?? undefined }
          : s
      )),
    );
  }

  function beginDeployStep(id: string) {
    setDeploySteps((prev) =>
      prev.map((s) => {
        if (s.id === id) return { ...s, status: 'running' as DeployStepStatus, detail: undefined };
        if (s.status === 'running') return { ...s, status: 'done' as DeployStepStatus };
        return s;
      }),
    );
  }

  function completeDeployStep(id: string, detail?: string) {
    patchDeployStep(id, 'done', detail);
  }

  function failDeployStep(id: string, detail?: string) {
    patchDeployStep(id, 'error', detail);
  }

  const deployActiveHint =
    deploySteps.find((s) => s.status === 'running')?.label ??
    'Approve the transaction in your wallet when prompted.';
  const [walletError, setWalletError] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [slugReady, setSlugReady] = useState(false);
  const [slugMessage, setSlugMessage] = useState<string | null>(null);
  const [evmFormationFeeWei, setEvmFormationFeeWei] = useState<bigint | null>(null);
  const [evmFormationFeeLoading, setEvmFormationFeeLoading] = useState(false);

  function setConfig(partial: Partial<DAOConfig>) {
    setConfigState(prev => ({ ...prev, ...partial }));
  }

  function setPolicy(partial: Partial<PolicyState>) {
    setPolicyState(prev => ({ ...prev, ...partial }));
  }

  // Keep the active chain synced to the selection. The wallet switch is the
  // same request deploy awaits, so selecting a network and then deploying
  // does not open a second MetaMask prompt.
  useEffect(() => {
    setChainFamily(config.chain);
    if (config.chain === 'solana' || !evmConnected) return;
    const targetId = activeEvmChainId(config.chain as Exclude<ChainFamily, 'solana'>);
    if (connectedEvmChainId === targetId) return;
    void ensureWalletOnChain(targetId).catch(() => {
      // Deploy repeats this check and surfaces the wallet error there.
    });
  }, [config.chain, setChainFamily, evmConnected, connectedEvmChainId]);

  useEffect(() => {
    setPolicyState((prev) => policyForChain(config.chain, prev.riskPreset));
  }, [config.chain]);

  useEffect(() => {
    if (step !== 2 || config.chain === 'solana') return;
    let cancelled = false;
    setEvmFormationFeeLoading(true);
    const chainId = activeEvmChainId(config.chain as Exclude<ChainFamily, 'solana'>);
    fetchFormationFeeEvm(chainId)
      .then((fee) => {
        if (!cancelled) setEvmFormationFeeWei(fee);
      })
      .catch(() => {
        if (!cancelled) setEvmFormationFeeWei(null);
      })
      .finally(() => {
        if (!cancelled) setEvmFormationFeeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, config.chain]);

  function handleSlugReadyChange(ready: boolean, message: string | null) {
    setSlugReady(ready);
    setSlugMessage(message);
  }
  const onSlugReadyChange = useCallback(handleSlugReadyChange, []);

  const wizardSteps = setupMode === 'quick' ? QUICK_STEPS : ADVANCED_STEPS;
  const connectedWallet =
    config.chain === 'solana'
      ? (publicKey?.toBase58() ?? null)
      : (evmAddress ?? null);

  // ── Resume-setup: an earlier attempt created a treasury on-chain but a
  // post-creation step (agent-key binding, token registration, metadata sync,
  // constitution activation) failed. Surface it as a persistent banner so the
  // founder can finish setup instead of accidentally creating a second DAO.
  const [pendingResume, setPendingResume] = useState<PendingDaoCreation | null>(null);
  const [resuming, setResuming] = useState(false);
  useEffect(() => {
    setPendingResume(findPendingDaoCreationForWallet(connectedWallet));
  }, [connectedWallet]);

  function selectSetupMode(mode: SetupMode) {
    setSetupMode(mode);
    if (mode === 'quick') {
      setStep(0);
      setConfig({
        governanceType: 'wallets',
        authorizedWallets: connectedWallet ? [connectedWallet] : [],
      });
      setPolicyState(policyForChain(config.chain, 'conservative'));
    }
  }

  useEffect(() => {
    if (setupMode !== 'quick') return;
    setPolicyState(policyForChain(config.chain, 'conservative'));
  }, [setupMode, config.chain]);

  function openCreateWallet() {
    if (config.chain === 'solana') setVisible(true);
    else openConnectModal?.();
  }

  // Keep quick-mode guardian in sync when the wallet connects after mode selection.
  useEffect(() => {
    if (setupMode !== 'quick' || !connectedWallet) return;
    if (config.governanceType !== 'wallets') {
      setConfig({ governanceType: 'wallets' });
    }
    if (!config.authorizedWallets.includes(connectedWallet)) {
      setConfig({ authorizedWallets: [connectedWallet] });
    }
  }, [setupMode, connectedWallet, config.governanceType, config.authorizedWallets]);

  function canAdvance() {
    if (step === 0) {
      if (config.chain === 'solana') {
        if (!connected || !publicKey) return false;
      } else if (!evmConnected || !evmAddress) {
        return false;
      }
      if (!config.name.trim()) return false;
      if (!config.slug.trim() || !slugReady) return false;
      if (setupMode === 'quick') {
        return config.governanceType === 'wallets' && config.authorizedWallets.length > 0;
      }
      if (!config.governanceType) return false;
      if (config.governanceType === 'token' && !config.tokenMode) return false;
      if (config.governanceType === 'token' && config.tokenMode === 'existing') {
        const token = config.existingTokenCA.trim();
        if (!token) return false;
        if (config.chain === 'solana') {
          try {
            new PublicKey(token);
          } catch {
            return false;
          }
        } else if (!toAddress(token)) {
          return false;
        }
      }
      if (config.governanceType === 'token' && config.tokenMode === 'new' && !config.newTokenName.trim()) return false;
    }
    if (step === 1) {
      // At least one protocol must be approved
      return Object.values(policy.approvedProtocols).some((v) => v);
    }
    if (step === 2) {
      // Seed must be a valid non-negative number (empty = not ready; "0" is valid)
      const seedNum = parseFloat(seedAmount);
      return !isNaN(seedNum) && seedNum >= 0;
    }
    return true;
  }

  async function handleDeployEvm() {
    // EVM (Ethereum/Base) deployment via the NaveDAOFactory clone. Requires a
    // connected EVM wallet and configured factory/protocol addresses; otherwise
    // sendEvm surfaces a clear "not configured" message (or demo mock).
    if (!evmConnected || !evmAddress) {
      setWalletError(true);
      return;
    }
    setWalletError(false);
    setTxError(null);
    setDeploying(true);
    initDeploySteps(false);
    beginDeployStep('create');

    // Populated once the treasury exists on-chain — from that point on, any
    // failure is a POST-creation failure (the DAO is real; don't lose it).
    // `currentSubStep` tracks finer-grained progress than the visible deploy
    // steps so a resume can report/label exactly where it left off.
    let checkpoint: Omit<PendingDaoCreation, 'failedStep' | 'failedError' | 'failedAt'> | null = null;
    let currentSubStep: 'create' | 'bind-keys' | 'token-registration' | 'register-metadata' | 'activate' = 'create';

    try {
      const family = config.chain as DaoEvmChainFamily;
      const chainId = activeEvmChainId(family);
      patchDeployStep('create', 'running', `Switching your wallet to ${chainDisplayLabel(family)}. Approve that prompt before signing.`);
      await ensureWalletOnChain(chainId);
      patchDeployStep('create', 'running', null);
      const founder = evmAddress as Address;
      const isTokenGov = config.governanceType === 'token';
      let votingTokenMint: Address | null = null;

      if (isTokenGov && config.tokenMode === 'existing') {
        votingTokenMint = toAddress(config.existingTokenCA);
        if (!votingTokenMint) {
          throw new Error('Enter a valid ERC-20 token contract address for EVM token governance.');
        }
      }

      // 1. Generate the 4 real EVM agent EOAs (+ a server-custodied guardian)
      //    keyed by an unguessable ref. EVM clones use CREATE, so the treasury
      //    address isn't known until the tx is mined — we rebind the keys to it
      //    after the DaoCreated event below. The founder proves ownership by
      //    signing the keygen challenge with their EVM wallet (EIP-191).
      const daoRef = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '');
      const keygenMsg = `nave-evm-keygen|${daoRef}|${chainId}|${Date.now()}`;
      const keygenSig = await signEvmMessage({ message: keygenMsg });
      const { data: keyData, error: keyError } = await generateEvmAgentKeys(
        daoRef, founder, chainId, family, keygenMsg, keygenSig,
      );
      if (keyError || !keyData) {
        throw new Error(`EVM agent key generation failed: ${keyError ?? 'unknown error'}`);
      }
      const agentAuthorities: [Address, Address, Address, Address] = [
        keyData.agents.executive.address as Address,
        keyData.agents.financial.address as Address,
        keyData.agents.oversight.address as Address,
        keyData.agents.operational.address as Address,
      ];

      // The connected wallet is always a guardian; the generated guardian signer
      // joins the set so the server-side M-of-N path has a usable signer too.
      const guardianWallets: Address[] =
        config.governanceType === 'wallets' && config.authorizedWallets.length > 0
          ? config.authorizedWallets.map((w) => w.trim() as Address)
          : [founder];
      if (keyData.guardian?.address && !guardianWallets.some((w) => w.toLowerCase() === keyData.guardian!.address.toLowerCase())) {
        guardianWallets.push(keyData.guardian.address as Address);
      }
      if (!guardianWallets.some((w) => w.toLowerCase() === founder.toLowerCase())) {
        guardianWallets.unshift(founder);
      }
      const custodiedGuardians = keyData.guardian?.address ? 1 : 0;

      const params: EvmCreateDaoParams = {
        name: config.name,
        privacyMode: 0,
        guardianWallets,
        guardianThreshold: defaultGuardianThreshold(guardianWallets.length, custodiedGuardians),
        agentAuthorities,
        managementFeeBps: MANAGEMENT_FEE_BPS_NORMAL,
        performanceFeeBps: PERFORMANCE_FEE_BPS,
        frozenManagementFeeBps: MANAGEMENT_FEE_BPS_FROZEN,
        frozenPerformanceFeeBps: FROZEN_PERFORMANCE_FEE_BPS,
        // Protocol-revenue share routes to the Nave-controlled fee wallet when
        // configured (mirrors Solana's protocol treasury); falls back to the
        // founder on deployments without one set (e.g. testnets).
        protocolRevenueWallet: (toAddress(EVM_PROTOCOL_REVENUE_WALLET ?? null) ?? founder) as Address,
        quorumBps: 3500,
        governanceType: isTokenGov ? 1 : 0,
      };

      // 2. Resolve factory address + formation fee from the on-chain protocol.
      //    fetchFactoryAddressEvm tries the env var first, then falls back to
      //    reading NaveProtocol.factory() — so it works even if .env.local hasn't
      //    been reloaded / the factory env var isn't set yet.
      const [resolvedFactory, formationFeeWei] = await Promise.all([
        fetchFactoryAddressEvm(chainId),
        fetchFormationFeeEvm(chainId).then(f => f ?? 0n),
      ]);
      if (!resolvedFactory) {
        throw new Error(
          `NaveDAOFactory is not deployed on this network yet (chain ${chainId}). ` +
          `Testnet factories fall back to the deployed Sepolia, Base Sepolia, Robinhood Testnet, and Arc Testnet stacks.`,
        );
      }
      // formationFee is 0. Any msg.value above that is the founder's own seed, not a fee.
      // On Arc Testnet (5042002), NaveProtocol.wrappedNative() is address(0) because
      // native gas is 18-decimal USDC while the treasury asset is 6-decimal ERC-20 USDC
      // (0x3600000000000000000000000000000000000000); passing seedWei > 0 reverts
      // seedNativeTreasury() with WrappedNativeNotConfigured().
      const seedNum = parseFloat(seedAmount);
      const seedWei =
        chainId === 5042002
          ? 0n
          : !isNaN(seedNum) && seedNum > 0
            ? parseEther(String(seedNum))
            : 0n;
      const totalValue = formationFeeWei + seedWei;
      const build = buildCreateDaoEvm(chainId, params, totalValue, resolvedFactory);
      const outcome = await tx.sendEvm(build, { successLabel: 'Treasury deployed', quietMock: true, quietToast: true });

      if (outcome.status === 'success') {
        completeDeployStep('create');
        // 3. Recover the treasury address from the DaoCreated event so we can
        //    rebind agent keys, persist chain metadata, and register off-chain
        //    DAO metadata. The indexer also records the trio from the same event.
        let treasury: Address | null = null;
        if (outcome.txHash) {
          const receipt = await getTransactionReceipt(wagmiConfig, { hash: outcome.txHash as `0x${string}`, chainId });
          for (const log of receipt.logs) {
            try {
              const decoded = decodeEventLog({ abi: NaveDAOFactoryAbi, data: log.data, topics: log.topics });
              if (decoded.eventName === 'DaoCreated') {
                treasury = (decoded.args as unknown as { treasury: Address }).treasury;
                break;
              }
            } catch { /* not a DaoCreated log */ }
          }
        }
        if (!treasury) {
          throw new Error('Treasury deployed, but the DaoCreated event could not be decoded. Please refresh and join the DAO by address once the indexer catches up.');
        }

        // The DAO now exists on-chain. From here on, any failure is a
        // POST-creation failure — persist a resumable checkpoint so a retry
        // (via the "Resume setup" banner) can finish the remaining steps
        // instead of restarting the wizard (which would create a SECOND DAO).
        checkpoint = {
          chain: family,
          chainId,
          daoAddress: treasury,
          daoRef,
          founder,
          name: config.name,
          slug: config.slug,
          description: config.description,
          governanceType: config.governanceType,
          tokenMode: config.tokenMode,
          existingTokenCA: config.existingTokenCA,
          newTokenName: config.newTokenName,
          newTokenSupply: config.newTokenSupply,
          votingTokenMint: votingTokenMint ?? null,
          guardianWallets,
          seedAmount,
          policy,
          website: config.website,
          twitter: config.twitter,
          discord: config.discord,
          logoUrl: '',
        };

        currentSubStep = 'bind-keys';
        await ensureWalletOnChain(chainId);
        const bindMsg = `nave-evm-keybind|${daoRef}|${treasury.toLowerCase()}|${chainId}|${Date.now()}`;
        const bindSig = await signEvmMessage({ message: bindMsg });
        const { error: bindError } = await bindEvmAgentKeys(daoRef, treasury, founder, chainId, family, bindMsg, bindSig);
        if (bindError) {
          throw new Error(`Treasury deployed, but agent key binding failed: ${bindError}`);
        }

        // 4. For EVM token governance, register the voting token on the treasury clone.
        currentSubStep = 'token-registration';
        if (isTokenGov && config.tokenMode === 'new') {
          const evmDecimals = 18;
          const initialSupply = parseUnits(config.newTokenSupply || '0', evmDecimals);
          if (initialSupply <= 0n) {
            throw new Error('Enter a positive initial token supply.');
          }
          const tokenOutcome = await tx.sendEvm(
            buildRegisterDaoTokenEvm(
              chainId,
              treasury,
              config.newTokenName.trim(),
              config.newTokenName.trim().toUpperCase().slice(0, 11),
              evmDecimals,
              initialSupply,
              treasury,
              parseEther(String(TOKEN_MINT_FEE_ETH)),
            ),
            { successLabel: 'Governance token deployed' },
          );
          if (tokenOutcome.status !== 'success' || !tokenOutcome.txHash) {
            throw new Error(tokenOutcome.error || 'Treasury deployed, but governance token registration failed.');
          }
          const tokenReceipt = await getTransactionReceipt(wagmiConfig, { hash: tokenOutcome.txHash as `0x${string}`, chainId });
          for (const log of tokenReceipt.logs) {
            try {
              const decoded = decodeEventLog({ abi: NaveTreasuryAbi, data: log.data, topics: log.topics });
              if (decoded.eventName === 'DaoTokenRegistered') {
                votingTokenMint = (decoded.args as unknown as { mint: Address }).mint;
                break;
              }
            } catch { /* not a DaoTokenRegistered log */ }
          }
          if (!votingTokenMint) {
            throw new Error('Treasury deployed, but the governance token address could not be decoded.');
          }
          if (checkpoint) checkpoint.votingTokenMint = votingTokenMint;
        } else if (isTokenGov && config.tokenMode === 'existing' && votingTokenMint) {
          let tokenDecimals = 18;
          try {
            tokenDecimals = Number(await readContract(wagmiConfig, {
              address: votingTokenMint,
              abi: Erc20Abi,
              functionName: 'decimals',
              chainId,
            }));
          } catch {
            /* default 18 */
          }
          const tokenName = config.name.trim() || 'Governance Token';
          const tokenSymbol = tokenName.toUpperCase().slice(0, 11) || 'GOV';
          const regOutcome = await tx.sendEvm(
            buildRegisterExternalDaoTokenEvm(
              chainId,
              treasury,
              votingTokenMint,
              tokenName,
              tokenSymbol,
              tokenDecimals,
            ),
            { successLabel: 'Governance token registered' },
          );
          if (regOutcome.status !== 'success' && regOutcome.status !== 'mock') {
            throw new Error(regOutcome.error || 'Treasury deployed, but governance token registration failed.');
          }
        }

        const evmGuardianThreshold = defaultGuardianThreshold(guardianWallets.length, custodiedGuardians);

        // 5. Persist the resolved chain id for this DAO address so future loads
        //    reconcile to the right chain (Ethereum vs Base) instead of
        //    defaulting to Ethereum, and select the new treasury.
        rememberDaoChain(treasury, chainId);
        setDaoAddress(treasury);

        let logoUrl = '';
        if (config.logoBlob) {
          try {
            logoUrl = await uploadDaoLogo(
              config.logoBlob,
              config.name || treasury,
              founder,
              treasury,
              async (m) => {
                await ensureWalletOnChain(chainId);
                return signEvmMessage({ message: m });
              },
              { chain: family, chainId },
            );
          } catch {
            /* logo upload is non-blocking */
          }
        }
        if (checkpoint) checkpoint.logoUrl = logoUrl;

        // 6. Attach off-chain metadata (name, socials, governance, chain) to
        //    the registry so the EVM DAO shows up in the lobby with full
        //    metadata (the indexer only writes the minimal identity row).
        //    register-dao verifies an EIP-191 personal_sign over a fresh single-use
        //    `nave-register-dao|…` challenge (built inside registerDao).
        currentSubStep = 'register-metadata';
        const { error: registerError } = await registerDao({
          dao_address: treasury,
          creator_wallet: founder,
          name: config.name,
          slug: config.slug,
          description: config.description,
          logo_url: logoUrl,
          governance_type: isTokenGov ? 'token' : 'wallet',
          voting_token_mint: isTokenGov ? votingTokenMint ?? undefined : undefined,
          authorized_wallets: guardianWallets,
          privacy_enabled: false,
          social_website: config.website,
          social_twitter: config.twitter,
          social_discord: config.discord,
          chain: family,
          chain_id: chainId,
        }, async (m) => {
          await ensureWalletOnChain(chainId);
          return signEvmMessage({ message: m });
        });
        if (registerError) {
          throw new Error(`Treasury created on-chain, but metadata sync failed: ${registerError}. Treasury address: ${treasury}`);
        }
        // register-dao auto-watches the creator wallet server-side; watch-dao
        // now requires its own signed challenge, so no extra prompt here.

        // ── Tx 2: Constitution + policy + agent enable ────────────────────────
        currentSubStep = 'activate';
        beginDeployStep('activate');
        const chainLabel = evmActivationChainFamily(chainId);
        const evmActivationResult = await runEvmActivation({
          daoAddress: treasury,
          chainId,
          chain: chainLabel,
          founderAddress: founder,
          policy,
          seedAmount,
          sendEvm: (r, opts) => tx.sendEvm(r, opts),
          signMessage: async (msg) => {
            await ensureWalletOnChain(chainId);
            return signEvmMessage({ message: msg });
          },
          executiveAddress: keyData.agents.executive.address,
          onStep: (label) => {
            if (label.includes('Activate')) beginDeployStep('activate');
            if (label.includes('agents')) beginDeployStep('agents');
          },
        });
        if (!evmActivationResult.ok) {
          failDeployStep('activate', evmActivationResult.error);
          throw new Error(
            `Treasury created, but constitution update failed: ${evmActivationResult.error}. ` +
            `Treasury address: ${treasury}`,
          );
        }
        completeDeployStep('activate');
        if (evmActivationResult.agentError) {
          failDeployStep('agents', evmActivationResult.agentError);
          console.warn('[CreateDAO] EVM agent enable failed (non-fatal):', evmActivationResult.agentError);
        } else {
          completeDeployStep('agents');
        }

        clearPendingDaoCreation(family, founder);
        setPendingResume(null);
        setDeploying(false);
        navigate('/dao-created', { state: {
          daoAddress: treasury,
          name: config.name,
          slug: config.slug,
          description: config.description,
          logoUrl,
          governanceType: config.governanceType,
          guardianCount: guardianWallets.length,
          guardianThreshold: evmGuardianThreshold,
          votingToken: votingTokenMint ?? null,
          chainId,
          agentError: evmActivationResult.agentError,
        } });
      } else if (outcome.status === 'mock') {
        setDeploying(false);
        setDeploySteps([]);
        setTxError('EVM treasury creation is not configured for this deployment yet (no factory address). Connect a configured environment to deploy on Ethereum or Base.');
      } else {
        setDeploying(false);
        failDeployStep('create', outcome.error ?? undefined);
        setTxError(outcome.error || 'EVM deployment failed');
      }
    } catch (err) {
      setDeploying(false);
      const msg = err instanceof Error ? err.message : 'EVM deployment failed';
      setTxError(msg);
      setDeploySteps((prev) =>
        prev.map((s) =>
          s.status === 'running'
            ? { ...s, status: 'error' as DeployStepStatus, detail: msg }
            : s,
        ),
      );
      // The treasury already exists on-chain (checkpoint is only set after
      // creation succeeds) — persist a resumable checkpoint instead of
      // leaving the founder with just a raw address in an error message.
      if (checkpoint) {
        savePendingDaoCreation({
          ...checkpoint,
          failedStep: EVM_SUB_STEP_LABELS[currentSubStep] ?? currentSubStep,
          failedError: msg,
          failedAt: new Date().toISOString(),
        });
        setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));
      }
    }
  }

  async function handleDeploy() {
    if (!(USER_CHAINS as readonly string[]).includes(config.chain)) {
      setTxError('This network is not open for treasury creation.');
      return;
    }
    // FN-H1/H2: an earlier attempt for THIS wallet already created a treasury
    // on-chain and didn't finish setup (checkpoint persisted below, or by an
    // earlier failed run) — never silently start a fresh deploy in that case,
    // since `daoCount` has already incremented and a second `initialize_dao`
    // would create a genuine second, half-abandoned DAO. Surface the existing
    // "Resume setup" banner instead (or let the user explicitly dismiss it).
    if (pendingResume && !resuming) {
      setTxError(
        `You have an unfinished DAO setup ("${pendingResume.name || pendingResume.daoAddress}"). ` +
          'Use "Resume setup" above to finish it (or dismiss it first if you intend to create a new DAO).',
      );
      return;
    }
    if (config.chain === 'solana') {
      await handleDeploySolana();
      return;
    }
    await handleDeployEvm();
  }

  /** Solana create path. Open on testnet, where Solana is in USER_CHAINS. */
  async function handleDeploySolana() {
    if (!connected || !publicKey) {
      setWalletError(true);
      setVisible(true);
      return;
    }
    setWalletError(false);
    setTxError(null);
    setDeploying(true);
    initDeploySteps(true);
    beginDeployStep('foundation');

    const founder = publicKey;

    // Populated once the DAO exists on-chain (foundation + governance txs
    // land) — from that point any failure is a POST-creation failure that
    // should be resumable rather than requiring a full wizard restart.
    let checkpoint: Omit<PendingDaoCreation, 'failedStep' | 'failedError' | 'failedAt'> | null = null;
    let currentSubStep: 'foundation' | 'governance' | 'activate' | 'register-metadata' = 'foundation';

    try {
      const walletBalance = await connection.getBalance(founder);
      const seedNum = parseFloat(seedAmount);
      const seedLamportsPreflight = !isNaN(seedNum) && seedNum > 0
        ? Math.round(seedNum * LAMPORTS_PER_SOL)
        : 0;
      const minLamports = Math.round(
        (DAO_FORMATION_FEE_SOL + AGENT_WALLET_TOTAL_SEED_SOL + 0.02) * LAMPORTS_PER_SOL,
      ) + seedLamportsPreflight;
      if (walletBalance < minLamports) {
        throw new Error(
          `Insufficient SOL: need about ${(minLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL in your wallet ` +
          `(agent funding, rent, gas, and your treasury seed — formation has no protocol fee). ` +
          `You have ${(walletBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL.`,
        );
      }

      const { core } = getNavePrograms(connection);

      // 1. Derive the next DAO id from global config and the resulting DAO PDA.
      const [globalConfigPda] = getNaveGlobalConfigPDA();
      const globalConfig = await core.account.naveGlobalConfig.fetch(globalConfigPda);
      const daoId = (globalConfig.daoCount as { toNumber: () => number }).toNumber();
      // The program enforces this exact address; env config is advisory only.
      const protocolTreasury = globalConfig.treasury as PublicKey;
      const [daoRegistry] = getDaoRegistryPDA(founder, daoId);

      // 2. Generate (or confirm) the 4 AI agent keypairs via the backend.
      //    The founder signs a fresh single-use `nave-agent-keys|…` challenge
      //    (built inside generateAgentKeys) to prove ownership.
      if (!signMessage) {
        throw new Error('Connected wallet does not support message signing.');
      }

      const { data: keyData, error: keyError } = await generateAgentKeys(
        daoRegistry.toBase58(),
        founder.toBase58(),
        signMessage,
        daoId,
      );
      if (keyError || !keyData) {
        throw new Error(`Agent key generation failed: ${keyError ?? 'unknown error'}`);
      }
      const agentAuthorities = [
        new PublicKey(keyData.agents.executive.pubkey),
        new PublicKey(keyData.agents.financial.pubkey),
        new PublicKey(keyData.agents.oversight.pubkey),
        new PublicKey(keyData.agents.operational.pubkey),
      ];

      const isTokenGov = config.governanceType === 'token';
      const [vaultAuthority] = getVaultAuthorityPDA(daoRegistry);

      // 3. Resolve the treasury's vault mint.
      //    - Wallet-governance DAOs do NOT create or register any token. Their
      //      vault uses wrapped SOL (NATIVE_MINT) so the treasury can hold funds
      //      without minting a governance token.
      //    - Token-governance DAOs use an existing mint, or create a new one
      //      owned by the DAO (so it can mint/revoke via governance later).
      const decimals = 6;
      let vaultMint: PublicKey;
      let mintResult: TransactionBuildResult | null = null;
      let registerTokenResult: TransactionBuildResult | null = null;
      let createdTokenMint: string | null = null;

      if (!isTokenGov) {
        vaultMint = NATIVE_MINT;
      } else if (config.tokenMode === 'existing' && config.existingTokenCA.trim()) {
        vaultMint = new PublicKey(config.existingTokenCA.trim());
        createdTokenMint = vaultMint.toBase58();
      } else {
        const mintKeypair = Keypair.generate();
        vaultMint = mintKeypair.publicKey;
        createdTokenMint = vaultMint.toBase58();
        const rent = await getMinimumBalanceForRentExemptMint(connection);
        mintResult = {
          // Mint + freeze authority = DAO registry PDA, so the treasury controls
          // future minting and can revoke authorities via governance.
          instruction: createInitializeMint2Instruction(vaultMint, decimals, daoRegistry, daoRegistry),
          preInstructions: [
            SystemProgram.createAccount({
              fromPubkey: founder,
              newAccountPubkey: vaultMint,
              space: MINT_SIZE,
              lamports: rent,
              programId: TOKEN_PROGRAM_ID,
            }),
          ],
          signers: [mintKeypair],
          programId: TOKEN_PROGRAM_ID,
        };
      }

      // 4. Assemble DAO parameters. The connected wallet is always a guardian.
      const guardianWallets =
        config.governanceType === 'wallets' && config.authorizedWallets.length > 0
          ? config.authorizedWallets.map((w) => new PublicKey(w.trim()))
          : [founder];
      if (!guardianWallets.some((w) => w.equals(founder))) {
        guardianWallets.unshift(founder);
      }
      const guardianThreshold = defaultGuardianThreshold(guardianWallets.length);
      const feeRecipient = getAssociatedTokenAddressSync(vaultMint, founder, true);

      const params: InitializeDaoParams = {
        name: config.name,
        guardianWallets,
        guardianThreshold,
        agentAuthorities,
        managementFeeBps: MANAGEMENT_FEE_BPS_NORMAL,
        performanceFeeBps: PERFORMANCE_FEE_BPS,
        frozenManagementFeeBps: MANAGEMENT_FEE_BPS_FROZEN,
        frozenPerformanceFeeBps: FROZEN_PERFORMANCE_FEE_BPS,
        privacyMode: 0,
        feeRecipient,
        // Protocol revenue wallet (15% yield skim). Sourced from
        // VITE_NAVE_PROTOCOL_FEE_WALLET; required non-zero on-chain.
        protocolRevenueWallet: NAVE_PROTOCOL_FEE_WALLET,
        quorumBps: 3500,
        governanceType: isTokenGov ? 1 : 0,
      };

      // 5. Build instructions. The vault ATA is created as a preInstruction on
      //    the extensions transaction.
      const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);
      const extResult = await buildInitializeDaoExtensions(founder, daoId, vaultMint, params);
      extResult.preInstructions = [
        createAssociatedTokenAccountIdempotentInstruction(founder, vaultTokenAccount, vaultAuthority, vaultMint),
      ];

      if (isTokenGov) {
        const tokenInitialSupply =
          config.tokenMode === 'new'
            ? Math.floor(parseFloat(config.newTokenSupply || '0') * 10 ** decimals)
            : 0;
        registerTokenResult = await buildRegisterDaoToken(
          daoRegistry,
          founder,
          vaultMint,
          vaultTokenAccount,
          config.newTokenName || config.name,
          (config.newTokenName || config.name).slice(0, 8).toUpperCase(),
          decimals,
          false, // creation-time registration is covered by the formation fee
          tokenInitialSupply,
        );
      }

      // 6. Strategy positions/escrows are NO LONGER provisioned at creation.
      //    In the multi-asset model they are keyed by a registered, priceable
      //    treasury asset (USDC, wSOL, …) and provisioned per-asset via the
      //    asset-management flow: register_asset → init position/escrow →
      //    configure_position_targets. The DAO governance token is not a
      //    priceable treasury asset, so escrowing it here is invalid.

      // 7. Bundle into sequential signatures:
      //    Tx 1 — Foundation: [mint?] + initialize_dao + agent_wallet_seeding
      //    Tx 2 — Governance: vault ATA + initialize_dao_extensions
      //                       + initialize_dao_governance + [register_token?]
      //
      //    Merging extensions + governance into one tx reduces the required
      //    wallet signatures from 3 → 2 for the init phase (plus the later
      //    Seed & Ratify tx makes 3 total).
      const AGENT_SEED_LAMPORTS = Math.round(AGENT_WALLET_SEED_SOL * 1_000_000_000);
      const seedAgentPubkeys = [
        ...agentAuthorities,
        ...(keyData.agents.planner?.pubkey ? [new PublicKey(keyData.agents.planner.pubkey)] : []),
      ];
      const initDaoResult = await buildInitializeDao(founder, protocolTreasury, daoId, params);
      initDaoResult.preInstructions = [
        ...(initDaoResult.preInstructions ?? []),
        ...seedAgentPubkeys.map((agentKey) =>
          SystemProgram.transfer({
            fromPubkey: founder,
            toPubkey: agentKey,
            lamports: AGENT_SEED_LAMPORTS,
          }),
        ),
      ];

      const foundationGroup: TransactionBuildResult[] = [
        ...(mintResult ? [mintResult] : []),
        initDaoResult,
      ];
      const governanceGroup: TransactionBuildResult[] = [
        extResult,
        await buildInitializeDaoGovernance(founder, daoId, params),
        ...(registerTokenResult ? [registerTokenResult] : []),
      ];

      // FN-H1/H2: sent as TWO separate sendGrouped calls (rather than one call
      // with two groups) so we have a real await boundary between them — the
      // instant the foundation group confirms, the DaoRegistry/TreasuryVault
      // exist on-chain and we can persist a resumable checkpoint BEFORE
      // attempting the governance group. Previously the checkpoint was only
      // built after BOTH groups finished (success or a caught throw), so a
      // governance-group failure that resolved as a normal `error` outcome
      // (not a thrown exception) — or a crash between the two txs — left no
      // recovery record at all, and a later "Try again" would re-run
      // `initialize_dao` with a fresh `daoId`, creating a second DAO while the
      // first stayed half-initialized forever.
      const foundationOutcome = await tx.sendGrouped([foundationGroup], {
        successLabel: 'DAO foundation created',
        quietMock: true,
        quietToast: true,
      });

      if (foundationOutcome.status === 'mock') {
        setDaoAddress(daoRegistry.toBase58());
        setTimeout(() => {
          setDeploying(false);
          setDeploySteps([]);
          navigate('/dao-created', {
            state: {
              daoAddress: daoRegistry.toBase58(),
              name: config.name,
              slug: config.slug,
              description: config.description,
              logoUrl: '',
              governanceType: config.governanceType,
              guardianCount: guardianWallets.length,
              guardianThreshold,
              votingToken: createdTokenMint,
              daoId,
              riskPreset: RISK_PRESETS.find((r) => r.id === policy.riskPreset)?.label ?? policy.riskPreset,
              approvedProtocols: Object.entries(policy.approvedProtocols)
                .filter(([, v]) => v)
                .map(([id]) => id),
            },
          });
        }, 1500);
        return;
      }

      if (foundationOutcome.status !== 'success') {
        setDeploying(false);
        setDeploySteps((prev) =>
          prev.map((s) =>
            s.status === 'running'
              ? { ...s, status: 'error' as DeployStepStatus, detail: foundationOutcome.error ?? undefined }
              : s,
          ),
        );
        setTxError(foundationOutcome.error || 'Deployment failed');
        return;
      }

      // The DaoRegistry + TreasuryVault + VaultAuthority now exist on-chain.
      // Persist a resumable checkpoint IMMEDIATELY — before attempting the
      // governance group — so a crash, a rejected governance signature, or
      // any other failure from this point on can be resumed instead of
      // silently orphaning this DAO and creating a second one.
      currentSubStep = 'governance';
      completeDeployStep('foundation');
      beginDeployStep('governance');
      checkpoint = {
        chain: 'solana',
        daoAddress: daoRegistry.toBase58(),
        daoId,
        founder: founder.toBase58(),
        name: config.name,
        slug: config.slug,
        description: config.description,
        governanceType: config.governanceType,
        tokenMode: config.tokenMode,
        existingTokenCA: config.existingTokenCA,
        newTokenName: config.newTokenName,
        newTokenSupply: config.newTokenSupply,
        votingTokenMint: vaultMint.toBase58(),
        guardianWallets: guardianWallets.map((w) => w.toBase58()),
        seedAmount,
        policy,
        website: config.website,
        twitter: config.twitter,
        discord: config.discord,
        logoUrl: '',
      };
      savePendingDaoCreation({
        ...checkpoint,
        failedStep: SOLANA_SUB_STEP_LABELS.governance,
        failedError: 'Foundation transaction confirmed; DAO governance setup has not completed yet.',
        failedAt: new Date().toISOString(),
      });
      setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));

      const outcome = await tx.sendGrouped([governanceGroup], {
        successLabel: 'Treasury deployed',
        quietMock: true,
        quietToast: true,
      });

      if (outcome.status === 'error') {
        setDeploying(false);
        setDeploySteps((prev) =>
          prev.map((s) =>
            s.status === 'running'
              ? { ...s, status: 'error' as DeployStepStatus, detail: outcome.error ?? undefined }
              : s,
          ),
        );
        setTxError(outcome.error || 'Deployment failed');
        savePendingDaoCreation({
          ...checkpoint,
          failedStep: SOLANA_SUB_STEP_LABELS.governance,
          failedError: outcome.error || 'DAO governance setup failed',
          failedAt: new Date().toISOString(),
        });
        setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));
        return;
      }

      completeDeployStep('governance');

      // 7. Upload the cropped logo (best-effort) before persisting metadata.
      let logoUrl = '';
      if (config.logoBlob) {
        try {
          if (!signMessage) throw new Error('Connected wallet does not support message signing.');
          logoUrl = await uploadDaoLogo(
            config.logoBlob,
            config.name || daoRegistry.toBase58(),
            founder.toBase58(),
            daoRegistry.toBase58(),
            solanaAccessSigner(signMessage),
            { chain: 'solana' },
          );
        } catch {
          /* logo upload is non-blocking */
        }
      }

      const successState = {
        daoAddress: daoRegistry.toBase58(),
        name: config.name,
        slug: config.slug,
        description: config.description,
        logoUrl,
        governanceType: config.governanceType,
        guardianCount: guardianWallets.length,
        guardianThreshold,
        votingToken: createdTokenMint,
        daoId,
        riskPreset: RISK_PRESETS.find((r) => r.id === policy.riskPreset)?.label ?? policy.riskPreset,
        approvedProtocols: Object.entries(policy.approvedProtocols)
          .filter(([, v]) => v)
          .map(([id]) => id),
      };

      // From here on, any failure is a POST-creation failure — refresh the
      // checkpoint (now with the real uploaded logoUrl) so a retry (via the
      // "Resume setup" banner) can finish the remaining steps instead of
      // restarting the wizard (which would create a SECOND DAO).
      checkpoint = {
        chain: 'solana',
        daoAddress: daoRegistry.toBase58(),
        daoId,
        founder: founder.toBase58(),
        name: config.name,
        slug: config.slug,
        description: config.description,
        governanceType: config.governanceType,
        tokenMode: config.tokenMode,
        existingTokenCA: config.existingTokenCA,
        newTokenName: config.newTokenName,
        newTokenSupply: config.newTokenSupply,
        // The vault mint (wSOL for wallet gov, the created/existing mint for
        // token gov) — resume needs this to re-derive the activation context.
        votingTokenMint: vaultMint.toBase58(),
        guardianWallets: guardianWallets.map((w) => w.toBase58()),
        seedAmount,
        policy,
        website: config.website,
        twitter: config.twitter,
        discord: config.discord,
        logoUrl,
      };

      // ── Auto-activation: seed + ratify (one tx), then start agents off-chain.
      if (outcome.status === 'success') {
        currentSubStep = 'activate';
        beginDeployStep('activate');
        const wizardSeedNum = parseFloat(seedAmount);
        const seedLamports = !isNaN(wizardSeedNum) && wizardSeedNum > 0
          ? Math.round(wizardSeedNum * LAMPORTS_PER_SOL)
          : Math.round(TREASURY_SEED_SOL * LAMPORTS_PER_SOL);
        const activationResult = await runSolanaAutoActivation({
          connection,
          daoRegistry,
          founder,
          governanceType: isTokenGov ? 'token' : 'wallet',
          daoTokenMint: vaultMint,
          guardianWalletCount: guardianWallets.length,
          seedLamports,
          // agentThresholdUsdMicro is derived post-revalue inside createDaoActivation
          constitutionProtocols: Object.entries(policy.approvedProtocols)
            .filter(([, v]) => v)
            .map(([id]) => ({ id })),
          policyParams: {
            maxAllocationBps: Math.round(policy.maxLending * 100),
            minStablecoinReserveBps: Math.round(policy.minStablecoin * 100),
            maxTotalDeployedBps: Math.round(policy.maxDeployment * 100),
            minLiquidityBps: Math.round(policy.liquidityReserve * 100),
            rebalanceFrequencySecs: rebalanceFreqToSecs(policy.rebalanceFreq),
            confidenceThreshold: SYSTEM_CONFIDENCE_THRESHOLD,
          },
          send: tx.send,
          sendGrouped: tx.sendGrouped,
          setAgentsEnabled: async (enabled) => {
            if (!signMessage) return { error: 'Connected wallet does not support message signing.' };
            const { data, error } = await setAgentsEnabledViaProxy(
              daoRegistry.toBase58(),
              founder.toBase58(),
              signMessage,
              enabled,
            );
            return {
              error: error ?? (data && data.success === false ? data.error ?? 'Agent start failed' : null),
            };
          },
          onStep: (id, status, detail) => {
            const stepId: Record<ActivationStepId, string> = {
              seedAndRatify: 'activate',
              agents: 'agents',
            };
            const mapped = stepId[id];
            if (status === 'running') beginDeployStep(mapped);
            else if (status === 'done' || status === 'skipped') completeDeployStep(mapped, detail);
            else if (status === 'error') failDeployStep(mapped, detail);
          },
        });
        // seedAndRatify (required) failing leaves the treasury created but
        // not ratified/activated — surface it as a resumable failure instead
        // of silently continuing to metadata registration and navigation.
        if (!activationResult.ok) {
          throw new Error(
            `Treasury created, but constitution activation failed: ${activationResult.error ?? 'unknown error'}. ` +
            `Treasury address: ${daoRegistry.toBase58()}`,
          );
        }
      }

      setDeploying(false);
      setDeploySteps([]);

      if (outcome.status === 'success') {
        // Attach off-chain metadata (name, description, logo, socials) to the
        // registry before routing. If this fails, the DAO exists on-chain but
        // would be hard to find in the app, so surface the recovery address.
        currentSubStep = 'register-metadata';
        const { error: registerError } = await registerDao({
          dao_address: daoRegistry.toBase58(),
          creator_wallet: founder.toBase58(),
          name: config.name,
          slug: config.slug,
          description: config.description,
          logo_url: logoUrl,
          governance_type: isTokenGov ? 'token' : 'wallet',
          voting_token_mint: isTokenGov ? createdTokenMint ?? undefined : undefined,
          authorized_wallets: !isTokenGov ? guardianWallets.map((w) => w.toBase58()) : undefined,
          privacy_enabled: false,
          social_website: config.website,
          social_twitter: config.twitter,
          social_discord: config.discord,
          dao_id: daoId,
          chain: 'solana',
          network: SOLANA_NETWORK === 'mainnet' ? 'mainnet' : 'devnet',
        }, solanaAccessSigner(signMessage));
        if (registerError) {
          setTxError(
            `Treasury created on-chain, but metadata sync failed: ${registerError}. ` +
              `Treasury address: ${daoRegistry.toBase58()}`,
          );
          setDaoAddress(daoRegistry.toBase58());
          if (checkpoint) {
            savePendingDaoCreation({
              ...checkpoint,
              failedStep: SOLANA_SUB_STEP_LABELS[currentSubStep] ?? currentSubStep,
              failedError: registerError,
              failedAt: new Date().toISOString(),
            });
            setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));
          }
          return;
        }
        // register-dao auto-watches the creator wallet server-side (watch-dao
        // now needs its own signed challenge — no extra wallet prompt here).

        clearPendingDaoCreation('solana', founder.toBase58());
        setPendingResume(null);
        setDaoAddress(daoRegistry.toBase58());
        navigate('/dao-created', { state: successState });
      } else {
        setTxError(outcome.error || 'Deployment failed');
      }
    } catch (err) {
      setDeploying(false);
      const msg = err instanceof Error ? err.message : 'Deployment failed';
      setTxError(msg);
      setDeploySteps((prev) =>
        prev.map((s) =>
          s.status === 'running'
            ? { ...s, status: 'error' as DeployStepStatus, detail: msg }
            : s,
        ),
      );
      // The DAO already exists on-chain (checkpoint is set as soon as the
      // foundation tx lands, before the governance tx is even attempted) —
      // persist a resumable checkpoint.
      if (checkpoint) {
        savePendingDaoCreation({
          ...checkpoint,
          failedStep: SOLANA_SUB_STEP_LABELS[currentSubStep] ?? currentSubStep,
          failedError: msg,
          failedAt: new Date().toISOString(),
        });
        setPendingResume(findPendingDaoCreationForWallet(checkpoint.founder));
      }
    }
  }

  // ── Resume setup: re-run ONLY the remaining post-creation steps for an
  // already-on-chain DAO. Every step below is checked against on-chain/
  // off-chain state before acting (idempotent), so calling this after ANY
  // partial failure — including one already retried — can never double-submit
  // a step that landed. Reuses the exact same building blocks as the main
  // deploy flows (bindEvmAgentKeys, registerDao are
  // idempotent upserts server-side; runEvmActivation/runSolanaAutoActivation
  // check on-chain state per step — see createDaoActivationEvm.ts /
  // createDaoActivation.ts).
  async function resumeEvmDaoCreation(record: PendingDaoCreation) {
    if (!evmConnected || !evmAddress) {
      setWalletError(true);
      throw new Error('Connect the EVM wallet used to create this DAO to resume.');
    }
    if (evmAddress.toLowerCase() !== record.founder.toLowerCase()) {
      throw new Error(`Connect the wallet that started this setup (${record.founder}) to resume.`);
    }
    const chainId = record.chainId as EvmChainId;
    const family = record.chain as DaoEvmChainFamily;
    await ensureWalletOnChain(chainId);
    const treasury = record.daoAddress as Address;
    const founder = evmAddress as Address;
    const isTokenGov = record.governanceType === 'token';
    let votingTokenMint: Address | null = toAddress(record.votingTokenMint);

    // 1. Agent key binding — idempotent: `bind` only updates rows still keyed
    //    to the pending ref, so a second call after a successful bind is a safe no-op.
    if (record.daoRef) {
      const bindMsg = `nave-evm-keybind|${record.daoRef}|${treasury.toLowerCase()}|${chainId}|${Date.now()}`;
      const bindSig = await signEvmMessage({ message: bindMsg });
      const { error: bindError } = await bindEvmAgentKeys(record.daoRef, treasury, founder, chainId, family, bindMsg, bindSig);
      if (bindError) throw new Error(`Agent key binding failed: ${bindError}`);
    }

    // 2. Governance token — on-chain idempotency check (votingToken() != 0 ⇒ already registered).
    if (isTokenGov) {
      const existingTokenRaw = await readContract(wagmiConfig, {
        address: treasury, abi: NaveTreasuryAbi, functionName: 'votingToken', chainId,
      }).catch(() => null);
      const existingAddr = existingTokenRaw && String(existingTokenRaw).toLowerCase() !== ZERO_EVM_ADDRESS
        ? toAddress(existingTokenRaw as string)
        : null;
      if (existingAddr) {
        votingTokenMint = existingAddr;
      } else if (record.tokenMode === 'new') {
        const evmDecimals = 18;
        const initialSupply = parseUnits(record.newTokenSupply || '0', evmDecimals);
        if (initialSupply <= 0n) throw new Error('Enter a positive initial token supply.');
        const tokenOutcome = await tx.sendEvm(
          buildRegisterDaoTokenEvm(
            chainId, treasury,
            record.newTokenName.trim(),
            record.newTokenName.trim().toUpperCase().slice(0, 11),
            evmDecimals, initialSupply, treasury,
            parseEther(String(TOKEN_MINT_FEE_ETH)),
          ),
          { successLabel: 'Governance token deployed' },
        );
        if (tokenOutcome.status !== 'success' || !tokenOutcome.txHash) {
          throw new Error(tokenOutcome.error || 'Governance token registration failed.');
        }
        const tokenReceipt = await getTransactionReceipt(wagmiConfig, { hash: tokenOutcome.txHash as `0x${string}`, chainId });
        for (const log of tokenReceipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: NaveTreasuryAbi, data: log.data, topics: log.topics });
            if (decoded.eventName === 'DaoTokenRegistered') {
              votingTokenMint = (decoded.args as unknown as { mint: Address }).mint;
              break;
            }
          } catch { /* not a DaoTokenRegistered log */ }
        }
        if (!votingTokenMint) throw new Error('Governance token registered, but the address could not be decoded.');
      } else if (record.tokenMode === 'existing') {
        votingTokenMint = toAddress(record.existingTokenCA);
        if (!votingTokenMint) throw new Error('Missing a valid existing governance token address to resume with.');
        let tokenDecimals = 18;
        try {
          tokenDecimals = Number(await readContract(wagmiConfig, {
            address: votingTokenMint, abi: Erc20Abi, functionName: 'decimals', chainId,
          }));
        } catch { /* default 18 */ }
        const tokenName = record.name.trim() || 'Governance Token';
        const tokenSymbol = tokenName.toUpperCase().slice(0, 11) || 'GOV';
        const regOutcome = await tx.sendEvm(
          buildRegisterExternalDaoTokenEvm(chainId, treasury, votingTokenMint, tokenName, tokenSymbol, tokenDecimals),
          { successLabel: 'Governance token registered' },
        );
        if (regOutcome.status !== 'success' && regOutcome.status !== 'mock') {
          throw new Error(regOutcome.error || 'Governance token registration failed.');
        }
      }
    }

    rememberDaoChain(treasury, chainId);
    setDaoAddress(treasury);

    // 3. Off-chain metadata — idempotent upsert (register-dao; fresh single-use challenge).
    const { error: registerError } = await registerDao({
      dao_address: treasury,
      creator_wallet: founder,
      name: record.name,
      slug: record.slug,
      description: record.description,
      logo_url: record.logoUrl,
      governance_type: isTokenGov ? 'token' : 'wallet',
      voting_token_mint: isTokenGov ? votingTokenMint ?? undefined : undefined,
      authorized_wallets: record.guardianWallets,
      privacy_enabled: false,
      social_website: record.website,
      social_twitter: record.twitter,
      social_discord: record.discord,
      chain: family,
      chain_id: chainId,
    }, async (m) => {
      await ensureWalletOnChain(chainId);
      return signEvmMessage({ message: m });
    });
    if (registerError) throw new Error(`Metadata sync failed: ${registerError}`);
    // register-dao auto-watches the creator wallet server-side.

    // 4. Constitution activation — idempotent (createDaoActivationEvm.ts checks).
    const chainLabel = evmActivationChainFamily(chainId);
    const evmActivationResult = await runEvmActivation({
      daoAddress: treasury,
      chainId,
      chain: chainLabel,
      founderAddress: founder,
      policy: record.policy,
      seedAmount: record.seedAmount,
      sendEvm: (r, opts) => tx.sendEvm(r, opts),
      signMessage: async (msg) => {
        await ensureWalletOnChain(chainId);
        return signEvmMessage({ message: msg });
      },
      onStep: () => {},
    });
    if (!evmActivationResult.ok) {
      throw new Error(`Constitution activation failed: ${evmActivationResult.error ?? 'unknown error'}`);
    }

    clearPendingDaoCreation(family, founder);
    setPendingResume(null);
    navigate('/dao-created', { state: {
      daoAddress: treasury,
      name: record.name,
      slug: record.slug,
      description: record.description,
      logoUrl: record.logoUrl,
      governanceType: record.governanceType,
      guardianCount: record.guardianWallets.length,
      guardianThreshold: defaultGuardianThreshold(record.guardianWallets.length, 1),
      votingToken: votingTokenMint ?? null,
      chainId,
      agentError: evmActivationResult.agentError,
    } });
  }

  async function resumeSolanaDaoCreation(record: PendingDaoCreation) {
    if (!connected || !publicKey) {
      setWalletError(true);
      setVisible(true);
      throw new Error('Connect the Solana wallet used to create this DAO to resume.');
    }
    if (publicKey.toBase58() !== record.founder) {
      throw new Error(`Connect the wallet that started this setup (${record.founder}) to resume.`);
    }
    if (!signMessage) throw new Error('Connected wallet does not support message signing.');

    const founder = publicKey;
    const daoRegistry = new PublicKey(record.daoAddress);
    const isTokenGov = record.governanceType === 'token';
    const vaultMint = record.votingTokenMint ? new PublicKey(record.votingTokenMint) : NATIVE_MINT;
    const guardianWallets = record.guardianWallets.map((w) => new PublicKey(w));

    const { core } = getNavePrograms(connection);

    // 0. Extensions + governance (AgentSet/FeeConfig from initialize_dao_extensions;
    //    GuardianConfig/Constitution/TokenRegistry from initialize_dao_governance,
    //    plus register_dao_token — all three land in ONE atomic transaction, the
    //    same "governance group" handleDeploy sends right after the foundation
    //    group). FN-H1/H2: the checkpoint is now persisted the moment the
    //    foundation group confirms, which means a resume can land here with
    //    ONLY the DaoRegistry/TreasuryVault/VaultAuthority created and NOTHING
    //    else — a stale resume implementation that jumped straight to constitution
    //    activation below would fail immediately (those
    //    steps depend on accounts this group creates). Detect that case via the
    //    AgentSet PDA (idempotency-checked — its existence implies the whole
    //    governance group already landed, since it's one atomic transaction)
    //    and complete the governance group first if it's missing.
    const [agentSetPda] = getAgentSetPDA(daoRegistry);
    const extensionsAndGovernanceDone = (await core.account.agentSet.fetchNullable(agentSetPda)) !== null;
    if (!extensionsAndGovernanceDone) {
      // Idempotent: generate-agent-keys returns the SAME pubkeys already
      // generated (and already seeded via agent_wallet_seeding in the
      // foundation tx) for this dao_address rather than minting new ones.
      // A fresh single-use challenge is signed inside generateAgentKeys.
      const { data: keyData, error: keyError } = await generateAgentKeys(
        daoRegistry.toBase58(),
        founder.toBase58(),
        signMessage,
        record.daoId,
      );
      if (keyError || !keyData) {
        throw new Error(`Could not recover agent keys to resume governance setup: ${keyError ?? 'unknown error'}`);
      }
      const agentAuthorities = [
        new PublicKey(keyData.agents.executive.pubkey),
        new PublicKey(keyData.agents.financial.pubkey),
        new PublicKey(keyData.agents.oversight.pubkey),
        new PublicKey(keyData.agents.operational.pubkey),
      ];
      const decimals = 6;
      const [vaultAuthority] = getVaultAuthorityPDA(daoRegistry);
      const feeRecipient = getAssociatedTokenAddressSync(vaultMint, founder, true);
      const guardianThreshold = defaultGuardianThreshold(guardianWallets.length);
      const resumeParams: InitializeDaoParams = {
        name: record.name,
        guardianWallets,
        guardianThreshold,
        agentAuthorities,
        managementFeeBps: MANAGEMENT_FEE_BPS_NORMAL,
        performanceFeeBps: PERFORMANCE_FEE_BPS,
        frozenManagementFeeBps: MANAGEMENT_FEE_BPS_FROZEN,
        frozenPerformanceFeeBps: FROZEN_PERFORMANCE_FEE_BPS,
        privacyMode: 0,
        feeRecipient,
        protocolRevenueWallet: NAVE_PROTOCOL_FEE_WALLET,
        quorumBps: 3500,
        governanceType: isTokenGov ? 1 : 0,
      };
      const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);
      const extResult = await buildInitializeDaoExtensions(founder, record.daoId!, vaultMint, resumeParams);
      extResult.preInstructions = [
        createAssociatedTokenAccountIdempotentInstruction(founder, vaultTokenAccount, vaultAuthority, vaultMint),
      ];
      let registerTokenResult: TransactionBuildResult | null = null;
      if (isTokenGov) {
        const tokenInitialSupply = record.tokenMode === 'new'
          ? Math.floor(parseFloat(record.newTokenSupply || '0') * 10 ** decimals)
          : 0;
        registerTokenResult = await buildRegisterDaoToken(
          daoRegistry,
          founder,
          vaultMint,
          vaultTokenAccount,
          record.newTokenName || record.name,
          (record.newTokenName || record.name).slice(0, 8).toUpperCase(),
          decimals,
          false,
          tokenInitialSupply,
        );
      }
      const governanceGroup: TransactionBuildResult[] = [
        extResult,
        await buildInitializeDaoGovernance(founder, record.daoId!, resumeParams),
        ...(registerTokenResult ? [registerTokenResult] : []),
      ];
      const governanceOutcome = await tx.sendGrouped([governanceGroup], {
        successLabel: 'DAO governance completed',
        quietMock: true,
        quietToast: true,
      });
      if (governanceOutcome.status !== 'success' && governanceOutcome.status !== 'mock') {
        throw new Error(governanceOutcome.error || 'Failed to complete DAO governance setup.');
      }
    }

    // Constitution activation — idempotent (createDaoActivation.ts checks).
    // New treasuries do not lock NAVE. An existing lock, if any, is released on moonlight.
    const wizardSeedNum = parseFloat(record.seedAmount);
    const seedLamports = !isNaN(wizardSeedNum) && wizardSeedNum > 0
      ? Math.round(wizardSeedNum * LAMPORTS_PER_SOL)
      : Math.round(TREASURY_SEED_SOL * LAMPORTS_PER_SOL);
    const activationResult = await runSolanaAutoActivation({
      connection,
      daoRegistry,
      founder,
      governanceType: isTokenGov ? 'token' : 'wallet',
      daoTokenMint: vaultMint,
      guardianWalletCount: guardianWallets.length,
      seedLamports,
      constitutionProtocols: Object.entries(record.policy.approvedProtocols)
        .filter(([, v]) => v)
        .map(([id]) => ({ id })),
      policyParams: {
        maxAllocationBps: Math.round(record.policy.maxLending * 100),
        minStablecoinReserveBps: Math.round(record.policy.minStablecoin * 100),
        maxTotalDeployedBps: Math.round(record.policy.maxDeployment * 100),
        minLiquidityBps: Math.round(record.policy.liquidityReserve * 100),
        rebalanceFrequencySecs: rebalanceFreqToSecs(record.policy.rebalanceFreq),
        confidenceThreshold: SYSTEM_CONFIDENCE_THRESHOLD,
      },
      send: tx.send,
      sendGrouped: tx.sendGrouped,
      setAgentsEnabled: async (enabled) => {
        const { data, error } = await setAgentsEnabledViaProxy(daoRegistry.toBase58(), founder.toBase58(), signMessage, enabled);
        return { error: error ?? (data && data.success === false ? data.error ?? 'Agent start failed' : null) };
      },
      onStep: () => {},
    });
    if (!activationResult.ok) {
      throw new Error(`Constitution activation failed: ${activationResult.error ?? 'unknown error'}`);
    }

    // 3. Off-chain metadata — idempotent upsert (register-dao); a fresh
    //    single-use challenge is signed inside registerDao.
    const { error: registerError } = await registerDao({
      dao_address: daoRegistry.toBase58(),
      creator_wallet: founder.toBase58(),
      name: record.name,
      slug: record.slug,
      description: record.description,
      logo_url: record.logoUrl,
      governance_type: isTokenGov ? 'token' : 'wallet',
      voting_token_mint: isTokenGov ? record.votingTokenMint ?? undefined : undefined,
      authorized_wallets: !isTokenGov ? guardianWallets.map((w) => w.toBase58()) : undefined,
      privacy_enabled: false,
      social_website: record.website,
      social_twitter: record.twitter,
      social_discord: record.discord,
      dao_id: record.daoId,
      chain: 'solana',
      network: SOLANA_NETWORK === 'mainnet' ? 'mainnet' : 'devnet',
    }, solanaAccessSigner(signMessage));
    if (registerError) {
      setDaoAddress(daoRegistry.toBase58());
      throw new Error(`Metadata sync failed: ${registerError}`);
    }
    // register-dao auto-watches the creator wallet server-side.

    clearPendingDaoCreation('solana', founder.toBase58());
    setPendingResume(null);
    setDaoAddress(daoRegistry.toBase58());
    navigate('/dao-created', { state: {
      daoAddress: daoRegistry.toBase58(),
      name: record.name,
      slug: record.slug,
      description: record.description,
      logoUrl: record.logoUrl,
      governanceType: record.governanceType,
      guardianCount: guardianWallets.length,
      guardianThreshold: defaultGuardianThreshold(guardianWallets.length),
      votingToken: isTokenGov ? record.votingTokenMint : null,
      daoId: record.daoId,
      riskPreset: RISK_PRESETS.find((r) => r.id === record.policy.riskPreset)?.label ?? record.policy.riskPreset,
      approvedProtocols: Object.entries(record.policy.approvedProtocols).filter(([, v]) => v).map(([id]) => id),
    } });
  }

  async function handleResumeSetup() {
    if (!pendingResume || resuming) return;
    const record = pendingResume;
    setResuming(true);
    setTxError(null);
    try {
      if (record.chain === 'solana') {
        await resumeSolanaDaoCreation(record);
      } else {
        await resumeEvmDaoCreation(record);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resume failed';
      setTxError(msg);
      savePendingDaoCreation({ ...record, failedError: msg, failedAt: new Date().toISOString() });
      setPendingResume(findPendingDaoCreationForWallet(record.founder));
    } finally {
      setResuming(false);
    }
  }

  function dismissPendingResume() {
    if (!pendingResume) return;
    clearPendingDaoCreation(pendingResume.chain, pendingResume.founder);
    setPendingResume(null);
  }

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      {/* Top bar */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-6 py-3.5 border-b"
        style={{
          backgroundColor: 'rgba(250, 248, 243, 0.9)',
          borderColor: 'hsl(var(--surface-2))',
          backdropFilter: 'blur(12px)',
        }}
      >
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 no-underline"
          style={{ color: 'hsl(var(--foreground))' }}
        >
          <span
            className="grid place-items-center rounded-[6px]"
            style={{
              width: '20px',
              height: '20px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
              fontFamily: 'var(--font-display)',
              fontSize: '13px',
            }}
          >
            N
          </span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '19px' }}>Nave</span>
        </button>
        <div className="flex items-center gap-3">
          {(config.chain === 'solana' ? !connected : !evmConnected) && (
            <button
              type="button"
              onClick={openCreateWallet}
              className="px-3.5 py-1.5 rounded-[9px] font-semibold"
              style={{ fontSize: '13px', backgroundColor: 'hsl(var(--foreground))', color: '#ffffff' }}
            >
              Connect
            </button>
          )}
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 hover:underline underline-offset-4"
            style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
          >
            <Fi icon="xmark" style={{ fontSize: '13px' }} />
            Exit
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-[620px] mx-auto px-4 sm:px-6 pt-10 pb-20">
        {/* Page Heading */}
        <div className="mb-6">
          <div className="nave-label" style={{ marginBottom: '10px' }}>New treasury</div>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 400,
              fontSize: '34px',
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              margin: '0 0 8px',
              color: 'hsl(var(--foreground))',
            }}
          >
            Create a treasury
          </h1>
          <p style={{ fontSize: '14.5px', color: 'hsl(var(--muted-foreground))', margin: 0, maxWidth: '520px' }}>
            About two minutes. No token required, no protocol fee — just network gas. Every choice can be changed later, by vote.
          </p>
        </div>

        {/* Mode toggle pills + Step Indicator */}
        <div className="flex items-center justify-between gap-4 flex-wrap my-7">
          <StepIndicator
            steps={wizardSteps}
            current={setupMode ? displayStepIndex(step, setupMode) : 0}
          />
          {step === 0 && (
            <div className="flex items-center gap-1.5">
              {(['quick', 'advanced'] as const).map((m) => {
                const active = setupMode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => selectSetupMode(m)}
                    className="px-3 py-1 rounded-full border transition-all"
                    style={{
                      fontSize: '12px',
                      fontWeight: active ? 600 : 400,
                      backgroundColor: active ? 'hsl(var(--foreground))' : '#ffffff',
                      borderColor: active ? 'hsl(var(--foreground))' : 'hsl(var(--border))',
                      color: active ? '#ffffff' : 'hsl(var(--muted-foreground))',
                    }}
                  >
                    {m === 'quick' ? 'Quick setup' : 'Advanced'}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {pendingResume && !deploying && (
          <div
            className="flex flex-col gap-2.5 px-4 py-3.5 rounded-[12px] border mb-6 animate-fade-in"
            style={{ backgroundColor: 'hsl(var(--warning-muted))', borderColor: 'hsl(var(--border))' }}
          >
            <div className="flex items-start gap-2.5">
              <Fi icon="arrows-rotate" style={{ fontSize: '13px', color: 'hsl(var(--warning))', flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>
                <strong>Resume setup</strong> — "{pendingResume.name || pendingResume.daoAddress}" was created
                on-chain ({chainDisplayLabel(pendingResume.chain)}), but setup didn't finish:{' '}
                {pendingResume.failedStep} failed ({pendingResume.failedError}). Your treasury is safe — finish
                setup instead of creating a new one.
              </div>
            </div>
            <div className="flex items-center gap-3" style={{ marginLeft: '22px' }}>
              <button
                onClick={handleResumeSetup}
                disabled={resuming}
                className="px-3.5 py-1.5 rounded-[9px] font-semibold"
                style={{
                  fontSize: '12.5px',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: '#ffffff',
                  opacity: resuming ? 0.6 : 1,
                }}
              >
                {resuming ? 'Resuming…' : 'Resume setup'}
              </button>
              <button
                onClick={dismissPendingResume}
                disabled={resuming}
                style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {walletError && (
          <div
            className="flex items-center gap-2.5 py-3 mb-6 animate-fade-in"
            style={{ borderTop: '1px solid hsl(var(--surface-2))', borderBottom: '1px solid hsl(var(--surface-2))' }}
          >
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: 'hsl(var(--brass))' }} />
            <span style={{ fontSize: '13.5px', color: 'hsl(var(--foreground))' }}>
              Please connect your wallet to deploy a treasury.
            </span>
            <button
              onClick={() => setWalletError(false)}
              style={{ marginLeft: 'auto', color: 'hsl(var(--muted-foreground))' }}
            >
              <Fi icon="xmark" style={{ fontSize: '13px' }} />
            </button>
          </div>
        )}
        {txError && !deploySteps.length && (
          <div
            className="flex items-center gap-2.5 px-4 py-3 rounded-[12px] border mb-6 animate-fade-in"
            style={{ backgroundColor: '#FFF9F8', borderColor: '#F2C7C2' }}
          >
            <Fi icon="circle-xmark" style={{ fontSize: '13px', color: '#B42318', flexShrink: 0 }} />
            <span style={{ fontSize: '13px', color: '#B42318' }}>
              {txError}
            </span>
            <button
              onClick={() => setTxError(null)}
              style={{ marginLeft: 'auto', color: '#B42318' }}
            >
              <Fi icon="xmark" style={{ fontSize: '13px' }} />
            </button>
          </div>
        )}
        {step === 0 && (
          <Step1
            config={config}
            setConfig={setConfig}
            connectedWallet={connectedWallet}
            onSlugReadyChange={onSlugReadyChange}
            quickMode={setupMode === 'quick'}
          />
        )}
        {setupMode === 'advanced' && step === 1 && (
          <ConstitutionStep
            policy={policy}
            setPolicy={setPolicy}
            chain={config.chain === 'solana' ? 'solana' : 'evm'}
            evmChainId={
              config.chain !== 'solana'
                ? activeEvmChainId(config.chain as Exclude<ChainFamily, 'solana'>)
                : undefined
            }
            offeredPresets={['conservative', 'balanced', 'yield6']}
          />
        )}
        {step === 2 && (
          <SeedReviewStep
            config={config}
            policy={policy}
            seedAmount={seedAmount}
            setSeedAmount={setSeedAmount}
            onDeploy={handleDeploy}
            deploying={deploying}
            evmFormationFeeWei={evmFormationFeeWei}
            evmFormationFeeLoading={evmFormationFeeLoading}
          />
        )}

        {/* Nav buttons */}
        {step === 0 && (
          <>
            <div className="flex items-center justify-between mt-8 pt-6" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
              <button
                type="button"
                onClick={() => selectSetupMode(setupMode === 'quick' ? 'advanced' : 'quick')}
                className="px-3.5 py-2 rounded-[9px]"
                style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
              >
                {setupMode === 'quick' ? 'Advanced setup' : 'Quick setup'}
              </button>
              <button
                type="button"
                onClick={() => setStep(setupMode === 'quick' ? 2 : 1)}
                disabled={!canAdvance()}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-[9px] font-semibold transition-all"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--foreground))',
                  color: '#ffffff',
                  opacity: canAdvance() ? 1 : 0.4,
                  cursor: canAdvance() ? 'pointer' : 'not-allowed',
                }}
              >
                {setupMode === 'quick' ? 'Review' : 'Constitution'}
                <Fi icon="arrow-right" style={{ fontSize: '11px' }} />
              </button>
            </div>
            {slugMessage && config.slug.trim() && (
              <p style={{ fontSize: '12px', color: 'hsl(var(--destructive))', marginTop: '8px', textAlign: 'right' }}>
                {slugMessage}
              </p>
            )}
          </>
        )}

        {setupMode === 'advanced' && step === 1 && (
          <div className="flex items-center justify-between mt-8 pt-6" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <button
              type="button"
              onClick={() => setStep(0)}
              className="px-3.5 py-2 rounded-[9px]"
              style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
            >
              ← Back to Identity
            </button>
            <button
              type="button"
              onClick={() => setStep(2)}
              disabled={!canAdvance()}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-[9px] font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--foreground))',
                color: '#ffffff',
                opacity: canAdvance() ? 1 : 0.4,
                cursor: canAdvance() ? 'pointer' : 'not-allowed',
              }}
            >
              Seed & Review →
            </button>
          </div>
        )}

        {step === 2 && !deploying && (
          <div className="flex items-center mt-6 pt-4" style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <button
              type="button"
              onClick={() => setStep(setupMode === 'quick' ? 0 : 1)}
              className="px-3.5 py-2 rounded-[9px]"
              style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
            >
              ← {setupMode === 'quick' ? 'Back to Setup' : 'Back to Constitution'}
            </button>
          </div>
        )}
      </div>

      <TreasuryDeployModal
        open={deploySteps.length > 0}
        chainLabel={chainDisplayLabel(config.chain)}
        steps={deploySteps}
        activeHint={deployActiveHint}
        error={txError}
        deploying={deploying}
        onClose={() => {
          if (deploying && !txError) return;
          setDeploySteps([]);
          setTxError(null);
        }}
        onRetry={() => {
          setTxError(null);
          void handleDeploy();
        }}
      />
    </div>
  );
}