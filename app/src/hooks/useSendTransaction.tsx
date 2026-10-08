import { useCallback, useRef, useState } from 'react';
import { Transaction, type Connection } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { writeContract, waitForTransactionReceipt, switchChain, getAccount, getPublicClient } from '@wagmi/core';
import { toast } from '../hooks/use-toast';
import { USE_MOCKS, SOLANA_NETWORK, SOLANA_RPC_URL } from '../lib/programConfig';
import type { TransactionBuildResult } from '../lib/transactionBuilders';
import { wagmiConfig } from '../lib/evm/wagmi';
import { type EvmBuildResult } from '../lib/evm/writers';
import { useChain } from './useChain';
import type { EvmChainId } from '../lib/chain/types';

export type TxStatus = 'idle' | 'signing' | 'confirming' | 'success' | 'error' | 'mock';

/** Block explorer base (tx) per supported EVM chain id (closed set). */
const EVM_EXPLORER_TX_BASE: Record<EvmChainId, string> = {
  1: 'https://etherscan.io/tx',
  8453: 'https://basescan.org/tx',
  4663: 'https://robinhoodchain.blockscout.com/tx',
  11155111: 'https://sepolia.etherscan.io/tx',
  84532: 'https://sepolia.basescan.org/tx',
  46630: 'https://explorer.testnet.chain.robinhood.com/tx',
};

interface SendState {
  status: TxStatus;
  txHash: string | null;
  error: string | null;
}

const EXPLORER_BASE = 'https://solscan.io/tx';

function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth += 1) {
    const obj = cur as {
      name?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      reason?: unknown;
      code?: unknown;
      metaMessages?: unknown;
      cause?: unknown;
      error?: unknown;
    };
    const name = typeof obj.name === 'string' ? obj.name : '';
    const message =
      typeof obj.shortMessage === 'string'
        ? obj.shortMessage
        : typeof obj.reason === 'string'
          ? obj.reason
          : typeof obj.details === 'string'
            ? obj.details
            : typeof obj.message === 'string'
              ? obj.message
              : '';
    const code = typeof obj.code === 'number' || typeof obj.code === 'string' ? String(obj.code) : '';
    const meta = Array.isArray(obj.metaMessages)
      ? obj.metaMessages.filter((m): m is string => typeof m === 'string').join(' ')
      : '';
    const label = [name, code && `code ${code}`, message, meta].filter(Boolean).join(': ');
    if (label) parts.push(label);

    const nested = obj.cause ?? obj.error;
    if (!nested || nested === cur) break;
    cur = nested;
  }
  if (!parts.length && typeof err === 'string') parts.push(err);
  return [...new Set(parts)].join(' | ');
}

function isWalletRejection(err: unknown, msg = errorText(err)): boolean {
  return /UserRejectedRequestError|code 4001|ACTION_REJECTED|(user|you) (rejected|denied)|rejected the request|request rejected|transaction cancelled/i.test(msg);
}

function walletErrorMessage(err: unknown, fallback = 'Transaction failed'): string {
  if (isWalletRejection(err)) return 'You rejected the transaction in your wallet.';
  const msg = errorText(err);
  return msg || fallback;
}

function findNestedLogs(err: unknown): string[] | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth += 1) {
    const obj = cur as {
      logs?: unknown;
      data?: { logs?: unknown };
      cause?: unknown;
      error?: unknown;
    };
    if (Array.isArray(obj.logs) && obj.logs.every((l) => typeof l === 'string')) return obj.logs;
    if (Array.isArray(obj.data?.logs) && obj.data.logs.every((l) => typeof l === 'string')) return obj.data.logs;
    const nested = obj.cause ?? obj.error;
    if (!nested || nested === cur) break;
    cur = nested;
  }
  return null;
}

