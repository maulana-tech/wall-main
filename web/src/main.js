// Wall — self-contained privacy wallet on ETH Sepolia.
// No MetaMask needed. Private key stays local. Relayer pays gas.
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";

const EXPLORER = "https://sepolia.etherscan.io/tx";
const $ = (s) => document.querySelector(s);
const API_BASE = import.meta.env.VITE_API_BASE || "";
const IS_EXT = import.meta.env.VITE_EXT === "1";
if (IS_EXT) { try { window.Worker = undefined; self.Worker = undefined; } catch {} document.documentElement.classList.add("ext"); }

const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA_CHAIN_ID = 11155111;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

let CFG = null, wallet = null, noxClient = null;
let notes = [], log = [], history = [], localHist = [];
let view = "landing", sheet = null;
let tab = "portfolio";
let lendTab = "lend";
let asset = 1, proving = false;
let heartbeat = 0;
let prices = { eurUsd: 1.08 };
let mktBusy = false;
let mktSheetData = null;

let mkt = {
  myPositions: [],
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
const balanceOf = (id) => notes.filter((n) => Number(n.assetId) === Number(id)).reduce((a, n) => a + n.amount, 0n);
const humanBal = (id) => Number(toHuman(balanceOf(id), decOf(id)));
const assetUsd = (id) => (/EUR/i.test(symOf(id)) ? prices.eurUsd : 1);
const totalUsd = () => (CFG?.assets || []).reduce((s, a) => s + humanBal(a.id) * assetUsd(a.id), 0);

// ---------- wallet (self-contained, no MetaMask) ----------
function generatePrivateKey() {
  return ethers.hexlify(ethers.randomBytes(32));
}

async function initWallet(privateKey) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const w = new ethers.Wallet(privateKey, provider);
  wallet = { privateKey, address: w.address, signer: w, provider };
  noxClient = await createEthersHandleClient(w.signer);
  return wallet;
}

async function encryptAmount(value) {
  if (!noxClient) throw new Error("Wallet not initialized");
  const result = await noxClient.encryptInput(value);
  return { handle: result.handle, proof: result.proof };
}

async function decryptHandle(handle) {
  if (!noxClient) throw new Error("Wallet not initialized");
  return await noxClient.decrypt(handle);
}

// ---------- ERC-20 ----------
async function erc20Balance(tokenAddress) {
  if (!wallet) return 0n;
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet.provider);
  return await token.balanceOf(wallet.address);
}

async function erc20Approve(tokenAddress, spender, amount) {
  if (!wallet) throw new Error("No wallet");
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet.signer);
  const tx = await token.approve(spender, amount);
  return await tx.wait();
}

