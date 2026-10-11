import { AnchorProvider, Program } from '@coral-xyz/anchor';
import type { Wallet } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { SOLANA_RPC_URL, isDirectCpiProtocol } from './programConfig';

export { isDirectCpiProtocol };

import naveCoreIdl from '../idl/nave_core.json';
import naveGovernanceIdl from '../idl/nave_governance.json';
import naveExecutionIdl from '../idl/nave_execution.json';
import naveJitoIdl from '../idl/nave_jito_adapter.json';
import naveKaminoIdl from '../idl/nave_kamino_adapter.json';
import naveMarginfiIdl from '../idl/nave_marginfi_adapter.json';

import type { NaveCore } from '../idl/nave_core';
import type { NaveGovernance } from '../idl/nave_governance';
import type { NaveExecution } from '../idl/nave_execution';
import type { NaveJitoAdapter } from '../idl/nave_jito_adapter';
import type { NaveKaminoAdapter } from '../idl/nave_kamino_adapter';
import type { NaveMarginfiAdapter } from '../idl/nave_marginfi_adapter';

// ─── Connection singleton ────────────────────────────────────────────────────

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  }
  return _connection;
}

// ─── Read-only wallet ────────────────────────────────────────────────────────
// Anchor's Program needs a provider with a wallet, but for instruction building
// (.instruction()) and account reads (.account.X.fetch()) no real signer is
// required — the connected wallet adapter signs the final transaction in
// useSendTransaction. We supply an ephemeral keypair that never signs anything.

class ReadonlyWallet implements Wallet {
  readonly payer: Keypair;

  constructor() {
    this.payer = Keypair.generate();
  }

  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return txs;
  }
}

// ─── Program bundle ──────────────────────────────────────────────────────────

export interface NavePrograms {
  connection: Connection;
  provider: AnchorProvider;
  core: Program<NaveCore>;
  governance: Program<NaveGovernance>;
  execution: Program<NaveExecution>;
  jito: Program<NaveJitoAdapter>;
  kamino: Program<NaveKaminoAdapter>;
  marginfi: Program<NaveMarginfiAdapter>;
}

let _cache: { endpoint: string; programs: NavePrograms } | null = null;

/**
 * Build (and cache) Anchor Program instances for all six Nave programs.
 * Program IDs, discriminators, argument codecs, and account layouts all come
 * from the embedded IDL — the single source of truth.
 */
export function getNavePrograms(connection?: Connection): NavePrograms {
  const conn = connection ?? getConnection();
  if (_cache && _cache.endpoint === conn.rpcEndpoint) {
    return _cache.programs;
  }

  const provider = new AnchorProvider(conn, new ReadonlyWallet(), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });

  const programs: NavePrograms = {
    connection: conn,
    provider,
    core: new Program(naveCoreIdl as NaveCore, provider),
    governance: new Program(naveGovernanceIdl as NaveGovernance, provider),
    execution: new Program(naveExecutionIdl as NaveExecution, provider),
    jito: new Program(naveJitoIdl as NaveJitoAdapter, provider),
    kamino: new Program(naveKaminoIdl as NaveKaminoAdapter, provider),
    marginfi: new Program(naveMarginfiIdl as NaveMarginfiAdapter, provider),
  };

  _cache = { endpoint: conn.rpcEndpoint, programs };
  return programs;
}

/**
 * Resolve an adapter Program by protocol id (jito | kamino | marginfi).
 * Returns null for `jupiter`, which has no Nave adapter program (see
 * `isDirectCpiProtocol`).
 */
export function getAdapterProgram(
  protocolId: string,
  programs: NavePrograms = getNavePrograms(),
): Program<NaveJitoAdapter> | Program<NaveKaminoAdapter> | Program<NaveMarginfiAdapter> | null {
  switch (protocolId.toLowerCase()) {
    case 'jito':
      return programs.jito;
    case 'kamino':
      return programs.kamino;
    case 'marginfi':
      return programs.marginfi;
    default:
      return null;
  }
}
