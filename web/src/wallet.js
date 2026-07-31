import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import { state } from "./state.js";
import { ERC20_ABI } from "./constants.js";
import { say, render } from "./ui.js";
import { rescan } from "./actions.js";
import { histKey } from "./utils.js";

export async function initWallet() {
  if (!window.ethereum) throw new Error("MetaMask is required");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }]);
  } catch (e) {
    throw new Error("Please switch your MetaMask to the Sepolia network.");
  }
  
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  state.wallet = { address, signer, provider };
  state.noxClient = await createEthersHandleClient(provider);
  return state.wallet;
}

export async function encryptAmount(value, targetContract) {
  if (!state.noxClient) throw new Error("Wallet not initialized");
  if (!targetContract) throw new Error("Target contract required for encryption");
  const result = await state.noxClient.encryptInput(value, "uint256", targetContract);
  return { handle: result.handle, proof: result.handleProof };
}

export async function decryptHandle(handle) {
  if (!state.noxClient) throw new Error("Wallet not initialized");
  return await state.noxClient.decrypt(handle);
}

export async function erc20Balance(tokenAddress) {
  if (!state.wallet) return 0n;
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, state.wallet.provider);
  return await token.balanceOf(state.wallet.address);
}

export async function erc20Approve(tokenAddr, spender, amount) {
  const abi = ["function approve(address spender, uint256 amount) external returns (bool)"];
  const contract = new ethers.Contract(tokenAddr, abi, state.wallet.signer);
  const tx = await contract.approve(spender, amount);
  await tx.wait();
}

export async function loadWallet(opts = {}) {
  try {
    await initWallet();
    localStorage.setItem("wall-connected", "true");
  } catch (e) {
    const msg = e.message || String(e);
    say("wallet init failed: " + msg);
    alert("wallet init failed: " + msg);
    return false;
  }
  state.localHist = JSON.parse(localStorage.getItem(histKey()) || "[]");
  state.history = [...state.localHist];
  if (!opts.stayOnLanding) { state.view = "home"; state.sheet = null; state.tab = "portfolio"; }
  clearInterval(state.heartbeat);
  state.heartbeat = setInterval(() => { if (state.wallet && !state.proving) rescan(); }, 20000);
  render();
  if (!opts.stayOnLanding) rescan();
  return true;
}

export function disconnect() {
  clearInterval(state.heartbeat);
  localStorage.removeItem("wall-connected");
  state.wallet = null; state.noxClient = null; state.notes = []; state.view = "landing"; state.sheet = null;
  render(); window.scrollTo(0, 0);
}