function summarizeSolanaLogs(logs: string[] | null | undefined, fallback: string): string {
  // JSON simulation often returns `InstructionError` + `Custom:6027` with thin logs.
  // On nave_governance (IDL) 6027 = ProposalTypeNotImplemented — legacy binaries rejected
  // `create_proposal` for Transfer; nave_core also maps 6027 to ProposalCountUnderflow.
  const joined = (logs ?? []).join('\n');
  const hit6006 =
    fallback.includes('"Custom":6006') ||
    fallback.includes('Custom:6006') ||
    /custom program error: 0x1776/i.test(fallback) ||
    /custom program error: 0x1776/i.test(joined) ||
    joined.includes('PerTxCapExceeded');
  if (hit6006) {
    return (
      'Amount exceeds the bridge per-transaction cap (currently 1,000 NAVE net per lock/release). ' +
      'Split into smaller transfers of at most 1,000 NAVE each.'
    );
  }
  const hit6007 =
    fallback.includes('"Custom":6007') ||
    fallback.includes('Custom:6007') ||
    /custom program error: 0x1777/i.test(fallback) ||
    /custom program error: 0x1777/i.test(joined) ||
    joined.includes('DailyCapExceeded');
  if (hit6007) {
    return (
      'Amount exceeds the bridge rolling 24h release cap (currently 25,000 NAVE). ' +
      'Try a smaller amount or wait for the daily window to reset.'
    );
  }
  const hit6027 =
    fallback.includes('"Custom":6027') ||
    fallback.includes('Custom:6027') ||
    /custom program error: 0x178b/i.test(fallback) ||
    /custom program error: 0x178b/i.test(joined);
  if (hit6027) {
    if (joined.includes('ProposalTypeNotImplemented') || joined.includes('Proposal type has no execution path')) {
      return (
        'Governance program rejected this proposal (6027 / ProposalTypeNotImplemented): the deployed ' +
        'nave_governance build still blocks treasury transfer proposals at creation. Upgrade nave_governance ' +
        'on this cluster to match your app. (If logs show nave_core instead, 6027 is ProposalCountUnderflow.)'
      );
    }
    return (
      'Simulation failed with custom error 6027. For treasury “send” / transfer proposals this is usually ' +
      'nave_governance ProposalTypeNotImplemented — upgrade nave_governance. If the failing program is nave_core, ' +
      '6027 is ProposalCountUnderflow.'
    );
  }
  if (fallback.includes('"Custom":3003') || fallback.includes('custom program error: 0xbbb')) {
    return 'A required on-chain account could not be decoded. Refresh the DAO data and try again; if this repeats, this action may be using an unsupported account type for the current DAO.';
  }
  if (!logs?.length) return fallback;
  const errorLine = logs.find((l) =>
    l.includes('AnchorError') ||
    l.includes('custom program error') ||
    l.includes('Error Code:') ||
    l.includes('Error:'),
  ) ?? logs[logs.length - 1];

  if (errorLine.includes('VotingPeriodNotEnded') || errorLine.includes('VotingStillOpen')) {
    return 'Voting window is still open — finalize becomes available when voting ends or the outcome is certain.';
  }
  if (errorLine.includes('VotingPeriodEnded')) {
    return 'The voting window is closed — you can no longer cast a vote.';
  }
  if (errorLine.includes('ProposalNotActive')) {
    return 'This proposal has already been finalized or cancelled.';
  }
  if (errorLine.includes('QuorumNotMet') || errorLine.includes('QuorumNotReached')) {
    return 'Quorum has not been reached.';
  }
  if (errorLine.includes('AlreadyVoted') || errorLine.includes('DuplicateSig')) {
    return 'Your vote has already been recorded on-chain.';
  }
  if (errorLine.includes('GuardianRequired')) {
    return 'Only DAO guardians can vote on wallet-governed proposals.';
  }
  if (errorLine.includes('DaoOwnershipMismatch')) {
    return 'Account ownership mismatch — please refresh and try again.';
  }
  if (errorLine.includes('Unauthorized')) {
    return 'Unauthorized — only the DAO founder or authorized guardian can perform this action.';
  }
  if (errorLine.includes('InsufficientFunds') || errorLine.includes('insufficient lamports')) {
    return 'Insufficient funds — the treasury or connected wallet needs more SOL to cover this operation.';
  }
  if (errorLine.includes('TokenNotRegistered') || errorLine.includes('token_not_registered')) {
    return 'This token is not registered in the DAO token registry.';
  }
  if (errorLine.includes('MintAuthorityRevoked') || errorLine.includes('mint_authority_revoked')) {
    return 'The mint authority for this token has been revoked — minting is no longer possible.';
  }
  if (
    joined.includes('InstructionDidNotDeserialize') ||
    joined.includes('instruction did not deserialize') ||
    joined.includes('Fallback functions are not supported') ||
    fallback.includes('InstructionDidNotDeserialize')
  ) {
    return (
      'The on-chain program does not match this app build (instruction decode failed). ' +
      'The cluster may be running an older nave_core — upgrade the program on this network, ' +
      'then refresh and try again.'
    );
  }
  if (joined.includes('AccountNotInitialized') || joined.includes('AccountNotFound')) {
    return 'A required on-chain account is missing or not initialized. If you retried after a partial deploy, refresh and resume — or use a new wallet if the DAO slot was already consumed.';
  }
  return fallback.includes('Unexpected') ? errorLine.slice(0, 220) : fallback;
}

