# Testnet live E2E — 2026-10-23

Started 2026-10-23T18:53:31.887Z. Finished 2026-10-23T18:58:22.103Z.

This run refused mocks and anvil, and it did not send transactions to mainnet, Base Sepolia, or Arc.

## Blocked deploys

- Base Sepolia (84532): bytecode at factory 0x4a15eB156b54403Fd0e58DfFe4F20aB6C35099dA and protocol 0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8 is empty. Base Sepolia rejected the implementation transaction gas limit. Same-address activation was not broadcast. This is a blocked deploy, not a pass.
- Arc testnet (5042002): bytecode at factory 0x4a15eB156b54403Fd0e58DfFe4F20aB6C35099dA and protocol 0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8 is empty. Arc testnet's 30M block gas limit cannot hold the ~37M gas implementation deploy. Same-address activation was not broadcast. This is a blocked deploy, not a pass.

## Transactions

- fund-founder-usdc (chain 11155111): `0x16f2969368db3e3879bba202557eb3a4fedcf95d4308e3df587f74cefd642690`
- create-cross-chain-sepolia (chain 11155111): `0xcaea465ac6be5796d8ef36ea0eb15cb60b26b7fdd6c93a0c89dd57fd07f991b5`
- activate-robinhood (chain 46630): `0x90a01569a65ed43d9bc7ad6110583d7351b13a7fa64ee347a4023667778bebd6`
- register-usdc (chain 11155111): `0x4af2f39f02e38b3cc4deb0d9147c4ce1044518c709211f7d3042a3722814e6f9`
- approve-usdc (chain 11155111): `0x73a68c6eb8629a08923837d44f62e9f1555b92b0e44cbc61324b19be83722129`
- deposit-dust (chain 11155111): `0x113ced2ccdd82bacf4dc086b7902586b4e14bef8199da3cd597c20f6cf18b3ea`
- deposit-normal (chain 11155111): `0xde163f6a777f6bc4e31c0b9fd023a1dd8e9be5461bc7e2df61860744ad222f3d`
- deposit-large (chain 11155111): `0x989d7510a0f0e67478d0a0ecf1db30bb311627625cb152a9f542f76f78eea910`
- proposal-dust-out (chain 11155111): `0x8b25f8bc4ff92ccc19c772861c24eb30bb8705d3918790a649f57cca3c10408d`
- vote-dust-out (chain 11155111): `0x2b54a964ad72797e77b49b5faf97a598e62d96437cd82623d36e71e35590f97b`
- finalize-dust-out (chain 11155111): `0x0bb24ddb6568f1017220627cf5b2c2f878c529e92e5c1f1c082a941b46958c9f`
- dust-transfer-empty-revert (chain 11155111): `0xe28e795df90998474451c9597729873bd2257efb825ca46706d1a19f54b5ed13`
- fund-treasury-native (chain 11155111): `0xa5e5bf5aa4d86cc22382f0c01d0c3e4338c859011489a31a05cd9a68a95af335`
- transfer-dust (chain 11155111): `0x42e032d45020edbc219132ccd608a2ce7dae91cded12f6a5be2416107cee4059`
- proposal-normal-out (chain 11155111): `0x270348f0111073254e2a3332293b82623788038e06a7698db1ff68bd366b7520`
- vote-normal-out (chain 11155111): `0xbc2d635bbcbcc9488a1c7d98abec4684812c46087fdb59bc4d56fa3dc452bfff`
- finalize-normal-out (chain 11155111): `0x8828473988b12123df97f6a0c2c70cfc6070b85cf6364d28fa902a3197b0ceb8`
- transfer-normal (chain 11155111): `0xf49dec06cacac961a39e55090e0d72d7fa17f115768843d0ae855f99f9c5f3ab`
- proposal-large-out (chain 11155111): `0xe4e5293411c131bc84a94ce32c802ceb065fa9e7e88e608a1c9210484f513ed1`
- vote-large-out (chain 11155111): `0x98d88791408b6410f23b1f3c26c2c1507be7abc2127d047f5328f5bc7be0e602`
- finalize-large-out (chain 11155111): `0x7f1918f15e7aeb02e61850c782050d8c509c9077cc6f83fb80e239e1b22216fb`
- transfer-large (chain 11155111): `0xa64dc605e897999868ae040cf5f218589c3556af778eadbb7ba131a5ee7f10b8`

