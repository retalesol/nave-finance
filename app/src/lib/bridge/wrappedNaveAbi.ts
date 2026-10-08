// ─── WrappedNave ABI (minimal, viem) ─────────────────────────────────────────
// The minimal surface the bridge frontend needs from the WrappedNave ERC-20 the
// sibling agent deploys on each EVM testnet. `burn(uint256)` burns the caller's
// own tokens; the relayer watches the `BridgeBurn` event and releases NAVE from
// Solana custody. `BridgeMint` is emitted when the relayer mints wrapped tokens.
// Declared `as const satisfies Abi` so viem infers fully-typed args/return
// values while staying assignable to the dispatcher's `EvmTxRequest.abi: Abi`.

import type { Abi } from 'viem';

export const wrappedNaveAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    // Outstanding wNAVE on this chain = all mints − all burns; the "Total
    // bridged" stat sums this across chains.
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'burn',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    // One-signature bridge-back: burns `amount` (gross = net + fee) and embeds
    // the 32-byte Solana recipient in the SAME tx, so the burn itself authorizes
    // the payout address (no separate off-chain recipient signature).
    type: 'function',
    name: 'bridgeBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'solanaRecipient', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    // For EVM-side staking: approve the NaveStaking mirror to pull wNAVE.
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'BridgeBurn',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'BridgeBurnTo',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'solanaRecipient', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'BridgeMint',
    inputs: [
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
] as const satisfies Abi;
