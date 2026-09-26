// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ANewOne, ANewOneToken} from "../src/ANewOne.sol";
import {ArcUSDC} from "./utils/ArcUSDC.sol";
import {UniV3Fixture, IUniFactory, IUniPool, IUniNFPM, IERC20Like, Position, ARC_USDC} from "./utils/UniV3Fixture.sol";

/// @dev The pool's swap face, which the fixture's IUniPool leaves to the router.
interface IPoolSwap {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @notice The migration rehearsed against Arc mainnet itself: the platform that is live, the
///         $NOAH that is live, and Uniswap's own v3 deployment, on a fork of the chain as it
///         stands. Nothing here is deployed by the test; it only buys, migrates, trades and
///         collects, and checks every wei and every token along the way.
///
///         Runs only on a fork of Arc mainnet and skips itself anywhere else:
///
///           forge test --match-contract MainnetFork --fork-url https://rpc.blockdaemon.mainnet.arc.io -vv
///
///         Inherits the fixture for its helpers only; _deployUniswap() is never called, the
///         addresses are the ones the platform was deployed with.
///
///         One piece of the chain a fork cannot carry: USDC's ERC-20 face at 0x3600...0000
///         moves native balances through an Arc precompile, and in forge's EVM its transfer()
///         and transferFrom() simply fail (probed 26 Sep 2026: balanceOf reads fine, every
///         transfer returns false). The test double from the unit tests is etched over it, the
///         same one-balance model, so the fork rehearses the real platform, the real $NOAH and
///         Uniswap's real Arc deployment; the precompile itself was rehearsed live on Arc
///         testnet on 10 Sep 2026 (MIGRATION.md).
contract ANewOneMainnetForkTest is UniV3Fixture {
    uint256 internal constant ARC_MAINNET = 5042;
    ANewOne internal constant PLATFORM = ANewOne(payable(0x3DDA5AD5E74c658aff3d082AFe404a71615B1bc5));
    address internal constant NOAH = 0x26Cc2b608Df6be8fF63C64C9464b2756cC5dc128;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    address internal buyer = makeAddr("forkBuyer");
    address internal anyone = makeAddr("forkAnyone");

    /// @dev The pool a swap in this test is paying, for the callback. Same pattern the platform uses.
    address internal swapPool;

    function setUp() public {
        vm.skip(block.chainid != ARC_MAINNET);
        vm.etch(ARC_USDC, address(new ArcUSDC()).code);
        // the double moves native balances through vm.deal; on a fork an etched address is
        // not granted cheatcodes by itself, unlike in the unit tests
        vm.allowCheatcodes(ARC_USDC);
        factory = IUniFactory(address(PLATFORM.v3Factory()));
        nfpm = IUniNFPM(address(PLATFORM.positionManager()));
        vm.deal(buyer, 100_000e18);
        vm.deal(address(this), 100_000e18);
    }

    // ------------------------------------------------------------ the chain as it stands

    function test_fork_platformPointsAtUniswapsOwnDeployment() public view {
        assertEq(address(factory), 0xf0db7b58379503491d857dB50AC9ece64c653918, "factory");
        assertEq(address(nfpm), 0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377, "position manager");
        assertEq(address(PLATFORM.usdc()), ARC_USDC, "usdc");
        assertGt(address(factory).code.length, 0, "factory is live");
        assertGt(address(nfpm).code.length, 0, "position manager is live");
        assertEq(factory.feeAmountTickSpacing(FEE), 200, "1% tier");
        assertTrue(PLATFORM.migrationsOpen(), "migrations are open on mainnet");
    }

    /// @dev Arc's native USDC and its ERC-20 face are one balance, which the whole migration
    ///      leans on: the platform's live balance must show through the face, unscaled by
    ///      anything but the decimals, or the etched double would be modelling the wrong thing.
    function test_fork_usdcFaceMirrorsNativeBalance() public view {
        assertEq(_usdc(address(PLATFORM)), address(PLATFORM).balance / 1e12, "face == native / 1e12");
        assertEq(_usdc(buyer), buyer.balance / 1e12, "dealt native shows through the face");
    }

    // ------------------------------------------------------------ the move

    /// @dev The state a migration starts from.
    struct Snap {
        uint256 price;
        uint256 raised;
        uint256 tReserve;
        uint256 balance;
        uint256 fees;
        uint256 creatorPot;
    }

    function _snap() internal view returns (Snap memory s) {
        s.price = PLATFORM.priceWad(NOAH);
        s.raised = _raised(NOAH);
        s.tReserve = _tReserve(NOAH);
        s.balance = address(PLATFORM).balance;
        s.fees = PLATFORM.platformFees();
        s.creatorPot = PLATFORM.creatorFees(_creator(NOAH));
    }

    function test_fork_noahGraduatesAndMigratesAtItsCurvePrice() public {
        _graduateNoah();
        Snap memory s = _snap();

        vm.prank(anyone);
        PLATFORM.migrate(NOAH);

        address pool = factory.getPool(NOAH, ARC_USDC, FEE);
        assertTrue(pool != address(0), "pool exists");
        assertTrue(PLATFORM.migrated(NOAH));
        assertApproxEqRel(_poolPriceWad(pool, NOAH), s.price, 1e8, "pool opens at the curve's last price");
        _assertPosition(pool);
        _assertMoved(pool, s);
        _assertCurveClosed(s);
    }

    /// @dev Full range, 1% tier, held by the platform, approved to nobody.
    function _assertPosition(address pool) internal view {
        uint256 id = PLATFORM.positionOf(NOAH);
        assertEq(nfpm.ownerOf(id), address(PLATFORM));
        assertEq(nfpm.getApproved(id), address(0));
        Position memory p = _position(id);
        (address t0, address t1) = _sorted(NOAH);
        assertEq(p.token0, t0);
        assertEq(p.token1, t1);
        assertEq(p.fee, FEE);
        assertEq(p.tickLower, FULL_LOWER);
        assertEq(p.tickUpper, FULL_UPPER);
        assertGt(p.liquidity, 0);
        assertEq(IUniPool(pool).liquidity(), p.liquidity, "the only liquidity is ours");
    }

    /// @dev Every wei and every token of the curve is accounted for.
    function _assertMoved(address pool, Snap memory s) internal view {
        uint256 poolUsdc = _usdc(pool);
        uint256 dust = PLATFORM.platformFees() - s.fees;
        assertEq(poolUsdc * 1e12 + dust, s.raised, "raised == pool + dust");
        assertLt(dust, 2e12, "dust stays dust");
        assertEq(s.balance - address(PLATFORM).balance, poolUsdc * 1e12, "only the pool's USDC left the platform");
        assertEq(PLATFORM.creatorFees(_creator(NOAH)), s.creatorPot, "the creator's pot is untouched");

        assertEq(ANewOneToken(NOAH).balanceOf(address(PLATFORM)), 0);
        assertEq(ANewOneToken(NOAH).balanceOf(pool) + ANewOneToken(NOAH).balanceOf(BURN), s.tReserve);
        // the pool got the tokens `raised` buys at the curve's price, the rest was burned
        assertApproxEqRel(
            ANewOneToken(NOAH).balanceOf(pool),
            Math.mulDiv(s.tReserve, s.raised, s.raised + PLATFORM.virtualUsdc0()),
            1e8,
            "pool tokens == what raised buys at the curve price"
        );
    }

    function _assertCurveClosed(Snap memory s) internal {
        assertEq(_raised(NOAH), 0);
        assertEq(_tReserve(NOAH), s.tReserve, "reserves frozen, not zeroed");
        vm.prank(buyer);
        vm.expectRevert("graduated");
        PLATFORM.buy{value: 1e18}(NOAH, 0);
        vm.expectRevert("already migrated");
        PLATFORM.migrate(NOAH);
    }

    // ------------------------------------------------------------ trading in the pool afterwards

    function test_fork_poolFeesSplitLikeCurveFees() public {
        _graduateNoah();
        vm.prank(anyone);
        PLATFORM.migrate(NOAH);
        address pool = factory.getPool(NOAH, ARC_USDC, FEE);
        uint256 id = PLATFORM.positionOf(NOAH);
        uint128 liqBefore = _position(id).liquidity;

        address creator = _creator(NOAH);
        uint256 creatorBefore = PLATFORM.creatorFees(creator);
        uint256 platformBefore = PLATFORM.platformFees();
        uint256 burnedBefore = ANewOneToken(NOAH).balanceOf(BURN);

        // buy 1,000 USDC of $NOAH in the pool, then sell a quarter of what the buyer holds
        uint256 buyUnits = 1_000e6;
        _swap(pool, ARC_USDC, buyUnits);
        uint256 held = ANewOneToken(NOAH).balanceOf(address(this));
        assertGt(held, 0, "the pool paid out tokens");
        uint256 sellAmount = held / 4;
        _swap(pool, NOAH, sellAmount);

        // anyone may sweep; nothing reaches whoever does
        uint256 anyoneBefore = anyone.balance;
        vm.prank(anyone);
        PLATFORM.collectPoolFees(NOAH);
        assertEq(anyone.balance, anyoneBefore);

        uint256 toCreator = PLATFORM.creatorFees(creator) - creatorBefore;
        uint256 toPlatform = PLATFORM.platformFees() - platformBefore;
        assertApproxEqAbs(toCreator + toPlatform, (buyUnits * 1e12) / 100, 2e12, "1% of the buy, in USDC");
        assertApproxEqAbs(toCreator * 2, toPlatform, 2, "a third to the creator");
        assertApproxEqAbs(
            ANewOneToken(NOAH).balanceOf(BURN) - burnedBefore, sellAmount / 100, sellAmount / 1e9, "the token side is burned"
        );
        assertEq(_position(id).liquidity, liqBefore, "the liquidity itself never moved");
        assertEq(ANewOneToken(NOAH).balanceOf(address(PLATFORM)), 0);

        // and the pot is claimed the usual way, by the creator, in native USDC
        uint256 cBal = creator.balance;
        vm.prank(creator);
        PLATFORM.claimCreatorFees();
        assertGt(creator.balance, cBal);
    }

    // ------------------------------------------------------------ helpers

    /// @dev Buys $NOAH past the target in one go, unless the chain already has it graduated.
    function _graduateNoah() internal {
        (,, bool graduated,,, uint256 raised,) = PLATFORM.info(NOAH);
        assertFalse(PLATFORM.migrated(NOAH), "not migrated yet on this fork");
        if (!graduated) {
            // what the curve still needs, grossed up for the 1.5% fee, plus a little
            uint256 need = PLATFORM.gradTarget() - raised;
            uint256 value = (need * 10_000) / (10_000 - PLATFORM.FEE_BPS()) + 10e18;
            vm.prank(buyer);
            PLATFORM.buy{value: value}(NOAH, 0);
        }
        (,, graduated,,,,) = PLATFORM.info(NOAH);
        assertTrue(graduated, "graduated");
    }

    function _creator(address token) internal view returns (address c) {
        (c,,,,,,) = PLATFORM.info(token);
    }

    function _raised(address token) internal view returns (uint256 r) {
        (,,,,, r,) = PLATFORM.info(token);
    }

    function _tReserve(address token) internal view returns (uint256 r) {
        (,,,, r,,) = PLATFORM.info(token);
    }

    /// @dev An exact-input swap straight against the pool, paid for in the callback below, so
    ///      the rehearsal does not depend on a router being where the config says.
    function _swap(address pool, address tokenIn, uint256 amountIn) internal {
        bool zeroForOne = tokenIn == IPoolSwap(pool).token0();
        swapPool = pool;
        IPoolSwap(pool).swap(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? uint160(4_295_128_740) : uint160(1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341), ""
        );
        swapPool = address(0);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == swapPool && swapPool != address(0), "not our swap");
        if (amount0Delta > 0) IERC20Like(IPoolSwap(swapPool).token0()).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20Like(IPoolSwap(swapPool).token1()).transfer(msg.sender, uint256(amount1Delta));
    }

    receive() external payable {}
}
