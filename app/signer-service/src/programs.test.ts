import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';

// programs.ts reads env at import time; pin a non-mainnet, localhost-friendly
// environment so the module loads hermetically.
delete process.env.NAVE_CLUSTER;
delete process.env.NODE_ENV;
delete process.env.SOLANA_RPC_URL;

const { getCoreIdl, pdas, PROGRAM_IDS, resolveSolanaRpcUrl, localhostRpcFallbackAllowed, devnetProgramIdWarnings } =
  await import('./programs.js');

type IdlSeed =
  | { kind: 'const'; value: number[] }
  | { kind: 'account'; path: string }
  | { kind: 'arg'; path: string };
interface IdlAccount { name: string; pda?: { seeds: IdlSeed[] } }
interface IdlInstruction { name: string; accounts: IdlAccount[] }

function idlPdaSeeds(instruction: string, account: string): IdlSeed[] {
  const idl = getCoreIdl() as { instructions: IdlInstruction[] };
  const ix = idl.instructions.find((i) => i.name === instruction);
  assert.ok(ix, `IDL instruction ${instruction} missing`);
  const acc = ix!.accounts.find((a) => a.name === account);
  assert.ok(acc?.pda, `IDL account ${instruction}.${account} has no pda seeds`);
  return acc!.pda!.seeds;
}

/** Derive a PDA exactly as the IDL declares it, from a (dao, protocol_id, mint) context. */
function deriveFromIdl(seeds: IdlSeed[], ctx: { dao: PublicKey; protocolId: string; mint: PublicKey }): PublicKey {
  const bufs = seeds.map((s) => {
    if (s.kind === 'const') return Buffer.from(s.value);
    if (s.kind === 'arg' && s.path === 'protocol_id') return Buffer.from(ctx.protocolId);
    if (s.kind === 'account' && s.path === 'dao_registry') return ctx.dao.toBuffer();
    if (s.kind === 'account' && s.path === 'mint') return ctx.mint.toBuffer();
    throw new Error(`unhandled IDL seed ${JSON.stringify(s)}`);
  });
  return PublicKey.findProgramAddressSync(bufs, PROGRAM_IDS.core)[0];
}

// Audit MEDIUM: the signer derived strategy_position / strategy_escrow with the
// legacy 3-seed form [seed, dao, protocol_id]; the on-chain programs (nave_core
// constants STRATEGY_POSITION_SEED / STRATEGY_ESCROW_SEED, IDL
// `update_strategy_position_value` / `init_strategy_escrow`) use the 4-seed
// form [seed, dao, protocol_id, mint]. These tests pin the helpers to the IDL.
test('pdas.strategyPosition matches the IDL 4-seed derivation [seed, dao, protocol_id, mint]', () => {
  const seeds = idlPdaSeeds('update_strategy_position_value', 'strategy_position');
  assert.equal(seeds.length, 4, 'on-chain strategy_position is a 4-seed PDA');
  assert.deepEqual(seeds.map((s) => s.kind), ['const', 'account', 'arg', 'account']);
  assert.equal(Buffer.from((seeds[0] as { value: number[] }).value).toString(), 'strategy_position');

  const ctx = { dao: Keypair.generate().publicKey, protocolId: 'kamino', mint: Keypair.generate().publicKey };
  const expected = deriveFromIdl(seeds, ctx);
  assert.equal(pdas.strategyPosition(ctx.dao, ctx.protocolId, ctx.mint).toBase58(), expected.toBase58());
  assert.equal(pdas.strategyPositionForMint(ctx.dao, ctx.protocolId, ctx.mint).toBase58(), expected.toBase58());

  // The legacy 3-seed address is a DIFFERENT account — proving the old helper
  // pointed the signer at a PDA the program would reject.
  const legacy = PublicKey.findProgramAddressSync(
    [Buffer.from('strategy_position'), ctx.dao.toBuffer(), Buffer.from(ctx.protocolId)],
    PROGRAM_IDS.core,
  )[0];
  assert.notEqual(legacy.toBase58(), expected.toBase58());
});

