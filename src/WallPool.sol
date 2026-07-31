// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WallPool {
    euint256 public totalSupply;
    address public admin;
    address public auditor;

    mapping(address => mapping(uint256 => euint256)) public balances;
    mapping(address => mapping(uint256 => bool)) public hasDeposited;

    IERC20 public usdc;
    IERC20 public eurc;

    uint256 public constant USDC_ID = 1;
    uint256 public constant EURC_ID = 2;

    event Deposited(address indexed user, uint256 assetId, uint256 amount);
    event Withdrawn(address indexed user, uint256 assetId, uint256 amount);
    event Transferred(address indexed from, address indexed to, uint256 assetId, uint256 amount);

    constructor(address _usdc, address _eurc, address _auditor) {
        admin = msg.sender;
        auditor = _auditor;
        usdc = IERC20(_usdc);
        eurc = IERC20(_eurc);
    }

    function deposit(
        externalEuint256 inputHandle,
        bytes calldata inputProof,
        uint256 assetId
    ) external {
        euint256 amount = Nox.fromExternal(inputHandle, inputProof);

        if (assetId == USDC_ID) {
            usdc.transferFrom(msg.sender, address(this), 0);
        } else if (assetId == EURC_ID) {
            eurc.transferFrom(msg.sender, address(this), 0);
        }

        if (!hasDeposited[msg.sender][assetId]) {
            balances[msg.sender][assetId] = amount;
            hasDeposited[msg.sender][assetId] = true;
        } else {
            balances[msg.sender][assetId] = Nox.add(balances[msg.sender][assetId], amount);
        }

        Nox.allowThis(balances[msg.sender][assetId]);
        Nox.allow(balances[msg.sender][assetId], msg.sender);
        Nox.allow(balances[msg.sender][assetId], auditor);

        emit Deposited(msg.sender, assetId, 0);
    }

    function withdraw(
        externalEuint256 inputHandle,
        bytes calldata inputProof,
        uint256 assetId
    ) external {
        euint256 amount = Nox.fromExternal(inputHandle, inputProof);

        balances[msg.sender][assetId] = Nox.sub(balances[msg.sender][assetId], amount);

        if (assetId == USDC_ID) {
            usdc.transfer(msg.sender, 0);
        } else if (assetId == EURC_ID) {
            eurc.transfer(msg.sender, 0);
        }

        Nox.allowThis(balances[msg.sender][assetId]);
        Nox.allow(balances[msg.sender][assetId], msg.sender);
        Nox.allow(balances[msg.sender][assetId], auditor);

        emit Withdrawn(msg.sender, assetId, 0);
    }

    function transfer(
        address to,
        externalEuint256 inputHandle,
        bytes calldata inputProof,
        uint256 assetId
    ) external {
        euint256 amount = Nox.fromExternal(inputHandle, inputProof);

        balances[msg.sender][assetId] = Nox.sub(balances[msg.sender][assetId], amount);

        if (!hasDeposited[to][assetId]) {
            balances[to][assetId] = amount;
            hasDeposited[to][assetId] = true;
        } else {
            balances[to][assetId] = Nox.add(balances[to][assetId], amount);
        }

        Nox.allowThis(balances[msg.sender][assetId]);
        Nox.allow(balances[msg.sender][assetId], msg.sender);
        Nox.allow(balances[msg.sender][assetId], auditor);
        Nox.allowThis(balances[to][assetId]);
        Nox.allow(balances[to][assetId], to);
        Nox.allow(balances[to][assetId], auditor);

        emit Transferred(msg.sender, to, assetId, 0);
    }

    function getBalance(address user, uint256 assetId) external view returns (euint256) {
        return balances[user][assetId];
    }

    function addViewer(address viewer, uint256 assetId) external {
        require(msg.sender == admin || msg.sender == auditor);
        Nox.allow(balances[msg.sender][assetId], viewer);
    }
}
