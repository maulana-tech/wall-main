import { state } from "./state.js";

export const $ = (s) => document.querySelector(s);
export const assetById = (id) => (state.CFG?.assets || []).find((a) => Number(a.id) === Number(id));
export const decOf = (id) => assetById(id)?.decimals ?? 7;
export const symOf = (id) => assetById(id)?.symbol || `#${id}`;

export function toRaw(human, d) {
  const s = String(human).trim();
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) throw new Error("enter a valid amount");
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
