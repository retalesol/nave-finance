import { useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { formatUnits, getAddress } from 'viem';
import Fi from '../components/Fi';
import ConnectNetworkButton from '../components/ConnectNetworkButton';
import NaveModal from '../components/NaveModal';
import { Notice } from '../components/calm';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../components/ui/tooltip';
import { useBridge } from '../hooks/useBridge';
import { useDaoContext } from '../hooks/useDaoContext';
import { evmTarget, type EvmChainId } from '../lib/chain/types';
import {
  NAVE_BRIDGE_BURN_BPS,
  NAVE_BRIDGE_ENABLED,
  NAVE_BRIDGE_PROTOCOL_BPS,
  NAVE_BRIDGE_STAKING_BPS,
  NAVE_DECIMALS,
} from '../lib/programConfig';

/** Format a NAVE base-unit amount for display (trim trailing zeros). */
function formatNave(raw: bigint): string {
  const s = formatUnits(raw, NAVE_DECIMALS);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Display form of a bps value as a percentage string (e.g. 100 → "1%"). */
function bpsPct(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid hsl(var(--border))',
  backgroundColor: '#ffffff',
  borderRadius: '10px',
  padding: '11px 13px',
  fontSize: '14.5px',
  color: 'hsl(var(--foreground))',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '12.5px',
  fontWeight: 600,
  color: 'hsl(var(--foreground))',
  marginBottom: '7px',
};

/* ── Bridge Form ─────────────────────────────────────────────── */
export default function Bridge() {
  const {
    supportedRoutes,
    direction,
    setDirection,
    evmChainId,
    setEvmChainId,
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
    bridge,
  } = useBridge();

  const { isMockMode } = useDaoContext();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mockStarted, setMockStarted] = useState(false);

  const { publicKey } = useWallet();
  const { address: evmAddress } = useAccount();

  // Unique EVM endpoints among the supported routes (Sepolia / Base Sepolia /
  // Robinhood Testnet — mainnets on a mainnet deployment).
  const evmChoices = useMemo(() => {
    const ids = new Set<EvmChainId>();
    for (const r of supportedRoutes) ids.add(r.evmChainId);
    return Array.from(ids);
  }, [supportedRoutes]);

  const isSolToEvm = direction === 'solana_to_evm';
  const sourceBalance = isSolToEvm ? solanaNaveBalance : evmWrappedBalance;
  const sourceLabel = isSolToEvm ? 'NAVE (Solana)' : 'wNAVE (EVM)';
  const sourceToken = isSolToEvm ? 'NAVE' : 'wNAVE';
  const destToken = isSolToEvm ? 'wNAVE' : 'NAVE';

  const solanaConnected = !!publicKey;
  const evmConnected = !!evmAddress;
  const signerReady = isMockMode || (isSolToEvm ? solanaConnected : evmConnected);

  const amountRaw = quote.netRaw;
  const insufficient =
    !isMockMode && sourceBalance !== null && quote.grossRaw > 0n && quote.grossRaw > sourceBalance;

  const feePct = bpsPct(quote.feeBps);
  const evmLabel = evmChainId !== null ? evmTarget(evmChainId).label : 'Base';

  const checksumSuspect = useMemo(() => {
    if (!isSolToEvm || !isDestinationValid) return false;
    const trimmed = destination.trim();
    const body = trimmed.slice(2);
    if (body === body.toLowerCase() || body === body.toUpperCase()) return false;
    try {
      getAddress(trimmed);
      return false;
    } catch {
      return true;
    }
  }, [isSolToEvm, isDestinationValid, destination]);

  const destinationWalletKnown = isSolToEvm ? evmConnected : solanaConnected;
  const destinationIsOwnWallet = isSolToEvm
    ? !!evmAddress && destination.trim().toLowerCase() === evmAddress.toLowerCase()
    : !!publicKey && destination.trim() === publicKey.toBase58();

  const canBridge =
    isMockMode
      ? amountRaw > 0n && !isBridging
      : NAVE_BRIDGE_ENABLED &&
        !!route &&
        amountRaw > 0n &&
        signerReady &&
        isDestinationValid &&
        !insufficient &&
        !isBridging;

  function handleMax() {
    if (sourceBalance && sourceBalance > 0n) {
      setAmount(formatNave(sourceBalance));
    } else if (isMockMode) {
      setAmount('5000');
    }
  }

  function handleSwapDirection() {
    setDirection(isSolToEvm ? 'evm_to_solana' : 'solana_to_evm');
  }

  function handleConfirmBridge() {
    setConfirmOpen(false);
    if (isMockMode && (!NAVE_BRIDGE_ENABLED || !signerReady || !isDestinationValid)) {
      setMockStarted(true);
      return;
    }
    void bridge();
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canBridge) return;
    if (isMockMode && !destination.trim()) {
      setMockStarted(true);
      return;
    }
    setConfirmOpen(true);
  }

  return (
    <div className="space-y-4 w-full">
      {/* Not-configured notice (only when not in demo mode) */}
      {!NAVE_BRIDGE_ENABLED && !isMockMode && (
        <Notice tone="brass">
          <strong style={{ fontWeight: 600 }}>Bridge not configured for this environment.</strong>{' '}
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>
            Set the relayer URL and the Solana custody account to enable the NAVE bridge.
          </span>
        </Notice>
      )}

      {NAVE_BRIDGE_ENABLED && supportedRoutes.length === 0 && !isMockMode && (
        <Notice tone="muted">
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>
            No wNAVE contracts are configured for the active EVM network yet.
          </span>
        </Notice>
      )}

      <form onSubmit={handleFormSubmit} className="space-y-4">
        {/* From / To network dropdowns */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="bridge-from" style={labelStyle}>
              From
            </label>
            {isSolToEvm ? (
              <select
                id="bridge-from"
                value="solana"
                onChange={(e) => {
                  if (e.target.value !== 'solana') {
                    setEvmChainId(Number(e.target.value) as EvmChainId);
                    setDirection('evm_to_solana');
                  }
                }}
                style={inputStyle}
              >
                <option value="solana">Solana</option>
                {evmChoices.map((id) => (
                  <option key={id} value={String(id)}>
                    {evmTarget(id).label}
                  </option>
                ))}
              </select>
            ) : (
              <select
                id="bridge-from"
                value={evmChainId !== null ? String(evmChainId) : ''}
                onChange={(e) => {
                  if (e.target.value === 'solana') {
                    setDirection('solana_to_evm');
                  } else {
                    setEvmChainId(Number(e.target.value) as EvmChainId);
                  }
                }}
                style={inputStyle}
              >
                {evmChoices.map((id) => (
                  <option key={id} value={String(id)}>
                    {evmTarget(id).label}
                  </option>
                ))}
                <option value="solana">Solana</option>
              </select>
            )}
          </div>

          <div>
            <label htmlFor="bridge-to" style={labelStyle}>
              To
            </label>
            {isSolToEvm ? (
              <select
                id="bridge-to"
                value={evmChainId !== null ? String(evmChainId) : ''}
                onChange={(e) => {
                  if (e.target.value === 'solana') {
                    setDirection('evm_to_solana');
                  } else {
                    setEvmChainId(Number(e.target.value) as EvmChainId);
                  }
                }}
                style={inputStyle}
              >
                {evmChoices.map((id) => (
                  <option key={id} value={String(id)}>
                    {evmTarget(id).label}
                  </option>
                ))}
                {evmChoices.length === 0 && <option value="">Base</option>}
                <option value="solana">Solana</option>
              </select>
            ) : (
              <select
                id="bridge-to"
                value="solana"
                onChange={(e) => {
                  if (e.target.value !== 'solana') {
                    setEvmChainId(Number(e.target.value) as EvmChainId);
                    setDirection('solana_to_evm');
                  }
                }}
                style={inputStyle}
              >
                <option value="solana">Solana</option>
                {evmChoices.map((id) => (
                  <option key={id} value={String(id)}>
                    {evmTarget(id).label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Swap direction text link */}
        <div className="text-center" style={{ margin: '-4px 0 8px' }}>
          <button
            type="button"
            onClick={handleSwapDirection}
            className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
            style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}
          >
            ⇅ Swap direction
          </button>
        </div>

        {/* Amount */}
        <div>
          <div className="flex items-center justify-between" style={{ marginBottom: '7px' }}>
            <label htmlFor="bridge-amount" style={{ ...labelStyle, marginBottom: 0 }}>
              Amount ({sourceToken})
            </label>
            <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
              <span>
                Balance:{' '}
                <span className="nave-mono">
                  {sourceBalance === null ? (isMockMode ? '12,500' : '—') : formatNave(sourceBalance)}
                </span>{' '}
                {sourceLabel}
              </span>
              <button
                type="button"
                onClick={handleMax}
                disabled={!isMockMode && (!sourceBalance || sourceBalance === 0n)}
                className="hover:underline underline-offset-4 bg-transparent border-0 cursor-pointer"
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: 'hsl(var(--foreground))',
                  opacity: !isMockMode && (!sourceBalance || sourceBalance === 0n) ? 0.4 : 1,
                }}
                aria-label={`Use full ${sourceLabel} balance`}
              >
                Max
              </button>
            </div>
          </div>

          <input
            id="bridge-amount"
            value={amount}
            onChange={(e) => {
              setMockStarted(false);
              setAmount(e.target.value);
            }}
            placeholder="0.0"
            inputMode="decimal"
            aria-invalid={insufficient || undefined}
            aria-describedby={insufficient ? 'bridge-amount-error' : undefined}
            style={{
              ...inputStyle,
              fontFamily: 'var(--font-mono)',
              borderColor: insufficient ? 'hsl(var(--destructive))' : 'hsl(var(--border))',
            }}
          />

          {insufficient && (
            <p id="bridge-amount-error" role="alert" style={{ fontSize: '12px', color: 'hsl(var(--destructive))', marginTop: '6px' }}>
              Amount plus the {feePct} fee exceeds your {sourceLabel} balance
              {sourceBalance !== null ? ` of ${formatNave(sourceBalance)}` : ''}.
            </p>
          )}
        </div>

        {/* Destination address */}
        <div>
          <label htmlFor="bridge-destination" style={labelStyle}>
            {isSolToEvm ? `Destination ${evmLabel} address` : 'Destination Solana address'}
          </label>
          <input
            id="bridge-destination"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder={isSolToEvm ? '0x…' : 'Solana wallet address'}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={(destination.trim() !== '' && !isDestinationValid) || undefined}
            aria-describedby={
              destination.trim() && !isDestinationValid
                ? 'bridge-destination-error'
                : 'bridge-destination-hint'
            }
            style={{
              ...inputStyle,
              fontFamily: 'var(--font-mono)',
            }}
          />
          {destination.trim() && !isDestinationValid && (
            <p id="bridge-destination-error" role="alert" style={{ fontSize: '12px', color: 'hsl(var(--destructive))', marginTop: '6px' }}>
              {isSolToEvm
                ? 'This is not a valid Ethereum/Base address — expected 0x followed by 40 hex characters.'
                : 'This is not a valid Solana address — expected a base58 wallet address (32–44 characters).'}
            </p>
          )}
          {checksumSuspect && (
            <p role="alert" style={{ fontSize: '12px', color: 'hsl(38 60% 35%)', marginTop: '6px' }}>
              This address fails its EIP-55 checksum — one or more characters may be mistyped.
              Re-copy it from the destination wallet before bridging.
            </p>
          )}
          <p id="bridge-destination-hint" style={{ fontSize: '12px', color: 'hsl(var(--faint))', marginTop: '6px', lineHeight: 1.5 }}>
            {isSolToEvm
              ? `${destToken} is minted to this address — double-check it before bridging.`
              : `${destToken} is released to this address — double-check it before bridging.`}
          </p>
        </div>

        {/* Live Quote Notebox */}
        <div
          style={{
            backgroundColor: 'hsl(var(--background))',
            border: '1px solid hsl(var(--surface-2))',
            borderRadius: '12px',
            padding: '13px 14px',
            fontSize: '13px',
            color: 'hsl(var(--muted-foreground))',
            lineHeight: 1.6,
          }}
        >
          <div>
            You receive ≈{' '}
            <b className="nave-mono" style={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}>
              {formatNave(quote.netRaw)} {destToken}
            </b>{' '}
            on {isSolToEvm ? evmLabel : 'Solana'} ·{' '}
            <span className="inline-flex items-center gap-1">
              fee{' '}
              <span className="nave-mono" style={{ color: 'hsl(var(--foreground))' }}>
                {formatNave(quote.feeRaw)} {sourceToken}
              </span>{' '}
              ({feePct})
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="How the bridge fee is split"
                      className="inline-flex items-center"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'help', color: 'hsl(var(--muted-foreground))' }}
                    >
                      <Fi icon="circle-info" style={{ fontSize: 11 }} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" style={{ maxWidth: 260, fontSize: 12, lineHeight: 1.5 }}>
                    The {feePct} fee is split on-chain: {bpsPct(NAVE_BRIDGE_STAKING_BPS)} to NAVE
                    stakers, {bpsPct(NAVE_BRIDGE_PROTOCOL_BPS)} to the protocol treasury, and{' '}
                    {bpsPct(NAVE_BRIDGE_BURN_BPS)} burned.
                    {quote.feeRaw > 0n && (
                      <>
                        {' '}For this transfer: {formatNave(quote.stakingRaw)} / {formatNave(quote.protocolRaw)} /{' '}
                        {formatNave(quote.burnRaw)} {sourceToken}.
                      </>
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>{' '}
            · total you pay{' '}
            <b className="nave-mono" style={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}>
              {formatNave(quote.grossRaw)} {sourceToken}
            </b>
          </div>
        </div>

        {mockStarted && (
          <div
            className="text-center pt-4"
            style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
          >
            <div
              className="mx-auto grid place-items-center rounded-full"
              style={{
                width: '40px',
                height: '40px',
                border: '1px solid #BFE0CC',
                backgroundColor: '#F2F9F4',
                color: 'hsl(var(--success))',
                fontSize: '18px',
                marginBottom: '10px',
              }}
            >
              ✓
            </div>
            <h4
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 400,
                fontSize: '22px',
                margin: '0 0 6px',
                color: 'hsl(var(--foreground))',
              }}
            >
              Bridge started
            </h4>
            <p style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))', margin: 0 }}>
              Your transfer is on its way and will appear in recent transfers below when it lands.
            </p>
          </div>
        )}

        {/* Connect prompt (when not in demo mode and signer not connected) */}
        {NAVE_BRIDGE_ENABLED && supportedRoutes.length > 0 && !signerReady && (
          <ConnectNetworkButton
            fullWidth
            menuAlign="left"
            label="Connect wallet to bridge"
            icon={<Fi icon="wallet" style={{ fontSize: 12 }} />}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-[9px] font-semibold"
            style={{
              fontSize: '13px',
              backgroundColor: '#ffffff',
              color: 'hsl(var(--foreground))',
              border: '1px solid hsl(var(--border))',
            }}
          />
        )}

        {/* Actions */}
        <div
          className="flex items-center justify-end gap-2 pt-4"
          style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
        >
          <button
            type="submit"
            disabled={!canBridge}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--foreground))',
              color: '#ffffff',
              border: '1px solid hsl(var(--foreground))',
              opacity: canBridge ? 1 : 0.4,
              cursor: canBridge ? 'pointer' : 'not-allowed',
            }}
          >
            {isBridging ? 'Bridging…' : 'Review bridge →'}
          </button>
        </div>
      </form>

      {/* Confirmation modal */}
      <NaveModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm bridge transfer"
        subtitle="Double-check the destination address. This cannot be undone once signed."
        maxWidth={480}
      >
        <div style={{ padding: '18px 22px 22px' }} className="space-y-4">
          <div style={{ borderTop: '1px solid hsl(var(--surface-2))' }}>
            <div className="flex items-center justify-between py-2.5" style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: '13px' }}>
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>Route</span>
              <b style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                {isSolToEvm ? `Solana → ${evmLabel}` : `${evmLabel} → Solana`}
              </b>
            </div>
            <div className="flex items-center justify-between py-2.5" style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: '13px' }}>
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>Total you pay (incl. {feePct} fee)</span>
              <b className="nave-mono" style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                {formatNave(quote.grossRaw)} {sourceToken}
              </b>
            </div>
            <div className="flex items-center justify-between py-2.5" style={{ borderBottom: '1px solid hsl(var(--surface-2))', fontSize: '13px' }}>
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>Recipient receives</span>
              <b className="nave-mono" style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                {formatNave(quote.netRaw)} {destToken}
              </b>
            </div>
          </div>

          <div className="space-y-1.5">
            <span style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))' }}>
              Destination ({isSolToEvm ? evmLabel : 'Solana'})
            </span>
            <p
              className="nave-mono break-all"
              style={{
                fontSize: '12.5px',
                padding: '10px 12px',
                borderRadius: '10px',
                backgroundColor: 'hsl(var(--background))',
                border: '1px solid hsl(var(--border))',
                margin: 0,
              }}
            >
              {destination.trim() || (isSolToEvm ? '0x0000…0000' : 'Solana treasury')}
            </p>
            {destinationWalletKnown && !destinationIsOwnWallet && (
              <p
                className="flex items-start gap-1.5"
                style={{ fontSize: '12px', color: 'hsl(38 60% 35%)', lineHeight: 1.5, margin: 0 }}
              >
                <Fi icon="triangle-exclamation" style={{ fontSize: 10, flexShrink: 0, marginTop: 4 }} />
                This is not your connected {isSolToEvm ? evmLabel : 'Solana'} wallet address —
                make sure the recipient is intentional.
              </p>
            )}
          </div>

          <div
            className="flex items-center justify-end gap-2 pt-4"
            style={{ borderTop: '1px solid hsl(var(--surface-2))' }}
          >
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="px-3.5 py-2 rounded-[9px] border font-semibold"
              style={{
                fontSize: '13px',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmBridge}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[9px] font-semibold"
              style={{
                fontSize: '13px',
                backgroundColor: 'hsl(var(--foreground))',
                color: '#ffffff',
              }}
            >
              Confirm &amp; sign
            </button>
          </div>
        </div>
      </NaveModal>
    </div>
  );
}
