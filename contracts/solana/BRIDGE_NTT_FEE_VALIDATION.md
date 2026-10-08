# Wormhole NTT Fee Validation

Scope: foundation validation for the NAVE bridge build. This does not deploy NTT managers, wrapped ERC-20s, or app bridge UI.

## Decision

Use Wormhole NTT with the Executor route for the first bridge implementation, provided the build uses the current Executor/Connect path that exposes referrer fees. The current docs state that `nttExecutorRoute` replaces the deprecated Standard Relayer route for NTT and provides one-click transfers with native gas drop-off and referrer fees.

The bare `@wormhole-foundation/sdk` NTT examples found in the current docs cover quote/attest/transfer mechanics, but did not expose a typed referrer-fee argument in the simple NTT helper example. Treat the referrer fee as validated for the Executor/Connect route, not for an arbitrary custom NTT SDK call path.

## Fee Shape

Wormhole Executor fee docs define:

```solidity
struct FeeArgs {
    uint16 dbps; // tenths of basis points
    address payee;
}
```

For Nave:

- Bridge/referrer fee: `2%`
- Basis points: `200`
- Executor `dbps`: `2000`
- Payee: Nave-controlled EVM fee wallet, configured per environment before live bridge transfers.

Run:

```bash
npm run bridge:validate-fee
```

Optional override:

```bash
NAVE_BRIDGE_FEE_BPS=200 \
NAVE_BRIDGE_FEE_DBPS=2000 \
NAVE_BRIDGE_REFERRER_FEE_PAYEE_EVM=0x0000000000000000000000000000000000000001 \
npm run bridge:validate-fee
```

## Dependency Notes For Bridge Build

The app bridge build should select the Wormhole route/dependencies that expose `nttExecutorRoute` and Executor referrer-fee configuration, expected from the `@wormhole-foundation/wormhole-connect` NTT entrypoint plus the current Wormhole TypeScript SDK stack. If the team chooses a fully custom SDK flow instead of Wormhole Connect routing, re-run this validation against the installed package exports and signed quote request shape before committing to Wormhole for the 2% fee.

If installed SDK exports do not expose the payee/referrer fee path for NTT Executor transfers, use the trusted-relayer MVP on testnet only and keep 2% fee capture in the relayer-controlled transfer/mint logic until the Wormhole route is upgraded or wrapped.

## Sources Checked

- Wormhole docs: NTT Executor integration, signed quote flow, and Executor-vs-Standard-Relayer migration guidance.
- Wormhole docs: `FeeArgs` structure for Executor helper contracts (`dbps`, `payee`).
- Wormhole TypeScript SDK docs: token transfer quote/initiate examples and automatic relay fee behavior.
