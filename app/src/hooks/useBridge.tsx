// ─── useBridge — cross-chain NAVE bridge controller (trusted-relayer MVP) ─────
// Drives the Bridge page: holds the selected direction + EVM endpoint + amount,
// computes the on-top fee quote (NAVE_BRIDGE_FEE_BPS, 2.5% by default), reads
// source-chain balances, and runs the two-step bridge flow (lock/burn on the
// source chain, then notify the relayer to mint/release on the destination
// chain). Reuses the app's unified transaction dispatcher (useSendTransaction)
// for both the Solana lock and the EVM burn.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PublicKey } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useAccount, usePublicClient } from 'wagmi';
import { parseUnits } from 'viem';
import { toast } from './use-toast';
import { useChain } from './useChain';
import { useSendTransaction } from './useSendTransaction';
import {
  EVM_RPC_URLS,
  EVM_WRAPPED_NAVE_ADDRESSES,
  NAVE_BRIDGE_ENABLED,
  NAVE_BRIDGE_EVM_CONFIRMATIONS,
  NAVE_BRIDGE_FEE_BPS,
  NAVE_BRIDGE_PER_TX_CAP_RAW,
  NAVE_BRIDGE_PROGRAM_ID,
  NAVE_BRIDGE_PROTOCOL_FEE_ACCOUNT,
  NAVE_BRIDGE_STAKING_POOL_ACCOUNT,
  NAVE_DECIMALS,
  SOLANA_NAVE_MINT,
} from '../lib/programConfig';
import { WAGMI_CHAIN_BY_ID } from '../lib/evm/wagmi';
import { createPublicClient, http, type Hash, type PublicClient } from 'viem';
import { toAddress } from '../lib/evm/addresses';
import type { EvmChainId } from '../lib/chain/types';
import { evmTarget, isEvmAddress } from '../lib/chain/types';
import { getNaveBalanceRaw } from '../lib/bridge/solanaLock';
import {
  buildBridgeLockInstruction,
  solanaAddressToBytes32,
} from '../lib/bridge/solanaBridgeProgram';
import { getSupportedBridgeRoutes, quoteBridge } from '../lib/bridge/routes';
import { fetchBridgeTransferStatus, submitBridgeRelay } from '../lib/bridge/relayer';
import {
  getEvmBurnConfirmationProgress,
  getSolanaLockConfirmationProgress,
  isConfirmationWaitError,
  parseConfirmationProgress,
  type ConfirmationProgress,
} from '../lib/bridge/confirmations';
import { wrappedNaveAbi } from '../lib/bridge/wrappedNaveAbi';
import type {
  BridgeDirection,
  BridgeQuote,
  BridgeRelayResponse,
  BridgeRoute,
} from '../lib/bridge/types';

/** A completed bridge attempt, surfaced in the page's "Recent transfers" area. */
export interface BridgeAttempt {
  direction: BridgeDirection;
  evmChainId: EvmChainId;
  sourceTx: string;
  amountRaw: string;
  recipient: string;
  response: BridgeRelayResponse;
}

