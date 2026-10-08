/**
 * Central Anchor program-error-code + EVM revert-reason → human-readable
 * message mapping.
 *
 * Wallet adapters and RPC nodes frequently surface transaction failures as
 * raw hex/string blobs — e.g. `"custom program error: 0x1771"` for Solana,
 * or bare selector/revert data for EVM — instead of the descriptive message
 * the program actually defined. This utility recovers that message where
 * possible so users see "DAO is frozen" instead of "0x1771".
 *
 * NOTE (UX-3 scope): this is wired into a small number of high-traffic call
 * sites (see `Assets.tsx`'s asset-registration flow and `Tokens.tsx`'s
 * authority-revoke flow) as a demonstration, not a full rollout. Broader
 * adoption should replace ad-hoc `err.message` / `out.error` display at other
 * toast/inline-error call sites across the app (notably the shared
 * `useSendTransaction.tsx` `errorText()` path, intentionally left untouched
 * here since it is being modified concurrently by another workstream).
 */
import naveCoreIdl from '../idl/nave_core.json';
import naveGovernanceIdl from '../idl/nave_governance.json';
import naveExecutionIdl from '../idl/nave_execution.json';
import naveJitoIdl from '../idl/nave_jito_adapter.json';
import naveKaminoIdl from '../idl/nave_kamino_adapter.json';
import naveMarginfiIdl from '../idl/nave_marginfi_adapter.json';

export type NaveProgramName = 'core' | 'governance' | 'execution' | 'jito' | 'kamino' | 'marginfi';

interface IdlErrorEntry {
  code: number;
  name: string;
  msg: string;
}

function buildErrorMap(idl: unknown): Map<number, IdlErrorEntry> {
  const errors = (idl as { errors?: IdlErrorEntry[] }).errors ?? [];
  return new Map(errors.map((e) => [e.code, e]));
}

// Error codes are only unique *within* a program's IDL (e.g. code 6000 is
// "Global protocol is paused" in nave_core but "Unauthorized caller" in the
// adapter programs) — keep per-program tables rather than one flat map.
const PROGRAM_ERROR_TABLES: Record<NaveProgramName, Map<number, IdlErrorEntry>> = {
  core: buildErrorMap(naveCoreIdl),
  governance: buildErrorMap(naveGovernanceIdl),
  execution: buildErrorMap(naveExecutionIdl),
  jito: buildErrorMap(naveJitoIdl),
  kamino: buildErrorMap(naveKaminoIdl),
  marginfi: buildErrorMap(naveMarginfiIdl),
};

/** Stringify an error (including any attached simulation logs) for pattern matching. */
function errorToSearchableString(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const logs = (error as { logs?: unknown }).logs;
    const logsStr = Array.isArray(logs) ? logs.filter((l) => typeof l === 'string').join('\n') : '';
    return `${error.name}: ${error.message}\n${logsStr}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Extract a numeric Anchor custom-program-error code from raw error text, or null. */
function extractAnchorErrorCode(text: string): number | null {
  const hexMatch = text.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hexMatch) return parseInt(hexMatch[1], 16);
  const customJsonMatch = text.match(/"Custom":\s*(\d+)/);
  if (customJsonMatch) return parseInt(customJsonMatch[1], 10);
  const errorNumberMatch = text.match(/Error Number:\s*(\d+)/i);
  if (errorNumberMatch) return parseInt(errorNumberMatch[1], 10);
  return null;
}

/**
 * Resolve a Solana Anchor program error to its IDL-defined message.
 * Prefers an already-parsed `AnchorError.error.errorMessage` when present,
 * otherwise recovers the numeric code from the raw error/log text and looks
 * it up — trying `programHint`'s table first, then the rest, since most
 * transactions here are built against `nave_core`/`nave_governance`.
 */
export function getAnchorErrorMessage(error: unknown, programHint?: NaveProgramName): string | null {
  const anchorErrorMessage = (error as { error?: { errorMessage?: string } } | null | undefined)?.error
    ?.errorMessage;
  if (typeof anchorErrorMessage === 'string' && anchorErrorMessage) {
    return anchorErrorMessage;
  }

  const text = errorToSearchableString(error);
  const code = extractAnchorErrorCode(text);
  if (code == null) return null;

  const order: NaveProgramName[] = programHint
    ? [programHint, ...(Object.keys(PROGRAM_ERROR_TABLES) as NaveProgramName[]).filter((p) => p !== programHint)]
    : (Object.keys(PROGRAM_ERROR_TABLES) as NaveProgramName[]);

  for (const program of order) {
    const entry = PROGRAM_ERROR_TABLES[program].get(code);
    if (entry) return entry.msg;
  }
  return null;
}

const EVM_ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /user rejected|user denied|ACTION_REJECTED/i, message: 'You rejected the request in your wallet.' },
  { pattern: /insufficient funds/i, message: 'Insufficient funds to cover the transaction amount and gas.' },
  { pattern: /nonce too low|nonce has already been used/i, message: 'Transaction nonce is out of sync with your wallet — please retry.' },
  { pattern: /gas required exceeds allowance|out of gas|intrinsic gas too low/i, message: 'Transaction ran out of gas. Try increasing the gas limit.' },
  { pattern: /replacement transaction underpriced/i, message: 'A pending transaction is blocking this one — increase the gas price or wait for it to confirm.' },
  { pattern: /already known|nonce too low.*already in the pool/i, message: 'This transaction was already submitted — check your wallet for its status.' },
  { pattern: /execution reverted/i, message: 'The transaction was rejected by the contract (execution reverted).' },
];

/** Resolve a common EVM (viem/wagmi) revert reason to a human-readable message, or null. */
export function getEvmErrorMessage(error: unknown): string | null {
  const shortMessage = (error as { shortMessage?: unknown } | null | undefined)?.shortMessage;
  const reason = (error as { reason?: unknown } | null | undefined)?.reason;
  const candidate = typeof shortMessage === 'string' ? shortMessage : typeof reason === 'string' ? reason : null;
  if (candidate && !/^execution reverted\.?$/i.test(candidate.trim())) {
    return candidate;
  }

  const text = errorToSearchableString(error);
  for (const { pattern, message } of EVM_ERROR_PATTERNS) {
    if (pattern.test(text)) return message;
  }
  return null;
}

/**
 * Best-effort human-readable message for a failed Solana/EVM transaction or
 * RPC call. Tries, in order: (1) exact Anchor program error code lookup from
 * the embedded IDLs, (2) common EVM revert-reason patterns, (3) the error's
 * own message/string — so nothing is ever silently swallowed into a blank
 * toast, and known program errors show their real meaning instead of a hex
 * code.
 */
export function describeTransactionError(
  error: unknown,
  opts?: { programHint?: NaveProgramName; fallback?: string },
): string {
  const anchorMessage = getAnchorErrorMessage(error, opts?.programHint);
  if (anchorMessage) return anchorMessage;

  const evmMessage = getEvmErrorMessage(error);
  if (evmMessage) return evmMessage;

  if (typeof error === 'string' && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return opts?.fallback ?? 'Something went wrong. Please try again.';
}
