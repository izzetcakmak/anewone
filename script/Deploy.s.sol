// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ANewOne} from "../src/ANewOne.sol";

/// @notice Deploys the ANewOne platform and launches $NOAH, the first token on it.
/// Env: PRIVATE_KEY, optional VIRTUAL_USDC0 (default 4000e18), GRAD_TARGET (default 5000e18),
///      SKIP_FIRST_TOKEN=1 to deploy platform only.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 v0 = vm.envOr("VIRTUAL_USDC0", uint256(4_000e18));
        uint256 grad = vm.envOr("GRAD_TARGET", uint256(5_000e18));
        bool skipFirst = vm.envOr("SKIP_FIRST_TOKEN", uint256(0)) == 1;

        vm.startBroadcast(pk);
        ANewOne arcade = new ANewOne(v0, grad);
        console.log("ANEWONE_PLATFORM:", address(arcade));

        if (!skipFirst) {
            address noah = arcade.createToken(
                "Noah's Arc",
                "NOAH",
                "https://anewone.xyz/meta/noah.json"
            );
            console.log("NOAH_TOKEN:", noah);
        }
        vm.stopBroadcast();
    }
}
