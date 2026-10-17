// Caller credentials for the signer service. The signer accepts a per-role
// secret (NAVE_SIGNER_SECRET_<ROLE>) for each signing role; when one is set,
// the shared NAVE_SIGNER_SECRET no longer authorizes that role. Mirrors
// signer-service/src/roleAuth.ts.

export type SignerRole = "executive" | "financial" | "oversight" | "operational" | "guardian";

const EVM_RELAY_ROLE: Record<string, SignerRole> = {
  executive_approve: "executive",
  financial_approve: "financial",
  oversight_approve: "oversight",
  operational_halt: "operational",
  operational_clear: "operational",
  expire_request: "operational",
  execute_strategy: "executive",
  execute_strategy_direct: "executive",
  withdraw_from_strategy: "executive",
  create_bridge_request: "financial",
  bridge_outbound: "executive",
  toggle_agents: "guardian",
  update_strategy_position_value: "operational",
  revalue_treasury: "operational",
  create_proposal: "operational",
  create_strategy_request: "operational",
  finalize_proposal: "operational",
};

/** Role whose EVM key signs a /relay-evm action. */
export function evmRelaySignerRole(action: string): SignerRole | null {
  return EVM_RELAY_ROLE[action] ?? null;
}

/** Credential role for a Solana /sign request; the planner proposes as Operational. */
export function solanaSignerRole(agentRole: string | undefined): SignerRole | null {
  if (agentRole === "planner") return "operational";
  if (
    agentRole === "executive" || agentRole === "financial" ||
    agentRole === "oversight" || agentRole === "operational"
  ) {
    return agentRole;
  }
  return null;
}

/** Secret to send as X-Signer-Secret for `role`, or null if none is configured. */
export function signerSecretFor(role: SignerRole | null): string | null {
  if (role) {
    const roleSecret = Deno.env.get(`NAVE_SIGNER_SECRET_${role.toUpperCase()}`);
    if (roleSecret) return roleSecret;
  }
  return Deno.env.get("NAVE_SIGNER_SECRET") ?? null;
}
