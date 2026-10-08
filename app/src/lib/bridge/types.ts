// ─── NAVE bridge types (trusted-relayer MVP) ─────────────────────────────────
// Shared shapes for the cross-chain NAVE bridge between Solana (home chain) and
// the supported EVM testnets. Raw token amounts are always `bigint` (NAVE base
// units, 6 decimals) — never `number` — to avoid precision loss.

import type { ChainFamily, EvmChainId } from '../chain/types';

/**
 * Bridge transfer direction:
 *  - `solana_to_evm` — lock NAVE on Solana, mint WrappedNave on EVM.
 *  - `evm_to_solana` — burn WrappedNave on EVM, release NAVE on Solana.
 */
export type BridgeDirection = 'solana_to_evm' | 'evm_to_solana';

/** A fully-resolved bridge route (source/destination families + EVM endpoint). */
export interface BridgeRoute {
  /** Source chain family. */
  from: ChainFamily;
  /** Destination chain family. */
  to: ChainFamily;
  /** Transfer direction implied by `from`/`to`. */
  direction: BridgeDirection;
  /** The EVM leg's chain id (Sepolia / Base Sepolia on testnet). */
  evmChainId: EvmChainId;
}

/**
 * A computed bridge quote for a 2.5%-on-top fee. The user enters `netRaw` (the
 * amount they want to bridge) and parts with `grossRaw = netRaw + feeRaw`. The
 * fee splits into three legs resolved on-chain.
 */
export interface BridgeQuote {
  /** Net amount the user wants to bridge / receives on the far side (base units). */
  netRaw: bigint;
  /** Gross the user parts with = net + fee (base units). */
  grossRaw: bigint;
  /** Total fee charged on top (base units). */
  feeRaw: bigint;
  /** Staking-pool leg (base units). */
  stakingRaw: bigint;
  /** Protocol-revenue leg (base units). */
  protocolRaw: bigint;
  /** Auto-burn leg (base units). */
  burnRaw: bigint;
  /** Total fee rate in basis points (mirrors NAVE_BRIDGE_FEE_BPS). */
  feeBps: number;
}

/**
 * Response from the relayer's `/bridge-relay` endpoint after it processes a
 * locked/burned source transaction and mints/releases on the destination chain.
 */
export interface BridgeRelayResponse {
  /** Relayer status string, e.g. `queued`, `submitted`, `confirmed`, `failed`. */
  status: string;
  /** Destination-chain tx hash/signature once the relayer has submitted it. */
  destTxHash?: string;
  /** Relayer-assigned identifier for tracking this transfer. */
  transferId?: string;
  /** Fee withheld, echoed back as a base-unit string. */
  feeRaw?: string;
  /** Net delivered, echoed back as a base-unit string. */
  netRaw?: string;
  /** Human-readable error when `status === 'failed'`. */
  error?: string;
  /** Numeric EVM chain id of the non-Solana side, echoed by the relayer (`evm_chain_id`). */
  evmChainId?: number;
  /** Source-tx confirmations observed so far (client poll while `status === 'confirming'`). */
  confirmationsCurrent?: number;
  /** Source-tx confirmations required before relay (EVM burn depth or Solana finality). */
  confirmationsRequired?: number;
}

/**
 * JSON payload POSTed to the relayer to request a destination-side mint/release.
 *
 * The destination recipient is now embedded IN the on-chain source transaction
 * (the nave_bridge `lock` instruction / WrappedNave `bridgeBurn`), so the
 * relayer derives it from the verified event and neither `recipient` nor a
 * separate `senderSignature` is required or trusted from the caller. Both are
 * retained as OPTIONAL for telemetry/backward compatibility only.
 */
export interface BridgeRelayPayload {
  direction: BridgeDirection;
  /**
   * CANONICAL route input: numeric EVM chain id of the non-Solana side —
   * `destChainId` for `solana_to_evm`, `sourceChainId` for `evm_to_solana`.
   * Family names are no longer resolved by the relayer (they were tied to a
   * single NAVE_EVM_NETWORK); always send the route's `evmChainId`.
   */
  destChainId?: EvmChainId;
  sourceChainId?: EvmChainId;
  /**
   * Route sides, still required by the relayer's HTTP layer: `'solana'` on the
   * Solana side and the numeric EVM chain id on the other (never a family name).
   */
  sourceChain: 'solana' | EvmChainId;
  destChain: 'solana' | EvmChainId;
  /** Source-chain tx signature (Solana) or tx hash (EVM) of the lock/burn. */
  sourceTx: string;
  /** Optional (telemetry): the recipient the user embedded on-chain. */
  recipient?: string;
  /** Optional (telemetry): the net amount as a base-unit string. */
  amountRaw?: string;
  /**
   * When true, ask the relayer to re-execute a transfer whose row already
   * exists in a non-completed state (bounded by retry_count on the server).
   */
  retry?: boolean;
}
