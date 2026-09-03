// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ANewOne, ANewOneToken} from "../src/ANewOne.sol";

/// @notice An actor that is a contract and refuses native payments. The existing invariant suite
///         drives only EOAs by design, so nothing there ever exercises a failing payout.
contract HostileActor {
    ANewOne public arcade;

    constructor(ANewOne a) {
        arcade = a;
    }

    function create() external returns (address) {
        return arcade.createToken("H", "H", "", "");
    }

    function buy(address t, uint256 value) external {
        arcade.buy{value: value}(t, 0);
    }

    function claim() external {
        arcade.claimCreatorFees();
    }

    receive() external payable {
        revert("rejected");
    }
}

/// @notice Extends the fuzzed surface with the paths the existing handler never reaches:
///         withdrawPlatformFees, owner churn, and a payout target that always reverts.
contract AdversarialHandler is Test {
    ANewOne public arcade;
    HostileActor public hostile;
    address[] public actors;
    address[] public tokens;

    constructor(ANewOne _arcade, address[] memory _actors, HostileActor _hostile) {
        arcade = _arcade;
        actors = _actors;
        hostile = _hostile;
    }

    receive() external payable {}

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

    function createTokenAsHostile() public {
        try hostile.create() returns (address t) {
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

    function buyAsHostile(uint256 tokenSeed, uint256 valueSeed) public {
        if (tokens.length == 0) return;
        address t = tokens[tokenSeed % tokens.length];
        uint256 value = bound(valueSeed, 1, 5_000e18);
        if (value > address(hostile).balance) return;
        try hostile.buy(t, value) {} catch {}
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
        vm.prank(_actor(actorSeed));
        try arcade.claimCreatorFees() {} catch {}
    }

    function claimAsHostile() public {
        try hostile.claim() {} catch {}
    }

    function sweep(uint256 actorSeed, uint256 creatorSeed) public {
        vm.prank(_actor(actorSeed));
        try arcade.sweepExpired(_actor(creatorSeed)) {} catch {}
    }

    function sweepHostile(uint256 actorSeed) public {
        vm.prank(_actor(actorSeed));
        try arcade.sweepExpired(address(hostile)) {} catch {}
    }

    /// @dev The path the existing handler never takes. `to` may be the hostile contract, so the
    ///      reverting-payout branch gets exercised too.
    function withdrawPlatformFees(uint256 toSeed) public {
        address to = toSeed % 5 == 0 ? address(hostile) : _actor(toSeed);
        try arcade.withdrawPlatformFees(to) {} catch {}
    }

    function addOwner(uint256 actorSeed) public {
        try arcade.addOwner(_actor(actorSeed)) {} catch {}
    }

    function removeOwner(uint256 actorSeed) public {
        try arcade.removeOwner(_actor(actorSeed)) {} catch {}
    }

    function advanceTime(uint256 dt) public {
        vm.warp(block.timestamp + bound(dt, 0, 10 days));
    }

    function advanceBlocks(uint256 db) public {
        vm.roll(block.number + bound(db, 0, 30));
    }
}

contract ANewOneAdversarialInvariant is Test {
    ANewOne arcade;
    AdversarialHandler handler;
    HostileActor hostile;
    address[] actors;

    uint256 constant V0 = 4_000e18;
    uint256 constant GRAD = 5_000e18;

    function setUp() public {
        arcade = new ANewOne(V0, GRAD);
        for (uint256 i = 0; i < 4; i++) {
            address a = address(uint160(0xACC0 + i));
            actors.push(a);
            vm.deal(a, 1_000_000e18);
        }
        hostile = new HostileActor(arcade);
        vm.deal(address(hostile), 1_000_000e18);

        handler = new AdversarialHandler(arcade, actors, hostile);
        arcade.addOwner(address(handler)); // so the withdraw / owner-churn paths are reachable

        bytes4[] memory sel = new bytes4[](14);
        sel[0] = AdversarialHandler.createToken.selector;
        sel[1] = AdversarialHandler.createTokenAsHostile.selector;
        sel[2] = AdversarialHandler.buy.selector;
        sel[3] = AdversarialHandler.buyAsHostile.selector;
        sel[4] = AdversarialHandler.sell.selector;
        sel[5] = AdversarialHandler.claim.selector;
        sel[6] = AdversarialHandler.claimAsHostile.selector;
        sel[7] = AdversarialHandler.sweep.selector;
        sel[8] = AdversarialHandler.sweepHostile.selector;
        sel[9] = AdversarialHandler.withdrawPlatformFees.selector;
        sel[10] = AdversarialHandler.addOwner.selector;
        sel[11] = AdversarialHandler.removeOwner.selector;
        sel[12] = AdversarialHandler.advanceTime.selector;
        sel[13] = AdversarialHandler.buy.selector; // weight buying so curves actually fill
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    function _liabilities() internal view returns (uint256 total) {
        total = arcade.platformFees();
        uint256 n = arcade.tokensCount();
        for (uint256 i = 0; i < n; i++) {
            (,,,,, uint256 raised,) = arcade.info(arcade.allTokens(i));
            total += raised;
        }
        for (uint256 i = 0; i < actors.length; i++) {
            total += arcade.creatorFees(actors[i]);
        }
        total += arcade.creatorFees(address(hostile));
        total += arcade.creatorFees(address(handler));
    }

    /// @dev Solvency has to survive owners withdrawing, owners being added and removed, and a
    ///      creator whose payouts always revert.
    function invariant_solventUnderWithdrawalsAndHostilePayouts() public view {
        assertGe(address(arcade).balance, _liabilities(), "platform is insolvent");
    }

    /// @dev The sharpest version of the "rug-proof" claim: whatever owners do with the fee pot,
    ///      the native backing every curve's reserves must still be there.
    function invariant_ownerWithdrawalsNeverTouchCurveReserves() public view {
        uint256 reserves;
        uint256 n = arcade.tokensCount();
        for (uint256 i = 0; i < n; i++) {
            (,,,,, uint256 raised,) = arcade.info(arcade.allTokens(i));
            reserves += raised;
        }
        assertGe(address(arcade).balance, reserves, "curve reserves were withdrawn");
    }

    /// @dev Token bookkeeping must stay exact even with a contract actor in the mix.
    function invariant_curveTokenBalanceMatchesReserve() public view {
        uint256 n = arcade.tokensCount();
        for (uint256 i = 0; i < n; i++) {
            address t = arcade.allTokens(i);
            (,,,, uint256 tReserve,,) = arcade.info(t);
            assertEq(ANewOneToken(t).balanceOf(address(arcade)), tReserve);
        }
    }

    /// @dev There must always be someone able to administer the platform.
    function invariant_atLeastOneOwnerAlways() public view {
        assertGt(arcade.ownersCount(), 0, "platform was left with no owner");
    }
}
