import { PublicKey } from '@solana/web3.js';

// Account sets for the venue CPIs, read from the venue's own on-chain state so
// a caller only names the reserve / stake pool the position is bound to.

export interface KaminoAccounts {
  reserve: string;
  lending_market: string;
  lending_market_authority: string;
  reserve_liquidity_supply: string;
  reserve_collateral_mint: string;
  /** refresh_reserve slots in order: pyth, switchboard price, switchboard twap, scope. */
  oracles: string[];
}

// klend `Reserve` offsets (8-byte discriminator included), checked against the
// devnet reserve Ax27Gp… used by tests/kamino-cpi-devnet.ts.
const RESERVE_LENDING_MARKET = 32;
const RESERVE_LIQUIDITY_SUPPLY = 160;
const RESERVE_COLLATERAL_MINT = 2560;
const RESERVE_SCOPE_PRICE_FEED = 5112;
const RESERVE_SWITCHBOARD_PRICE = 5160;
const RESERVE_SWITCHBOARD_TWAP = 5192;
const RESERVE_PYTH_PRICE = 5224;
const RESERVE_MIN_LEN = RESERVE_PYTH_PRICE + 32;

/** klend stores "no oracle" as the zero key or this sentinel. */
const KLEND_NULL_KEY = 'nu11111111111111111111111111111111111111111';

function keyAt(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

export function kaminoAccountsFromReserve(
  reserve: PublicKey,
  data: Uint8Array,
  klendProgram: PublicKey,
): KaminoAccounts {
  if (data.length < RESERVE_MIN_LEN) {
    throw new Error(`account ${reserve.toBase58()} is not a klend reserve (${data.length} bytes)`);
  }
  const lendingMarket = keyAt(data, RESERVE_LENDING_MARKET);
  const oracle = (offset: number) => {
    const k = keyAt(data, offset);
    return k.equals(PublicKey.default) || k.toBase58() === KLEND_NULL_KEY ? klendProgram : k;
  };
  return {
    reserve: reserve.toBase58(),
    lending_market: lendingMarket.toBase58(),
    lending_market_authority: PublicKey.findProgramAddressSync(
      [Buffer.from('lma'), lendingMarket.toBuffer()],
      klendProgram,
    )[0].toBase58(),
    reserve_liquidity_supply: keyAt(data, RESERVE_LIQUIDITY_SUPPLY).toBase58(),
    reserve_collateral_mint: keyAt(data, RESERVE_COLLATERAL_MINT).toBase58(),
    oracles: [
      oracle(RESERVE_PYTH_PRICE),
      oracle(RESERVE_SWITCHBOARD_PRICE),
      oracle(RESERVE_SWITCHBOARD_TWAP),
      oracle(RESERVE_SCOPE_PRICE_FEED),
    ].map((k) => k.toBase58()),
  };
}

export interface JitoAccounts {
  stake_pool: string;
  stake_pool_withdraw_authority: string;
  reserve_stake: string;
  manager_fee_account: string;
  pool_mint: string;
}

// SPL stake-pool `StakePool` layout (no discriminator; account_type is byte 0).
const POOL_RESERVE_STAKE = 130;
const POOL_MINT = 162;
const POOL_MANAGER_FEE_ACCOUNT = 194;
const POOL_MIN_LEN = POOL_MANAGER_FEE_ACCOUNT + 32;

export function jitoAccountsFromStakePool(
  stakePool: PublicKey,
  data: Uint8Array,
  stakePoolProgram: PublicKey,
): JitoAccounts {
  if (data.length < POOL_MIN_LEN || data[0] !== 1) {
    throw new Error(`account ${stakePool.toBase58()} is not an initialized SPL stake pool`);
  }
  return {
    stake_pool: stakePool.toBase58(),
    stake_pool_withdraw_authority: PublicKey.findProgramAddressSync(
      [stakePool.toBuffer(), Buffer.from('withdraw')],
      stakePoolProgram,
    )[0].toBase58(),
    reserve_stake: keyAt(data, POOL_RESERVE_STAKE).toBase58(),
    pool_mint: keyAt(data, POOL_MINT).toBase58(),
    manager_fee_account: keyAt(data, POOL_MANAGER_FEE_ACCOUNT).toBase58(),
  };
}
