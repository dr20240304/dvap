// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LibStorage} from "./LibStorage.sol";

struct Config {
    address owner;
    address agent;        // key allowed to sign intents
    address recipient;    // the one allowed payee (the real spec uses a Merkle root)
    uint256 maxPerTx;
    uint256 dailyCap;
    uint256 configNonce;
}

struct Intent {
    address owner;
    address to;
    uint256 amount;
    uint256 intentNonce;
    uint256 ts;           // the agent's idea of "now"
}

/// Owner signs a Config, the agent signs an Intent; the router spends the owner's ERC-20 allowance.
contract PaymentModule {
    event PaymentExecuted(address indexed owner, address indexed to, uint256 amount, uint256 intentNonce);

    bytes32 constant CONFIG_TYPEHASH = keccak256("Config(address owner,address agent,address recipient,uint256 maxPerTx,uint256 dailyCap,uint256 configNonce)");
    bytes32 constant INTENT_TYPEHASH = keccak256("Intent(address owner,address to,uint256 amount,uint256 intentNonce,uint256 ts)");

    function configDigest(Config memory c) public view returns (bytes32) {
        bytes32 h = keccak256(abi.encode(CONFIG_TYPEHASH, c.owner, c.agent, c.recipient, c.maxPerTx, c.dailyCap, c.configNonce));
        // O3: without the chain id and this contract's address, a config signed for one deployment (a staging copy, a fork,
        // another chain) is valid on every other deployment where the owner has granted an allowance.
        if (LibStorage.fixed_(LibStorage.O3_DOMAIN)) h = keccak256(abi.encode(h, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    function intentDigest(Intent memory i) public view returns (bytes32) {
        // O7: the vulnerable digest hashes a zero where the amount belongs, so the agent's signature approves "a payment to this
        // payee with this nonce" at ANY amount. Whoever relays the signed intent (a bundler, a mempool watcher) picks the amount.
        uint256 signedAmount = LibStorage.fixed_(LibStorage.O7_AMOUNT) ? i.amount : 0;
        bytes32 h = keccak256(abi.encode(INTENT_TYPEHASH, i.owner, i.to, signedAmount, i.intentNonce, i.ts));
        h = keccak256(abi.encode(h, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    function _recover(bytes32 d, bytes memory sig) internal view returns (address) {
        require(sig.length == 65, "bad sig");
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "malleable s");
        address a = ecrecover(d, v, r, s);
        // O6: ecrecover returns address(0) for ANY invalid signature instead of reverting. Without this check, a config whose
        // `agent` was left unset (address(0)) accepts garbage as the agent's signature, and anyone can submit payments.
        if (LibStorage.fixed_(LibStorage.O6_ZERO_SIGNER)) require(a != address(0), "bad sig");
        return a;
    }

    function executePayment(Config calldata c, bytes calldata ownerSig, Intent calldata i, bytes calldata agentSig) external {
        LibStorage.S storage st = LibStorage.s();
        bool reentrancySafe = LibStorage.fixed_(LibStorage.O4_REENTRY);
        if (reentrancySafe) { require(!st.locked, "reentrant"); st.locked = true; }

        LibStorage.OwnerState storage o = st.owners[c.owner];
        require(_recover(configDigest(c), ownerSig) == c.owner, "owner sig");
        require(c.configNonce == o.configNonce, "config revoked");
        require(_recover(intentDigest(i), agentSig) == c.agent, "agent sig");
        require(i.owner == c.owner, "owner mismatch");
        require(i.intentNonce == o.intentNonce + 1, "intent nonce");
        // O5: the intent carries a timestamp but nothing bounds it, so a signed intent stays executable until its nonce is used.
        // A relayer that withholds it (or an attacker who copied it from a queue) can run it weeks later, after the invoice it
        // paid was cancelled or the vendor's account changed.
        if (LibStorage.fixed_(LibStorage.O5_EXPIRY)) require(i.ts <= block.timestamp && block.timestamp - i.ts <= LibStorage.MAX_INTENT_AGE, "stale intent");
        require(i.to == c.recipient, "recipient not allowed");
        require(i.amount <= c.maxPerTx, "over per-tx cap");

        // O2: the cap bucket must come from the chain's clock; the vulnerable version trusts the day the agent wrote in the intent.
        uint256 dayKey = (LibStorage.fixed_(LibStorage.O2_DAYKEY) ? block.timestamp : i.ts) / 1 days;
        require(o.spent[dayKey] + i.amount <= c.dailyCap, "over daily cap");

        if (reentrancySafe) {
            // checks-effects-interactions: all accounting is done before the token (and any hook it fires) runs
            o.intentNonce = i.intentNonce;
            o.spent[dayKey] += i.amount;
            require(st.token.transferFrom(c.owner, i.to, i.amount), "transfer failed");
            st.locked = false;
        } else {
            // O4: the token call happens first; a token or recipient hook can call executePayment again with the
            // same signed intent while the nonce and the daily counter still hold their old values.
            require(st.token.transferFrom(c.owner, i.to, i.amount), "transfer failed");
            o.intentNonce = i.intentNonce;
            o.spent[dayKey] += i.amount;
        }
        emit PaymentExecuted(c.owner, i.to, i.amount, i.intentNonce);
    }
}
