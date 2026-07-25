// Wall — privacy wallet on ETH Sepolia. Uses Nox for encrypted balances
// and MetaMask for wallet connection. The visual identity is the eclipse:
// balances rest in the wall (shadow) and a corona of light reveals them —
// to the owner on a tap, to the auditor by view key.
import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import { initPoseidon, Note } from "../../client/lib/crypto";
import { buildTree } from "../../client/lib/tree";
import { buildWitness, buildSwapWitness, SWAP_SCALE } from "../../client/lib/transaction";
import { initAuditor, auditorPubOf } from "../../client/lib/auditor";
import { randomSeed, deriveIdentity, decodeAddress } from "../../client/lib/identity";
import { WallPool, WallMarket } from "../../client/lib/eth";

const WASM_URL = "/transfer.wasm", ZKEY_URL = "/transfer_final.zkey";
const SWAP_WASM_URL = "/swap.wasm", SWAP_ZKEY_URL = "/swap_final.zkey";
const SEED_KEY = "wall-seed";
const EXPLORER = "https://sepolia.etherscan.io/tx"; // tx links in Activity
const $ = (s) => document.querySelector(s);

// Build targets: the web app talks to same-origin /api; the MV3 extension popup
// (VITE_EXT=1) talks to the deployed relayer (VITE_API_BASE) and proves single-
// threaded so snarkjs never spawns a blob: Worker the extension CSP would block.
// MetaMask isn't reachable from an extension popup, so deposits open the web app.
const API_BASE = import.meta.env.VITE_API_BASE || "";
const IS_EXT = import.meta.env.VITE_EXT === "1";
if (IS_EXT) { try { window.Worker = undefined; self.Worker = undefined; } catch {} document.documentElement.classList.add("ext"); }

let CFG, ME = null, notes = [], log = [], history = [], localHist = [];
let lastGroups = [], lastOwned = []; // cached chain state for instant activity rebuilds
let view = "landing", sheet = null, tmpSeed = "";
let tab = "portfolio"; // top section: portfolio | swap | lending
let swapSub = "swap"; // within Swap: swap | lp
let lendSub = "lend"; // within Lending: lend | borrow
let swapFrom = 1, swapTo = 2; // swap direction (asset ids)
let swapOracleRate = null; // pool's on-chain oracle EUR/USD in SWAP_SCALE (1e6), cached
// on-chain market snapshot (reserves, APYs, the identity's positions + balances)
let mkt = { stats: {}, pos: {}, health: null, power: 0n, idBal: {}, loadedAt: 0, loading: false, err: null };
let mktSheet = null; // { fn: "supply"|"withdraw"|"borrow"|"repay", id } while a market action sheet is open
let mktBusy = false;
let liqList = [], liqLoading = false; // liquidatable positions (keeper view)
// DeFi identity: an Ethereum keypair derived from the wallet seed (a fresh pseudonym,
// NOT MetaMask). It signs market ops; the relayer pays the gas (fee-bump). Funded
// privately by withdrawing shielded USDC to its address.
let mid = null; // { kp, address, active } for the ACTIVE position
let posIndex = 0, posMax = 0; // active position + highest opened (each = a fresh, unlinkable identity)
let asset = 1, proving = false, revealBalance = false, reveals = new Set();
let discCanvas = null, disc = null, heartbeat = 0;
let fr = null; // { address, status: {hasTrust, raw} } — connected MetaMask account
let prices = { eurUsd: 1.08 }; // EURC/EUR price in USD (fetched; fallback)
let auditorPriv = null; // set when the auditor logs in with their key
let auditRows = []; // reconstructed disclosure rows (for live filtering + export)

// ---------- amount helpers ----------
const assetById = (id) => (CFG.assets || []).find((a) => Number(a.id) === Number(id));
const decOf = (id) => assetById(id)?.decimals ?? 7;
const symOf = (id) => assetById(id)?.symbol || `#${id}`;
function toRaw(human, d) {
  const s = String(human).trim();
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) throw new Error("enter a valid amount");
  const [int, frac = ""] = s.split(".");
  if (frac.length > d) throw new Error(`${symOf(asset)} allows at most ${d} decimals`);
  return BigInt((int || "0") + frac.padEnd(d, "0"));
}
// parse a human amount against a specific asset id (independent of the global `asset`)
function toRawAs(human, id) {
  const d = decOf(id), s = String(human).trim();
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) throw new Error("enter a valid amount");
  const [int, frac = ""] = s.split(".");
  if (frac.length > d) throw new Error(`${symOf(id)} allows at most ${d} decimals`);
  return BigInt((int || "0") + frac.padEnd(d, "0"));
}
function toHuman(raw, d) {
  const s = BigInt(raw).toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d), frac = d ? s.slice(s.length - d).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}
const balanceOf = (id) => notes.filter((n) => Number(n.assetId) === Number(id)).reduce((a, n) => a + n.amount, 0n);
const noteCount = (id) => notes.filter((n) => Number(n.assetId) === Number(id)).length;
// portfolio valuation: USDC = $1, EURC = EUR/USD rate. The total can be expressed
// in any asset's unit (the home toggle).
const humanBal = (id) => Number(toHuman(balanceOf(id), decOf(id)));
// USD value of one unit of an asset: EURC ≈ EUR/USD, USDC (and other USD) ≈ $1.
const assetUsd = (id) => (/EUR/i.test(symOf(id)) ? prices.eurUsd : 1);
const totalUsd = () => (CFG.assets || []).reduce((s, a) => s + humanBal(a.id) * assetUsd(a.id), 0);
const fmtNum = (n, dp) => (isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: dp }) : "0");
async function fetchPrices() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd");
    const j = await r.json();
    if (j?.["euro-coin"]?.usd) { prices.eurUsd = j["euro-coin"].usd; if (ME) render(); }
  } catch { /* keep fallback */ }
}
const short = (s, n = 5) => (s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || "");

// ---------- Wall Market (transparent money-market + AMM) ----------
// The market runs on testnet USDC/EURC (mintable) so reserves, fees and APYs are
// real and verifiable on-chain. Anonymity comes from the shielded pool that funds
// the addresses interacting here. All reads are on-chain (no mock numbers).
const SWAP_FEE_BPS = 30n;
const marketAssets = () => CFG.marketAssets || [];
const mAssetById = (id) => marketAssets().find((a) => Number(a.id) === Number(id));
const mSym = (id) => mAssetById(id)?.symbol || `#${id}`;
const mDec = (id) => mAssetById(id)?.decimals ?? 7;
// Source for read-only view simulations: must be a funded account. The DeFi
// identity may not exist on-chain yet (before activation), so always use the
// relayer/admin address, which is always funded. (Views take the user as an arg.)
const mktSrc = () => CFG.userAddr;
const pct = (bps) => (Number(bps) / 100).toFixed(2); // basis points -> percent string
const mPriceUsd = (id) => Number(mkt.stats[id]?.price || (id === 2 ? 11400000n : 10000000n)) / 1e7;
const mIdBal = (id) => mkt.idBal[id] ?? 0n; // the DeFi identity's on-chain token balance
// derive the ACTIVE position's DeFi identity (a fresh pseudonym per position, so
// positions are unlinkable to each other on-chain — like swap B, but per position).
const posKey = () => `wall-pos-${ME.seed.slice(0, 8)}`;
function loadPos() { try { const p = JSON.parse(localStorage.getItem(posKey()) || "{}"); posIndex = p.active || 0; posMax = p.max || 0; } catch { posIndex = 0; posMax = 0; } }
function savePos() { localStorage.setItem(posKey(), JSON.stringify({ active: posIndex, max: posMax })); }
function initMid() { try { const kp = deriveMarketKey(ME.seed, posIndex); mid = { kp, address: kp.publicKey(), active: false }; } catch { mid = null; } }
// open a brand-new, unlinkable position (a fresh identity)
function newPosition() { posMax += 1; posIndex = posMax; savePos(); mkt = { stats: {}, pos: {}, health: null, power: 0n, idBal: {}, loadedAt: 0, loading: false, err: null }; initMid(); toast(`New private position #${posIndex + 1}`); render(); marketRefresh(); }
function switchPosition(i) { if (i < 0 || i > posMax) return; posIndex = i; savePos(); mkt = { stats: {}, pos: {}, health: null, power: 0n, idBal: {}, loadedAt: 0, loading: false, err: null }; initMid(); render(); marketRefresh(); }

