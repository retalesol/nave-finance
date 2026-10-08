import { useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount } from 'wagmi';
import { formatUnits, getAddress } from 'viem';
import Fi from '../components/Fi';
import ConnectNetworkButton from '../components/ConnectNetworkButton';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../components/ui/tooltip';
import { useBridge } from '../hooks/useBridge';
import { evmTarget, type EvmChainId } from '../lib/chain/types';
import {
  NAVE_BRIDGE_BURN_BPS,
  NAVE_BRIDGE_ENABLED,
  NAVE_BRIDGE_PROTOCOL_BPS,
  NAVE_BRIDGE_STAKING_BPS,
  NAVE_DECIMALS,
} from '../lib/programConfig';
import type { BridgeDirection } from '../lib/bridge/types';

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

/* ── Bridge Page ─────────────────────────────────────────────── */
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

  const [confirmOpen, setConfirmOpen] = useState(false);

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
  // The token the user parts with lives on the SOURCE chain (NAVE on Solana,
  // wNAVE on EVM); the recipient always receives the token native to the
  // DESTINATION chain (wNAVE on EVM, NAVE on Solana).
  const sourceToken = isSolToEvm ? 'NAVE' : 'wNAVE';
  const destToken = isSolToEvm ? 'wNAVE' : 'NAVE';

  const solanaConnected = !!publicKey;
  const evmConnected = !!evmAddress;
  // Only the SOURCE wallet needs to be connected — it has to sign the lock/burn.
  // The recipient is always the explicit `destination` field below, never an
  // implicitly (and possibly silently auto-reconnected) connected wallet.
  const signerReady = isSolToEvm ? solanaConnected : evmConnected;

  // The user enters the amount they want to bridge (net); they part with the
  // gross (net + on-top fee), so balance is checked against the gross.
  const amountRaw = quote.netRaw;
  const insufficient =
    sourceBalance !== null && quote.grossRaw > 0n && quote.grossRaw > sourceBalance;

  // Fee percent derived from the configured bps so copy can never drift from
  // the quote math (which mirrors the on-chain fee config).
  const feePct = bpsPct(quote.feeBps);

  // Label of the currently selected EVM endpoint ("Ethereum Sepolia", …).
  const evmLabel = evmChainId !== null ? evmTarget(evmChainId).label : 'EVM network';

  // Non-blocking EIP-55 checksum check. A mixed-case 0x address that fails its
  // checksum is very likely a typo or corrupted paste; all-lowercase (or
  // all-uppercase) input carries no checksum, so nothing can be verified there.
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

  // Whether the destination matches the user's own connected wallet on the
  // destination side — used to surface a "third-party recipient" caution in the
  // confirmation dialog. Only meaningful when that wallet is connected.
  const destinationWalletKnown = isSolToEvm ? evmConnected : solanaConnected;
  const destinationIsOwnWallet = isSolToEvm
    ? !!evmAddress && destination.trim().toLowerCase() === evmAddress.toLowerCase()
    : !!publicKey && destination.trim() === publicKey.toBase58();

  const canBridge =
    NAVE_BRIDGE_ENABLED &&
    !!route &&
    amountRaw > 0n &&
    signerReady &&
    isDestinationValid &&
    !insufficient &&
    !isBridging;

  function handleMax() {
    if (sourceBalance && sourceBalance > 0n) setAmount(formatNave(sourceBalance));
  }

  function handleConfirmBridge() {
    setConfirmOpen(false);
    void bridge();
  }

  return (
    <div className="space-y-4 w-full h-full">
      {/* Not-configured notice */}
      {!NAVE_BRIDGE_ENABLED && (
        <div
          className="flex items-start gap-2.5 p-4 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--warning-muted))', borderColor: 'hsl(var(--border))' }}
        >
          <Fi icon="triangle-exclamation" style={{ fontSize: 14, color: 'hsl(38 60% 35%)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: '12.5px', color: 'hsl(38 60% 35%)', lineHeight: 1.6 }}>
            <strong>Bridge not configured for this environment.</strong>
            <br />
            Set the relayer URL and the Solana custody account to enable the NAVE bridge.
          </div>
        </div>
      )}

      {/* No routes notice (enabled but no wrapped tokens) */}
      {NAVE_BRIDGE_ENABLED && supportedRoutes.length === 0 && (
        <div
          className="flex items-start gap-2.5 p-4 rounded-xl border"
          style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
        >
          <Fi icon="circle-info" style={{ fontSize: 14, color: 'hsl(var(--muted-foreground))', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>
            No wNAVE contracts are configured for the active EVM network yet. Configure a wNAVE
            address for Sepolia or Base Sepolia to enable bridging.
          </div>
        </div>
      )}

      {/* Direction toggle */}
      <Tabs value={direction} onValueChange={(v) => setDirection(v as BridgeDirection)}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="solana_to_evm">Solana → EVM</TabsTrigger>
          <TabsTrigger value="evm_to_solana">EVM → Solana</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Main card */}
      <div
        className="rounded-xl border p-5 space-y-5"
        style={{ backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))' }}
      >
        <div
          className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 border"
          style={{
            backgroundColor: 'hsl(var(--warning-muted))',
            borderColor: 'hsl(38 92% 75%)',
          }}
          role="status"
        >
          <Fi
            icon="triangle-exclamation"
            style={{ fontSize: 13, color: 'hsl(var(--warning))', flexShrink: 0, marginTop: 2 }}
          />
          <p style={{ fontSize: 12, color: 'hsl(38 60% 35%)', lineHeight: 1.55 }}>
            <strong style={{ fontWeight: 600 }}>Beta.</strong> Bridge &amp; Stake is an early
            release. Use at your own risk until independent security audits are complete.
            Only bridge amounts you can afford to lose.
          </p>
        </div>

        {/* EVM chain selector */}
        <div className="space-y-1.5">
          <label htmlFor="bridge-network" className="nave-label" style={{ fontSize: 12, fontWeight: 500, color: 'hsl(var(--foreground))' }}>
            {isSolToEvm ? 'Destination network' : 'Source network'}
          </label>
          <Select
            value={evmChainId !== null ? String(evmChainId) : undefined}
            onValueChange={(v) => setEvmChainId(Number(v) as EvmChainId)}
            disabled={evmChoices.length === 0}
          >
            <SelectTrigger id="bridge-network">
              <SelectValue placeholder="Select an EVM network" />
            </SelectTrigger>
            <SelectContent>
              {evmChoices.map((id) => (
                <SelectItem key={id} value={String(id)}>
                  {evmTarget(id).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Amount */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="bridge-amount" className="nave-label" style={{ fontSize: 12, fontWeight: 500, color: 'hsl(var(--foreground))' }}>
              Amount
            </label>
            <span style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))' }}>
              Balance:{' '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {sourceBalance === null ? '—' : formatNave(sourceBalance)}
              </span>{' '}
              {sourceLabel}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="bridge-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              inputMode="decimal"
              aria-invalid={insufficient || undefined}
              aria-describedby={insufficient ? 'bridge-amount-error' : undefined}
              style={{ fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleMax}
              disabled={!sourceBalance || sourceBalance === 0n}
              aria-label={`Use full ${sourceLabel} balance`}
            >
              Max
            </Button>
          </div>
          {insufficient && (
            <p id="bridge-amount-error" role="alert" style={{ fontSize: 12, color: 'hsl(var(--destructive))' }}>
              Amount plus the {feePct} fee exceeds your {sourceLabel} balance
              {sourceBalance !== null ? ` of ${formatNave(sourceBalance)}` : ''}.
            </p>
          )}
        </div>

        {/* Destination address — always explicit, never silently inferred from
            whatever wallet happens to be auto-connected. */}
        <div className="space-y-1.5">
          <label htmlFor="bridge-destination" className="nave-label" style={{ fontSize: 12, fontWeight: 500, color: 'hsl(var(--foreground))' }}>
            {isSolToEvm ? `Destination ${evmLabel} address` : 'Destination Solana address'}
          </label>
          <Input
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
            style={{ fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--surface-0))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
          />
          {destination.trim() && !isDestinationValid && (
            <p id="bridge-destination-error" role="alert" style={{ fontSize: 12, color: 'hsl(var(--destructive))' }}>
              {isSolToEvm
                ? 'This is not a valid Ethereum/Base address — expected 0x followed by 40 hex characters.'
                : 'This is not a valid Solana address — expected a base58 wallet address (32–44 characters).'}
            </p>
          )}
          {checksumSuspect && (
            <p role="alert" style={{ fontSize: 12, color: 'hsl(38 60% 35%)' }}>
              This address fails its EIP-55 checksum — one or more characters may be mistyped.
              Re-copy it from the destination wallet before bridging.
            </p>
          )}
          <p id="bridge-destination-hint" style={{ fontSize: 11.5, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
            {isSolToEvm
              ? 'wNAVE is minted to this address — double-check it before bridging.'
              : 'NAVE is released to this address — double-check it before bridging.'}
          </p>
        </div>

        {/* Quote panel */}
        <div
          className="rounded-lg p-4 space-y-2"
          style={{ backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
        >
          <div className="flex items-center justify-between">
            <span style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>You bridge</span>
            <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono)' }}>
              {formatNave(quote.netRaw)} {sourceToken}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5" style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>
              Bridge fee ({feePct})
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
            </span>
            <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono)' }}>
              {formatNave(quote.feeRaw)} {sourceToken}
            </span>
          </div>
          <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--foreground))' }}>Total you pay</span>
            <span className="text-display font-semibold" style={{ fontSize: 14, color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono)' }}>
              {formatNave(quote.grossRaw)} {sourceToken}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>Recipient receives</span>
            <span style={{ fontSize: 12.5, color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              {formatNave(quote.netRaw)} {destToken}
            </span>
          </div>
          <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5, paddingTop: 4 }}>
            The {feePct} fee is charged on top of the amount you bridge. One signature completes
            the bridge — the recipient is embedded in your transaction.
          </p>
        </div>

        {/* Connect prompt — pick network first, then the matching wallet modal */}
        {NAVE_BRIDGE_ENABLED && supportedRoutes.length > 0 && !signerReady && (
          <ConnectNetworkButton
            fullWidth
            menuAlign="left"
            label="Connect wallet to bridge"
            icon={<Fi icon="wallet" style={{ fontSize: 12 }} />}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium"
            style={{ fontSize: 13, backgroundColor: 'hsl(var(--surface-1))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border-strong))' }}
          />
        )}

        {/* Bridge button — opens a confirmation dialog before signing anything */}
        <Button
          className="w-full"
          onClick={() => setConfirmOpen(true)}
          disabled={!canBridge}
          style={{ backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
        >
          {isBridging ? (
            'Bridging…'
          ) : (
            <>
              <Fi icon="right-left" style={{ fontSize: 12 }} />
              {isSolToEvm ? 'Lock NAVE & bridge' : 'Burn wNAVE & bridge'}
            </>
          )}
        </Button>
      </div>

      {/* Confirmation dialog — surfaces the exact destination + fee breakdown
          before anything is signed, so the recipient is always a deliberate,
          visible choice rather than whatever wallet happens to be connected. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm bridge transfer</DialogTitle>
            <DialogDescription>
              Double-check the destination address. This cannot be undone once signed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-center justify-between">
              <span style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>Route</span>
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>
                {isSolToEvm ? `Solana → ${evmLabel}` : `${evmLabel} → Solana`}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>Total you pay (incl. {feePct} fee)</span>
              <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{formatNave(quote.grossRaw)} {sourceToken}</span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>Recipient receives</span>
              <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{formatNave(quote.netRaw)} {destToken}</span>
            </div>
            <div className="space-y-1">
              <span style={{ fontSize: 12.5, color: 'hsl(var(--muted-foreground))' }}>
                Destination ({isSolToEvm ? evmLabel : 'Solana'})
              </span>
              <p
                className="rounded-lg p-2.5 break-all"
                style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', backgroundColor: 'hsl(var(--surface-1))', border: '1px solid hsl(var(--border))' }}
              >
                {destination.trim()}
              </p>
              {destinationWalletKnown && !destinationIsOwnWallet && (
                <p
                  className="flex items-start gap-1.5"
                  style={{ fontSize: 11.5, color: 'hsl(38 60% 35%)', lineHeight: 1.5 }}
                >
                  <Fi icon="triangle-exclamation" style={{ fontSize: 10, flexShrink: 0, marginTop: 3 }} />
                  This is not your connected {isSolToEvm ? evmLabel : 'Solana'} wallet address —
                  make sure the recipient is intentional.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmBridge} style={{ backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}>
              <Fi icon="right-left" style={{ fontSize: 12 }} />
              Confirm &amp; sign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The in-flight / most-recent transfer is now surfaced as the top row of
          "Your Transactions" (see TransactionsFeed) instead of a separate box
          here, so its status transitions (confirming → pending → confirmed)
          read as a single timeline. */}
    </div>
  );
}
