// ─── Wallet SPA rendering ───
// All HTML templates and event wiring for the wallet view.

import { state } from "./lib/state.js";
import { decOf, symOf, toHuman, toRaw, short, esc, fmtNum, $ } from "./lib/utils.js";
import { EXPLORER, mintFaucet, fetchEvents } from "./lib/chain.js";
import { encryptAmount } from "./lib/nox.js";
import { submitToRelayer, erc20Approve, ethers } from "./lib/chain.js";
import { lendingPanel, marketRefresh, openMarketPosition, supplyToMarket, borrowFromMarket, repayToMarket } from "./lib/market.js";

// ─── Activity/history ───
const histKey = () => `wall-hist-${(state.wallet?.address || "anon").slice(0, 10)}`;

export function loadHistory() {
  state.localHist = JSON.parse(localStorage.getItem(histKey()) || "[]");
  state.history = [...state.localHist];
}

export function pushHistory(e) {
  state.localHist.unshift({ ...e, ts: Date.now() });
  localStorage.setItem(histKey(), JSON.stringify(state.localHist.slice(0, 50)));
  state.history = [...state.localHist];
}

// ─── Balance helpers ───
export const balanceOf = (id) => state.notes.filter((n) => Number(n.assetId) === Number(id)).reduce((a, n) => a + n.amount, 0n);
const humanBal = (id) => Number(toHuman(balanceOf(id), decOf(id)));
const assetUsd = (id) => (/EUR/i.test(symOf(id)) ? state.prices.eurUsd : 1);
const totalUsd = () => (state.CFG?.assets || []).reduce((s, a) => s + humanBal(a.id) * assetUsd(a.id), 0);

// ─── Toast ───
let toastT = 0;
export function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove("show"), 2600);
}

// ─── Status ───
const say = (m) => {
  const el = $("#prove-status");
  if (state.proving && el) el.textContent = m.replace(/^[^ ]+ +/, "");
};

// ─── Core actions ───
async function doDeposit(amount, assetId) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount);
  say("approving token transfer…");
  const tokenAddr = assetId === 1 ? state.CFG.usdc : state.CFG.eurc;
  await erc20Approve(tokenAddr, state.CFG.pool, amount);
  say("submitting deposit to relayer…");
  const txHash = await submitToRelayer("deposit", {
    handle: ethers.hexlify(handle),
    handleProof: ethers.hexlify(proof),
    assetId: String(assetId),
  });
  state.notes.push({ amount, assetId, txHash, ts: Date.now() });
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
  state.notes = state.notes.filter((n) => !(Number(n.assetId) === Number(assetId) && n.amount <= amount));
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
  state.notes = state.notes.filter((n) => !(Number(n.assetId) === Number(assetId) && n.amount <= amount));
  say("sent in shadow");
  return txHash;
}

// ─── Orchestrated actions ───
export async function runDeposit(amt, assetId, renderWallet) {
  if (state.proving) return;
  state.proving = true;
  renderWallet();
  try {
    const hash = await doDeposit(amt, assetId);
    pushHistory({ dir: "deposit", amount: amt.toString(), assetId, hash });
    state.sheet = null;
  } catch (e) { say(e.message || String(e)); state.proving = false; renderWallet(); return; }
  state.proving = false;
  renderWallet();
}

export async function runAction(kind, args, renderWallet) {
  if (state.proving) return;
  state.proving = true;
  renderWallet();
  try {
    let hash;
    if (kind === "send") hash = await doTransfer(args.amt, args.assetId, args.addr);
    else if (kind === "withdraw") hash = await doWithdraw(args.amt, args.assetId);
    pushHistory({ dir: kind, amount: args.amt.toString(), assetId: args.assetId, hash });
    state.sheet = null;
  } catch (e) { say(e.message || String(e)); state.proving = false; renderWallet(); return; }
  state.proving = false;
  renderWallet();
}

// ─── Scanning ───
export async function rescan(renderWallet) {
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
  } catch { say("couldn't reach the network"); }
  if (!state.proving) renderWallet();
}

// ─── Proving view ───
const provingView = () => `<div class="screen center proving">
  <img class="prove-eclipse" src="/images/logo.png" alt="" aria-hidden="true" />
  <p class="prove-status" id="prove-status">encrypting via Nox…</p>
  <p class="prove-sub">Amount encrypted client-side. Relayer submits to chain.</p>
</div>`;

