import os
import re

# We will read main.js to get original content, but it's easier to just construct the new files from what we know.
# Wait, I have the exact content of main.js in memory from view_file.

constants_js = """export const EXPLORER = "https://sepolia.etherscan.io/tx";
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
  "function transfer(address,bytes32,bytes,uint256) external"
];
export const MARKET_ABI = [
  "function positions(uint256) view returns (bytes32, bytes32, address, uint256, uint256)",
  "function nextPositionId() view returns (uint256)",
];
export const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";
"""

state_js = """export const state = {
  CFG: null,
  wallet: null,
  noxClient: null,
  notes: [],
  log: [],
  history: [],
  localHist: [],
  view: "landing",
  sheet: null,
  tab: "portfolio",
  lendTab: "lend",
  asset: 1,
  proving: false,
  heartbeat: 0,
  prices: { eurUsd: 1.08 },
  mktBusy: false,
  mktSheetData: null,
  mkt: {
    myPositions: [],
    loadedAt: 0,
    loading: false,
    err: null,
  },
  swapFrom: 1,
  swapTo: 2,
};
"""

utils_js = """import { state } from "./state.js";

export const $ = (s) => document.querySelector(s);
export const assetById = (id) => (state.CFG?.assets || []).find((a) => Number(a.id) === Number(id));
export const decOf = (id) => assetById(id)?.decimals ?? 7;
export const symOf = (id) => assetById(id)?.symbol || `#${id}`;

export function toRaw(human, d) {
  const s = String(human).trim();
  if (s === "" || s === "." || !/^\\d*\\.?\\d*$/.test(s)) throw new Error("enter a valid amount");
  const [int, frac = ""] = s.split(".");
  if (frac.length > d) throw new Error(`${symOf(state.asset)} allows at most ${d} decimals`);
  return BigInt((int || "0") + frac.padEnd(d, "0"));
}

export function toHuman(raw, d) {
  const s = BigInt(raw).toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d), frac = d ? s.slice(s.length - d).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}

export const short = (s, n = 5) => (s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || "");
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmtNum = (n, dp) => (isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: dp }) : "0");

export const balanceOf = (id) => state.notes.filter((n) => Number(n.assetId) === Number(id)).reduce((a, n) => a + n.amount, 0n);
export const humanBal = (id) => Number(toHuman(balanceOf(id), decOf(id)));
export const assetUsd = (id) => (/EUR/i.test(symOf(id)) ? state.prices.eurUsd : 1);
export const totalUsd = () => (state.CFG?.assets || []).reduce((s, a) => s + humanBal(a.id) * assetUsd(a.id), 0);

export const histKey = () => `wall-hist-${(state.wallet?.address || "anon").slice(0, 10)}`;

export function pushHistory(e) {
  state.localHist.unshift({ ...e, ts: Date.now() });
  localStorage.setItem(histKey(), JSON.stringify(state.localHist.slice(0, 50)));
  state.history = [...state.localHist];
}
"""

api_js = """import { API_BASE } from "./constants.js";
import { state } from "./state.js";
import { render } from "./ui.js";

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

export async function fetchPrices() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd");
    const j = await r.json();
    if (j?.["euro-coin"]?.usd) { state.prices.eurUsd = j["euro-coin"].usd; if (state.wallet) render(); }
  } catch { /* keep fallback */ }
}
"""

wallet_js = """import { ethers } from "ethers";
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
"""

