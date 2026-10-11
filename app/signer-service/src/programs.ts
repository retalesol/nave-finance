import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the IDL directory. Priority:
//   1. IDL_DIR env override (explicit deploy path)
//   2. vendored copy bundled with the service (./idl) — used in containers
//   3. the monorepo frontend IDLs (../../src/idl) — used in local dev
const VENDORED_IDL_DIR = resolve(__dirname, '..', 'idl');
const MONOREPO_IDL_DIR = resolve(__dirname, '..', '..', 'src', 'idl');

function resolveIdlDir(): string {
  if (process.env.IDL_DIR) return process.env.IDL_DIR;
  if (existsSync(join(VENDORED_IDL_DIR, 'nave_core.json'))) return VENDORED_IDL_DIR;
  return MONOREPO_IDL_DIR;
}

const IDL_DIR = resolveIdlDir();

function loadIdl(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(IDL_DIR, `${name}.json`), 'utf8'));
}

/** External protocol program ids the nave_core CPIs verify against. */
export const EXTERNAL_PROGRAM_IDS = {
  klend: new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'),
  splStakePool: new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'),
  stake: new PublicKey('Stake11111111111111111111111111111111111111'),
  // Jupiter Lend (Earn): devnet default, override JUPITER_LENDING_PROGRAM_ID for mainnet.
  // Mainnet: jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9
  jupiterLending: new PublicKey(
    process.env.JUPITER_LENDING_PROGRAM_ID ?? '7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3',
  ),
  // Jupiter liquidity layer program (forwarded as a runtime account, not pinned on-chain).
  // Mainnet: jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC
  jupiterLiquidity: new PublicKey(
    process.env.JUPITER_LIQUIDITY_PROGRAM_ID ?? '5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL',
  ),
  // MarginFi v2 lending program. Differs devnet vs mainnet (mirrors nave_core's
  // `constants::marginfi_program`, built with `--features mainnet` for the real
  // deployment). Devnet default matches the pinned devnet id in that module.
  // Mainnet: MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA
  marginfi: new PublicKey(
    process.env.MARGINFI_PROGRAM_ID ?? 'A7vUDErNPCTt9qrB6SSM4F6GkxzUe9d8P3cXSmRg4eY4',
  ),
};

/** Canonical Jupiter mainnet program ids (the ONLY acceptable values on mainnet). */
export const JUPITER_MAINNET_PROGRAM_IDS = {
  lending: 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9',
  liquidity: 'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC',
} as const;

/** The devnet placeholder defaults that must NEVER be used on mainnet. */
export const JUPITER_DEVNET_DEFAULTS = {
  lending: '7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3',
  liquidity: '5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL',
} as const;

/**
 * Whether this process is targeting Solana mainnet. Prefers the explicit
 * NAVE_CLUSTER signal (mainnet | mainnet-beta | devnet | localnet); falls back
 * to sniffing the RPC URL only when NAVE_CLUSTER is unset. Defaulting to "not
 * mainnet" when ambiguous is safe because the mainnet assertion is the gate —
 * an operator who forgets NAVE_CLUSTER on a real mainnet RPC still trips the
 * URL sniff, and a custom mainnet RPC (e.g. Helius) is covered by NAVE_CLUSTER.
 */
export function isMainnetCluster(): boolean {
  const cluster = (process.env.NAVE_CLUSTER ?? '').toLowerCase().trim();
  if (cluster) return cluster === 'mainnet' || cluster === 'mainnet-beta';
  return (process.env.SOLANA_RPC_URL ?? '').includes('mainnet');
}

export interface JupiterIdCheck {
  isMainnet: boolean;
  lending: string;
  liquidity: string;
  ok: boolean;
  errors: string[];
}

/**
 * Validate that the configured Jupiter program ids are the mainnet values when
 * the process targets mainnet. On devnet/localnet anything is accepted. This is
 * the boot-time guard against a mainnet binary silently CPI-ing the devnet
 * placeholder programs (which would route real funds to the wrong program).
 */
export function checkJupiterProgramIds(): JupiterIdCheck {
  const isMainnet = isMainnetCluster();
  const lending = EXTERNAL_PROGRAM_IDS.jupiterLending.toBase58();
  const liquidity = EXTERNAL_PROGRAM_IDS.jupiterLiquidity.toBase58();
  const errors: string[] = [];
  if (isMainnet) {
    if (lending !== JUPITER_MAINNET_PROGRAM_IDS.lending) {
      errors.push(
        `JUPITER_LENDING_PROGRAM_ID is ${lending}; mainnet requires ${JUPITER_MAINNET_PROGRAM_IDS.lending}`,
      );
    }
    if (liquidity !== JUPITER_MAINNET_PROGRAM_IDS.liquidity) {
      errors.push(
        `JUPITER_LIQUIDITY_PROGRAM_ID is ${liquidity}; mainnet requires ${JUPITER_MAINNET_PROGRAM_IDS.liquidity}`,
      );
    }
  }
  return { isMainnet, lending, liquidity, ok: errors.length === 0, errors };
}

