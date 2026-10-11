# GenLayer for Nave

GenLayer is one review layer above the treasuries. The same review covers Solana, Ethereum, Base, and Robinhood. The chain is an input on the case. It is not a separate product, and it is not a Base-only add-on.

GenLayer does not hold Nave assets. A review can stop a signature. It cannot, by itself, approve a transfer. The vault, the caps, the payload binding, and the review window stay on the chain that already holds the funds.

## What stays on the treasury chain

Custody stays on Solana, or on Ethereum, Base, or Robinhood, whichever treasury the member already picked.

These checks stay there too:

- Allocation caps, the deployment cap, the liquidity floor, and the stablecoin reserve floor.
- Payload binding: the signed transaction still has to match the action the treasury recorded.
- The review window, including who may pause and who may clear a pause.

The Oversight key (role `operational`) on that chain is still required to lift a pause. A GenLayer result does not shorten the window and does not move the vault.

GenLayer contracts cannot call Nave's Solana programs or the treasury contracts on Ethereum, Base, or Robinhood.

## What the member sees

The member sees one plain status, in the same words, on every chain. Chain ids, GEN, appeal bonds, and protocol jargon stay off the main card. Operators can open a quiet "How this was checked" detail for the case id, the rule ids, and the GenLayer transaction.

| On screen | Status key | When |
| --- | --- | --- |
| Checked | `checked` | The decision is `pass` and the review is finished. |
| Needs a closer look | `needs_closer_look` | The decision is `fail` and the review is finished. |
| Still checking | `still_checking` | A review exists and is not finished, including an accepted fail. |
| Ask for another check | (not a status) | The member asks for a second look. That opens a halt appeal. |

Apply that in this order:

1. If there is no stored review, show nothing. Do not show Still checking for an empty treasury.
2. If the review is not finished, show Still checking. An accepted fail is not finished.
3. If the stored decision is `fail` and the review is finished, show Needs a closer look.
4. If the stored decision is `pass` and the review is finished, show Checked.

"Review finished" means the GenLayer transaction can no longer be challenged. A result that is only accepted, and not yet final, is not finished. An unfinished pass stays Still checking. The contracts do not store this flag. Read it from the GenLayer transaction.

Do not invent other status labels. Do not say the review is a legal ruling, a KYC result, or that a test network is custody.

Venue status, when that check is on, uses three words:

| Stored `status` | Words for the member | Stored `summary` |
| --- | --- | --- |
| `fine` | fine | This venue is fine. |
| `watch` | watch | This venue is on watch. |
| `stop` | stop new deposits | Stop new deposits into this venue. |

If VenueWatch has no record for that venue, there is no venue status to show. Do not invent a fourth word.

A halt appeal stores `keep_pause` or `lift_pause`, plus one sentence. Ask for another check is the member's action, not the result. `lift_pause` means operators on the treasury chain may lift the pause. It does not lift the pause by itself. `keep_pause` means the pause stays.

## The case id

Every charter case and every halt appeal uses the same four fields:

| Field | Values |
| --- | --- |
| `chain_family` | `solana`, `ethereum`, `base`, or `robinhood` |
| `network` | `mainnet`, `testnet`, or `devnet` |
| `treasury` | The treasury address, as a string |
| `action_hash` | A 64-character hex string |

Stored form, which `get_case`, `has_case`, `get_appeal`, and `has_appeal` also accept on the way in:

- `chain_family` and `network` are lowercase.
- `action_hash` is 64 lowercase hex characters with no `0x`. A `0x` prefix on input is accepted and stripped. Any other length is rejected.
- A Solana `treasury` is stored exactly as trimmed base58. Case is kept.
- An Ethereum, Base, or Robinhood `treasury` is stored as lowercase `0x` plus 40 hex characters.

The storage key is those four stored fields joined with `|`. Call the view methods rather than building the key in the app.

## CharterAdjudicator

File: `contracts/genlayer/charter_adjudicator.py`.

`open_case` judges one proposed move. It returns and stores:

| Field | Meaning |
| --- | --- |
| `chain_family` | Stored case id |
| `network` | Stored case id |
| `treasury` | Stored case id |
| `action_hash` | Stored case id |
| `decision` | `pass` or `fail` |
| `rule_ids` | String list. Empty when the decision is `pass`. |
| `summary` | One sentence a member can read |