async function getWalletAdapterLogs(err: unknown, connection: Connection): Promise<string[] | null> {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth += 1) {
    const loggable = cur as { getLogs?: (c: Connection) => Promise<string[] | null>; cause?: unknown; error?: unknown };
    if (typeof loggable.getLogs === 'function') {
      const logs = await loggable.getLogs(connection);
      if (logs?.length) return logs;
    }
    const nested = loggable.cause ?? loggable.error;
    if (!nested || nested === cur) break;
    cur = nested;
  }
  return null;
}

async function describeSolanaSendError(err: unknown, connection: Connection): Promise<{ message: string; rejected: boolean }> {
  const message = walletErrorMessage(err);
  const rejected = isWalletRejection(err, message);
  if (rejected) return { message, rejected };

  const nestedLogs = findNestedLogs(err);
  if (nestedLogs) return { message: summarizeSolanaLogs(nestedLogs, message), rejected };

  try {
    const adapterLogs = await getWalletAdapterLogs(err, connection);
    if (adapterLogs) return { message: summarizeSolanaLogs(adapterLogs, message), rejected };
  } catch {
    // Keep the wallet adapter message if log extraction itself fails.
  }

  // Phantom often surfaces failed wallet simulation as RPC -32603 with no program logs.
  if (/code -32603|32603.*Unexpected/i.test(message)) {
    return {
      message:
        'Wallet simulation failed (RPC -32603). Common causes: not enough SOL for formation fee, agent seeding, and rent; ' +
        'on-chain programs older than this app build; or retrying after a partial deploy. Add SOL, refresh, and try again. ' +
        'If Phantom shows “simulation failed”, expand its error details for the underlying program message.',
      rejected,
    };
  }

  return { message, rejected };
}

async function simulateBeforeWallet(
  connection: Connection,
  tx: Transaction,
  signers: import('@solana/web3.js').Keypair[] = [],
): Promise<string | null> {
  try {
    // Clone so partial signatures for simulation never leak into the wallet send.
    const simTx = new Transaction();
    simTx.feePayer = tx.feePayer;
    simTx.recentBlockhash = tx.recentBlockhash;
    for (const ix of tx.instructions) simTx.add(ix);
    if (signers.length > 0) {
      simTx.partialSign(...signers);
    }
    const simulation = await connection.simulateTransaction(simTx);
    if (simulation.value.err) {
      const summarized = summarizeSolanaLogs(
        simulation.value.logs,
        `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`,
      );
      return summarized;
    }
  } catch {
    // Some wallets/RPCs reject unsigned simulation. Let wallet preflight handle it.
  }
  return null;
}

const CONFIRM_POLL_INTERVAL_MS = 2_000;
const CONFIRM_POLL_MAX_ATTEMPTS = 30;

