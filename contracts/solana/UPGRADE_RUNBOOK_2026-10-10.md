# Devnet upgrade: nave_core + nave_execution (Oct 10, 2026)

Sign with the upgrade authority `EJ9qpuQosjwv8N1Rab7SK4zvVpEbvEBbCdum9KseADLn`.
Program ids do not change. Run from `contracts/solana`, with `EJ9=.deploy-wallet-ej9-devnet.json`
(gitignored).

| Program | Id | New binary (sha256) |
|---|---|---|
| nave_core | `8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB` | `1701e49cea3c49bc89092cdb7810c16131cf3e0abf95bec871ed83bffcfc7d17` (2,084,952 bytes) |
| nave_execution | `2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb` | `c176b44509fd2ea62d070c91595f2069efa7ce93089a0dde18a70e8d652c4268` (629,680 bytes) |

Both binaries are deployed straight from `target/deploy`. The buffer written earlier,
`52EdSMFGKXW9rxay9pEz14qu8ZfV3q98tuBW115m3NxB`, holds a nave_core build from before the
`register_dao_token` fix (mint not writable, so a creation-time `initial_supply` mint fails).
Do not deploy it; step 1 closes it and returns its 10.59 SOL rent to EJ9.

EJ9 holds about 6.4 SOL on devnet. After step 1 it has about 19.2 SOL, which covers the extend
(about 1.54 SOL) and the temporary write buffers (10.59 SOL for nave_core, 3.20 SOL for
nave_execution, each refunded when its deploy finishes).

## Steps

Upgrade nave_core first: the new nave_execution reads nave_core's `DaoControl` account (it treats a
missing one as "no lock", so the order is safe either way, but core-first avoids a window where the
lock cannot be set).

1. Close the stale nave_core buffer and an older EJ9 buffer (returns about 12.8 SOL to EJ9).

   ```bash
   solana program close 52EdSMFGKXW9rxay9pEz14qu8ZfV3q98tuBW115m3NxB --url devnet -k "$EJ9" --authority "$EJ9"
   solana program close 4EbXxV88A9JgXYhNWgjWTh3U4Mzwti1wyJjVGFdgXjry --url devnet -k "$EJ9" --authority "$EJ9"
   ```

2. Grow nave_core's program account from 1,782,720 to 2,084,952 bytes.

   ```bash
   solana program extend 8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB 302232 --url devnet -k "$EJ9"
   ```

3. Upgrade nave_core.

   ```bash
   shasum -a 256 target/deploy/nave_core.so   # must match the table
   solana program deploy target/deploy/nave_core.so --url devnet -k "$EJ9" \
     --upgrade-authority "$EJ9" --program-id 8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB
   ```

4. Upgrade nave_execution (fits the current account; no extend needed).

   ```bash
   shasum -a 256 target/deploy/nave_execution.so   # must match the table
   solana program deploy target/deploy/nave_execution.so --url devnet -k "$EJ9" \
     --upgrade-authority "$EJ9" --program-id 2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb
   ```

If a deploy is interrupted, `solana program show --buffers --url devnet -k "$EJ9"` lists the
half-written buffer; close it with `solana program close <buffer> --url devnet -k "$EJ9"` and rerun the step.

## Verify

```bash
for p in 8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB 2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb; do
  solana program dump $p /tmp/$p.so --url devnet && shasum -a 256 /tmp/$p.so
done
```

`program dump` returns the full program account, which can be zero-padded past the binary's
length; compare the first 2,084,952 / 629,448 bytes if the hashes differ only for that reason:

```bash
head -c 2084952 /tmp/8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB.so | shasum -a 256
head -c 629448 /tmp/2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb.so | shasum -a 256
```

Then run the devnet role-boundary round trip against the upgraded programs; with the new IDLs it
also checks the guardian lock (venue legs refused while disabled, Executive locked out, quorum re-enable):

```bash
NODE_PATH=../../app/node_modules ../../app/node_modules/.bin/tsx tests/multisig-roundtrip-devnet.ts
```

The app already ships the matching IDLs (`app/src/idl/nave_core.*`, `app/src/idl/nave_execution.*`).
The nave_core IDL changes are the new `RiskTierCapExceeded` error (6119), doc text on
`max_allocation_bps`, whose two high bits now carry the venue risk tier (existing constitutions read
as Tier 1), and `register_dao_token` marking `mint` writable.

## What changes on-chain

- nave_core: per-tier caps in `update_constitution` (Tier 2 approved caps total at most 30%, Tier 3
  at most 15%), plus the guardrails from this pass (direct-execute review deadline, quorum-only
  break-glass, re-enable and agent restore by guardian quorum only, `jupiter_deposit` only through an execution request,
  kToken/fToken marks, venue legs refused while agents are disabled), and the `register_dao_token`
  mint fix.
- nave_execution: `operational_clear` takes a `reason_hash`, and execution honours the guardian
  `DaoControl` lock.
