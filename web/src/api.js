import { API_BASE } from "./constants.js";
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
