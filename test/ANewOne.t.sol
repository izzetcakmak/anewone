// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ANewOne, ANewOneToken} from "../src/ANewOne.sol";

contract ANewOneTest is Test {
    ANewOne arcade;
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant V0 = 4_000e18; // virtual USDC
    uint256 constant GRAD = 5_000e18; // graduation target

    function setUp() public {
        arcade = new ANewOne(V0, GRAD);
        vm.deal(creator, 100_000e18);
        vm.deal(alice, 100_000e18);
        vm.deal(bob, 100_000e18);
    }

    function _create() internal returns (address token) {
        vm.prank(creator);
        token = arcade.createToken("Noah's Arc", "NOAH", "ipfs://noah");
    }

    function test_createToken() public {
        address token = _create();
        assertEq(arcade.tokensCount(), 1);
        assertEq(ANewOneToken(token).balanceOf(address(arcade)), arcade.TOTAL_SUPPLY());
        (address c,,, uint256 vUsdc, uint256 tReserve, uint256 raised,) = arcade.info(token);
        assertEq(c, creator);
        assertEq(vUsdc, V0);
        assertEq(tReserve, arcade.TOTAL_SUPPLY());
        assertEq(raised, 0);
    }

    function test_buyGivesTokensAndAccruesFees() public {
        address token = _create();
        vm.roll(block.number + 21); // past anti-snipe window

        uint256 quoted = arcade.quoteBuy(token, 100e18);
        vm.prank(alice);
        arcade.buy{value: 100e18}(token, quoted);

        assertEq(ANewOneToken(token).balanceOf(alice), quoted);
        assertGt(quoted, 0);
        // 1% fee split: 0.5 creator / 0.5 platform
        assertEq(arcade.creatorFees(creator), 0.5e18);
        assertEq(arcade.platformFees(), 0.5e18);
        (,,,,, uint256 raised,) = arcade.info(token);
        assertEq(raised, 99e18);
    }

    function test_priceIncreasesWithBuys() public {
        address token = _create();
        vm.roll(block.number + 21);
        uint256 p0 = arcade.priceWad(token);
        vm.prank(alice);
        arcade.buy{value: 500e18}(token, 0);
        uint256 p1 = arcade.priceWad(token);
        assertGt(p1, p0);
    }

    function test_sellRoundTripNeverDrainsVirtualFloor() public {
        address token = _create();
        vm.roll(block.number + 21);

        vm.prank(alice);
        arcade.buy{value: 1_000e18}(token, 0);
        uint256 aliceTokens = ANewOneToken(token).balanceOf(alice);

        vm.startPrank(alice);
        ANewOneToken(token).approve(address(arcade), aliceTokens);
        arcade.sell(token, aliceTokens, 0);
        vm.stopPrank();

        (,,, uint256 vUsdc, uint256 tReserve, uint256 raised,) = arcade.info(token);
        assertLe(raised, 1); // dust only
        assertGe(vUsdc, V0); // virtual floor intact
        assertEq(tReserve + ANewOneToken(token).balanceOf(alice), arcade.TOTAL_SUPPLY());
        // contract still solvent for fees
        assertGe(address(arcade).balance, arcade.platformFees() + arcade.creatorFees(creator));
    }

    function test_antiSnipeCapInEarlyBlocks() public {
        address token = _create();
        // within window: cap = 2% of supply = 20M tokens
        uint256 cap = arcade.ANTI_SNIPE_MAX();
        uint256 costOverCap = 150e18; // pushes past 2% at start price (~4e-6): ~2.4% of supply

        vm.prank(alice);
        vm.expectRevert("anti-snipe cap");
        arcade.buy{value: costOverCap}(token, 0);

        // small buy under cap succeeds
        vm.prank(alice);
        arcade.buy{value: 50e18}(token, 0);
        assertLe(ANewOneToken(token).balanceOf(alice), cap);

        // after window, big buys allowed
        vm.roll(block.number + 21);
        vm.prank(bob);
        arcade.buy{value: 150e18}(token, 0);
        assertGt(ANewOneToken(token).balanceOf(bob), 0);
    }

    function test_graduationAtTarget() public {
        address token = _create();
        vm.roll(block.number + 21);
        vm.prank(alice);
        arcade.buy{value: 6_000e18}(token, 0); // raised ~5940 > 5000 target
        (,, bool graduated,,,,) = arcade.info(token);
        assertTrue(graduated);
        assertEq(arcade.progressBps(token), 10_000);
    }

    function test_feeClaims() public {
        address token = _create();
        vm.roll(block.number + 21);
        vm.prank(alice);
        arcade.buy{value: 1_000e18}(token, 0);

        uint256 before = creator.balance;
        vm.prank(creator);
        arcade.claimCreatorFees();
        assertEq(creator.balance - before, 5e18);

        uint256 ownerBefore = address(this).balance;
        arcade.withdrawPlatformFees(address(this));
        assertEq(address(this).balance - ownerBefore, 5e18);
    }

    function test_initialDevBuyOnCreate() public {
        // dev buy at creation is allowed but still subject to the anti-snipe cap (fair launch)
        vm.prank(creator);
        address token = arcade.createToken{value: 50e18}("Test", "TST", "");
        uint256 got = ANewOneToken(token).balanceOf(creator);
        assertGt(got, 0);
        assertLe(got, arcade.ANTI_SNIPE_MAX());

        vm.prank(creator);
        vm.expectRevert("anti-snipe cap");
        arcade.createToken{value: 150e18}("Test2", "TST2", "");
    }

    function test_slippageProtection() public {
        address token = _create();
        vm.roll(block.number + 21);
        uint256 quoted = arcade.quoteBuy(token, 100e18);
        vm.prank(alice);
        vm.expectRevert("slippage");
        arcade.buy{value: 100e18}(token, quoted + 1e18);
    }

    function test_creatorFeeExpiresAfter7Days() public {
        address token = _create();
        vm.roll(block.number + 21);
        vm.prank(alice);
        arcade.buy{value: 1_000e18}(token, 0); // creator pot: 5 USDC
        assertEq(arcade.creatorFees(creator), 5e18);
        assertFalse(arcade.creatorFeeExpired(creator));
        assertEq(arcade.creatorFeeDeadline(creator), block.timestamp + 7 days);

        vm.warp(block.timestamp + 7 days + 1);
        assertTrue(arcade.creatorFeeExpired(creator));

        // claim after expiry pays nothing — pot rolls into platform fees
        uint256 balBefore = creator.balance;
        uint256 platBefore = arcade.platformFees();
        vm.prank(creator);
        arcade.claimCreatorFees();
        assertEq(creator.balance, balBefore);
        assertEq(arcade.creatorFees(creator), 0);
        assertEq(arcade.platformFees(), platBefore + 5e18);
    }

    function test_sweepExpiredByAnyone() public {
        address token = _create();
        vm.roll(block.number + 21);
        vm.prank(alice);
        arcade.buy{value: 1_000e18}(token, 0);

        vm.prank(bob);
        vm.expectRevert("not expired");
        arcade.sweepExpired(creator);

        vm.warp(block.timestamp + 7 days + 1);
        uint256 platBefore = arcade.platformFees();
        vm.prank(bob); // anyone can sweep
        arcade.sweepExpired(creator);
        assertEq(arcade.creatorFees(creator), 0);
        assertEq(arcade.platformFees(), platBefore + 5e18);

        // swept funds are withdrawable by owner
        uint256 ownerBefore = address(this).balance;
        arcade.withdrawPlatformFees(address(this));
        assertEq(address(this).balance - ownerBefore, platBefore + 5e18);
    }

    function test_claimWindowSemantics() public {
        address token = _create();
        vm.roll(block.number + 21);
        vm.prank(alice);
        arcade.buy{value: 100e18}(token, 0);
        uint256 t0 = arcade.creatorFeeSince(creator);

        // new fees into a non-empty pot do NOT reset the deadline
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        arcade.buy{value: 100e18}(token, 0);
        assertEq(arcade.creatorFeeSince(creator), t0);

        // claiming in time pays out and empties the pot
        vm.prank(creator);
        arcade.claimCreatorFees();
        assertEq(arcade.creatorFees(creator), 0);

        // next fee starts a fresh window
        vm.warp(block.timestamp + 10 days);
        vm.prank(alice);
        arcade.buy{value: 100e18}(token, 0);
        assertFalse(arcade.creatorFeeExpired(creator));
        assertGt(arcade.creatorFeeSince(creator), t0);
    }

    function test_freshFeesNeverInheritExpiredWindow() public {
        address token = _create();
        vm.roll(block.number + 21);
        vm.prank(alice);
        arcade.buy{value: 1_000e18}(token, 0); // pot: 5 USDC
        uint256 platBefore = arcade.platformFees();

        // pot expires unclaimed; token keeps trading
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(alice);
        arcade.buy{value: 1_000e18}(token, 0); // fresh 5 USDC cut

        // old pot rolled to platform, fresh cut got its own full window
        assertEq(arcade.creatorFees(creator), 5e18);
        assertEq(arcade.platformFees(), platBefore + 5e18 + 5e18); // old pot + new platform half
        assertFalse(arcade.creatorFeeExpired(creator));
        assertEq(arcade.creatorFeeDeadline(creator), block.timestamp + 7 days);

        // creator can claim the fresh pot in full
        uint256 balBefore = creator.balance;
        vm.prank(creator);
        arcade.claimCreatorFees();
        assertEq(creator.balance - balBefore, 5e18);
    }

    // ---------------------------------------------------------------- owners

    function test_deployerIsInitialOwner() public {
        assertTrue(arcade.isOwner(address(this)));
        assertEq(arcade.ownersCount(), 1);
        assertEq(arcade.owners(0), address(this));
    }

    function test_secondOwnerSharesFeePool() public {
        address token = _create();
        vm.roll(block.number + 21);
        vm.prank(alice);
        arcade.buy{value: 1_000e18}(token, 0); // platformFees += 5e18

        assertFalse(arcade.isOwner(bob));
        arcade.addOwner(bob);
        assertTrue(arcade.isOwner(bob));
        assertEq(arcade.ownersCount(), 2);

        // the second owner can withdraw the whole shared pool (Option A semantics)
        uint256 pf = arcade.platformFees();
        assertGt(pf, 0);
        uint256 before = bob.balance;
        vm.prank(bob);
        arcade.withdrawPlatformFees(bob);
        assertEq(bob.balance - before, pf);
        assertEq(arcade.platformFees(), 0);
    }

    function test_nonOwnerCannotWithdrawOrAdmin() public {
        vm.prank(alice);
        vm.expectRevert("owner");
        arcade.withdrawPlatformFees(alice);
        vm.prank(alice);
        vm.expectRevert("owner");
        arcade.addOwner(alice);
        vm.prank(alice);
        vm.expectRevert("owner");
        arcade.removeOwner(address(this));
    }

    function test_addOwnerValidation() public {
        vm.expectRevert("zero addr");
        arcade.addOwner(address(0));
        arcade.addOwner(bob);
        vm.expectRevert("already owner");
        arcade.addOwner(bob);
    }

    function test_removeOwnerRevokesAccess() public {
        arcade.addOwner(bob);
        vm.prank(bob); // a second owner has full admin rights
        arcade.addOwner(alice);
        assertEq(arcade.ownersCount(), 3);

        arcade.removeOwner(bob);
        assertFalse(arcade.isOwner(bob));
        assertEq(arcade.ownersCount(), 2);

        vm.prank(bob);
        vm.expectRevert("owner");
        arcade.addOwner(address(0xDEAD));
    }

    function test_cannotRemoveLastOwner() public {
        vm.expectRevert("last owner");
        arcade.removeOwner(address(this));
        assertTrue(arcade.isOwner(address(this)));
    }

    function test_ownersArrayConsistentAfterSwapPop() public {
        arcade.addOwner(alice);
        arcade.addOwner(bob); // [this, alice, bob]
        arcade.removeOwner(alice); // swap-pop: [this, bob]
        assertEq(arcade.ownersCount(), 2);
        assertTrue(arcade.isOwner(address(this)) && arcade.isOwner(bob) && !arcade.isOwner(alice));
        address o0 = arcade.owners(0);
        address o1 = arcade.owners(1);
        assertTrue(o0 != o1);
        assertTrue(o0 == address(this) || o0 == bob);
        assertTrue(o1 == address(this) || o1 == bob);
    }

    function testFuzz_buySellInvariant(uint96 buyAmount) public {
        vm.assume(buyAmount > 0.01e18 && buyAmount < 50_000e18);
        address token = _create();
        vm.roll(block.number + 21);

        vm.prank(alice);
        arcade.buy{value: buyAmount}(token, 0);
        uint256 got = ANewOneToken(token).balanceOf(alice);

        vm.startPrank(alice);
        ANewOneToken(token).approve(address(arcade), got);
        arcade.sell(token, got, 0);
        vm.stopPrank();

        // alice can never profit from a round trip (fees + curve)
        assertLt(alice.balance, 100_000e18);
        // contract balance always covers raised + all fees
        (,,,,, uint256 raised,) = arcade.info(token);
        assertGe(address(arcade).balance, raised + arcade.platformFees() + arcade.creatorFees(creator));
    }

    receive() external payable {}
}
