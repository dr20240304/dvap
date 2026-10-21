// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LibStorage} from "./LibStorage.sol";

contract UpgradeModule {
    event ModuleSet(address module, bytes4[] selectors);

    function setModule(bytes4[] calldata selectors, address module) external {
        LibStorage.S storage s = LibStorage.s();
        require(msg.sender == s.routerOwner, "not owner");
        for (uint256 i; i < selectors.length; i++) s.moduleOf[selectors[i]] = module;
        emit ModuleSet(module, selectors);
    }
}

contract InitModule {
    /// Hands the router to the real admin (multisig) after the modules are cut in.
    function init(address newOwner) external {
        LibStorage.S storage s = LibStorage.s();
        // O1: the vulnerable version never records that init already ran, so anyone can call it again and take over.
        if (LibStorage.fixed_(LibStorage.O1_INIT)) {
            require(!s.initialized, "already initialized");
            require(msg.sender == s.routerOwner, "not owner");
        }
        s.initialized = true;
        s.routerOwner = newOwner;
    }

    function owner() external view returns (address) {
        return LibStorage.s().routerOwner;
    }
}

contract WalletModule {
    /// Kill switch: bumps the config nonce so every outstanding signed config is dead. Direct caller only.
    function incrementConfigNonce() external {
        LibStorage.s().owners[msg.sender].configNonce += 1;
    }

    function configNonce(address o) external view returns (uint256) { return LibStorage.s().owners[o].configNonce; }
    function intentNonce(address o) external view returns (uint256) { return LibStorage.s().owners[o].intentNonce; }
    function spentOn(address o, uint256 dayKey) external view returns (uint256) { return LibStorage.s().owners[o].spent[dayKey]; }
}
