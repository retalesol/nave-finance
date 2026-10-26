import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  MOONPAY_CURRENCY,
  chainForMoonPayCurrency,
  deriveVaultAuthorityAddress,
  moonpayWebhookSignatureValid,
  signMoonPayQuery,
  validateMoonPaySignUrl,
  type SolanaPublicKeyCtor,
} from "../../supabase/functions/_shared/moonpay.ts";

const DOCS_SECRET = "sk_test_DocsVector00";
const DOCS_URL =
  "https://buy-sandbox.moonpay.com/?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe";
const DOCS_QUERY =
  "?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe";
const DOCS_SIGNATURE = "oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=";

const TEST_KEY = "pk_test_DocsVector00";
const LIVE_KEY = "pk_live_DocsVector00";
const PROGRAM_ID = "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB";
const EVM_DAO = "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe";
const SOL_DAO = "So11111111111111111111111111111111111111112";
const PublicKeyCtor = PublicKey as unknown as SolanaPublicKeyCtor;

const rules = {
  publishableKey: TEST_KEY,
  programId: PROGRAM_ID,
  PublicKey: PublicKeyCtor,
};

function buyUrl(host: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `https://${host}/?${query}`;
}

test("published MoonPay vector signs the query string including the leading ?", async () => {
  assert.equal(new URL(DOCS_URL).search, DOCS_QUERY);
  const signature = await signMoonPayQuery(DOCS_QUERY, DOCS_SECRET);
  assert.equal(signature, DOCS_SIGNATURE);
  assert.equal(signature.includes("+"), true);
  assert.equal(signature.includes("/"), true);
  assert.equal(decodeURIComponent(signature), signature);
});

test("ethereum mainnet signs only usdc sent to the dao address", () => {
  const ok = validateMoonPaySignUrl(
    {
      url: buyUrl("buy-sandbox.moonpay.com", {
        apiKey: TEST_KEY,
        currencyCode: "usdc",
        walletAddress: EVM_DAO.toUpperCase().replace("0X", "0x"),
        externalTransactionId: EVM_DAO,
      }),
      daoAddress: EVM_DAO,
      chainId: 1,
    },
    rules,
  );
  assert.equal(ok.ok, true);

  const wrongWallet = validateMoonPaySignUrl(
    {
      url: buyUrl("buy-sandbox.moonpay.com", {
        apiKey: TEST_KEY,
        currencyCode: "usdc",
        walletAddress: "0x1111111111111111111111111111111111111111",
        externalTransactionId: EVM_DAO,
      }),
      daoAddress: EVM_DAO,
      chainId: 1,
    },
    rules,
  );
  assert.deepEqual(wrongWallet, { ok: false, error: "Wallet does not match this treasury" });

  const wrongExternalId = validateMoonPaySignUrl(
    {
      url: buyUrl("buy-sandbox.moonpay.com", {
        apiKey: TEST_KEY,
        currencyCode: "usdc",
        walletAddress: EVM_DAO,
        externalTransactionId: "0x1111111111111111111111111111111111111111",
      }),
      daoAddress: EVM_DAO,
      chainId: 1,
    },
    rules,
  );
  assert.deepEqual(wrongExternalId, { ok: false, error: "externalTransactionId must be the treasury address" });

  const wrongCurrency = validateMoonPaySignUrl(
    {
      url: buyUrl("buy-sandbox.moonpay.com", {
        apiKey: TEST_KEY,
        currencyCode: "usdc_base",
        walletAddress: EVM_DAO,
        externalTransactionId: EVM_DAO,
      }),
      daoAddress: EVM_DAO,
      chainId: 1,
    },
    rules,
  );
  assert.deepEqual(wrongCurrency, { ok: false, error: "Currency does not match this treasury" });
});

test("base mainnet requires usdc_base and a live key stays on buy.moonpay.com", () => {
  const sandboxOnLiveHost = validateMoonPaySignUrl(
    {
      url: buyUrl("buy.moonpay.com", {
        apiKey: TEST_KEY,
        currencyCode: "usdc_base",
        walletAddress: EVM_DAO,
        externalTransactionId: EVM_DAO,
      }),
      daoAddress: EVM_DAO,
      chainId: 8453,
    },
    rules,
  );
  assert.deepEqual(sandboxOnLiveHost, { ok: false, error: "MoonPay host does not match the key" });

  const live = validateMoonPaySignUrl(
    {
      url: buyUrl("buy.moonpay.com", {
        apiKey: LIVE_KEY,
        currencyCode: "usdc_base",
        walletAddress: EVM_DAO.toLowerCase(),
        externalTransactionId: EVM_DAO,
      }),
      daoAddress: EVM_DAO,
      chainId: 8453,
    },
    { ...rules, publishableKey: LIVE_KEY },
  );
  assert.equal(live.ok, true);

  const liveOnSandbox = validateMoonPaySignUrl(
    {
      url: buyUrl("buy-sandbox.moonpay.com", {
        apiKey: LIVE_KEY,
        currencyCode: "usdc_base",
        walletAddress: EVM_DAO,
        externalTransactionId: EVM_DAO,
      }),
      daoAddress: EVM_DAO,
      chainId: 8453,
    },
    { ...rules, publishableKey: LIVE_KEY },
  );
  assert.deepEqual(liveOnSandbox, { ok: false, error: "MoonPay host does not match the key" });
});

