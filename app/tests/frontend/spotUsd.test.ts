import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { fetchSpotUsd, resetSpotUsdCache } from '../../src/lib/pricing/spotUsd';

const MAINNET_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const SEPOLIA_WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const ROBINHOOD_WETH = '0x7943e237c7f95da44e0301572d358911207852fa';

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  } as unknown as Response;
}

test.beforeEach(() => {
  resetSpotUsdCache();
  globalThis.fetch = realFetch;
});

test.afterEach(() => {
  resetSpotUsdCache();
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

test('CoinGecko ethereum price is cached for 60s and does not query a WETH contract', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return jsonResponse({ ethereum: { usd: 3450.25 }, solana: { usd: 180 } });
  }) as typeof fetch;

  const first = await fetchSpotUsd(['ethereum', 'solana']);
  const second = await fetchSpotUsd(['ethereum']);
  assert.equal(first.ethereum, 3450.25);
  assert.equal(first.solana, 180);
  assert.equal(second.ethereum, 3450.25);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /api\.coingecko\.com/);
  assert.equal(urls.some((url) => url.toLowerCase().includes(MAINNET_WETH)), false);
  assert.equal(urls.some((url) => url.toLowerCase().includes(SEPOLIA_WETH)), false);
  assert.equal(urls.some((url) => url.toLowerCase().includes(ROBINHOOD_WETH)), false);
});

test('a CoinGecko miss uses the most liquid mainnet WETH pair on DexScreener', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const href = String(url);
    urls.push(href);
    if (href.includes('coingecko')) return jsonResponse({}, false, 429);
    if (href.includes('dexscreener')) {
      return jsonResponse([
        {
          priceUsd: '1',
          liquidity: { usd: 9_000_000_000 },
          baseToken: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        },
        {
          priceUsd: '100',
          liquidity: { usd: 10 },
          baseToken: { address: MAINNET_WETH },
        },
        {
          priceUsd: '3210.5',
          liquidity: { usd: 40_000_000 },
          baseToken: { address: MAINNET_WETH.toUpperCase() },
        },
      ]);
    }
    throw new Error(`unexpected ${href}`);
  }) as typeof fetch;

  const prices = await fetchSpotUsd(['ethereum']);
  assert.equal(prices.ethereum, 3210.5);
  assert.equal(urls.length, 2);
  assert.match(urls[1], new RegExp(`dexscreener\\.com/tokens/v1/ethereum/${MAINNET_WETH}`));
  assert.equal(urls.some((url) => url.toLowerCase().includes(SEPOLIA_WETH)), false);
  assert.equal(urls.some((url) => url.toLowerCase().includes(ROBINHOOD_WETH)), false);
  assert.equal(urls.some((url) => url.includes('geckoterminal')), false);
});

test('DexScreener miss falls through to GeckoTerminal mainnet WETH', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const href = String(url);
    urls.push(href);
    if (href.includes('coingecko')) return jsonResponse({ ethereum: { usd: 0 }, solana: { usd: 90 } });
    if (href.includes('dexscreener')) return jsonResponse([]);
    if (href.includes('geckoterminal')) {
      return jsonResponse({
        data: {
          attributes: {
            token_prices: { [MAINNET_WETH]: '2875.125' },
          },
        },
      });
    }
    throw new Error(`unexpected ${href}`);
  }) as typeof fetch;

  const prices = await fetchSpotUsd(['solana', 'ethereum']);
  assert.equal(prices.solana, 90);
  assert.equal(prices.ethereum, 2875.125);
  assert.match(urls[2], new RegExp(`geckoterminal\\.com/api/v2/simple/networks/eth/token_price/${MAINNET_WETH}`));
  assert.equal(urls.some((url) => url.toLowerCase().includes(SEPOLIA_WETH)), false);
  assert.equal(urls.some((url) => url.toLowerCase().includes(ROBINHOOD_WETH)), false);
});

test('every source missing leaves ethereum unset', async () => {
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;

  const prices = await fetchSpotUsd(['ethereum']);
  assert.deepEqual(prices, {});
});

test('a cached ETH price expires after 60s', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse({ ethereum: { usd: 3000 + calls } });
  }) as typeof fetch;

  assert.equal((await fetchSpotUsd(['ethereum'])).ethereum, 3001);
  mock.timers.tick(59_000);
  assert.equal((await fetchSpotUsd(['ethereum'])).ethereum, 3001);
  assert.equal(calls, 1);
  mock.timers.tick(1_000);
  assert.equal((await fetchSpotUsd(['ethereum'])).ethereum, 3002);
  assert.equal(calls, 2);
});
