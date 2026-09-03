// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ANewOne, ANewOneToken} from "../src/ANewOne.sol";

/// @notice A trader that tries to re-enter sell() from inside its own payout.
contract ReentrantTrader {
    ANewOne public arcade;
    address public token;
    bool public attempted;
    bool public reentrySucceeded;

    constructor(ANewOne a) {
        arcade = a;
    }

    function setToken(address t) external {
        token = t;
    }

    function buy(uint256 value) external {
        arcade.buy{value: value}(token, 0);
    }

    function sellHalf() external {
        uint256 bal = ANewOneToken(token).balanceOf(address(this));
        ANewOneToken(token).approve(address(arcade), bal);
        arcade.sell(token, bal / 2, 0);
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        uint256 bal = ANewOneToken(token).balanceOf(address(this));
        if (bal == 0) return;
        ANewOneToken(token).approve(address(arcade), bal);
        try arcade.sell(token, bal, 0) {
            reentrySucceeded = true;
        } catch {}
    }
}

/// @notice A creator that refuses every native payment.
contract RejectsEther {
    ANewOne public arcade;

    constructor(ANewOne a) {
        arcade = a;
    }

    function create() external returns (address) {
        return arcade.createToken("R", "R", "", "");
    }

    function claim() external {
        arcade.claimCreatorFees();
    }

    receive() external payable {
        revert("rejected");
    }
}

