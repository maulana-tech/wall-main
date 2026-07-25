const { ethers } = require("ethers");

const POOL_ABI = [
  "function deposit(bytes inputHandle, bytes inputProof, uint256 assetId) external",
  "function withdraw(bytes inputHandle, bytes inputProof, uint256 assetId) external",
  "function transfer(address to, bytes inputHandle, bytes inputProof, uint256 assetId) external",
  "function getBalance(address user) external view returns (bytes32)",
  "function getTotalSupply() external view returns (bytes32)",
  "function admin() external view returns (address)",
  "function auditor() external view returns (address)",
  "function usdc() external view returns (address)",
  "function eurc() external view returns (address)",
  "function addViewer(address viewer) external",
  "event Deposited(address indexed user, uint256 assetId, uint256 amount)",
  "event Withdrawn(address indexed user, uint256 assetId, uint256 amount)",
  "event Transferred(address indexed from, address indexed to, uint256 assetId, uint256 amount)",
];

const MARKET_ABI = [
  "function openPosition(uint256 assetId) external returns (uint256)",
  "function supply(uint256 positionId, bytes inputHandle, bytes inputProof) external",
  "function borrow(uint256 positionId, bytes inputHandle, bytes inputProof) external",
  "function repay(uint256 positionId, bytes inputHandle, bytes inputProof) external",
  "function liquidate(uint256 positionId, bytes inputHandle, bytes inputProof) external",
  "function getPosition(uint256 positionId) external view returns (bytes32, bytes32, address, uint256, uint256)",
  "function nextPositionId() external view returns (uint256)",
  "event PositionOpened(uint256 indexed positionId, address indexed owner)",
  "event Supplied(uint256 indexed positionId, uint256 amount)",
  "event Borrowed(uint256 indexed positionId, uint256 amount)",
  "event Repaid(uint256 indexed positionId, uint256 amount)",
  "event Liquidated(uint256 indexed positionId, address indexed liquidator)",
];

class WallPool {
  constructor(address, signerOrProvider) {
    this.contract = new ethers.Contract(address, POOL_ABI, signerOrProvider);
  }

  async deposit(handle, proof, assetId) {
    return await this.contract.deposit(handle, proof, assetId);
  }

  async withdraw(handle, proof, assetId) {
    return await this.contract.withdraw(handle, proof, assetId);
  }

  async transfer(to, handle, proof, assetId) {
    return await this.contract.transfer(to, handle, proof, assetId);
  }

  async getBalance(user) {
    return await this.contract.getBalance(user);
  }

  async getTotalSupply() {
    return await this.contract.getTotalSupply();
  }

  async addViewer(viewer) {
    return await this.contract.addViewer(viewer);
  }

  async queryDepositEvents(fromBlock, toBlock) {
    const filter = this.contract.filters.Deposited();
    return await this.contract.queryFilter(filter, fromBlock, toBlock);
  }

  async queryWithdrawEvents(fromBlock, toBlock) {
    const filter = this.contract.filters.Withdrawn();
    return await this.contract.queryFilter(filter, fromBlock, toBlock);
  }

  async queryTransferEvents(fromBlock, toBlock) {
    const filter = this.contract.filters.Transferred();
    return await this.contract.queryFilter(filter, fromBlock, toBlock);
  }
}

class WallMarket {
  constructor(address, signerOrProvider) {
    this.contract = new ethers.Contract(address, MARKET_ABI, signerOrProvider);
  }

  async openPosition(assetId) {
    return await this.contract.openPosition(assetId);
  }

  async supply(positionId, handle, proof) {
    return await this.contract.supply(positionId, handle, proof);
  }

  async borrow(positionId, handle, proof) {
    return await this.contract.borrow(positionId, handle, proof);
  }

  async repay(positionId, handle, proof) {
    return await this.contract.repay(positionId, handle, proof);
  }

  async liquidate(positionId, handle, proof) {
    return await this.contract.liquidate(positionId, handle, proof);
  }

  async getPosition(positionId) {
    return await this.contract.getPosition(positionId);
  }

  async queryPositionOpenedEvents(fromBlock, toBlock) {
    const filter = this.contract.filters.PositionOpened();
    return await this.contract.queryFilter(filter, fromBlock, toBlock);
  }
}

module.exports = {
  WallPool,
  WallMarket,
  POOL_ABI,
  MARKET_ABI,
};
