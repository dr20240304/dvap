# DVAP on-chain: a vulnerable payment router

A deliberately small example of an agent-payment router contract: owner-signed config, agent-signed intent, a standing ERC-20 allowance and a kill-switch nonce. **It is not audited code.** It is built to show four bug classes that appear in this design shape. Chain-specific features are out of scope: plain `ecrecover` and an ERC-20.

```
make onchain-test     # 10 Foundry tests: vulnerable behaviour and the fix for each bug
make onchain-demo     # live: anvil, O1 takeover and drain, then the fixed run
```
Needs Foundry (`forge`, `anvil`). `lib/forge-std` is vendored (v1.9.7). Fixes are a bitmask passed to the `Router` constructor (like `DVAP_HARDEN`):
`O1=1, O2=2, O3=4, O4=8, all=15`; a bug is live unless its bit is set.

| Bug | What is wrong | Impact in the test | Fix |
|---|---|---|---|
| **O1** re-callable `init()` | Nothing records that init already ran, so anyone can call it again, become owner, and `setModule` in a module that runs as the router | A stranger drains every user's standing allowance ($1,400 of $1,400) | `initialized` flag + owner check |
| **O2** cap bucket from the signer | Daily-cap day = the timestamp the agent wrote in its intent | $500 paid in one real day against a $100/day cap | use `block.timestamp` |
| **O3** no domain separation | Config digest has no chain id or contract address | A config signed for staging spends real funds on prod ($900) | bind digest to `chainid` and `address(this)` |
| **O4** reentrancy | Token call before nonce and daily counter are updated; a receiver hook (ERC-777/1363 style) re-enters with the same intent | One signed $100 intent pays $600; the nonce says 1 payment | checks-effects-interactions + reentrancy guard |

## Honest limits
- The modular proxy design is not the bug. O1 is a classic unprotected initializer; the router only makes the blast radius total, because one stable spender address holds every user's allowance and `setModule` can change what that address does.
- O4 needs a token with a receiver callback (ERC-777, ERC-1363, ERC-677 style). A plain ERC-20 has none.
- O2 and O3 are design-level mistakes: a well-built router binds the signing domain and uses block time; these are the mistakes an implementation could make.
- Test accounts are anvil's public dev keys. Nothing here touches a real network.

## Files
`src/Router.sol` fallback-only proxy · `src/AdminModules.sol` upgrade / init / wallet (kill switch) · `src/PaymentModule.sol` `executePayment` ·
`src/MockUSDC.sol` 6-decimal token with receiver hook · `test/Router.t.sol` exploit and fix per bug · `script/Demo.s.sol` + `demo.sh` live O1.
