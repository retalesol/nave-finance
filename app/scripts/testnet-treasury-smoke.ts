/**
 * Testnet treasury smoke. Checks the definition-of-done items that do not
 * need a new broadcast. It does not send transactions.
 *
 *   npx tsx scripts/testnet-treasury-smoke.ts
 *   npx tsx scripts/testnet-treasury-smoke.ts --chain ethereum
 *
 * Chains: solana, ethereum, base, robinhood, arc
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userChainsFor, EVM_CHAIN_IDS } from "../src/lib/chain/types.ts";
import { scoreEvmTestnetOpportunities } from "../supabase/functions/_shared/yieldSources.ts";
import {
  NAVE_GENLAYER_GATE,
  NAVE_GENLAYER_HALT_GATE,
  NAVE_GENLAYER_VENUE_GATE,
  charterGateOutcome,
  readGenlayerFlag,
} from "../supabase/functions/_shared/genlayerCharter.ts";
import { daoNetworkFor, registryNetworkFor } from "../supabase/functions/_shared/chain.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const REPO = resolve(APP, "..");

const CHAINS = ["solana", "ethereum", "base", "robinhood", "arc"] as const;
type SmokeChain = (typeof CHAINS)[number];

const CANONICAL_WNAVE: Partial<Record<SmokeChain, { chainId: number; address: string; file: string }>> = {
  ethereum: {
    chainId: 11155111,
    address: "0x1d1d988e8ffE542f1f8F7932DE3A634251D4A042",
    file: "contracts/ethereum/sepolia/canonical-wnave.json",
  },
  base: {
    chainId: 84532,
    address: "0xC286e67D59F643a725cf4998af6Bb4f8D1354280",
    file: "contracts/base/sepolia/canonical-wnave.json",
  },
  robinhood: {
    chainId: 46630,
    address: "0x7860FF876b49a5A992a7F3a4a6043ea57f17eD96",
    file: "contracts/robinhood/testnet/canonical-wnave.json",
  },
};

const FACTORY_FILES: Partial<Record<SmokeChain, string>> = {
  ethereum: "contracts/ethereum/sepolia/11155111.json",
  base: "contracts/base/sepolia/84532.json",
  robinhood: "contracts/robinhood/testnet/46630.json",
  arc: "contracts/arc/testnet/5042002.json",
};

const CLOSED_SOLANA_BRIDGE = "Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6";
const GENLAYER_ACCOUNT = "0xb82acb2eb8a1c76805b6fac55cfc8797f00fcc10";
const SEPOLIA_AAVE = "0xFfFDfc7DEfbfaF64c232897452Aa6E6F92809426";
const SEPOLIA_COMPOUND = "0x845d8310A861A95Ed1644643D1BAe086944B1AA0";
const BASE_SEPOLIA_AAVE = "0x33D19799EBac88FFDc4e5BF61c199c71963470A6";

const failures: string[] = [];
const skips: string[] = [];

function fail(chain: string, message: string) {
  failures.push(`${chain}: ${message}`);
  console.error(`FAIL  ${chain}: ${message}`);
}

function ok(chain: string, message: string) {
  console.log(`ok    ${chain}: ${message}`);
}

function skip(chain: string, message: string) {
  skips.push(`${chain}: ${message}`);
  console.log(`skip  ${chain}: ${message}`);
}

function readJson(rel: string): Record<string, unknown> | null {
  const path = resolve(REPO, rel);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function envExampleHas(address: string): boolean {
  const text = readFileSync(resolve(APP, ".env.example"), "utf8");
  return text.toLowerCase().includes(address.toLowerCase());
}

function deployerKeyPresent(): boolean {
  const names = ["DEPLOYER_PRIVATE_KEY", "PRIVATE_KEY", "EVM_PRIVATE_KEY", "SAFE_OWNER_PRIVATE_KEY"];
  return names.some((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function solanaWalletPresent(): boolean {
  const names = ["SOLANA_KEYPAIR", "ANCHOR_WALLET", "SOLANA_DEVNET_KEYPAIR"];
  return names.some((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function checkPicker(chain: SmokeChain) {
  const testnet = userChainsFor("testnet");
  const mainnet = userChainsFor("mainnet");
  if (!testnet.includes(chain)) {
    fail(chain, "testnet create picker does not include this family");
    return;
  }
  ok(chain, "testnet create picker includes this family");
  if (chain !== "base" && mainnet.includes(chain)) {
    fail(chain, "mainnet picker includes this family; it should stay Base observe-only");
  }
  if ((EVM_CHAIN_IDS as readonly number[]).includes(5042)) {
    fail(chain, "Arc mainnet chain id 5042 is in the app chain list");
  }
}

function checkCanonical(chain: SmokeChain) {
  const spec = CANONICAL_WNAVE[chain];
  if (!spec) {
    if (chain === "arc") {
      ok(chain, "no canonical wNAVE is published for Arc Testnet; none is invented");
    } else if (chain === "solana") {
      const devnet = readJson("contracts/solana/deployments/devnet.json");
      const programs = devnet?.programs as Record<string, string> | undefined;
      const core = programs?.nave_core;
      if (core === "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB") {
        ok(chain, "devnet nave_core resolves to 8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB");
      } else {
        fail(chain, `devnet nave_core did not resolve (got ${core ?? "missing"})`);
      }
      if (core === CLOSED_SOLANA_BRIDGE) {
        fail(chain, "closed Solana bridge was treated as nave_core");
      }
    }
    return;
  }
  const artifact = readJson(spec.file);
  const wrapped = typeof artifact?.wrappedNave === "string" ? artifact.wrappedNave : "";
  if (wrapped.toLowerCase() !== spec.address.toLowerCase()) {
    fail(chain, `canonical wNAVE artifact ${spec.file} is ${wrapped || "missing"}, expected ${spec.address}`);
    return;
  }
  if (!envExampleHas(spec.address)) {
    fail(chain, `.env.example does not point wrapped NAVE at ${spec.address}`);
    return;
  }
  ok(chain, `canonical wNAVE resolves to ${spec.address}`);
}

function checkYield(chain: SmokeChain) {
  if (chain === "solana") {
    ok(chain, "Solana yield stays on the existing builtin venues; execute_strategy escrow is not scored as live yield");
    return;
  }
  if (chain === "ethereum") {
    const scored = scoreEvmTestnetOpportunities(
      [
        { protocolId: "aave", programId: SEPOLIA_AAVE },
        { protocolId: "compound", programId: SEPOLIA_COMPOUND },
      ],
      "ethereum",
      11155111,
    );
    const sources = scored.map((row) => row.source ?? "");
    if (sources.length !== 2 || !sources.every((source) => source.startsWith("testnet-rate:"))) {
      fail(chain, `expected Aave V3 and Compound V3 testnet rates, got ${sources.join(", ") || "nothing"}`);
      return;
    }
    const mainnet = scoreEvmTestnetOpportunities(
      [{ protocolId: "aave", programId: SEPOLIA_AAVE }],
      "ethereum",
      1,
    );
    if (mainnet.length !== 0) fail(chain, "Ethereum mainnet received testnet rates");
    else ok(chain, "Sepolia scores Aave V3 and Compound V3 as testnet rates");
    return;
  }
  if (chain === "base") {
    const scored = scoreEvmTestnetOpportunities([{ protocolId: "aave", programId: "" }], "base", 84532);
    if (scored[0]?.source !== "testnet-rate:aave-v3" || scored[0].programId !== BASE_SEPOLIA_AAVE || !scored[0].liquid) {
      fail(chain, `Base Sepolia Aave did not score the deployed adapter ${BASE_SEPOLIA_AAVE}`);
      return;
    }
    ok(chain, `Base Sepolia Aave V3 scores ${BASE_SEPOLIA_AAVE}`);
    return;
  }
  const chainId = chain === "robinhood" ? 46630 : 5042002;
  const scored = scoreEvmTestnetOpportunities([{ protocolId: "cctp", programId: "" }], chain, chainId);
  const source = scored[0]?.source ?? "";
  if (scored.length !== 1 || !source.startsWith("testnet-rate:cctp-to-sepolia-aave-v3")) {
    fail(chain, `expected a CCTP-to-Sepolia Aave V3 testnet rate, got ${source || "nothing"}`);
    return;
  }
  if (chain === "robinhood" && scored[0].mint) {
    fail(chain, "Robinhood score invented a USDC address");
    return;
  }
  if (chain === "arc" && scored[0].mint?.toLowerCase() !== "0x3600000000000000000000000000000000000000") {
    fail(chain, "Arc score did not use the published USDC address");
    return;
  }
  ok(chain, "CCTP-to-Sepolia Aave V3 is scored as a testnet rate");
}

function checkGates(chain: SmokeChain) {
  const flags = [NAVE_GENLAYER_GATE, NAVE_GENLAYER_VENUE_GATE, NAVE_GENLAYER_HALT_GATE];
  const on = flags.filter((name) => readGenlayerFlag(name));
  if (on.length > 0) {
    fail(chain, `${on.join(", ")} is true. Gates stay off: no finalized Bradbury charter case, and ${GENLAYER_ACCOUNT} has 0 GEN.`);
    return;
  }
  const missing = charterGateOutcome({
    gateOn: false,
    signing: true,
    expectedActionHash: "ab".repeat(32),
    charter: null,
  });
  if (missing.block || !missing.recordedOnly) {
    fail(chain, "a missing charter review blocked signing while the gate is off");
    return;
  }
  ok(chain, `GenLayer gates are off. A missing charter review does not block (${missing.detail}).`);
}

function checkRegistry(chain: SmokeChain) {
  if (chain === "solana") {
    const network = registryNetworkFor({ chain: "solana", chain_id: null }, "devnet", true);
    if (network !== "devnet") {
      fail(chain, `Solana devnet register stored ${network}`);
      return;
    }
    ok(chain, "Solana devnet register stores network=devnet even if the edge RPC looks like mainnet");
    return;
  }
  const chainId = chain === "ethereum" ? 11155111 : chain === "base" ? 84532 : chain === "robinhood" ? 46630 : 5042002;
  const network = daoNetworkFor({ chain, chain_id: chainId }, true);
  if (network !== "testnet") {
    fail(chain, `register would store network=${network} for chain id ${chainId}`);
    return;
  }
  ok(chain, `register stores network=testnet for chain id ${chainId}`);
}

function checkLive(chain: SmokeChain) {
  if (chain === "solana") {
    const wallet = solanaWalletPresent()
      ? "A Solana key path is set, but this smoke does not sign."
      : "No devnet wallet is configured (SOLANA_KEYPAIR / ANCHOR_WALLET / SOLANA_DEVNET_KEYPAIR).";
    skip(
      chain,
      `${wallet} Live create, deposit, and the venue CPI need a funded devnet wallet. execute_strategy escrow is not live yield. The closed bridge ${CLOSED_SOLANA_BRIDGE} is not used.`,
    );
    return;
  }
  const factoryFile = FACTORY_FILES[chain];
  const factoryArtifact = factoryFile ? readJson(factoryFile) : null;
  const factory = typeof factoryArtifact?.factory === "string" ? factoryArtifact.factory : "";
  const keyNote = deployerKeyPresent()
    ? "A deployer key name is set in the environment, but this smoke does not broadcast."
    : "No deployer key is in the environment.";
  if (!factory) {
    skip(chain, `${keyNote} Factory artifact ${factoryFile} has no factory address, so live create, deposit, and execute are skipped.`);
    return;
  }
  const note = chain === "robinhood"
    ? " USDC is unpublished, and there is no CCTP adapter. Forming a treasury does not lock NAVE."
    : chain === "arc"
      ? " CCTP to Sepolia is deployed. Arc mainnet 5042 is not in scope. Forming a treasury does not lock NAVE."
      : chain === "base"
        ? " Aave V3 is approved. Forming a treasury does not lock NAVE."
        : " Aave V3, Compound V3, and CCTP are approved. Forming a treasury does not lock NAVE.";
  skip(chain, `${keyNote} Factory ${factory} is recorded. Live create, deposit, vote, and execute from a wallet are skipped.${note}`);
}

function checkChain(chain: SmokeChain) {
  console.log(`\n${chain}`);
  checkPicker(chain);
  checkCanonical(chain);
  checkYield(chain);
  checkGates(chain);
  checkRegistry(chain);
  checkLive(chain);
}

function selectedChains(): SmokeChain[] {
  const eq = process.argv.find((item) => item.startsWith("--chain="));
  const flag = process.argv.indexOf("--chain");
  const value = eq ? eq.slice("--chain=".length) : flag === -1 ? "all" : process.argv[flag + 1];
  if (!value || value === "all") return [...CHAINS];
  if ((CHAINS as readonly string[]).includes(value)) return [value as SmokeChain];
  console.error(`Unknown chain ${value}. Use solana, ethereum, base, robinhood, arc, or all.`);
  process.exit(1);
}

const bradbury = readJson("contracts/genlayer/deployments/bradbury.json");
console.log("GenLayer gates stay off.");
console.log(`Bradbury deployed=${String(bradbury?.deployed)}. Account ${GENLAYER_ACCOUNT} balance: ${String(bradbury?.balance ?? "0 GEN")}.`);
console.log("No finalized Bradbury charter case exists, so NAVE_GENLAYER_GATE, NAVE_GENLAYER_VENUE_GATE, and NAVE_GENLAYER_HALT_GATE stay unset.");

for (const chain of selectedChains()) checkChain(chain);

console.log(`\n${failures.length} failed, ${skips.length} skipped.`);
if (failures.length > 0) {
  process.exitCode = 1;
}
