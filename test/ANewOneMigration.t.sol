// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ANewOne, ANewOneToken} from "../src/ANewOne.sol";
import {
    UniV3Fixture, IUniFactory, IUniPool, IUniNFPM, IERC20Like, Position, ARC_USDC
} from "./utils/UniV3Fixture.sol";

string constant IMG = "data:image/png;base64,iVBORw0KGgo=";

contract FactoryWithoutOnePercent {
    function feeAmountTickSpacing(uint24) external pure returns (int24) {
        return 0;
    }
}

contract EighteenDecimals {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// @notice Graduation into Uniswap v3, against Uniswap's published bytecode and a USDC that
///         behaves like Arc's: one balance, 18 decimals natively and 6 through the ERC-20.
contract ANewOneMigrationTest is UniV3Fixture {
    ANewOne internal arcade;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant V0 = 4_000e18;
    uint256 internal constant GRAD = 5_000e18;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @dev One token that sorts below USDC (token0 in its pool) and one above (token1), so
    ///      every path is exercised with the pair both ways round.
    address internal tLow;
    address internal tHigh;

    /// @dev The state a migration starts from.
    struct Snap {
        uint256 raised;
        uint256 tReserve;
        uint256 price;
        uint256 balance;
        uint256 fees;
    }

    struct FeeSnap {
        uint256 creator;
        uint256 platform;
        uint256 burned;
    }

    struct MigratedData {
        uint256 positionId;
        uint256 tokensToPool;
        uint256 usdcToPool;
        uint128 liquidity;
        uint256 tokensBurned;
    }

    function setUp() public {
        _deployUniswap();
        arcade = new ANewOne(V0, GRAD, address(factory), address(nfpm), ARC_USDC);
        vm.deal(creator, 1_000_000e18);
        vm.deal(alice, 1_000_000e18);
        vm.deal(bob, 1_000_000e18);
        vm.deal(mallory, 1_000_000e18);
        for (uint256 i; i < 64 && (tLow == address(0) || tHigh == address(0)); i++) {
            vm.prank(creator);
            address t = arcade.createToken("T", "T", "", IMG);
            if (t < ARC_USDC) {
                if (tLow == address(0)) tLow = t;
            } else if (tHigh == address(0)) {
                tHigh = t;
            }
        }
        require(tLow != address(0) && tHigh != address(0), "need a token on each side of USDC");
        vm.roll(block.number + arcade.ANTI_SNIPE_BLOCKS() + 1);
    }

    // ------------------------------------------------------------ helpers

    function _graduate(address token) internal {
        _graduateOn(arcade, token);
    }

    function _graduateOn(ANewOne a, address token) internal {
        vm.prank(alice);
        a.buy{value: 6_000e18}(token, 0);
        (,, bool graduated,,,,) = a.info(token);
        assertTrue(graduated, "graduated");
    }

    function _open() internal {
        if (!arcade.migrationsOpen()) arcade.setMigrationsOpen(true);
    }

    function _migrate(address token) internal {
        _open();
        vm.prank(bob);
        arcade.migrate(token);
    }

    function _raised(address token) internal view returns (uint256) {
        return _raisedOn(arcade, token);
    }

    function _raisedOn(ANewOne a, address token) internal view returns (uint256 r) {
        (,,,,, r,) = a.info(token);
    }

    function _tReserve(address token) internal view returns (uint256 r) {
        (,,,, r,,) = arcade.info(token);
    }

    function _pool(address token) internal view returns (address) {
        return factory.getPool(token, ARC_USDC, FEE);
    }

    function _snap(address token) internal view returns (Snap memory s) {
        s.raised = _raised(token);
        s.tReserve = _tReserve(token);
        s.price = arcade.priceWad(token);
        s.balance = address(arcade).balance;
        s.fees = arcade.platformFees();
    }

    /// @dev What the platform owes: every curve's reserve, every creator pot, the platform pot.
    function _liabilities() internal view returns (uint256 sum) {
        sum = arcade.platformFees();
        uint256 n = arcade.tokensCount();
        for (uint256 i; i < n; i++) {
            sum += _raised(arcade.allTokens(i));
        }
        sum += arcade.creatorFees(creator) + arcade.creatorFees(alice) + arcade.creatorFees(bob)
            + arcade.creatorFees(mallory);
    }

    /// @dev Exact, not at least: a migration that lost or conjured a single wei would show here.
    function _assertBooks() internal view {
        assertEq(address(arcade).balance, _liabilities(), "native balance == reserves + fee pots");
    }

    /// @dev A pool somebody else created and initialised before the migration could.
    function _hostilePool(address token, uint256 priceWad) internal returns (address pool) {
        (address t0, address t1) = _sorted(token);
        vm.startPrank(mallory);
        pool = factory.createPool(t0, t1, FEE);
        IUniPool(pool).initialize(_sqrtAt(token, priceWad));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ deployment

    function test_constructor_withoutDexNeverMigrates() public {
        ANewOne plain = new ANewOne(V0, GRAD, address(0), address(0), address(0));
        vm.expectRevert("no dex");
        plain.setMigrationsOpen(true);

        vm.prank(creator);
        address t = plain.createToken("T", "T", "", IMG);
        vm.roll(block.number + 21);
        _graduateOn(plain, t);
        vm.expectRevert("migration off");
        plain.migrate(t);
    }

    function test_constructor_allOrNone() public {
        vm.expectRevert("dex: all or none");
        new ANewOne(V0, GRAD, address(factory), address(0), ARC_USDC);
        vm.expectRevert("dex: all or none");
        new ANewOne(V0, GRAD, address(factory), address(nfpm), address(0));
        vm.expectRevert("dex: all or none");
        new ANewOne(V0, GRAD, address(0), address(nfpm), ARC_USDC);
    }

    /// @dev USDC is an Arc predeploy, so it is checked at deploy.
    function test_constructor_checksUsdc() public {
        address dec18 = address(new EighteenDecimals());
        vm.expectRevert("dex: usdc");
        new ANewOne(V0, GRAD, address(factory), address(nfpm), dec18);
        vm.expectRevert("dex: usdc");
        new ANewOne(V0, GRAD, address(factory), address(nfpm), makeAddr("no code"));
    }

    /// @dev Uniswap is checked when migrations open, and a wrong Uniswap cannot be opened.
    function test_openingChecksUniswap() public {
        ANewOne a = new ANewOne(V0, GRAD, _deployArtifact("UniswapV3Factory.json", ""), address(nfpm), ARC_USDC);
        vm.expectRevert("dex: pm factory");
        a.setMigrationsOpen(true);

        address noTier = address(new FactoryWithoutOnePercent());
        address pm = _deployArtifact("NonfungiblePositionManager.json", abi.encode(noTier, NO_WETH, address(0)));
        ANewOne b = new ANewOne(V0, GRAD, noTier, pm, ARC_USDC);
        vm.expectRevert("dex: 1% tier");
        b.setMigrationsOpen(true);

        ANewOne c = new ANewOne(V0, GRAD, makeAddr("factory later"), makeAddr("pm later"), ARC_USDC);
        vm.expectRevert("dex: not live");
        c.setMigrationsOpen(true);
        c.setMigrationsOpen(false); // closing never needs Uniswap
        assertFalse(c.migrationsOpen());
    }

    /// @dev $NOAH launches with the chain, and Uniswap may reach Arc after it. The platform deploys
    ///      anyway, pointed at where Uniswap will be; its curves trade and graduate as usual,
    ///      opening waits for the code to arrive, and from then on it migrates as if Uniswap had
    ///      always been there.
    function test_launchesBeforeUniswap_migratesOnceItArrives() public {
        uint256 n = vm.getNonce(address(this));
        address futureFactory = computeCreateAddress(address(this), n + 1);
        address futureNfpm = computeCreateAddress(address(this), n + 2);
        ANewOne early = new ANewOne(V0, GRAD, futureFactory, futureNfpm, ARC_USDC); // nonce n

        vm.prank(creator);
        address t = early.createToken("T", "T", "", IMG);
        vm.roll(block.number + 21);
        _graduateOn(early, t);
        vm.expectRevert("dex: not live");
        early.setMigrationsOpen(true);
        vm.expectRevert("migration off");
        early.migrate(t);

        // Uniswap arrives, at the addresses the platform was deployed with
        address f = _deployArtifact("UniswapV3Factory.json", ""); // nonce n + 1
        address pm = _deployArtifact("NonfungiblePositionManager.json", abi.encode(f, NO_WETH, address(0))); // n + 2
        assertEq(f, futureFactory);
        assertEq(pm, futureNfpm);

        early.setMigrationsOpen(true);
        uint256 price = early.priceWad(t);
        early.migrate(t);
        assertTrue(early.migrated(t));
        address pool = IUniFactory(f).getPool(t, ARC_USDC, FEE);
        assertApproxEqRel(_poolPriceWad(pool, t), price, 1e8);
        assertEq(IUniNFPM(pm).ownerOf(early.positionOf(t)), address(early));
    }

    // ------------------------------------------------------------ the switch

    function test_migrationShipsClosed() public {
        assertFalse(arcade.migrationsOpen());
        _graduate(tLow);
        vm.expectRevert("migration off");
        arcade.migrate(tLow);
    }

    function test_onlyOwnerCanOpen() public {
        vm.prank(mallory);
        vm.expectRevert("owner");
        arcade.setMigrationsOpen(true);
    }

    function test_closingAgainStopsMigrations() public {
        _graduate(tLow);
        arcade.setMigrationsOpen(true);
        arcade.setMigrationsOpen(false);
        vm.expectRevert("migration off");
        arcade.migrate(tLow);
    }

    function test_migrate_requirements() public {
        _open();
        vm.expectRevert("unknown token");
        arcade.migrate(makeAddr("nope"));
        vm.expectRevert("not graduated");
        arcade.migrate(tLow);

        _graduate(tLow);
        // sells take the curve back under the target: graduated for good, not deep enough yet
        uint256 half = ANewOneToken(tLow).balanceOf(alice) / 2;
        vm.startPrank(alice);
        ANewOneToken(tLow).approve(address(arcade), half);
        arcade.sell(tLow, half, 0);
        vm.stopPrank();
        assertLt(_raised(tLow), GRAD);
        vm.expectRevert("below target");
        arcade.migrate(tLow);

        // buys lift it again
        vm.prank(bob);
        arcade.buy{value: 10_000e18}(tLow, 0);
        arcade.migrate(tLow);
        vm.expectRevert("already migrated");
        arcade.migrate(tLow);
    }

    // ------------------------------------------------------------ the move itself

    function test_migrate_opensPoolAtCurvePrice_token0() public {
        _happyPath(tLow);
    }

    function test_migrate_opensPoolAtCurvePrice_token1() public {
        _happyPath(tHigh);
    }

    function _happyPath(address token) internal {
        _graduate(token);
        Snap memory s = _snap(token);

        _migrate(token);

        address pool = _pool(token);
        assertTrue(pool != address(0), "pool exists");
        assertTrue(arcade.migrated(token));
        // the pool opens exactly where the curve stopped
        assertApproxEqRel(_poolPriceWad(pool, token), s.price, 1e8, "pool price == last curve price");
        _assertPosition(token, pool);
        _assertMoved(token, pool, s);
        _assertCurveClosed(token, s);
        _assertBooks();
    }

    /// @dev A full range position in the 1% tier, held by the platform and approved to nobody.
    function _assertPosition(address token, address pool) internal view {
        uint256 id = arcade.positionOf(token);
        assertEq(nfpm.ownerOf(id), address(arcade));
        assertEq(nfpm.getApproved(id), address(0));
        Position memory p = _position(id);
        (address t0, address t1) = _sorted(token);
        assertEq(p.token0, t0);
        assertEq(p.token1, t1);
        assertEq(p.fee, FEE);
        assertEq(p.tickLower, FULL_LOWER);
        assertEq(p.tickUpper, FULL_UPPER);
        assertGt(p.liquidity, 0);
        assertEq(IUniPool(pool).liquidity(), p.liquidity, "the only liquidity is ours");
    }

    /// @dev Every wei and every token of the curve is accounted for.
    function _assertMoved(address token, address pool, Snap memory s) internal view {
        uint256 poolUsdc = _usdc(pool);
        uint256 dust = arcade.platformFees() - s.fees;
        assertEq(poolUsdc * 1e12 + dust, s.raised, "raised == pool + dust");
        assertLt(dust, 2e12, "dust stays dust");
        assertEq(s.balance - address(arcade).balance, poolUsdc * 1e12, "only the pool's USDC left");

        assertEq(ANewOneToken(token).balanceOf(address(arcade)), 0);
        assertEq(ANewOneToken(token).balanceOf(pool) + ANewOneToken(token).balanceOf(BURN), s.tReserve);
        // the pool got the tokens `raised` buys at the curve's price, not the whole reserve
        assertApproxEqRel(
            ANewOneToken(token).balanceOf(pool), Math.mulDiv(s.tReserve, s.raised, s.raised + V0), 1e8
        );
    }

    /// @dev The curve is closed, and says so rather than quoting prices nobody can get.
    function _assertCurveClosed(address token, Snap memory s) internal {
        assertEq(_raised(token), 0);
        assertEq(_tReserve(token), s.tReserve, "reserves frozen, not zeroed");
        assertEq(arcade.priceWad(token), s.price);

        vm.prank(alice);
        vm.expectRevert("migrated");
        arcade.buy{value: 1e18}(token, 0);

        vm.startPrank(alice);
        ANewOneToken(token).approve(address(arcade), 1e18);
        vm.expectRevert("migrated");
        arcade.sell(token, 1e18, 0);
        vm.stopPrank();

        vm.expectRevert("migrated");
        arcade.quoteBuy(token, 1e18);
        vm.expectRevert("migrated");
        arcade.quoteSell(token, 1e18);
    }

    function test_migrate_eventMatchesState() public {
        _graduate(tHigh);
        _open();
        vm.recordLogs();
        vm.prank(bob);
        arcade.migrate(tHigh);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Migrated(address,address,uint256,uint256,uint256,uint128,uint256)");
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(arcade) || logs[i].topics[0] != sig) continue;
            seen = true;
            _checkMigratedLog(logs[i], tHigh);
        }
        assertTrue(seen, "Migrated emitted");
    }

    function _checkMigratedLog(Vm.Log memory log, address token) internal view {
        assertEq(address(uint160(uint256(log.topics[1]))), token);
        address pool = address(uint160(uint256(log.topics[2])));
        assertEq(pool, _pool(token));
        MigratedData memory d = abi.decode(log.data, (MigratedData));
        assertEq(d.positionId, arcade.positionOf(token));
        assertEq(d.tokensToPool, ANewOneToken(token).balanceOf(pool));
        assertEq(d.usdcToPool, _usdc(pool) * 1e12, "native units, like every other event here");
        assertEq(d.tokensBurned, ANewOneToken(token).balanceOf(BURN));
        assertEq(d.liquidity, _position(d.positionId).liquidity);
    }

    function testFuzz_migrate_anyRaise(bool low, uint256 buyValue) public {
        address token = low ? tLow : tHigh;
        buyValue = bound(buyValue, 5_051e18, 300_000e18);
        vm.prank(alice);
        arcade.buy{value: buyValue}(token, 0);
        Snap memory s = _snap(token);

        _migrate(token);

        address pool = _pool(token);
        assertApproxEqRel(_poolPriceWad(pool, token), s.price, 1e8);
        assertEq(_usdc(pool) * 1e12 + (arcade.platformFees() - s.fees), s.raised);
        _assertBooks();
    }

    /// @dev The Arc testnet rehearsal runs with a graduation target a thousand times smaller,
    ///      which prices a token1 at more units per USDC than 2^64. Both orderings must still
    ///      open at the curve's price.
    function test_smallTargetPlatform_migratesBothWays() public {
        ANewOne small = new ANewOne(4e18, 5e18, address(factory), address(nfpm), ARC_USDC);
        small.setMigrationsOpen(true);
        address lo;
        address hi;
        for (uint256 i; i < 64 && (lo == address(0) || hi == address(0)); i++) {
            vm.prank(creator);
            address t = small.createToken("T", "T", "", IMG);
            if (t < ARC_USDC) {
                if (lo == address(0)) lo = t;
            } else if (hi == address(0)) {
                hi = t;
            }
        }
        vm.roll(block.number + 21);
        for (uint256 k; k < 2; k++) {
            address t = k == 0 ? lo : hi;
            vm.prank(alice);
            small.buy{value: 6e18}(t, 0);
            uint256 price = small.priceWad(t);
            small.migrate(t);
            assertApproxEqRel(_poolPriceWad(_pool(t), t), price, 1e8);
        }
    }

    function test_oneMigrationLeavesOtherCurvesWhole() public {
        _graduate(tLow);
        vm.prank(bob);
        arcade.buy{value: 2_000e18}(tHigh, 0);
        uint256 highRaised = _raised(tHigh);

        _migrate(tLow);
        assertEq(_raised(tHigh), highRaised);
        _assertBooks();

        // tHigh's holders can still sell every token back to its curve
        uint256 bal = ANewOneToken(tHigh).balanceOf(bob);
        vm.startPrank(bob);
        ANewOneToken(tHigh).approve(address(arcade), bal);
        arcade.sell(tHigh, bal, 0);
        vm.stopPrank();
        _assertBooks();
    }

    // ------------------------------------------------------------ after the move

    function test_poolFees_splitLikeCurveFees_token0() public {
        _feesPath(tLow);
    }

    function test_poolFees_splitLikeCurveFees_token1() public {
        _feesPath(tHigh);
    }

    function _feesPath(address token) internal {
        vm.prank(bob);
        arcade.buy{value: 1_000e18}(token, 0); // bob holds some to sell on the pool later
        _graduate(token);
        _migrate(token);
        uint256 id = arcade.positionOf(token);
        uint128 liqBefore = _position(id).liquidity;
        FeeSnap memory f = FeeSnap(arcade.creatorFees(creator), arcade.platformFees(), ANewOneToken(token).balanceOf(BURN));

        uint256 buyUnits = 1_000e6;
        assertGt(_buyOnPool(alice, token, buyUnits), 0);
        uint256 sellAmount = ANewOneToken(token).balanceOf(bob) / 4;
        assertGt(_sellOnPool(bob, token, sellAmount), 0);

        // anybody may sweep the fees, and nothing reaches whoever does
        uint256 malloryBefore = mallory.balance;
        vm.prank(mallory);
        arcade.collectPoolFees(token);
        assertEq(mallory.balance, malloryBefore);

        _assertFeeSplit(token, f, buyUnits, sellAmount);
        // and the liquidity itself never moved
        assertEq(_position(id).liquidity, liqBefore);
        assertEq(ANewOneToken(token).balanceOf(address(arcade)), 0);
        _assertBooks();

        // the creator's half is claimed the usual way
        uint256 cBal = creator.balance;
        vm.prank(creator);
        arcade.claimCreatorFees();
        assertGt(creator.balance, cBal);
        _assertBooks();
    }

    function _assertFeeSplit(address token, FeeSnap memory f, uint256 buyUnits, uint256 sellAmount)
        internal
        view
    {
        uint256 toCreator = arcade.creatorFees(creator) - f.creator;
        uint256 toPlatform = arcade.platformFees() - f.platform;
        // 1% of the buy, give or take the pool's rounding
        assertApproxEqAbs(toCreator + toPlatform, (buyUnits * 1e12) / 100, 2e12);
        // split down the middle, as a curve fee is
        assertApproxEqAbs(toCreator, toPlatform, 1);
        // the token side, 1% of bob's sell, is burned
        assertApproxEqAbs(ANewOneToken(token).balanceOf(BURN) - f.burned, sellAmount / 100, sellAmount / 1e9);
    }

    function test_collectPoolFees_needsAMigration() public {
        vm.expectRevert("not migrated");
        arcade.collectPoolFees(tLow);
    }

    function test_ownerWithdrawTakesFeesOnly() public {
        vm.prank(bob);
        arcade.buy{value: 2_000e18}(tHigh, 0); // a curve that stays a curve
        _graduate(tLow);
        _migrate(tLow);
        _buyOnPool(alice, tLow, 500e6);
        arcade.collectPoolFees(tLow);
        uint256 id = arcade.positionOf(tLow);
        uint128 liq = _position(id).liquidity;

        uint256 fees = arcade.platformFees();
        arcade.withdrawPlatformFees(treasury);
        assertEq(treasury.balance, fees);
        _assertBooks(); // tHigh's reserve and every creator pot are untouched
        assertEq(_position(id).liquidity, liq);
        assertEq(nfpm.ownerOf(id), address(arcade));
    }

    // ------------------------------------------------------------ somebody got there first

    function test_bareCreatedPool_isInitialisedAtCurvePrice() public {
        for (uint256 k; k < 2; k++) {
            address token = k == 0 ? tLow : tHigh;
            (address t0, address t1) = _sorted(token);
            vm.prank(mallory);
            factory.createPool(t0, t1, FEE); // created, never initialised
            _graduate(token);
            uint256 price = arcade.priceWad(token);
            _migrate(token);
            assertApproxEqRel(_poolPriceWad(_pool(token), token), price, 1e8);
        }
        _assertBooks();
    }

    function testFuzz_emptyPoolAtHostilePrice_isMovedForNothing(bool low, uint256 seed) public {
        address token = low ? tLow : tHigh;
        _graduate(token);
        Snap memory s = _snap(token);
        // anywhere from a millionth of the price to a million times it
        uint256 f = bound(seed, 1, 1e6);
        address pool = _hostilePool(token, seed % 2 == 0 ? s.price * f : s.price / f);

        _migrate(token);

        assertApproxEqRel(_poolPriceWad(pool, token), s.price, 1e8);
        assertEq(_usdc(pool) * 1e12 + (arcade.platformFees() - s.fees), s.raised, "empty pools move for free");
        _assertBooks();
    }

    function test_foreignLiquidityOffPrice_isTradedBack_token0() public {
        _smallForeign(tLow);
    }

    function test_foreignLiquidityOffPrice_isTradedBack_token1() public {
        _smallForeign(tHigh);
    }

    function _smallForeign(address token) internal {
        vm.prank(mallory);
        arcade.buy{value: 50e18}(token, 0);
        _graduate(token);
        uint256 price = arcade.priceWad(token);
        // 3% under the curve: outside tolerance, so it has to be traded back
        address pool = _hostilePool(token, (price * 97) / 100);
        uint128 theirs = _addLiquidity(mallory, token, ANewOneToken(token).balanceOf(mallory), 1_000e6);
        assertGt(theirs, 0);

        _migrate(token);

        assertApproxEqRel(_poolPriceWad(pool, token), price, 0.011e18, "back within tolerance");
        assertGt(IUniPool(pool).liquidity(), theirs, "ours joined theirs");
        _assertBooks();
    }

    function test_foreignLiquidityAbovePrice_leftoverUsdcIsBoughtBackNotKept() public {
        address token = tLow;
        vm.prank(mallory);
        arcade.buy{value: 50e18}(token, 0);
        _graduate(token);
        uint256 price = arcade.priceWad(token);
        // 50% over: the migration sells into it and comes out holding more USDC than it can pair
        address pool = _hostilePool(token, (price * 150) / 100);
        _addLiquidity(mallory, token, ANewOneToken(token).balanceOf(mallory), 1_000_000e6);
        uint256 feesBefore = arcade.platformFees();

        _migrate(token);

        assertLt(arcade.platformFees() - feesBefore, 1e16 + 1e12, "leftover USDC went into the pool, not to fees");
        assertGe(_poolPriceWad(pool, token), (price * 99) / 100, "nobody who bought on the curve is marked down");
        _assertBooks();
    }

    function _deepForeign(address token) internal returns (address pool, uint256 price) {
        vm.prank(mallory);
        arcade.buy{value: 3_000e18}(token, 0);
        _graduate(token);
        price = arcade.priceWad(token);
        // half the curve's price, backed by everything mallory bought and USDC to match
        pool = _hostilePool(token, price / 2);
        _addLiquidity(mallory, token, ANewOneToken(token).balanceOf(mallory), 1_000_000e6);
    }

    /// @dev A migration that reverts partway. On Arc the revert undoes the USDC it moved, like any
    ///      other state. The test double moves USDC with vm.deal, which a revert does not undo, so
    ///      the state from before the call is put back by hand to keep modelling the chain.
    function _expectMigrationRefused(address token, bytes memory reason) internal {
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        vm.expectRevert(reason);
        arcade.migrate(token);
        vm.revertToState(snap);
    }

    function test_foreignLiquidityTooDeep_isRefused_curveStaysOpen() public {
        (, uint256 price) = _deepForeign(tHigh);
        uint256 raised = _raised(tHigh);
        _open();
        _expectMigrationRefused(tHigh, "pool price out of reach");

        // the curve still trades and still holds every wei
        assertFalse(arcade.migrated(tHigh));
        assertEq(_raised(tHigh), raised);
        assertEq(arcade.priceWad(tHigh), price);
        vm.prank(alice);
        arcade.buy{value: 10e18}(tHigh, 0);
        _assertBooks();
    }

    function test_foreignLiquidityTooDeep_migratesOnceArbitraged() public {
        (address pool, uint256 price) = _deepForeign(tLow);
        _open();
        _expectMigrationRefused(tLow, "pool price out of reach");

        // anybody can buy mallory's cheap tokens up to the curve's price, and then it goes
        _swapOnPool(bob, ARC_USDC, tLow, 100_000e6, _sqrtAt(tLow, price));
        vm.prank(bob);
        arcade.migrate(tLow);
        assertTrue(arcade.migrated(tLow));
        assertApproxEqRel(_poolPriceWad(pool, tLow), price, 0.011e18);
        _assertBooks();
    }

    // ------------------------------------------------------------ nobody else gets paid

    function test_swapCallback_paysNobodyOutsideAMigration() public {
        vm.prank(mallory);
        vm.expectRevert("not our swap");
        arcade.uniswapV3SwapCallback(1, 1, "");

        _graduate(tLow);
        _migrate(tLow);
        // even the real pool cannot make the platform pay once its migration is over
        vm.prank(_pool(tLow));
        vm.expectRevert("not our swap");
        arcade.uniswapV3SwapCallback(1e6, 1e18, "");
    }

    /// @dev The position manager also approves by signature (ERC721Permit). For an owner that is a
    ///      contract it asks isValidSignature, which the platform does not implement, so no
    ///      signature can ever approve anybody for a migrated position.
    function test_positionCannotBeApprovedByPermit() public {
        _graduate(tLow);
        _migrate(tLow);
        uint256 id = arcade.positionOf(tLow);
        vm.expectRevert();
        nfpm.permit(mallory, id, block.timestamp + 1, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(nfpm.getApproved(id), address(0));
        assertEq(nfpm.ownerOf(id), address(arcade));
    }

    function test_nativeTransfersBounce() public {
        vm.prank(alice);
        (bool ok,) = address(arcade).call{value: 1e18}("");
        assertFalse(ok);
    }

    /// @dev Arc has no WETH, so what the official periphery was given as WETH9 is unknown until
    ///      its mainnet RPC is public. If it were the USDC face itself, a speck of USDC sent to
    ///      the position manager would push its payment code into WETH9.deposit. This pins down
    ///      that the migration then fails whole, loses nothing, and goes through once anybody
    ///      clears the speck with refundETH().
    function test_positionManagerWithUsdcAsWeth_failsSafe() public {
        address pm2 =
            _deployArtifact("NonfungiblePositionManager.json", abi.encode(address(factory), ARC_USDC, address(0)));
        ANewOne a2 = new ANewOne(V0, GRAD, address(factory), pm2, ARC_USDC);
        vm.prank(creator);
        address t = a2.createToken("T", "T", "", IMG);
        vm.roll(block.number + 21);
        _graduateOn(a2, t);
        a2.setMigrationsOpen(true);
        uint256 raised = _raisedOn(a2, t);

        vm.prank(mallory);
        IERC20Like(ARC_USDC).transfer(pm2, 1);
        vm.expectRevert();
        a2.migrate(t);
        assertFalse(a2.migrated(t));
        assertEq(_raisedOn(a2, t), raised);

        vm.prank(bob);
        IUniNFPM(pm2).refundETH();
        a2.migrate(t);
        assertTrue(a2.migrated(t));
    }
}