test('pdas.strategyEscrow matches the IDL 4-seed derivation [seed, dao, protocol_id, mint]', () => {
  const seeds = idlPdaSeeds('init_strategy_escrow', 'strategy_escrow');
  assert.equal(seeds.length, 4);
  assert.equal(Buffer.from((seeds[0] as { value: number[] }).value).toString(), 'strategy_escrow');
  const ctx = { dao: Keypair.generate().publicKey, protocolId: 'jito', mint: Keypair.generate().publicKey };
  const expected = deriveFromIdl(seeds, ctx);
  assert.equal(pdas.strategyEscrow(ctx.dao, ctx.protocolId, ctx.mint).toBase58(), expected.toBase58());
  assert.equal(pdas.strategyEscrowForMint(ctx.dao, ctx.protocolId, ctx.mint).toBase58(), expected.toBase58());
});

test('update_strategy_position_value IDL accounts include mint (signer must pass it)', () => {
  const idl = getCoreIdl() as { instructions: IdlInstruction[] };
  const ix = idl.instructions.find((i) => i.name === 'update_strategy_position_value')!;
  const names = ix.accounts.map((a) => a.name);
  assert.ok(names.includes('mint'));
  assert.ok(!names.includes('treasury_vault'), 'treasury_vault is not an account of this instruction');
});

// Audit 8c: the localhost RPC default must not survive into production / public clusters.
test('resolveSolanaRpcUrl refuses the localhost default in production or on mainnet/devnet', () => {
  const saved = { c: process.env.NAVE_CLUSTER, n: process.env.NODE_ENV, r: process.env.SOLANA_RPC_URL };
  try {
    delete process.env.SOLANA_RPC_URL;
    delete process.env.NAVE_CLUSTER;
    delete process.env.NODE_ENV;
    assert.equal(localhostRpcFallbackAllowed(), true);
    assert.equal(resolveSolanaRpcUrl(), 'http://localhost:8899');

    process.env.NAVE_CLUSTER = 'localnet';
    assert.equal(resolveSolanaRpcUrl(), 'http://localhost:8899');

    for (const cluster of ['mainnet', 'mainnet-beta', 'devnet']) {
      process.env.NAVE_CLUSTER = cluster;
      assert.equal(localhostRpcFallbackAllowed(), false, cluster);
      assert.throws(() => resolveSolanaRpcUrl(), /SOLANA_RPC_URL is not set/, cluster);
    }
    delete process.env.NAVE_CLUSTER;
    process.env.NODE_ENV = 'production';
    assert.throws(() => resolveSolanaRpcUrl(), /SOLANA_RPC_URL is not set/);

    // Explicit URL always wins.
    process.env.SOLANA_RPC_URL = 'https://rpc.example.invalid';
    process.env.NAVE_CLUSTER = 'mainnet';
    assert.equal(resolveSolanaRpcUrl(), 'https://rpc.example.invalid');
  } finally {
    for (const [k, v] of [['NAVE_CLUSTER', saved.c], ['NODE_ENV', saved.n], ['SOLANA_RPC_URL', saved.r]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// Audit 8e/8f: devnet program ids on a mainnet cluster are surfaced.
test('devnetProgramIdWarnings flags unset/devnet ids only when NAVE_CLUSTER is mainnet', () => {
  const saved = { c: process.env.NAVE_CLUSTER, core: process.env.NAVE_CORE_PROGRAM_ID, bridge: process.env.BRIDGE_SOLANA_BRIDGE_PROGRAM };
  try {
    delete process.env.NAVE_CLUSTER;
    assert.deepEqual(devnetProgramIdWarnings(), []);

    process.env.NAVE_CLUSTER = 'mainnet';
    delete process.env.NAVE_CORE_PROGRAM_ID;
    process.env.BRIDGE_SOLANA_BRIDGE_PROGRAM = 'Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6'; // the devnet default, set explicitly
    const warnings = devnetProgramIdWarnings();
    assert.ok(warnings.some((w) => w.startsWith('NAVE_CORE_PROGRAM_ID is unset on mainnet')));
    assert.ok(warnings.some((w) => w.startsWith('BRIDGE_SOLANA_BRIDGE_PROGRAM is set to the DEVNET program id')));

    process.env.BRIDGE_SOLANA_BRIDGE_PROGRAM = Keypair.generate().publicKey.toBase58();
    assert.ok(!devnetProgramIdWarnings().some((w) => w.startsWith('BRIDGE_SOLANA_BRIDGE_PROGRAM')));
  } finally {
    for (const [k, v] of [['NAVE_CLUSTER', saved.c], ['NAVE_CORE_PROGRAM_ID', saved.core], ['BRIDGE_SOLANA_BRIDGE_PROGRAM', saved.bridge]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
