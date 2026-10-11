/**
 * Product names for the four agents.
 *
 * Wire roles, key slots, and on-chain discriminants are unchanged:
 *   executive → Executive
 *   financial → Financial
 *   oversight → Operational   (final multisig signer, role index 2)
 *   operational → Oversight   (monitor / halt, role index 3)
 *
 * The pipeline is still Executive → Financial → Operational → Oversight.
 * Only the last two labels differ from the stored role keys.
 */
const AGENT_ROLE_LABELS: Record<string, string> = {
  executive: 'Executive',
  financial: 'Financial',
  oversight: 'Operational',
  operational: 'Oversight',
  planner: 'Planner',
  guardian: 'Guardian',
};

export function agentRoleLabel(role: string | null | undefined): string {
  if (!role) return '';
  const key = role.trim().toLowerCase();
  return AGENT_ROLE_LABELS[key] ?? role.charAt(0).toUpperCase() + role.slice(1);
}
