// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ANewOne, ANewOneToken} from "../src/ANewOne.sol";

/// @notice Drives the platform with random sequences of every state-changing action across
///         several actors and many tokens. Reverting actions (anti-snipe cap, slippage,
///         empty pots) are swallowed so the fuzzer keeps exploring instead of dead-ending.
contract Handler is Test {
    ANewOne public arcade;
    address[] public actors;
    address[] public tokens;

    constructor(ANewOne _arcade, address[] memory _actors) {
        arcade = _arcade;
        actors = _actors;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function createToken(uint256 actorSeed, uint256 valueSeed) public {
        address a = _actor(actorSeed);
        uint256 value = bound(valueSeed, 0, 200e18);
        if (value > a.balance) value = 0;
        vm.prank(a);
        try arcade.createToken{value: value}("T", "T", "", "") returns (address t) {
            tokens.push(t);
        } catch {}
    }

    function buy(uint256 actorSeed, uint256 tokenSeed, uint256 valueSeed) public {
        if (tokens.length == 0) return;
        address a = _actor(actorSeed);
        address t = tokens[tokenSeed % tokens.length];
        uint256 value = bound(valueSeed, 1, 20_000e18);
        if (value > a.balance) return;
        vm.prank(a);
        try arcade.buy{value: value}(t, 0) {} catch {}
    }

    function sell(uint256 actorSeed, uint256 tokenSeed, uint256 amtSeed) public {
        if (tokens.length == 0) return;
        address a = _actor(actorSeed);
        address t = tokens[tokenSeed % tokens.length];
        uint256 bal = ANewOneToken(t).balanceOf(a);
        if (bal == 0) return;
        uint256 amt = bound(amtSeed, 1, bal);
        vm.startPrank(a);
        ANewOneToken(t).approve(address(arcade), amt);
        try arcade.sell(t, amt, 0) {} catch {}
        vm.stopPrank();
    }

    function claim(uint256 actorSeed) public {
        address a = _actor(actorSeed);
        vm.prank(a);
        try arcade.claimCreatorFees() {} catch {}
    }

    function sweep(uint256 actorSeed, uint256 creatorSeed) public {
        vm.prank(_actor(actorSeed));
        try arcade.sweepExpired(_actor(creatorSeed)) {} catch {}
    }

    function advanceTime(uint256 dt) public {
        vm.warp(block.timestamp + bound(dt, 0, 10 days));
    }

    function advanceBlocks(uint256 db) public {
        vm.roll(block.number + bound(db, 0, 30));
    }
}

/// @notice Global properties that must hold no matter what history the handler produces.
///         All actors are EOAs (they accept native payouts), so the platform's whole native
///         balance is backed by exactly three buckets: curve reserves, creator pots, platform pot.
contract ANewOneInvariant is Test {
    ANewOne arcade;
    Handler handler;
    address[] actors;

    uint256 constant V0 = 4_000e18;
    uint256 constant GRAD = 5_000e18;

    function setUp() public {
        arcade = new ANewOne(V0, GRAD);
        for (uint256 i = 0; i < 4; i++) {
            address a = address(uint160(0xACC0 + i)); // above precompiles, plain EOAs
            actors.push(a);
            vm.deal(a, 1_000_000e18);
        }
        handler = new Handler(arcade, actors);

        bytes4[] memory sel = new bytes4[](8);
        sel[0] = Handler.createToken.selector;
        sel[1] = Handler.buy.selector;
        sel[2] = Handler.sell.selector;
        sel[3] = Handler.claim.selector;
        sel[4] = Handler.sweep.selector;
        sel[5] = Handler.advanceTime.selector;
        sel[6] = Handler.advanceBlocks.selector;
        sel[7] = Handler.buy.selector; // weight buying so curves actually fill
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// @dev The contract's native balance must always cover every claim against it:
    ///      Σ curve reserves + Σ creator pots + platform pot. If it ever fell short, some
    ///      user's sell / claim / withdraw could fail or the platform would be insolvent.
    function invariant_solvent() public view {
        uint256 liabilities = arcade.platformFees();
        uint256 n = arcade.tokensCount();
        for (uint256 i = 0; i < n; i++) {
            (,,,,, uint256 raised,) = arcade.info(arcade.allTokens(i));
            liabilities += raised;
        }
        for (uint256 i = 0; i < actors.length; i++) {
            liabilities += arcade.creatorFees(actors[i]);
        }
        assertGe(address(arcade).balance, liabilities);
    }

    /// @dev The token units the curve *thinks* it holds (tReserve) must equal the ERC20 units
    ///      it *actually* holds. Divergence would mean tokens were minted/leaked off the books.
    function invariant_curveTokenBalanceMatchesReserve() public view {
        uint256 n = arcade.tokensCount();
        for (uint256 i = 0; i < n; i++) {
            address t = arcade.allTokens(i);
            (,,,, uint256 tReserve,,) = arcade.info(t);
            assertEq(ANewOneToken(t).balanceOf(address(arcade)), tReserve);
        }
    }

    /// @dev The virtual reserve can never dip below its seeded floor, and the exact accounting
    ///      identity vUsdc == virtualUsdc0 + raised must hold on every token forever.
    function invariant_virtualFloorAndRaisedIdentity() public view {
        uint256 n = arcade.tokensCount();
        for (uint256 i = 0; i < n; i++) {
            (,,, uint256 vUsdc, uint256 tReserve, uint256 raised,) = arcade.info(arcade.allTokens(i));
            assertGe(vUsdc, arcade.virtualUsdc0());
            assertEq(vUsdc - arcade.virtualUsdc0(), raised);
            assertLe(tReserve, arcade.TOTAL_SUPPLY());
        }
    }
}
