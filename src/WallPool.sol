// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WallPool {
    euint256 public totalSupply;
    address public admin;
    address public auditor;

    mapping(address => euint256) public balances;
    mapping(address => bool) public hasDeposited;

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

        if (!hasDeposited[msg.sender]) {
            balances[msg.sender] = amount;
            hasDeposited[msg.sender] = true;
        } else {
            balances[msg.sender] = Nox.add(balances[msg.sender], amount);
        }

        Nox.allowThis(balances[msg.sender]);
        Nox.allow(balances[msg.sender], msg.sender);
        Nox.allow(balances[msg.sender], auditor);

        emit Deposited(msg.sender, assetId, 0);
    }

    function withdraw(
        externalEuint256 inputHandle,
        bytes calldata inputProof,
        uint256 assetId
    ) external {
        euint256 amount = Nox.fromExternal(inputHandle, inputProof);

        balances[msg.sender] = Nox.sub(balances[msg.sender], amount);

        if (assetId == USDC_ID) {
            usdc.transfer(msg.sender, 0);
        } else if (assetId == EURC_ID) {
            eurc.transfer(msg.sender, 0);
        }

        Nox.allowThis(balances[msg.sender]);
        Nox.allow(balances[msg.sender], msg.sender);
        Nox.allow(balances[msg.sender], auditor);

        emit Withdrawn(msg.sender, assetId, 0);
    }

    function transfer(
        address to,
        externalEuint256 inputHandle,
        bytes calldata inputProof,
        uint256 assetId
    ) external {
        euint256 amount = Nox.fromExternal(inputHandle, inputProof);

        balances[msg.sender] = Nox.sub(balances[msg.sender], amount);

        if (!hasDeposited[to]) {
            balances[to] = amount;
            hasDeposited[to] = true;
        } else {
            balances[to] = Nox.add(balances[to], amount);
        }

        Nox.allowThis(balances[msg.sender]);
        Nox.allow(balances[msg.sender], msg.sender);
        Nox.allow(balances[msg.sender], auditor);
        Nox.allowThis(balances[to]);
        Nox.allow(balances[to], to);
        Nox.allow(balances[to], auditor);

        emit Transferred(msg.sender, to, assetId, 0);
    }

    function getBalance(address user) external view returns (euint256) {
        return balances[user];
    }

    function addViewer(address viewer) external {
        require(msg.sender == admin || msg.sender == auditor);
        Nox.addViewer(balances[msg.sender], viewer);
    }
}
