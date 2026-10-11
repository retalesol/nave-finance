/**
 * Fund the three EVM testing keys and three Solana guardian wallets.
 * Reads secrets from gitignored env files and prints addresses only.
 *
 *   node scripts/fund-test-wallets.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, baseSepolia } from "viem/chains";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const EVM_ENV = resolve(ROOT, "contracts/evm/.env.testnet.local");
const SOL_ENV = resolve(ROOT, "contracts/solana/.env.testnet.local");
const SOL_WALLET = resolve(ROOT, "contracts/solana/.deploy-wallet-devnet.json");
const SOL_DIR = resolve(ROOT, "contracts/solana/wallets");
const BASE_L1_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";
const BRIDGE_ABI = [
  {
    type: "function",
    name: "bridgeETH",
    stateMutability: "payable",
    inputs: [
      { name: "_minGasLimit", type: "uint32" },
      { name: "_extraData", type: "bytes" },
    ],
    outputs: [],
  },
];

function parseEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function asKey(value) {
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("expected a 32-byte hex key");
  return hex;
}

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function sendNative(wallet, publicClient, to, value) {
  const hash = await wallet.sendTransaction({ to, value });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`transfer reverted ${hash}`);
  console.log(`  sent ${formatEther(value)} -> ${to} ${hash}`);
  return hash;
}

async function main() {
  const evmEnv = parseEnv(EVM_ENV);
  const solEnv = parseEnv(SOL_ENV);
  const founder = privateKeyToAccount(asKey(evmEnv.EVM_DEPLOY_PRIVATE_KEY));
  const testers = [1, 2, 3].map((n) =>
    privateKeyToAccount(asKey(evmEnv[`EVM_TESTING_KEY_${n}`])),
  );
  console.log("founder", founder.address);
  testers.forEach((account, i) => console.log(`guardian ${i + 1}`, account.address));

  const sepoliaClient = createPublicClient({ chain: sepolia, transport: http(evmEnv.EVM_SEPOLIA_RPC_URL) });
  const baseClient = createPublicClient({ chain: baseSepolia, transport: http(evmEnv.EVM_BASE_SEPOLIA_RPC_URL) });
  const robinhood = defineChain({
    id: 46630,
    name: "Robinhood Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [evmEnv.EVM_ROBINHOOD_TESTNET_RPC_URL] } },
  });
  const arc = defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [evmEnv.EVM_ARC_TESTNET_RPC_URL] } },
  });
  const rhClient = createPublicClient({ chain: robinhood, transport: http(evmEnv.EVM_ROBINHOOD_TESTNET_RPC_URL) });
  const arcClient = createPublicClient({ chain: arc, transport: http(evmEnv.EVM_ARC_TESTNET_RPC_URL) });

  const founderSepolia = createWalletClient({
    account: founder,
    chain: sepolia,
    transport: http(evmEnv.EVM_SEPOLIA_RPC_URL),
  });
  for (const account of testers) {
    const balance = await sepoliaClient.getBalance({ address: account.address });
    if (balance >= parseEther("0.05")) {
      console.log(`sepolia ${account.address} already ${formatEther(balance)}`);
      continue;
    }
    await sendNative(founderSepolia, sepoliaClient, account.address, parseEther("0.08"));
  }

  console.log("bridging 0.03 ETH from each guardian Sepolia -> Base");
  for (const account of testers) {
    const onBase = await baseClient.getBalance({ address: account.address });
    if (onBase >= parseEther("0.01")) {
      console.log(`base ${account.address} already ${formatEther(onBase)}`);
      continue;
    }
    const wallet = createWalletClient({
      account,
      chain: sepolia,
      transport: http(evmEnv.EVM_SEPOLIA_RPC_URL),
    });
    const hash = await wallet.writeContract({
      address: BASE_L1_BRIDGE,
      abi: BRIDGE_ABI,
      functionName: "bridgeETH",
      args: [200_000, "0x"],
      value: parseEther("0.03"),
    });
    const receipt = await sepoliaClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`bridge reverted ${hash}`);
    console.log(`  bridge ${account.address} ${hash}`);
  }

  const founderRh = createWalletClient({
    account: founder,
    chain: robinhood,
    transport: http(evmEnv.EVM_ROBINHOOD_TESTNET_RPC_URL),
  });
  for (const account of testers) {
    const balance = await rhClient.getBalance({ address: account.address });
    if (balance >= parseEther("0.008")) {
      console.log(`robinhood ${account.address} already ${formatEther(balance)}`);
      continue;
    }
    await sendNative(founderRh, rhClient, account.address, parseEther("0.012"));
  }

  const founderArc = createWalletClient({
    account: founder,
    chain: arc,
    transport: http(evmEnv.EVM_ARC_TESTNET_RPC_URL),
  });
  const arcDust = 400_000_000_000_000_000n; // 0.4 native USDC
  for (const account of testers) {
    const balance = await arcClient.getBalance({ address: account.address });
    if (balance >= arcDust / 2n) {
      console.log(`arc ${account.address} already ${formatEther(balance)}`);
      continue;
    }
    await sendNative(founderArc, arcClient, account.address, arcDust);
  }

  console.log("waiting for Base deposits");
  const deadline = Date.now() + 12 * 60 * 1000;
  let pending = testers.map((account) => account.address);
  while (pending.length && Date.now() < deadline) {
    const still = [];
    for (const address of pending) {
      const balance = await baseClient.getBalance({ address });
      if (balance >= parseEther("0.01")) console.log(`base ${address} ${formatEther(balance)}`);
      else still.push(address);
    }
    pending = still;
    if (pending.length) await sleep(15_000);
  }
  if (pending.length) throw new Error(`Base deposit still pending for ${pending.join(", ")}`);

  const rpc = solEnv.SOLANA_DEVNET_RPC || solEnv.RPC;
  const connection = new Connection(rpc, "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(SOL_WALLET, "utf8"))));
  mkdirSync(SOL_DIR, { recursive: true });
  const guardians = [];
  for (let i = 1; i <= 3; i++) {
    const path = resolve(SOL_DIR, `guardian-${i}.json`);
    let keypair;
    if (existsSync(path)) {
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
    } else {
      keypair = Keypair.generate();
      writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
      chmodSync(path, 0o600);
    }
    guardians.push(keypair);
    console.log(`solana guardian ${i}`, keypair.publicKey.toBase58());
  }
  for (const keypair of guardians) {
    const balance = await connection.getBalance(keypair.publicKey);
    if (balance >= 0.5 * LAMPORTS_PER_SOL) {
      console.log(`solana ${keypair.publicKey.toBase58()} already ${balance / LAMPORTS_PER_SOL}`);
      continue;
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: keypair.publicKey,
        lamports: LAMPORTS_PER_SOL,
      }),
    );
    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  sent 1 SOL -> ${keypair.publicKey.toBase58()} ${sig}`);
  }
  console.log("funding complete");
}

main().catch((error) => {
  console.error(error?.shortMessage || error?.message || error);
  process.exit(1);
});
