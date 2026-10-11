# Tokenomics & Bridge

What `$NAVE` (Nave Shares) does, how it is used in the protocol, and the state of the cross-chain bridge. The treasury yield fee and formation cost are covered in [Treasury Operations](/docs/treasury-operations).

## Nave Shares ($NAVE)

`$NAVE` is the protocol token. Three facts define it:

| Property | Value |
| --- | --- |
| Ticker | `$NAVE` |
| Max supply | Fixed at **500,000 $NAVE** |
| Launch | Fully fair launched — **no team allocation, no team supply** |
| Decimals | 6 |

There is no team or insider allocation carved out of supply, and no vesting schedule to track — distribution is open to the community from day one.

## What $NAVE is used for

| Use | Mechanics |
| --- | --- |
| **Vote** | Where a DAO enables token governance, $NAVE (or that DAO's own governance token) is the voting weight for proposals and treasury decisions. |
| **Bridge** | A designed path for moving $NAVE between Solana and EVM. The Solana program that accepted locks is closed. Do not use it in this beta. |

Forming a treasury is not a use of `$NAVE`. There is no protocol formation fee and no NAVE or wNAVE creation stake on any chain. The founder pays only network gas (and account rent). A founder may still deposit their own assets into the treasury as a seed. That deposit is their capital, not a fee.

An existing locked creation stake, from a treasury formed before this change, is still returned when that treasury moonlights. New treasuries have nothing to return. Reopening does not require a new stake. See [Treasury Operations](/docs/treasury-operations#winding-a-treasury-down-moonlighting).

The only protocol treasury fee is **15% of realized yield**: the gain above principal when a strategy position is withdrawn. Principal is not charged. Frozen treasuries use the same 15%. There is no annual management fee. Detail is in [Treasury Operations](/docs/treasury-operations).

Mainnet create stays refused while the closed Solana bridge cannot redeem locked NAVE for wNAVE. That refusal is about the closed bridge. It is not a creation stake. Testers do not use that path.

## The cross-chain bridge

Treasuries in this beta can be created on **Solana devnet**, **Ethereum Sepolia**, **Base Sepolia**, **Robinhood Testnet**, and **Arc Testnet**. `$NAVE` itself lives natively on Solana (an SPL token) and is represented on Ethereum and Base by **WrappedNAVE**, an ERC-20.

> **Status: do not use the closed Solana bridge.** Program `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6` cannot redeem locked NAVE for wNAVE. Do not broadcast a lock or a redeem against it. Mainnet create stays refused until a replacement bridge can redeem. The design below is a testnet trusted-relayer model. It is unaudited, and it is not a step in this beta. See [Product Maturity](/docs/product-maturity) and [Security & Trust](/docs/security-and-trust).

### How a transfer is designed

These steps describe the trusted-relayer design. They are not a beta procedure. Do not lock or redeem against `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`.

```
Solana → EVM                              EVM → Solana
─────────────                             ─────────────
1. User locks NAVE into a                 1. User burns WrappedNAVE on the
   Solana custody token account              EVM chain
2. Browser notifies the relayer           2. Browser notifies the relayer
3. Relayer independently re-verifies      3. Relayer independently re-verifies
   the lock on-chain                         the burn on-chain
4. Relayer mints WrappedNAVE to the       4. Relayer releases NAVE from
   destination address                       custody to the destination address
```

The relayer is "public-but-verifying": the browser never holds a privileged secret to call it. Instead, the relayer independently re-derives and checks the source-chain transaction before minting or releasing anything, and a unique constraint on the source transaction makes replays idempotent (the same lock/burn can never be paid out twice).

### Fees

The designed fee is **2.5%** (250 bps) on top of the bridged amount, split into staking, protocol, and burn legs. There is no separate relayer surcharge in that design. Testers should not pay it: the Solana bridge program is closed.

### Explicit destination, every time

The bridge form is built to require an explicit destination address before a signature, with a confirmation of the destination and the fee. It does not infer a recipient from the connected wallet. That form is not a path around the closed program. Do not sign a lock or a redeem to `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`.

### Pending transfers

Once the source-chain lock or burn confirms, the Bridge page shows a **pending** card immediately and polls for completion every 5 seconds — it does not wait for the relayer's full round trip to resolve before giving you feedback. The pending state is persisted locally, so refreshing the page or reconnecting your wallet resumes monitoring instead of losing track of an in-flight transfer.

## Testnet gas

Testers get gas from the site banner.

- **Network** selects Solana devnet, Ethereum Sepolia, Base Sepolia, Robinhood Testnet, or Arc Testnet, and asks an EVM wallet to add or switch chains. Solana Devnet opens Phantom’s devnet instructions.
- **Faucet** opens a QuickNode faucet for Solana devnet SOL, Ethereum Sepolia ETH, Base Sepolia ETH, or Robinhood Testnet ETH. Arc uses Circle’s faucet. Arc gas is native USDC (18 decimals). Treasury USDC on Arc is a separate 6-decimal token.

Solana creation needs testnet SOL for the transaction and for account rent. It does not need NAVE. The banner faucets supply gas. They are not a reason to lock NAVE in the closed bridge.

## Where to go next

- The treasury-level operating lifecycle, including DAO formation and wind-down: [Treasury Operations](/docs/treasury-operations).
- Architecture of the EVM contracts and the bridge/faucet relayer: [Architecture](/docs/architecture).
- Honest current limitations: [Product Maturity](/docs/product-maturity).