/**
 * FN-M1: poll signature status (searching transaction history, so a tx that
 * landed just before an RPC/WebSocket hiccup is still found) until it lands,
 * fails on-chain, or provably expired. Distinguishes the three outcomes:
 * - landed → return
 * - failed on-chain → throw with the on-chain error (retrying would re-fail)
 * - expired (blockhash window passed, no record anywhere) → throw "safe to retry"
 */
async function pollSignatureStatus(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<void> {
  for (let attempt = 0; attempt < CONFIRM_POLL_MAX_ATTEMPTS; attempt++) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = value[0];
    if (status?.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    if (status == null) {
      // No record of the signature. Only once the blockhash window has passed
      // can we be certain it will never land.
      const blockHeight = await connection.getBlockHeight('confirmed');
      if (blockHeight > lastValidBlockHeight) {
        throw new Error(
          'Transaction expired — it was never processed (blockhash window passed with no on-chain record), so it is safe to retry.',
        );
      }
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_INTERVAL_MS));
  }

  throw new Error(
    'Transaction confirmation timed out. Check Solscan or your wallet — it may still land. Do not retry until you confirm it did not.',
  );
}

/**
 * Confirm a signature by POLLING signature status (not the WebSocket
 * `signatureSubscribe` subscription).
 *
 * `connection.confirmTransaction` uses a `signatureSubscribe` pubsub
 * subscription over the WebSocket that web3.js auto-derives from the HTTP RPC.
 * Our public browser RPC (VITE_SOLANA_RPC_URL) does not support pubsub without
 * the API key (which must never ship in the browser bundle), so every
 * subscription is rejected with a JSON-RPC error, and web3.js replays the whole
 * pending set on each WS reconnect — flooding the console even though the tx
 * itself lands. Polling `getSignatureStatuses` (searching transaction history)
 * is endpoint-agnostic, opens no WebSocket, and already distinguishes
 * landed / failed-on-chain / provably-expired. `blockhash` is unused here (the
 * poller derives expiry from `lastValidBlockHeight` + current block height).
 */
async function confirmSignature(
  connection: Connection,
  signature: string,
  _blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  await pollSignatureStatus(connection, signature, lastValidBlockHeight);
}

type WalletSendTransaction = (
  transaction: Transaction,
  connection: Connection,
  options?: { signers?: import('@solana/web3.js').Keypair[] },
) => Promise<string>;

