// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import "forge-std/Script.sol";
import "../src/WallPool.sol";
import "../src/WallMarket.sol";
import "../src/mocks/MockTokens.sol";

contract DeployWall is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        MockUSDC usdc = new MockUSDC();
        MockEURC eurc = new MockEURC();
        address auditor = vm.envAddress("AUDITOR_ADDRESS");

        WallPool pool = new WallPool(
            address(usdc),
            address(eurc),
            auditor
        );

        WallMarket market = new WallMarket(
            address(usdc),
            address(eurc),
            msg.sender,
            auditor
        );

        vm.stopBroadcast();

        console.log("USDC:", address(usdc));
        console.log("EURC:", address(eurc));
        console.log("Pool:", address(pool));
        console.log("Market:", address(market));
    }
}
