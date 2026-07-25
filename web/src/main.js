// Wall — privacy wallet on ETH Sepolia. Uses Nox for encrypted balances
// and MetaMask for wallet connection.
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import { WallPool } from "../../client/lib/eth";

const EXPLORER = "https://sepolia.etherscan.io/tx";
const $ = (s) => document.querySelector(s);
const API_BASE = import.meta.env.VITE_API_BASE || "";
const IS_EXT = import.meta.env.VITE_EXT === "1";
if (IS_EXT) { try { window.Worker = undefined; self.Worker = undefined; } catch {} document.documentElement.classList.add("ext"); }

const SEPOLIA_CHAIN_ID = 11155111;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

let CFG = null, ME = null, notes = [], log = [], history = [], localHist = [];
let view = "landing", sheet = null;
let tab = "portfolio";
let lendTab = "lend"; // lend | borrow | liquidate
let asset = 1, proving = false, revealBalance = false, reveals = new Set();
let discCanvas = null, disc = null, heartbeat = 0;
let fr = null; // { address, signer, provider, noxClient }
let prices = { eurUsd: 1.08 };
let mktBusy = false;
let mktSheetData = null; // { assetId, positionId } for market sheet operations

// Market state
let mkt = {
  stats: {}, // { [assetId]: { reserve, supplied, borrowed, supplyApy, borrowApy } }
  positions: {}, // { [assetId]: { positionId, collateral, debt } }
  myPositions: [], // [{ positionId, assetId, collateral, debt, owner }]
  loadedAt: 0,
  loading: false,
  err: null,
};

// ---------- amount helpers ----------
const assetById = (id) => (CFG?.assets || []).find((a) => Number(a.id) === Number(id));
const decOf = (id) => assetById(id)?.decimals ?? 7;
const symOf = (id) => assetById(id)?.symbol || `#${id}`;
function toRaw(human, d) {
  const s = String(human).trim();
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) throw new Error("enter a valid amount");
  const [int, frac = ""] = s.split(".");
  if (frac.length > d) throw new Error(`${symOf(asset)} allows at most ${d} decimals`);
  return BigInt((int || "0") + frac.padEnd(d, "0"));
}
function toHuman(raw, d) {
  const s = BigInt(raw).toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d), frac = d ? s.slice(s.length - d).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}
const short = (s, n = 5) => (s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || "");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtNum = (n, dp) => (isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: dp }) : "0");

const say = (m) => { log.unshift(`${new Date().toLocaleTimeString().slice(0, 8)}  ${m}`); const el = $("#prove-status"); if (proving && el) el.textContent = m.replace(/^[^ ]+ +/, ""); else render(); };

// ---------- balance tracking ----------
// We track encrypted balances by scanning Deposited events + locally recording operations.
// The actual balance is encrypted on-chain; we maintain a local note list for the UI.
const balanceOf = (id) => notes.filter((n) => Number(n.assetId) === Number(id)).reduce((a, n) => a + n.amount, 0n);
const humanBal = (id) => Number(toHuman(balanceOf(id), decOf(id)));
const assetUsd = (id) => (/EUR/i.test(symOf(id)) ? prices.eurUsd : 1);
const totalUsd = () => (CFG?.assets || []).reduce((s, a) => s + humanBal(a.id) * assetUsd(a.id), 0);
const noteCount = (id) => notes.filter((n) => Number(n.assetId) === Number(id)).length;

// ---------- Nox client ----------
let noxClient = null;
async function initNox(signer) {
  noxClient = await createEthersHandleClient(signer);
  return noxClient;
}
async function encryptAmount(value) {
  if (!noxClient) throw new Error("Nox not initialized — connect MetaMask first");
  const result = await noxClient.encryptInput(value);
  return { handle: result.handle, proof: result.proof };
}
async function decryptHandle(handle) {
  if (!noxClient) throw new Error("Nox not initialized");
  return await noxClient.decrypt(handle);
}

// ---------- MetaMask ----------
async function connectMetaMask() {
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
  await initNox(signer);
  return { provider, signer, address };
}

