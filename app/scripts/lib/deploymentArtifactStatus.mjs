/**
 * Refusal for deployment JSON that must not be treated as live.
 * Keep in sync with nave-contracts contracts/evm/script/lib/deploymentArtifactStatus.mjs
 * and contracts/evm/deployments/deployment-artifact.schema.json.
 */

/** Anvil's default account 0. deployments/1.json was written by a local fixture. */
export const ANVIL_DEFAULT_AUTHORITY = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

/**
 * Closed Solana mainnet program ids. `solana program deploy` cannot reuse them.
 * A future bridge/staking pair needs new ids.
 */
export const CLOSED_MAINNET_SOLANA_PROGRAM_IDS = {
  nave_bridge: "Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6",
  nave_staking: "AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf",
};

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

/**
 * Sync half of the bridge-program gate. Returns an error message when the
 * configured id is absent or is a known-closed mainnet id. Returns null when
 * an RPC liveness read is still required.
 *
 * @param {{ bridgeConfigured: boolean, bridgeProgramId: string, stakingProgramId: string }} input
 * @returns {string | null}
 */
export function solanaBridgeProgramConfigRefusal(input) {
  if (!input.bridgeConfigured) return null;
  const bridgeProgramId = (input.bridgeProgramId || "").trim();
  const stakingProgramId = (input.stakingProgramId || "").trim();
  if (!bridgeProgramId) {
    return (
      "Bridge env is set but the Solana nave_bridge program id is missing " +
      "(BRIDGE_SOLANA_BRIDGE_PROGRAM / VITE_NAVE_BRIDGE_PROGRAM_ID). " +
      "Cutover refuses to wire the bridge until a new program id is deployed and executable. " +
      `The closed mainnet id ${CLOSED_MAINNET_SOLANA_PROGRAM_IDS.nave_bridge} must not be reused.`
    );
  }
  if (bridgeProgramId === CLOSED_MAINNET_SOLANA_PROGRAM_IDS.nave_bridge) {
    return (
      `BRIDGE_SOLANA_BRIDGE_PROGRAM is the closed mainnet nave_bridge ${bridgeProgramId}. ` +
      "That program account cannot be redeployed. Configure a new program id."
    );
  }
  if (stakingProgramId === CLOSED_MAINNET_SOLANA_PROGRAM_IDS.nave_staking) {
    return (
      `BRIDGE_SOLANA_STAKING_PROGRAM is the closed mainnet nave_staking ${stakingProgramId}. ` +
      "That program account cannot be redeployed. Configure a new program id."
    );
  }
  return null;
}
