// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WallSwap {
    address public admin;
    IERC20 public usdc;
    IERC20 public eurc;

    uint256 public constant USDC_ID = 1;
    uint256 public constant EURC_ID = 2;

    uint256 public rate; // price of 1 EURC in USDC, scaled by 1e7 (e.g. 10800000 = 1.08 USDC/EURC)

    event Swapped(address indexed user, uint256 fromAssetId, uint256 toAssetId);

    constructor(address _usdc, address _eurc, uint256 _rate) {
        admin = msg.sender;
        usdc = IERC20(_usdc);
        eurc = IERC20(_eurc);
        rate = _rate;
    }

    function setRate(uint256 _rate) external {
        require(msg.sender == admin);
        rate = _rate;
    }

    function getRate() external view returns (uint256) {
        return rate;
    }

    function swap(
        externalEuint256 inputHandle,
        bytes calldata inputProof,
        externalEuint256 outputHandle,
        bytes calldata outputProof,
        uint256 fromAssetId,
        uint256 toAssetId
    ) external {
        require(fromAssetId != toAssetId, "same asset");
        require(
            (fromAssetId == USDC_ID && toAssetId == EURC_ID) ||
            (fromAssetId == EURC_ID && toAssetId == USDC_ID),
            "invalid pair"
        );

        euint256 inputAmount = Nox.fromExternal(inputHandle, inputProof);
        euint256 outputAmount = Nox.fromExternal(outputHandle, outputProof);

        if (fromAssetId == USDC_ID) {
            usdc.transferFrom(msg.sender, address(this), 0);
        } else {
            eurc.transferFrom(msg.sender, address(this), 0);
        }

        if (toAssetId == USDC_ID) {
            usdc.transfer(msg.sender, 0);
        } else {
            eurc.transfer(msg.sender, 0);
        }

        emit Swapped(msg.sender, fromAssetId, toAssetId);
    }
}
