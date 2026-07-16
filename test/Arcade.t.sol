// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Arcade, ArcadeToken} from "../src/Arcade.sol";

contract ArcadeTest is Test {
    Arcade arcade;
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant V0 = 4_000e18; // virtual USDC
    uint256 constant GRAD = 5_000e18; // graduation target

    function setUp() public {
        arcade = new Arcade(V0, GRAD);
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
        assertEq(ArcadeToken(token).balanceOf(address(arcade)), arcade.TOTAL_SUPPLY());
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

        assertEq(ArcadeToken(token).balanceOf(alice), quoted);
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
        uint256 aliceTokens = ArcadeToken(token).balanceOf(alice);

        vm.startPrank(alice);
        ArcadeToken(token).approve(address(arcade), aliceTokens);
        arcade.sell(token, aliceTokens, 0);
        vm.stopPrank();

        (,,, uint256 vUsdc, uint256 tReserve, uint256 raised,) = arcade.info(token);
        assertLe(raised, 1); // dust only
        assertGe(vUsdc, V0); // virtual floor intact
        assertEq(tReserve + ArcadeToken(token).balanceOf(alice), arcade.TOTAL_SUPPLY());
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
        assertLe(ArcadeToken(token).balanceOf(alice), cap);

        // after window, big buys allowed
        vm.roll(block.number + 21);
        vm.prank(bob);
        arcade.buy{value: 150e18}(token, 0);
        assertGt(ArcadeToken(token).balanceOf(bob), 0);
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
        uint256 got = ArcadeToken(token).balanceOf(creator);
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

    function testFuzz_buySellInvariant(uint96 buyAmount) public {
        vm.assume(buyAmount > 0.01e18 && buyAmount < 50_000e18);
        address token = _create();
        vm.roll(block.number + 21);

        vm.prank(alice);
        arcade.buy{value: buyAmount}(token, 0);
        uint256 got = ArcadeToken(token).balanceOf(alice);

        vm.startPrank(alice);
        ArcadeToken(token).approve(address(arcade), got);
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
