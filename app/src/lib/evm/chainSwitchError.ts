/** Classify wallet chain-switch failures without depending on wagmi. */

export type ChainSwitchFailure = 'rejected' | 'pending' | 'missing' | 'mismatch' | 'other';

function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth += 1) {
    const obj = cur as {
      code?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      cause?: unknown;
      error?: unknown;
      data?: { originalError?: { code?: unknown; message?: unknown } };
    };
    if (typeof obj.code === 'number') parts.push(String(obj.code));
    if (typeof obj.message === 'string') parts.push(obj.message);
    if (typeof obj.shortMessage === 'string') parts.push(obj.shortMessage);
    const original = obj.data?.originalError;
    if (typeof original?.code === 'number') parts.push(String(original.code));
    if (typeof original?.message === 'string') parts.push(original.message);
    const next = obj.cause ?? obj.error;
    if (!next || next === cur) break;
    cur = next;
  }
  if (!parts.length && typeof err === 'string') parts.push(err);
  return parts.join(' ');
}

/** Pending requests win over 4902, because some wallets wrap -32002 as 4902. */
export function classifyChainSwitchError(err: unknown): ChainSwitchFailure {
  const text = errorText(err).toLowerCase();
  if (/4001|user rejected|user denied|rejected the request/.test(text)) return 'rejected';
  if (/-32002|already pending/.test(text)) return 'pending';
  if (/does not match the connection|connectorchainmismatch/.test(text)) return 'mismatch';
  if (/4902|unrecognized chain|has not been added|try adding the chain/.test(text)) return 'missing';
  return 'other';
}