## Assertions

- PASS Base Sepolia deterministic factory bytecode: got `0`, expected `0`
- PASS Base Sepolia deterministic protocol bytecode: got `0`, expected `0`
- PASS Arc testnet deterministic factory bytecode: got `0`, expected `0`
- PASS Arc testnet deterministic protocol bytecode: got `0`, expected `0`
- PASS Sepolia protocol factory: got `0x4a15eB156b54403Fd0e58DfFe4F20aB6C35099dA`, expected `0x4a15eB156b54403Fd0e58DfFe4F20aB6C35099dA`
- PASS Sepolia factory protocol: got `0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8`, expected `0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8`
- PASS Sepolia relayer: got `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`, expected `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`
- PASS Sepolia revenue: got `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`, expected `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`
- PASS Sepolia paused: got `false`, expected `false`
- PASS Sepolia formation fee: got `0`, expected `0`
- PASS Sepolia implementation 0: got `0x19Af8d8De09580F52149e006f0a66412180F018A`, expected `0x19Af8d8De09580F52149e006f0a66412180F018A`
- PASS Sepolia implementation 1: got `0x6B1c0506568d45BdfB4B942425b2F3a30DAE8351`, expected `0x6B1c0506568d45BdfB4B942425b2F3a30DAE8351`
- PASS Sepolia implementation 2: got `0x170C5c672642f366bbAF0083A8331745c2eE66d4`, expected `0x170C5c672642f366bbAF0083A8331745c2eE66d4`
- PASS Robinhood testnet protocol factory: got `0x4a15eB156b54403Fd0e58DfFe4F20aB6C35099dA`, expected `0x4a15eB156b54403Fd0e58DfFe4F20aB6C35099dA`
- PASS Robinhood testnet factory protocol: got `0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8`, expected `0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8`
- PASS Robinhood testnet relayer: got `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`, expected `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`
- PASS Robinhood testnet revenue: got `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`, expected `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`
- PASS Robinhood testnet paused: got `false`, expected `false`
- PASS Robinhood testnet formation fee: got `0`, expected `0`
- PASS Robinhood testnet implementation 0: got `0x19Af8d8De09580F52149e006f0a66412180F018A`, expected `0x19Af8d8De09580F52149e006f0a66412180F018A`
- PASS Robinhood testnet implementation 1: got `0x6B1c0506568d45BdfB4B942425b2F3a30DAE8351`, expected `0x6B1c0506568d45BdfB4B942425b2F3a30DAE8351`
- PASS Robinhood testnet implementation 2: got `0x170C5c672642f366bbAF0083A8331745c2eE66d4`, expected `0x170C5c672642f366bbAF0083A8331745c2eE66d4`
- PASS predicted treasury matches on Robinhood before deploy: got `0xf17833e9Bf00b2cC408db58Fbc8Cc2bd6DC4645B`, expected `0xf17833e9Bf00b2cC408db58Fbc8Cc2bd6DC4645B`
- PASS predicted governor matches on Robinhood before deploy: got `0xA1981BF5Cd2a57106870EEB6977BA7456Fd59cC1`, expected `0xA1981BF5Cd2a57106870EEB6977BA7456Fd59cC1`
- PASS predicted execution matches on Robinhood before deploy: got `0xE720f47A8a6563DD4dAdc88f6f21aa2dF82413F1`, expected `0xE720f47A8a6563DD4dAdc88f6f21aa2dF82413F1`
- PASS founder USDC covers the three deposits: got `true`, expected `true`
- PASS Sepolia predicted treasury founder: got `0x04573b182871F45516B25195fF8b98d1991D6a11`, expected `0x04573b182871F45516B25195fF8b98d1991D6a11`
- PASS Sepolia treasury name: got `Nave Treasury`, expected `Nave Treasury`
- PASS Sepolia treasury has code: got `true`, expected `true`
- PASS Robinhood activation fee is 0.001 ETH: got `1000000000000000`, expected `1000000000000000`
- PASS Robinhood activation fee is not Arc USDC: got `0`, expected `0`
- PASS Robinhood treasury founder: got `0x04573b182871F45516B25195fF8b98d1991D6a11`, expected `0x04573b182871F45516B25195fF8b98d1991D6a11`
- PASS same treasury address: got `0xf17833e9Bf00b2cC408db58Fbc8Cc2bd6DC4645B`, expected `0xf17833e9Bf00b2cC408db58Fbc8Cc2bd6DC4645B`
- PASS same governor address: got `0xA1981BF5Cd2a57106870EEB6977BA7456Fd59cC1`, expected `0xA1981BF5Cd2a57106870EEB6977BA7456Fd59cC1`
- PASS same execution address: got `0xE720f47A8a6563DD4dAdc88f6f21aa2dF82413F1`, expected `0xE720f47A8a6563DD4dAdc88f6f21aa2dF82413F1`
- PASS revenue wallet gained 0.001 ETH: got `1000000000000000`, expected `1000000000000000`
- PASS deposit dust did not charge the relayer: got `257360097092233129`, expected `257360097092233129`
- PASS treasury USDC after dust deposit: got `1`, expected `1`
- PASS deposit normal did not charge the relayer: got `257360097092233129`, expected `257360097092233129`
- PASS treasury USDC after normal deposit: got `1000001`, expected `1000001`
- PASS deposit large did not charge the relayer: got `257360097092233129`, expected `257360097092233129`
- PASS treasury USDC after large deposit: got `16000001`, expected `16000001`
- PASS deposits left the relayer balance unchanged overall: got `257360097092233129`, expected `257360097092233129`
- PASS proposal dust-out passed: got `1`, expected `1`
- PASS empty native balance reverts InsufficientNativeForRelayerFee: got `true`, expected `true`
- PASS mined empty-balance transfer reverted: got `reverted`, expected `reverted`
- PASS treasury native balance is empty before the fee fund: got `0`, expected `0`
- PASS inbound ETH wrapped and left native balance at 0: got `0`, expected `0`
- PASS treasury WETH covers three relayer fees: got `2000000000000000`, expected `2000000000000000`
- PASS transfer dust paid 0.0005 ETH to the relayer: got `500000000000000`, expected `500000000000000`
- PASS transfer dust USDC arrived: got `1`, expected `1`
- PASS transfer dust unwrapped the relayer fee from WETH: got `1500000000000000`, expected `1500000000000000`
- PASS transfer dust proposal consumed: got `4`, expected `4`
- PASS proposal normal-out passed: got `1`, expected `1`
- PASS transfer normal paid 0.0005 ETH to the relayer: got `500000000000000`, expected `500000000000000`
- PASS transfer normal USDC arrived: got `1000001`, expected `1000001`
- PASS transfer normal unwrapped the relayer fee from WETH: got `1000000000000000`, expected `1000000000000000`
- PASS transfer normal proposal consumed: got `4`, expected `4`
- PASS proposal large-out passed: got `1`, expected `1`
- PASS transfer large paid 0.0005 ETH to the relayer: got `500000000000000`, expected `500000000000000`
- PASS transfer large USDC arrived: got `16000001`, expected `16000001`
- PASS transfer large unwrapped the relayer fee from WETH: got `500000000000000`, expected `500000000000000`
- PASS transfer large proposal consumed: got `4`, expected `4`
- PASS deployer Sepolia balance stayed above the sweep reserve: got `true`, expected `true`
- PASS sweep math leaves 0.05 from an 0.08 balance: got `30000000000000000`, expected `30000000000000000`
- PASS Robinhood Aave row is bridge-required: got `true`, expected `true`
- PASS Robinhood Aave venue is Sepolia: got `11155111`, expected `11155111`
- PASS Robinhood Aave is not executable while the bridge flag is off: got `false`, expected `false`
- PASS Aave would be executable only with a linked Sepolia treasury and the flag: got `true`, expected `true`
- PASS sol-like Jito insert: got `e5638735-8fa6-4a37-8101-7632da06bd03`, expected `row`
- PASS blue-chip WETH insert: got `9e2c68ad-e2b8-4bcf-9217-5942421d9882`, expected `row`
- PASS checksummed wallet normalizes to lowercase: got `0x04573b182871f45516b25195ff8b98d1991d6a11`, expected `0x04573b182871f45516b25195ff8b98d1991d6a11`
- PASS checksummed wallet finds one treasury group: got `1`, expected `1`
- PASS group includes Sepolia: got `true`, expected `true`
- PASS group includes Robinhood testnet: got `true`, expected `true`
- PASS stored creator wallet is lowercase: got `true`, expected `true`
- PASS keyless treasury dispatcher calls across two sweeps: got `0`, expected `0`
- PASS keyed treasury has one discovery decision: got `1`, expected `1`

