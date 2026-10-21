// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function allowance(address o, address s) external view returns (uint256);
}

/// Shared router storage at a fixed slot, so every module that the router delegates to sees the same state.
library LibStorage {
    bytes32 constant POSITION = keccak256("dvap.router.storage.v1");

    // DVAP_HARDEN-style switches: a bug is live unless its bit is set in `fixes`.
    uint256 constant O1_INIT = 1;      // re-callable initializer
    uint256 constant O2_DAYKEY = 2;    // daily cap bucket chosen by the signer
    uint256 constant O3_DOMAIN = 4;    // config signature has no chain / contract binding
    uint256 constant O4_REENTRY = 8;   // nonce and cap updated after the token call
    uint256 constant ALL = 15;

    struct OwnerState {
        uint256 configNonce;
        uint256 intentNonce;
        mapping(uint256 => uint256) spent; // dayKey => amount
    }

    struct S {
        address routerOwner;
        bool initialized;
        bool locked;
        uint256 fixes;
        IERC20 token;
        mapping(bytes4 => address) moduleOf;
        mapping(address => OwnerState) owners;
    }

    function s() internal pure returns (S storage x) {
        bytes32 p = POSITION;
        assembly { x.slot := p }
    }

    function fixed_(uint256 bit) internal view returns (bool) {
        return s().fixes & bit != 0;
    }
}