actions_js = """import { ethers } from "ethers";
import { state } from "./state.js";
import { say, render, toast, swapPreview } from "./ui.js";
import { POOL_ABI, MARKET_ABI, API_BASE } from "./constants.js";
import { encryptAmount, erc20Approve } from "./wallet.js";
import { submitToRelayer, submitMarket } from "./api.js";
import { toRaw, decOf, toHuman, symOf, pushHistory } from "./utils.js";
import { $ } from "./utils.js";

export async function doDeposit(amount, assetId) {
  say("approving token transfer…");
  const tokenAddr = assetId === 1 ? state.CFG.usdc : state.CFG.eurc;
  await erc20Approve(tokenAddr, state.CFG.pool, amount);
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount, state.CFG.pool);
  say("submitting deposit via MetaMask…");
  const pool = new ethers.Contract(state.CFG.pool, POOL_ABI, state.wallet.signer);
  const tx = await pool.deposit(handle, ethers.hexlify(proof), assetId);
  await tx.wait();
  state.notes.push({ amount, assetId, txHash: tx.hash, ts: Date.now() });
  say("deposited into the wall");
}

export async function doWithdraw(amount, assetId) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount, state.CFG.pool);
  say("submitting withdrawal via MetaMask…");
  const pool = new ethers.Contract(state.CFG.pool, POOL_ABI, state.wallet.signer);
  const tx = await pool.withdraw(handle, ethers.hexlify(proof), assetId);
  await tx.wait();
  state.notes = state.notes.filter((n) => !(Number(n.assetId) === Number(assetId) && n.amount <= amount));
  say("withdrew from the wall");
}

export async function doTransfer(amount, assetId, toAddr) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount, state.CFG.pool);
  say("submitting transfer via MetaMask…");
  const pool = new ethers.Contract(state.CFG.pool, POOL_ABI, state.wallet.signer);
  const tx = await pool.transfer(toAddr, handle, ethers.hexlify(proof), assetId);
  await tx.wait();
  state.notes = state.notes.filter((n) => !(Number(n.assetId) === Number(assetId) && n.amount <= amount));
  say("sent successfully");
  return tx.hash;
}

export async function runSwap() {
  if (!state.wallet) return toast("Connect wallet first");
  const amtRaw = toRaw($("#swap-amt")?.value || "0", decOf(state.swapFrom));
  if (amtRaw <= 0n) return toast("Enter valid amount");
  
  const fromA = state.CFG.assets.find(a => a.id === state.swapFrom);
  const toA = state.CFG.assets.find(a => a.id === state.swapTo);
  if (!fromA || !toA) return toast("Invalid asset");
  const outRaw = swapPreview(amtRaw);
  
  const balanceOf = (id) => state.notes.filter((n) => Number(n.assetId) === Number(id)).reduce((a, n) => a + n.amount, 0n);
  if (balanceOf(state.swapFrom) < amtRaw) return toast("Insufficient private balance");
  
  state.proving = true; render();
  try {
    say("encrypting amounts via Nox…");
    const inputEnc = await encryptAmount(amtRaw, state.CFG.swap);
    const outputEnc = await encryptAmount(outRaw, state.CFG.swap);
    
    say("submitting swap via MetaMask…");
    const swapC = new ethers.Contract(state.CFG.swap, [
      "function swap(uint256,uint256,bytes32,bytes,bytes32,bytes) external"
    ], state.wallet.signer);
    
    const tx = await swapC.swap(
      state.swapFrom, state.swapTo,
      inputEnc.handle, ethers.hexlify(inputEnc.proof),
      outputEnc.handle, ethers.hexlify(outputEnc.proof)
    );
    await tx.wait();
    
    state.notes = state.notes.filter((n) => !(Number(n.assetId) === Number(state.swapFrom) && n.amount <= amtRaw));
    state.notes.push({ amount: outRaw, assetId: state.swapTo, txHash: tx.hash, ts: Date.now() });
    
    toast(`Swapped ${toHuman(amtRaw, decOf(state.swapFrom))} ${fromA.symbol} for ${toHuman(outRaw, decOf(state.swapTo))} ${toA.symbol}`);
    $("#swap-amt").value = "";
    $("#swap-preview").textContent = "0.0";
    rescan();
  } catch (e) {
    say("swap error: " + (e.message || String(e)));
  } finally {
    state.proving = false; render();
  }
}

export async function mintFaucet() {
  if (!state.wallet) return toast("Create or import a wallet first");
  try {
    const res = await fetch(`${API_BASE}/api/faucet?to=${state.wallet.address}`);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    toast("Minted 1000 USDC + 1000 EURC");
  } catch (e) { toast(e.message || "faucet failed"); }
}

export async function marketRefresh() {
  if (!state.CFG?.market || !state.wallet?.provider) return;
  state.mkt.loading = true; state.mkt.err = null;
  try {
    const market = new ethers.Contract(state.CFG.market, MARKET_ABI, state.wallet.provider);
    const nextId = Number(await market.nextPositionId());
    const myPos = [];
    for (let i = 1; i < nextId; i++) {
      try {
        const [collateral, debt, owner, assetId, healthFactor] = await market.positions(i);
        if (owner.toLowerCase() === state.wallet.address.toLowerCase()) {
          myPos.push({ positionId: i, collateral: BigInt(collateral), debt: BigInt(debt), owner, assetId: Number(assetId), healthFactor: Number(healthFactor) });
        }
      } catch { /* skip */ }
    }
    state.mkt.myPositions = myPos;
    state.mkt.loadedAt = Date.now();
  } catch (e) { state.mkt.err = e.message || String(e); }
  state.mkt.loading = false;
  if (state.view === "home" && state.tab === "lending") render();
}

export async function openMarketPosition(assetId) {
  if (state.mktBusy) return;
  state.mktBusy = true; state.proving = true; render();
  try {
    await submitMarket("openPosition", { assetId: String(assetId) });
    toast("Position opened");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false; state.proving = false; render();
}

export async function supplyToMarket() {
  const v = $("#mkt-amt") ? $("#mkt-amt").value : ($("#s-amt") ? $("#s-amt").value : "");
  if (!v || isNaN(v)) return;
  const amount = toRaw(v, decOf(state.mktSheetData.assetId));
  if (amount <= 0n) return;
  
  state.proving = true; render();
  try {
    say("approving token transfer…");
    const tokenAddr = state.mktSheetData.assetId === 1 ? state.CFG.usdc : state.CFG.eurc;
    await erc20Approve(tokenAddr, state.CFG.market, amount);
    say("encrypting amount via Nox…");
    const { handle, proof } = await encryptAmount(amount, state.CFG.market);
    say("submitting supply via MetaMask…");
    const mkt = new ethers.Contract(state.CFG.market, [
      "function supply(bytes32,bytes,uint256) external"
    ], state.wallet.signer);
    const tx = await mkt.supply(handle, ethers.hexlify(proof), state.mktSheetData.assetId);
    await tx.wait();
    
    toast("Supply successful");
    state.sheet = null; rescan();
  } catch (e) { say("supply error: " + (e.message || String(e))); }
  finally { state.proving = false; render(); }
}

export async function borrowFromMarket(positionId, amount) {
  if (state.mktBusy) return;
  state.mktBusy = true; state.proving = true; render();
  try {
    const { handle, proof } = await encryptAmount(amount, state.CFG.market);
    await submitMarket("borrow", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Borrowed from market");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false; state.proving = false; render();
}

export async function repayToMarket(positionId, amount, assetId) {
  if (state.mktBusy) return;
  state.mktBusy = true; state.proving = true; render();
  try {
    const { handle, proof } = await encryptAmount(amount, state.CFG.market);
    await submitMarket("repay", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
      assetId: String(assetId),
    });
    toast("Repaid to market");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false; state.proving = false; render();
}

export async function runDeposit(amt, assetId) {
  if (state.proving) return;
  state.proving = true; render();
  try {
    await doDeposit(amt, assetId);
    state.sheet = null;
    rescan();
  } catch (e) { say(e.message || String(e)); state.proving = false; render(); return; }
  state.proving = false; render();
}

export async function runAction(kind, args) {
  if (state.proving) return;
  state.proving = true; render();
  try {
    let hash;
    if (kind === "send") hash = await doTransfer(args.amt, args.assetId, args.addr);
    else if (kind === "withdraw") await doWithdraw(args.amt, args.assetId);
    pushHistory({ dir: kind, amount: args.amt.toString(), assetId: args.assetId, hash });
    state.sheet = null;
    rescan();
  } catch (e) { say(e.message || String(e)); state.proving = false; render(); return; }
  state.proving = false; render();
}

export async function fetchEvents() {
  if (!state.CFG?.pool || !state.wallet?.provider) return [];
  const pool = new ethers.Contract(state.CFG.pool, [
    "event Deposited(address indexed user, uint256 assetId, uint256 amount)",
    "event Withdrawn(address indexed user, uint256 assetId, uint256 amount)",
    "event Transferred(address indexed from, address indexed to, uint256 assetId, uint256 amount)",
  ], state.wallet.provider);
  const [deps, wds, trs] = await Promise.all([
    pool.queryFilter(pool.filters.Deposited()),
    pool.queryFilter(pool.filters.Withdrawn()),
    pool.queryFilter(pool.filters.Transferred()),
  ]);
  let swaps = [];
  if (state.CFG.swap) {
    try {
      const swapC = new ethers.Contract(state.CFG.swap, ["event Swapped(address indexed user, uint256 fromAssetId, uint256 toAssetId)"], state.wallet.provider);
      const sw = await swapC.queryFilter(swapC.filters.Swapped());
      swaps = sw.map((e) => ({ ...e, type: "swap" }));
    } catch { /* skip */ }
  }
  return [...deps.map((e) => ({ ...e, type: "deposit" })), ...wds.map((e) => ({ ...e, type: "withdraw" })), ...trs.map((e) => ({ ...e, type: "transfer" })), ...swaps];
}

export async function rescan() {
  if (!state.wallet) return;
  say("reading the horizon…");
  try {
    const events = await fetchEvents();
    state.history = [...events.map((e) => ({
      dir: e.type === "deposit" ? "deposit" : e.type === "withdraw" ? "withdraw" : "send",
      amount: (e.args?.amount || 0n).toString(),
      assetId: Number(e.args?.assetId || 1),
      ts: Date.now(),
      hash: e.transactionHash,
    })), ...state.localHist.filter((e) => !events.some((ev) => ev.transactionHash === e.hash))]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
    say(`${state.notes.length} note${state.notes.length === 1 ? "" : "s"} in shadow`);
  } catch (e) { say("couldn't reach the network"); }
  if (!state.proving) render();
}
"""

