// ═══════════════════════════════════════════════════════════
// Wall — main entry point
// Boot, view switching, glue between landing & wallet.
// ═══════════════════════════════════════════════════════════

import { state } from "./lib/state.js";
import { $ } from "./lib/utils.js";
import { fetchConfig, fetchPrices, generatePrivateKey, initWallet } from "./lib/chain.js";
import { initNox } from "./lib/nox.js";
import { initScrambleCycle, initScrollObserver, initChartGridFade } from "./landing.js";
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

  // Chart grid fade on scroll
  initChartGridFade();

  // Wire "Enter" buttons → show onboarding
  const enterOnboarding = () => { state.view = 'onboarding'; renderOnboarding(); };
  $('#btn-create')?.addEventListener('click', enterOnboarding);
  $('#btn-create-nav')?.addEventListener('click', enterOnboarding);

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

function renderOnboarding() {
  const landing = $('#landing');
  const walletEl = $('#wallet');
  if (landing) landing.style.display = 'none';
  if (walletEl) walletEl.style.display = 'none';

  // Create or reuse onboarding element
  let el = $('#onboarding');
  if (!el) {
    el = document.createElement('div');
    el.id = 'onboarding';
    document.body.appendChild(el);
  }
  el.style.display = '';
  el.innerHTML = `
    <div class="onb-root">
      <div class="onb-card">
        <img src="/logo.png" alt="Wall" class="onb-logo" />
        <h1 class="onb-title">Wall</h1>
        <p class="onb-sub">private money on ethereum</p>

        <div class="onb-actions">
          <button class="onb-btn onb-btn-primary" id="onb-create">Create Wallet</button>
          <button class="onb-btn onb-btn-secondary" id="onb-import">Import Private Key</button>
        </div>

        <p class="onb-note">your key never leaves this device. relayer pays gas.</p>

        <button class="onb-back" id="onb-back">← back</button>
      </div>
    </div>
  `;

  $('#onb-create')?.addEventListener('click', () => {
    const pk = generatePrivateKey();
    localStorage.setItem("wall-key", pk);
    el.style.display = 'none';
    loadWallet(pk);
  });

  $('#onb-import')?.addEventListener('click', () => {
    const pk = prompt("Paste your private key (0x…):");
    if (pk && pk.startsWith("0x") && pk.length === 66) {
      el.style.display = 'none';
      loadWallet(pk);
    } else if (pk) toast("Invalid private key");
  });

  $('#onb-back')?.addEventListener('click', () => {
    el.style.display = 'none';
    state.view = 'landing';
    showLanding();
  });
}

function showWallet() {
  const landing = $('#landing');
  const walletEl = $('#wallet');
  const onb = $('#onboarding');
  if (landing) landing.style.display = 'none';
  if (walletEl) walletEl.style.display = '';
  if (onb) onb.style.display = 'none';
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