export const PROGRAM_IDS = {
  core: new PublicKey(process.env.NAVE_CORE_PROGRAM_ID || '8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB'),
  governance: new PublicKey(process.env.NAVE_GOVERNANCE_PROGRAM_ID || 'CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M'),
  execution: new PublicKey(process.env.NAVE_EXECUTION_PROGRAM_ID || '2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb'),
  jito: new PublicKey(process.env.NAVE_JITO_ADAPTER_ID || 'E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT'),
  kamino: new PublicKey(process.env.NAVE_KAMINO_ADAPTER_ID || 'B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD'),
  marginfi: new PublicKey(process.env.NAVE_MARGINFI_ADAPTER_ID || 'Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7'),
};

const idl = {
  core: loadIdl('nave_core'),
  governance: loadIdl('nave_governance'),
  execution: loadIdl('nave_execution'),
};

/** Local validator default — only ever acceptable for localnet development. */
export const LOCALHOST_SOLANA_RPC_URL = 'http://localhost:8899';

/**
 * Whether the implicit `http://localhost:8899` fallback is permitted. It is
 * NOT when the process is production (`NODE_ENV=production`) or explicitly
 * targets a public cluster (`NAVE_CLUSTER=mainnet|mainnet-beta|devnet`): a
 * silent localhost default there means every RPC read/send fails (or, worse,
 * hits a stray local validator) instead of surfacing the missing config.
 */
export function localhostRpcFallbackAllowed(): boolean {
  if ((process.env.NODE_ENV || '').trim().toLowerCase() === 'production') return false;
  const cluster = (process.env.NAVE_CLUSTER ?? '').toLowerCase().trim();
  return !(cluster === 'mainnet' || cluster === 'mainnet-beta' || cluster === 'devnet');
}

/**
 * Resolve the service-wide Solana RPC URL. Throws (instead of defaulting to
 * localhost) whenever {@link localhostRpcFallbackAllowed} is false — callers at
 * boot turn this into a fatal exit.
 */
export function resolveSolanaRpcUrl(): string {
  const configured = (process.env.SOLANA_RPC_URL || '').trim();
  if (configured) return configured;
  if (localhostRpcFallbackAllowed()) return LOCALHOST_SOLANA_RPC_URL;
  throw new Error(
    'SOLANA_RPC_URL is not set and the localhost fallback is disabled for ' +
      `NODE_ENV=${process.env.NODE_ENV || ''} / NAVE_CLUSTER=${process.env.NAVE_CLUSTER || ''}. Set SOLANA_RPC_URL explicitly.`,
  );
}

export function getConnection(): Connection {
  return new Connection(resolveSolanaRpcUrl(), 'confirmed');
}

/**
 * Devnet program ids this binary falls back to when the NAVE_*_PROGRAM_ID /
 * BRIDGE_SOLANA_*_PROGRAM envs are unset. A mainnet deployment MUST override
 * every one of them; {@link devnetProgramIdWarnings} surfaces any that still
 * hold a devnet default while the cluster is mainnet.
 */
export const DEVNET_DEFAULT_PROGRAM_IDS: Record<string, string> = {
  NAVE_CORE_PROGRAM_ID: '8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB',
  NAVE_GOVERNANCE_PROGRAM_ID: 'CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M',
  NAVE_EXECUTION_PROGRAM_ID: '2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb',
  NAVE_JITO_ADAPTER_ID: 'E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT',
  NAVE_KAMINO_ADAPTER_ID: 'B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD',
  NAVE_MARGINFI_ADAPTER_ID: 'Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7',
  BRIDGE_SOLANA_STAKING_PROGRAM: 'AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf',
  BRIDGE_SOLANA_BRIDGE_PROGRAM: 'Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6',
};

/**
 * Warnings for every Solana program id that is still a devnet default (or
 * explicitly set to one) while `NAVE_CLUSTER` says mainnet. Empty when not on
 * mainnet or when every id has been overridden.
 */
