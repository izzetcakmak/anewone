// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

/// @title ANewOne — meme token launchpad with a bonding curve, native-USDC denominated (Arc L1).
/// @notice pump.fun-style constant-product curve with quality upgrades:
///         - creator earns half of every trade fee (0.5% of 1%)
///         - anti-snipe: per-wallet cap during the first blocks after launch
///         - rug-proof: curve reserves can never be withdrawn, only traded against;
///           fees are segregated from reserves.
contract ANewOne {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18; // 1B tokens per launch
    uint16 public constant FEE_BPS = 100; // 1% total trade fee
    uint16 public constant CREATOR_FEE_BPS = 50; // 0.5% of trade goes to token creator
    uint256 public constant ANTI_SNIPE_BLOCKS = 20;
    uint256 public constant ANTI_SNIPE_MAX = TOTAL_SUPPLY / 50; // 2% per wallet early on

    /// @notice Virtual USDC seeded into every curve (sets the starting price).
    uint256 public immutable virtualUsdc0;
    /// @notice Real USDC raised at which a token "graduates" (badge + event; trading continues).
    uint256 public immutable gradTarget;

    address public owner;
    uint256 public platformFees;
    mapping(address => uint256) public creatorFees;

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

    uint256 private unlocked = 1;

    event TokenCreated(
        address indexed token, address indexed creator, string name, string symbol, string metadataURI
    );
    event Trade(
        address indexed token,
        address indexed trader,
        bool indexed isBuy,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 newPriceWad
    );
    event Graduated(address indexed token, uint256 raised);
    event FeesClaimed(address indexed who, uint256 amount);

    modifier nonReentrant() {
        require(unlocked == 1, "reentrancy");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(uint256 virtualUsdc0_, uint256 gradTarget_) {
        require(virtualUsdc0_ > 0 && gradTarget_ > 0, "params");
        owner = msg.sender;
        virtualUsdc0 = virtualUsdc0_;
        gradTarget = gradTarget_;
    }

    // ---------------------------------------------------------------- launch

    /// @notice Launch a new meme token. Free (gas only). Send value to make an initial dev buy.
    function createToken(string calldata name_, string calldata symbol_, string calldata metadataURI_)
        external
        payable
        nonReentrant
        returns (address token)
    {
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
            emit Graduated(token, t.raised);
        }

        require(ANewOneToken(token).transfer(to, tokensOut), "transfer");
        emit Trade(token, to, true, value, tokensOut, _priceWad(t));
    }

    function sell(address token, uint256 tokenAmount, uint256 minUsdcOut) external nonReentrant {
        TokenInfo storage t = info[token];
        require(t.creator != address(0), "unknown token");
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

    // ---------------------------------------------------------------- fees

    function _splitFee(address creator, uint256 fee) internal {
        uint256 creatorCut = (fee * CREATOR_FEE_BPS) / FEE_BPS;
        creatorFees[creator] += creatorCut;
        platformFees += fee - creatorCut;
    }

    function claimCreatorFees() external nonReentrant {
        uint256 amount = creatorFees[msg.sender];
        require(amount > 0, "nothing");
        creatorFees[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send");
        emit FeesClaimed(msg.sender, amount);
    }

    function withdrawPlatformFees(address to) external nonReentrant {
        require(msg.sender == owner, "owner");
        uint256 amount = platformFees;
        require(amount > 0, "nothing");
        platformFees = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send");
        emit FeesClaimed(to, amount);
    }

    function setOwner(address newOwner) external {
        require(msg.sender == owner, "owner");
        owner = newOwner;
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
        uint256 usdcAfterFee = usdcIn - (usdcIn * FEE_BPS) / 10_000;
        uint256 k = t.vUsdc * t.tReserve;
        tokensOut = t.tReserve - _ceilDiv(k, t.vUsdc + usdcAfterFee);
    }

    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 usdcOut) {
        TokenInfo storage t = info[token];
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

    function _priceWad(TokenInfo storage t) internal view returns (uint256) {
        return (t.vUsdc * 1e18) / t.tReserve;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    receive() external payable {
        revert("use buy()");
    }
}