/// @notice Attempts to break the platform on purpose. Every test here is written to FAIL if
///         the attack works, so a green run is evidence the attack was tried and repelled.
contract ANewOneAdversarialTest is Test {
    ANewOne arcade;
    uint256 constant V0 = 4_000e18;
    uint256 constant GRAD = 5_000e18;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        arcade = new ANewOne(V0, GRAD);
        vm.deal(alice, 1_000_000e18);
        vm.deal(bob, 1_000_000e18);
        vm.deal(address(this), 1_000_000e18);
    }

    function _launch(address who) internal returns (address t) {
        vm.prank(who);
        t = arcade.createToken("T", "T", "", "");
        vm.roll(block.number + arcade.ANTI_SNIPE_BLOCKS() + 1); // past the early cap window
    }

    function _sell(address who, address t, uint256 amt) internal {
        vm.startPrank(who);
        ANewOneToken(t).approve(address(arcade), amt);
        arcade.sell(t, amt, 0);
        vm.stopPrank();
    }

    /// @dev Every native unit the platform holds is owed to exactly one of three buckets:
    ///      curve reserves, creator pots, the platform pot. If the balance ever fell short,
    ///      value escaped the protocol's own books.
    function _assertSolvent() internal view {
        uint256 liabilities = arcade.platformFees() + arcade.creatorFees(alice) + arcade.creatorFees(bob);
        uint256 n = arcade.tokensCount();
        for (uint256 i = 0; i < n; i++) {
            (,,,,, uint256 raised,) = arcade.info(arcade.allTokens(i));
            liabilities += raised;
        }
        assertGe(address(arcade).balance, liabilities, "platform is insolvent");
    }

    // ------------------------------------------------------------ value extraction

    /// @dev The headline economic property: buying and immediately selling back must always
    ///      cost the trader money. If it ever paid, the curve would be a free money printer.
    function testFuzz_attack_roundTripNeverProfits(uint96 raw) public {
        uint256 spend = bound(uint256(raw), 1e15, 50_000e18);
        address t = _launch(alice);

        uint256 before = bob.balance;
        vm.prank(bob);
        arcade.buy{value: spend}(t, 0);
        uint256 got = ANewOneToken(t).balanceOf(bob);
        vm.assume(got > 0);
        _sell(bob, t, got);

        assertLe(bob.balance, before, "round trip returned more than it cost");
    }

    /// @dev Same, but split across many small trades: rounding must not accumulate in the
    ///      trader's favour over a long sequence.
    function test_attack_manySmallRoundTripsNeverProfit() public {
        address t = _launch(alice);
        uint256 before = bob.balance;
        for (uint256 i = 0; i < 40; i++) {
            vm.prank(bob);
            arcade.buy{value: 1e16}(t, 0);
            uint256 bal = ANewOneToken(t).balanceOf(bob);
            if (bal > 0) _sell(bob, t, bal);
        }
        assertLe(bob.balance, before, "small-trade loop printed value");
    }

    /// @dev A sandwich IS profitable on any constant-product curve — that is MEV, not a contract
    ///      bug, and the UI defends it with a 2% default slippage bound (this test deliberately
    ///      passes minOut=0 to remove that guard). What must never happen is the attacker
    ///      profiting by MORE than the victim loses: that would mean the surplus came out of the
    ///      curve's own reserves rather than out of the victim's trade.
    ///
    ///      Solvency is asserted rather than "profit <= victim shortfall": valuing the victim's
    ///      missing tokens through quoteSell() nets out the 1% exit fee and curve convexity, so
    ///      that comparison understates the loss by ~1.5% and would flag a phantom leak. The
    ///      books are the unambiguous test — if the platform still covers every claim against
    ///      it, nothing came out of the curve.
    function test_attack_sandwichTakesFromTheVictimNotTheCurve() public {
        address t = _launch(alice);

        uint256 victimClean = arcade.quoteBuy(t, 800e18); // what the victim gets untouched
        uint256 attackerBefore = bob.balance;

        vm.prank(bob);
        arcade.buy{value: 500e18}(t, 0); // front-run
        uint256 front = ANewOneToken(t).balanceOf(bob);

        vm.prank(alice);
        arcade.buy{value: 800e18}(t, 0); // victim in the middle
        uint256 victimSandwiched = ANewOneToken(t).balanceOf(alice);

        _sell(bob, t, front); // back-run

        assertLt(victimSandwiched, victimClean, "no sandwich occurred, this test proves nothing");
        _assertSolvent();

        // the victim is poorer, but still able to exit for whatever the curve owes them
        uint256 aliceBefore = alice.balance;
        _sell(alice, t, victimSandwiched);
        assertGt(alice.balance, aliceBefore, "victim could not exit after being sandwiched");
        _assertSolvent();

        emit log_named_decimal_uint("sandwich profit to attacker (USDC)", bob.balance - attackerBefore, 18);
        emit log_named_decimal_uint("victim token shortfall", victimClean - victimSandwiched, 18);
    }

    // ------------------------------------------------------------ cross-token isolation

    /// @dev Each curve's reserves belong to that curve. Draining one token by trading another
    ///      would be a total loss of user funds, so hammer the shared balance from both sides.
    function test_attack_sellCannotReachAnotherCurvesReserves() public {
        address a = _launch(alice);
        address b = _launch(bob);

        vm.prank(alice);
        arcade.buy{value: 3_000e18}(a, 0);
        vm.prank(bob);
        arcade.buy{value: 50e18}(b, 0);

        (,,,,, uint256 raisedBefore,) = arcade.info(b);

        // dump every unit of A back into its curve
        _sell(alice, a, ANewOneToken(a).balanceOf(alice));

        (,,,,, uint256 raisedAfter,) = arcade.info(b);
        assertEq(raisedAfter, raisedBefore, "token B reserves moved while trading token A");

        // and B's holder can still exit in full
        uint256 bobBefore = bob.balance;
        _sell(bob, b, ANewOneToken(b).balanceOf(bob));
        assertGt(bob.balance, bobBefore, "token B holder could not exit after A was drained");
    }

    /// @dev Donating tokens straight to the curve address must not shift the accounting the
    ///      contract keeps in its own tReserve bookkeeping.
    function test_attack_directTokenDonationDoesNotDistortCurve() public {
        address t = _launch(alice);
        vm.prank(bob);
        arcade.buy{value: 1_000e18}(t, 0);

        (,,, uint256 vBefore, uint256 rBefore,,) = arcade.info(t);
        uint256 priceBefore = arcade.priceWad(t);

        // NB: resolve the amount first — vm.prank only covers the very next call, and an
        // inline balanceOf() would consume it, leaving transfer() to run as the test contract.
        uint256 donation = ANewOneToken(t).balanceOf(bob) / 2;
        vm.prank(bob);
        ANewOneToken(t).transfer(address(arcade), donation);

        (,,, uint256 vAfter, uint256 rAfter,,) = arcade.info(t);
        assertEq(vAfter, vBefore, "donation moved the virtual reserve");
        assertEq(rAfter, rBefore, "donation moved the tracked token reserve");
        assertEq(arcade.priceWad(t), priceBefore, "donation moved the price");
    }

    // ------------------------------------------------------------ reentrancy

    function test_attack_reentrantSellIsBlocked() public {
        address t = _launch(alice);
        ReentrantTrader r = new ReentrantTrader(arcade);
        r.setToken(t);
        vm.deal(address(r), 10_000e18);

        r.buy(2_000e18);
        r.sellHalf(); // the payout lands in receive(), which tries to sell again

        assertTrue(r.attempted(), "the reentrant path never ran, this test proves nothing");
        assertFalse(r.reentrySucceeded(), "sell() was re-entered from inside its own payout");
    }

    // ------------------------------------------------------------ griefing / liveness

    /// @dev A creator that cannot receive native must not wedge the platform: their own claim
    ///      reverts, but trading and everyone else's money keep working.
    function test_attack_creatorRejectingEtherCannotWedgePlatform() public {
        RejectsEther r = new RejectsEther(arcade);
        address t = r.create();
        vm.roll(block.number + arcade.ANTI_SNIPE_BLOCKS() + 1);

        vm.prank(bob);
        arcade.buy{value: 1_000e18}(t, 0);
        assertGt(arcade.creatorFees(address(r)), 0, "creator earned nothing, this test proves nothing");

        vm.expectRevert(); // their own payout bounces
        r.claim();

        uint256 bobBefore = bob.balance;
        _sell(bob, t, ANewOneToken(t).balanceOf(bob));
        assertGt(bob.balance, bobBefore, "an unpayable creator blocked an unrelated seller");

        vm.prank(alice);
        arcade.buy{value: 10e18}(t, 0); // trading still works
    }

    /// @dev The 2% early cap must hold across a whole sequence of buys, not just one. Buys are
    ///      sized small on purpose: near the start of the curve a single 200 USDC order already
    ///      clears 4% of supply and is rejected outright, which would test nothing.
    function test_attack_antiSnipeCapHoldsAcrossManyBuys() public {
        vm.prank(alice);
        address t = arcade.createToken("T", "T", "", ""); // deliberately stay inside the window
        uint256 cap = arcade.ANTI_SNIPE_MAX();

        uint256 landed;
        for (uint256 i = 0; i < 30; i++) {
            vm.prank(bob);
            try arcade.buy{value: 20e18}(t, 0) {
                landed++;
            } catch {}
            assertLe(ANewOneToken(t).balanceOf(bob), cap, "one wallet exceeded the anti-snipe cap");
        }
        assertGt(landed, 0, "no buy landed, this test proves nothing");
        assertLt(landed, 30, "the cap never bound, this test proves nothing");
    }

    /// @dev Quantifies what the cap is actually worth. It bounds TOKENS (2% of supply), which
    ///      near the curve's start is only a small amount of USDC, and it is per-wallet, so the
    ///      real question is what it costs an attacker to buy the whole graduation target.
    function test_measure_antiSnipeBudgetPerWalletAndBypassCost() public {
        vm.prank(alice);
        address t = arcade.createToken("T", "T", "", "");

        uint256 spent;
        for (uint256 i = 0; i < 400; i++) {
            vm.prank(bob);
            try arcade.buy{value: 1e18}(t, 0) {
                spent += 1e18;
            } catch {
                break;
            }
        }
        emit log_named_decimal_uint("anti-snipe budget per wallet (USDC)", spent, 18);
        emit log_named_decimal_uint("graduation target (USDC)", GRAD, 18);
        emit log_named_uint("wallets needed to reach graduation", GRAD / spent + 1);

        assertLe(ANewOneToken(t).balanceOf(bob), arcade.ANTI_SNIPE_MAX(), "cap breached");
        assertLt(spent, GRAD, "one wallet could buy the whole graduation target in the window");
    }

    /// @dev Dust buys must never mint tokens worth more than they cost.
    function test_attack_dustBuysCannotMintFreeTokens() public {
        address t = _launch(alice);
        uint256 spent;
        for (uint256 i = 0; i < 50; i++) {
            vm.prank(bob);
            try arcade.buy{value: 1}(t, 0) {
                spent += 1;
            } catch {}
        }
        uint256 got = ANewOneToken(t).balanceOf(bob);
        if (got > 0) {
            assertLe(arcade.quoteSell(t, got), spent, "dust buys produced value out of nothing");
        }
    }
}
