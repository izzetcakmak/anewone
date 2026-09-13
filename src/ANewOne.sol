// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Minimal ERC20 minted entirely to the ANewOne curve at creation.
contract ANewOneToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply_, address holder_) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply_;
        balanceOf[holder_] = supply_;
        emit Transfer(address(0), holder_, supply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(to != address(0), "zero to");
        uint256 bal = balanceOf[from];
        require(bal >= value, "balance");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        return true;
    }
}

/// @notice The slices of Uniswap v3 this contract touches, and nothing more.
/// @dev On Arc, native USDC has an ERC-20 face at 0x3600...0000 with 6 decimals, over the
///      same balance the chain counts in 18. Uniswap only ever sees the ERC-20 face and the
///      curve only the native one, so every crossing between the two goes through
///      NATIVE_PER_USDC_UNIT.
interface IERC20Min {
    function decimals() external view returns (uint8);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface INonfungiblePositionManager {
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

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function factory() external view returns (address);
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

/// @title ANewOne — meme token launchpad with a bonding curve, native-USDC denominated (Arc L1).
/// @notice pump.fun-style constant-product curve with quality upgrades:
///         - creator earns 0.5% of every trade (a third of the 1.5% fee); the platform's 1%
///           is split evenly between the owners as it accrues, each withdrawing only their own
///         - anti-snipe: per-wallet cap during the first blocks after launch
///         - rug-proof: curve reserves can only be traded against, or moved once into a
///           Uniswap v3 position this contract holds and has no way to withdraw; fees are
///           segregated from reserves.
contract ANewOne {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18; // 1B tokens per launch
    uint16 public constant FEE_BPS = 150; // 1.5% total trade fee
    uint16 public constant CREATOR_FEE_BPS = 50; // 0.5% of trade goes to token creator
    // The remaining 1% is the platform's, and it is split evenly between the owners
    // as it accrues: with the two owners this launches with, half a percent each.
    uint256 public constant ANTI_SNIPE_BLOCKS = 20;
    uint256 public constant ANTI_SNIPE_MAX = TOTAL_SUPPLY / 50; // 2% per wallet early on

    /// @notice Virtual USDC seeded into every curve (sets the starting price).
    uint256 public immutable virtualUsdc0;
    /// @notice Real USDC raised at which a token "graduates". The buy that crosses it goes
    ///         through; after it the curve is closed, and the coin waits for migrate() to move
    ///         it into Uniswap v3, where trading resumes. If that move cannot happen, the admin may
    ///         reopen the curve from REOPEN_DELAY after graduation (reopenCurve). On a platform
    ///         built without Uniswap graduation is only a badge and trading carries on.
    uint256 public immutable gradTarget;

    /// @notice Creators must claim accrued fees within this window; afterwards the pot
    ///         is sweepable into platform fees by anyone.
    uint256 public constant CLAIM_WINDOW = 7 days;

    /// @notice The one wallet that governs the platform: it adds and removes owners, opens and
    ///         closes migrations and reopens curves. Owners have no say in any of it. Set to the
    ///         deployer and fixed for good, with no function to hand it over, so control of the
    ///         platform can never pass to another wallet.
    address public immutable admin;
    /// @notice Platform owners share the platform's fees: each has its own balance, withdraws
    ///         only that, and cannot touch another's. Withdrawing is the only thing an owner can
    ///         do. Only the admin adds or removes owners, and there must always be at least one.
    mapping(address => bool) public isOwner;
    address[] public owners;
    /// @notice Each owner's unclaimed platform fees. The platform's share of a trade is split
    ///         evenly across the owners at the moment it accrues, so a later change to the owner
    ///         set never moves fees that were already earned.
    mapping(address => uint256) public ownerFees;
    mapping(address => uint256) public creatorFees;
    /// @notice When the creator's current unclaimed pot started accruing (set when pot goes 0 -> >0).
    mapping(address => uint256) public creatorFeeSince;

    struct TokenInfo {
        address creator;
        uint64 createdBlock;
        bool graduated;
        uint256 vUsdc; // virtual USDC reserve = virtualUsdc0 + raised
        uint256 tReserve; // tokens still held by the curve
        uint256 raised; // real USDC locked in the curve
        string metadataURI;
    }

    address[] public allTokens;
    mapping(address => TokenInfo) public info;
    mapping(address => mapping(address => uint256)) public earlyBought;

    // ------------------------------------------------------------ migration state

    /// @notice The 1% Uniswap v3 tier, the same fee the curve charges, and the tick spacing
    ///         v3 pairs with it. Full range is TickMath's bounds rounded in to that spacing.
    uint24 public constant POOL_FEE = 10_000;
    int24 public constant TICK_SPACING = 200;
    int24 internal constant FULL_RANGE_LOWER = -887_200;
    int24 internal constant FULL_RANGE_UPPER = 887_200;
    uint160 internal constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 internal constant MAX_SQRT_RATIO = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;
    /// @notice Native USDC carries 18 decimals, its ERC-20 face on Arc carries 6.
    uint256 public constant NATIVE_PER_USDC_UNIT = 1e12;
    /// @notice How far from the curve's price a pool somebody else initialised may still sit
    ///         once migrate() has traded against it: 0.5% on the square root, about 1% on the
    ///         price. Further than that and the migration is refused, not accepted at their price.
    uint256 public constant SQRT_PRICE_TOLERANCE_BPS = 50;
    /// @notice The most of its own reserves a migration will trade to pull such a pool back to
    ///         the curve's price. Moving an empty pool costs nothing; this only bounds how much
    ///         liquidity parked at the wrong price can sell to, or buy from, the migration.
    uint256 public constant MAX_CORRECTION_BPS = 200;
    /// @notice Leftover USDC below this (ERC-20 units: 0.01 USDC) is dust, not worth a swap.
    uint256 internal constant BUYBACK_MIN = 1e4;
    /// @notice Where tokens leave circulation for good. ANewOneToken refuses address(0).
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @notice Fixed at deploy, with no setter. An owner who could re-point migration at a
    ///         different "Uniswap" could point it at a contract that keeps the reserves, and
    ///         every graduation would become a rug. All three zero means this deployment can
    ///         never migrate, which is the right answer on a chain without Uniswap v3. Uniswap
    ///         itself need not be live yet: see setMigrationsOpen.
    IUniswapV3Factory public immutable v3Factory;
    INonfungiblePositionManager public immutable positionManager;
    IERC20Min public immutable usdc;

    /// @notice The owner's only migration lever. It can hold migrations back; it cannot send a
    ///         single wei of the reserves anywhere.
    bool public migrationsOpen;
    /// @notice Tokens whose curve has been moved into a pool.
    /// @dev Its own mapping rather than a field on TokenInfo: adding to that struct changes the
    ///      tuple `info()` returns, and the same front end reads this contract and the one
    ///      already on testnet.
    mapping(address => bool) public migrated;
    /// @notice The v3 position each migrated token's liquidity sits in. This contract holds the
    ///         NFT and has no function that moves it or takes liquidity out of it: fees can be
    ///         collected from it, the liquidity can never be withdrawn. Nor can a signature: it
    ///         implements no ERC-1271 isValidSignature, so the position manager's permit() cannot
    ///         approve anybody for the NFT either.
    mapping(address => uint256) public positionOf;
    /// @notice When each coin graduated (block timestamp): the clock REOPEN_DELAY runs on.
    mapping(address => uint64) public graduatedAt;
    /// @notice Graduated coins an owner put back on their curve because their move into Uniswap
    ///         could not happen yet. Such a curve trades as before until migrate() succeeds.
    mapping(address => bool) public curveReopened;
    /// @notice How long a graduated coin's curve stays closed before an owner may reopen it.
    uint256 public constant REOPEN_DELAY = 1 hours;

    uint256 private unlocked = 1;
    /// @dev The one pool migrate() is trading against right now. The swap callback pays that
    ///      pool and no other, and not even that one outside a migration.
    address private swapPool;

    /// @dev What a migration carries between its steps, in memory so the steps can be separate
    ///      functions without running out of stack.
    struct Move {
        address token;
        address pool;
        bool tokenIsZero;
        uint256 amount0;
        uint256 amount1;
        uint256 tokensBurned;
    }

    event TokenCreated(
        address indexed token, address indexed creator, string name, string symbol, string metadataURI
    );
    /// @notice Token image, emitted once at launch. Event-only like comments: log data costs
    ///         8 gas/byte vs ~625 gas/byte for storage, so a 24KB image costs ~0.3M gas
    ///         instead of ~20M.
    event TokenImage(address indexed token, string imageURI);
    /// @notice A completed trade.
    /// @dev `usdcAmount` is trader-centric and the two sides are deliberately NOT the same
    ///      quantity: on a buy it is what the trader PAID (fee included), on a sell what the
    ///      trader RECEIVED (fee already deducted). That is what a wallet actually moved, so
    ///      it is the correct basis for a trade feed and for per-trader PnL.
    ///      Indexers summing this as VOLUME must convert both sides to the curve-side amount
    ///      first (buy x (1 - fee), sell / (1 - fee)); adding the raw values overstates buys
    ///      by the fee. The same applies to any price implied as usdcAmount / tokenAmount.
    event Trade(
        address indexed token,
        address indexed trader,
        bool indexed isBuy,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 newPriceWad
    );
    event Graduated(address indexed token, uint256 raised);
    event MigrationsSet(bool open);
    event CurveReopened(address indexed token);
    /// @notice A curve moved into Uniswap v3. The USDC amount is in native units (18 decimals),
    ///         like every other amount this contract emits, not in the pool's 6.
    event Migrated(
        address indexed token,
        address indexed pool,
        uint256 positionId,
        uint256 tokensToPool,
        uint256 usdcToPool,
        uint128 liquidity,
        uint256 tokensBurned
    );
    /// @notice Pool fees swept into the books: the USDC side (native units) split like a curve
    ///         fee, the token side burned.
    event PoolFeesCollected(address indexed token, uint256 usdcFees, uint256 tokensBurned);
    event FeesClaimed(address indexed who, uint256 amount);
    event CreatorFeesExpired(address indexed creator, uint256 amount);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event Comment(address indexed token, address indexed author, string text);

    modifier nonReentrant() {
        require(unlocked == 1, "reentrancy");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    modifier onlyOwner() {
        require(isOwner[msg.sender], "owner");
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "admin");
        _;
    }

    constructor(
        uint256 virtualUsdc0_,
        uint256 gradTarget_,
        address v3Factory_,
        address positionManager_,
        address usdc_
    ) {
        require(virtualUsdc0_ > 0 && gradTarget_ > 0, "params");
        admin = msg.sender;
        _addOwner(msg.sender);
        virtualUsdc0 = virtualUsdc0_;
        gradTarget = gradTarget_;

        // All three or none; none builds a platform that can never migrate.
        bool none = v3Factory_ == address(0) && positionManager_ == address(0) && usdc_ == address(0);
        if (!none) {
            require(
                v3Factory_ != address(0) && positionManager_ != address(0) && usdc_ != address(0), "dex: all or none"
            );
            // USDC is an Arc predeploy, there from the first block, so it is checked now.
            require(usdc_.code.length > 0 && IERC20Min(usdc_).decimals() == 6, "dex: usdc");
            // Uniswap is not: it may reach a chain after the chain opens, and this platform must
            // not wait for it, because $NOAH launches with the chain. Its addresses are fixed here
            // all the same; what stands behind them is checked when an owner opens migrations,
            // the first moment it matters.
        }
        v3Factory = IUniswapV3Factory(v3Factory_);
        positionManager = INonfungiblePositionManager(positionManager_);
        usdc = IERC20Min(usdc_);
    }

    // ---------------------------------------------------------------- launch

    /// @notice Storage cap for the metadata document (compact JSON: description + socials).
    ///         Storage bytes are the expensive part of a launch, so they are bounded.
    uint256 public constant MAX_METADATA_BYTES = 2048;
    /// @notice Cap for the image data URI carried in the TokenImage event (frontend
    ///         compresses to ≤24KB binary ≈ 32K base64 chars; headroom on top).
    uint256 public constant MAX_IMAGE_BYTES = 36_000;

    /// @notice Launch a new meme token. Free (gas only). Send value to make an initial dev buy.
    /// @dev The image travels in the TokenImage event, never in storage — that keeps a launch
    ///      with a full-size image around ~2M gas instead of ~20M+.
    function createToken(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        string calldata imageURI_
    ) external payable nonReentrant returns (address token) {
        require(bytes(metadataURI_).length <= MAX_METADATA_BYTES, "metadata too large");
        // A coin with no artwork is an unreadable card on a floor people scan by
        // picture, and nothing off-chain can enforce this: the front end can ask
        // politely, but createToken is permissionless and callable directly.
        require(bytes(imageURI_).length > 0, "image required");
        require(bytes(imageURI_).length <= MAX_IMAGE_BYTES, "image too large");
        token = address(new ANewOneToken(name_, symbol_, TOTAL_SUPPLY, address(this)));
        info[token] = TokenInfo({
            creator: msg.sender,
            createdBlock: uint64(block.number),
            graduated: false,
            vUsdc: virtualUsdc0,
            tReserve: TOTAL_SUPPLY,
            raised: 0,
            metadataURI: metadataURI_
        });
        allTokens.push(token);
        emit TokenCreated(token, msg.sender, name_, symbol_, metadataURI_);
        emit TokenImage(token, imageURI_); // required above, so always present

        if (msg.value > 0) {
            _buy(token, msg.sender, msg.value, 0);
        }
    }

    // ---------------------------------------------------------------- trading

    function buy(address token, uint256 minTokensOut) external payable nonReentrant {
        require(msg.value > 0, "no value");
        _buy(token, msg.sender, msg.value, minTokensOut);
    }

    function _buy(address token, address to, uint256 value, uint256 minTokensOut) internal {
        TokenInfo storage t = info[token];
        require(t.creator != address(0), "unknown token");
        // a graduated curve is done: it waits, closed, for its move into Uniswap v3
        require(_curveOpen(token, t), "graduated");

        uint256 fee = (value * FEE_BPS) / 10_000;
        uint256 usdcIn = value - fee;
        _splitFee(t.creator, fee);

        uint256 k = t.vUsdc * t.tReserve;
        uint256 newTReserve = _ceilDiv(k, t.vUsdc + usdcIn);
        uint256 tokensOut = t.tReserve - newTReserve;
        require(tokensOut >= minTokensOut && tokensOut > 0, "slippage");

        if (block.number <= t.createdBlock + ANTI_SNIPE_BLOCKS) {
            uint256 bought = earlyBought[token][to] + tokensOut;
            require(bought <= ANTI_SNIPE_MAX, "anti-snipe cap");
            earlyBought[token][to] = bought;
        }

        t.vUsdc += usdcIn;
        t.tReserve = newTReserve;
        t.raised += usdcIn;

        if (!t.graduated && t.raised >= gradTarget) {
            t.graduated = true;
            graduatedAt[token] = uint64(block.timestamp);
            emit Graduated(token, t.raised);
        }

        require(ANewOneToken(token).transfer(to, tokensOut), "transfer");
        emit Trade(token, to, true, value, tokensOut, _priceWad(t));
    }

    function sell(address token, uint256 tokenAmount, uint256 minUsdcOut) external nonReentrant {
        TokenInfo storage t = info[token];
        require(t.creator != address(0), "unknown token");
        require(_curveOpen(token, t), "graduated");
        require(tokenAmount > 0, "no amount");

        require(ANewOneToken(token).transferFrom(msg.sender, address(this), tokenAmount), "transferFrom");

        uint256 k = t.vUsdc * t.tReserve;
        uint256 newVUsdc = _ceilDiv(k, t.tReserve + tokenAmount);
        uint256 gross = t.vUsdc - newVUsdc;
        if (gross > t.raised) gross = t.raised; // rounding-dust clamp; virtual floor is never touched

        uint256 fee = (gross * FEE_BPS) / 10_000;
        uint256 usdcOut = gross - fee;
        require(usdcOut >= minUsdcOut && usdcOut > 0, "slippage");

        t.vUsdc -= gross;
        t.tReserve += tokenAmount;
        t.raised -= gross;

        _splitFee(t.creator, fee);
        (bool ok,) = msg.sender.call{value: usdcOut}("");
        require(ok, "send");
        emit Trade(token, msg.sender, false, usdcOut, tokenAmount, _priceWad(t));
    }

    // ------------------------------------------------------------ migration

    /// @notice Open or close migration. Closed is how this ships. Opening requires Uniswap v3 to
    ///         be live at the addresses fixed at deploy, and to be the Uniswap v3 this contract
    ///         expects; closing never needs it.
    function setMigrationsOpen(bool open) external onlyAdmin {
        require(address(v3Factory) != address(0), "no dex");
        if (open) {
            require(address(v3Factory).code.length > 0 && address(positionManager).code.length > 0, "dex: not live");
            require(v3Factory.feeAmountTickSpacing(POOL_FEE) == TICK_SPACING, "dex: 1% tier");
            require(positionManager.factory() == address(v3Factory), "dex: pm factory");
        }
        migrationsOpen = open;
        emit MigrationsSet(open);
    }

    /// @notice The admin's way out for a graduated coin whose move into Uniswap cannot happen:
    ///         Uniswap not live yet, or something blocking its pool. From REOPEN_DELAY after
    ///         graduation the admin may put the coin back on its curve, which then trades exactly
    ///         as before graduation until migrate() succeeds and closes it for good. Reopening
    ///         moves no funds and changes no price.
    function reopenCurve(address token) external onlyAdmin {
        TokenInfo storage t = info[token];
        require(address(v3Factory) != address(0), "no dex"); // without Uniswap it never closed
        require(t.graduated, "not graduated");
        require(!migrated[token], "already migrated");
        require(!curveReopened[token], "already open");
        require(block.timestamp >= graduatedAt[token] + REOPEN_DELAY, "too early");
        curveReopened[token] = true;
        emit CurveReopened(token);
    }

    /// @notice Move a graduated token's curve into a full-range Uniswap v3 position that this
    ///         contract holds for good. Trading on the curve already ended at graduation; it
    ///         resumes in the pool.
    /// @dev Permissionless on purpose: once a token has graduated, nobody should have to wait
    ///      on us for it to reach a pool every indexer can see. A separate call rather than part
    ///      of the graduating buy, so one unlucky buyer is not charged for a pool deployment and
    ///      a problem anywhere in Uniswap cannot take their trade down with it.
    ///
    ///      The pool opens at the curve's own last price, vUsdc / tReserve, so nobody who bought
    ///      on the curve is marked down by the move. That price counts the virtual USDC, which
    ///      never existed, so pairing all of `raised` with all of `tReserve` would open the pool
    ///      well below it (about 45% below with the launch parameters). Only the tokens `raised`
    ///      buys at the curve's price go in. The rest of the unsold supply is burned, not kept.
    function migrate(address token) external nonReentrant {
        require(migrationsOpen, "migration off");
        TokenInfo storage t = info[token];
        require(t.creator != address(0), "unknown token");
        require(t.graduated, "not graduated");
        require(!migrated[token], "already migrated");
        // A closed curve cannot slip back under the target, but a reopened one can: it then
        // trades on until buys lift it again, since a pool should never open shallower than the
        // target that earned it.
        require(t.raised >= gradTarget, "below target");

        Move memory m = _plan(token, t);
        _openPool(m);
        (uint256 id, uint128 liquidity, uint256 used0, uint256 used1) = _mintFullRange(m);
        positionOf[token] = id;
        _disposeLeftovers(m, used0, used1);
        if (m.tokensBurned > 0) require(ANewOneToken(token).transfer(BURN, m.tokensBurned), "burn");

        emit Migrated(
            token,
            m.pool,
            id,
            m.tokenIsZero ? used0 : used1,
            (m.tokenIsZero ? used1 : used0) * NATIVE_PER_USDC_UNIT,
            liquidity,
            m.tokensBurned
        );
    }

    /// @notice Sweep the trading fees a migrated token's position has earned. Anybody may call
    ///         it. The USDC side is split between creator and platform exactly as a curve fee
    ///         is; the token side is burned, since nobody here is meant to end up holding it.
    function collectPoolFees(address token) external nonReentrant {
        uint256 id = positionOf[token];
        require(id != 0, "not migrated");
        (uint256 a0, uint256 a1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: id,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        bool tokenIsZero = token < address(usdc);
        uint256 tokenFees = tokenIsZero ? a0 : a1;
        uint256 usdcFees = (tokenIsZero ? a1 : a0) * NATIVE_PER_USDC_UNIT;
        if (tokenFees > 0) require(ANewOneToken(token).transfer(BURN, tokenFees), "burn");
        // it came in through the ERC-20 face, so it is already part of this contract's balance
        if (usdcFees > 0) _splitFee(info[token].creator, usdcFees);
        emit PoolFeesCollected(token, usdcFees, tokenFees);
    }

    /// @notice Uniswap v3 asks for payment here during a swap. Only the pool migrate() is
    ///         trading against, and only while it is, gets paid.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        address pool = swapPool;
        require(pool != address(0) && msg.sender == pool, "not our swap");
        if (amount0Delta > 0) _pay(IUniswapV3Pool(pool).token0(), pool, uint256(amount0Delta));
        if (amount1Delta > 0) _pay(IUniswapV3Pool(pool).token1(), pool, uint256(amount1Delta));
    }

    /// @dev Only so a position manager that mints with _safeMint could still hand over the NFT.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    /// @dev Sizes the move and closes the curve, before anything external runs.
    function _plan(address token, TokenInfo storage t) internal returns (Move memory m) {
        // The single native to ERC-20 conversion, rounding down. What the 6 decimal face cannot
        // carry is under a millionth of a USDC; it goes to the fee pool so the native books
        // still balance to the wei.
        uint256 usdcIn = t.raised / NATIVE_PER_USDC_UNIT;
        uint256 tokensIn = Math.mulDiv(t.tReserve, usdcIn * NATIVE_PER_USDC_UNIT, t.vUsdc);
        require(usdcIn > 0 && tokensIn > 0, "nothing to migrate");

        m.token = token;
        m.tokenIsZero = token < address(usdc);
        if (m.tokenIsZero) {
            m.amount0 = tokensIn;
            m.amount1 = usdcIn;
        } else {
            m.amount0 = usdcIn;
            m.amount1 = tokensIn;
        }
        m.tokensBurned = t.tReserve - tokensIn;

        // The reserves stay frozen rather than zeroed: _priceWad divides by tReserve, and the
        // last curve price is worth keeping readable.
        _creditPlatform(t.raised - usdcIn * NATIVE_PER_USDC_UNIT);
        migrated[token] = true;
        t.raised = 0;
    }

    /// @dev Opens the pool at the curve's price or, if somebody got there first, pulls theirs
    ///      back to it.
    function _openPool(Move memory m) internal {
        (address token0, address token1) = _pair(m);
        uint160 target = _sqrtPriceX96(m.amount0, m.amount1);
        // creates the pool if there is none, and initialises it if somebody created it bare
        m.pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, POOL_FEE, target);
        require(m.pool != address(0) && v3Factory.getPool(token0, token1, POOL_FEE) == m.pool, "pool");

        (uint160 current,,,,,,) = IUniswapV3Pool(m.pool).slot0();
        if (current == target) return;

        // Initialised by somebody else, at a price of their choosing. Trade against it toward
        // the curve's price with this token's own reserves: every unit that moves is bought
        // below, or sold above, what the curve says it is worth, so a pool set at a hostile
        // price pays for its own correction and an empty one moves for nothing. The trade is
        // capped, so liquidity parked just off the price cannot use the migration as the buyer
        // for a whole bag. If the pool is still off after that, refuse: a migration can wait, a
        // mispriced pool cannot be taken back.
        bool zeroForOne = current > target; // selling token0 pushes the price down
        uint256 budget = ((zeroForOne ? m.amount0 : m.amount1) * MAX_CORRECTION_BPS) / 10_000;
        if (budget == 0) budget = 1;
        (int256 d0, int256 d1) = _swap(m.pool, zeroForOne, budget, target);
        m.amount0 = _afterDelta(m.amount0, d0);
        m.amount1 = _afterDelta(m.amount1, d1);

        (current,,,,,,) = IUniswapV3Pool(m.pool).slot0();
        require(_within(current, target), "pool price out of reach");
    }

    function _mintFullRange(Move memory m)
        internal
        returns (uint256 id, uint128 liquidity, uint256 used0, uint256 used1)
    {
        (address token0, address token1) = _pair(m);
        _approvePm(token0, m.amount0);
        _approvePm(token1, m.amount1);
        // amount0Min / amount1Min stay zero: the price was set or checked earlier in this same
        // transaction, and nothing outside it can move the pool in between
        (id, liquidity, used0, used1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: FULL_RANGE_LOWER,
                tickUpper: FULL_RANGE_UPPER,
                amount0Desired: m.amount0,
                amount1Desired: m.amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        _approvePm(token0, 0);
        _approvePm(token1, 0);
    }

    /// @dev Whatever the full-range mint could not use: a few wei normally, more only when a
    ///      correction left the two sides out of balance. Leftover tokens are burned. Leftover
    ///      USDC belongs to the holders, not to us, so it buys the token in the pool that just
    ///      opened and that is burned too. Under BUYBACK_MIN it is dust and goes to fees.
    function _disposeLeftovers(Move memory m, uint256 used0, uint256 used1) internal {
        m.tokensBurned += m.tokenIsZero ? m.amount0 - used0 : m.amount1 - used1;
        uint256 leftUsdc = m.tokenIsZero ? m.amount1 - used1 : m.amount0 - used0;

        if (leftUsdc >= BUYBACK_MIN) {
            bool zeroForOne = !m.tokenIsZero; // paying USDC, which is token0 whenever the token is not
            (int256 d0, int256 d1) =
                _swap(m.pool, zeroForOne, leftUsdc, zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1);
            int256 tokenDelta = m.tokenIsZero ? d0 : d1; // negative: tokens the pool paid out
            int256 usdcDelta = m.tokenIsZero ? d1 : d0; // positive: USDC the pool took
            if (tokenDelta < 0) m.tokensBurned += uint256(-tokenDelta);
            leftUsdc -= uint256(usdcDelta);
        }
        if (leftUsdc > 0) _creditPlatform(leftUsdc * NATIVE_PER_USDC_UNIT);
    }

    /// @dev A swap this contract pays for in uniswapV3SwapCallback.
    function _swap(address pool, bool zeroForOne, uint256 amountIn, uint160 limit)
        internal
        returns (int256 d0, int256 d1)
    {
        swapPool = pool;
        (d0, d1) = IUniswapV3Pool(pool).swap(address(this), zeroForOne, int256(amountIn), limit, "");
        swapPool = address(0);
    }

    function _pay(address tok, address to, uint256 amount) internal {
        bool ok = tok == address(usdc) ? usdc.transfer(to, amount) : ANewOneToken(tok).transfer(to, amount);
        require(ok, "pay");
    }

    function _approvePm(address tok, uint256 amount) internal {
        bool ok = tok == address(usdc)
            ? usdc.approve(address(positionManager), amount)
            : ANewOneToken(tok).approve(address(positionManager), amount);
        require(ok, "approve");
    }

    function _pair(Move memory m) internal view returns (address token0, address token1) {
        if (m.tokenIsZero) return (m.token, address(usdc));
        return (address(usdc), m.token);
    }

    /// @dev positive: the pool was paid out of what we hold; negative: the pool paid us
    function _afterDelta(uint256 held, int256 poolDelta) internal pure returns (uint256) {
        return poolDelta >= 0 ? held - uint256(poolDelta) : held + uint256(-poolDelta);
    }

    function _within(uint160 a, uint160 b) internal pure returns (bool) {
        uint256 d = a > b ? a - b : b - a;
        return d * 10_000 <= uint256(b) * SQRT_PRICE_TOLERANCE_BPS;
    }

    /// @dev sqrt(amount1 / amount0) in Q64.96, the form a v3 pool is initialised with. Scaling the
    ///      ratio by 2^192 before the root keeps every bit of precision, but only fits while the
    ///      ratio is under 2^64. With the token as token1 the ratio is token wei per USDC unit, and
    ///      it passes 2^64 once a token trades under about 0.00000005 USDC, which a curve with a
    ///      small graduation target does. Past that the ratio is scaled by 2^128 instead and the
    ///      missing 2^32 goes back on after the root, still exact to one part in 2^96.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 r = amount1 < (amount0 << 64)
            ? Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0))
            : Math.sqrt(Math.mulDiv(amount1, 1 << 128, amount0)) << 32;
        require(r > MIN_SQRT_RATIO && r < MAX_SQRT_RATIO, "price out of range");
        return uint160(r);
    }

    // ---------------------------------------------------------------- fees

    /// @dev The platform's share of anything — a trade fee, migration dust, an expired creator
    ///      pot — divided evenly across the owners there and then. Splitting at accrual rather
    ///      than at withdrawal is what makes each owner's balance theirs: adding or removing an
    ///      owner later changes who earns from the next trade, never who owns the last one.
    ///      The remainder of an odd wei goes to the first owner; at 1e-18 USDC it is dust, and
    ///      leaving it unassigned would strand it in the contract.
    function _creditPlatform(uint256 amount) internal {
        if (amount == 0) return;
        uint256 n = owners.length;
        uint256 each = amount / n;
        if (each > 0) {
            for (uint256 i = 0; i < n; i++) ownerFees[owners[i]] += each;
        }
        uint256 dust = amount - each * n;
        if (dust > 0) ownerFees[owners[0]] += dust;
    }

    /// @notice Every owner's unclaimed fees added up — what the platform has earned and not
    ///         yet withdrawn. The money itself sits in the per-owner balances.
    function platformFees() public view returns (uint256 total) {
        for (uint256 i = 0; i < owners.length; i++) total += ownerFees[owners[i]];
    }

    function _splitFee(address creator, uint256 fee) internal {
        uint256 creatorCut = (fee * CREATOR_FEE_BPS) / FEE_BPS;
        if (creatorCut > 0) {
            uint256 pot = creatorFees[creator];
            if (pot > 0 && block.timestamp > creatorFeeSince[creator] + CLAIM_WINDOW) {
                // enforce expiry before adding fresh fees, so new earnings always
                // start their own full 7-day window instead of inheriting a dead one
                _creditPlatform(pot);
                emit CreatorFeesExpired(creator, pot);
                pot = 0;
            }
            if (pot == 0) creatorFeeSince[creator] = block.timestamp;
            creatorFees[creator] = pot + creatorCut;
        }
        _creditPlatform(fee - creatorCut);
    }

    /// @notice True when the creator's pot sat unclaimed past the 7-day window.
    function creatorFeeExpired(address creator) public view returns (bool) {
        return creatorFees[creator] > 0 && block.timestamp > creatorFeeSince[creator] + CLAIM_WINDOW;
    }

    /// @notice Deadline for the creator's current pot (0 if pot is empty).
    function creatorFeeDeadline(address creator) external view returns (uint256) {
        if (creatorFees[creator] == 0) return 0;
        return creatorFeeSince[creator] + CLAIM_WINDOW;
    }

    function claimCreatorFees() external nonReentrant {
        uint256 amount = creatorFees[msg.sender];
        require(amount > 0, "nothing");
        creatorFees[msg.sender] = 0;
        if (block.timestamp > creatorFeeSince[msg.sender] + CLAIM_WINDOW) {
            // window missed: pot rolls into platform fees instead of paying out
            _creditPlatform(amount);
            emit CreatorFeesExpired(msg.sender, amount);
            return;
        }
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send");
        emit FeesClaimed(msg.sender, amount);
    }

    /// @notice Anyone may roll an expired creator pot into platform fees.
    function sweepExpired(address creator) external nonReentrant {
        require(creatorFeeExpired(creator), "not expired");
        uint256 amount = creatorFees[creator];
        creatorFees[creator] = 0;
        _creditPlatform(amount);
        emit CreatorFeesExpired(creator, amount);
    }

    /// @notice Withdraw your own share of the platform fees. An owner can send it wherever they
    ///         like, but can only ever send their own: there is no path from one owner's balance
    ///         to another's, and none from an owner to the curve reserves.
    function withdrawPlatformFees(address to) external nonReentrant onlyOwner {
        uint256 amount = ownerFees[msg.sender];
        require(amount > 0, "nothing");
        ownerFees[msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send");
        emit FeesClaimed(to, amount);
    }

    // ---------------------------------------------------------------- comments

    uint256 public constant MAX_COMMENT_BYTES = 280;

    /// @notice Post a public comment on a token's thread. Event-only — nothing is stored,
    ///         so a comment costs little more than base gas. Spam guard: you must hold the
    ///         token, be its creator, or be the platform admin.
    function comment(address token, string calldata text) external {
        TokenInfo storage t = info[token];
        require(t.creator != address(0), "unknown token");
        uint256 len = bytes(text).length;
        require(len > 0 && len <= MAX_COMMENT_BYTES, "length");
        require(
            ANewOneToken(token).balanceOf(msg.sender) > 0 || msg.sender == t.creator || msg.sender == admin,
            "hold to comment"
        );
        emit Comment(token, msg.sender, text);
    }

    // ---------------------------------------------------------------- owners

    /// @notice Give a wallet a share of the platform fees. Admin only. The owner it creates can
    ///         withdraw its own share and do nothing else.
    function addOwner(address newOwner) external onlyAdmin {
        require(newOwner != address(0), "zero addr");
        require(!isOwner[newOwner], "already owner");
        _addOwner(newOwner);
    }

    /// @notice Revoke an owner. Admin only. The last remaining owner cannot be removed.
    function removeOwner(address who) external onlyAdmin {
        require(isOwner[who], "not owner");
        require(owners.length > 1, "last owner");
        // Removal must not orphan money. A departing owner's balance is theirs and nobody else
        // can move it, so it has to be withdrawn before the owner set shrinks, or it would sit
        // in the contract outside every accounting view.
        require(ownerFees[who] == 0, "claim fees first");
        isOwner[who] = false;
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == who) {
                owners[i] = owners[owners.length - 1];
                owners.pop();
                break;
            }
        }
        emit OwnerRemoved(who);
    }

    function _addOwner(address newOwner) internal {
        isOwner[newOwner] = true;
        owners.push(newOwner);
        emit OwnerAdded(newOwner);
    }

    function ownersCount() external view returns (uint256) {
        return owners.length;
    }

    // ---------------------------------------------------------------- views

    function tokensCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Price in USDC-wei per whole token (1e18 units), scaled by 1e18.
    function priceWad(address token) external view returns (uint256) {
        return _priceWad(info[token]);
    }

    function quoteBuy(address token, uint256 usdcIn) external view returns (uint256 tokensOut) {
        TokenInfo storage t = info[token];
        // a quote for a curve that no longer trades would be a price nobody can get
        require(_curveOpen(token, t), "graduated");
        uint256 usdcAfterFee = usdcIn - (usdcIn * FEE_BPS) / 10_000;
        uint256 k = t.vUsdc * t.tReserve;
        tokensOut = t.tReserve - _ceilDiv(k, t.vUsdc + usdcAfterFee);
    }

    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 usdcOut) {
        TokenInfo storage t = info[token];
        require(_curveOpen(token, t), "graduated");
        uint256 k = t.vUsdc * t.tReserve;
        uint256 gross = t.vUsdc - _ceilDiv(k, t.tReserve + tokenAmount);
        if (gross > t.raised) gross = t.raised;
        usdcOut = gross - (gross * FEE_BPS) / 10_000;
    }

    /// @notice Bonding-curve progress toward graduation, in basis points (10000 = graduated).
    function progressBps(address token) external view returns (uint256) {
        TokenInfo storage t = info[token];
        if (t.graduated) return 10_000;
        return (t.raised * 10_000) / gradTarget;
    }

    /// @dev A curve trades until it graduates. On a platform built with Uniswap v3 it then closes:
    ///      its reserve waits for migrate(), and trading resumes in the pool. An owner may put it
    ///      back on the curve after REOPEN_DELAY if the move cannot happen, until it does. Without
    ///      Uniswap there is nowhere to move to, so graduation stays a badge.
    function _curveOpen(address token, TokenInfo storage t) internal view returns (bool) {
        if (!t.graduated || address(v3Factory) == address(0)) return true;
        return curveReopened[token] && !migrated[token];
    }

    function _priceWad(TokenInfo storage t) internal view returns (uint256) {
        return (t.vUsdc * 1e18) / t.tReserve;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    /// @dev Closed. Uniswap v3 moves USDC through its ERC-20 face, which changes this
    ///      contract's balance without calling it, so nothing legitimate ever lands here.
    receive() external payable {
        revert("use buy()");
    }
}
