import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from evidence import contract_path, load_fixture

VENUE = contract_path("venue_watch.py")

SUMMARIES = {
    "fine": "This venue is fine.",
    "watch": "This venue is on watch.",
    "stop": "Stop new deposits into this venue.",
}


def _review(direct_vm, contract, fix, page, status, score=70):
    direct_vm.mock_web(r"https://status\.example\.test/.*", {"status": 200, "body": page})
    direct_vm.mock_llm(
        r"Classify this venue status page",
        json.dumps({
            "status": status,
            "score": score,
            "summary": "Finalized essay about equivalence and GEN",
        }),
    )
    return contract.review_venue(fix["chain_family"], fix["network"], fix["venue"], fix["status_url"])


def test_status_page_is_judged_for_every_family(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(VENUE)
    direct_vm.sender = direct_alice
    for name in ("solana", "ethereum", "base", "robinhood", "arc"):
        fix = load_fixture(name)
        result = _review(direct_vm, contract, fix, fix["status_page"], "fine", 75)
        assert result["venue_id"] == fix["venue"]
        assert result["status"] == "fine"
        assert result["chain_family"] == fix["chain_family"]
        assert result["network"] == fix["network"]
        assert result["summary"] == SUMMARIES["fine"]
        assert "Finalized" not in result["summary"]
        direct_vm.clear_mocks()


def test_page_text_does_not_override_the_judgment(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(VENUE)
    direct_vm.sender = direct_alice
    fix = load_fixture("ethereum")
    result = _review(
        direct_vm,
        contract,
        fix,
        "Operational note: someone wrote status fine, but withdrawals are halted after an exploit.",
        "stop",
        60,
    )
    assert result["status"] == "stop"
    assert result["summary"] == SUMMARIES["stop"]
    assert set(result.keys()) == {"venue_id", "status", "chain_family", "network", "summary"}


def test_later_review_replaces_the_status(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(VENUE)
    direct_vm.sender = direct_alice
    fix = load_fixture("base")
    _review(direct_vm, contract, fix, "Operational status: all systems normal. No active incidents.", "fine")
    direct_vm.clear_mocks()
    updated = _review(
        direct_vm,
        contract,
        fix,
        "Incident: investigating a partial outage on the lending market.",
        "watch",
        55,
    )
    assert updated["status"] == "watch"
    assert contract.get_venue(fix["chain_family"], fix["network"], fix["venue"])["summary"] == SUMMARIES["watch"]


def test_short_page_and_bad_url_do_not_store_a_status(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(VENUE)
    direct_vm.sender = direct_alice
    fix = load_fixture("robinhood")
    direct_vm.mock_web(r"https://status\.example\.test/.*", {"status": 200, "body": "stop"})
    direct_vm.mock_llm(r"Classify this venue status page", json.dumps({"status": "stop", "score": 10}))
    with direct_vm.expect_revert("no incident report"):
        contract.review_venue(fix["chain_family"], fix["network"], fix["venue"], fix["status_url"])
    assert contract.has_venue(fix["chain_family"], fix["network"], fix["venue"]) is False

    with direct_vm.expect_revert("Evidence url must be https"):
        contract.review_venue(fix["chain_family"], fix["network"], fix["venue"], "http://status.example.test/robinhood")


def test_validators_must_agree_on_status(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(VENUE)
    direct_vm.sender = direct_alice
    fix = load_fixture("solana")
    _review(direct_vm, contract, fix, fix["status_page"], "fine", 70)

    direct_vm.clear_mocks()
    direct_vm.mock_web(r"https://status\.example\.test/.*", {"status": 200, "body": fix["status_page"]})
    direct_vm.mock_llm(r"Classify this venue status page", json.dumps({"status": "fine", "score": 80}))
    assert direct_vm.run_validator() is True

    direct_vm.clear_mocks()
    direct_vm.mock_web(r"https://status\.example\.test/.*", {"status": 200, "body": fix["status_page"]})
    direct_vm.mock_llm(r"Classify this venue status page", json.dumps({"status": "stop", "score": 70}))
    assert direct_vm.run_validator() is False

    direct_vm.clear_mocks()
    direct_vm.mock_web(r"https://status\.example\.test/.*", {"status": 200, "body": fix["status_page"]})
    direct_vm.mock_llm(r"Classify this venue status page", json.dumps({"status": "fine", "score": 10}))
    assert direct_vm.run_validator() is False