// Read the whole market state from chain: per-asset reserves/APY + the DeFi
// identity's positions, health, balances and activation status. Then re-render.
async function marketRefresh() {
  if (!CFG.market) return;
  mkt.loading = true; mkt.err = null;
  try {
    const src = mktSrc();
    const stats = {}, pos = {};
    let anyTrust = false, acctExists = true;
    for (const a of marketAssets()) {
      const id = a.id;
      const [reserve, sup, bor, sApy, bApy, util, price] = await Promise.all([
        readViewAs(CFG.market, src, "reserve", [mU(id)]),
        readViewAs(CFG.market, src, "total_supplied", [mU(id)]),
        readViewAs(CFG.market, src, "total_borrowed", [mU(id)]),
        readViewAs(CFG.market, src, "supply_rate_bps", [mU(id)]),
        readViewAs(CFG.market, src, "borrow_rate_bps", [mU(id)]),
        readViewAs(CFG.market, src, "utilization_bps", [mU(id)]),
        readViewAs(CFG.market, src, "price", [mU(id)]),
      ]);
      stats[id] = { reserve, sup, bor, sApy, bApy, util, price };
      if (mid) {
        const p = await readViewAs(CFG.market, src, "position", [mA(mid.address), mU(id)]);
        pos[id] = { supplied: BigInt(p.supplied), borrowed: BigInt(p.borrowed) };
        try {
          const st = await assetStatus(mid.address, a.code, a.issuer, a.decimals);
          acctExists = acctExists && st.exists;
          mkt.idBal[id] = st.hasTrust ? st.raw : 0n; mkt.idBal[`trust${id}`] = st.hasTrust;
          if (st.hasTrust) anyTrust = true;
        } catch { mkt.idBal[id] = 0n; }
      }
    }
    if (mid) {
      mkt.health = await readViewAs(CFG.market, src, "health", [mA(mid.address)]);
      // "active" = the identity account exists and trusts the market assets
      mid.active = acctExists && marketAssets().every((a) => mkt.idBal[`trust${a.id}`]);
    }
    mkt.stats = stats; mkt.pos = pos; mkt.loadedAt = Date.now();
  } catch (e) { mkt.err = e.message || String(e); }
  mkt.loading = false;
  if (ME && tab === "lending") render();
}
// USD value of supplied collateral / debt across both market assets (for the hero)
const mSuppliedUsd = () => marketAssets().reduce((s, a) => s + Number(toHuman(mkt.pos[a.id]?.supplied || 0n, mDec(a.id))) * mPriceUsd(a.id), 0);
const mDebtUsd = () => marketAssets().reduce((s, a) => s + Number(toHuman(mkt.pos[a.id]?.borrowed || 0n, mDec(a.id))) * mPriceUsd(a.id), 0);
const MKT_LTV = 0.8; // matches the contract's collateral factor
const mBorrowableUsd = () => Math.max(0, mSuppliedUsd() * MKT_LTV - mDebtUsd());
// quote a swap output from the on-chain price + fee (mirrors the contract math)
function mSwapQuote(fromId, toId, amtIn) {
  const pin = BigInt(mkt.stats[fromId]?.price || 0n), pout = BigInt(mkt.stats[toId]?.price || 0n);
  if (!pin || !pout || amtIn <= 0n) return { out: 0n, fee: 0n };
  const fee = (amtIn * SWAP_FEE_BPS) / 10000n;
  const usdVal = ((amtIn - fee) * pin) / 10000000n;
  const out = (usdVal * 10000000n) / pout;
  return { out, fee };
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// status line — patch in place during proving so the disc canvas is never torn down
const say = (m) => { log.unshift(`${new Date().toLocaleTimeString().slice(0, 8)}  ${m}`); const el = $("#prove-status"); if (proving && el) el.textContent = m.replace(/^[^ ]+ +/, ""); else render(); };

// ---------- identity ----------
const histKey = () => `wall-hist-${ME.seed.slice(0, 8)}`;
const spentKey = () => `wall-spent-${ME.seed.slice(0, 8)}`;

// Reconstruct the wallet's activity purely from the chain (like Zcash/Railgun):
// group events by transaction, then for each tx decide my role from what it
// SPENT vs what it CREATED for me.
//  - I spent an input note in this tx  → it's MY outgoing tx; net out = inputs −
//    my change → "Sent" (the device that made it overlays the precise
//    Deposited/Withdrew label + the amount via mergeActivity).
//  - I own an output but spent nothing → value came IN → "Received".
//  - net out == 0 (a merge / self-transfer) → not user-facing, skipped.
// owned = every note I can decrypt (spent or not), so I can match my spent inputs.
function deriveActivity(groups, owned) {
  const byCommit = new Map(owned.map((o) => [o.commitment || o.note.commitment().toString(), o]));
  const byNull = new Map(owned.map((o) => [nullifierHex(o.note.nullifier(o.index)), o]));
  const acts = [];
  for (const g of groups) {
    const myOuts = g.commits.map((c) => byCommit.get(c.commitment)).filter(Boolean).filter((o) => o.amount > 0n);
    const mySpent = g.nullifiers.map((n) => byNull.get(n)).filter(Boolean);
    if (!myOuts.length && !mySpent.length) continue;
    const ts = Date.parse(g.ts) || Date.now();
    if (mySpent.length) {
      // a swap spends one asset and creates a note of a DIFFERENT asset (plus change
      // in the original asset): detect it so it isn't mislabeled as a send.
      const fromId = Number(mySpent[0].assetId);
      const swapOuts = myOuts.filter((o) => Number(o.assetId) !== fromId);
      if (swapOuts.length) {
        const change = myOuts.filter((o) => Number(o.assetId) === fromId).reduce((s, o) => s + o.amount, 0n);
        const inAmt = mySpent.reduce((s, o) => s + o.amount, 0n) - change;
        const outAmt = swapOuts.reduce((s, o) => s + o.amount, 0n);
        acts.push({ dir: "swap", amount: inAmt.toString(), assetId: fromId, outAmount: outAmt.toString(), outAssetId: Number(swapOuts[0].assetId), ts, hash: g.hash });
        continue;
      }
      const net = mySpent.reduce((s, o) => s + o.amount, 0n) - myOuts.reduce((s, o) => s + o.amount, 0n);
      if (net <= 0n) continue; // merge / self-send — no net movement to show
      acts.push({ dir: "send", amount: net.toString(), assetId: Number(mySpent[0].assetId), ts, hash: g.hash });
    } else {
      for (const o of myOuts) acts.push({ dir: "receive", amount: o.amount.toString(), assetId: Number(o.assetId), ts, hash: g.hash });
    }
  }
  return acts;
}
// Merge the chain-derived list with this device's local action log (which knows
// the precise Deposited / Sent / Withdrew label, by txHash). Local entries not
// yet on-chain show immediately; once indexed, the chain entry takes over.
function mergeActivity(derived) {
  const dHashes = new Set(derived.map((d) => d.hash));
  const localByHash = new Map(localHist.filter((e) => e.hash).map((e) => [e.hash, e]));
  const overlaid = derived.map((d) => { const l = localByHash.get(d.hash); return l ? { ...d, dir: l.dir } : d; });
  const pending = localHist.filter((e) => !e.hash || !dHashes.has(e.hash)); // recent, not indexed yet
  const out = [], seen = new Set();
  for (const e of [...overlaid, ...pending]) { const k = e.hash || `${e.dir}-${e.ts}`; if (seen.has(k)) continue; seen.add(k); out.push(e); }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
}
// Is this pasted key the auditor's? (its public key matches the pool's pinned one)
function isAuditorKey(s) {
  if (!CFG.auditorPubX || !/^[0-9]+$/.test(s)) return false; // auditor key is a decimal scalar
  const pub = auditorPubOf(s);
  return !!pub && pub.pubX === CFG.auditorPubX && pub.pubY === CFG.auditorPubY;
}
function connect(seed) {
  const s = String(seed).trim();
  // The auditor logs in with their key: if it matches the pool's auditor key, open
  // the disclosure dashboard instead of a wallet (the key IS their credential).
  if (isAuditorKey(s)) { auditorPriv = s; view = "auditor"; render(); return; }
  ME = deriveIdentity(s);
  localStorage.setItem(SEED_KEY, ME.seed);
  localHist = JSON.parse(localStorage.getItem(histKey()) || "[]");
  history = [...localHist];
  view = "home"; sheet = null; tab = "portfolio"; notes = []; revealBalance = false;
  loadPos(); initMid(); marketRefresh();
  // heartbeat: keep balances converging even if testnet indexing lags the action
  clearInterval(heartbeat);
  heartbeat = setInterval(() => { if (ME && !proving) rescan(); }, 20000);
  render(); rescan();
}
function disconnect() { clearInterval(heartbeat); localStorage.removeItem(SEED_KEY); ME = null; notes = []; view = "landing"; sheet = null; render(); }
// Record an action THIS device performed (precise label + tx hash). The rendered
// history is rebuilt from chain on each scan (mergeActivity overlays these).
function pushHistory(e) {
  localHist.unshift({ ...e, ts: Date.now() });
  localStorage.setItem(histKey(), JSON.stringify(localHist.slice(0, 50)));
  history = mergeActivity(deriveActivity(lastGroups, lastOwned));
}

// ---------- chain ----------
async function rescan() {
  if (!ME) return;
  say("reading the horizon…");
  try {
    // one pass: tx-grouped events drive BOTH the balance and the activity history
    const { groups, commits, spent: onchainSpent } = await fetchTxGroups(CFG.poolId, CFG.startLedger);
    window.__tree = buildTree(commits.map((e) => e.commitment));
    const owned = scanOwned(commits, ME.viewSecret, ME.spend); // every note I can decrypt (spent or not)
    const localSpent = new Set(JSON.parse(localStorage.getItem(spentKey()) || "[]"));
    notes = owned.filter((n) => {
      const h = nullifierHex(n.note.nullifier(n.index));
      return !onchainSpent.has(h) && !localSpent.has(h);
    });
    lastGroups = groups; lastOwned = owned;
    history = mergeActivity(deriveActivity(groups, owned)); // full history, reconstructed from chain
    say(`${notes.length} note${notes.length === 1 ? "" : "s"} in shadow`);
  } catch (e) { say("couldn't reach the network. retrying soon"); }
  if (!proving) render();
}
function scheduleRescans() { [6000, 14000, 25000, 40000].forEach((ms) => setTimeout(rescan, ms)); }
function markSpent(ns) {
  const s = new Set(JSON.parse(localStorage.getItem(spentKey()) || "[]"));
  ns.forEach((n) => s.add(nullifierHex(n.note.nullifier(n.index))));
  localStorage.setItem(spentKey(), JSON.stringify([...s]));
}
function selectInputs(amount, assetId) {
  const mine = notes.filter((n) => Number(n.assetId) === Number(assetId)).sort((a, b) => (a.amount < b.amount ? 1 : -1));
  const chosen = []; let sum = 0n;
  for (const n of mine) { if (sum >= amount) break; chosen.push(n); sum += n.amount; }
  if (sum < amount) throw new Error(`not enough ${symOf(assetId)} in shadow`);
  if (chosen.length > 2) throw new Error("this amount spans more than 2 notes. merge them first");
  return { chosen, sum };
}

async function proveAndSubmit(params, { recipient, extAmount, assetId }) {
  say("entering the wall. proving privately…");
  const r = buildWitness({ ...params, assetId, auditor: { pubX: CFG.auditorPubX, pubY: CFG.auditorPubY } });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(r.witness, WASM_URL, ZKEY_URL);
  say("proof formed. crossing the horizon…");
  const res = await fetch(`${API_BASE}/api/submit`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proof: proofToHex(proof), public: publicToHex(publicSignals), caller: CFG.userAddr, recipient, extAmount: String(extAmount), fee: "0", enc1: r.enc1, enc2: r.enc2 }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  say("settled in shadow");
  return j.hash;
}
const enc = (recipients) => ({ senderViewPub: ME.viewPub, recipients });

async function doShield(amount, assetId) {
  const note = new Note({ amount, assetId, owner: ME.spend });
  const hash = await proveAndSubmit({ tree: window.__tree, inputs: [], outputs: [note], publicAmount: amount, extData: { recipient: CFG.userAddr, extAmount: String(amount), fee: "0" }, enc: enc([ME.viewPub]) }, { recipient: CFG.userAddr, extAmount: amount, assetId });
  scheduleRescans(); return hash;
}
async function doSend(amount, assetId, addr) {
  const { chosen, sum } = selectInputs(amount, assetId);
  const rcpt = decodeAddress(addr);
  const toR = new Note({ amount, assetId, owner: rcpt.spendPub });
  const change = new Note({ amount: sum - amount, assetId, owner: ME.spend });
  const hash = await proveAndSubmit({ tree: window.__tree, inputs: chosen.map((n) => ({ note: n.note, index: n.index })), outputs: [toR, change], publicAmount: 0n, extData: { recipient: CFG.userAddr, extAmount: "0", fee: "0" }, enc: enc([rcpt.viewPub, ME.viewPub]) }, { recipient: CFG.userAddr, extAmount: 0, assetId });
  markSpent(chosen); scheduleRescans(); return hash;
}
async function doUnshield(amount, assetId, ethAddr) {
  // Pre-flight the destination: the pool → recipient payout reverts on-chain if
  // the account doesn't exist or lacks a trustline for the asset. Surface that as
  // a clear message instead of a cryptic failed transaction.
  const a = assetById(assetId);
  const st = await assetStatus(ethAddr, a.code, a.issuer, a.decimals);
  if (!st.exists) throw new Error(`Destination ${short(ethAddr, 4)} isn't activated on Ethereum yet. Fund it first.`);
  if (!st.hasTrust) throw new Error(`Destination has no ${a.symbol} trustline, so it can't receive ${a.symbol}. Add the trustline there first.`);
  const { chosen, sum } = selectInputs(amount, assetId);
  const change = new Note({ amount: sum - amount, assetId, owner: ME.spend });
  const hash = await proveAndSubmit({ tree: window.__tree, inputs: chosen.map((n) => ({ note: n.note, index: n.index })), outputs: [change], publicAmount: -amount, extData: { recipient: ethAddr, extAmount: String(-amount), fee: "0" }, enc: enc([ME.viewPub]) }, { recipient: ethAddr, extAmount: -amount, assetId });
  markSpent(chosen); scheduleRescans(); return hash;
}
async function doConsolidate(assetId) {
  const mine = notes.filter((n) => Number(n.assetId) === Number(assetId)).sort((a, b) => (a.amount < b.amount ? -1 : 1));
  if (mine.length < 2) throw new Error("nothing to merge");
  const [n1, n2] = mine;
  const merged = new Note({ amount: n1.amount + n2.amount, assetId, owner: ME.spend });
  await proveAndSubmit({ tree: window.__tree, inputs: [{ note: n1.note, index: n1.index }, { note: n2.note, index: n2.index }], outputs: [merged], publicAmount: 0n, extData: { recipient: CFG.userAddr, extAmount: "0", fee: "0" }, enc: enc([ME.viewPub]) }, { recipient: CFG.userAddr, extAmount: 0, assetId });
  markSpent([n1, n2]); scheduleRescans();
}

// ---------- Shielded SWAP (amounts AND assets hidden) ----------
// A private exchange inside the shielded pool: you burn from-asset notes and mint a
// to-asset note + change, value conserved at the public oracle rate. Amounts and the
// asset of each note stay hidden (only the rate + a tiny rounding fee are public);
// the auditor ciphertext is enforced. It is internal (no token moves), so it is as
// private as a transfer and needs no liquidity for the swap itself.
// Prefer the pool's on-chain oracle rate (so the proof matches what `swap` checks);
// fall back to the live EUR/USD price until it's fetched / on an oracle-less pool.
const swapRate = () => (swapOracleRate ?? BigInt(Math.round(prices.eurUsd * Number(SWAP_SCALE))));
let swapRateAt = 0;
async function fetchSwapRate() {
  if (Date.now() - swapRateAt < 15000) return; // throttle: no re-render loop
  swapRateAt = Date.now();
  try {
    const r = await readViewAs(CFG.poolId, mktSrc(), "oracle_rate", []);
    if (r && BigInt(r) > 0n && BigInt(r) !== swapOracleRate) { swapOracleRate = BigInt(r); if (ME && tab === "swap") render(); }
  } catch { /* pool has no oracle (pre-binding) — keep the local fallback */ }
}
const priceOfId = (id, rate) => (Number(id) === 2 ? rate : SWAP_SCALE); // USD price of one unit
function swapQuote(fromId, toId, amtIn, rate) {
  const valueIn = amtIn * priceOfId(fromId, rate);
  const out = valueIn / priceOfId(toId, rate); // floor
  const feeValue = valueIn - out * priceOfId(toId, rate); // rounding remainder (public, tiny)
  return { out, feeValue };
}
async function doSwap(fromId, toId, amtIn) {
  const { chosen, sum } = selectInputs(amtIn, fromId);
  const rate = swapRate();
  const { out, feeValue } = swapQuote(fromId, toId, amtIn, rate);
  if (out <= 0n) throw new Error("amount too small to swap");
  const toNote = new Note({ amount: out, assetId: BigInt(toId), owner: ME.spend });
  const change = new Note({ amount: sum - amtIn, assetId: BigInt(fromId), owner: ME.spend });
  const w = buildSwapWitness({
    tree: window.__tree, inputs: chosen.map((n) => ({ note: n.note, index: n.index })),
    outputs: [toNote, change], rate, feeValue,
    extData: { recipient: "swap", extAmount: "0", fee: "0" }, enc: enc([ME.viewPub, ME.viewPub]),
    auditor: { pubX: CFG.auditorPubX, pubY: CFG.auditorPubY },
  });
  say("entering the wall. proving the swap privately…");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(w.witness, SWAP_WASM_URL, SWAP_ZKEY_URL);
  say("proof formed. crossing the horizon…");
  const res = await fetch(`${API_BASE}/api/swap`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proof: proofToHex(proof), public: publicToHex(publicSignals), enc1: w.enc1, enc2: w.enc2 }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "swap rejected");
  say("settled in shadow");
  markSpent(chosen); scheduleRescans();
  return { hash: j.hash, out };
}
async function runSwap(fromId, toId, amtIn) {
  if (proving) return;
  proving = true; render(); disc?.occult();
  try {
    await rescan();
    const { hash, out } = await doSwap(fromId, toId, amtIn);
    pushHistory({ dir: "swap", amount: amtIn.toString(), assetId: fromId, outAmount: out.toString(), outAssetId: toId, hash });
    disc?.settle();
    toast(`Swapped privately`);
  } catch (e) { say(e.message || String(e)); toast(humanizeErr(e.message || String(e))); disc?.idle(); proving = false; render(); return; }
  proving = false; setTimeout(() => disc?.idle(), 1400); render();
}