/** Simulate, refresh blockhash, sign via wallet, send, and confirm (with expiry recovery). */
async function signSendConfirm(
  connection: Connection,
  sendTransaction: WalletSendTransaction,
  feePayer: import('@solana/web3.js').PublicKey,
  tx: Transaction,
  signers: import('@solana/web3.js').Keypair[],
): Promise<string> {
  tx.feePayer = feePayer;
  const { blockhash: simBlockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = simBlockhash;

  const simulationError = await simulateBeforeWallet(connection, tx, signers);
  if (simulationError) throw new Error(simulationError);

  // Refresh blockhash immediately before wallet sign+broadcast — DAO creation can
  // spend 60s+ in the wallet while the initial blockhash expires.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  const sig = await sendTransaction(tx, connection, { signers });
  await confirmSignature(connection, sig, blockhash, lastValidBlockHeight);
  return sig;
}

/** Solscan cluster query suffix derived from the configured network. Mainnet is
 *  Solscan's default (no param); devnet/localnet need an explicit cluster. */
function explorerClusterSuffix(): string {
  if (SOLANA_NETWORK === 'mainnet') return '';
  if (SOLANA_NETWORK === 'localnet') {
    return `?cluster=custom&customUrl=${encodeURIComponent(SOLANA_RPC_URL)}`;
  }
  return '?cluster=devnet';
}

/**
 * Shared hook for building, signing, sending, and confirming Solana transactions.
 *
 * Fires toast notifications automatically on every outcome:
 * - **success** — green toast with Solscan explorer link
 * - **error** — destructive toast with the error message
 * - **mock** — subtle toast indicating demo/mock mode
 *
 * Accepts one or more `TransactionBuildResult` objects.  If *any* result has a
 * `null` instruction (programs not configured), the hook falls back to `'mock'`
 * status so the calling page can run its existing mock UX.
 *
 * Multiple results are sent as separate sequential transactions (needed for the
 * 3-tx DAO init flow).
 */
export function useSendTransaction() {
  const { connection } = useConnection();
  const { sendTransaction, publicKey } = useWallet();
  const { chainKind } = useChain();
  const [state, setState] = useState<SendState>({ status: 'idle', txHash: null, error: null });

  // FN-M1: in-flight latch. A second concurrent submission (e.g. double-click)
  // must be rejected before it opens another wallet prompt — deposits are not
  // idempotent, so two prompts risk a double spend. A ref (not state) so the
  // guard is synchronous and immune to render batching.
  const inFlightRef = useRef(false);

  const rejectConcurrent = useCallback((): SendState => {
    const busy: SendState = {
      status: 'error',
      txHash: null,
      error: 'A transaction is already in progress. Wait for it to finish before submitting another.',
    };
    toast({
      variant: 'destructive',
      title: 'Transaction in progress',
      description: busy.error!,
    });
    return busy;
  }, []);

  const reset = useCallback(() => {
    setState({ status: 'idle', txHash: null, error: null });
  }, []);

  const send = useCallback(
    async (
      results: TransactionBuildResult | TransactionBuildResult[],
      options?: {
        /** Fires each time a sequential tx begins (step 1-based, total) */
        onProgress?: (step: number, total: number) => void;
        /** Human-readable label for the toast, e.g. "Vote cast" */
        successLabel?: string;
        /** Skip the mock-mode toast (useful for pages that have their own mock UX) */
        quietMock?: boolean;
      },
    ): Promise<SendState> => {
      const list = Array.isArray(results) ? results : [results];
      const { onProgress, successLabel, quietMock } = options ?? {};

      // ── Mock vs. real build failure ─────────────────────────
      // A null instruction means "no tx to send". Only treat that as benign
      // demo mode when mocks are explicitly enabled; on a real DAO it is a
      // genuine build failure and must surface as an error (never a silent
      // success), so the UI cannot read a no-op as a completed action.
      const nullResult = list.find((r) => r.instruction === null);
      if (nullResult) {
        if (USE_MOCKS) {
          const mockState: SendState = {
            status: 'mock',
            txHash: null,
            error: nullResult.error || null,
          };
          setState(mockState);
          if (!quietMock) {
            toast({
              title: 'Demo mode',
              description: 'Programs not configured — running in mock mode.',
            });
          }
          return mockState;
        }
        const buildError: SendState = {
          status: 'error',
          txHash: null,
          error: nullResult.error || 'Failed to build transaction.',
        };
        setState(buildError);
        toast({
          variant: 'destructive',
          title: 'Transaction failed',
          description: buildError.error!,
        });
        return buildError;
      }

      // ── Wallet guard ────────────────────────────────────────
      if (!publicKey) {
        const noWallet: SendState = {
          status: 'error',
          txHash: null,
          error: 'Wallet not connected',
        };
        setState(noWallet);
        toast({
          variant: 'destructive',
          title: 'Wallet required',
          description: 'Connect your wallet to submit transactions.',
        });
        return noWallet;
      }

      // ── Build, sign, send, confirm ──────────────────────────
      // Each result is sent as its own transaction. To bundle multiple
      // instructions into a single signature, use `sendGrouped`.
      if (inFlightRef.current) return rejectConcurrent();
      inFlightRef.current = true;
      try {
        setState({ status: 'signing', txHash: null, error: null });

        let lastSig = '';
        for (let i = 0; i < list.length; i++) {
          onProgress?.(i + 1, list.length);

          const result = list[i];
          const tx = new Transaction();
          if (result.preInstructions?.length) {
            tx.add(...result.preInstructions);
          }
          tx.add(result.instruction!);

          setState((prev) => ({ ...prev, status: i === 0 ? 'signing' : 'confirming' }));

          const sig = await signSendConfirm(
            connection,
            sendTransaction,
            publicKey,
            tx,
            result.signers ?? [],
          );
          lastSig = sig;

          setState((prev) => ({ ...prev, status: 'confirming' }));
        }

        const success: SendState = { status: 'success', txHash: lastSig, error: null };
        setState(success);

        toast({
          title: successLabel ?? 'Transaction confirmed',
          description: lastSig
            ? `${lastSig.slice(0, 8)}…${lastSig.slice(-8)}`
            : 'Transaction landed on-chain.',
          action: lastSig
            ? toastExplorerAction(lastSig)
            : undefined,
        });

        return success;
      } catch (err: unknown) {
        const { message: msg, rejected: isRejection } = await describeSolanaSendError(err, connection);

        const errState: SendState = { status: 'error', txHash: null, error: msg };
        setState(errState);

        toast({
          variant: 'destructive',
          title: isRejection ? 'Transaction cancelled' : 'Transaction failed',
          description: isRejection
            ? msg
            : msg.length > 120
              ? msg.slice(0, 120) + '…'
              : msg,
        });

        return errState;
      } finally {
        inFlightRef.current = false;
      }
    },
    [connection, publicKey, sendTransaction, rejectConcurrent],
  );

  /**
   * Send a sequence of *grouped* transactions. Each inner array is combined into
   * a single transaction (one wallet signature), so callers can bundle several
   * instructions together to reduce the number of signature prompts. Groups are
   * still sent sequentially because later groups may depend on accounts created
   * by earlier ones (e.g. the DAO registry before its extensions).
   */
  const sendGrouped = useCallback(
    async (
      groups: TransactionBuildResult[][],
      options?: {
        onProgress?: (step: number, total: number) => void;
        successLabel?: string;
        quietMock?: boolean;
        quietToast?: boolean;
      },
    ): Promise<SendState> => {
      const { onProgress, successLabel, quietMock, quietToast } = options ?? {};
      const flat = groups.flat();

      const nullResult = flat.find((r) => r.instruction === null);
      if (nullResult) {
        if (USE_MOCKS) {
          const mockState: SendState = {
            status: 'mock',
            txHash: null,
            error: nullResult.error || null,
          };
          setState(mockState);
          if (!quietMock) {
            toast({ title: 'Demo mode', description: 'Programs not configured — running in mock mode.' });
          }
          return mockState;
        }
        const buildError: SendState = {
          status: 'error',
          txHash: null,
          error: nullResult.error || 'Failed to build transaction.',
        };
        setState(buildError);
        if (!quietToast) {
          toast({ variant: 'destructive', title: 'Transaction failed', description: buildError.error! });
        }
        return buildError;
      }

      if (!publicKey) {
        const noWallet: SendState = { status: 'error', txHash: null, error: 'Wallet not connected' };
        setState(noWallet);
        if (!quietToast) {
          toast({ variant: 'destructive', title: 'Wallet required', description: 'Connect your wallet to submit transactions.' });
        }
        return noWallet;
      }

      if (inFlightRef.current) return rejectConcurrent();
      inFlightRef.current = true;
      try {
        setState({ status: 'signing', txHash: null, error: null });
        let lastSig = '';
        for (let i = 0; i < groups.length; i++) {
          onProgress?.(i + 1, groups.length);
          const group = groups[i];
          const tx = new Transaction();
          const signers: import('@solana/web3.js').Keypair[] = [];
          for (const result of group) {
            if (result.preInstructions?.length) tx.add(...result.preInstructions);
            if (result.instruction) tx.add(result.instruction);
            if (result.signers?.length) signers.push(...result.signers);
          }
          setState((prev) => ({ ...prev, status: i === 0 ? 'signing' : 'confirming' }));
          const sig = await signSendConfirm(connection, sendTransaction, publicKey, tx, signers);
          lastSig = sig;
          setState((prev) => ({ ...prev, status: 'confirming' }));
        }

        const success: SendState = { status: 'success', txHash: lastSig, error: null };
        setState(success);
        if (!quietToast) {
          toast({
            title: successLabel ?? 'Transaction confirmed',
            description: lastSig ? `${lastSig.slice(0, 8)}…${lastSig.slice(-8)}` : 'Transaction landed on-chain.',
            action: lastSig ? toastExplorerAction(lastSig) : undefined,
          });
        }
        return success;
      } catch (err: unknown) {
        const { message: msg, rejected: isRejection } = await describeSolanaSendError(err, connection);
        const errState: SendState = { status: 'error', txHash: null, error: msg };
        setState(errState);
        if (!quietToast) {
          toast({
            variant: 'destructive',
            title: isRejection ? 'Transaction cancelled' : 'Transaction failed',
            description: isRejection
              ? msg
              : msg.length > 120 ? msg.slice(0, 120) + '…' : msg,
          });
        }
        return errState;
      } finally {
        inFlightRef.current = false;
      }
    },
    [connection, publicKey, sendTransaction, rejectConcurrent],
  );

  /**
   * EVM transaction path (Ethereum + Base). Mirrors `send`: accepts one or more
   * `EvmBuildResult`s, submits each sequentially via wagmi's writeContract, and
   * waits for the receipt. A null `request` is treated the same way `send`
   * treats a null instruction — benign demo `mock` when VITE_USE_MOCKS, else a
   * surfaced build error. The connected EVM wallet is auto-switched to the
   * target chain when needed.
   */
  const sendEvm = useCallback(
    async (
      results: EvmBuildResult | EvmBuildResult[],
      options?: {
        onProgress?: (step: number, total: number) => void;
        successLabel?: string;
        quietMock?: boolean;
        /** Suppress success/error toasts (e.g. when a modal owns deploy feedback). */
        quietToast?: boolean;
      },
    ): Promise<SendState> => {
      const list = Array.isArray(results) ? results : [results];
      const { onProgress, successLabel, quietMock, quietToast } = options ?? {};

      const nullResult = list.find((r) => r.request === null);
      if (nullResult) {
        if (USE_MOCKS) {
          const mockState: SendState = { status: 'mock', txHash: null, error: nullResult.error || null };
          setState(mockState);
          if (!quietMock) {
            toast({ title: 'Demo mode', description: 'EVM contracts not configured — running in mock mode.' });
          }
          return mockState;
        }
        const buildError: SendState = {
          status: 'error',
          txHash: null,
          error: nullResult.error || 'Failed to build EVM transaction.',
        };
        setState(buildError);
        toast({ variant: 'destructive', title: 'Transaction failed', description: buildError.error! });
        return buildError;
      }

      const account = getAccount(wagmiConfig);
      if (!account.address) {
        const noWallet: SendState = { status: 'error', txHash: null, error: 'EVM wallet not connected' };
        setState(noWallet);
        toast({ variant: 'destructive', title: 'Wallet required', description: 'Connect an Ethereum/Base wallet to submit transactions.' });
        return noWallet;
      }

      if (inFlightRef.current) return rejectConcurrent();
      inFlightRef.current = true;
      try {
        setState({ status: 'signing', txHash: null, error: null });
        let lastHash = '';
        let lastChainId: EvmChainId = list[0].request!.chainId;

        for (let i = 0; i < list.length; i++) {
          onProgress?.(i + 1, list.length);
          const req = list[i].request!;
          lastChainId = req.chainId;

          // Ensure the wallet is on the target chain before writing.
          if (getAccount(wagmiConfig).chainId !== req.chainId) {
            await switchChain(wagmiConfig, { chainId: req.chainId });
          }

          setState((prev) => ({ ...prev, status: i === 0 ? 'signing' : 'confirming' }));

          // Pre-estimate gas and pass an explicit limit. Without this, some
          // wallets fall back to a huge gas limit that Base (OP-stack) and
          // Infura reject at submission with "gas limit too high" — even for a
          // ~130k-gas stake. A +25% buffer absorbs state drift between estimate
          // and inclusion.
          //
          // When estimation fails because the call itself REVERTS, sending
          // anyway is doomed: the wallet's fallback gas limit gets bounced by
          // the RPC ("gas limit too high"), burying the actual revert reason.
          // Surface the revert now instead. Only transport/RPC estimation
          // failures fall through to wallet estimation.
          let gas: bigint | undefined;
          try {
            const publicClient = getPublicClient(wagmiConfig, { chainId: req.chainId });
            if (publicClient) {
              const estimated = await publicClient.estimateContractGas({
                address: req.address,
                abi: req.abi,
                functionName: req.functionName,
                args: req.args as readonly unknown[],
                value: req.value,
                account: account.address,
              });
              gas = (estimated * 125n) / 100n;
            }
          } catch (estimateErr) {
            const estimateMsg = estimateErr instanceof Error ? estimateErr.message : String(estimateErr);
            if (/revert/i.test(estimateMsg)) throw estimateErr;
            gas = undefined;
          }

          const hash = await writeContract(wagmiConfig, {
            address: req.address,
            abi: req.abi,
            functionName: req.functionName,
            args: req.args as readonly unknown[],
            value: req.value,
            chainId: req.chainId,
            gas,
          });
          lastHash = hash;

          setState((prev) => ({ ...prev, status: 'confirming' }));
          // FN-H5: viem resolves (does not throw) once a transaction is mined,
          // even when it reverted on-chain — check the receipt status explicitly
          // so a reverted deposit/vote/activation isn't reported as a success.
          const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: req.chainId });
          if (receipt.status !== 'success') {
            throw new Error('Transaction reverted on-chain');
          }
        }

        const success: SendState = { status: 'success', txHash: lastHash, error: null };
        setState(success);
        if (!quietToast) {
          toast({
            title: successLabel ?? 'Transaction confirmed',
            description: lastHash ? `${lastHash.slice(0, 10)}…${lastHash.slice(-8)}` : 'Transaction confirmed on-chain.',
            action: lastHash ? evmExplorerAction(lastHash, lastChainId) : undefined,
          });
        }
        return success;
      } catch (err: unknown) {
        let msg = walletErrorMessage(err);
        const isRejection = isWalletRejection(err, msg);
        if (msg.length > 200) msg = msg.slice(0, 200) + '…';

        const errState: SendState = { status: 'error', txHash: null, error: msg };
        setState(errState);
        if (!quietToast) {
          toast({
            variant: 'destructive',
            title: isRejection ? 'Transaction cancelled' : 'Transaction failed',
            description: msg,
          });
        }
        return errState;
      } finally {
        inFlightRef.current = false;
      }
    },
    [rejectConcurrent],
  );

  return { ...state, chainKind, send, sendGrouped, sendEvm, reset };
}