// ─── Portfolio panel ───
function portfolioPanel() {
  const assets = state.CFG?.assets || [];
  return `<div class="panel">
    <nav class="actions">
      <button class="act" data-sheet="send"><span class="act-i">↗</span>Send</button>
      <button class="act" data-sheet="deposit"><span class="act-i">↧</span>Deposit</button>
      <button class="act" data-sheet="withdraw"><span class="act-i">↥</span>Withdraw</button>
      <button class="act" data-sheet="receive"><span class="act-i">◎</span>Receive</button>
    </nav>
    <div class="terminator"></div>
    <section class="holdings">
      <div class="sec-h"><span>Tokens</span></div>
      ${assets.map((a) => {
        const bal = humanBal(a.id);
        return `<div class="hrow">
          <span class="hico">${esc(a.symbol[0])}</span>
          <span class="hrow-main"><span class="hsym">${esc(a.symbol)}</span></span>
          <span class="hrow-amt"><span class="hbal">${esc(bal.toFixed(2))}</span></span>
        </div>`;
      }).join("")}
    </section>
    <section class="activity">
      <div class="sec-h"><span>Activity</span></div>
      ${state.history.length ? state.history.map((e) => {
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
      }).join("") : `<p class="empty">No activity yet.</p>`}
    </section>
  </div>`;
}

// ─── Main render ───
export function renderWallet() {
  const main = $('#wallet-main');
  if (!main) return;
  if (state.proving) { main.innerHTML = provingView(); return; }

  const heroUsd = totalUsd();
  let panel = portfolioPanel();
  if (state.tab === "lending") panel = lendingPanel();

  main.innerHTML = `
    <section class="hero">
      <div class="hero-balance">
        <span class="amt">${esc(fmtNum(heroUsd, 2))}</span>
        <span class="sym">USD</span>
      </div>
    </section>
    <nav class="tabs">
      <button class="tab ${state.tab === "portfolio" ? "on" : ""}" data-tab="portfolio">Portfolio</button>
      <button class="tab ${state.tab === "lending" ? "on" : ""}" data-tab="lending">Lending</button>
    </nav>
    ${panel}
  `;
  wireHome(renderWallet);
}

// ─── Wire wallet events ───
function wireHome(renderWallet) {
  const faucet = $("#faucet-btn");
  const copyaddr = $("#copyaddr");

  if (faucet) faucet.onclick = async () => {
    try { await mintFaucet(); toast("Minted 1000 USDC + 1000 EURC"); }
    catch (e) { toast(e.message || "faucet failed"); }
  };
  if (copyaddr) copyaddr.onclick = () => { navigator.clipboard?.writeText(state.wallet.address); toast("Address copied"); };

  document.querySelectorAll(".tab[data-tab]").forEach((b) => b.onclick = () => {
    state.tab = b.dataset.tab;
    if (state.tab === "lending") marketRefresh(() => renderWallet());
    renderWallet();
  });
  document.querySelectorAll(".subtab[data-lendtab]").forEach((b) => b.onclick = () => {
    state.lendTab = b.dataset.lendtab;
    renderWallet();
  });
  document.querySelectorAll(".act").forEach((b) => b.onclick = () => {
    state.sheet = b.dataset.sheet;
    renderWallet();
  });
  document.querySelectorAll("[data-mktopen]").forEach((b) => b.onclick = () =>
    openMarketPosition(Number(b.dataset.mktopen), toast, () => renderWallet())
  );
  document.querySelectorAll("[data-mktsupply]").forEach((b) => b.onclick = () => {
    state.sheet = "mkt-supply";
    state.mktSheetData = { assetId: Number(b.dataset.mktsupply), positionId: Number(b.dataset.posid) || 0 };
    renderWallet();
  });
  document.querySelectorAll("[data-mktborrow]").forEach((b) => b.onclick = () => {
    state.sheet = "mkt-borrow";
    state.mktSheetData = { positionId: Number(b.dataset.mktborrow) };
    renderWallet();
  });
  document.querySelectorAll("[data-mktrepay]").forEach((b) => b.onclick = () => {
    state.sheet = "mkt-repay";
    state.mktSheetData = { positionId: Number(b.dataset.mktrepay) };
    renderWallet();
  });
}
