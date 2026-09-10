// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

/// @notice Deploys Uniswap v3 (factory, position manager, swap router) from the exact bytecode
///         Uniswap published to npm: test/fixtures/uniswap-v3, provenance in PROVENANCE.md.
/// @dev For rehearsals only, on chains Uniswap has not deployed to: Arc testnet, a local anvil.
///      On Arc mainnet the platform points at Uniswap's own deployment instead. Arc has no
///      wrapped native token, so the periphery's WETH9 is an address with no code behind it and
///      its WETH branches never run.
/// Env: PRIVATE_KEY.
contract DeployUniswapV3 is Script {
    address internal constant NO_WETH = address(uint160(0x5EE0));

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        address factory = _deploy("UniswapV3Factory.json", "");
        address nfpm = _deploy("NonfungiblePositionManager.json", abi.encode(factory, NO_WETH, address(0)));
        address router = _deploy("SwapRouter.json", abi.encode(factory, NO_WETH));
        vm.stopBroadcast();
        console.log("DEX_FACTORY:", factory);
        console.log("DEX_POSITION_MANAGER:", nfpm);
        console.log("DEX_SWAP_ROUTER:", router);
    }

    function _deploy(string memory name, bytes memory args) internal returns (address a) {
        bytes memory code = abi.encodePacked(
            vm.parseJsonBytes(vm.readFile(string.concat("test/fixtures/uniswap-v3/", name)), ".bytecode"), args
        );
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0), string.concat("deploy failed: ", name));
    }
}