ui_js = """import { state } from "./state.js";
import { EXPLORER, SCRAMBLE_CHARS } from "./constants.js";
import { $, short, esc, fmtNum, humanBal, assetUsd, toHuman, decOf, toRaw, symOf, totalUsd, balanceOf } from "./utils.js";
import { loadWallet, disconnect } from "./wallet.js";
import { runDeposit, runAction, runSwap, marketRefresh, openMarketPosition, supplyToMarket, borrowFromMarket, repayToMarket } from "./actions.js";

export function say(m) {
  state.log.unshift(`${new Date().toLocaleTimeString().slice(0, 8)}  ${m}`);
  const el = $("#prove-status");
  if (state.proving && el) el.textContent = m.replace(/^[^ ]+ +/, "");
  else render();
}

let toastT = 0;
export function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2600);
}

export function scramble(el, target, { speed = 35, stepMs = 600, batchSize = 3 } = {}) {
  if (!el) return;
  el.innerHTML = "";
  const spans = [...target].map((ch) => {
    const s = document.createElement("span");
    s.className = "glyph";
    s.textContent = ch === " " ? "\\u00a0" : ch;
    el.appendChild(s);
    return { el: s, final: ch === " " ? "\\u00a0" : ch };
  });
  let i = 0;
  const tick = () => {
    for (let b = 0; b < batchSize && i < spans.length; b++, i++) {
      const { el: s, final } = spans[i];
      let c = 0;
      const iv = setInterval(() => {
        s.textContent = SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        if (++c > 4) { clearInterval(iv); s.textContent = final; }
      }, speed);
    }
    if (i < spans.length) setTimeout(tick, stepMs);
  };
  tick();
}

const brand = `<div class="brand"><img class="brand-logo" src="/logo/logo-wall.png" alt="" aria-hidden="true"/>Wall</div>`;

export function render() {
  const app = $("#app");
  if (!app) return;
  document.body.classList.toggle("plain-bg", state.view === "docs");
  if (!state.CFG) { app.innerHTML = `<div class="screen center"><img class="hero-eclipse" src="/logo/logo-wall.png" alt="" style="opacity:.6"/></div>`; return; }
  if (state.CFG.error) { app.innerHTML = `<div class="screen center"><p class="muted">${esc(state.CFG.error)}</p></div>`; return; }
  if (state.proving) { app.innerHTML = provingView(); return; }
  if (state.view === "landing") return void (app.innerHTML = landingView(), wireLanding());
  app.innerHTML = homeView() + (state.sheet ? sheetView() : "");
  wireHome();
  if (state.sheet) wireSheet();
}

function landingView() {
  return `<div class="landing-root">
  <section class="hero-section">
    <div class="hero-fluid"></div>
    <div class="hero-grain"></div>
    <div class="chart-grid"></div>
    <div class="hero-gradient"></div>
    <header class="hero-header">
      <a class="hero-logo" href="#">
        <img src="/logo/logo-wall.png" alt="Wall" width="32" height="32" />
        <span class="hero-logo-text">Wall</span>
      </a>
      <nav class="hero-nav">
        <button class="hero-nav-link" id="nav-story">Story</button>
        <button class="hero-nav-link" id="nav-features">Features</button>
        <button class="hero-nav-link" id="hero-enter">Enter</button>
      </nav>
    </header>
    <div class="hero-content">
      <h1 class="hero-title">
        <span class="hero-line"><span class="hero-word">Private</span> <span class="hero-word">Payments</span></span>
        <span class="hero-scramble-line"><span class="hero-scramble" id="hero-scramble"></span></span>
      </h1>
      <p class="hero-scroll">Scroll to explore</p>
    </div>
    <div class="hero-transition"></div>
  </section>

  <section class="story-section" id="story">
    <div class="story-grain"></div>
    <div class="story-inner">
      <div class="story-label">
        <span>Our Story</span>
        <span class="story-label-sep">&mdash;</span>
        <span>Why Wall Exists</span>
      </div>
      <h2 class="story-heading">Money should move <span class="story-heading-muted">like whispers, not broadcasts</span></h2>
      <div class="story-cards">
        <div class="story-card">
          <div class="story-card-grid">
            <div class="story-card-visual">
              <img class="story-card-img" src="/assets/hourglass.webp" alt="" />
            </div>
            <div class="story-card-text">
              <div class="story-card-meta">
                <span class="story-card-n">01</span>
                <span class="story-card-label">The Problem</span>
                <span class="story-card-coord">2024</span>
              </div>
              <h3>Every transaction is a public statement</h3>
              <p>On Ethereum, every payment, swap, and loan is permanently visible. Your financial life is an open book &mdash; anyone can read your balance, your history, your habits.</p>
            </div>
          </div>
        </div>
        <div class="story-card">
          <div class="story-card-grid story-card-grid-flip">
            <div class="story-card-visual">
              <img class="story-card-img" src="/assets/balance.webp" alt="" />
            </div>
            <div class="story-card-text">
              <div class="story-card-meta">
                <span class="story-card-n">02</span>
                <span class="story-card-label">The Insight</span>
                <span class="story-card-coord">Privacy</span>
              </div>
              <h3>Privacy is not secrecy &mdash; it's control</h3>
              <p>You should choose who sees your finances. An auditor needs compliance access. A merchant doesn't need your savings. <code>Nox TEE</code> gives you that control.</p>
            </div>
          </div>
        </div>
        <div class="story-card">
          <div class="story-card-grid">
            <div class="story-card-visual">
              <img class="story-card-img" src="/assets/cube.webp" alt="" />
            </div>
            <div class="story-card-text">
              <div class="story-card-meta">
                <span class="story-card-n">03</span>
                <span class="story-card-label">The Wall</span>
                <span class="story-card-coord">2025</span>
              </div>
              <h3>Confidential by default, transparent by choice</h3>
              <p>Wall uses <code>Nox</code> (TEE-based confidential computing) to encrypt your balances and positions on-chain. Nothing is visible unless you choose to disclose it.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="features-section" id="features">
    <div class="features-inner">
      <div class="story-label" style="margin-bottom:2rem">
        <span>Features</span>
        <span class="story-label-sep">&mdash;</span>
        <span>What Wall Does</span>
      </div>
      <div class="bento-grid">
        <div class="bento-card bento-card-info">
          <div class="bento-title">Confidential Pool</div>
          <div class="bento-desc">Deposit, withdraw, and send tokens with encrypted balances. No MetaMask needed &mdash; your private key stays on device.</div>
        </div>
        <div class="bento-card bento-card-info">
          <div class="bento-title">Confidential Lending</div>
          <div class="bento-desc">Supply and borrow against encrypted positions. Collateral, debt, and health factors remain private on-chain.</div>
        </div>
        <div class="bento-card bento-card-info">
          <div class="bento-title">Nox TEE Privacy</div>
          <div class="bento-desc">Balances encrypted via Intel SGX enclaves. Selective disclosure for auditors without exposing full financial history.</div>
        </div>
        <div class="bento-card bento-card-info">
          <div class="bento-title">Relayer-Paid Gas</div>
          <div class="bento-desc">No ETH needed for transactions. The relayer signs and submits; you just encrypt and confirm.</div>
        </div>
      </div>
      <div class="story-cta">
        <button class="cta-btn" id="landing-cta">Connect MetaMask</button>
      </div>
    </div>
  </section>

  <footer class="landing-footer">
    <div class="footer-grain"></div>
    <div class="footer-inner">
      <div class="footer-top">
        <p class="footer-tagline">Money moves in shadows.<br/>Only the light you choose to cast reveals it.</p>
        <img class="footer-logo" src="/logo/logo-wall.png" alt="Wall" width="48" height="48" />
      </div>
      <div class="footer-email-wrap">
        <a class="footer-email" href="#">wall.wtf</a>
      </div>
      <div class="footer-divider"></div>
      <div class="footer-bottom">
        <div class="footer-links">
          <a href="https://github.com/maulana-tech/wall-main" target="_blank">GitHub</a>
        </div>
        <div class="footer-info">
          <div class="footer-info-col">
            <div class="footer-info-title">Protocol</div>
            <p>Nox TEE confidential computing on Ethereum Sepolia.</p>
          </div>
          <div class="footer-info-col">
            <div class="footer-info-title">Built for</div>
            <p>WTF Hackathon Summer Edition &mdash; iExec Nox challenge.</p>
          </div>
        </div>
      </div>
      <div class="footer-copyright">
        <span>WALL &mdash; PRIVACY WALLET</span>
        <button class="footer-top-btn" id="footer-top">Back to top</button>
      </div>
    </div>
  </footer>
</div>`;
}

function wireLanding() {
  scramble($("#hero-scramble"), "On Ethereum");
  setTimeout(() => {
    const story = $("#nav-story"), features = $("#nav-features"), enter = $("#hero-enter");
    if (story) story.onclick = () => document.getElementById("story")?.scrollIntoView({ behavior: "smooth" });
    if (features) features.onclick = () => document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
    const goConnect = async () => { 
      try {
        const res = await loadWallet({ stayOnLanding: false });
        if (!res) alert("loadWallet returned false");
      } catch (e) {
        alert("Connection failed in goConnect: " + (e.message || String(e)));
      }
    };
    if (enter) enter.onclick = goConnect;
    const cta = $("#landing-cta"); if (cta) cta.onclick = goConnect;
    const top = $("#footer-top"); if (top) top.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("visible"); obs.unobserve(e.target); }
    }, { threshold: 0.15 });
    document.querySelectorAll(".story-card").forEach((c) => obs.observe(c));
  });
}

const TABS = [["portfolio", "Portfolio"], ["lending", "Lending"], ["swap", "Swap"]];

function homeView() {
  const heroUsd = totalUsd();
  const addr = state.wallet?.address || "";
  let panel = portfolioPanel();
  if (state.tab === "lending") panel = lendingPanel();
  if (state.tab === "swap") panel = swapPanel();
  return `<div class="screen home">
    <header class="bar">
      ${brand}
      <div class="bar-r">
        <button class="chip" id="copyaddr" title="copy your address">${esc(short(addr, 5))}</button>
        <button class="icon-btn" id="disconnect" title="disconnect" aria-label="disconnect">⏻</button>
      </div>
    </header>
    <section class="hero">
      <div class="hero-balance" id="reveal-bal">
        <span class="amt">${esc(fmtNum(heroUsd, 2))}</span>
        <span class="sym">USDC</span>
      </div>
    </section>
    <nav class="tabs">
      ${TABS.map(([k, label]) => `<button class="tab ${state.tab === k ? "on" : ""}" data-tab="${k}">${label}</button>`).join("")}
    </nav>
    ${panel}
  </div>`;
}

function portfolioPanel() {
  const assets = state.CFG?.assets || [];
  const holdings = assets.filter((a) => balanceOf(a.id) > 0n);
  const holdingRow = (a) => {
    const bal = humanBal(a.id);
    const usd = bal * assetUsd(a.id);
    return `<div class="hrow">
      <span class="hico">${esc(a.symbol[0])}</span>
      <span class="hrow-main"><span class="hsym">${esc(a.symbol)}</span></span>
      <span class="hrow-amt"><span class="hbal">${esc(toHuman(balanceOf(a.id), decOf(a.id)))}</span><span class="husd">$${esc(fmtNum(usd, 2))}</span></span>
    </div>`;
  };
  return `<div class="panel">
    <nav class="actions">
      <button class="act" data-sheet="send"><span class="act-i">↗</span>Send</button>
      <button class="act" data-sheet="deposit"><span class="act-i">↧</span>Deposit</button>
      <button class="act" data-sheet="withdraw"><span class="act-i">↥</span>Withdraw</button>
      <button class="act" data-sheet="receive"><span class="act-i">◎</span>Receive</button>
    </nav>
    <div class="terminator"></div>
    <section class="holdings">
      <div class="sec-h"><span>Your tokens</span></div>
      ${holdings.length ? holdings.map(holdingRow).join("") : `<p class="empty">No tokens in shadow yet. Make a deposit to begin.</p>`}
    </section>
    <section class="activity">
      <div class="sec-h"><span>Activity</span></div>
      ${state.history.length ? state.history.map((e) => {
        const dirIcon = { deposit: "↧", withdraw: "↥", send: "↗", swap: "⇄" }[e.dir] || "◐";
        const amt = `${toHuman(e.amount, decOf(e.assetId))} ${symOf(e.assetId)}`;
        const label = { deposit: "Deposited", withdraw: "Withdrew", send: "Sent", swap: "Swapped" }[e.dir] || e.dir;
        const when = new Date(e.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        const link = e.hash ? `<a class="arow-tx" href="${EXPLORER}/${esc(e.hash)}" target="_blank" rel="noopener">↗</a>` : "";
        return `<div class="arow-wrap"><div class="arow lit">
          <span class="ecl ${e.dir}">${dirIcon}</span>
          <span class="arow-main"><span class="dir">${label}</span><span class="when">${esc(when)}</span></span>
          <span class="amt">${esc(amt)}</span>
        </div>${link}</div>`;
      }).join("") : `<p class="empty">Nothing has crossed the horizon yet.</p>`}
    </section>
  </div>`;
}

function lendingPanel() {
  const subTabs = [["lend", "Supply"], ["borrow", "Borrow"], ["positions", "My Positions"]];
  const subnav = `<nav class="subtabs">${subTabs.map(([k, l]) => `<button class="subtab ${state.lendTab === k ? "on" : ""}" data-lendtab="${k}">${l}</button>`).join("")}</nav>`;
  if (state.lendTab === "positions") return `<div class="panel">${subnav}${positionsPanel()}</div>`;
  if (state.lendTab === "borrow") return `<div class="panel">${subnav}${borrowPanel()}</div>`;
  return `<div class="panel">${subnav}${supplyPanel()}</div>`;
}

const marketAssets = () => state.CFG?.marketAssets || state.CFG?.assets || [];
const mDec = (id) => marketAssets().find((a) => Number(a.id) === Number(id))?.decimals ?? 7;
const mSym = (id) => marketAssets().find((a) => Number(a.id) === Number(id))?.symbol || `#${id}`;

function supplyPanel() {
  return marketAssets().map((a) => {
    const hasPos = state.mkt.myPositions.some((p) => p.assetId === a.id);
    return `<div class="hrow" style="padding:12px 0;border-bottom:1px solid rgba(128,128,128,0.15)">
      <span class="hico">${esc(a.symbol[0])}</span>
      <span class="hrow-main"><span class="hsym">${esc(a.symbol)}</span><span class="muted small"> supply to market</span></span>
      <div class="lp-btns">
        ${!hasPos ? `<button class="lp-b" data-mktopen="${a.id}">Open Position</button>` : ""}
        <button class="lp-b" data-mktsupply="${a.id}">Supply</button>
      </div>
    </div>`;
  }).join("") + `<p class="panel-note" style="margin-top:12px">Supply tokens to the lending market. Amounts encrypted via Nox TEE.</p>`;
}

function borrowPanel() {
  const positions = state.mkt.myPositions;
  if (!positions.length) return `<p class="empty" style="padding:20px">Open a position in the Supply tab first.</p>`;
  return positions.map((p) => `<div class="hrow" style="padding:12px 0;border-bottom:1px solid rgba(128,128,128,0.15)">
    <span class="hrow-main"><span class="hsym">Position #${p.positionId}</span><span class="muted small"> ${esc(mSym(p.assetId))}</span></span>
    <div class="lp-btns">
      <button class="lp-b" data-mktborrow="${p.positionId}">Borrow</button>
      ${p.debt > 0n ? `<button class="lp-b ghost" data-mktrepay="${p.positionId}">Repay</button>` : ""}
    </div>
  </div>`).join("");
}

function positionsPanel() {
  const positions = state.mkt.myPositions;
  if (!positions.length) return `<p class="empty" style="padding:20px">No positions yet.</p>`;
  return positions.map((p) => {
    const health = p.healthFactor > 0 ? (p.healthFactor / 100).toFixed(2) : "—";
    return `<div class="hrow" style="padding:12px 0;border-bottom:1px solid rgba(128,128,128,0.15)">
      <span class="hrow-main"><span class="hsym">Position #${p.positionId}</span><span class="muted small"> ${esc(mSym(p.assetId))} · health ${esc(health)}</span></span>
      <div class="lp-btns"><button class="lp-b" data-mktsupply="${p.assetId}" data-posid="${p.positionId}">Add Collateral</button></div>
    </div>`;
  }).join("");
}

const swapAssets = () => state.CFG?.assets || [];
const swapRate = () => state.prices.eurUsd || 1.08;

export function swapPreview(amtRaw) {
  if (!amtRaw || amtRaw <= 0n) return 0n;
  const rate14 = BigInt(Math.round(swapRate() * 1e7)); // scaled 1e7
  if (state.swapFrom === 2 && state.swapTo === 1) return (amtRaw * rate14) / 10000000n;
  if (state.swapFrom === 1 && state.swapTo === 2) return (amtRaw * 10000000n) / rate14;
  return amtRaw;
}

function swapPanel() {
  const assets = swapAssets();
  const fromA = assets.find((a) => a.id === state.swapFrom) || assets[0];
  const toA = assets.find((a) => a.id === state.swapTo) || assets[1];
  return `<div class="panel">
    <div class="swap-box">
      <div class="swap-row">
        <span class="lbl">You pay</span>
        <div class="swap-asset-sel">${assets.map((a) => `<button class="seg-b ${a.id === state.swapFrom ? "on" : ""}" data-swapfrom="${a.id}">${esc(a.symbol)}</button>`).join("")}</div>
      </div>
      <input id="swap-amt" class="field swap-input" inputmode="decimal" placeholder="0.0" autocomplete="off"/>
      <div class="swap-rate-line">Balance: ${esc(toHuman(balanceOf(state.swapFrom), decOf(state.swapFrom)))} ${esc(fromA?.symbol || "")}</div>
      <div class="swap-divider"><button class="swap-flip" id="swap-flip" aria-label="flip">&#8645;</button></div>
      <div class="swap-row">
        <span class="lbl">You receive</span>
        <div class="swap-asset-sel">${assets.map((a) => `<button class="seg-b ${a.id === state.swapTo ? "on" : ""}" data-swapto="${a.id}">${esc(a.symbol)}</button>`).join("")}</div>
      </div>
      <div class="swap-preview" id="swap-preview">0.0</div>
      <div class="swap-rate-line">1 EURC = ${esc(swapRate().toFixed(2))} USDC</div>
    </div>
    <button class="btn primary wide" id="swap-go">Swap</button>
    <p class="panel-note">Amounts encrypted via Nox TEE. Swap at fixed rate.</p>
  </div>`;
}

function wireHome() {
  $("#disconnect").onclick = disconnect;
  const copyaddr = $("#copyaddr"); if (copyaddr) copyaddr.onclick = () => { navigator.clipboard?.writeText(state.wallet.address); toast("Address copied"); };
  document.querySelectorAll(".tab[data-tab]").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; if (state.tab === "lending") marketRefresh(); render(); });
  document.querySelectorAll(".subtab[data-lendtab]").forEach((b) => b.onclick = () => { state.lendTab = b.dataset.lendtab; render(); });
  document.querySelectorAll(".act").forEach((b) => b.onclick = () => { state.sheet = b.dataset.sheet; render(); });
  document.querySelectorAll("[data-mktopen]").forEach((b) => b.onclick = () => openMarketPosition(Number(b.dataset.mktopen)));
  document.querySelectorAll("[data-mktsupply]").forEach((b) => b.onclick = () => {
    state.sheet = "mkt-supply"; state.mktSheetData = { assetId: Number(b.dataset.mktsupply), positionId: Number(b.dataset.posid) || 0 }; render();
  });
  document.querySelectorAll("[data-mktborrow]").forEach((b) => b.onclick = () => {
    state.sheet = "mkt-borrow"; state.mktSheetData = { positionId: Number(b.dataset.mktborrow) }; render();
  });
  document.querySelectorAll("[data-mktrepay]").forEach((b) => b.onclick = () => {
    state.sheet = "mkt-repay"; state.mktSheetData = { positionId: Number(b.dataset.mktrepay) }; render();
  });
  // swap
  document.querySelectorAll("[data-swapfrom]").forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.swapfrom);
    if (id === state.swapTo) { state.swapTo = state.swapFrom; state.swapFrom = id; } else { state.swapFrom = id; }
    render();
  });
  document.querySelectorAll("[data-swapto]").forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.swapto);
    if (id === state.swapFrom) { state.swapFrom = state.swapTo; state.swapTo = id; } else { state.swapTo = id; }
    render();
  });
  const flipBtn = $("#swap-flip");
  if (flipBtn) flipBtn.onclick = () => { [state.swapFrom, state.swapTo] = [state.swapTo, state.swapFrom]; render(); };
  const swapAmt = $("#swap-amt");
  const swapPreviewEl = $("#swap-preview");
  if (swapAmt && swapPreviewEl) {
    swapAmt.oninput = () => {
      try {
        const raw = toRaw(swapAmt.value || "0", decOf(state.swapFrom));
        const out = swapPreview(raw);
        swapPreviewEl.textContent = `${toHuman(out, decOf(state.swapTo))} ${symOf(state.swapTo)}`;
      } catch { swapPreviewEl.textContent = "—"; }
    };
  }
  const swapGo = $("#swap-go");
  if (swapGo) swapGo.onclick = () => runSwap();
}

function sheetView() {
  const assets = state.CFG?.assets || [];
  const sel = assets.length > 1 ? `<label class="lbl">Asset</label><div class="seg">${assets.map((a) => `<button class="seg-b ${a.id === state.asset ? "on" : ""}" data-sasset="${a.id}">${esc(a.symbol)}</button>`).join("")}</div>` : "";
  const amount = `<label class="lbl">Amount</label><input id="s-amt" class="field" inputmode="decimal" placeholder="0.0" autocomplete="off"/>`;
  let title, body, hint;

  if (state.sheet === "mkt-supply") {
    const a = assets.find((x) => x.id === state.mktSheetData?.assetId) || assets[0];
    title = `Supply ${a?.symbol || ""}`; hint = "Supply tokens to your lending position.";
    body = `${amount}`;
  } else if (state.sheet === "mkt-borrow") {
    title = "Borrow"; hint = "Borrow against your supplied collateral.";
    body = `${amount}`;
  } else if (state.sheet === "mkt-repay") {
    title = "Repay"; hint = "Repay your outstanding debt.";
    body = `${amount}`;
  } else if (state.sheet === "send") {
    title = "Send in shadow"; hint = "Amount and recipient stay hidden on-chain.";
    body = `${sel}<label class="lbl">Recipient</label><input id="s-addr" class="field mono" placeholder="0x…" autocomplete="off"/>${amount}`;
  } else if (state.sheet === "deposit") {
    title = "Into the wall"; hint = "Deposit tokens from your wallet into the pool.";
    body = `${sel}${amount}`;
  } else if (state.sheet === "withdraw") {
    title = "Toward daybreak"; hint = "Withdraw tokens from the pool back to your wallet.";
    body = `${sel}${amount}`;
  } else {
    title = "Your address"; hint = "Share this so others can send you tokens.";
    body = `<div class="addr-box"><code>${esc(state.wallet?.address || "")}</code></div>`;
  }

  return `<div class="sheet-scrim" id="scrim"><div class="sheet" role="dialog">
    <div class="sheet-grip"></div>
    <h3 class="sheet-title">${esc(title)}</h3>
    <p class="sheet-hint">${esc(hint)}</p>
    ${body}
    <div class="sheet-actions">
      ${state.sheet === "receive" ? `<button class="btn primary" id="s-copy">Copy</button><button class="btn ghost" id="s-cancel">Done</button>`
        : `<button class="btn primary" id="s-go">Confirm</button><button class="btn ghost" id="s-cancel">Cancel</button>`}
    </div>
  </div></div>`;
}

function wireSheet() {
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") { state.sheet = null; render(); } };
  $("#s-cancel").onclick = () => { state.sheet = null; render(); };
  document.querySelectorAll(".seg-b").forEach((b) => b.onclick = () => { state.asset = Number(b.dataset.sasset); render(); });
  const copy = $("#s-copy"); if (copy) copy.onclick = () => { navigator.clipboard?.writeText(state.wallet.address); copy.textContent = "Copied"; };

  if (state.sheet === "mkt-supply" || state.sheet === "mkt-borrow" || state.sheet === "mkt-repay") {
    const goBtn = $("#s-go");
    if (goBtn) goBtn.onclick = async () => {
      let amt; try { amt = toRaw($("#s-amt").value || "0", 7); } catch (e) { return toast(e.message); }
      if (amt <= 0n) return toast("Enter an amount");
      if (state.sheet === "mkt-supply") await supplyToMarket(state.mktSheetData.positionId || 1, amt, state.mktSheetData.assetId);
      else if (state.sheet === "mkt-borrow") await borrowFromMarket(state.mktSheetData.positionId, amt);
      else if (state.sheet === "mkt-repay") await repayToMarket(state.mktSheetData.positionId, amt, state.mktSheetData.assetId);
      state.sheet = null; render();
    };
    return;
  }

  if (state.sheet === "deposit") {
    const goBtn = $("#s-go");
    if (goBtn) goBtn.onclick = () => {
      let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(state.asset)); } catch (e) { return toast(e.message); }
      if (amt <= 0n) return toast("Enter an amount");
      runDeposit(amt, state.asset);
    };
    return;
  }

  const goBtn = $("#s-go");
  if (goBtn) goBtn.onclick = () => {
    let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(state.asset)); } catch (e) { return toast(e.message); }
    if (amt <= 0n) return toast("Enter an amount");
    if (state.sheet === "send") {
      const addr = $("#s-addr")?.value?.trim();
      if (!addr || !addr.startsWith("0x")) return toast("Enter a valid address");
      runAction("send", { amt, assetId: state.asset, addr });
    } else if (state.sheet === "withdraw") {
      runAction("withdraw", { amt, assetId: state.asset });
    }
  };
}

const provingView = () => `<div class="screen center proving">
  <img class="prove-eclipse" src="/logo/logo-wall.png" alt="" aria-hidden="true" />
  <p class="prove-status" id="prove-status">encrypting via Nox…</p>
  <p class="prove-sub">Amount encrypted client-side. Relayer submits to chain.</p>
</div>`;
"""