// ---------- ERC-20 helpers ----------
async function getERC20Balance(address, tokenAddress, provider) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return await token.balanceOf(address);
}
async function approveERC20(tokenAddress, spender, amount, signer) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const tx = await token.approve(spender, amount);
  return await tx.wait();
}

// ---------- chain actions ----------
async function fetchEvents(fromBlock = 0, toBlock = "latest") {
  if (!CFG?.pool) return [];
  const provider = fr?.provider;
  if (!provider) return [];
  const pool = new ethers.Contract(CFG.pool, [
    "event Deposited(address indexed user, uint256 assetId, uint256 amount)",
    "event Withdrawn(address indexed user, uint256 assetId, uint256 amount)",
    "event Transferred(address indexed from, address indexed to, uint256 assetId, uint256 amount)",
  ], provider);
  const [deps, wds, trs] = await Promise.all([
    pool.queryFilter(pool.filters.Deposited(), fromBlock, toBlock),
    pool.queryFilter(pool.filters.Withdrawn(), fromBlock, toBlock),
    pool.queryFilter(pool.filters.Transferred(), fromBlock, toBlock),
  ]);
  return [...deps.map((e) => ({ ...e, type: "deposit" })), ...wds.map((e) => ({ ...e, type: "withdraw" })), ...trs.map((e) => ({ ...e, type: "transfer" }))];
}

// ---------- relayer submission ----------
async function submitToRelayer(action, data) {
  const url = `${API_BASE}/api/submit`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "relayer rejected");
  return j.txHash || j.hash;
}

// ---------- core actions ----------
async function doDeposit(amount, assetId) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount);
  say("approving token transfer…");

  // Approve ERC20 to the pool
  const tokenAddr = assetId === 1 ? CFG.usdc : CFG.eurc;
  await approveERC20(tokenAddr, CFG.pool, amount, fr.signer);

  say("submitting deposit to relayer…");
  const txHash = await submitToRelayer("deposit", {
    handle: ethers.hexlify(handle),
    handleProof: ethers.hexlify(proof),
    assetId: String(assetId),
  });

  // Track locally
  notes.push({ amount, assetId, txHash, ts: Date.now() });
  say("deposited into the wall");
  return txHash;
}

async function doWithdraw(amount, assetId, destAddr) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount);
  say("submitting withdrawal to relayer…");

  const txHash = await submitToRelayer("withdraw", {
    handle: ethers.hexlify(handle),
    handleProof: ethers.hexlify(proof),
    assetId: String(assetId),
  });

  // Track locally
  notes = notes.filter((n) => !(Number(n.assetId) === Number(assetId) && n.amount <= amount));
  say("withdrew toward daybreak");
  return txHash;
}

async function doTransfer(amount, assetId, toAddr) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount);
  say("submitting transfer to relayer…");

  const txHash = await submitToRelayer("transfer", {
    handle: ethers.hexlify(handle),
    handleProof: ethers.hexlify(proof),
    recipient: toAddr,
    assetId: String(assetId),
  });

  // Track locally
  notes = notes.filter((n) => !(Number(n.assetId) === Number(assetId) && n.amount <= amount));
  say("sent in shadow");
  return txHash;
}

// ---------- orchestrated actions ----------
async function runDeposit(amt, assetId) {
  if (proving) return;
  if (!fr) { toast("Connect MetaMask first"); return; }
  proving = true; render(); disc?.occult();
  try {
    const hash = await doDeposit(amt, assetId);
    pushHistory({ dir: "deposit", amount: amt.toString(), assetId, hash });
    disc?.settle(); sheet = null;
  } catch (e) { say(e.message || String(e)); disc?.idle(); proving = false; render(); return; }
  proving = false; setTimeout(() => disc?.idle(), 1400); render();
}

async function runAction(kind, args) {
  if (proving) return;
  proving = true; render(); disc?.occult();
  try {
    let hash;
    if (kind === "send") hash = await doTransfer(args.amt, args.assetId, args.addr);
    else if (kind === "withdraw") hash = await doWithdraw(args.amt, args.assetId, args.addr);
    pushHistory({ dir: kind, amount: args.amt.toString(), assetId: args.assetId, hash });
    disc?.settle(); sheet = null;
  } catch (e) { say(e.message || String(e)); disc?.idle(); proving = false; render(); return; }
  proving = false; setTimeout(() => disc?.idle(), 1400); render();
}

