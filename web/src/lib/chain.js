import { ethers } from "ethers";
import { state } from "./state.js";

const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

export const EXPLORER = "https://sepolia.etherscan.io/tx";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

export const API_BASE = import.meta.env.VITE_API_BASE || "";

// ─── Wallet init ───
export function generatePrivateKey() {
  return ethers.hexlify(ethers.randomBytes(32));
}

export async function initWallet(privateKey) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const w = new ethers.Wallet(privateKey, provider);
  state.wallet = { privateKey, address: w.address, signer: w, provider };
  return state.wallet;
}

// ─── ERC-20 ───
export async function erc20Approve(tokenAddress, spender, amount) {
  if (!state.wallet) throw new Error("No wallet");
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, state.wallet.signer);
  const tx = await token.approve(spender, amount);
  return await tx.wait();
}

// ─── Relayer ───
export async function submitToRelayer(action, data) {
  const res = await fetch(`${API_BASE}/api/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "relayer rejected");
  return j.txHash;
}

export async function submitMarket(action, data) {
  const res = await fetch(`${API_BASE}/api/market`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "market rejected");
  return j.txHash;
}

// ─── Config ───
export async function fetchConfig() {
  try {
    state.CFG = await (await fetch(`${API_BASE}/api/config`)).json();
  } catch {
    state.CFG = { error: "Could not load config" };
  }
}

// ─── Prices ───
export async function fetchPrices(onUpdate) {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd");
    const j = await r.json();
    if (j?.["euro-coin"]?.usd) {
      state.prices.eurUsd = j["euro-coin"].usd;
      onUpdate?.();
    }
  } catch { /* keep fallback */ }
}

// ─── Faucet ───
export async function mintFaucet() {
  if (!state.wallet) throw new Error("No wallet");
  const res = await fetch(`${API_BASE}/api/faucet?to=${state.wallet.address}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
}

// ─── Event scanning ───
const POOL_EVENTS = [
  "event Deposited(address indexed user, uint256 assetId, uint256 amount)",
  "event Withdrawn(address indexed user, uint256 assetId, uint256 amount)",
  "event Transferred(address indexed from, address indexed to, uint256 assetId, uint256 amount)",
];

export async function fetchEvents() {
  if (!state.CFG?.pool || !state.wallet?.provider) return [];
  const pool = new ethers.Contract(state.CFG.pool, POOL_EVENTS, state.wallet.provider);
  const [deps, wds, trs] = await Promise.all([
    pool.queryFilter(pool.filters.Deposited()),
    pool.queryFilter(pool.filters.Withdrawn()),
    pool.queryFilter(pool.filters.Transferred()),
  ]);
  return [
    ...deps.map((e) => ({ ...e, type: "deposit" })),
    ...wds.map((e) => ({ ...e, type: "withdraw" })),
    ...trs.map((e) => ({ ...e, type: "transfer" })),
  ];
}

export { ethers };
