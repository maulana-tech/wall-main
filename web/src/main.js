// Wall — self-contained privacy wallet on ETH Sepolia.
// No MetaMask needed. Private key stays local. Relayer pays gas.

import { state } from "./state.js";
import { API_BASE, IS_EXT } from "./constants.js";
import { fetchPrices } from "./api.js";
import { loadWallet } from "./wallet.js";
import { render } from "./ui.js";
import { normalizeConfig } from "./config.js";

if (IS_EXT) { 
  try { window.Worker = undefined; self.Worker = undefined; } catch {} 
  document.documentElement.classList.add("ext"); 
}

(async () => {
  try { state.CFG = normalizeConfig(await (await fetch(`${API_BASE}/api/config`)).json()); } catch { state.CFG = { error: "Could not load config" }; }
  if (state.CFG?.assets?.length) state.asset = state.CFG.assets[0].id;
  fetchPrices();
  const saved = localStorage.getItem("wall-connected");
  if (saved && !state.CFG.error) loadWallet({ stayOnLanding: true });
  else render();
})();