// ---------- activity ----------
const histKey = () => `wall-hist-${(ME?.seed || "anon").slice(0, 8)}`;
function pushHistory(e) {
  localHist.unshift({ ...e, ts: Date.now() });
  localStorage.setItem(histKey(), JSON.stringify(localHist.slice(0, 50)));
  history = [...localHist];
}

function deriveActivity(events) {
  return events.map((e) => {
    const dir = e.type === "deposit" ? "deposit" : e.type === "withdraw" ? "withdraw" : "send";
    return { dir, amount: (e.args?.amount || 0n).toString(), assetId: Number(e.args?.assetId || 1), ts: Date.parse(e.blockTimestamp || "") || Date.now(), hash: e.transactionHash };
  }).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
}

// ---------- scan ----------
async function rescan() {
  if (!ME || !fr) return;
  say("reading the horizon…");
  try {
    const events = await fetchEvents();
    history = [...deriveActivity(events), ...localHist.filter((e) => !events.some((ev) => ev.transactionHash === e.hash))].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
    say(`${notes.length} note${notes.length === 1 ? "" : "s"} in shadow`);
  } catch (e) { say("couldn't reach the network. retrying soon"); }
  if (!proving) render();
}

// ---------- identity ----------
function connect(seed) {
  const s = String(seed).trim();
  ME = { seed: s, address: s.slice(0, 42) };
  localStorage.setItem("wall-seed", s);
  localHist = JSON.parse(localStorage.getItem(histKey()) || "[]");
  history = [...localHist];
  view = "home"; sheet = null; tab = "portfolio"; notes = [];
  clearInterval(heartbeat);
  heartbeat = setInterval(() => { if (ME && !proving) rescan(); }, 20000);
  render(); rescan();
}

function disconnect() {
  clearInterval(heartbeat);
  localStorage.removeItem("wall-seed");
  ME = null; fr = null; notes = []; view = "landing"; sheet = null; noxClient = null;
  render();
}

// ---------- MetaMask connect ----------
async function doConnectMetaMask() {
  if (!(window.ethereum)) { toast("Install the MetaMask wallet extension"); window.open("https://www.metamask.app/", "_blank"); return; }
  const { provider, signer, address } = await connectMetaMask();
  fr = { address, signer, provider };
  toast(`Connected: ${short(address, 4)}`);
  render();
}

// ---------- prices ----------
async function fetchPrices() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd");
    const j = await r.json();
    if (j?.["euro-coin"]?.usd) { prices.eurUsd = j["euro-coin"].usd; if (ME) render(); }
  } catch { /* keep fallback */ }
}

// ---------- faucet ----------
async function mintFaucet() {
  if (!fr) { toast("Connect MetaMask first"); return; }
  try {
    const res = await fetch(`${API_BASE}/api/faucet?to=${fr.address}`);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    toast("Minted 1000 USDC + 1000 EURC");
  } catch (e) { toast(e.message || "faucet failed"); }
}

// ---------- market ----------
const MARKET_ABI = [
  "function positions(uint256) view returns (bytes32, bytes32, address, uint256, uint256)",
  "function nextPositionId() view returns (uint256)",
];
const mDec = (id) => (CFG?.marketAssets || CFG?.assets || []).find((a) => Number(a.id) === Number(id))?.decimals ?? 7;
const mSym = (id) => (CFG?.marketAssets || CFG?.assets || []).find((a) => Number(a.id) === Number(id))?.symbol || `#${id}`;
const marketAssets = () => CFG?.marketAssets || CFG?.assets || [];

