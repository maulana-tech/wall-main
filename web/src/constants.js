export const EXPLORER = "https://sepolia.etherscan.io/tx";
export const API_BASE = import.meta.env.VITE_API_BASE || "";
export const IS_EXT = import.meta.env.VITE_EXT === "1";
export const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
export const SEPOLIA_CHAIN_ID = 11155111;
export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
export const POOL_ABI = [
  "function deposit(bytes32,bytes,uint256) external",
  "function withdraw(bytes32,bytes,uint256) external",
  "function transfer(address,bytes32,bytes,uint256) external",
  "function getBalance(address,uint256) external view returns (bytes32)"
];
export const MARKET_ABI = [
  "function positions(uint256) view returns (bytes32, bytes32, address, uint256, uint256)",
  "function nextPositionId() view returns (uint256)",
];
export const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";
