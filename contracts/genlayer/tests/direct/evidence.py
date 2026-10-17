import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures"

PASS_SUMMARY = "This move fits the treasury rules."
ALLOCATION_SUMMARY = "This would put more into one venue than your limit allows."


def load_fixture(name):
    return json.loads((FIXTURES / f"{name}.json").read_text())


def contract_path(filename):
    return str(ROOT / filename)


def mock_mandate(direct_vm, fits=True, score=80):
    direct_vm.mock_llm(
        r"Set fits to false only when the written mandate forbids something",
        json.dumps({
            "fits": fits,
            "score": score,
            "summary": "Finalized essay about equivalence and GEN that must not be stored",
        }),
    )


def open_case(contract, fix, **overrides):
    constitution = dict(fix["constitution"])
    if "constitution" in overrides:
        constitution.update(overrides.pop("constitution"))
    fields = {
        "chain_family": fix["chain_family"],
        "network": fix["network"],
        "treasury": fix["treasury"],
        "action_hash": fix["action_hash"],
        "venue": fix["venue"],
        "amount": fix["amount"],
        "asset": fix["asset"],
        "mandate_text": fix["mandate_text"],
        "mandate_hash": fix["mandate_hash"],
        "constitution_json": json.dumps(constitution),
        "evidence_url": "",
    }
    fields.update(overrides)
    return contract.open_case(
        fields["chain_family"],
        fields["network"],
        fields["treasury"],
        fields["action_hash"],
        fields["venue"],
        fields["amount"],
        fields["asset"],
        fields["mandate_text"],
        fields["mandate_hash"],
        fields["constitution_json"],
        fields["evidence_url"],
    )
