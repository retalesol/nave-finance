/**
 * Refusal for deployment JSON that must not be treated as live.
 * Status vocabulary: evm/deployments/deployment-artifact.schema.json
 * app/scripts/lib/deploymentArtifactStatus.mjs keeps the same check.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Anvil's default account 0. deployments/1.json was written by a local fixture. */
export const ANVIL_DEFAULT_AUTHORITY = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

/**
 * @param {unknown} artifact
 * @returns {string | null} Why the artifact must not be wired, or null if it may be treated as production.
 */
export function deploymentWireRefusal(artifact) {
  if (!artifact || typeof artifact !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (artifact);
  const status = typeof record.status === "string" ? record.status : "";
  if (record.wireable === false || record.production === false) {
    return status || "marked not wireable";
  }
  if (/do-not-wire|anvil-fixture|not-production/i.test(status)) return status;
  if (record.daoStack === "undeployed") return "daoStack undeployed";
  const authority = String(record.authority || "").toLowerCase();
  if (authority === ANVIL_DEFAULT_AUTHORITY) return "anvil default authority";
  return null;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node script/lib/deploymentArtifactStatus.mjs <deployment.json>");
    process.exit(2);
  }
  const artifact = JSON.parse(readFileSync(target, "utf8"));
  const reason = deploymentWireRefusal(artifact);
  if (reason) {
    console.error(`Refusing to treat ${target} as production (${reason}).`);
    console.error("Do not broadcast or wire these addresses. Chain 1 DAO cutover needs a real artifact, not the Anvil fixture.");
    process.exit(1);
  }
}
