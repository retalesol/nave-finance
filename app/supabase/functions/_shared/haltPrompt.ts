// Pure prompt text for the Oversight role when the request is already Halted
// on chain. No Deno imports so Node tests can load it. It adds wording only:
// the confidence threshold, the guardrails, and what counts as a halt cause are
// decided elsewhere and are not touched here.

export function isHaltedStatus(requestStatus: string | null | undefined): boolean {
  return (requestStatus ?? "").trim().toLowerCase() === "halted";
}

/** Context section for a Halted request; "" for any other status. */
export function haltedRequestNotice(
  requestStatus: string | null | undefined,
  haltCauses?: readonly string[] | null,
): string {
  if (!isHaltedStatus(requestStatus)) return "";
  const causes = (haltCauses ?? []).map((c) => c.trim()).filter(Boolean);
  const causeLine = causes.length > 0
    ? `Causes recorded with the halt: ${causes.join("; ")}.`
    : "No deterministic halt causes were recorded with this halt.";
  return `## Request Status: HALTED
This request is currently HALTED on chain. It will not execute while halted.
The question for you is whether the halt is still warranted given the current guardrails and facts above.
${causeLine}
- Return decision "clear_halt" with should_clear_halt true only when every guardrail passes and no halt cause remains.
- Otherwise return "continue" or "request_review" with a short reason that says which guardrail or halt cause still stands (or what is missing).
- Do not clear a halt because the request looks compliant in general; address the halt itself.
`;
}

/** Extra system-prompt paragraph for the Oversight role. */
export const HALTED_SYSTEM_PROMPT_NOTE = `If the context says the request is HALTED, it is blocked on chain right now. Decide only whether that halt is still warranted: answer "clear_halt" (should_clear_halt true) only when every guardrail passes and no halt cause remains; otherwise answer "continue" or "request_review" and state the reason. Confidence thresholds and guardrails are unchanged.`;