/* ── Helper: Solscan explorer link as toast action ──────────── */
function toastExplorerAction(sig: string) {
  // We return a JSX element that the shadcn ToastAction expects.
  // The toast() call accepts `action?: ToastActionElement`, which is a
  // ReactElement<typeof ToastAction>.  To avoid importing the heavy
  // component here we use a lightweight anchor instead, which Radix
  // renders just fine inside the toast slot.
  const url = `${EXPLORER_BASE}/${sig}${explorerClusterSuffix()}`;

  // Return a plain JSX anchor styled as a toast action
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-secondary"
      style={{ fontSize: '12px', whiteSpace: 'nowrap' }}
    >
      View on Solscan
    </a>
  );
}

/* ── Helper: EVM explorer link as toast action (Etherscan/Basescan) ────────── */
function evmExplorerAction(hash: string, chainId: EvmChainId) {
  const url = `${EVM_EXPLORER_TX_BASE[chainId]}/${hash}`;
  const label =
    chainId === 8453 || chainId === 84532
      ? 'View on Basescan'
      : chainId === 4663 || chainId === 46630
        ? 'View on Blockscout'
        : 'View on Etherscan';
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-secondary"
      style={{ fontSize: '12px', whiteSpace: 'nowrap' }}
    >
      {label}
    </a>
  );
}
