# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""VenueWatch reads a public status or incident page and stores fine, watch, or stop.

Prices and yields are not evidence. The same contract covers Solana, Ethereum,
Base, and Robinhood. It does not hold treasury tokens, and it does not change
the allowlist on the treasury chain.
"""

from genlayer import *
from dataclasses import dataclass

ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"
ERROR_LLM = "[LLM_ERROR]"

SCORE_TOLERANCE = 15

VENUE_SUMMARY = {
    "fine": "This venue is fine.",
    "watch": "This venue is on watch.",
    "stop": "Stop new deposits into this venue.",
}

@allow_storage
@dataclass
class VenueRecord:
    venue_id: str
    status: str
    chain_family: str
    network: str
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


def _venue_id(value):
    if not isinstance(value, str):
        raise gl.vm.UserError(ERROR_EXPECTED + " venue_id is missing")
    text = value.strip()
    if text == "" or len(text) > 64 or (" " in text):
        raise gl.vm.UserError(ERROR_EXPECTED + " venue_id is missing")
    return text


def _family_network(chain_family, network):
    family = _enum("chain_family", chain_family, ("solana", "ethereum", "base", "robinhood"))
    net = _enum("network", network, ("mainnet", "testnet", "devnet"))
    return family, net


def _venue_key(chain_family, network, venue_id):
    return chain_family + "|" + network + "|" + venue_id


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


def _parse_status(analysis):
    data = _as_object(analysis)
    raw = data.get("status")
    if not isinstance(raw, str):
        raise gl.vm.UserError(ERROR_LLM + " Venue status missing")
    status = raw.strip().lower()
    if status not in ("fine", "watch", "stop"):
        raise gl.vm.UserError(ERROR_LLM + " Venue status not recognized")
    score_raw = data.get("score")
    if score_raw is None and "confidence" in data:
        score_raw = data["confidence"]
    return status, _parse_score(score_raw)


def _score_close(left, right):
    if isinstance(left, bool) or not isinstance(left, int):
        return False
    if isinstance(right, bool) or not isinstance(right, int):
        return False
    diff = left - right
    if diff < 0:
        diff = -diff
    return diff <= SCORE_TOLERANCE


def _read_status_page(url):
    res = gl.nondet.web.get(url)
    status_code = int(res.status)
    body = res.body
    if not isinstance(body, str):
        body = body.decode("utf-8")
    if status_code >= 500:
        raise gl.vm.UserError(ERROR_TRANSIENT + " Venue status page unavailable")
    if status_code != 200:
        raise gl.vm.UserError(ERROR_EXTERNAL + " Venue status page returned " + str(status_code))
    text = body.strip()
    if len(text) < 12:
        raise gl.vm.UserError(ERROR_EXTERNAL + " Venue status page has no incident report")
    return text


class VenueWatch(gl.Contract):
    """Latest plain status for one venue on one chain family and network."""

    venues: TreeMap[str, VenueRecord]

    def __init__(self):
        pass

    def _judge(self, status_url):
        def leader_fn():
            page = _read_status_page(status_url)
            prompt = (
                "Classify this venue status page. "
                "Ignore prices, yields, and APY. "
                "Use operational incidents only. "
                "fine means no active incident. "
                "watch means degraded or investigating. "
                "stop means halted, exploited, or insolvent.\n"
                "Page:\n" + page + "\n"
                'Return JSON {"status": "fine" or "watch" or "stop", "score": 0 to 100}.'
            )
            status, score = _parse_status(gl.nondet.exec_prompt(prompt, response_format="json"))
            return {"status": status, "score": score}

        def validator_fn(leaders_res):
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)
            data = leaders_res.calldata
            if not isinstance(data, dict):
                return False
            mine = leader_fn()
            if data.get("status") != mine["status"]:
                return False
            return _score_close(data.get("score"), mine["score"])

        return gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

    def _view(self, record):
        return {
            "venue_id": record.venue_id,
            "status": record.status,
            "chain_family": record.chain_family,
            "network": record.network,
            "summary": record.summary,
        }

    @gl.public.write
    def review_venue(self, chain_family: str, network: str, venue_id: str, status_url: str):
        _reject_value()
        family, net = _family_network(chain_family, network)
        venue = _venue_id(venue_id)
        if not isinstance(status_url, str):
            raise gl.vm.UserError(ERROR_EXPECTED + " Evidence url must be https")
        url = status_url.strip()
        if not url.startswith("https://") or (" " in url):
            raise gl.vm.UserError(ERROR_EXPECTED + " Evidence url must be https")

        judged = self._judge(url)
        status = judged["status"]
        if status not in VENUE_SUMMARY:
            raise gl.vm.UserError(ERROR_LLM + " Venue status not recognized")
        summary = _assert_member_sentence(VENUE_SUMMARY[status])

        record = gl.storage.inmem_allocate(VenueRecord, venue, status, family, net, summary)
        self.venues[_venue_key(family, net, venue)] = record
        return self._view(self.venues[_venue_key(family, net, venue)])

    @gl.public.view
    def has_venue(self, chain_family: str, network: str, venue_id: str) -> bool:
        family, net = _family_network(chain_family, network)
        return _venue_key(family, net, _venue_id(venue_id)) in self.venues

    @gl.public.view
    def get_venue(self, chain_family: str, network: str, venue_id: str) -> dict:
        family, net = _family_network(chain_family, network)
        key = _venue_key(family, net, _venue_id(venue_id))
        if key not in self.venues:
            raise gl.vm.UserError(ERROR_EXPECTED + " Venue not found")
        return self._view(self.venues[key])
