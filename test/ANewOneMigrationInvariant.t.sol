// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ANewOne, ANewOneToken} from "../src/ANewOne.sol";
import {
    UniV3Fixture,
    IUniFactory,
    IUniPool,
    IUniNFPM,
    IUniRouter,
    IERC20Like,
    readPosition,
    ARC_USDC
} from "./utils/UniV3Fixture.sol";

string constant IMG = "data:image/png;base64,iVBORw0KGgo=";

/// @notice Random histories of every action, curve and pool alike: launches, buys and sells on
///         the curve, pools created early at random prices, migrations, trades on the pools,
///         fee sweeps, claims, withdrawals. Reverting actions are swallowed so the fuzzer keeps
///         exploring instead of dead-ending.
contract MigrationHandler is Test {
    uint160 internal constant MIN_SQRT = 4_295_128_739;
    uint160 internal constant MAX_SQRT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

    ANewOne public arcade;
    IUniFactory internal factory;
    IUniNFPM internal nfpm;
    IUniRouter internal router;
    address[] public actors;
    address[] public tokens;
    mapping(address => uint128) public liquidityAtMigration;
    uint256 public migrations;
    uint256 public poolTrades;

    constructor(ANewOne a, IUniFactory f, IUniNFPM n, IUniRouter r, address[] memory acts) {
        arcade = a;
        factory = f;
        nfpm = n;
        router = r;
        actors = acts;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function _token(uint256 s) internal view returns (address) {
        return tokens[s % tokens.length];
    }

    function createToken(uint256 a, uint256 v) public {
        address who = _actor(a);
        uint256 value = bound(v, 0, 200e18);
        vm.prank(who);
        try arcade.createToken{value: value}("T", "T", "", IMG) returns (address t) {
            tokens.push(t);
        } catch {}
    }

    function buy(uint256 a, uint256 t, uint256 v) public {
        if (tokens.length == 0) return;
        address who = _actor(a);
        uint256 value = bound(v, 1, 20_000e18);
        if (value > who.balance) return;
        vm.prank(who);
        try arcade.buy{value: value}(_token(t), 0) {} catch {}
    }

    function sell(uint256 a, uint256 t, uint256 amt) public {
        if (tokens.length == 0) return;
        address who = _actor(a);
        address token = _token(t);
        uint256 bal = ANewOneToken(token).balanceOf(who);
        if (bal == 0) return;
        uint256 amount = bound(amt, 1, bal);
        vm.startPrank(who);
        ANewOneToken(token).approve(address(arcade), amount);
        try arcade.sell(token, amount, 0) {} catch {}
        vm.stopPrank();
    }

    /// @dev Somebody creates the pool before the migration, at whatever price they like.
    function hostilePool(uint256 t, uint256 priceSeed) public {
        if (tokens.length == 0) return;
        address token = _token(t);
        if (arcade.migrated(token)) return;
        (address t0, address t1) = token < ARC_USDC ? (token, ARC_USDC) : (ARC_USDC, token);
        address pool = factory.getPool(t0, t1, 10_000);
        if (pool == address(0)) pool = factory.createPool(t0, t1, 10_000);
        (uint160 sp,,,,,,) = IUniPool(pool).slot0();
        if (sp == 0) IUniPool(pool).initialize(uint160(bound(priceSeed, MIN_SQRT + 1, MAX_SQRT - 1)));
    }

    function migrate(uint256 a, uint256 t) public {
        if (tokens.length == 0) return;
        address token = _token(t);
        vm.prank(_actor(a));
        try arcade.migrate(token) {
            liquidityAtMigration[token] = readPosition(address(nfpm), arcade.positionOf(token)).liquidity;
            migrations++;
        } catch {}
    }

    function poolBuy(uint256 a, uint256 t, uint256 u) public {
        if (tokens.length == 0) return;
        address token = _token(t);
        if (!arcade.migrated(token)) return;
        _poolSwap(_actor(a), ARC_USDC, token, bound(u, 1, 3_000e6));
    }

    function poolSell(uint256 a, uint256 t, uint256 amt) public {
        if (tokens.length == 0) return;
        address token = _token(t);
        if (!arcade.migrated(token)) return;
        address who = _actor(a);
        uint256 bal = ANewOneToken(token).balanceOf(who);
        if (bal == 0) return;
        _poolSwap(who, token, ARC_USDC, bound(amt, 1, bal));
    }

    function _poolSwap(address who, address tokenIn, address tokenOut, uint256 amountIn) internal {
        vm.startPrank(who);
        IERC20Like(tokenIn).approve(address(router), amountIn);
        try router.exactInputSingle(
            IUniRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: 10_000,
                recipient: who,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        ) {
            poolTrades++;
        } catch {}
        vm.stopPrank();
    }

    /// @dev Reopening is the admin's call, so the handler makes it as the admin, putting a
    ///      graduated coin back on its curve whenever that is allowed. Both arguments are
    ///      read before the prank so that the prank lands on reopenCurve itself.
    function reopen(uint256 t) public {
        if (tokens.length == 0) return;
        address token = _token(t);
        address adm = arcade.admin();
        vm.prank(adm);
        try arcade.reopenCurve(token) {} catch {}
    }

    function collect(uint256 a, uint256 t) public {
        if (tokens.length == 0) return;
        vm.prank(_actor(a));
        try arcade.collectPoolFees(_token(t)) {} catch {}
    }

    function claim(uint256 a) public {
        vm.prank(_actor(a));
        try arcade.claimCreatorFees() {} catch {}
    }

    function sweep(uint256 a, uint256 c) public {
        vm.prank(_actor(a));
        try arcade.sweepExpired(_actor(c)) {} catch {}
    }

    /// @dev this handler is made an owner in setUp
    function withdraw() public {
        try arcade.withdrawPlatformFees(address(uint160(0xFEE0))) {} catch {}
    }

    function advanceTime(uint256 dt) public {
        vm.warp(block.timestamp + bound(dt, 0, 10 days));
    }

    function advanceBlocks(uint256 db) public {
        vm.roll(block.number + bound(db, 0, 30));
    }
}

/// @notice What must hold after any such history.
contract ANewOneMigrationInvariant is UniV3Fixture {
    ANewOne internal arcade;
    MigrationHandler internal handler;
    address[] internal actors;

    uint256 internal constant V0 = 4_000e18;
    uint256 internal constant GRAD = 5_000e18;

    function setUp() public {
        _deployUniswap();
        arcade = new ANewOne(V0, GRAD, address(factory), address(nfpm), ARC_USDC);
        arcade.setMigrationsOpen(true);
        for (uint256 i = 0; i < 4; i++) {
            address a = address(uint160(0xACC0 + i)); // above precompiles, plain EOAs
            actors.push(a);
            vm.deal(a, 1_000_000e18);
        }
        handler = new MigrationHandler(arcade, factory, nfpm, router, actors);
        arcade.addOwner(address(handler));

        bytes4[] memory sel = new bytes4[](17);
        sel[0] = MigrationHandler.createToken.selector;
        sel[1] = MigrationHandler.buy.selector;
        sel[2] = MigrationHandler.buy.selector; // weight buying so curves actually graduate
        sel[3] = MigrationHandler.buy.selector;
        sel[4] = MigrationHandler.sell.selector;
        sel[5] = MigrationHandler.hostilePool.selector;
        sel[6] = MigrationHandler.migrate.selector;
        sel[7] = MigrationHandler.migrate.selector;
        sel[8] = MigrationHandler.poolBuy.selector;
        sel[9] = MigrationHandler.poolSell.selector;
        sel[10] = MigrationHandler.collect.selector;
        sel[11] = MigrationHandler.claim.selector;
        sel[12] = MigrationHandler.sweep.selector;
        sel[13] = MigrationHandler.withdraw.selector;
        sel[14] = MigrationHandler.advanceTime.selector;
        sel[15] = MigrationHandler.advanceBlocks.selector;
        sel[16] = MigrationHandler.reopen.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// @dev Exact, not at least: every wei the platform holds is a curve reserve, a creator pot
    ///      or the platform pot, however many curves have moved into pools and traded there.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_booksBalanceExactly() public view {
        uint256 liabilities = arcade.platformFees();
        uint256 n = arcade.tokensCount();
        for (uint256 i = 0; i < n; i++) {
            (,,,,, uint256 raised,) = arcade.info(arcade.allTokens(i));
            liabilities += raised;
        }
        for (uint256 i = 0; i < actors.length; i++) {
            liabilities += arcade.creatorFees(actors[i]);
        }
        assertEq(address(arcade).balance, liabilities);
    }

    /// @dev A curve that has not moved holds exactly its reserve. One that has moved holds no
    ///      tokens and no USDC, and its position is still the platform's, approved to nobody,
    ///      with every unit of liquidity it started with.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_curvesAndPositions() public view {
        uint256 n = arcade.tokensCount();
        for (uint256 i = 0; i < n; i++) {
            address t = arcade.allTokens(i);
            if (arcade.migrated(t)) _checkMigrated(t);
            else _checkCurve(t);
        }
    }

    function _checkMigrated(address t) internal view {
        (,, bool graduated,,, uint256 raised,) = arcade.info(t);
        assertTrue(graduated);
        assertEq(raised, 0);
        assertEq(ANewOneToken(t).balanceOf(address(arcade)), 0);
        uint256 id = arcade.positionOf(t);
        assertEq(nfpm.ownerOf(id), address(arcade));
        assertEq(nfpm.getApproved(id), address(0));
        assertEq(_position(id).liquidity, handler.liquidityAtMigration(t));
    }

    function _checkCurve(address t) internal view {
        (,,, uint256 vUsdc, uint256 tReserve, uint256 raised,) = arcade.info(t);
        assertEq(ANewOneToken(t).balanceOf(address(arcade)), tReserve);
        assertEq(vUsdc - V0, raised);
    }

    /// @dev Proof the campaign reached the interesting states at all.
    function afterInvariant() external {
        emit log_named_uint("migrations", handler.migrations());
        emit log_named_uint("pool trades", handler.poolTrades());
    }
}
