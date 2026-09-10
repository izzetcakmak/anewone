// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcUSDC} from "./ArcUSDC.sol";

address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

interface IUniFactory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IUniPool {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
}

interface IUniNFPM {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function refundETH() external payable;
    function permit(address spender, uint256 tokenId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        payable;
}

interface IUniRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IERC20Like {
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @dev NonfungiblePositionManager.positions(), all twelve fields.
struct Position {
    uint96 nonce;
    address operator;
    address token0;
    address token1;
    uint24 fee;
    int24 tickLower;
    int24 tickUpper;
    uint128 liquidity;
    uint256 feeGrowthInside0LastX128;
    uint256 feeGrowthInside1LastX128;
    uint128 tokensOwed0;
    uint128 tokensOwed1;
}

/// @dev Decoded straight into memory: destructuring twelve return values puts all twelve on
///      the stack at once, which the legacy code generator cannot fit next to a test's locals.
function readPosition(address positionManager, uint256 id) view returns (Position memory p) {
    (bool ok, bytes memory data) = positionManager.staticcall(abi.encodeWithSignature("positions(uint256)", id));
    require(ok, "positions");
    p = abi.decode(data, (Position));
}

/// @notice Canonical Uniswap v3, deployed from the bytecode Uniswap published to npm, with Arc's
///         USDC face emulated at its real address. See test/fixtures/uniswap-v3/PROVENANCE.md.
abstract contract UniV3Fixture is Test {
    string internal constant FIX = "test/fixtures/uniswap-v3/";
    uint24 internal constant FEE = 10_000;
    int24 internal constant FULL_LOWER = -887_200;
    int24 internal constant FULL_UPPER = 887_200;

    /// @dev Arc has no wrapped native token, yet the periphery takes a WETH9 argument. An
    ///      address with no code and no owner: its WETH9 branches can never run.
    address internal constant NO_WETH = address(uint160(0x5EE0));

    IUniFactory internal factory;
    IUniNFPM internal nfpm;
    IUniRouter internal router;

    function _deployUniswap() internal {
        vm.etch(ARC_USDC, address(new ArcUSDC()).code);
        factory = IUniFactory(_deployArtifact("UniswapV3Factory.json", ""));
        nfpm = IUniNFPM(
            _deployArtifact("NonfungiblePositionManager.json", abi.encode(address(factory), NO_WETH, address(0)))
        );
        router = IUniRouter(_deployArtifact("SwapRouter.json", abi.encode(address(factory), NO_WETH)));
        vm.label(ARC_USDC, "USDC");
        vm.label(address(factory), "UniswapV3Factory");
        vm.label(address(nfpm), "NonfungiblePositionManager");
        vm.label(address(router), "SwapRouter");
    }

    function _deployArtifact(string memory name, bytes memory args) internal returns (address a) {
        bytes memory code =
            abi.encodePacked(vm.parseJsonBytes(vm.readFile(string.concat(FIX, name)), ".bytecode"), args);
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0) && a.code.length > 0, string.concat("deploy failed: ", name));
    }

    function _position(uint256 id) internal view returns (Position memory) {
        return readPosition(address(nfpm), id);
    }

    function _usdc(address who) internal view returns (uint256) {
        return IERC20Like(ARC_USDC).balanceOf(who);
    }

    function _sorted(address token) internal pure returns (address token0, address token1) {
        return token < ARC_USDC ? (token, ARC_USDC) : (ARC_USDC, token);
    }

    /// @dev A pool's price the way the curve's priceWad states it: native USDC wei per whole
    ///      token, times 1e18, which is USDC units per token wei times 1e30.
    function _poolPriceWad(address pool, address token) internal view returns (uint256) {
        (uint160 sp,,,,,,) = IUniPool(pool).slot0();
        uint256 s = uint256(sp);
        // s * s whenever it fits, so no intermediate step rounds away the digits of a tiny price
        if (token < ARC_USDC) {
            // price = token1 / token0 = USDC units per token wei
            return s < (1 << 128)
                ? Math.mulDiv(s * s, 1e30, 1 << 192)
                : Math.mulDiv(Math.mulDiv(s, s, 1 << 64), 1e30, 1 << 128);
        }
        // price = token wei per USDC unit
        return s < (1 << 128)
            ? Math.mulDiv(1e30, 1 << 192, s * s)
            : Math.mulDiv(Math.mulDiv(1e30, 1 << 96, s), 1 << 96, s);
    }

    /// @dev The sqrtPriceX96 a pool for this token has at a curve-style priceWad. As in the
    ///      contract, a ratio past 2^64 is scaled by 2^128 before the root so it cannot overflow.
    function _sqrtAt(address token, uint256 priceWad) internal pure returns (uint160) {
        if (token < ARC_USDC) return uint160(Math.sqrt(Math.mulDiv(priceWad, 1 << 192, 1e30)));
        if (1e30 < (priceWad << 64)) return uint160(Math.sqrt(Math.mulDiv(1e30, 1 << 192, priceWad)));
        return uint160(Math.sqrt(Math.mulDiv(1e30, 1 << 128, priceWad)) << 32);
    }

    function _buyOnPool(address who, address token, uint256 usdcUnits) internal returns (uint256 out) {
        return _swapOnPool(who, ARC_USDC, token, usdcUnits, 0);
    }

    function _sellOnPool(address who, address token, uint256 amount) internal returns (uint256 out) {
        return _swapOnPool(who, token, ARC_USDC, amount, 0);
    }

    function _swapOnPool(address who, address tokenIn, address tokenOut, uint256 amountIn, uint160 limit)
        internal
        returns (uint256 out)
    {
        vm.startPrank(who);
        IERC20Like(tokenIn).approve(address(router), amountIn);
        out = router.exactInputSingle(
            IUniRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: FEE,
                recipient: who,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: limit
            })
        );
        vm.stopPrank();
    }

    /// @dev Somebody else's liquidity, minted through the position manager like anyone would.
    function _addLiquidity(address who, address token, uint256 tokenAmount, uint256 usdcUnits)
        internal
        returns (uint128 liquidity)
    {
        (address t0, address t1) = _sorted(token);
        (uint256 a0, uint256 a1) = token < ARC_USDC ? (tokenAmount, usdcUnits) : (usdcUnits, tokenAmount);
        vm.startPrank(who);
        IERC20Like(token).approve(address(nfpm), tokenAmount);
        IERC20Like(ARC_USDC).approve(address(nfpm), usdcUnits);
        (, liquidity,,) = nfpm.mint(
            IUniNFPM.MintParams({
                token0: t0,
                token1: t1,
                fee: FEE,
                tickLower: FULL_LOWER,
                tickUpper: FULL_UPPER,
                amount0Desired: a0,
                amount1Desired: a1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: who,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }
}