async function marketRefresh() {
  if (!CFG?.market || !fr?.provider) return;
  mkt.loading = true; mkt.err = null;
  try {
    const market = new ethers.Contract(CFG.market, MARKET_ABI, fr.provider);
    const nextId = Number(await market.nextPositionId());
    const myPos = [];
    for (let i = 1; i < nextId; i++) {
      try {
        const [collateral, debt, owner, assetId, healthFactor] = await market.positions(i);
        if (owner.toLowerCase() === fr.address.toLowerCase()) {
          myPos.push({ positionId: i, collateral: BigInt(collateral), debt: BigInt(debt), owner, assetId: Number(assetId), healthFactor: Number(healthFactor) });
        }
      } catch { /* skip */ }
    }
    mkt.myPositions = myPos;
    mkt.loadedAt = Date.now();
  } catch (e) { mkt.err = e.message || String(e); }
  mkt.loading = false;
  if (ME && tab === "lending") render();
}

async function submitMarket(action, data) {
  const url = `${API_BASE}/api/market`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "market rejected");
  return j.txHash;
}

async function openMarketPosition(assetId) {
  if (mktBusy) return;
  mktBusy = true; proving = true; render();
  try {
    const txHash = await submitMarket("openPosition", { assetId: String(assetId) });
    toast("Position opened");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  mktBusy = false; proving = false; render();
}

async function supplyToMarket(positionId, amount, assetId) {
  if (mktBusy) return;
  mktBusy = true; proving = true; render();
  try {
    const { handle, proof } = await encryptAmount(amount);
    const tokenAddr = assetId === 1 ? CFG.usdc : CFG.eurc;
    await approveERC20(tokenAddr, CFG.market, amount, fr.signer);
    const txHash = await submitMarket("supply", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Supplied to market");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  mktBusy = false; proving = false; render();
}

async function borrowFromMarket(positionId, amount, assetId) {
  if (mktBusy) return;
  mktBusy = true; proving = true; render();
  try {
    const { handle, proof } = await encryptAmount(amount);
    const txHash = await submitMarket("borrow", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Borrowed from market");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  mktBusy = false; proving = false; render();
}

async function repayToMarket(positionId, amount, assetId) {
  if (mktBusy) return;
  mktBusy = true; proving = true; render();
  try {
    const { handle, proof } = await encryptAmount(amount);
    const tokenAddr = assetId === 1 ? CFG.usdc : CFG.eurc;
    await approveERC20(tokenAddr, CFG.market, amount, fr.signer);
    const txHash = await submitMarket("repay", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Repaid to market");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  mktBusy = false; proving = false; render();
}

// ============================ rendering ============================
const brand = `<div class="brand"><img class="brand-logo" src="/logo.png" alt="" aria-hidden="true"/>Wall</div>`;
function placeDisc() {}

function render() {
  const app = $("#app");
  document.body.classList.toggle("plain-bg", view === "docs");
  if (!CFG) { app.innerHTML = `<div class="screen center"><img class="hero-eclipse" src="/logo.png" alt="" style="opacity:.6"/></div>`; return; }
  if (CFG.error) { app.innerHTML = `<div class="screen center"><p class="muted">${esc(CFG.error)}</p></div>`; return; }

  if (proving) { app.innerHTML = provingView(); return; }
  if (view === "landing") return void (app.innerHTML = landingView(), wireLanding());
  if (view === "create") return void (app.innerHTML = createView(), wireCreate());
  if (view === "connect") return void (app.innerHTML = connectView(), wireConnect());

  app.innerHTML = homeView() + (sheet ? sheetView() : "");
  placeDisc();
  wireHome();
  if (sheet) wireSheet();
}

// ---- landing ----
const landingView = () => `<div class="screen center landing">
  <img class="hero-logo" src="/logo.png" alt="Wall" />
  <h1 class="title">Wall</h1>
  <p class="phonetic">/wɔːl/</p>
  <p class="lede">Private payments and balances on Ethereum</p>
  <div class="stack">
    <button class="btn primary" id="go-create">Create wallet</button>
    <button class="btn ghost" id="go-connect">I have a private key</button>
  </div>
  <div class="landing-foot">
    ${IS_EXT ? "" : `<a class="ext-cta" href="https://github.com/maulana-tech/wall-main">View on GitHub ↗</a>`}
  </div>
</div>`;
function wireLanding() {
  $("#go-create").onclick = () => { view = "create"; render(); };
  $("#go-connect").onclick = () => { view = "connect"; render(); };
}

const createView = () => `<div class="screen center pane">
  ${brand}
  <h2 class="title sm">Your private key</h2>
  <p class="lede">This single key is the only way back to your wallet. Keep it somewhere safe, because it can't be recovered.</p>
  <div class="keybox"><code id="seedval">${esc(crypto.randomUUID().replace(/-/g, "").slice(0, 64))}</code></div>
  <button class="btn ghost wide" id="copyseed">Copy key</button>
  <label class="check"><input type="checkbox" id="saved"/> <span>I've saved my private key</span></label>
  <button class="btn primary" id="open" disabled>Open wallet</button>
  <button class="btn link" id="back">Back</button>
</div>`;
function wireCreate() {
  const seed = $("#seedval")?.textContent;
  $("#copyseed").onclick = () => { navigator.clipboard?.writeText(seed); $("#copyseed").textContent = "Copied"; };
  $("#saved").onchange = (e) => { $("#open").disabled = !e.target.checked; };
  $("#open").onclick = () => connect(seed);
  $("#back").onclick = () => { view = "landing"; render(); };
}

const connectView = () => `<div class="screen center pane">
  ${brand}
  <h2 class="title sm">Connect wallet</h2>
  <p class="lede">Paste your private key to step back into the shadow.</p>
  <textarea id="seedin" class="field mono" rows="3" placeholder="private key"></textarea>
  <button class="btn primary" id="do-connect">Connect</button>
  <button class="btn link" id="back">Back</button>
</div>`;
function wireConnect() {
  $("#do-connect").onclick = () => { try { connect($("#seedin").value); } catch (e) { toast(e.message); } };
  $("#back").onclick = () => { view = "landing"; render(); };
}

// ---- home ----
const TABS = [["portfolio", "Portfolio"], ["lending", "Lending"]];
function homeView() {
  let heroUsd = totalUsd();
  let panel = portfolioPanel();
  if (tab === "lending") panel = lendingPanel();
  return `<div class="screen home">
    <header class="bar">
      ${brand}
      <div class="bar-r">
        <button class="chip" id="faucet-btn" title="Get test tokens">🚰</button>
        <button class="chip" id="copyaddr" title="copy your address">${esc(short(ME?.address, 5))}</button>
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
      ${TABS.map(([k, label]) => `<button class="tab ${tab === k ? "on" : ""}" data-tab="${k}">${label}</button>`).join("")}
    </nav>
    ${panel}
  </div>`;
}

function lendingPanel() {
  const subTabs = [["lend", "Supply"], ["borrow", "Borrow"], ["positions", "My Positions"]];
  const subnav = `<nav class="subtabs">${subTabs.map(([k, l]) => `<button class="subtab ${lendTab === k ? "on" : ""}" data-lendtab="${k}">${l}</button>`).join("")}</nav>`;

  if (lendTab === "positions") return `<div class="panel">${subnav}${positionsPanel()}</div>`;
  if (lendTab === "borrow") return `<div class="panel">${subnav}${borrowPanel()}</div>`;
  return `<div class="panel">${subnav}${supplyPanel()}</div>`;
}

function supplyPanel() {
  const assets = marketAssets();
  return assets.map((a) => {
    const hasPos = mkt.myPositions.some((p) => p.assetId === a.id);
    return `<div class="hrow" style="padding:12px 0;border-bottom:1px solid rgba(128,128,128,0.15)">
      <span class="hico">${esc(a.symbol[0])}</span>
      <span class="hrow-main"><span class="hsym">${esc(a.symbol)}</span><span class="muted small"> supply to market</span></span>
      <div class="lp-btns">
        <button class="lp-b" data-mktsupply="${a.id}">Supply</button>
        ${!hasPos ? `<button class="lp-b ghost" data-mktopen="${a.id}">Open Position</button>` : ""}
      </div>
    </div>`;
  }).join("") + `<p class="panel-note" style="margin-top:12px">Supply USDC or EURC to the lending market. You earn interest from borrowers. Amounts are encrypted via Nox TEE.</p>`;
}

function borrowPanel() {
  const positions = mkt.myPositions;
  if (!positions.length) return `<p class="empty" style="padding:20px">Open a position first in the Supply tab.</p>`;
  return positions.map((p) => {
    const sym = mSym(p.assetId);
    return `<div class="hrow" style="padding:12px 0;border-bottom:1px solid rgba(128,128,128,0.15)">
      <span class="hrow-main"><span class="hsym">Position #${p.positionId}</span><span class="muted small"> ${esc(sym)} collateral</span></span>
      <div class="lp-btns">
        <button class="lp-b" data-mktborrow="${p.positionId}">Borrow</button>
        ${p.debt > 0n ? `<button class="lp-b ghost" data-mktrepay="${p.positionId}">Repay</button>` : ""}
      </div>
    </div>`;
  }).join("") + `<p class="panel-note" style="margin-top:12px">Borrow against your supplied collateral. Encrypted via Nox TEE.</p>`;
}

function positionsPanel() {
  const positions = mkt.myPositions;
  if (!positions.length) return `<p class="empty" style="padding:20px">No positions yet. Open one in the Supply tab.</p>`;
  return positions.map((p) => {
    const sym = mSym(p.assetId);
    const health = p.healthFactor > 0 ? (p.healthFactor / 100).toFixed(2) : "—";
    return `<div class="hrow" style="padding:12px 0;border-bottom:1px solid rgba(128,128,128,0.15)">
      <span class="hrow-main">
        <span class="hsym">Position #${p.positionId}</span>
        <span class="muted small"> ${esc(sym)} · health ${esc(health)}</span>
      </span>
      <div class="lp-btns">
        <button class="lp-b" data-mktsupply="${p.assetId}" data-posid="${p.positionId}">Add Collateral</button>
      </div>
    </div>`;
  }).join("") + `<p class="panel-note" style="margin-top:12px">Your lending positions. Each is linked to a position on the WallMarket contract.</p>`;
}

function portfolioPanel() {
  const assets = CFG?.assets || [];
  const holdings = assets.filter((a) => balanceOf(a.id) > 0n);
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
      ${history.length ? history.map(activityRow).join("") : `<p class="empty">Nothing has crossed the horizon yet.</p>`}
    </section>
  </div>`;
}

function holdingRow(a) {
  const bal = toHuman(balanceOf(a.id), decOf(a.id));
  const usd = humanBal(a.id) * assetUsd(a.id);
  return `<div class="hrow">
    <span class="hico">${esc(a.symbol[0])}</span>
    <span class="hrow-main"><span class="hsym">${esc(a.symbol)}</span></span>
    <span class="hrow-amt"><span class="hbal">${esc(bal)}</span><span class="husd">$${esc(fmtNum(usd, 2))}</span></span>
  </div>`;
}

function activityRow(e) {
  const dirIcon = { deposit: "↧", withdraw: "↥", send: "↗", receive: "↙" }[e.dir] || "◐";
  const amt = `${toHuman(e.amount, decOf(e.assetId))} ${symOf(e.assetId)}`;
  const label = { deposit: "Deposited", withdraw: "Withdrew", send: "Sent", receive: "Received" }[e.dir] || e.dir;
  const when = new Date(e.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const link = e.hash ? `<a class="arow-tx" href="${EXPLORER}/tx/${esc(e.hash)}" target="_blank" rel="noopener">↗</a>` : "";
  return `<div class="arow-wrap">
    <div class="arow lit">
      <span class="ecl ${e.dir}">${dirIcon}</span>
      <span class="arow-main"><span class="dir">${label}</span><span class="when">${esc(when)}</span></span>
      <span class="amt">${esc(amt)}</span>
    </div>
    ${link}
  </div>`;
}

function wireHome() {
  placeDisc();
  $("#disconnect").onclick = disconnect;
  const faucet = $("#faucet-btn"); if (faucet) faucet.onclick = mintFaucet;
  $("#copyaddr").onclick = () => { navigator.clipboard?.writeText(ME.address); toast("Address copied"); };
  document.querySelectorAll(".tab[data-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.tab; if (tab === "lending") marketRefresh(); render(); });
  document.querySelectorAll(".subtab[data-lendtab]").forEach((b) => b.onclick = () => { lendTab = b.dataset.lendtab; render(); });
  document.querySelectorAll(".act").forEach((b) => b.onclick = () => { sheet = b.dataset.sheet; render(); });

  // Market actions
  document.querySelectorAll("[data-mktopen]").forEach((b) => b.onclick = () => openMarketPosition(Number(b.dataset.mktopen)));
  document.querySelectorAll("[data-mktsupply]").forEach((b) => b.onclick = () => {
    const posId = Number(b.dataset.posid) || 0;
    sheet = "mkt-supply"; mktSheetData = { assetId: Number(b.dataset.mktsupply), positionId: posId }; render();
  });
  document.querySelectorAll("[data-mktborrow]").forEach((b) => b.onclick = () => {
    sheet = "mkt-borrow"; mktSheetData = { positionId: Number(b.dataset.mktborrow) }; render();
  });
  document.querySelectorAll("[data-mktrepay]").forEach((b) => b.onclick = () => {
    sheet = "mkt-repay"; mktSheetData = { positionId: Number(b.dataset.mktrepay) }; render();
  });
}

// ---- sheets ----
function sheetView() {
  const assets = CFG?.assets || [];
  const sel = assets.length > 1 ? `<label class="lbl">Asset</label><div class="seg">${assets.map((a) => `<button class="seg-b ${a.id === asset ? "on" : ""}" data-sasset="${a.id}">${esc(a.symbol)}</button>`).join("")}</div>` : "";
  const amount = `<label class="lbl">Amount</label><input id="s-amt" class="field" inputmode="decimal" placeholder="0.0" autocomplete="off"/>`;
  let title, body, btn, hint;

  if (sheet === "mkt-supply") {
    const a = assets.find((x) => x.id === mktSheetData?.assetId) || assets[0];
    title = `Supply ${a?.symbol || ""}`; btn = "Supply";
    hint = "Supply tokens to your lending position. Encrypted via Nox.";
    body = `${amount}<button class="btn primary" id="s-go">${btn}</button>`;
  } else if (sheet === "mkt-borrow") {
    title = "Borrow"; btn = "Borrow";
    hint = "Borrow against your supplied collateral.";
    body = `${amount}<button class="btn primary" id="s-go">${btn}</button>`;
  } else if (sheet === "mkt-repay") {
    title = "Repay"; btn = "Repay";
    hint = "Repay your outstanding debt.";
    body = `${amount}<button class="btn primary" id="s-go">${btn}</button>`;
  } else if (sheet === "send") {
    title = "Send in shadow"; btn = "Send";
    hint = "Amount and recipient stay hidden on-chain.";
    body = `${sel}<label class="lbl">Recipient</label><input id="s-addr" class="field mono" placeholder="Ethereum address (0x…)" autocomplete="off"/>${amount}`;
  } else if (sheet === "deposit") {
    title = "Into the wall"; btn = null;
    hint = "Deposit from your own Ethereum wallet. Public tokens enter the wall.";
    if (!fr) {
      body = `${sel}<button class="btn primary" id="fr-connect">Connect MetaMask</button>
        <p class="faucet">Get testnet USDC at <a href="https://faucet.circle.com" target="_blank">faucet.circle.com</a></p>`;
    } else {
      body = `${sel}<div class="fr-row"><span class="muted small">MetaMask · <span class="mono">${esc(short(fr.address, 4))}</span></span></div>${amount}<button class="btn primary" id="fr-deposit">Deposit</button>`;
    }
  } else if (sheet === "withdraw") {
    title = "Toward daybreak"; btn = "Withdraw";
    hint = "Value returns to the public light.";
    body = `${sel}<label class="lbl">Destination</label><input id="s-addr" class="field mono" placeholder="Ethereum address (0x…)" autocomplete="off"/>${amount}`;
  } else {
    title = "A point of light"; btn = null;
    hint = "Share this address so others can find you in the dark.";
    body = `<div class="addr-box"><code>${esc(ME?.address || "")}</code></div>`;
  }
  return `<div class="sheet-scrim" id="scrim"><div class="sheet" role="dialog" aria-label="${esc(title)}">
    <div class="sheet-grip"></div>
    <h3 class="sheet-title">${title}</h3>
    <p class="sheet-hint">${hint}</p>
    ${body}
    <div class="sheet-actions">
      ${sheet === "receive" ? `<button class="btn primary" id="s-copy">Copy</button><button class="btn ghost" id="s-cancel">Done</button>`
        : sheet === "deposit" ? `<button class="btn ghost" id="s-cancel">Close</button>`
        : `<button class="btn primary" id="s-go">${btn}</button><button class="btn ghost" id="s-cancel">Cancel</button>`}
    </div>
  </div></div>`;
}

function wireSheet() {
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") { sheet = null; render(); } };
  $("#s-cancel").onclick = () => { sheet = null; render(); };
  document.querySelectorAll(".seg-b").forEach((b) => b.onclick = () => { asset = Number(b.dataset.sasset); render(); });
  const copy = $("#s-copy"); if (copy) copy.onclick = () => { navigator.clipboard?.writeText(ME.address); copy.textContent = "Copied"; };

  // Market sheets
  if (sheet === "mkt-supply" || sheet === "mkt-borrow" || sheet === "mkt-repay") {
    const goBtn = $("#s-go");
    if (goBtn) goBtn.onclick = async () => {
      let amt; try { amt = toRaw($("#s-amt").value || "0", 7); } catch (e) { return toast(e.message); }
      if (amt <= 0n) return toast("Enter an amount");
      if (sheet === "mkt-supply") {
        await supplyToMarket(mktSheetData.positionId, amt, mktSheetData.assetId);
      } else if (sheet === "mkt-borrow") {
        await borrowFromMarket(mktSheetData.positionId, amt, mktSheetData.assetId);
      } else if (sheet === "mkt-repay") {
        await repayToMarket(mktSheetData.positionId, amt, mktSheetData.assetId);
      }
      sheet = null; render();
    };
    return;
  }

  // MetaMask deposit
  const conn = $("#fr-connect"); if (conn) conn.onclick = async () => { try { await doConnectMetaMask(); } catch (e) { toast(e.message || "connect failed"); } };
  const dep = $("#fr-deposit"); if (dep) dep.onclick = () => {
    let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(asset)); } catch (e) { return toast(e.message); }
    if (amt <= 0n) return toast("Enter an amount");
    runDeposit(amt, asset);
  };

  // send / withdraw
  const go = $("#s-go"); if (!go) return;
  go.onclick = () => {
    let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(asset)); } catch (e) { return toast(e.message); }
    if (amt <= 0n) return toast("Enter an amount");
    const addr = $("#s-addr") ? $("#s-addr").value.trim() : "";
    if (!addr) return toast("Enter a destination");
    runAction(sheet, { amt, assetId: asset, addr });
  };
}

// ---- proving ----
const provingView = () => `<div class="screen center proving">
  <img class="prove-eclipse" src="/logo.png" alt="" aria-hidden="true" />
  <p class="prove-status" id="prove-status">entering the wall…</p>
  <p class="prove-sub">Encrypting via Nox TEE. This happens on your device.</p>
</div>`;

// ---- toast ----
let toastT = 0;
function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2600);
}

// ============================ boot ============================
(async () => {
  try { CFG = await (await fetch(`${API_BASE}/api/config`)).json(); } catch { CFG = { error: "Run the relayer (npm run web:server)." }; }
  if (CFG?.assets?.length) asset = CFG.assets[0].id;
  fetchPrices();
  const saved = localStorage.getItem("wall-seed");
  if (saved && !CFG.error) {
    try {
      ME = { seed: saved, address: saved.slice(0, 42) };
      localHist = JSON.parse(localStorage.getItem(histKey()) || "[]");
      history = [...localHist];
      view = "home";
      heartbeat = setInterval(() => { if (ME && !proving) rescan(); }, 20000);
    } catch { localStorage.removeItem("wall-seed"); }
  }
  render();
  if (ME) rescan();
})();
