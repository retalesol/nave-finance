// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {NaveErrors} from "./libraries/NaveErrors.sol";

/// @title WrappedNave
/// @notice The relayer-controlled wrapped ERC-20 representation of the Solana
/// NAVE SPL token (the home chain). A trusted Nave relayer (the `minter`, a.k.a.
/// the bridge manager) mints WrappedNave when a user locks NAVE on Solana, and
/// burns WrappedNave when a user bridges back. Mint is gated solely to the
/// `minter`; users burn their own balance to initiate a bridge-back, and the
/// manager may burn via allowance (`burnFrom`). The `owner` can rotate the
/// `minter`. Decimals are fixed at 6 to match the NAVE SPL mint. `ERC20Permit`
/// enables gasless approvals. The canonical `BridgeMint` / `BridgeBurn` events
/// are what the off-chain indexer keys on.
contract WrappedNave is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable
{
    /// The bridge manager (Nave relayer): the sole address allowed to mint and
    /// to burn via allowance.
    address public minter;
    /// SEC-M5: pending minter of a two-step rotation ({setMinter} proposes,
    /// {acceptMinter} claims) so a typoed rotation cannot brick the bridge.
    address public pendingMinter;
    /// SEC-M5: hard supply cap enforced on mint (0 ⇒ uncapped). A compromised
    /// relayer key can inflate at most up to the cap, bounding bridge damage.
    uint256 public supplyCap;
    /// SEC-M5: owner-settable circuit breaker halting mints (bridge-in) while
    /// leaving burns (bridge-out / user exit) available.
    bool public mintPaused;
    uint8 private _decimals;

    /// Early-stage control: the owner may freeze accounts (e.g. to contain a
    /// compromised holder or a bad mint during the trusted-relayer phase).
    /// Frozen accounts cannot send, receive, mint into, or burn. This control
    /// is intended to be REVOKED later (see {renounceControl}) so the token
    /// becomes fully permissionless once the bridge is decentralized.
    mapping(address => bool) public frozen;
    /// Once true, freezing is permanently disabled and all `frozen` checks are
    /// skipped — the token is fully permissionless and cannot be re-controlled.
    bool public controlRevoked;

    event MinterUpdated(address indexed previous, address indexed current);
    event MinterProposed(address indexed current, address indexed pending);
    event SupplyCapUpdated(uint256 cap);
    event MintPausedSet(bool paused);
    /// Emitted when the relayer mints against a Solana lock; indexer keys on this.
    event BridgeMint(address indexed to, uint256 amount);
    /// Emitted when supply is burned to bridge back to Solana; indexer keys on this.
    event BridgeBurn(address indexed from, uint256 amount);
    /// Emitted when a holder burns to bridge back to Solana with an embedded
    /// Solana recipient — a SINGLE signed transaction fully authorizes the
    /// payout address (no separate off-chain "sign this recipient" step). The
    /// relayer/indexer keys the Solana release on `(from, solanaRecipient,
    /// amount)`; `amount` is the gross (net + fee) burned.
    event BridgeBurnTo(address indexed from, bytes32 indexed solanaRecipient, uint256 amount);
    event AccountFrozen(address indexed account, bool frozen);
    event ControlRenounced();

    modifier onlyMinter() {
        if (msg.sender != minter) revert NaveErrors.Unauthorized();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address owner_,
        address minter_
    ) external initializer {
        if (owner_ == address(0) || minter_ == address(0)) revert NaveErrors.ZeroAddress();
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        _decimals = decimals_;
        minter = minter_;
        emit MinterUpdated(address(0), minter_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// Fixed at 6 to match the Solana NAVE SPL mint.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// Relayer-only mint, called after a user locks NAVE on Solana. SEC-M5:
    /// blocked while {mintPaused} and bounded by {supplyCap} when set.
    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert NaveErrors.ZeroAddress();
        if (mintPaused) revert NaveErrors.MintPaused();
        if (supplyCap != 0 && totalSupply() + amount > supplyCap) {
            revert NaveErrors.SupplyCapExceeded();
        }
        _mint(to, amount);
        emit BridgeMint(to, amount);
    }

    /// A holder burns their own balance to bridge NAVE back to Solana.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        emit BridgeBurn(msg.sender, amount);
    }

    /// One-signature bridge-back: a holder burns their own `amount` (the gross,
    /// i.e. net + fee) and embeds the Solana `solanaRecipient` (32-byte base58-
    /// decoded pubkey) in the SAME transaction. This is what makes bridging a
    /// single signature on the EVM side — the burn tx itself authorizes the
    /// exact Solana payout address, closing the recipient-substitution gap
    /// without a second off-chain message signature. The relayer releases the
    /// net NAVE and resolves the fee on Solana ("claim the fee on the SOL side
    /// always").
    function bridgeBurn(uint256 amount, bytes32 solanaRecipient) external {
        if (amount == 0) revert NaveErrors.ZeroAmount();
        if (solanaRecipient == bytes32(0)) revert NaveErrors.InvalidRecipient();
        _burn(msg.sender, amount);
        emit BridgeBurn(msg.sender, amount);
        emit BridgeBurnTo(msg.sender, solanaRecipient, amount);
    }

    /// Manager-initiated burn that spends the holder's allowance.
    function burnFrom(address from, uint256 amount) external onlyMinter {
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
        emit BridgeBurn(from, amount);
    }

    /// SEC-M5: propose a bridge-manager (relayer) rotation. The new key must
    /// prove liveness by calling {acceptMinter}; the active minter keeps
    /// operating until then, so a typo cannot brick the bridge.
    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert NaveErrors.ZeroAddress();
        pendingMinter = newMinter;
        emit MinterProposed(minter, newMinter);
    }

    /// Second step of the rotation: the proposed key claims the minter role.
    function acceptMinter() external {
        if (msg.sender != pendingMinter) revert NaveErrors.NotPendingMinter();
        emit MinterUpdated(minter, msg.sender);
        minter = msg.sender;
        pendingMinter = address(0);
    }

    /// SEC-M5: owner-set hard cap on total supply (0 disables the cap).
    function setSupplyCap(uint256 cap) external onlyOwner {
        supplyCap = cap;
        emit SupplyCapUpdated(cap);
    }

    /// SEC-M5: owner circuit breaker on minting (burn stays available so users
    /// can always bridge back out).
    function setMintPaused(bool paused) external onlyOwner {
        mintPaused = paused;
        emit MintPausedSet(paused);
    }

    /// Early-stage control: freeze/unfreeze an account. Reverts once control
    /// has been permanently revoked. While control is active a frozen account
    /// cannot send, receive, be minted into, or burn.
    function setFrozen(address account, bool isFrozen) external onlyOwner {
        if (controlRevoked) revert NaveErrors.ControlAlreadyRevoked();
        if (account == address(0)) revert NaveErrors.ZeroAddress();
        frozen[account] = isFrozen;
        emit AccountFrozen(account, isFrozen);
    }

    /// Permanently revoke the freeze control. After this call {setFrozen} can
    /// never be used again and all `frozen` checks in transfers are skipped, so
    /// the token becomes fully permissionless. Irreversible by design — this is
    /// how the team hands off the "controllable early on" capability once the
    /// bridge no longer needs a containment lever.
    function renounceControl() external onlyOwner {
        controlRevoked = true;
        emit ControlRenounced();
    }

    /// Enforce freezes on every balance change (mint/burn/transfer) while
    /// control is active. Once {controlRevoked} is set this is a no-op wrapper
    /// around the base implementation.
    function _update(address from, address to, uint256 value) internal override {
        if (!controlRevoked) {
            if (from != address(0) && frozen[from]) revert NaveErrors.AccountIsFrozen();
            if (to != address(0) && frozen[to]) revert NaveErrors.AccountIsFrozen();
        }
        super._update(from, to, value);
    }

    uint256[40] private __gap;
}