export function devnetProgramIdWarnings(): string[] {
  if (!isMainnetCluster()) return [];
  const out: string[] = [];
  for (const [env, devnetId] of Object.entries(DEVNET_DEFAULT_PROGRAM_IDS)) {
    const configured = (process.env[env] || '').trim();
    if (!configured) {
      out.push(`${env} is unset on mainnet — falling back to the DEVNET program id ${devnetId}`);
    } else if (configured === devnetId) {
      out.push(`${env} is set to the DEVNET program id ${devnetId} while NAVE_CLUSTER is mainnet`);
    }
  }
  return out;
}

export interface AgentPrograms {
  connection: Connection;
  provider: AnchorProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  core: Program<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  governance: Program<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execution: Program<any>;
}

/** Build Program instances whose provider signs with (and pays from) the agent keypair. */
export function programsForAgent(agent: Keypair, connection = getConnection()): AgentPrograms {
  const provider = new AnchorProvider(connection, new Wallet(agent), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return {
    connection,
    provider,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    core: new Program(idl.core as any, provider),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    governance: new Program(idl.governance as any, provider),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execution: new Program(idl.execution as any, provider),
  };
}

// ─── Tolerant account decode (pre-bootstrap layout compatibility) ─────────────
// The bootstrap release appended a trailing 1-byte field to both DaoRegistry
// (`bootstrap_used`) and ExecutionRequest (`bootstrap`). Until the on-chain
// programs are redeployed, accounts created by the deployed program are one byte
// short of what the regenerated IDL expects, so the typed AccountClient throws
// ("offset out of range") decoding them. The appended fields are LAST (after
// every value the service reads), so padding a legacy account with a single zero
// byte decodes all consumed fields correctly. Only the exact old-layout length is
// padded so genuinely-incompatible older layouts are never resurrected as garbage.
const DAO_REGISTRY_OLD_LEN = 160;
const DAO_REGISTRY_NEW_LEN = 161;
const EXECUTION_REQUEST_OLD_LEN = 362;
const EXECUTION_REQUEST_NEW_LEN = 363;

async function fetchTolerant(
  programs: AgentPrograms,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  accountName: string,
  address: PublicKey,
  oldLen: number,
  newLen: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const info = await programs.connection.getAccountInfo(address);
  if (!info) throw new Error(`Account not found: ${address.toBase58()}`);
  let data: Buffer = info.data;
  if (data.length === oldLen) {
    data = Buffer.concat([data, Buffer.alloc(newLen - oldLen)]);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (program as any).coder.accounts.decode(accountName, data);
}

/** Fetch + decode a DaoRegistry tolerantly (pads the pre-bootstrap layout). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchDaoRegistryTolerant(programs: AgentPrograms, dao: PublicKey): Promise<any> {
  return fetchTolerant(programs, programs.core, 'daoRegistry', dao, DAO_REGISTRY_OLD_LEN, DAO_REGISTRY_NEW_LEN);
}

/** Fetch + decode an ExecutionRequest tolerantly (pads the pre-bootstrap layout). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fetchExecutionRequestTolerant(programs: AgentPrograms, address: PublicKey): Promise<any> {
  return fetchTolerant(
    programs,
    programs.execution,
    'executionRequest',
    address,
    EXECUTION_REQUEST_OLD_LEN,
    EXECUTION_REQUEST_NEW_LEN,
  );
}

export function adapterProgramId(protocolId: string): PublicKey | null {
  switch (protocolId.toLowerCase()) {
    case 'jito':
      return PROGRAM_IDS.jito;
    case 'kamino':
      return PROGRAM_IDS.kamino;
    case 'marginfi':
      return PROGRAM_IDS.marginfi;
    case 'jupiter':
      // No Nave adapter: the request binds the Jupiter Lend program and
      // jupiter_deposit places the escrow after execute_strategy.
      return EXTERNAL_PROGRAM_IDS.jupiterLending;
    default:
      return null;
  }
}

// ─── PDA derivations (mirror the on-chain seeds) ─────────────────────────────

function leU64(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export const pdas = {
  globalConfig: () =>
    PublicKey.findProgramAddressSync([Buffer.from('global_config')], PROGRAM_IDS.core)[0],
  guardianConfig: (dao: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('guardian_config'), dao.toBuffer()], PROGRAM_IDS.core)[0],
  agentSet: (dao: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('agent_set'), dao.toBuffer()], PROGRAM_IDS.core)[0],
  daoLifecycle: (dao: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('dao_lifecycle'), dao.toBuffer()], PROGRAM_IDS.core)[0],
  constitution: (dao: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('constitution'), dao.toBuffer()], PROGRAM_IDS.core)[0],
  treasuryVault: (dao: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('treasury_vault'), dao.toBuffer()], PROGRAM_IDS.core)[0],
  vaultAuthority: (dao: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('vault_authority'), dao.toBuffer()], PROGRAM_IDS.core)[0],
  /** Per-dao fee configuration (management/performance bps + protocol_revenue_wallet). */
  feeConfig: (dao: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('fee_config'), dao.toBuffer()], PROGRAM_IDS.core)[0],
  /**
   * Strategy position PDA. On-chain seeds (nave_core::constants
   * STRATEGY_POSITION_SEED, IDL `update_strategy_position_value`) are the
   * 4-seed form `[seed, dao, protocol_id, mint]` — the legacy 3-seed
   * derivation was silently wrong for every multi-asset position.
   */
  strategyPosition: (dao: PublicKey, protocolId: string, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('strategy_position'), dao.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
      PROGRAM_IDS.core,
    )[0],
  /**
   * Distinct escrow token-account PDA, owned by vault_authority. On-chain seeds
   * (STRATEGY_ESCROW_SEED, IDL `init_strategy_escrow`) are
   * `[seed, dao, protocol_id, mint]`.
   */
  strategyEscrow: (dao: PublicKey, protocolId: string, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('strategy_escrow'), dao.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
      PROGRAM_IDS.core,
    )[0],
  proposal: (dao: PublicKey, index: number | bigint) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('proposal'), dao.toBuffer(), leU64(index)],
      PROGRAM_IDS.governance,
    )[0],
  executionRequest: (proposal: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('execution_request'), proposal.toBuffer()],
      PROGRAM_IDS.execution,
    )[0],
  executionAuthority: (dao: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('execution_authority'), dao.toBuffer()],
      PROGRAM_IDS.execution,
    )[0],

  // ── Multi-asset treasury PDAs (mirror nave_core::constants) ──────────────
  /** Per-(dao, mint) asset configuration: Pyth feed id, decimals, classification. */
  assetConfig: (dao: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('asset_config'), dao.toBuffer(), mint.toBuffer()],
      PROGRAM_IDS.core,
    )[0],
  /** Per-(dao, mint) treasury accounting record. */
  treasuryAsset: (dao: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('treasury_asset'), dao.toBuffer(), mint.toBuffer()],
      PROGRAM_IDS.core,
    )[0],
  /** Per-(dao, mint) holding token account PDA, owned by vault_authority. */
  assetVault: (dao: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('asset_vault'), dao.toBuffer(), mint.toBuffer()],
      PROGRAM_IDS.core,
    )[0],
  /** Per-(dao, protocol_id, mint) receipt-token account PDA (cTokens / poolSOL). */
  positionToken: (dao: PublicKey, protocolId: string, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('position_token'), dao.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
      PROGRAM_IDS.core,
    )[0],
  /** Per-dao system-owned native-SOL funding signer (SPL stake-pool DepositSol). */
  solFunding: (dao: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('sol_funding'), dao.toBuffer()],
      PROGRAM_IDS.core,
    )[0],
  /** Alias of {@link pdas.strategyPosition} (same 4-seed derivation). */
  strategyPositionForMint: (dao: PublicKey, protocolId: string, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('strategy_position'), dao.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
      PROGRAM_IDS.core,
    )[0],
  /** Alias of {@link pdas.strategyEscrow} (same 4-seed derivation). */
  strategyEscrowForMint: (dao: PublicKey, protocolId: string, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('strategy_escrow'), dao.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
      PROGRAM_IDS.core,
    )[0],
};

/** Raw nave_core IDL (for tests/tools that need to cross-check PDA seeds). */
export function getCoreIdl(): Record<string, unknown> {
  return idl.core;
}

// ─── Pyth feed registry (PriceUpdateV2 pull-oracle feed ids) ─────────────────
// Hex feed ids (Hermes/pyth-evm-feed-ids). Stablecoins are valued at USD parity
// on-chain and do NOT require a price update; only non-stable (SolLike/Other)
// assets need a posted PriceUpdateV2. Same feed ids on mainnet & devnet.
export const PYTH_FEED_IDS: Record<string, string> = {
  // SOL / USD
  So11111111111111111111111111111111111111112:
    'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
};

/** Mints valued at exact USD parity on-chain (no Pyth update needed). */
export const STABLECOIN_MINTS = new Set<string>([
  // devnet/mainnet USDC + USDT are registered as stablecoins on-chain; the
  // authoritative `is_stablecoin` flag lives in the AssetConfig account. This
  // set is a fast-path hint for the off-chain price-posting decision only.
]);