// All market actions are signed by the DeFi identity (relayer-sponsored) and settle
// on the transparent market contract; each runs the proving overlay, then refreshes.
async function runMarket(label, fn, args, onDone) {
  if (mktBusy) return;
  if (!mid?.active) { toast("Activate your DeFi identity first"); return; }
  mktBusy = true; proving = true; render();
  try {
    const hash = await submitViaRelayer({ marketId: CFG.market, kp: mid.kp, fn, args, apiBase: API_BASE, rpcUrl: CFG.rpc });
    toast(label);
    if (onDone) onDone(hash);
  } catch (e) { proving = false; mktBusy = false; toast(humanizeErr(e.message || String(e))); render(); return; }
  proving = false; mktBusy = false;
  sheet = null; mktSheet = null; render();
  marketRefresh();
}
// Activate the DeFi identity: friendbot-fund it + add trustlines (relayer-paid),
// so the wallet's pseudonym can hold and move USDC/EURC without MetaMask or gas.
async function activateIdentity() {
  if (!mid) return;
  if (mktBusy) return;
  mktBusy = true; proving = true; render();
  try {
    await bootstrapIdentity({ kp: mid.kp, assets: marketAssets(), apiBase: API_BASE, rpcUrl: CFG.rpc, friendbot: CFG.friendbot });
    toast("DeFi identity activated");
  } catch (e) { proving = false; mktBusy = false; toast(humanizeErr(e.message || String(e))); render(); return; }
  proving = false; mktBusy = false; render();
  await marketRefresh();
}
// turn a raw contract panic into a readable reason
function humanizeErr(m) {
  if (/insufficient pool liquidity/i.test(m)) return "Not enough liquidity in the pool for that amount";
  if (/borrow limit|collateral/i.test(m)) return "That would exceed your borrow limit";
  if (/slippage/i.test(m)) return "Price moved: output below the minimum";
  if (/Error\(Contract, #?\d*\)/.test(m) || /trap/i.test(m)) return "The market rejected this (check amount, trustline and balance)";
  return m.length > 120 ? m.slice(0, 120) + "…" : m;
}
// Swap-pool LP actions target the shielded POOL contract (not the market); signed
// by the DeFi identity, gas fee-bumped by the relayer.
async function runLp(label, fn, args) {
  if (mktBusy) return;
  if (!mid?.active) { toast("Activate your DeFi identity first"); return; }
  mktBusy = true; proving = true; render();
  try { await submitViaRelayer({ marketId: CFG.poolId, kp: mid.kp, fn, args, apiBase: API_BASE, rpcUrl: CFG.rpc }); toast(label); }
  catch (e) { proving = false; mktBusy = false; toast(humanizeErr(e.message || String(e))); render(); return; }
  proving = false; mktBusy = false; sheet = null; mktSheet = null; render();
  fetchSwapDepth();
}
const runAddLiq = (id, amt) => runLp(`Provided ${toHuman(amt, decOf(id))} ${symOf(id)} of swap liquidity`, "add_liquidity", [mA(mid.address), mU(id), mI(amt)]);
const runRemLiq = (id) => runLp(`Withdrew swap liquidity in ${symOf(id)}`, "remove_liquidity", [mA(mid.address), mU(id), mI(swapDepth.shares || 0n)]);
const runSupply = (id, amt) => runMarket(`Supplied ${toHuman(amt, mDec(id))} ${mSym(id)}`, "supply", [mA(mid.address), mU(id), mI(amt)]);
const runWithdrawMkt = (id, amt) => runMarket(`Withdrew ${toHuman(amt, mDec(id))} ${mSym(id)}`, "withdraw", [mA(mid.address), mU(id), mI(amt)]);
const runBorrow = (id, amt) => runMarket(`Borrowed ${toHuman(amt, mDec(id))} ${mSym(id)}`, "borrow", [mA(mid.address), mU(id), mI(amt)]);
const runRepay = (id, amt) => runMarket(`Repaid ${toHuman(amt, mDec(id))} ${mSym(id)}`, "repay", [mA(mid.address), mU(id), mI(amt)]);

// ---------- MetaMask (self-custodial deposits) ----------
async function refreshFr() {
  if (!fr) return;
  const a = assetById(asset);
  try { fr.status = await assetStatus(fr.address, a.code, a.issuer, a.decimals); } catch { fr.status = { hasTrust: false, raw: 0n }; }
}
async function doConnectMetaMask() {
  if (!(await metamaskInstalled())) { toast("Install the MetaMask wallet extension"); window.open("https://www.metamask.app/", "_blank"); return; }
  fr = { address: await connectMetaMask(), status: null };
  await refreshFr();
  render();
}

// Deposit (shield) — signed and paid BY THE USER via MetaMask. caller == the
// user's Ethereum account; their own public USDC moves into the pool.
async function runDeposit(amt, assetId) {
  if (proving) return;
  if (!fr) { toast("Connect MetaMask first"); return; }
  proving = true; render(); disc?.occult();
  try {
    await rescan();
    const note = new Note({ amount: amt, assetId, owner: ME.spend });
    const r = buildWitness({
      tree: window.__tree, inputs: [], outputs: [note], publicAmount: amt, assetId,
      extData: { recipient: fr.address, extAmount: String(amt), fee: "0" }, enc: enc([ME.viewPub]),
      auditor: { pubX: CFG.auditorPubX, pubY: CFG.auditorPubY },
    });
    say("entering the wall. proving privately…");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(r.witness, WASM_URL, ZKEY_URL);
    say("sign the deposit in MetaMask…");
    const hash = await submitTransact({
      poolId: CFG.poolId, caller: fr.address, recipient: fr.address,
      proofHex: proofToHex(proof), publicHex: publicToHex(publicSignals),
      extAmount: amt.toString(), fee: 0, enc1: r.enc1, enc2: r.enc2,
      signXdr: metamaskSign, rpcUrl: CFG.rpc,
    });
    say("settled in shadow");
    pushHistory({ dir: "deposit", amount: amt.toString(), assetId, hash });
    disc?.settle(); sheet = null; await refreshFr();
  } catch (e) { say(e.message || String(e)); disc?.idle(); proving = false; render(); return; }
  proving = false; setTimeout(() => disc?.idle(), 1400); scheduleRescans(); render();
}

// orchestrated action runner — drives the occultation around the proof
async function runAction(kind, args) {
  if (proving) return;
  proving = true; render(); disc?.occult();
  try {
    await rescan();
    let hash;
    if (kind === "deposit") hash = await doShield(args.amt, args.assetId);
    else if (kind === "send") hash = await doSend(args.amt, args.assetId, args.addr);
    else if (kind === "withdraw") hash = await doUnshield(args.amt, args.assetId, args.addr);
    else if (kind === "merge") await doConsolidate(args.assetId);
    if (kind !== "merge") pushHistory({ dir: kind, amount: args.amt.toString(), assetId: args.assetId, hash });
    disc?.settle();
    sheet = null;
  } catch (e) { say(e.message || String(e)); disc?.idle(); proving = false; render(); return; }
  proving = false;
  setTimeout(() => disc?.idle(), 1400);
  render();
}

// Reconstruct each transaction's flow from the chain, as only the auditor can:
// decrypt the output notes (enforced ElGamal ciphertexts), group them by tx, and
// read off who paid whom. By the wallet's output convention the first output of a
// transfer is the recipient and the second is the sender's change, so output[0].owner
// is the recipient and output[1].owner is the sender.
function auditTable(groups, decoded) {
  const byIdx = new Map(decoded.map((d) => [d.index, d]));
  const rows = [];
  for (const g of groups) {
    const outs = g.commits.map((c) => byIdx.get(c.index)).filter(Boolean).sort((a, b) => a.index - b.index);
    if (!outs.length) continue;
    const base = { ts: g.ts, ledger: g.ledger, hash: g.hash };
    if (outs.some((o) => o.opaque)) { rows.push({ ...base, sealed: true }); continue; }
    const nz = outs.filter((o) => BigInt(o.amount) > 0n);
    if (nz.length >= 2) rows.push({ ...base, from: outs[1].owner, to: outs[0].owner, amount: outs[0].amount, assetId: outs[0].assetId });
    else if (nz.length === 1) rows.push({ ...base, deposit: true, to: nz[0].owner, amount: nz[0].amount, assetId: nz[0].assetId });
  }
  return rows.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
}
const auditTime = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
// One card per transaction — readable in the wallet's narrow (phone/extension) layout.
function auditCards(rows) {
  return rows.map((r) => {
    if (r.sealed) return `<div class="aud-card sealed"><div class="aud-c-meta">${esc(auditTime(r.ts))} · block ${r.ledger} · sealed (wrong key)</div></div>`;
    const parties = r.deposit
      ? `<span class="aud-tag">deposit</span><span class="aud-arrow">→</span><code>${esc(short(r.to, 5))}</code>`
      : `<code>${esc(short(r.from, 5))}</code><span class="aud-arrow">→</span><code>${esc(short(r.to, 5))}</code>`;
    return `<div class="aud-card">
      <div class="aud-c-top">
        <span class="aud-parties">${parties}</span>
        <span class="aud-c-amt">${esc(toHuman(r.amount, decOf(r.assetId)))} <span class="u">${esc(symOf(r.assetId))}</span></span>
      </div>
      <div class="aud-c-meta">${esc(auditTime(r.ts))} · block ${r.ledger}</div>
    </div>`;
  }).join("");
}
// Table rows for the wide (desktop) layout.
function auditTableRows(rows) {
  return rows.map((r) => {
    if (r.sealed) return `<tr class="sealed"><td>${esc(auditTime(r.ts))}</td><td class="mono">${r.ledger}</td><td colspan="4" class="muted">sealed — wrong key</td></tr>`;
    const from = r.deposit ? `<span class="aud-tag">deposit</span>` : `<code>${esc(short(r.from, 6))}</code>`;
    return `<tr>
      <td class="aud-when">${esc(auditTime(r.ts))}</td>
      <td class="mono">${r.ledger}</td>
      <td>${from}</td>
      <td><code>${esc(short(r.to, 6))}</code></td>
      <td class="num">${esc(toHuman(r.amount, decOf(r.assetId)))}</td>
      <td class="aud-asset">${esc(symOf(r.assetId))}</td>
    </tr>`;
  }).join("");
}
// Apply the auditor's filters (sender / recipient / asset / since-date) to the
// reconstructed rows. Read live from the controls so filtering is instant.
function auditFiltered() {
  const f = ($("#aud-f-from")?.value || "").trim();
  const t = ($("#aud-f-to")?.value || "").trim();
  const asset = $("#aud-f-asset")?.value || "all";
  const since = $("#aud-f-since")?.value || ""; // yyyy-mm-dd
  const cutoff = since ? Date.parse(since) : 0;
  const minUsd = $("#aud-f-min")?.value !== "" ? parseFloat($("#aud-f-min").value) : null;
  const maxUsd = $("#aud-f-max")?.value !== "" ? parseFloat($("#aud-f-max").value) : null;
  return auditRows.filter((r) => {
    if (r.sealed) return false;
    if (cutoff && (Date.parse(r.ts) || 0) < cutoff) return false;
    if (asset !== "all" && String(r.assetId) !== asset) return false;
    const usd = Number(toHuman(r.amount, decOf(r.assetId))) * assetUsd(r.assetId);
    if (minUsd != null && usd < minUsd) return false;
    if (maxUsd != null && usd > maxUsd) return false;
    if (f && !String(r.from || "").includes(f)) return false;
    if (t && !String(r.to || "").includes(t)) return false;
    return true;
  });
}
function renderAuditTable() {
  const cards = $("#aud-cards"), body = $("#audit-body"), count = $("#aud-count");
  if (!cards && !body) return;
  const setBoth = (cardHtml, rowHtml) => { if (cards) cards.innerHTML = cardHtml; if (body) body.innerHTML = rowHtml; };
  if (!auditRows.length) { setBoth(`<p class="empty cool">No transactions to disclose yet.</p>`, `<tr><td colspan="6" class="muted small" style="padding:18px">No transactions to disclose yet.</td></tr>`); if (count) count.textContent = ""; return; }
  const rows = auditFiltered();
  if (!rows.length) { setBoth(`<p class="empty cool">No transactions match these filters.</p>`, `<tr><td colspan="6" class="muted small" style="padding:18px">No transactions match these filters.</td></tr>`); }
  else setBoth(auditCards(rows), auditTableRows(rows));
  if (count) count.textContent = `${rows.length} of ${auditRows.length} tx`;
}
// Export the currently-filtered rows as CSV (opens in Excel). Full owner keys and
// tx hashes are included so the auditor has the complete record.
function auditExportCsv() {
  const rows = auditFiltered();
  if (!rows.length) { toast("Nothing to export with these filters"); return; }
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Time", "Block", "Type", "From", "To", "Amount", "Asset", "Tx"];
  const lines = [head.map(q).join(",")];
  for (const r of rows) lines.push([r.ts, r.ledger, r.deposit ? "deposit" : "transfer", r.deposit ? "" : r.from, r.to, toHuman(r.amount, decOf(r.assetId)), symOf(r.assetId), r.hash].map(q).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wall-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function runAudit(priv) {
  const msg = (m) => { if ($("#aud-cards")) $("#aud-cards").innerHTML = `<div class="muted small">${esc(m)}</div>`; if ($("#audit-body")) $("#audit-body").innerHTML = `<tr><td colspan="6" class="muted small" style="padding:18px">${esc(m)}</td></tr>`; };
  msg("reconstructing the ledger…");
  try {
    const [{ groups, commits }, auditMap] = await Promise.all([fetchTxGroups(CFG.poolId, CFG.startLedger), fetchAuditEvents(CFG.poolId, CFG.startLedger)]);
    auditRows = auditTable(groups, auditEnforced(commits, auditMap, priv));
    renderAuditTable();
  } catch (e) { msg(e.message || "could not read events"); }
}

// ============================ rendering ============================
const mark = "•••";
const brand = `<div class="brand"><img class="brand-logo" src="/logo.png" alt="" aria-hidden="true"/>Wall</div>`;

// Editorial direction: the eclipse is the logo (a dark wall on cream paper),
// not a WebGL disc. These remain as harmless no-ops so the proving-animation
// hooks (disc?.occult() etc.) don't need to be threaded out of the action paths.
function placeDisc() {}

function render() {
  const app = $("#app");
  document.body.classList.toggle("plain-bg", view === "docs"); // docs gets a flat, uniform ground
  if (!CFG) { app.innerHTML = `<div class="screen center"><img class="hero-eclipse" src="/logo.png" alt="" style="opacity:.6"/></div>`; return; }
  if (CFG.error) { app.innerHTML = `<div class="screen center"><p class="muted">${esc(CFG.error)}</p></div>`; return; }

  if (proving) { app.innerHTML = provingView(); return; }
  if (view === "docs") return void (app.innerHTML = docsView(CFG), wireDocs());
  if (view === "landing") return void (app.innerHTML = landingView(), wireLanding());
  if (view === "create") return void (app.innerHTML = createView(), wireCreate());
  if (view === "connect") return void (app.innerHTML = connectView(), wireConnect());
  if (view === "auditor") return void (app.innerHTML = auditorView(), wireAuditor());

  app.innerHTML = homeView() + (sheet ? sheetView() : "");
  placeDisc();
  wireHome();
  if (sheet) wireSheet();
}

// ---- landing ----
const landingView = () => `<div class="screen center landing">
  <img class="hero-logo" src="/logo.png" alt="Wall" />
  <h1 class="title">Wall</h1>
  <p class="phonetic">/ˈʌm.brə/</p>
  <p class="lede">Private payments and balances on Ethereum</p>
  <div class="stack">
    <button class="btn primary" id="go-create">Create wallet</button>
    <button class="btn ghost" id="go-connect">I have a private key</button>
  </div>
  <div class="landing-foot">
    <a class="ext-cta" id="go-docs" href="#docs">Read the docs</a>
    ${IS_EXT ? "" : `<a class="ext-cta" href="https://github.com/abaresks24/wall/releases/latest/download/wall-extension.zip">Get the Chrome extension ↗</a>`}
  </div>
</div>`;
function wireLanding() {
  $("#go-create").onclick = () => { tmpSeed = randomSeed(); view = "create"; render(); };
  $("#go-connect").onclick = () => { view = "connect"; render(); };
  $("#go-docs").onclick = (e) => { e.preventDefault(); openDocs(); };
}
// Open the docs by rendering immediately (never depend on a hashchange firing),
// then reflect it in the URL so the route is shareable and the back button works.
function openDocs() { renderDocs(); if (location.hash !== "#docs") { try { history.pushState(null, "", "#docs"); } catch {} } }
function renderDocs() { if (view !== "docs") { view = "docs"; render(); } window.scrollTo(0, 0); }
function wireDocs() {
  // leave docs: clear any hash (#docs or a #section anchor) and render the wallet.
  const back = () => { view = ME ? "home" : "landing"; try { history.pushState(null, "", location.pathname); } catch {} render(); };
  $("#doc-back").onclick = back;
  const b2 = $("#doc-back-2"); if (b2) b2.onclick = back;
  // scroll-spy: highlight the contents entry whose section is in view
  const links = new Map([...document.querySelectorAll(".doc-nav-list a[data-doc]")].map((a) => [a.dataset.doc, a]));
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      links.forEach((a) => a.classList.remove("on"));
      links.get(e.target.id)?.classList.add("on");
    }
  }, { rootMargin: "-12% 0px -70% 0px" });
  document.querySelectorAll(".doc section[id]").forEach((s) => spy.observe(s));
}

const createView = () => `<div class="screen center pane">
  ${brand}
  <h2 class="title sm">Your private key</h2>
  <p class="lede">This single key is the only way back to your wallet. Keep it somewhere safe, because it can't be recovered.</p>
  <div class="keybox"><code id="seedval">${esc(tmpSeed)}</code></div>
  <button class="btn ghost wide" id="copyseed">Copy key</button>
  <label class="check"><input type="checkbox" id="saved"/> <span>I've saved my private key</span></label>
  <button class="btn primary" id="open" disabled>Open wallet</button>
  <button class="btn link" id="back">Back</button>
</div>`;
function wireCreate() {
  $("#copyseed").onclick = () => { navigator.clipboard?.writeText(tmpSeed); $("#copyseed").textContent = "Copied"; };
  $("#saved").onchange = (e) => { $("#open").disabled = !e.target.checked; };
  $("#open").onclick = () => connect(tmpSeed);
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

// ---- home. Top sections: Portfolio · Swap · Lending. Swap has sub-tabs
// [Swap | LP] (the AMM + its liquidity providers); Lending has [Lend | Borrow]
// (the money market). Utilisation/APY belong to Lending only; the swap pool shows
// depth + fee APR.
const TABS = [["portfolio", "Portfolio"], ["swap", "Swap"], ["lending", "Lending"]];
const subBar = (group, items, active) => `<nav class="subtabs">${items.map(([k, l]) => `<button class="subtab ${active === k ? "on" : ""}" data-group="${group}" data-sub="${k}">${l}</button>`).join("")}</nav>`;
function homeView() {
  const inSwap = tab === "swap", inLend = tab === "lending";
  // hero value reflects the active (sub)section
  let heroUsd = totalUsd(), heroCap = "";
  if (inLend && lendSub === "lend") { heroUsd = mSuppliedUsd(); heroCap = "Supplied · lending"; }
  else if (inLend && lendSub === "borrow") { heroUsd = mDebtUsd(); heroCap = "Borrowed"; }
  // sub-nav + panel
  let subnav = "", panel = portfolioPanel();
  if (inSwap) {
    subnav = subBar("swap", [["swap", "Swap"], ["lp", "LP"]], swapSub);
    panel = swapSub === "lp" ? swapLpPanel() : swapPanel();
  } else if (inLend) {
    subnav = subBar("lend", [["lend", "Lend"], ["borrow", "Borrow"], ["liquidate", "Liquidate"]], lendSub);
    panel = lendSub === "borrow" ? borrowPanel() : lendSub === "liquidate" ? liquidatePanel() : earnPanel();
  }
  return `<div class="screen home">
    <header class="bar">
      ${brand}
      <div class="bar-r">
        <button class="chip" id="copyaddr" title="copy your address">${esc(short(ME.address, 5))}</button>
        <button class="icon-btn" id="go-docs" title="docs" aria-label="docs">?</button>
        <button class="icon-btn" id="disconnect" title="disconnect" aria-label="disconnect">⏻</button>
      </div>
    </header>

    <section class="hero">
      <div class="hero-balance" id="reveal-bal">
        <span class="amt">${esc(fmtNum(heroUsd, 2))}</span>
        <span class="sym">USDC</span>
      </div>
      ${heroCap ? `<p class="hero-cap">${heroCap}</p>` : ""}
    </section>

    <nav class="tabs">
      ${TABS.map(([k, label]) => `<button class="tab ${tab === k ? "on" : ""}" data-tab="${k}">${label}</button>`).join("")}
    </nav>
    ${subnav}
    ${panel}
  </div>`;
}

// — Portfolio: the original wallet (actions + holdings + activity) —
function portfolioPanel() {
  const assets = CFG.assets || [];
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

// The DeFi identity banner. The market is NOT signed by MetaMask — it's signed by
// a fresh pseudonym derived from your wallet, with gas paid by the relayer. Until
// it's activated (account + trustlines), show the activate button; once active,
// show the address to fund privately (withdraw shielded USDC to it).
// A DeFi "account" = a separate private identity (a fresh pseudonym). You can open
// several so your activity in one can't be linked to another. Kept compact.
function positionNav() {
  return `<div class="pos-nav">
    <button class="pos-arrow" id="pos-prev" ${posIndex === 0 ? "disabled" : ""} aria-label="previous account">‹</button>
    <span class="pos-label">Account ${posIndex + 1}${posMax > 0 ? ` / ${posMax + 1}` : ""}</span>
    <button class="pos-arrow" id="pos-next" ${posIndex >= posMax ? "disabled" : ""} aria-label="next account">›</button>
    <button class="link sm" id="pos-new" title="Open a separate private account, unlinkable to this one">+ new</button>
  </div>`;
}
function identityBanner() {
  if (!mid) return "";
  if (!mid.active) {
    return `<div class="mkt-connect">
      ${positionNav()}
      <button class="btn primary wide" id="mkt-activate">Activate account ${posIndex + 1}</button>
      <p class="panel-note" style="margin:0">A private, gasless identity — not your MetaMask, unlinkable to your other accounts. Activating is free (the relayer pays).</p>
    </div>`;
  }
  const funded = marketAssets().some((a) => mIdBal(a.id) > 0n);
  const bals = marketAssets().map((a) => `${esc(toHuman(mIdBal(a.id), mDec(a.id)))} ${esc(a.symbol)}`).join(" · ");
  return `<div class="mkt-connect">
    ${positionNav()}
    <div class="fr-row"><span class="mono small">${esc(short(mid.address, 4))} <button class="link sm" id="mkt-copy-id">copy</button></span><span class="mono small">${bals}</span></div>
    <button class="btn ${funded ? "ghost" : "primary"} wide" id="mkt-fund">Fund from shadow</button>
  </div>`;
}
function mktErrBar() { return mkt.err ? `<p class="panel-note" style="color:var(--danger)">Market read failed: ${esc(humanizeErr(mkt.err))}</p>` : ""; }

// — Swap: real oracle-priced exchange, honoured only if the pool holds enough —
function swapPanel() {
  const rate = swapRate();
  const fromBal = balanceOf(swapFrom);
  const poolLiq = swapDepth["spare" + swapTo]; // LP liquidity available to swap into
  const ratio = Number(priceOfId(swapFrom, rate)) / Number(priceOfId(swapTo, rate));
  return `<div class="panel swap-panel">
    <div class="swap-card">
      <div class="swap-leg">
        <div class="swap-leg-top"><span class="lbl">You pay</span><span class="bal-mini">you have ${esc(toHuman(fromBal, decOf(swapFrom)))} ${esc(symOf(swapFrom))}</span></div>
        <div class="swap-leg-row">
          <input id="swap-amt" class="swap-input" inputmode="decimal" placeholder="0.0" autocomplete="off"/>
          <button class="asset-pill" id="swap-from-pill">${esc(symOf(swapFrom))}</button>
        </div>
      </div>
      <button class="swap-flip" id="swap-flip" title="flip direction" aria-label="flip direction">⇅</button>
      <div class="swap-leg">
        <div class="swap-leg-top"><span class="lbl">You receive</span><span class="bal-mini">pool has ${poolLiq != null ? esc(toHuman(poolLiq, decOf(swapTo))) : "…"} ${esc(symOf(swapTo))}</span></div>
        <div class="swap-leg-row">
          <input id="swap-out" class="swap-input" placeholder="0.0" readonly/>
          <button class="asset-pill" id="swap-to-pill">${esc(symOf(swapTo))}</button>
        </div>
      </div>
    </div>
    <div class="swap-quote"><span>Rate · oracle</span><span class="mono">1 ${esc(symOf(swapFrom))} = ${esc(ratio.toFixed(4))} ${esc(symOf(swapTo))}</span></div>
    <div class="swap-quote"><span>Privacy</span><span>amount + identity hidden</span></div>
    <button class="btn primary wide" id="swap-go">Swap privately</button>
    ${poolLiq != null && poolLiq === 0n ? `<p class="panel-note" style="color:var(--danger)">The pool has no ${esc(symOf(swapTo))} liquidity yet — go to the LP tab and Provide some (or ask someone to), then swaps into ${esc(symOf(swapTo))} will work.</p>` : `<p class="panel-note">Private swap in the shielded pool. It settles only if the pool holds enough of the asset you want (provided by LPs — see the LP tab). Your amount and identity stay hidden.</p>`}
  </div>`;
}

// — Lending > Lend: supply to the money market, earn utilization interest —
function earnPanel() {
  const rows = marketAssets().map((a) => {
    const st = mkt.stats[a.id] || {};
    const mine = mkt.pos[a.id]?.supplied || 0n;
    const apy = st.sApy != null ? pct(st.sApy) : "…";
    const tvl = st.sup != null ? fmtNum(Number(toHuman(st.sup, mDec(a.id))), 0) : "…";
    const util = st.util != null ? (Number(st.util) / 100).toFixed(0) : "…";
    return `<div class="lp-row">
      <span class="hico">${esc(a.symbol[0])}</span>
      <div class="lp-main">
        <span class="hsym">${esc(a.symbol)}</span>
        <span class="lp-sub">pool ${esc(tvl)} · ${esc(util)}% used${mine > 0n ? ` · you ${esc(toHuman(mine, mDec(a.id)))}` : ""}</span>
      </div>
      <span class="lp-apy">${esc(apy)}%<small>SUPPLY APY</small></span>
      <div class="lp-btns">
        ${mid?.active ? `<button class="lp-b" data-msupply="${a.id}">Supply</button>` : ""}
        ${mid?.active && mine > 0n ? `<button class="lp-b ghost" data-mwithdraw="${a.id}">Withdraw</button>` : ""}
      </div>
    </div>`;
  }).join("");
  return `<div class="panel earn-panel">
    ${identityBanner()}${mktErrBar()}
    <section class="holdings">
      <div class="sec-h"><span>Lending markets (per asset)</span></div>
      ${rows || `<p class="empty">Loading market…</p>`}
    </section>
    <p class="panel-note">Supply USDC or EURC to the money market and earn interest from borrowers. Supply APY is 0% when nothing is borrowed and rises with utilisation (utilisation = borrowed / supplied — a lending metric). Read live from the contract; real Circle testnet USDC/EURC.</p>
  </div>`;
}

// — Borrow: real over-collateralised borrowing against supplied collateral —
function borrowPanel() {
  const health = mkt.health != null && mkt.health < (2n ** 120n) ? Number(mkt.health) / 1e12 : null;
  const collUsd = mSuppliedUsd(), debtUsd = mDebtUsd();
  const rows = marketAssets().map((a) => {
    const st = mkt.stats[a.id] || {};
    const debt = mkt.pos[a.id]?.borrowed || 0n;
    const bApy = st.bApy != null ? pct(st.bApy) : "…";
    const avail = st.reserve != null ? fmtNum(Number(toHuman(st.reserve, mDec(a.id))), 0) : "…";
    return `<div class="lp-row">
      <span class="hico">${esc(a.symbol[0])}</span>
      <div class="lp-main">
        <span class="hsym">${esc(a.symbol)}</span>
        <span class="lp-sub">avail ${esc(avail)}${debt > 0n ? ` · you owe ${esc(toHuman(debt, mDec(a.id)))}` : ""}</span>
      </div>
      <span class="lp-apy">${esc(bApy)}%<small>BORROW APY</small></span>
      <div class="lp-btns">
        ${mid?.active ? `<button class="lp-b" data-mborrow="${a.id}">Borrow</button>` : ""}
        ${mid?.active && debt > 0n ? `<button class="lp-b ghost" data-mrepay="${a.id}">Repay</button>` : ""}
      </div>
    </div>`;
  }).join("");
  return `<div class="panel borrow-panel">
    ${identityBanner()}${mktErrBar()}
    <div class="borrow-stat-row">
      <div class="borrow-stat"><span class="bs-k">Collateral</span><span class="bs-v mono">${esc(fmtNum(collUsd, 2))} USD</span></div>
      <div class="borrow-stat"><span class="bs-k">Debt</span><span class="bs-v mono">${esc(fmtNum(debtUsd, 2))} USD</span></div>
      <div class="borrow-stat"><span class="bs-k">Health</span><span class="bs-v mono ${health != null && health < 1.1 ? "hf-warn" : ""}">${health == null ? "—" : health > 99 ? "∞" : health.toFixed(2)}</span></div>
    </div>
    <section class="holdings">
      <div class="sec-h"><span>Markets</span></div>
      ${rows || `<p class="empty">Loading market…</p>`}
    </section>
    <p class="panel-note">Borrow up to 80% of your supplied collateral's value. Supply collateral in the Lend tab first, then draw a loan here. Borrow APY tracks utilisation; if your health factor falls below 1.0 the position can be liquidated (5% bonus). All values are live from the contract.</p>
  </div>`;
}

// — Lending > Liquidate: a keeper view. Scans borrowers, lists positions with a
// health factor < 1.0, and lets you repay part of their debt to seize collateral
// (+5% bonus). Repayment comes from YOUR active position identity's balance.
function liquidatePanel() {
  const rows = liqList.map((p) => {
    const hf = (Number(p.health) / 1e12).toFixed(2);
    const debt = marketAssets().map((a) => p.debt[a.id] > 0n ? `${toHuman(p.debt[a.id], mDec(a.id))} ${a.symbol}` : "").filter(Boolean).join(" + ");
    const coll = marketAssets().map((a) => p.coll[a.id] > 0n ? `${toHuman(p.coll[a.id], mDec(a.id))} ${a.symbol}` : "").filter(Boolean).join(" + ");
    return `<div class="lp-row">
      <div class="lp-main">
        <span class="hsym mono">${esc(short(p.user, 5))}</span>
        <span class="lp-sub">debt ${esc(debt || "—")} · collat ${esc(coll || "—")}</span>
      </div>
      <span class="lp-apy hf-warn">${esc(hf)}<small>HEALTH</small></span>
      <div class="lp-btns">${mid?.active ? `<button class="lp-b" data-liq="${esc(p.user)}">Liquidate</button>` : ""}</div>
    </div>`;
  }).join("");
  return `<div class="panel borrow-panel">
    ${identityBanner()}${mktErrBar()}
    <section class="holdings">
      <div class="sec-h"><span>Liquidatable positions</span><button class="link sm" id="liq-refresh">${liqLoading ? "scanning…" : "refresh"}</button></div>
      ${liqLoading && !liqList.length ? `<p class="empty">Scanning borrowers…</p>` : rows || `<p class="empty">No positions are underwater right now.</p>`}
    </section>
    <p class="panel-note">Keeper view: positions with health &lt; 1.0 can be liquidated — you repay up to 50% of their debt from your active position's balance and seize the equivalent collateral +5% bonus. Fund your identity with the debt asset first. Anyone can liquidate; this keeps the pool solvent.</p>
  </div>`;
}
let liqAt = 0;
async function fetchLiquidatable() {
  if (liqLoading || Date.now() - liqAt < 15000) return; // throttle: no re-render loop when the list is empty
  liqAt = Date.now();
  liqLoading = true; if (ME && tab === "lending" && lendSub === "liquidate") render();
  try {
    const src = mktSrc();
    const borrowers = await fetchBorrowers(CFG.market, CFG.startLedger, CFG.rpc);
    const out = [];
    for (const user of borrowers) {
      let health; try { health = BigInt(await readViewAs(CFG.market, src, "health", [mA(user)])); } catch { continue; }
      if (health >= 1000000000000n) continue; // healthy (>= 1.0 in WAD)
      const debt = {}, coll = {};
      for (const a of marketAssets()) {
        try { const p = await readViewAs(CFG.market, src, "position", [mA(user), mU(a.id)]); debt[a.id] = BigInt(p.borrowed); coll[a.id] = BigInt(p.supplied); }
        catch { debt[a.id] = 0n; coll[a.id] = 0n; }
      }
      out.push({ user, health, debt, coll });
    }
    liqList = out;
  } catch (e) { mkt.err = e.message || String(e); }
  liqLoading = false;
  if (ME && tab === "lending" && lendSub === "liquidate") render();
}
async function runLiquidate(user) {
  if (!mid?.active) return toast("Activate a position identity first");
  const p = liqList.find((x) => x.user === user); if (!p) return;
  // pick the asset the user owes most (repay) and holds most as collateral (seize)
  const debtId = marketAssets().map((a) => a.id).sort((x, y) => (p.debt[y] > p.debt[x] ? 1 : -1))[0];
  const collId = marketAssets().map((a) => a.id).sort((x, y) => (p.coll[y] > p.coll[x] ? 1 : -1))[0];
  const repay = p.debt[debtId] / 2n; // close factor 50%
  if (repay <= 0n) return toast("Nothing to liquidate on this position");
  if (mIdBal(debtId) < repay) return toast(`Fund your identity with ${toHuman(repay, mDec(debtId))} ${mSym(debtId)} to liquidate`);
  await runMarket(`Liquidated ${short(user, 4)}`, "liquidate", [mA(mid.address), mA(user), mU(debtId), mU(collId), mI(repay)]);
  fetchLiquidatable();
}
function holdingRow(a) {
  const bal = toHuman(balanceOf(a.id), decOf(a.id));
  const nc = noteCount(a.id);
  const usd = humanBal(a.id) * assetUsd(a.id);
  return `<div class="hrow">
    <span class="hico">${esc(a.symbol[0])}</span>
    <span class="hrow-main"><span class="hsym">${esc(a.symbol)}</span>${nc > 1 ? `<button class="merge-link sm" data-merge="${a.id}">merge ${nc} notes</button>` : ""}</span>
    <span class="hrow-amt"><span class="hbal">${esc(bal)}</span><span class="husd">$${esc(fmtNum(usd, 2))}</span></span>
  </div>`;
}
function activityRow(e, i) {
  const dirIcon = { deposit: "↧", withdraw: "↥", send: "↗", receive: "↙", swap: "⇄" }[e.dir] || "◐";
  const amt = e.dir === "swap" && e.outAmount != null
    ? `${toHuman(e.amount, decOf(e.assetId))} ${symOf(e.assetId)} → ${toHuman(e.outAmount, decOf(e.outAssetId))} ${symOf(e.outAssetId)}`
    : `${toHuman(e.amount, decOf(e.assetId))} ${symOf(e.assetId)}`; // always shown
  const label = { deposit: "Deposited", withdraw: "Withdrew", send: "Sent", receive: "Received", swap: "Swapped" }[e.dir] || e.dir;
  const when = new Date(e.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const link = e.hash ? `<a class="arow-tx" href="${EXPLORER}/tx/${esc(e.hash)}" target="_blank" rel="noopener" title="View on etherscan.io" aria-label="View transaction on explorer">↗</a>` : "";
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
  $("#go-docs").onclick = () => openDocs();
  $("#copyaddr").onclick = () => { navigator.clipboard?.writeText(ME.address); toast("Address copied"); };
  document.querySelectorAll(".tab[data-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); });
  document.querySelectorAll(".subtab[data-sub]").forEach((b) => b.onclick = () => { if (b.dataset.group === "swap") swapSub = b.dataset.sub; else lendSub = b.dataset.sub; render(); });
  // balance is always shown — no reveal toggle
  document.querySelectorAll(".merge-link[data-merge]").forEach((b) => b.onclick = () => runAction("merge", { assetId: Number(b.dataset.merge) }));
  document.querySelectorAll(".act").forEach((b) => b.onclick = async () => { sheet = b.dataset.sheet; render(); if (sheet === "deposit" && fr) { await refreshFr(); render(); } });
  document.querySelectorAll(".row-reveal").forEach((b) => b.onclick = () => { const k = b.dataset.rev; reveals.has(k) ? reveals.delete(k) : reveals.add(k); render(); });
  const act = $("#mkt-activate"); if (act) act.onclick = () => activateIdentity();
  const cid = $("#mkt-copy-id"); if (cid) cid.onclick = () => { navigator.clipboard?.writeText(mid.address); toast("Position address copied"); };
  const fund = $("#mkt-fund"); if (fund) fund.onclick = () => fundIdentity();
  const pn = $("#pos-new"); if (pn) pn.onclick = () => newPosition();
  const pp = $("#pos-prev"); if (pp) pp.onclick = () => switchPosition(posIndex - 1);
  const px = $("#pos-next"); if (px) px.onclick = () => switchPosition(posIndex + 1);
  if (tab === "swap" && swapSub === "swap") wireSwap();
  if (tab === "swap" && swapSub === "lp") {
    fetchSwapDepth();
    document.querySelectorAll("[data-addliq]").forEach((b) => b.onclick = () => openMktSheet("addliq", Number(b.dataset.addliq)));
    document.querySelectorAll("[data-remliq]").forEach((b) => b.onclick = () => runRemLiq(Number(b.dataset.remliq)));
  }
  if (tab === "lending" && lendSub === "lend") wireEarn();
  if (tab === "lending" && lendSub === "borrow") wireBorrow();
  if (tab === "lending" && lendSub === "liquidate") {
    fetchLiquidatable(); // throttled internally
    const lr = $("#liq-refresh"); if (lr) lr.onclick = () => { liqAt = 0; fetchLiquidatable(); };
    document.querySelectorAll("[data-liq]").forEach((b) => b.onclick = () => runLiquidate(b.dataset.liq));
  }
}
// Swap-pool state: `spare` = LP liquidity available to swap out; `mine` = my LP shares
let swapDepth = {};
let swapDepthAt = 0;
async function fetchSwapDepth() {
  if (Date.now() - swapDepthAt < 15000) return; // throttle: no re-render loop
  swapDepthAt = Date.now();
  try {
    for (const a of (CFG.assets || [])) {
      const [reserve, spare] = await Promise.all([
        readViewAs(CFG.poolId, mktSrc(), "swap_reserve", [mU(a.id)]),
        readViewAs(CFG.poolId, mktSrc(), "swap_spare", [mU(a.id)]),
      ]);
      swapDepth[a.id] = BigInt(reserve || 0n);
      swapDepth["spare" + a.id] = BigInt(spare || 0n);
    }
    if (mid) { try { swapDepth.shares = BigInt(await readViewAs(CFG.poolId, mktSrc(), "lp_shares", [mA(mid.address)])); } catch {} }
    if (ME && tab === "swap" && swapSub === "lp") render();
  } catch { /* leave as-is */ }
}
// — Swap > LP: provide liquidity to the swap pool, earn the 0.30% fee. Kept simple:
// one row per asset (how much is in the pool) with a Provide / Withdraw button.
function swapLpPanel() {
  const hasPos = (swapDepth.shares || 0n) > 0n;
  const rows = (CFG.assets || []).map((a) => {
    const inPool = swapDepth["spare" + a.id];
    return `<div class="lp-row">
      <span class="hico">${esc(a.symbol[0])}</span>
      <div class="lp-main"><span class="hsym">${esc(a.symbol)}</span><span class="lp-sub">${inPool != null ? esc(toHuman(inPool, decOf(a.id))) : "…"} in the pool</span></div>
      <div class="lp-btns">
        ${mid?.active ? `<button class="lp-b" data-addliq="${a.id}">Provide</button>` : ""}
        ${mid?.active && hasPos ? `<button class="lp-b ghost" data-remliq="${a.id}">Withdraw</button>` : ""}
      </div>
    </div>`;
  }).join("");
  return `<div class="panel earn-panel">
    ${identityBanner()}
    <section class="holdings">
      <div class="sec-h"><span>Provide liquidity — earn 0.30% of every swap</span></div>
      ${rows}
    </section>
    <p class="panel-note">Add USDC or EURC to the swap pool. You earn a share of the 0.30% fee on every swap and can withdraw whenever the pool has enough. ${hasPos ? "You're currently providing liquidity." : ""}</p>
  </div>`;
}
// Fund the DeFi identity privately: withdraw shielded USDC to its address (opens
// the withdraw sheet pre-filled with the identity address as the destination).
function fundIdentity() {
  if (!mid) return;
  asset = marketAssets()[0]?.id || 1;
  sheet = "withdraw"; render();
  setTimeout(() => { const el = $("#s-addr"); if (el) el.value = mid.address; }, 0);
}
// live swap quote: recompute the receive amount from the typed input + oracle rate
function refreshSwapQuote() {
  const inEl = $("#swap-amt"), outEl = $("#swap-out");
  if (!inEl || !outEl) return;
  try {
    const amt = toRawAs($("#swap-amt").value || "0", swapFrom);
    if (amt <= 0n) { outEl.value = ""; return; }
    const { out } = swapQuote(swapFrom, swapTo, amt, swapRate());
    outEl.value = out > 0n ? toHuman(out, decOf(swapTo)) : "";
  } catch { outEl.value = ""; }
}
function wireSwap() {
  fetchSwapRate(); // keep the quote bound to the on-chain oracle
  fetchSwapDepth(); // show how much LP liquidity is available to swap into
  const flip = () => { [swapFrom, swapTo] = [swapTo, swapFrom]; render(); };
  const fp = $("#swap-flip"); if (fp) fp.onclick = flip;
  const fpp = $("#swap-from-pill"); if (fpp) fpp.onclick = flip;
  const tpp = $("#swap-to-pill"); if (tpp) tpp.onclick = flip;
  const inEl = $("#swap-amt"); if (inEl) inEl.oninput = refreshSwapQuote;
  const go = $("#swap-go"); if (go) go.onclick = async () => {
    let amt; try { amt = toRawAs($("#swap-amt").value || "0", swapFrom); } catch (e) { return toast(e.message); }
    if (amt <= 0n) return toast("Enter an amount");
    if (amt > balanceOf(swapFrom)) return toast(`Only ${toHuman(balanceOf(swapFrom), decOf(swapFrom))} ${symOf(swapFrom)} in shadow`);
    // liquidity gate: a swap into an asset needs LP SPARE of that asset (the pool's
    // reserve minus everyone's claims). Read the on-chain swap_spare — matches what
    // the contract checks — so we block early with a clear message.
    const { out } = swapQuote(swapFrom, swapTo, amt, swapRate());
    try {
      const spare = BigInt(await readViewAs(CFG.poolId, mktSrc(), "swap_spare", [mU(swapTo)]));
      if (spare < out) return toast(`Only ${toHuman(spare, decOf(swapTo))} ${symOf(swapTo)} of swap liquidity — someone must Provide it in the LP tab first`);
    } catch { /* if it can't be read, let the on-chain check be the backstop */ }
    runSwap(swapFrom, swapTo, amt);
  };
}
function wireEarn() {
  document.querySelectorAll("[data-msupply]").forEach((b) => b.onclick = () => openMktSheet("supply", Number(b.dataset.msupply)));
  document.querySelectorAll("[data-mwithdraw]").forEach((b) => b.onclick = () => openMktSheet("withdraw", Number(b.dataset.mwithdraw)));
}
function wireBorrow() {
  document.querySelectorAll("[data-mborrow]").forEach((b) => b.onclick = () => openMktSheet("borrow", Number(b.dataset.mborrow)));
  document.querySelectorAll("[data-mrepay]").forEach((b) => b.onclick = () => openMktSheet("repay", Number(b.dataset.mrepay)));
}
function openMktSheet(fn, id) { mktSheet = { fn, id }; sheet = "mkt"; render(); }

// ---- sheets (send / deposit / withdraw / receive) ----
function sheetView() {
  const assets = CFG.assets || [];
  const sel = assets.length > 1 ? `<label class="lbl">Asset</label><div class="seg">${assets.map((a) => `<button class="seg-b ${a.id === asset ? "on" : ""}" data-sasset="${a.id}">${esc(a.symbol)}</button>`).join("")}</div>` : "";
  const amount = `<label class="lbl">Amount</label><input id="s-amt" class="field" inputmode="decimal" placeholder="0.0" autocomplete="off"/>`;
  let title, body, btn, hint;
  if (sheet === "send") {
    title = "Send in shadow"; btn = "Send";
    hint = "Amount and recipient stay hidden on-chain.";
    body = `${sel}<label class="lbl">Recipient</label><input id="s-addr" class="field mono" placeholder="wall address (shld_…)" autocomplete="off"/>${amount}`;
  } else if (sheet === "deposit") {
    title = "Into nightfall"; btn = null; // wired separately to MetaMask
    hint = "Deposit from your own Ethereum wallet. Public tokens enter the wall.";
    const a = assetById(asset);
    if (IS_EXT) {
      // MetaMask can't be reached from inside an extension popup — send the user
      // to the web app to sign the deposit; the popup picks up the note on rescan.
      body = `${sel}<p class="faucet">Deposits are signed with MetaMask, which lives in the browser tab. Open Wall on the web to deposit, and your new balance shows up here automatically.</p>
        <button class="btn primary" id="ext-open-web">Open Wall on the web ↗</button>`;
    } else if (!fr) {
      body = `${sel}<button class="btn primary" id="fr-connect">Connect MetaMask</button>
        <p class="faucet">No ${esc(a.symbol)} yet? ${a.faucet === "circle"
          ? `Get testnet ${esc(a.symbol)} at <a href="${esc(CFG.circleFaucet)}" target="_blank">faucet.circle.com</a>`
          : `ask the issuer to send you ${esc(a.symbol)}`} · XLM for fees at <a href="${esc(CFG.friendbot)}?addr=" target="_blank" id="xlm-faucet">friendbot</a>.</p>`;
    } else {
      const st = fr.status || { hasTrust: false, raw: 0n };
      const wallet = `<div class="fr-row"><span class="muted small">MetaMask · <span class="mono">${esc(short(fr.address, 4))}</span></span><button class="link sm" id="fr-disc">Disconnect</button></div>
        <div class="fr-row"><span class="muted small">${esc(a.symbol)} available</span><span class="mono small">${st.hasTrust ? esc(toHuman(st.raw, a.decimals)) : "no trustline"} <button class="link sm" id="fr-refresh" title="refresh">↻</button></span></div>`;
      if (!st.hasTrust) {
        body = `${sel}${wallet}<button class="btn ghost" id="fr-trust">Add ${esc(a.symbol)} trustline</button>
          <p class="faucet">Then fund it: ${a.faucet === "circle" ? `<a href="${esc(CFG.circleFaucet)}" target="_blank">faucet.circle.com</a>` : `issuer top-up`}.</p>`;
      } else {
        body = `${sel}${wallet}${amount}<button class="btn primary" id="fr-deposit">Deposit</button>`;
      }
    }
  } else if (sheet === "withdraw") {
    title = "Toward daybreak"; btn = "Withdraw";
    hint = "Value returns to the public light.";
    body = `${sel}<label class="lbl">Destination</label><input id="s-addr" class="field mono" placeholder="Ethereum address (G…)" value="${esc(CFG.recipAddr || "")}" autocomplete="off"/>${amount}`;
  } else if (sheet === "mkt") {
    const id = mktSheet.id, fn = mktSheet.fn;
    const labels = { supply: "Supply", withdraw: "Withdraw", borrow: "Borrow", repay: "Repay", addliq: "Provide" };
    const hints = {
      supply: "Supply to the money market and earn interest from borrowers; also counts as collateral.",
      withdraw: "Take supplied liquidity back to your wallet.",
      borrow: "Draw a loan against your supplied collateral (up to 80% of its value).",
      repay: "Pay down your outstanding debt.",
      addliq: "Provide liquidity to the swap pool and earn the 0.30% swap fee.",
    };
    // the relevant balance/cap for this action
    let cap, capLbl;
    if (fn === "supply" || fn === "addliq") { cap = mIdBal(id); capLbl = "DeFi identity balance"; }
    else if (fn === "withdraw") { cap = mkt.pos[id]?.supplied || 0n; capLbl = "Supplied"; }
    else if (fn === "repay") { cap = mkt.pos[id]?.borrowed || 0n; capLbl = "Your debt"; }
    else { cap = mkt.stats[id]?.reserve || 0n; capLbl = "Pool liquidity"; }
    title = `${labels[fn]} ${mSym(id)}`; btn = labels[fn];
    hint = hints[fn];
    body = `<div class="fr-row"><span class="muted small">${capLbl}</span><span class="mono small">${esc(toHuman(cap, mDec(id)))} ${esc(mSym(id))} ${fn !== "borrow" ? `<button class="link sm" id="mkt-max">max</button>` : ""}</span></div>
      ${fn === "borrow" ? `<div class="fr-row"><span class="muted small">Borrow power left</span><span class="mono small">${esc(fmtNum(mBorrowableUsd(), 2))} USD</span></div>` : ""}
      <label class="lbl">Amount</label><input id="s-amt" class="field" inputmode="decimal" placeholder="0.0" autocomplete="off"/>`;
  } else {
    title = "A point of light"; btn = null;
    hint = "Share this address so others can find you in the dark.";
    body = `<div class="addr-box"><code>${esc(ME.address)}</code></div>`;
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
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") { sheet = null; mktSheet = null; render(); } };
  $("#s-cancel").onclick = () => { sheet = null; mktSheet = null; render(); };
  document.querySelectorAll(".seg-b").forEach((b) => b.onclick = async () => { asset = Number(b.dataset.sasset); if (fr) await refreshFr(); render(); });
  const copy = $("#s-copy"); if (copy) copy.onclick = () => { navigator.clipboard?.writeText(ME.address); copy.textContent = "Copied"; };
  // MetaMask deposit controls
  const extOpen = $("#ext-open-web"); if (extOpen) extOpen.onclick = () => window.open(API_BASE || "https://wall-wallet.vercel.app", "_blank");
  const xf = $("#xlm-faucet"); if (xf && fr) xf.href = `${CFG.friendbot}?addr=${fr.address}`;
  const conn = $("#fr-connect"); if (conn) conn.onclick = async () => { try { await doConnectMetaMask(); } catch (e) { toast(e.message || "connect failed"); } };
  const fdisc = $("#fr-disc"); if (fdisc) fdisc.onclick = () => { fr = null; toast("MetaMask disconnected. Switch account in MetaMask, then reconnect."); render(); };
  const fref = $("#fr-refresh"); if (fref) fref.onclick = async () => { fref.textContent = "…"; await refreshFr(); render(); };
  const trust = $("#fr-trust"); if (trust) trust.onclick = async () => {
    const a = assetById(asset);
    try { trust.textContent = "Confirm in MetaMask…"; await addTrustline(fr.address, a.code, a.issuer); await refreshFr(); render(); }
    catch (e) { toast(e.message || "trustline failed"); render(); }
  };
  const dep = $("#fr-deposit"); if (dep) dep.onclick = () => {
    let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(asset)); } catch (e) { return toast(e.message); }
    if (amt <= 0n) return toast("Enter an amount");
    if (fr.status && amt > fr.status.raw) return toast(`Only ${toHuman(fr.status.raw, decOf(asset))} ${symOf(asset)} available`);
    runDeposit(amt, asset);
  };
  // market actions (supply / withdraw / borrow / repay) — signed by the DeFi
  // identity, gas paid by the relayer
  if (sheet === "mkt") {
    const id = mktSheet.id, fn = mktSheet.fn;
    let cap;
    if (fn === "supply" || fn === "addliq") cap = mIdBal(id);
    else if (fn === "withdraw") cap = mkt.pos[id]?.supplied || 0n;
    else if (fn === "repay") cap = mkt.pos[id]?.borrowed || 0n;
    else cap = mkt.stats[id]?.reserve || 0n;
    const mx = $("#mkt-max"); if (mx) mx.onclick = () => { $("#s-amt").value = toHuman(cap, mDec(id)); };
    const go = $("#s-go"); if (go) go.onclick = () => {
      let amt; try { amt = toRawAs($("#s-amt").value || "0", id); } catch (e) { return toast(e.message); }
      if (amt <= 0n) return toast("Enter an amount");
      if ((fn === "supply" || fn === "addliq") && amt > mIdBal(id)) return toast(`Only ${toHuman(mIdBal(id), mDec(id))} ${mSym(id)} in your DeFi identity`);
      const run = { supply: runSupply, withdraw: runWithdrawMkt, borrow: runBorrow, repay: runRepay, addliq: runAddLiq }[fn];
      run(id, amt);
    };
    return;
  }
  // send / withdraw (relayer)
  const go = $("#s-go"); if (!go) return;
  go.onclick = () => {
    let amt; try { amt = toRaw($("#s-amt").value || "0", decOf(asset)); } catch (e) { return toast(e.message); }
    if (amt <= 0n) return toast("Enter an amount");
    const addr = $("#s-addr") ? $("#s-addr").value.trim() : "";
    if (!addr) return toast("Enter a destination");
    runAction(sheet, { amt, assetId: asset, addr });
  };
}

// ---- auditor (corona mode — cool, lawful light) ----
const auditorView = () => {
  const assetOpts = (CFG.assets || []).map((a) => `<option value="${a.id}">${esc(a.symbol)}</option>`).join("");
  return `<div class="screen auditor">
  <header class="bar">
    <div class="brand"><img class="brand-logo" src="/logo.png" alt="" aria-hidden="true"/>Wall</div>
    <button class="chip" id="audit-back">Sign out</button>
  </header>
  <div class="aud-intro">
    <p class="net">Signed in as auditor</p>
    <h2 class="title sm">Lawful light</h2>
    <p class="lede">With the auditor key, every note is reconstructed: who paid whom, how much, in which asset and when, while the public sees only opaque commitments.</p>
  </div>
  <div class="aud-filterbar">
    <label class="ff-l">From<input id="aud-f-from" class="ff mono" placeholder="any" autocomplete="off"/></label>
    <label class="ff-l">To<input id="aud-f-to" class="ff mono" placeholder="any" autocomplete="off"/></label>
    <label class="ff-l">Min $<input id="aud-f-min" class="ff" type="number" min="0" inputmode="decimal" placeholder="—"/></label>
    <label class="ff-l">Max $<input id="aud-f-max" class="ff" type="number" min="0" inputmode="decimal" placeholder="—"/></label>
    <label class="ff-l">Asset<select id="aud-f-asset" class="ff"><option value="all">all</option>${assetOpts}</select></label>
    <label class="ff-l">Since<input id="aud-f-since" class="ff" type="date"/></label>
  </div>
  <div class="aud-toolbar">
    <span class="muted small" id="aud-count"></span>
    <button class="btn gold" id="aud-export">Export CSV</button>
  </div>
  <div class="aud-cards" id="aud-cards"><div class="muted small">reconstructing the ledger…</div></div>
  <div class="aud-table-wrap">
    <table class="aud-table">
      <thead><tr><th>Time</th><th>Block</th><th>From</th><th>To</th><th>Amount</th><th>Asset</th></tr></thead>
      <tbody id="audit-body"><tr><td colspan="6" class="muted small" style="padding:18px">reconstructing the ledger…</td></tr></tbody>
    </table>
  </div>
</div>`;
};
function wireAuditor() {
  disc?.idle();
  $("#audit-back").onclick = () => { auditorPriv = null; auditRows = []; view = "landing"; render(); };
  ["aud-f-from", "aud-f-to", "aud-f-asset", "aud-f-min", "aud-f-max", "aud-f-since"].forEach((id) => { const el = $("#" + id); if (el) el.oninput = el.onchange = renderAuditTable; });
  $("#aud-export").onclick = auditExportCsv;
  if (auditorPriv) runAudit(auditorPriv); // auto-disclose with the logged-in key
}

// ---- proving (the occultation) ----
const provingView = () => `<div class="screen center proving">
  <img class="prove-eclipse" src="/logo.png" alt="" aria-hidden="true" />
  <p class="prove-status" id="prove-status">${mktBusy ? "settling on the market…" : "entering the wall…"}</p>
  <p class="prove-sub">${mktBusy ? "Confirm in MetaMask; the transaction settles on Ethereum." : "Generating your zero-knowledge proof. This happens on your device."}</p>
</div>`;

// ---- toast ----
let toastT = 0;
function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2600);
}

// One-time cleanup: an earlier build could mislabel your own notes as "Received".
// Drop stale receive entries and reset the scan baseline so it stops recurring;
// your own deposit/send/withdraw history (and balances) are untouched.
function migrateActivity() {
  if (localStorage.getItem("wall-mig-3")) return;
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("wall-hist-")) {
      try { localStorage.setItem(k, JSON.stringify(JSON.parse(localStorage.getItem(k) || "[]").filter((e) => e.dir !== "receive"))); } catch {}
    } else if (k.startsWith("wall-seen-")) {
      localStorage.removeItem(k); // re-baseline on next scan
    }
  }
  localStorage.setItem("wall-mig-3", "1");
}

