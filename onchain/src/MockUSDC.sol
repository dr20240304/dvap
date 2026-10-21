// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ITokenReceiver { function onTokenReceived(address from, uint256 amount) external; }

/// 6-decimal ERC-20 with an ERC-777/677-style receiver hook. Plain ERC-20s have no such callback, but token standards such as
/// ERC-777, ERC-1363 and ERC-677 do, which is what makes the O4 reentrancy real.
contract MockUSDC {
    string public constant name = "Mock USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public hooks = true;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function setHooks(bool on) external { hooks = on; }

    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[from][msg.sender];
        require(al >= a, "allowance");
        if (al != type(uint256).max) allowance[from][msg.sender] = al - a;
        require(balanceOf[from] >= a, "balance");
        balanceOf[from] -= a;
        balanceOf[to] += a;
        if (hooks && to.code.length > 0) ITokenReceiver(to).onTokenReceived(from, a);
        return true;
    }
}
