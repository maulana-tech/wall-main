// ─── Amount helpers ───
const assetById = (id) => (window.__CFG?.assets || []).find((a) => Number(a.id) === Number(id));
export const decOf = (id) => assetById(id)?.decimals ?? 7;
export const symOf = (id) => assetById(id)?.symbol || `#${id}`;

export function toRaw(human, d, activeAsset) {
  const s = String(human).trim();
  if (s === "" || s === "." || !/^\d*\.?\d*$/.test(s)) throw new Error("enter a valid amount");
  const [int, frac = ""] = s.split(".");
  if (frac.length > d) throw new Error(`${symOf(activeAsset)} allows at most ${d} decimals`);
  return BigInt((int || "0") + frac.padEnd(d, "0"));
}

export function toHuman(raw, d) {
  const s = BigInt(raw).toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d);
  const frac = d ? s.slice(s.length - d).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}

// ─── Formatting ───
export const short = (s, n = 5) => (s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || "");
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmtNum = (n, dp) => (isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: dp }) : "0");

// ─── DOM ───
export const $ = (s) => document.querySelector(s);