// ---------- relayer submission ----------
async function submitToRelayer(action, data) {
  const res = await fetch(`${API_BASE}/api/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "relayer rejected");
  return j.txHash;
}

async function submitMarket(action, data) {
  const res = await fetch(`${API_BASE}/api/market`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "market rejected");
  return j.txHash;
}

// ---------- core actions ----------
async function doDeposit(amount, assetId) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount);
  say("approving token transfer…");
  const tokenAddr = assetId === 1 ? CFG.usdc : CFG.eurc;
  await erc20Approve(tokenAddr, CFG.pool, amount);
  say("submitting deposit to relayer…");
  const txHash = await submitToRelayer("deposit", {
    handle: ethers.hexlify(handle),
    handleProof: ethers.hexlify(proof),
    assetId: String(assetId),
  });
  notes.push({ amount, assetId, txHash, ts: Date.now() });
  say("deposited into the wall");
  return txHash;
}

async function doWithdraw(amount, assetId) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount);
  say("submitting withdrawal to relayer…");
  const txHash = await submitToRelayer("withdraw", {
    handle: ethers.hexlify(handle),
    handleProof: ethers.hexlify(proof),
    assetId: String(assetId),
  });
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
  notes = notes.filter((n) => !(Number(n.assetId) === Number(assetId) && n.amount <= amount));
  say("sent in shadow");
  return txHash;
}

// ---------- faucet ----------
async function mintFaucet() {
  if (!wallet) return toast("Create or import a wallet first");
  try {
    const res = await fetch(`${API_BASE}/api/faucet?to=${wallet.address}`);
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
  if (!CFG?.market || !wallet?.provider) return;
  mkt.loading = true; mkt.err = null;
  try {
    const market = new ethers.Contract(CFG.market, MARKET_ABI, wallet.provider);
    const nextId = Number(await market.nextPositionId());
    const myPos = [];
    for (let i = 1; i < nextId; i++) {
      try {
        const [collateral, debt, owner, assetId, healthFactor] = await market.positions(i);
        if (owner.toLowerCase() === wallet.address.toLowerCase()) {
          myPos.push({ positionId: i, collateral: BigInt(collateral), debt: BigInt(debt), owner, assetId: Number(assetId), healthFactor: Number(healthFactor) });
        }
      } catch { /* skip */ }
    }
    mkt.myPositions = myPos;
    mkt.loadedAt = Date.now();
  } catch (e) { mkt.err = e.message || String(e); }
  mkt.loading = false;
  if (view === "home" && tab === "lending") render();
}

async function openMarketPosition(assetId) {
  if (mktBusy) return;
  mktBusy = true; proving = true; render();
  try {
    await submitMarket("openPosition", { assetId: String(assetId) });
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
    await erc20Approve(tokenAddr, CFG.market, amount);
    await submitMarket("supply", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Supplied to market");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  mktBusy = false; proving = false; render();
}

async function borrowFromMarket(positionId, amount) {
  if (mktBusy) return;
  mktBusy = true; proving = true; render();
  try {
    const { handle, proof } = await encryptAmount(amount);
    await submitMarket("borrow", {
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
    await erc20Approve(tokenAddr, CFG.market, amount);
    await submitMarket("repay", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Repaid to market");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  mktBusy = false; proving = false; render();
}

// ---------- orchestrated actions ----------
async function runDeposit(amt, assetId) {
  if (proving) return;
  proving = true; render();
  try {
    const hash = await doDeposit(amt, assetId);
    pushHistory({ dir: "deposit", amount: amt.toString(), assetId, hash });
    sheet = null;
  } catch (e) { say(e.message || String(e)); proving = false; render(); return; }
  proving = false; render();
}

async function runAction(kind, args) {
  if (proving) return;
  proving = true; render();
  try {
    let hash;
    if (kind === "send") hash = await doTransfer(args.amt, args.assetId, args.addr);
    else if (kind === "withdraw") hash = await doWithdraw(args.amt, args.assetId);
    pushHistory({ dir: kind, amount: args.amt.toString(), assetId: args.assetId, hash });
    sheet = null;
  } catch (e) { say(e.message || String(e)); proving = false; render(); return; }
  proving = false; render();
}

// ---------- activity ----------
const histKey = () => `wall-hist-${(wallet?.address || "anon").slice(0, 10)}`;
function pushHistory(e) {
  localHist.unshift({ ...e, ts: Date.now() });
  localStorage.setItem(histKey(), JSON.stringify(localHist.slice(0, 50)));
  history = [...localHist];
}

// ---------- scan ----------
async function fetchEvents() {
  if (!CFG?.pool || !wallet?.provider) return [];
  const pool = new ethers.Contract(CFG.pool, [
    "event Deposited(address indexed user, uint256 assetId, uint256 amount)",
    "event Withdrawn(address indexed user, uint256 assetId, uint256 amount)",
    "event Transferred(address indexed from, address indexed to, uint256 assetId, uint256 amount)",
  ], wallet.provider);
  const [deps, wds, trs] = await Promise.all([
    pool.queryFilter(pool.filters.Deposited()),
    pool.queryFilter(pool.filters.Withdrawn()),
    pool.queryFilter(pool.filters.Transferred()),
  ]);
  return [...deps.map((e) => ({ ...e, type: "deposit" })), ...wds.map((e) => ({ ...e, type: "withdraw" })), ...trs.map((e) => ({ ...e, type: "transfer" }))];
}

async function rescan() {
  if (!wallet) return;
  say("reading the horizon…");
  try {
    const events = await fetchEvents();
    history = [...events.map((e) => ({
      dir: e.type === "deposit" ? "deposit" : e.type === "withdraw" ? "withdraw" : "send",
      amount: (e.args?.amount || 0n).toString(),
      assetId: Number(e.args?.assetId || 1),
      ts: Date.now(),
      hash: e.transactionHash,
    })), ...localHist.filter((e) => !events.some((ev) => ev.transactionHash === e.hash))]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
    say(`${notes.length} note${notes.length === 1 ? "" : "s"} in shadow`);
  } catch (e) { say("couldn't reach the network"); }
  if (!proving) render();
}

// ---------- identity ----------
function loadWallet(privateKey) {
  const key = privateKey || localStorage.getItem("wall-key");
  if (!key) return false;
  localStorage.setItem("wall-key", key);
  initWallet(key);
  localHist = JSON.parse(localStorage.getItem(histKey()) || "[]");
  history = [...localHist];
  view = "home"; sheet = null; tab = "portfolio";
  clearInterval(heartbeat);
  heartbeat = setInterval(() => { if (wallet && !proving) rescan(); }, 20000);
  render();
  rescan();
  return true;
}

function disconnect() {
  clearInterval(heartbeat);
  localStorage.removeItem("wall-key");
  wallet = null; noxClient = null; notes = []; view = "landing"; sheet = null;
  render();
}

// ---------- prices ----------
async function fetchPrices() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd");
    const j = await r.json();
    if (j?.["euro-coin"]?.usd) { prices.eurUsd = j["euro-coin"].usd; if (wallet) render(); }
  } catch { /* keep fallback */ }
}

// ============================ scramble animation ============================
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";
function scramble(el, target, { speed = 35, stepMs = 600, batchSize = 3 } = {}) {
  if (!el) return;
  el.innerHTML = "";
  const spans = [...target].map((ch) => {
    const s = document.createElement("span");
    s.className = "glyph";
    s.textContent = ch === " " ? "\u00a0" : ch;
    el.appendChild(s);
    return { el: s, final: ch === " " ? "\u00a0" : ch };
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

// ============================ rendering ============================
const brand = `<div class="brand"><img class="brand-logo" src="/logo/logo-wall.png" alt="" aria-hidden="true"/>Wall</div>`;

function render() {
  const app = $("#app");
  document.body.classList.toggle("plain-bg", view === "docs");
  if (!CFG) { app.innerHTML = `<div class="screen center"><img class="hero-eclipse" src="/logo/logo-wall.png" alt="" style="opacity:.6"/></div>`; return; }
  if (CFG.error) { app.innerHTML = `<div class="screen center"><p class="muted">${esc(CFG.error)}</p></div>`; return; }
  if (proving) { app.innerHTML = provingView(); return; }
  if (view === "landing") return void (app.innerHTML = landingView(), wireLanding());
  if (view === "create") return void (app.innerHTML = createView(), wireCreate());
  if (view === "connect") return void (app.innerHTML = connectView(), wireConnect());
  app.innerHTML = homeView() + (sheet ? sheetView() : "");
  wireHome();
  if (sheet) wireSheet();
}

// ---- landing (LaxStell-inspired hero + story + bento + footer) ----
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
        <button class="cta-btn" id="landing-cta">Create your wallet</button>
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
    const goCreate = () => { view = "create"; render(); window.scrollTo(0, 0); };
    if (enter) enter.onclick = goCreate;
    const cta = $("#landing-cta"); if (cta) cta.onclick = goCreate;
    const top = $("#footer-top"); if (top) top.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
    // Intersection observer for story cards
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("visible"); obs.unobserve(e.target); }
    }, { threshold: 0.15 });
    document.querySelectorAll(".story-card").forEach((c) => obs.observe(c));
  });
}

// ---- create wallet ----
const createView = () => `<div class="screen center pane">
  ${brand}
  <h2 class="title sm">Your private key</h2>
  <p class="lede">This single key is the only way back to your wallet. Keep it somewhere safe, because it cannot be recovered.</p>
  <div class="keybox"><code id="pkval">${esc(tmpPk)}</code></div>
  <button class="btn ghost wide" id="copypk">Copy key</button>
  <label class="check"><input type="checkbox" id="saved"/> <span>I've saved my private key</span></label>
  <button class="btn primary" id="open" disabled>Open wallet</button>
  <button class="btn link" id="back">Back</button>
</div>`;

let tmpPk = "";
function wireCreate() {
  $("#copypk").onclick = () => { navigator.clipboard?.writeText(tmpPk); $("#copypk").textContent = "Copied"; };
  $("#saved").onchange = (e) => { $("#open").disabled = !e.target.checked; };
  $("#open").onclick = () => loadWallet(tmpPk);
  $("#back").onclick = () => { view = "landing"; render(); };
}

// ---- connect (import) wallet ----
const connectView = () => `<div class="screen center pane">
  ${brand}
  <h2 class="title sm">Connect wallet</h2>
  <p class="lede">Paste your private key to step back into the shadow.</p>
  <textarea id="pkinput" class="field mono" rows="3" placeholder="0x…"></textarea>
  <button class="btn primary" id="do-connect">Connect</button>
  <button class="btn link" id="back">Back</button>
</div>`;

function wireConnect() {
  $("#do-connect").onclick = () => {
    const pk = $("#pkinput").value.trim();
    if (pk && pk.startsWith("0x") && pk.length === 66) loadWallet(pk);
    else toast("Invalid private key");
  };
  $("#back").onclick = () => { view = "landing"; render(); };
}

// ---- home ----
const TABS = [["portfolio", "Portfolio"], ["lending", "Lending"]];
function homeView() {
  const heroUsd = totalUsd();
  const addr = wallet?.address || "";
  let panel = portfolioPanel();
  if (tab === "lending") panel = lendingPanel();
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
      ${TABS.map(([k, label]) => `<button class="tab ${tab === k ? "on" : ""}" data-tab="${k}">${label}</button>`).join("")}
    </nav>
    ${panel}
  </div>`;
}

// ---- portfolio ----
function portfolioPanel() {
  const assets = CFG?.assets || [];
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
      ${history.length ? history.map((e) => {
        const dirIcon = { deposit: "↧", withdraw: "↥", send: "↗" }[e.dir] || "◐";
        const amt = `${toHuman(e.amount, decOf(e.assetId))} ${symOf(e.assetId)}`;
        const label = { deposit: "Deposited", withdraw: "Withdrew", send: "Sent" }[e.dir] || e.dir;
        const when = new Date(e.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        const link = e.hash ? `<a class="arow-tx" href="${EXPLORER}/tx/${esc(e.hash)}" target="_blank" rel="noopener">↗</a>` : "";
        return `<div class="arow-wrap"><div class="arow lit">
          <span class="ecl ${e.dir}">${dirIcon}</span>
          <span class="arow-main"><span class="dir">${label}</span><span class="when">${esc(when)}</span></span>
          <span class="amt">${esc(amt)}</span>
        </div>${link}</div>`;
      }).join("") : `<p class="empty">Nothing has crossed the horizon yet.</p>`}
    </section>
  </div>`;
}

// ---- lending ----
function lendingPanel() {
  const subTabs = [["lend", "Supply"], ["borrow", "Borrow"], ["positions", "My Positions"]];
  const subnav = `<nav class="subtabs">${subTabs.map(([k, l]) => `<button class="subtab ${lendTab === k ? "on" : ""}" data-lendtab="${k}">${l}</button>`).join("")}</nav>`;
  if (lendTab === "positions") return `<div class="panel">${subnav}${positionsPanel()}</div>`;
  if (lendTab === "borrow") return `<div class="panel">${subnav}${borrowPanel()}</div>`;
  return `<div class="panel">${subnav}${supplyPanel()}</div>`;
}

function supplyPanel() {
  return marketAssets().map((a) => {
    const hasPos = mkt.myPositions.some((p) => p.assetId === a.id);
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
  const positions = mkt.myPositions;
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
  const positions = mkt.myPositions;
  if (!positions.length) return `<p class="empty" style="padding:20px">No positions yet.</p>`;
  return positions.map((p) => {
    const health = p.healthFactor > 0 ? (p.healthFactor / 100).toFixed(2) : "—";
    return `<div class="hrow" style="padding:12px 0;border-bottom:1px solid rgba(128,128,128,0.15)">
      <span class="hrow-main"><span class="hsym">Position #${p.positionId}</span><span class="muted small"> ${esc(mSym(p.assetId))} · health ${esc(health)}</span></span>
      <div class="lp-btns"><button class="lp-b" data-mktsupply="${p.assetId}" data-posid="${p.positionId}">Add Collateral</button></div>
    </div>`;
  }).join("");
}

// ---- wire home ----
function wireHome() {
  $("#disconnect").onclick = disconnect;
  const copyaddr = $("#copyaddr"); if (copyaddr) copyaddr.onclick = () => { navigator.clipboard?.writeText(wallet.address); toast("Address copied"); };
  document.querySelectorAll(".tab[data-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.tab; if (tab === "lending") marketRefresh(); render(); });
  document.querySelectorAll(".subtab[data-lendtab]").forEach((b) => b.onclick = () => { lendTab = b.dataset.lendtab; render(); });
  document.querySelectorAll(".act").forEach((b) => b.onclick = () => { sheet = b.dataset.sheet; render(); });
  document.querySelectorAll("[data-mktopen]").forEach((b) => b.onclick = () => openMarketPosition(Number(b.dataset.mktopen)));
  document.querySelectorAll("[data-mktsupply]").forEach((b) => b.onclick = () => {
    sheet = "mkt-supply"; mktSheetData = { assetId: Number(b.dataset.mktsupply), positionId: Number(b.dataset.posid) || 0 }; render();
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
  let title, body, hint;

  if (sheet === "mkt-supply") {
    const a = assets.find((x) => x.id === mktSheetData?.assetId) || assets[0];
    title = `Supply ${a?.symbol || ""}`; hint = "Supply tokens to your lending position.";
    body = `${amount}`;
  } else if (sheet === "mkt-borrow") {
    title = "Borrow"; hint = "Borrow against your supplied collateral.";
    body = `${amount}`;
  } else if (sheet === "mkt-repay") {
    title = "Repay"; hint = "Repay your outstanding debt.";
    body = `${amount}`;
  } else if (sheet === "send") {
    title = "Send in shadow"; hint = "Amount and recipient stay hidden on-chain.";
    body = `${sel}<label class="lbl">Recipient</label><input id="s-addr" class="field mono" placeholder="0x…" autocomplete="off"/>${amount}`;
  } else if (sheet === "deposit") {
    title = "Into the wall"; hint = "Deposit tokens from your wallet into the pool.";
    body = `${sel}${amount}`;
  } else if (sheet === "withdraw") {
    title = "Toward daybreak"; hint = "Withdraw tokens from the pool back to your wallet.";
    body = `${sel}${amount}`;
  } else {
    title = "Your address"; hint = "Share this so others can send you tokens.";
    body = `<div class="addr-box"><code>${esc(wallet?.address || "")}</code></div>`;
  }

  return `<div class="sheet-scrim" id="scrim"><div class="sheet" role="dialog">
    <div class="sheet-grip"></div>
    <h3 class="sheet-title">${esc(title)}</h3>
    <p class="sheet-hint">${esc(hint)}</p>
    ${body}
    <div class="sheet-actions">
      ${sheet === "receive" ? `<button class="btn primary" id="s-copy">Copy</button><button class="btn ghost" id="s-cancel">Done</button>`
        : `<button class="btn primary" id="s-go">Confirm</button><button class="btn ghost" id="s-cancel">Cancel</button>`}
    </div>
  </div></div>`;
}

function wireSheet() {
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") { sheet = null; render(); } };
  $("#s-cancel").onclick = () => { sheet = null; render(); };
  document.querySelectorAll(".seg-b").forEach((b) => b.onclick = () => { asset = Number(b.dataset.sasset); render(); });
  const copy = $("#s-copy"); if (copy) copy.onclick = () => { navigator.clipboard?.writeText(wallet.address); copy.textContent = "Copied"; };

  if (sheet === "mkt-supply" || sheet === "mkt-borrow" || sheet === "mkt-repay") {
    const goBtn = $("#s-go");
    if (goBtn) goBtn.onclick = async () => {
      let amt; try { amt = toRaw($("#s-amt").value || "0", 7); } catch (e) { return toast(e.message); }
      if (amt <= 0n) return toast("Enter an amount");
      if (sheet === "mkt-supply") await supplyToMarket(mktSheetData.positionId || 1, amt, mktSheetData.assetId);
      else if (sheet === "mkt-borrow") await borrowFromMarket(mktSheetData.positionId, amt);
      else if (sheet === "mkt-repay") await repayToMarket(mktSheetData.positionId, amt, mktSheetData.assetId);
      sheet = null; render();
    };
    return;
  }

  if (sheet === "deposit") {
    const goBtn = $("#s-go");
    if (goBtn) goBtn.onclick = () => {
      let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(asset)); } catch (e) { return toast(e.message); }
      if (amt <= 0n) return toast("Enter an amount");
      runDeposit(amt, asset);
    };
    return;
  }

  const goBtn = $("#s-go");
  if (goBtn) goBtn.onclick = () => {
    let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(asset)); } catch (e) { return toast(e.message); }
    if (amt <= 0n) return toast("Enter an amount");
    if (sheet === "send") {
      const addr = $("#s-addr")?.value?.trim();
      if (!addr || !addr.startsWith("0x")) return toast("Enter a valid address");
      runAction("send", { amt, assetId: asset, addr });
    } else if (sheet === "withdraw") {
      runAction("withdraw", { amt, assetId: asset });
    }
  };
}

// ---- proving ----
const provingView = () => `<div class="screen center proving">
  <img class="prove-eclipse" src="/logo/logo-wall.png" alt="" aria-hidden="true" />
  <p class="prove-status" id="prove-status">encrypting via Nox…</p>
  <p class="prove-sub">Amount encrypted client-side. Relayer submits to chain.</p>
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
  try { CFG = await (await fetch(`${API_BASE}/api/config`)).json(); } catch { CFG = { error: "Could not load config" }; }
  if (CFG?.assets?.length) asset = CFG.assets[0].id;
  fetchPrices();
  const saved = localStorage.getItem("wall-key");
  if (saved && !CFG.error) { loadWallet(saved); }
  else { render(); }
})();