`rule_ids` on a fail lists every broken rule, in this order. `summary` is the sentence for the first id in that list. On a pass, `summary` is "This move fits the treasury rules."

| `rule_ids` entry | Sentence |
| --- | --- |
| `protocol_allowlist` | This venue is not on your approved list. |
| `allocation_cap` | This would put more into one venue than your limit allows. |
| `global_deployment_cap` | This would deploy more of the treasury than your limit allows. |
| `liquidity_floor` | This would leave less cash on hand than your rules require. |
| `reserve_floor` | This would leave less in stable assets than your rules require. |
| `mandate_fit` | This move does not fit the written mandate. |

Show `summary` as written. Do not add chain ids, GEN, "Finalized", or "equivalence".

Arguments to `open_case`, in order:

1. `chain_family`
2. `network`
3. `treasury`
4. `action_hash`
5. `venue` — protocol id, exact spelling from the snapshot (`kamino`, `aave-v3`, …)
6. `amount` — whole number of base units, as a decimal string
7. `asset` — symbol or mint, no spaces
8. `mandate_text` — the mandate itself, not a hash and not an assistant paragraph
9. `mandate_hash` — lowercase sha256 of the exact UTF-8 `mandate_text`, 64 hex characters
10. `constitution_json` — the public snapshot, as a JSON object string
11. `evidence_url` — `https://…` or `""`. When set, the contract re-fetches that JSON and requires it to match the arguments.

The snapshot fields are:

- `approved_venues` — list of venue id strings
- `max_single_allocation_bps`, `max_deployment_bps`, `liquidity_floor_bps`, `reserve_floor_bps` — integers from 0 to 10000
- `nav_base_units`, `deployed_base_units`, `venue_deployed_base_units`, `liquid_base_units`, `reserve_base_units` — whole base units, as a decimal string or an integer. `nav_base_units` must be greater than zero
- `asset_is_stable` — true or false. The reserve floor applies only when this is true

The contract ignores `decision`, `rule_ids`, `summary`, `essay`, `assistant`, `explanation`, and `reasoning` if they appear in the snapshot or on the fetched page. Validators re-judge the mandate. They must agree on `decision` and `rule_ids` exactly. A numeric score may differ by up to 15 points. That score is not stored.

Opening the same case twice does not change the stored result. A bad mandate hash does not open a case.

`has_case` returns true or false. `get_case` returns the same object as `open_case`, or reverts if the case is missing. A missing case is Still checking, not a pass.

## VenueWatch

File: `contracts/genlayer/venue_watch.py`.

`review_venue(chain_family, network, venue_id, status_url)` re-fetches a public status or incident page. It stores the latest result:

| Field | Meaning |
| --- | --- |
| `venue_id` | Exact venue id |
| `status` | `fine`, `watch`, or `stop` |
| `chain_family` | Which family this venue was checked on |
| `network` | `mainnet`, `testnet`, or `devnet` |
| `summary` | The one sentence in the venue table above |

`status_url` must be `https://…`. The page is the evidence. A one-word page is rejected. Prices, yields, and APY are not the source; price marks stay on Pyth. A `stop` withholds new deposits into that venue. Changing the on-chain allowlist is still a governance vote on the treasury chain.

A later `review_venue` for the same family, network, and venue replaces the stored status. `get_venue` returns the record. `has_venue` is true or false. No record means there is nothing to show.

Validators must agree on `status` exactly. The score may differ by up to 15 points and is not stored.

## HaltAppeal

File: `contracts/genlayer/halt_appeal.py`.

`open_appeal` is the second check. Arguments, in order:

1. `chain_family`
2. `network`
3. `treasury`
4. `action_hash`
5. `pause_reason` — why the move was paused, in public words
6. `counterevidence` — the new public evidence. Blank means there is nothing new, and the decision is `keep_pause`
7. `venue`
8. `amount` — base units, as a decimal string
9. `asset`

It returns and stores `chain_family`, `network`, `treasury`, `action_hash`, `decision` (`keep_pause` or `lift_pause`), and `summary`.

| `decision` | `summary` |
| --- | --- |
| `keep_pause` | The pause stays until this is looked at again. |
| `lift_pause` | A second check says the pause can be lifted by the treasury operators. |

