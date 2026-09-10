// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @notice Test double for Arc's USDC ERC-20 face, etched at 0x3600...0000.
/// @dev On Arc, native USDC (18 decimals, what msg.value and address.balance count) and
///      the ERC-20 at 0x3600...0000 (6 decimals) are one balance seen two ways; there is
///      no wrapping. A plain mock ERC-20 would get the one property that matters wrong:
///      that paying a pool through transferFrom drains the payer's native balance. So this
///      keeps no balances of its own. It reads and writes native balances through the
///      cheatcodes, scaled by 1e12, which is what the precompile does on the real chain.
///
///      It is still a model. The migration is rehearsed end to end on Arc testnet against
///      the real precompile before mainnet; this is what makes the unit tests honest.
///
///      One thing it cannot model: vm.deal is not undone when the call around it reverts. A
///      test that expects a migration to revert partway therefore restores state with
///      vm.revertToState before carrying on. On the chain, a revert undoes the precompile's
///      balance moves like any other state change.
contract ArcUSDC {
    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SCALE = 1e12;

    string public constant name = "USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external pure returns (uint256) {
        return type(uint128).max;
    }

    /// @dev floored, as on the real chain: sub-micro-USDC is invisible through this face
    function balanceOf(address who) public view returns (uint256) {
        return who.balance / SCALE;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        uint256 native = value * SCALE;
        require(from.balance >= native, "balance");
        VM.deal(from, from.balance - native);
        VM.deal(to, to.balance + native);
        emit Transfer(from, to, value);
    }
}
