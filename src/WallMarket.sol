// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WallMarket {
    address public admin;
    address public oracle;
    address public auditor;

    IERC20 public usdc;
    IERC20 public eurc;

    struct Position {
        euint256 collateral;
        euint256 debt;
        address owner;
        uint256 assetId;
        uint256 healthFactor;
    }

    mapping(uint256 => Position) public positions;
    uint256 public nextPositionId;

    uint256 public constant LTV = 80;
    uint256 public constant LIQUIDATION_THRESHOLD = 85;
    uint256 public constant CLOSE_FACTOR = 50;
    uint256 public constant LIQUIDATION_BONUS = 5;

    event PositionOpened(uint256 indexed positionId, address indexed owner);
    event Supplied(uint256 indexed positionId, uint256 amount);
    event Borrowed(uint256 indexed positionId, uint256 amount);
    event Repaid(uint256 indexed positionId, uint256 amount);
    event Liquidated(uint256 indexed positionId, address indexed liquidator);

    constructor(address _usdc, address _eurc, address _oracle, address _auditor) {
        admin = msg.sender;
        oracle = _oracle;
        auditor = _auditor;
        usdc = IERC20(_usdc);
        eurc = IERC20(_eurc);
        nextPositionId = 1;
    }

    function openPosition(uint256 assetId) external returns (uint256) {
        uint256 positionId = nextPositionId++;

        positions[positionId] = Position({
            collateral: euint256.wrap(bytes32(0)),
            debt: euint256.wrap(bytes32(0)),
            owner: msg.sender,
            assetId: assetId,
            healthFactor: 100
        });

        emit PositionOpened(positionId, msg.sender);
        return positionId;
    }

    function supply(
        uint256 positionId,
        externalEuint256 inputHandle,
        bytes calldata inputProof
    ) external {
        require(positions[positionId].owner == msg.sender);
        euint256 amount = Nox.fromExternal(inputHandle, inputProof);

        if (!Nox.isInitialized(positions[positionId].collateral)) {
            positions[positionId].collateral = amount;
        } else {
            positions[positionId].collateral = Nox.add(
                positions[positionId].collateral,
                amount
            );
        }

        if (positions[positionId].assetId == 1) {
            usdc.transferFrom(msg.sender, address(this), 0);
        } else {
            eurc.transferFrom(msg.sender, address(this), 0);
        }

        Nox.allowThis(positions[positionId].collateral);
        Nox.allow(positions[positionId].collateral, msg.sender);
        Nox.allow(positions[positionId].collateral, auditor);

        emit Supplied(positionId, 0);
    }

    function borrow(
        uint256 positionId,
        externalEuint256 inputHandle,
        bytes calldata inputProof
    ) external {
        require(positions[positionId].owner == msg.sender);
        euint256 amount = Nox.fromExternal(inputHandle, inputProof);

        if (!Nox.isInitialized(positions[positionId].debt)) {
            positions[positionId].debt = amount;
        } else {
            positions[positionId].debt = Nox.add(
                positions[positionId].debt,
                amount
            );
        }

        if (positions[positionId].assetId == 1) {
            usdc.transfer(msg.sender, 0);
        } else {
            eurc.transfer(msg.sender, 0);
        }

        Nox.allowThis(positions[positionId].debt);
        Nox.allow(positions[positionId].debt, msg.sender);
        Nox.allow(positions[positionId].debt, auditor);

        emit Borrowed(positionId, 0);
    }

    function repay(
        uint256 positionId,
        externalEuint256 inputHandle,
        bytes calldata inputProof
    ) external {
        require(positions[positionId].owner == msg.sender);
        euint256 amount = Nox.fromExternal(inputHandle, inputProof);

        positions[positionId].debt = Nox.sub(
            positions[positionId].debt,
            amount
        );

        if (positions[positionId].assetId == 1) {
            usdc.transferFrom(msg.sender, address(this), 0);
        } else {
            eurc.transferFrom(msg.sender, address(this), 0);
        }

        Nox.allowThis(positions[positionId].debt);
        Nox.allow(positions[positionId].debt, msg.sender);
        Nox.allow(positions[positionId].debt, auditor);

        emit Repaid(positionId, 0);
    }

    function liquidate(
        uint256 positionId,
        externalEuint256 inputHandle,
        bytes calldata inputProof
    ) external {
        require(msg.sender != positions[positionId].owner);
        euint256 amount = Nox.fromExternal(inputHandle, inputProof);

        positions[positionId].collateral = Nox.sub(
            positions[positionId].collateral,
            amount
        );

        positions[positionId].debt = Nox.sub(
            positions[positionId].debt,
            amount
        );

        if (positions[positionId].assetId == 1) {
            usdc.transfer(msg.sender, 0);
        } else {
            eurc.transfer(msg.sender, 0);
        }

        Nox.allowThis(positions[positionId].collateral);
        Nox.allow(positions[positionId].collateral, positions[positionId].owner);
        Nox.allowThis(positions[positionId].debt);
        Nox.allow(positions[positionId].debt, positions[positionId].owner);

        emit Liquidated(positionId, msg.sender);
    }

    function getPosition(uint256 positionId) external view returns (
        euint256 collateral,
        euint256 debt,
        address owner,
        uint256 assetId,
        uint256 healthFactor
    ) {
        Position storage p = positions[positionId];
        return (p.collateral, p.debt, p.owner, p.assetId, p.healthFactor);
    }
}