export interface UseBridgeResult {
  /** Supported routes for the active EVM network (filtered to configured wrapped tokens). */
  supportedRoutes: BridgeRoute[];
  /** Active direction. */
  direction: BridgeDirection;
  setDirection: (direction: BridgeDirection) => void;
  /** Active EVM endpoint chain id (Sepolia / Base Sepolia on testnet). */
  evmChainId: EvmChainId | null;
  setEvmChainId: (chainId: EvmChainId) => void;
  /** The fully-resolved route for the current direction + EVM endpoint. */
  route: BridgeRoute | null;
  /** Amount input (human NAVE string). */
  amount: string;
  setAmount: (amount: string) => void;
  /**
   * Explicit destination address the user has typed/confirmed. NEVER inferred
   * silently from whatever wallet wagmi/wallet-adapter auto-reconnected to —
   * the caller (Bridge page) must show this for confirmation before bridging.
   * EVM address (0x…) for Solana→EVM; Solana address (base58) for EVM→Solana.
   */
  destination: string;
  setDestination: (destination: string) => void;
  /** True when `destination` is a syntactically valid address for the active direction. */
  isDestinationValid: boolean;
  /** Quote derived from `amount` (on-top fee split per NAVE_BRIDGE_FEE_BPS). */
  quote: BridgeQuote;
  /** Owner's Solana NAVE balance (base units), or null while loading/unavailable. */
  solanaNaveBalance: bigint | null;
  /** Owner's WrappedNave balance on the active EVM chain (base units), or null. */
  evmWrappedBalance: bigint | null;
  /** True while a bridge flow is in-flight. */
  isBridging: boolean;
  /** Last completed relay attempt (for the recent-transfers display). */
  lastAttempt: BridgeAttempt | null;
  /** Whether the bridge feature is configured for this deployment. */
  enabled: boolean;
  /** Execute the bridge for the current selection. */
  bridge: () => Promise<void>;
  /** Re-submit relay for a failed attempt (source lock/burn already on-chain). */
  retryRelay: () => Promise<void>;
}

/** Parse a human NAVE amount string into base units; returns 0n when invalid. */
function parseAmountRaw(amount: string): bigint {
  const trimmed = amount.trim();
  if (!trimmed) return 0n;
  try {
    return parseUnits(trimmed, NAVE_DECIMALS);
  } catch {
    return 0n;
  }
}

/** True once a transfer has reached a terminal state (no more polling needed). */
function isTerminalStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

const LAST_ATTEMPT_STORAGE_KEY = 'nave_bridge_last_attempt';
const CONFIRM_POLL_MS = 3_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 60; // ~5 minutes at 5s intervals
/** Consecutive polls with no bridge_transfers row → relay never reached the server. */
const RELAY_MISSING_NULL_POLLS = 3;

const RELAY_NEVER_SUBMITTED_ERROR =
  'Your transfer is confirmed on the source chain, but the relayer was not notified. Retry to complete the bridge — your funds are safe.';

/** Human fee percentage derived from config so toast copy can never drift. */
const FEE_PCT_LABEL = `${NAVE_BRIDGE_FEE_BPS / 100}%`;

function evmClientForChain(chainId: EvmChainId): PublicClient {
  const chain = WAGMI_CHAIN_BY_ID[chainId];
  const rpc = EVM_RPC_URLS[chainId];
  return createPublicClient({ chain, transport: rpc ? http(rpc) : http() });
}

function confirmingResponse(
  direction: BridgeDirection,
  progress?: Partial<ConfirmationProgress>,
): BridgeRelayResponse {
  const required =
    progress?.required ??
    (direction === 'evm_to_solana' ? NAVE_BRIDGE_EVM_CONFIRMATIONS : 1);
  return {
    status: 'confirming',
    confirmationsCurrent: progress?.current ?? 0,
    confirmationsRequired: required,
  };
}

function normalizeStoredAttempt(attempt: BridgeAttempt): BridgeAttempt {
  if (attempt.response.status === 'failed' && isConfirmationWaitError(attempt.response.error)) {
    const parsed = parseConfirmationProgress(attempt.response.error);
    return {
      ...attempt,
      response: confirmingResponse(attempt.direction, parsed ?? undefined),
    };
  }
  return attempt;
}

