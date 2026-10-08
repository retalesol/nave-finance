// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {WrappedNave} from "../../src/WrappedNave.sol";
import {NaveBridge} from "../../src/NaveBridge.sol";
import {NaveStaking} from "../../src/NaveStaking.sol";
import {NaveProtocol} from "../../src/NaveProtocol.sol";
import {PythOracle} from "../../src/oracle/PythOracle.sol";
import {NaveDAOFactory} from "../../src/NaveDAOFactory.sol";
import {NaveDaoStake} from "../../src/NaveDaoStake.sol";

/// @dev Shared proxy deploy helpers for unit tests after the UUPS cutover.
library TestProxies {
    function deployWrappedNave(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address owner_,
        address minter_
    ) internal returns (WrappedNave token) {
        WrappedNave impl = new WrappedNave();
        token = WrappedNave(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        WrappedNave.initialize, (name_, symbol_, decimals_, owner_, minter_)
                    )
                )
            )
        );
    }

    function deployBridge(
        address wnave,
        address owner_,
        address relayer,
        uint256 perTx,
        uint256 daily
    ) internal returns (NaveBridge bridge) {
        NaveBridge impl = new NaveBridge();
        bridge = NaveBridge(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(NaveBridge.initialize, (wnave, owner_, relayer, perTx, daily))
                )
            )
        );
    }

    function deployStaking(address token, address owner_, address rewarder)
        internal
        returns (NaveStaking staking)
    {
        NaveStaking impl = new NaveStaking();
        staking = NaveStaking(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(NaveStaking.initialize, (token, owner_, rewarder))
                )
            )
        );
    }

    function deployProtocol(
        address owner_,
        address protocolTreasury,
        uint256 formationFee,
        uint256 tokenMintFee
    ) internal returns (NaveProtocol protocol) {
        NaveProtocol impl = new NaveProtocol();
        protocol = NaveProtocol(
            payable(
                address(
                    new ERC1967Proxy(
                        address(impl),
                        abi.encodeCall(
                            NaveProtocol.initialize,
                            (owner_, protocolTreasury, formationFee, tokenMintFee)
                        )
                    )
                )
            )
        );
    }

    function deployOracle(address pyth, address owner_) internal returns (PythOracle oracle) {
        PythOracle impl = new PythOracle();
        oracle = PythOracle(
            address(new ERC1967Proxy(address(impl), abi.encodeCall(PythOracle.initialize, (pyth, owner_))))
        );
    }

    function deployFactory(
        address owner_,
        address protocol,
        address oracle,
        address tokenDeployer
    ) internal returns (NaveDAOFactory factory) {
        NaveDAOFactory impl = new NaveDAOFactory();
        factory = NaveDAOFactory(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        NaveDAOFactory.initialize, (owner_, protocol, oracle, tokenDeployer)
                    )
                )
            )
        );
    }

    function deployDaoStake(address owner_, address protocol)
        internal
        returns (NaveDaoStake stake)
    {
        NaveDaoStake impl = new NaveDaoStake();
        stake = NaveDaoStake(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(NaveDaoStake.initialize, (owner_, protocol))
                )
            )
        );
    }
}
