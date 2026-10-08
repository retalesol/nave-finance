// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBalancerVault} from "../../src/adapters/external/IExternalProtocols.sol";
import {MockRateToken} from "./MockRateToken.sol";

/// @notice Minimal Balancer v2 Vault stand-in for testing manipulation-resistant
/// LP pricing (EVM-C2). BPT is minted/burned against the `MockRateToken`'s
/// `getRate()` (the real, rate-provider-derived measure {BalancerAdapter} now
/// prices with). `getPoolTokens()` balances are INDEPENDENTLY settable via
/// {setSpotBalance}, standing in for the pre-fix vulnerable
/// `balances[assetIndex]` spot read a flash loan can move within one block
/// without touching `getRate()`.
contract MockBalancerVault {
    IERC20 public immutable asset;
    MockRateToken public immutable bpt;
    uint256 public immutable assetIndex;
    uint256[] internal _balances;
    address[] internal _assets;

    constructor(address asset_, address bpt_, uint256 tokenCount, uint256 assetIndex_) {
        asset = IERC20(asset_);
        bpt = MockRateToken(bpt_);
        assetIndex = assetIndex_;
        for (uint256 i = 0; i < tokenCount; i++) {
            _assets.push(i == assetIndex_ ? asset_ : address(uint160(0x1000 + i)));
            _balances.push(0);
        }
    }

    function setSpotBalance(uint256 index, uint256 bal) external {
        _balances[index] = bal;
    }

    function getPoolTokens(bytes32)
        external
        view
        returns (address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock)
    {
        return (_assets, _balances, block.number);
    }

    function joinPool(
        bytes32,
        address,
        address,
        IBalancerVault.JoinPoolRequest calldata request
    ) external {
        uint256 amountIn = request.maxAmountsIn[assetIndex];
        asset.transferFrom(msg.sender, address(this), amountIn);
        uint256 minted = (amountIn * 1e18) / bpt.getRate();
        bpt.mint(msg.sender, minted);
    }

    function exitPool(
        bytes32,
        address,
        address payable,
        IBalancerVault.ExitPoolRequest calldata request
    ) external {
        (, uint256 bptAmount,) = abi.decode(request.userData, (uint256, uint256, uint256));
        bpt.burn(msg.sender, bptAmount);
        uint256 out = (bptAmount * bpt.getRate()) / 1e18;
        require(out >= request.minAmountsOut[assetIndex], "MockBalancerVault: slippage");
        asset.transfer(msg.sender, out);
    }
}