test("apiKey, host, and unsupported chains are rejected", () => {
  const mismatch = validateMoonPaySignUrl(
    {
      url: buyUrl("buy-sandbox.moonpay.com", {
        apiKey: "pk_test_other",
        currencyCode: "usdc",
        walletAddress: EVM_DAO,
        externalTransactionId: EVM_DAO,
      }),
      daoAddress: EVM_DAO,
      chainId: 1,
    },
    rules,
  );
  assert.deepEqual(mismatch, { ok: false, error: "apiKey does not match" });

  const foreignHost = validateMoonPaySignUrl(
    {
      url: buyUrl("buy.moonpay.com.evil.example", {
        apiKey: TEST_KEY,
        currencyCode: "usdc",
        walletAddress: EVM_DAO,
        externalTransactionId: EVM_DAO,
      }),
      daoAddress: EVM_DAO,
      chainId: 1,
    },
    rules,
  );
  assert.equal(foreignHost.ok, false);

  for (const chainId of [11155111, 84532, 4663, 46630, 5042002, 0]) {
    const rejected = validateMoonPaySignUrl(
      {
        url: buyUrl("buy-sandbox.moonpay.com", {
          apiKey: TEST_KEY,
          currencyCode: "usdc",
          walletAddress: EVM_DAO,
          externalTransactionId: EVM_DAO,
        }),
        daoAddress: EVM_DAO,
        chainId,
      },
      rules,
    );
    assert.deepEqual(rejected, { ok: false, error: "Unsupported chain" });
  }

  const evmWithoutChain = validateMoonPaySignUrl(
    {
      url: buyUrl("buy-sandbox.moonpay.com", {
        apiKey: TEST_KEY,
        currencyCode: "usdc_sol",
        walletAddress: EVM_DAO,
        externalTransactionId: EVM_DAO,
      }),
      daoAddress: EVM_DAO,
      chainId: null,
    },
    rules,
  );
  assert.deepEqual(evmWithoutChain, { ok: false, error: "EVM treasury requires chain id 1 or 8453" });
});

test("solana mainnet signs only usdc_sol sent to the vault authority PDA", () => {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), new PublicKey(SOL_DAO).toBytes()],
    new PublicKey(PROGRAM_ID),
  );
  const vault = pda.toBase58();
  assert.equal(deriveVaultAuthorityAddress(SOL_DAO, PROGRAM_ID, PublicKeyCtor), vault);

  const ok = validateMoonPaySignUrl(
    {
      url: buyUrl("buy-sandbox.moonpay.com", {
        apiKey: TEST_KEY,
        currencyCode: MOONPAY_CURRENCY.solana,
        walletAddress: vault,
        externalTransactionId: SOL_DAO,
      }),
      daoAddress: SOL_DAO,
      chainId: null,
    },
    rules,
  );
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.query.startsWith("?"), true);

  const daoAsWallet = validateMoonPaySignUrl(
    {
      url: buyUrl("buy-sandbox.moonpay.com", {
        apiKey: TEST_KEY,
        currencyCode: "usdc_sol",
        walletAddress: SOL_DAO,
        externalTransactionId: SOL_DAO,
      }),
      daoAddress: SOL_DAO,
      chainId: null,
    },
    rules,
  );
  assert.deepEqual(daoAsWallet, { ok: false, error: "Wallet does not match this treasury" });
});

test("webhook signature covers timestamp plus the raw body", async () => {
  const raw = JSON.stringify({
    type: "transaction_updated",
    data: { status: "completed", externalTransactionId: SOL_DAO, cryptoTransactionId: "sig", currency: { code: "usdc_sol" } },
  });
  const headerTime = "1492774577";
  const mac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("whsec_test"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode(`${headerTime}.${raw}`)),
  );
  const hex = [...signed].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const header = `t=${headerTime},s=${hex}`;
  assert.equal(await moonpayWebhookSignatureValid(header, raw, "whsec_test"), true);
  assert.equal(await moonpayWebhookSignatureValid(header, `${raw} `, "whsec_test"), false);
  assert.equal(await moonpayWebhookSignatureValid(null, raw, "whsec_test"), false);
  assert.equal(await moonpayWebhookSignatureValid("t=1,s=abcd", raw, "whsec_test"), false);
  assert.deepEqual(chainForMoonPayCurrency("usdc_base"), { chain: "base", chain_id: 8453 });
});