main_js = """// Wall — self-contained privacy wallet on ETH Sepolia.
// No MetaMask needed. Private key stays local. Relayer pays gas.

import { state } from "./state.js";
import { API_BASE, IS_EXT } from "./constants.js";
import { fetchPrices } from "./api.js";
import { loadWallet } from "./wallet.js";
import { render } from "./ui.js";

if (IS_EXT) { 
  try { window.Worker = undefined; self.Worker = undefined; } catch {} 
  document.documentElement.classList.add("ext"); 
}

(async () => {
  try { state.CFG = await (await fetch(`${API_BASE}/api/config`)).json(); } catch { state.CFG = { error: "Could not load config" }; }
  if (state.CFG?.assets?.length) state.asset = state.CFG.assets[0].id;
  fetchPrices();
  const saved = localStorage.getItem("wall-connected");
  if (saved && !state.CFG.error) loadWallet({ stayOnLanding: true });
  else render();
})();
"""

files = {
    "constants.js": constants_js,
    "state.js": state_js,
    "utils.js": utils_js,
    "api.js": api_js,
    "wallet.js": wallet_js,
    "actions.js": actions_js,
    "ui.js": ui_js,
    "main.js": main_js,
}

base_dir = "/Users/em/web/wall-main/web/src/"
for fname, content in files.items():
    with open(os.path.join(base_dir, fname), "w") as f:
        f.write(content)

print("Files written successfully")