## Notes

- VITE_USE_MOCKS is not true. Anvil and mainnet chain ids are refused.
- Focused poll-discovery and relayer-sweep unit tests passed.
- Founder is testing key 1 (0x04573b182871F45516B25195fF8b98d1991D6a11). Revenue and relayer are the deployer (0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca). Keys are not printed.
- Base Sepolia (84532): bytecode at factory 0x4a15eB156b54403Fd0e58DfFe4F20aB6C35099dA and protocol 0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8 is empty. Base Sepolia rejected the implementation transaction gas limit. Same-address activation was not broadcast. This is a blocked deploy, not a pass.
- Arc testnet (5042002): bytecode at factory 0x4a15eB156b54403Fd0e58DfFe4F20aB6C35099dA and protocol 0x6C07BC6A22d2D18E232D546Ab06B6F49115834C8 is empty. Arc testnet's 30M block gas limit cannot hold the ~37M gas implementation deploy. Same-address activation was not broadcast. This is a blocked deploy, not a pass.
- Slug nave-e2e-mvlbvxqd0. Predicted treasury 0xf17833e9Bf00b2cC408db58Fbc8Cc2bd6DC4645B.
- Activation fee delta at revenue 0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca: 1000000000000000 wei.
- eth_call revert on the passed dust transfer: InsufficientNativeForRelayerFee
- Sweep not broadcast. Relayer, revenue, and the deployer are 0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca on both chains. A sweep would pay that same key and only burn its gas. Sepolia excess above 0.05 ETH is 208860097092233129 wei. Robinhood excess above 0.05 ETH is 0 wei. The reserve math was unit-tested. The deployer Sepolia balance stayed above the 0.05 ETH reserve.
- Robinhood scored Aave as "not executable: no linked Ethereum treasury; outbound bridge is off". NAVE_BRIDGE_OUTBOUND_ENABLED was not turned on. No bridge transaction was sent.
- yield_opportunities insert succeeded. Jito sol-like e5638735-8fa6-4a37-8101-7632da06bd03. WETH blue-chip 9e2c68ad-e2b8-4bcf-9217-5942421d9882.
- register-dao Sepolia: 500 {"error":"Failed to register DAO"}
- register-dao Robinhood: 500 {"error":"Failed to register DAO"}
- Registry rows were written with the service SQL path because register-dao did not return both chain rows.
- Lobby query with checksummed 0x04573b182871F45516B25195fF8b98d1991D6a11 matched group 8d5b7ceb-a040-0964-7caf-3f8dfccef95a via 0x04573b182871f45516b25195ff8b98d1991d6a11.
- The signer worker was not started. Autopilot was not enabled. No agent_action_logs row was pre-seeded. The keyless result is the orchestrator discovery path, not two live 15-minute wall-clock sweeps, and the keyed result did not contact the signer.
- Done. Treasury 0xf17833e9Bf00b2cC408db58Fbc8Cc2bd6DC4645B. Slug nave-e2e-mvlbvxqd0.

## Balances

- deployerSepoliaBefore: 257360097092233129
- founderSepoliaBefore: 169976806491067905
- revenueRobinhoodBefore: 30050937373514467
- revenueRobinhoodAfter: 31050937373514467
- deployerSepoliaAfter: 258860097092233129
- founderSepoliaAfter: 167976806067644312

## Follow-up

The first `register-dao` calls returned 500. The deployed function still upserted on `dao_onchain_address` after the migration had replaced that unique constraint with `(chain_id, dao_onchain_address)`. The source in the repo already used the new conflict target. Deploying that function fixed the live path.

Retry after deploy, same treasury `0xf17833e9Bf00b2cC408db58Fbc8Cc2bd6DC4645B` and slug `nave-e2e-mvlbvxqd0`:

- Sepolia `register-dao`: 200, group `8d5b7ceb-a040-0964-7caf-3f8dfccef95a`
- Robinhood testnet `register-dao`: 200, same group
- Checksummed founder query still returns both chain rows, stored creator wallet lowercase

No contract code changed. The relayer sweep was already a real sweep. It was not broadcast because the relayer and the revenue wallet are the deployer key.
