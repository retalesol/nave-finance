// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Minimal external ABIs for treasury capital bridges (CCTP / OP / Arbitrum).

interface ITokenMessenger {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce);
}

/// Circle TokenMessengerV2. `minFinalityThreshold` 2000 is standard finality.
/// `maxFee` of 0 can revert on routes that charge a fee.
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external returns (uint64 nonce);
}

interface IMessageTransmitter {
    function receiveMessage(bytes calldata message, bytes calldata attestation)
        external
        returns (bool success);
}

/// OP Stack L2 → L1 / L2 standard bridge (Base uses the same surface).
interface IL2StandardBridge {
    function bridgeETHTo(address _to, uint32 _minGasLimit, bytes calldata _extraData)
        external
        payable;

    function bridgeERC20To(
        address _localToken,
        address _remoteToken,
        address _to,
        uint256 _amount,
        uint32 _minGasLimit,
        bytes calldata _extraData
    ) external;
}

interface IL1StandardBridge {
    function bridgeETHTo(address _to, uint32 _minGasLimit, bytes calldata _extraData)
        external
        payable;

    function depositERC20To(
        address _l1Token,
        address _l2Token,
        address _to,
        uint256 _amount,
        uint32 _minGasLimit,
        bytes calldata _extraData
    ) external;
}

/// Arbitrum Nitro L2 gateway router (outbound to L1).
interface IArbGatewayRouter {
    function outboundTransferCustomRefund(
        address _token,
        address _refundTo,
        address _to,
        uint256 _amount,
        uint256 _maxGas,
        uint256 _gasPriceBid,
        bytes calldata _data
    ) external payable returns (bytes memory);

    function outboundTransfer(
        address _token,
        address _to,
        uint256 _amount,
        bytes calldata _data
    ) external payable returns (bytes memory);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function balanceOf(address) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}
