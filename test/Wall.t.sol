// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import "forge-std/Test.sol";
import "../src/mocks/MockTokens.sol";

contract WallConstantsTest is Test {
    MockUSDC usdc;
    MockEURC eurc;
    address admin = address(0x1);

    function setUp() public {
        vm.prank(admin);
        usdc = new MockUSDC();
        vm.prank(admin);
        eurc = new MockEURC();
    }

    function testMockUSDC() public view {
        assertEq(usdc.name(), "USD Coin");
        assertEq(usdc.symbol(), "USDC");
        assertEq(usdc.decimals(), 7);
    }

    function testMockEURC() public view {
        assertEq(eurc.name(), "Euro Coin");
        assertEq(eurc.symbol(), "EURC");
        assertEq(eurc.decimals(), 7);
    }

    function testMockMint() public {
        usdc.mint(admin, 1000e7);
        assertEq(usdc.balanceOf(admin), 1000e7);
    }
}

// NOTE: WallPool and WallMarket require the Nox TEE infrastructure
// to operate. Full integration tests must run on Sepolia where the
// Nox compute contract is deployed. See scripts/deploy.js for the
// Sepolia deployment flow.
