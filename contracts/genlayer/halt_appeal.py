# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""HaltAppeal is a second check: keep a pause, or say it can be lifted.

Lifting here does not move funds, does not shorten the review window, and does
not replace the Operational key on the treasury chain. The contract stores
keep_pause or lift_pause plus one sentence. It does not hold treasury tokens,
and it does not accept a prewritten decision as evidence.
"""

from genlayer import *
from dataclasses import dataclass

ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"
ERROR_LLM = "[LLM_ERROR]"

SCORE_TOLERANCE = 15

HALT_SUMMARY = {
    "keep_pause": "The pause stays until this is looked at again.",
    "lift_pause": "A second check says the pause can be lifted by the treasury operators.",
}

_VERDICT_TOKENS = (
    "keep_pause",
    "lift_pause",
    "pass",
    "fail",
    "checked",
    "finalized",
    "lift",
    "keep",
)

_BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_HEX = "0123456789abcdef"


@allow_storage
@dataclass
class HaltRecord:
    chain_family: str
    network: str
    treasury: str
    action_hash: str
    decision: str
    summary: str


def _reject_value():
    if int(gl.message.value) != 0:
        raise gl.vm.UserError(ERROR_EXPECTED + " This contract does not hold treasury tokens")


def _handle_leader_error(leaders_res, leader_fn):
    leader_msg = leaders_res.message if hasattr(leaders_res, "message") else ""
    try:
        leader_fn()
        return False
    except gl.vm.UserError as err:
        validator_msg = err.message if hasattr(err, "message") else str(err)
        if validator_msg.startswith(ERROR_EXPECTED) or validator_msg.startswith(ERROR_EXTERNAL):
            return validator_msg == leader_msg
        if validator_msg.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
            return True
        return False
    except Exception:
        return False


def _enum(label, value, allowed):
    if not isinstance(value, str):
        raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " is missing")
    text = value.strip().lower()
    for item in allowed:
        if text == item:
            return text
    raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " is not supported")


def _canonical_hash(label, value):
    if not isinstance(value, str):
        raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " must be a 64-character hex string")
    text = value.strip().lower()
    if text.startswith("0x"):
        text = text[2:]
    if len(text) != 64:
        raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " must be a 64-character hex string")
    for ch in text:
        if ch not in _HEX:
            raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " must be a 64-character hex string")
    return text


def _canonical_treasury(chain_family, treasury):
    if not isinstance(treasury, str):
        raise gl.vm.UserError(ERROR_EXPECTED + " Treasury address is missing")
    text = treasury.strip()
    if chain_family == "solana":
        if len(text) < 32 or len(text) > 44:
            raise gl.vm.UserError(ERROR_EXPECTED + " Treasury address is not a Solana address")
        for ch in text:
            if ch not in _BASE58:
                raise gl.vm.UserError(ERROR_EXPECTED + " Treasury address is not a Solana address")
        return text
    if len(text) != 42 or text[:2].lower() != "0x":
        raise gl.vm.UserError(ERROR_EXPECTED + " Treasury address is not an EVM address")
    hexpart = text[2:].lower()
    for ch in hexpart:
        if ch not in _HEX:
            raise gl.vm.UserError(ERROR_EXPECTED + " Treasury address is not an EVM address")
    return "0x" + hexpart


def _identity(chain_family, network, treasury, action_hash):
    family = _enum("chain_family", chain_family, ("solana", "ethereum", "base", "robinhood"))
    net = _enum("network", network, ("mainnet", "testnet", "devnet"))
    return family, net, _canonical_treasury(family, treasury), _canonical_hash("action_hash", action_hash)


def _case_key(chain_family, network, treasury, action_hash):
    return chain_family + "|" + network + "|" + treasury + "|" + action_hash


def _label(value, label, limit):
    if not isinstance(value, str):
        raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " is missing")
    text = value.strip()
    if text == "" or len(text) > limit or (" " in text):
        raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " is missing")
    return text


def _base_units(label, value):
    if not isinstance(value, str):
        raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " must be a whole number of base units")
    text = value.strip()
    if text == "" or len(text) > 78:
        raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " must be a whole number of base units")
    for ch in text:
        if ch not in "0123456789":
            raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " must be a whole number of base units")
    return int(text)


def _evidence_text(value, label):
    if not isinstance(value, str) or value.strip() == "":
        raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " is missing")
    token = value.strip().lower().replace(" ", "_").replace("-", "_")
    if token in _VERDICT_TOKENS:
        raise gl.vm.UserError(ERROR_EXPECTED + " A prewritten decision is not evidence")
    if len(value.strip()) < 12:
        raise gl.vm.UserError(ERROR_EXPECTED + " " + label + " is missing")
    return value


def _assert_member_sentence(text):
    if text.count(".") != 1 or not text.endswith("."):
        raise gl.vm.UserError(ERROR_EXPECTED + " Summary must be one sentence")
    lowered = " " + text.lower().replace(".", " ") + " "
    for banned in (" finalized ", " equivalence ", " gen "):
        if banned in lowered:
            raise gl.vm.UserError(ERROR_EXPECTED + " Summary is not member language")
    return text


def _as_object(analysis):
    if isinstance(analysis, dict):
        return analysis
    if isinstance(analysis, str):
        start = analysis.find("{")
        end = analysis.rfind("}")
        if start < 0 or end < start:
            raise gl.vm.UserError(ERROR_LLM + " LLM returned no JSON object")
        import json
        try:
            data = json.loads(analysis[start:end + 1])
        except json.JSONDecodeError:
            raise gl.vm.UserError(ERROR_LLM + " LLM returned invalid JSON")
        if not isinstance(data, dict):
            raise gl.vm.UserError(ERROR_LLM + " LLM returned non-dict")
        return data
    raise gl.vm.UserError(ERROR_LLM + " LLM returned non-dict")


def _parse_score(raw):
    if isinstance(raw, bool):
        raise gl.vm.UserError(ERROR_LLM + " Non-integer score")
    if isinstance(raw, int):
        score = raw
    elif isinstance(raw, str) and raw.strip().isdigit():
        score = int(raw.strip())
    else:
        raise gl.vm.UserError(ERROR_LLM + " Non-integer score")
    if score < 0 or score > 100:
        raise gl.vm.UserError(ERROR_LLM + " Score out of range")
    return score


def _parse_halt(analysis):
    data = _as_object(analysis)
    raw = data.get("decision")
    if not isinstance(raw, str):
        raise gl.vm.UserError(ERROR_LLM + " Pause decision missing")
    text = raw.strip().lower().replace(" ", "_").replace("-", "_")
    if text in ("keep_pause", "keep"):
        decision = "keep_pause"
    elif text in ("lift_pause", "lift"):
        decision = "lift_pause"
    else:
        raise gl.vm.UserError(ERROR_LLM + " Pause decision not recognized")
    score_raw = data.get("score")
    if score_raw is None and "confidence" in data:
        score_raw = data["confidence"]
    return decision, _parse_score(score_raw)


def _score_close(left, right):
    if isinstance(left, bool) or not isinstance(left, int):
        return False
    if isinstance(right, bool) or not isinstance(right, int):
        return False
    diff = left - right
    if diff < 0:
        diff = -diff
    return diff <= SCORE_TOLERANCE


class HaltAppeal(gl.Contract):
    """Second check for one paused move. The treasury chain still holds the funds."""

    appeals: TreeMap[str, HaltRecord]

    def __init__(self):
        pass

    def _judge(self, pause_reason, counterevidence, venue, amount, asset):
        def leader_fn():
            prompt = (
                "Decide whether this pause should stay. "
                "Use only the reason and the new evidence. "
                "Do not copy a suggested verdict.\n"
                "Why it was paused: " + pause_reason + "\n"
                "New evidence: " + counterevidence + "\n"
                "Venue: " + venue + "\n"
                "Amount base units: " + amount + "\n"
                "Asset: " + asset + "\n"
                'Return JSON {"decision": "keep_pause" or "lift_pause", "score": 0 to 100}.'
            )
            decision, score = _parse_halt(gl.nondet.exec_prompt(prompt, response_format="json"))
            return {"decision": decision, "score": score}

        def validator_fn(leaders_res):
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)
            data = leaders_res.calldata
            if not isinstance(data, dict):
                return False
            mine = leader_fn()
            if data.get("decision") != mine["decision"]:
                return False
            return _score_close(data.get("score"), mine["score"])

        return gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

    def _view(self, record):
        return {
            "chain_family": record.chain_family,
            "network": record.network,
            "treasury": record.treasury,
            "action_hash": record.action_hash,
            "decision": record.decision,
            "summary": record.summary,
        }

    @gl.public.write
    def open_appeal(
        self,
        chain_family: str,
        network: str,
        treasury: str,
        action_hash: str,
        pause_reason: str,
        counterevidence: str,
        venue: str,
        amount: str,
        asset: str,
    ):
        _reject_value()
        family, net, treas, action = _identity(chain_family, network, treasury, action_hash)
        key = _case_key(family, net, treas, action)
        if key in self.appeals:
            raise gl.vm.UserError(ERROR_EXPECTED + " Appeal already open")

        reason = _evidence_text(pause_reason, "pause_reason")
        venue_name = _label(venue, "venue", 64)
        amount_units = _base_units("amount", amount)
        asset_name = _label(asset, "asset", 64)

        fresh = counterevidence.strip() if isinstance(counterevidence, str) else ""
        if fresh == "":
            decision = "keep_pause"
        else:
            evidence = _evidence_text(counterevidence, "counterevidence")
            judged = self._judge(reason, evidence, venue_name, str(amount_units), asset_name)
            decision = judged["decision"]
        if decision not in HALT_SUMMARY:
            raise gl.vm.UserError(ERROR_LLM + " Pause decision not recognized")
        summary = _assert_member_sentence(HALT_SUMMARY[decision])

        record = gl.storage.inmem_allocate(
            HaltRecord,
            family,
            net,
            treas,
            action,
            decision,
            summary,
        )
        self.appeals[key] = record
        return self._view(self.appeals[key])

    @gl.public.view
    def has_appeal(self, chain_family: str, network: str, treasury: str, action_hash: str) -> bool:
        family, net, treas, action = _identity(chain_family, network, treasury, action_hash)
        return _case_key(family, net, treas, action) in self.appeals

    @gl.public.view
    def get_appeal(self, chain_family: str, network: str, treasury: str, action_hash: str) -> dict:
        family, net, treas, action = _identity(chain_family, network, treasury, action_hash)
        key = _case_key(family, net, treas, action)
        if key not in self.appeals:
            raise gl.vm.UserError(ERROR_EXPECTED + " Appeal not found")
        return self._view(self.appeals[key])
