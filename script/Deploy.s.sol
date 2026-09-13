// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ANewOne, ANewOneToken} from "../src/ANewOne.sol";

/// @notice Deploys the ANewOne platform and launches $NOAH, the first token on it.
/// Env: PRIVATE_KEY, optional VIRTUAL_USDC0 (default 4000e18), GRAD_TARGET (default 5000e18),
///      SKIP_FIRST_TOKEN=1 to deploy platform only,
///      SECOND_OWNER=0x.. to grant a second owner at deploy time (shared platform-fee pool),
///      DEV_BUY_VALUE=<wei of native USDC> to make the dev buy inside the createToken tx
///      (same-tx buy: nothing can front-run it, and it stays under the anti-snipe cap).
///      Uniswap v3 for graduation: DEX_FACTORY, DEX_POSITION_MANAGER, USDC_ERC20. On Arc
///      mainnet (chain 5042) they default to Uniswap's official deployment and Arc's USDC; on
///      any other chain they default to zero, which builds a platform that can never migrate.
///      USDC is checked at deploy. Uniswap need not exist yet: it may reach Arc after the chain
///      opens, and $NOAH launches with the chain. Opening migrations checks it instead.
contract Deploy is Script {
    /// @dev The main wallet. The deployer becomes the platform's admin, the only wallet that can
    ///      change anything, so on Arc mainnet no other key may deploy it.
    address internal constant MAINNET_ADMIN = 0xD4F1254C803662c46D9c21f80F4F3c15FF57e2c9;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        bool skipFirst = vm.envOr("SKIP_FIRST_TOKEN", uint256(0)) == 1;
        address secondOwner = vm.envOr("SECOND_OWNER", address(0));
        uint256 devBuy = vm.envOr("DEV_BUY_VALUE", uint256(0));

        if (block.chainid == 5042) {
            require(vm.addr(pk) == MAINNET_ADMIN, "mainnet deploy must come from the main wallet");
        }

        vm.startBroadcast(pk);
        ANewOne arcade = _deployPlatform();

        if (secondOwner != address(0)) {
            arcade.addOwner(secondOwner);
            console.log("SECOND_OWNER:", secondOwner);
        }

        if (!skipFirst) {
            address noah = arcade.createToken{value: devBuy}(
                "Noah's Arc",
                "NOAH",
                "https://anewone.xyz/meta/noah.json",
                // createToken refuses a launch with no image. The art the metadata points
                // at, as a URL the site's image filter accepts (it rejects SVG data URIs).
                "https://anewone.xyz/meta/noah.svg"
            );
            console.log("NOAH_TOKEN:", noah);
            if (devBuy > 0) {
                console.log("DEV_BUY_VALUE:", devBuy);
                console.log("DEV_BUY_TOKENS:", ANewOneToken(noah).balanceOf(vm.addr(pk)));
            }
        }
        vm.stopBroadcast();
    }

    /// @dev Its own function rather than inline in run(): with the Uniswap addresses added,
    ///      run() held more locals than the legacy code generator can reach.
    function _deployPlatform() internal returns (ANewOne arcade) {
        // Uniswap's own Arc mainnet deployment (sdk-core ARC_ADDRESSES) and Arc's USDC
        // ERC-20 face. Only the mainnet chain id gets these as defaults.
        bool arcMainnet = block.chainid == 5042;
        address dexFactory =
            vm.envOr("DEX_FACTORY", arcMainnet ? 0xf0db7b58379503491d857dB50AC9ece64c653918 : address(0));
        address dexPositionManager =
            vm.envOr("DEX_POSITION_MANAGER", arcMainnet ? 0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377 : address(0));
        address usdcErc20 =
            vm.envOr("USDC_ERC20", arcMainnet ? 0x3600000000000000000000000000000000000000 : address(0));

        arcade = new ANewOne(
            vm.envOr("VIRTUAL_USDC0", uint256(4_000e18)),
            vm.envOr("GRAD_TARGET", uint256(5_000e18)),
            dexFactory,
            dexPositionManager,
            usdcErc20
        );
        console.log("ANEWONE_PLATFORM:", address(arcade));
        console.log("DEX_FACTORY:", dexFactory);
        console.log("DEX_POSITION_MANAGER:", dexPositionManager);
        console.log("USDC_ERC20:", usdcErc20);
    }
}