A pause reason or a counterevidence text that is only a verdict word (`lift_pause`, `keep_pause`, `pass`, `fail`, and the like) is rejected. The contract does not read CharterAdjudicator. Pass the public facts in. A second appeal for the same case id does not replace the first.

`lift_pause` still needs the Oversight key (role `operational`) on the treasury chain and does not shorten the review window. `keep_pause` means a clear stays blocked in the shared guardrail.

`has_appeal` and `get_appeal` match the case id. Validators must agree on `decision` exactly. The score may differ by up to 15 points and is not stored.

## Writing the decision back onto the treasury chain

This is deferred. Do not build a registry, a program, or a contract that writes the GenLayer decision back onto Solana or onto Ethereum, Base, or Robinhood.

That step waits until the treasury programs have been audited, and until a real proof exists for the chain that holds the assets. Solana needs its own proof. Ethereum, Base, and Robinhood each need their own proof.

Even after a receipt like that exists, it still cannot move the vault.

## How the app calls the contracts

The app does not invent RPC methods. When a session is configured, it calls `open_case`, `review_venue`, and `open_appeal`, then reads `has_case` / `get_case`, `has_venue` / `get_venue`, and `has_appeal` / `get_appeal`.

A session exists only when all of these are set:

- `NAVE_GENLAYER_RPC_URL`
- `NAVE_GENLAYER_SIGNER_KEY`
- `NAVE_GENLAYER_CHARTER_ADDRESS`
- `NAVE_GENLAYER_VENUE_ADDRESS`
- `NAVE_GENLAYER_HALT_ADDRESS`

If any of those is missing, the adjudicator returns an error and writes no row. The dispatcher skips the submit. Signing continues under the existing treasury rules. The three gate flags stay off until those addresses are real.

The dispatcher submits `open_case` only when it already has the 64-hex action hash the signer will check, the on-chain constitution numbers, the venue, the amount, and the asset. The snapshot uses the contract's fields (`approved_venues`, `max_deployment_bps`, `liquidity_floor_bps`, `reserve_floor_bps`, `liquid_base_units`, `venue_deployed_base_units`, `reserve_base_units`, `asset_is_stable`). A missing number skips the submit. The mandate sentence is built from those numbers. The model's paragraph is not the mandate and is not the verdict.

The edge function submits the transaction and stores its id as Still checking. It does not wait for the appeal window. A later read polls the transaction. Checked or Needs a closer look is stored only when the GenLayer status is `FINALIZED` and the execution result is `FINISHED_WITH_RETURN`. `ACCEPTED` stays Still checking, whether the stored decision is pass or fail. A finished pass still does not authorize a transfer. The treasury signer keeps that decision.

Ask for another check calls `open_appeal` with the pause reason. It does not flip a boolean in the database by itself. The action hash must be 64 hex characters.

## Networks and custody

Public GenLayer networks in the current docs are Studionet, localnet, Asimov, and Bradbury (chain id 4221). That set has no GenLayer mainnet. No production treasury depends on Bradbury for custody. Bradbury can host a review. The assets stay on the treasury chain.

The contracts reject a non-zero GenLayer payment. They store no token balance.

## Evidence fixtures

One public case per family, with test addresses:

| File | Family | Network | Treasury | Venue |
| --- | --- | --- | --- | --- |
| `contracts/genlayer/fixtures/solana.json` | solana | devnet | `7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2` | kamino |
| `contracts/genlayer/fixtures/ethereum.json` | ethereum | testnet | `0x1111111111111111111111111111111111111111` | aave-v3 |
| `contracts/genlayer/fixtures/base.json` | base | testnet | `0x2222222222222222222222222222222222222222` | compound-v3 |
| `contracts/genlayer/fixtures/robinhood.json` | robinhood | testnet | `0x3333333333333333333333333333333333333333` | balancer-v2 |

Each file is a passing move against the same mandate. The mandate hash is the sha256 of the exact `mandate_text` in the file.

## Checks

From a machine with `genvm-lint` and `genlayer-test` installed:

```bash
genvm-lint check contracts/genlayer/charter_adjudicator.py
genvm-lint check contracts/genlayer/venue_watch.py
genvm-lint check contracts/genlayer/halt_appeal.py
pytest contracts/genlayer/tests/direct -v
```

Each contract pins runner `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`. Do not replace that pin with `test`, `latest`, or an unversioned runner.