/** Persist the in-flight/last attempt so a refresh resumes monitoring it. */
function saveLastAttempt(attempt: BridgeAttempt | null): void {
  try {
    if (attempt) {
      localStorage.setItem(LAST_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
    } else {
      localStorage.removeItem(LAST_ATTEMPT_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable (private browsing, etc.) — non-fatal, just skip persistence.
  }
}

function loadLastAttempt(): BridgeAttempt | null {
  try {
    const raw = localStorage.getItem(LAST_ATTEMPT_STORAGE_KEY);
    if (!raw) return null;
    return normalizeStoredAttempt(JSON.parse(raw) as BridgeAttempt);
  } catch {
    return null;
  }
}

function useBridgeController(): UseBridgeResult {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();
  const { target, setChainFamily } = useChain();
  const tx = useSendTransaction();

  const supportedRoutes = useMemo(() => getSupportedBridgeRoutes(), []);
  const firstEvmChainId = supportedRoutes[0]?.evmChainId ?? null;

  const seededEvmChainId = useMemo((): EvmChainId | null => {
    if (target.kind === 'evm' && target.evmChainId != null) {
      if (supportedRoutes.some((r) => r.evmChainId === target.evmChainId)) {
        return target.evmChainId;
      }
    }
    return firstEvmChainId;
  }, [target, supportedRoutes, firstEvmChainId]);

  const [direction, setDirection] = useState<BridgeDirection>('solana_to_evm');
  const [evmChainId, setEvmChainId] = useState<EvmChainId | null>(seededEvmChainId);
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [solanaNaveBalance, setSolanaNaveBalance] = useState<bigint | null>(null);
  const [evmWrappedBalance, setEvmWrappedBalance] = useState<bigint | null>(null);
  const [isBridging, setIsBridging] = useState(false);
  const [lastAttempt, setLastAttempt] = useState<BridgeAttempt | null>(() => loadLastAttempt());
  const pollAttemptsRef = useRef(0);
  const pollNullStreakRef = useRef(0);
  const polledSourceTxRef = useRef<string | null>(null);
  const confirmingRelayRef = useRef(false);
  const prevSolanaConnectedRef = useRef<string | null>(null);
  const prevEvmConnectedRef = useRef<string | null>(null);

  // Auto-recognize the bridge direction from whichever wallet is (or becomes)
  // connected: a connected Solana wallet implies Solana→EVM, a connected EVM
  // wallet implies EVM→Solana. Fires on the connection TRANSITION (null →
  // address) rather than continuously, so it covers both "already connected"
  // (wallet-adapter's autoConnect resolving on mount) and an explicit connect
  // action during the session, while still letting the user override the
  // direction afterward via the tabs without it snapping back.
  useEffect(() => {
    const cur = publicKey?.toBase58() ?? null;
    if (cur && cur !== prevSolanaConnectedRef.current) {
      setDirection('solana_to_evm');
    }
    prevSolanaConnectedRef.current = cur;
  }, [publicKey]);

  useEffect(() => {
    const cur = evmAddress ?? null;
    if (cur && cur !== prevEvmConnectedRef.current) {
      setDirection('evm_to_solana');
    }
    prevEvmConnectedRef.current = cur;
  }, [evmAddress]);

  // Keep a valid EVM endpoint selected once routes resolve.
  useEffect(() => {
    if (evmChainId === null && firstEvmChainId !== null) {
      setEvmChainId(firstEvmChainId);
    }
  }, [evmChainId, firstEvmChainId]);

  // When the Bridge page network selector switches EVM family, seed the route
  // AND keep the global chain context in sync so StakeBox follows the same chain.
  useEffect(() => {
    if (target.kind === 'evm' && target.evmChainId != null) {
      if (supportedRoutes.some((r) => r.evmChainId === target.evmChainId)) {
        setEvmChainId(target.evmChainId);
      }
    }
  }, [target, supportedRoutes]);

  // Bridge form's own EVM network dropdown → global chain context (StakeBox).
  const handleEvmChainId = useCallback(
    (chainId: EvmChainId) => {
      setEvmChainId(chainId);
      setChainFamily(evmTarget(chainId).family);
    },
    [setChainFamily],
  );

  const route = useMemo<BridgeRoute | null>(() => {
    if (evmChainId === null) return null;
    return (
      supportedRoutes.find(
        (r) => r.direction === direction && r.evmChainId === evmChainId,
      ) ?? null
    );
  }, [supportedRoutes, direction, evmChainId]);

  const amountRaw = useMemo(() => parseAmountRaw(amount), [amount]);
  const quote = useMemo(() => quoteBridge(amountRaw), [amountRaw]);

  // Clear the destination on direction change — an address valid for one
  // chain family is meaningless (and potentially dangerous) for the other.
  useEffect(() => {
    setDestination('');
  }, [direction]);

  // Convenience prefill ONLY — never auto-submits. The connected wallet's
  // address is offered as a starting point, but it stays a plain, editable
  // text field and the Bridge page shows it back for explicit confirmation
  // before anything is signed. This is what prevents a silently auto-
  // reconnected wallet (e.g. Phantom's injected EVM provider) from becoming
  // the recipient without the user ever seeing/confirming it.
  useEffect(() => {
    if (destination.trim()) return;
    if (direction === 'solana_to_evm' && evmAddress) {
      setDestination(evmAddress);
    } else if (direction === 'evm_to_solana' && publicKey) {
      setDestination(publicKey.toBase58());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction, evmAddress, publicKey]);

  const isDestinationValid = useMemo(() => {
    const trimmed = destination.trim();
    if (!trimmed) return false;
    if (direction === 'solana_to_evm') return isEvmAddress(trimmed);
    try {
      // eslint-disable-next-line no-new
      new PublicKey(trimmed);
      return true;
    } catch {
      return false;
    }
  }, [destination, direction]);

  const wrappedAddress = useMemo(
    () => (evmChainId !== null ? toAddress(EVM_WRAPPED_NAVE_ADDRESSES[evmChainId]) : null),
    [evmChainId],
  );

  // ── Solana NAVE balance ───────────────────────────────────────────────────
  const refreshSolanaBalance = useCallback(async () => {
    if (!publicKey) {
      setSolanaNaveBalance(null);
      return;
    }
    try {
      setSolanaNaveBalance(await getNaveBalanceRaw(connection, publicKey));
    } catch {
      setSolanaNaveBalance(null);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refreshSolanaBalance();
  }, [refreshSolanaBalance]);

  // ── EVM WrappedNave balance ───────────────────────────────────────────────
  const publicClient = usePublicClient({ chainId: evmChainId ?? undefined });

  const refreshEvmBalance = useCallback(async () => {
    if (!publicClient || !evmAddress || !wrappedAddress) {
      setEvmWrappedBalance(null);
      return;
    }
    try {
      const bal = await publicClient.readContract({
        address: wrappedAddress,
        abi: wrappedNaveAbi,
        functionName: 'balanceOf',
        args: [evmAddress],
      });
      setEvmWrappedBalance(bal as bigint);
    } catch {
      setEvmWrappedBalance(null);
    }
  }, [publicClient, evmAddress, wrappedAddress]);

  useEffect(() => {
    void refreshEvmBalance();
  }, [refreshEvmBalance]);

  // ── Persist + poll the in-flight/last attempt ────────────────────────────
  // Persisting means a refresh or reconnect resumes monitoring the same
  // transfer instead of losing it; polling every 5s catches the relayer's
  // eventual completion even if the original /bridge-relay request never
  // resolved client-side (network blip, tab closed mid-flight, etc.) — the
  // relayer's own verify + mint/release work continues server-side regardless.
  useEffect(() => {
    saveLastAttempt(lastAttempt);
  }, [lastAttempt]);

  useEffect(() => {
    // Skip while 'confirming' — the relay has NOT been submitted yet, so there
    // is no bridge_transfers row to find. The confirmation poller below owns
    // this phase and submits the relay once the source tx is final; letting the
    // DB poller run here would hit 3 null reads and wrongly mark the transfer
    // 'failed' ("relayer was not notified") while it is legitimately maturing.
    if (
      !lastAttempt ||
      isTerminalStatus(lastAttempt.response.status) ||
      lastAttempt.response.status === 'confirming'
    ) {
      polledSourceTxRef.current = null;
      pollAttemptsRef.current = 0;
      pollNullStreakRef.current = 0;
      return;
    }
    const sourceTx = lastAttempt.sourceTx;
    if (polledSourceTxRef.current !== sourceTx) {
      polledSourceTxRef.current = sourceTx;
      pollAttemptsRef.current = 0;
      pollNullStreakRef.current = 0;
    }

    async function pollOnce(): Promise<boolean> {
      pollAttemptsRef.current += 1;
      const status = await fetchBridgeTransferStatus(sourceTx);
      if (status) {
        pollNullStreakRef.current = 0;
        setLastAttempt((prev) => (prev && prev.sourceTx === sourceTx ? { ...prev, response: status } : prev));
        if (isTerminalStatus(status.status)) {
          if (status.status === 'completed') {
            void refreshEvmBalance();
            void refreshSolanaBalance();
          }
          return true;
        }
        return false;
      }

      // Source lock/burn landed on-chain but the relayer has no record — the
      // user likely closed the tab during message signing or the relay POST
      // never completed. Surface a retryable failure instead of spinning forever.
      pollNullStreakRef.current += 1;
      if (pollNullStreakRef.current >= RELAY_MISSING_NULL_POLLS) {
        setLastAttempt((prev) =>
          prev && prev.sourceTx === sourceTx
            ? { ...prev, response: { status: 'failed', error: RELAY_NEVER_SUBMITTED_ERROR } }
            : prev,
        );
        return true;
      }
      return pollAttemptsRef.current >= MAX_POLL_ATTEMPTS;
    }

    void pollOnce();
    const interval = setInterval(async () => {
      if (await pollOnce()) clearInterval(interval);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAttempt?.sourceTx, lastAttempt?.response.status]);

  // ── Poll source-tx confirmations, then auto-submit relay when ready ────────
  useEffect(() => {
    if (!lastAttempt || lastAttempt.response.status !== 'confirming') {
      confirmingRelayRef.current = false;
      return;
    }

    const attempt = lastAttempt;
    let cancelled = false;

    async function applyRelayOutcome(response: BridgeRelayResponse) {
      setLastAttempt({ ...attempt, response });
      if (response.status === 'failed') {
        toast({
          variant: 'destructive',
          title: 'Relay failed',
          description: response.error || 'The relayer could not complete the destination transfer.',
        });
      } else if (response.status === 'completed') {
        toast({
          title: 'Bridge completed',
          description: response.destTxHash
            ? attempt.direction === 'solana_to_evm'
              ? 'wNAVE minted on the destination chain.'
              : 'NAVE released to your Solana address.'
            : 'Destination transfer completed.',
        });
        void refreshEvmBalance();
        void refreshSolanaBalance();
      }
    }

    async function tick() {
      const { direction, sourceTx, evmChainId: chainId } = attempt;
      let progress: ConfirmationProgress;

      try {
        if (direction === 'evm_to_solana') {
          progress = await getEvmBurnConfirmationProgress(
            evmClientForChain(chainId),
            sourceTx as Hash,
            NAVE_BRIDGE_EVM_CONFIRMATIONS,
          );
        } else {
          progress = await getSolanaLockConfirmationProgress(connection, sourceTx);
        }
      } catch {
        return;
      }

      if (cancelled) return;

      setLastAttempt((prev) =>
        prev && prev.sourceTx === sourceTx
          ? {
              ...prev,
              response: {
                status: 'confirming',
                confirmationsCurrent: progress.current,
                confirmationsRequired: progress.required,
              },
            }
          : prev,
      );

      if (!progress.ready || confirmingRelayRef.current) return;

      confirmingRelayRef.current = true;
      try {
        const response = await submitBridgeRelay({
          direction: attempt.direction,
          ...(attempt.direction === 'solana_to_evm'
            ? { sourceChain: 'solana' as const, destChain: chainId, destChainId: chainId }
            : { sourceChain: chainId, sourceChainId: chainId, destChain: 'solana' as const }),
          sourceTx,
          recipient: attempt.recipient,
          amountRaw: attempt.amountRaw,
        });

        if (cancelled) return;

        if (response.status === 'failed' && isConfirmationWaitError(response.error)) {
          const parsed = parseConfirmationProgress(response.error);
          setLastAttempt((prev) =>
            prev && prev.sourceTx === sourceTx
              ? {
                  ...prev,
                  response: confirmingResponse(direction, parsed ?? progress),
                }
              : prev,
          );
          return;
        }

        await applyRelayOutcome(response);
      } finally {
        confirmingRelayRef.current = false;
      }
    }

    void tick();
    const interval = setInterval(() => void tick(), CONFIRM_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAttempt?.sourceTx, lastAttempt?.response.status, connection]);

  const bridge = useCallback(async () => {
    if (!NAVE_BRIDGE_ENABLED) {
      toast({ variant: 'destructive', title: 'Bridge unavailable', description: 'The bridge is not configured for this environment.' });
      return;
    }
    if (!route) {
      toast({ variant: 'destructive', title: 'No route', description: 'No bridge route is available for this selection.' });
      return;
    }
    if (amountRaw <= 0n) {
      toast({ variant: 'destructive', title: 'Invalid amount', description: 'Enter a positive NAVE amount to bridge.' });
      return;
    }
    if (NAVE_BRIDGE_PER_TX_CAP_RAW > 0n && amountRaw > NAVE_BRIDGE_PER_TX_CAP_RAW) {
      const capHuman = Number(NAVE_BRIDGE_PER_TX_CAP_RAW) / 10 ** NAVE_DECIMALS;
      toast({
        variant: 'destructive',
        title: 'Over per-transaction cap',
        description: `Max ${capHuman.toLocaleString()} NAVE net per bridge tx. Split into smaller transfers.`,
      });
      return;
    }
    if (!isDestinationValid) {
      toast({
        variant: 'destructive',
        title: 'Destination address required',
        description:
          direction === 'solana_to_evm'
            ? 'Enter the Ethereum/Base address that should receive wNAVE.'
            : 'Enter the Solana address that should receive NAVE.',
      });
      return;
    }

    setIsBridging(true);
    try {
      if (direction === 'solana_to_evm') {
        if (!publicKey) {
          toast({ variant: 'destructive', title: 'Connect Solana wallet', description: 'Connect your Solana wallet to lock NAVE.' });
          return;
        }
        const destAddress = toAddress(destination);
        if (!destAddress) {
          toast({ variant: 'destructive', title: 'Invalid destination', description: 'Enter a valid Ethereum/Base address (0x…).' });
          return;
        }
        // The lock instruction pulls the GROSS (net + on-top fee) from the
        // sender's account, so check against gross — mirroring the EVM path.
        if (solanaNaveBalance !== null && quote.grossRaw > solanaNaveBalance) {
          toast({ variant: 'destructive', title: 'Insufficient balance', description: `You need enough NAVE to cover the amount plus the ${FEE_PCT_LABEL} bridge fee.` });
          return;
        }

        if (!NAVE_BRIDGE_PROGRAM_ID) {
          toast({ variant: 'destructive', title: 'Bridge misconfigured', description: 'The Solana bridge program is not configured.' });
          return;
        }
        if (!NAVE_BRIDGE_PROTOCOL_FEE_ACCOUNT || !NAVE_BRIDGE_STAKING_POOL_ACCOUNT) {
          toast({ variant: 'destructive', title: 'Bridge misconfigured', description: 'The Solana fee destinations are not configured.' });
          return;
        }

        // Single signature: the destination EVM recipient is embedded IN the
        // lock instruction data, so this one signed tx authorizes the exact
        // payout address AND pulls the 2.5%-on-top fee (resolved on Solana).
        // No separate off-chain recipient signature is needed.
        let instruction;
        try {
          instruction = buildBridgeLockInstruction({
            programId: NAVE_BRIDGE_PROGRAM_ID,
            sender: publicKey,
            naveMint: SOLANA_NAVE_MINT,
            protocolFeeAccount: new PublicKey(NAVE_BRIDGE_PROTOCOL_FEE_ACCOUNT),
            stakingPoolAccount: new PublicKey(NAVE_BRIDGE_STAKING_POOL_ACCOUNT),
            netAmount: amountRaw,
            destChainId: route.evmChainId,
            evmRecipient: destAddress,
          });
        } catch (err) {
          toast({ variant: 'destructive', title: 'Bridge misconfigured', description: err instanceof Error ? err.message : 'Could not build the lock instruction.' });
          return;
        }

        const out = await tx.send(
          { instruction, programId: NAVE_BRIDGE_PROGRAM_ID },
          { successLabel: 'NAVE locked — relaying to EVM' },
        );
        if (out.status !== 'success' || !out.txHash) return;

        // Wait for Solana finality before calling the relayer — poll every 3s and
        // auto-submit once the lock tx is finalized (see confirming effect).
        setLastAttempt({
          direction,
          evmChainId: route.evmChainId,
          sourceTx: out.txHash,
          amountRaw: amountRaw.toString(),
          recipient: destAddress,
          response: confirmingResponse('solana_to_evm'),
        });
      } else {
        // evm_to_solana — burn WrappedNave, then relay releases NAVE on Solana.
        if (!evmAddress) {
          toast({ variant: 'destructive', title: 'Connect EVM wallet', description: 'Connect an Ethereum/Base wallet to burn wNAVE.' });
          return;
        }
        let destPubkey: PublicKey;
        try {
          destPubkey = new PublicKey(destination.trim());
        } catch {
          toast({ variant: 'destructive', title: 'Invalid destination', description: 'Enter a valid Solana address.' });
          return;
        }
        if (!wrappedAddress) {
          toast({ variant: 'destructive', title: 'Bridge misconfigured', description: 'No wNAVE contract is configured for this chain.' });
          return;
        }
        // The user burns the GROSS (net + on-top fee), so check against gross.
        if (evmWrappedBalance !== null && quote.grossRaw > evmWrappedBalance) {
          toast({ variant: 'destructive', title: 'Insufficient balance', description: `You need enough wNAVE to cover the amount plus the ${FEE_PCT_LABEL} bridge fee.` });
          return;
        }

        // Single signature: burn `gross` (net + 2.5%) with the Solana recipient
        // embedded via `bridgeBurn(amount, solanaRecipient)` — the burn tx
        // itself authorizes the payout address. The relayer releases the net on
        // Solana and resolves the fee there. The user pays the gross so the net
        // arrives whole on Solana.
        const grossRaw = quote.grossRaw;
        let solanaRecipient32: `0x${string}`;
        try {
          solanaRecipient32 = solanaAddressToBytes32(destPubkey.toBase58());
        } catch {
          toast({ variant: 'destructive', title: 'Invalid destination', description: 'Enter a valid Solana address.' });
          return;
        }

        const out = await tx.sendEvm(
          {
            request: {
              kind: 'evm',
              chainId: route.evmChainId,
              address: wrappedAddress,
              abi: wrappedNaveAbi,
              functionName: 'bridgeBurn',
              args: [grossRaw, solanaRecipient32],
            },
          },
          { successLabel: 'wNAVE burned — relaying to Solana' },
        );
        if (out.status !== 'success' || !out.txHash) return;

        // Wait for EVM burn confirmations before calling the relayer — poll every
        // 3s and auto-submit once depth is met (see confirming effect).
        setLastAttempt({
          direction,
          evmChainId: route.evmChainId,
          sourceTx: out.txHash,
          amountRaw: amountRaw.toString(),
          recipient: destPubkey.toBase58(),
          response: confirmingResponse('evm_to_solana'),
        });
      }
    } finally {
      setIsBridging(false);
      void refreshSolanaBalance();
      void refreshEvmBalance();
    }
  }, [
    route,
    amountRaw,
    quote,
    direction,
    destination,
    isDestinationValid,
    publicKey,
    evmAddress,
    solanaNaveBalance,
    evmWrappedBalance,
    wrappedAddress,
    tx,
    refreshSolanaBalance,
    refreshEvmBalance,
  ]);

  const retryRelay = useCallback(async () => {
    if (!lastAttempt) return;
    if (lastAttempt.response.status === 'confirming') return;

    if (
      lastAttempt.response.status === 'failed' &&
      isConfirmationWaitError(lastAttempt.response.error)
    ) {
      setLastAttempt((prev) =>
        prev
          ? {
              ...prev,
              response: confirmingResponse(
                prev.direction,
                parseConfirmationProgress(prev.response.error) ?? undefined,
              ),
            }
          : prev,
      );
      return;
    }

    if (lastAttempt.response.status !== 'failed') return;

    setIsBridging(true);
    try {
      const attempt = lastAttempt;
      const response = await submitBridgeRelay({
        direction: attempt.direction,
        ...(attempt.direction === 'solana_to_evm'
          ? { sourceChain: 'solana' as const, destChain: attempt.evmChainId, destChainId: attempt.evmChainId }
          : { sourceChain: attempt.evmChainId, sourceChainId: attempt.evmChainId, destChain: 'solana' as const }),
        sourceTx: attempt.sourceTx,
        recipient: attempt.recipient,
        amountRaw: attempt.amountRaw,
        retry: true,
      });

      if (response.status === 'failed' && isConfirmationWaitError(response.error)) {
        setLastAttempt({
          ...attempt,
          response: confirmingResponse(
            attempt.direction,
            parseConfirmationProgress(response.error) ?? undefined,
          ),
        });
        return;
      }

      setLastAttempt({ ...attempt, response });
      if (response.status === 'failed') {
        toast({
          variant: 'destructive',
          title: 'Relay failed',
          description: response.error || 'The relayer could not complete the destination transfer.',
        });
      } else {
        toast({
          title: 'Bridge completed',
          description: response.destTxHash
            ? attempt.direction === 'solana_to_evm'
              ? 'wNAVE minted on the destination chain.'
              : 'NAVE released to your Solana address.'
            : 'Relay accepted — destination transfer submitted.',
        });
        void refreshEvmBalance();
        void refreshSolanaBalance();
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Relay failed',
        description: err instanceof Error ? err.message : 'Could not reach the bridge relayer.',
      });
    } finally {
      setIsBridging(false);
    }
  }, [lastAttempt, refreshEvmBalance, refreshSolanaBalance]);

  return {
    supportedRoutes,
    direction,
    setDirection,
    evmChainId,
    setEvmChainId: handleEvmChainId,
    route,
    amount,
    setAmount,
    destination,
    setDestination,
    isDestinationValid,
    quote,
    solanaNaveBalance,
    evmWrappedBalance,
    isBridging,
    lastAttempt,
    enabled: NAVE_BRIDGE_ENABLED,
    bridge,
    retryRelay,
  };
}

// ─── Shared context ──────────────────────────────────────────────────────────
// The bridge controller runs the two-step flow plus source-confirmation and
// DB-status polling — it must exist exactly once per page. Expose it through a
// provider so both the Bridge form and the "Your transfers" list (which surfaces
// the in-flight attempt as its top row) read the SAME live state without
// double-running those side effects.

const BridgeContext = createContext<UseBridgeResult | null>(null);

export function BridgeProvider({ children }: { children: ReactNode }) {
  const value = useBridgeController();
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useBridge(): UseBridgeResult {
  const ctx = useContext(BridgeContext);
  if (!ctx) {
    throw new Error('useBridge must be used within a <BridgeProvider>.');
  }
  return ctx;
}