// ============================ boot ============================
(async () => {
  migrateActivity();
  await initPoseidon();
  await initAuditor();
  try { CFG = await (await fetch(`${API_BASE}/api/config`)).json(); } catch { CFG = { error: "Run the relayer (npm run web:server) and init the pool (npm run web:init)." }; }
  if (CFG.assets?.length) asset = CFG.assets[0].id;
  fetchPrices(); // non-blocking; re-renders when the EUR/USD rate lands
  const saved = localStorage.getItem(SEED_KEY);
  if (saved && !CFG.error) { try { ME = deriveIdentity(saved); localHist = JSON.parse(localStorage.getItem(histKey()) || "[]"); history = [...localHist]; view = "home"; heartbeat = setInterval(() => { if (ME && !proving) rescan(); }, 20000); loadPos(); initMid(); marketRefresh(); } catch { localStorage.removeItem(SEED_KEY); } }
  if (location.hash === "#docs") view = "docs"; // shareable /#docs deep-link
  // route the docs view off the URL hash. Only #docs opens it and only a CLEARED
  // hash closes it; any other hash (#what, #model, …) is in-page TOC navigation
  // within the docs and must NOT close the page.
  window.addEventListener("hashchange", () => {
    const h = location.hash;
    if (h === "#docs") renderDocs();
    else if ((h === "" || h === "#") && view === "docs") { view = ME ? "home" : "landing"; render(); }
  });
  render();
  if (ME) rescan();
})();
