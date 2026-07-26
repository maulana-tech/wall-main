// ═══════════════════════════════════════════════════════════
// Wall — main entry point
// Boot, view switching, glue between landing & wallet.
// ═══════════════════════════════════════════════════════════

import { state } from "./lib/state.js";
import { $ } from "./lib/utils.js";
import { fetchConfig, fetchPrices, generatePrivateKey, initWallet } from "./lib/chain.js";
import { initNox } from "./lib/nox.js";
import { initScrambleCycle, initScrollObserver } from "./landing.js";
import { renderWallet, loadHistory, rescan, toast, runDeposit, runAction, pushHistory } from "./wallet.js";
import { marketRefresh } from "./lib/market.js";
import { ethers } from "./lib/chain.js";

// ─── Ext mode ───
const IS_EXT = import.meta.env.VITE_EXT === "1";
if (IS_EXT) {
  try { window.Worker = undefined; self.Worker = undefined; } catch {}
  document.documentElement.classList.add("ext");
}

// ─── Heartbeat ───
function startHeartbeat() {
  clearInterval(state.heartbeat);
  state.heartbeat = setInterval(() => {
    if (state.wallet && !state.proving) rescan(renderWallet);
  }, 20000);
}

// ─── Load wallet ───
function loadWallet(privateKey) {
  const key = privateKey || localStorage.getItem("wall-key");
  if (!key) return false;
  localStorage.setItem("wall-key", key);
  initWallet(key).then((w) => initNox(w.signer));
  loadHistory();
  state.view = "home";
  state.sheet = null;
  state.tab = "portfolio";
  startHeartbeat();
  showWallet();
  rescan(renderWallet);
  return true;
}

// ─── Disconnect ───
function disconnect() {
  clearInterval(state.heartbeat);
  localStorage.removeItem("wall-key");
  state.wallet = null;
  state.noxClient = null;
  state.notes = [];
  state.view = "landing";
  state.sheet = null;
  showLanding();
}

// ─── View switching ───
function showLanding() {
  const landing = $('#landing');
  const walletEl = $('#wallet');
  if (landing) landing.style.display = '';
  if (walletEl) walletEl.style.display = 'none';
  state.view = 'landing';

  // Scramble animation
  const scrambleEl = $('#scramble');
  if (scrambleEl) {
    initScrambleCycle(scrambleEl, ['shielded', 'encrypted', 'confidential', 'private', 'yours']);
  }

  // Scroll observer for story cards
  initScrollObserver();

  // Wire create button
  $('#btn-create')?.addEventListener('click', () => {
    const pk = generatePrivateKey();
    localStorage.setItem("wall-key", pk);
    loadWallet(pk);
  });

  // Wire import button
  $('#btn-import')?.addEventListener('click', () => {
    const pk = prompt("Paste your private key (0x…):");
    if (pk && pk.startsWith("0x") && pk.length === 66) loadWallet(pk);
    else if (pk) toast("Invalid private key");
  });

  // Wire feature cards
  $('#feat-pool')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.wallet) { state.tab = 'portfolio'; showWallet(); }
  });
  $('#feat-market')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.wallet) { state.tab = 'lending'; showWallet(); }
  });
}

function showWallet() {
  const landing = $('#landing');
  const walletEl = $('#wallet');
  if (landing) landing.style.display = 'none';
  if (walletEl) walletEl.style.display = '';
  state.view = 'home';
  renderWallet();

  $('#wallet-back')?.addEventListener('click', disconnect);
}

// ─── Render dispatch ───
function render() {
  if (state.view === "landing") showLanding();
  else showWallet();
}

// ─── Boot ───
(async () => {
  await fetchConfig();
  if (state.CFG?.assets?.length) state.asset = state.CFG.assets[0].id;

  fetchPrices(() => { if (state.wallet) render(); });

  const saved = localStorage.getItem("wall-key");
  if (saved && !state.CFG.error) loadWallet(saved);
  else showLanding();
})();
