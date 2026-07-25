// Wall — ETH Sepolia adapter. Handles MetaMask connection, Nox encryption,
// and ethers.js chain interactions for the confidential pool.
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";

const SEPOLIA_CHAIN_ID = 11155111;
const EXPLORER = "https://sepolia.etherscan.io/tx/";

// ---------- MetaMask connection ----------
export async function connectMetaMask() {
  if (!window.ethereum) throw new Error("MetaMask not installed");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(SEPOLIA_CHAIN_ID)) {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${SEPOLIA_CHAIN_ID.toString(16)}` }],
    });
  }
  return { provider, signer, address };
}

// ---------- Nox handle client ----------
let noxClient = null;
export async function initNox(signer) {
  noxClient = await createEthersHandleClient(signer);
  return noxClient;
}
export async function encryptAmount(value) {
  if (!noxClient) throw new Error("Nox not initialized");
  return await noxClient.encryptInput(value);
}
export async function decryptHandle(handle) {
  if (!noxClient) throw new Error("Nox not initialized");
  return await noxClient.decrypt(handle);
}

// ---------- ERC-20 helpers ----------
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export async function getERC20Balance(address, tokenAddress, provider) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [balance, decimals] = await Promise.all([
    token.balanceOf(address),
    token.decimals(),
  ]);
  return { balance, decimals };
}

export async function approveERC20(tokenAddress, spender, amount, signer) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const tx = await token.approve(spender, amount);
  return await tx.wait();
}

// ---------- Pool contract interaction ----------
const POOL_ABI = [
  "function deposit(bytes,bytes,uint256) external",
  "function withdraw(bytes,bytes,uint256) external",
  "function transfer(address,bytes,bytes,uint256) external",
  "function getBalance(address) view returns (bytes32)",
  "function getTotalSupply() view returns (bytes32)",
  "function usdc() view returns (address)",
  "function eurc() view returns (address)",
  "function addViewer(address) external",
  "event Deposited(address indexed,uint256,uint256)",
  "event Withdrawn(address indexed,uint256,uint256)",
  "event Transferred(address indexed,address indexed,uint256,uint256)",
];

export async function depositToPool(poolAddress, handle, proof, assetId, signer) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);
  const tx = await pool.deposit(handle, proof, assetId);
  return await tx.wait();
}

export async function withdrawFromPool(poolAddress, handle, proof, assetId, signer) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);
  const tx = await pool.withdraw(handle, proof, assetId);
  return await tx.wait();
}

export async function transferInPool(poolAddress, to, handle, proof, assetId, signer) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);
  const tx = await pool.transfer(to, handle, proof, assetId);
  return await tx.wait();
}

// ---------- Event scanning ----------
export async function scanPoolEvents(poolAddress, provider, fromBlock, toBlock) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [deposits, withdrawals, transfers] = await Promise.all [
    pool.queryFilter(pool.filters.Deposited(), fromBlock, toBlock),
    pool.queryFilter(pool.filters.Withdrawn(), fromBlock, toBlock),
    pool.queryFilter(pool.filters.Transferred(), fromBlock, toBlock),
  ];
  return { deposits, withdrawals, transfers };
}

// ---------- Relayer submission ----------
export async function submitViaRelayer(apiBase, action, data) {
  const url = `${apiBase}/api/submit`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  return await res.json();
}

export { EXPLORER, SEPOLIA_CHAIN_ID };
