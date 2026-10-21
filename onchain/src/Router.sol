// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LibStorage, IERC20} from "./LibStorage.sol";
import {UpgradeModule} from "./AdminModules.sol";

/// Fallback-only proxy: all logic lives in modules reached by delegatecall, so users approve ONE stable address.
contract Router {
    constructor(address token, uint256 fixes, address upgradeModule) {
        LibStorage.S storage s = LibStorage.s();
        s.routerOwner = msg.sender; // deployer until init() hands it to the real admin
        s.token = IERC20(token);
        s.fixes = fixes;
        s.moduleOf[UpgradeModule.setModule.selector] = upgradeModule; // bootstrap: the only way to add the rest
    }

    fallback() external payable {
        address module = LibStorage.s().moduleOf[msg.sig];
        require(module != address(0), "no module");
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), module, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}
