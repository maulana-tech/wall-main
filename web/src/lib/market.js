import { ethers } from "./chain.js";
import { state } from "./state.js";
import { esc } from "./utils.js";
import { encryptAmount } from "./nox.js";
import { erc20Approve, submitMarket } from "./chain.js";

const MARKET_ABI = [
  "function positions(uint256) view returns (bytes32, bytes32, address, uint256, uint256)",
  "function nextPositionId() view returns (uint256)",
];

export const mDec = (id) => (state.CFG?.marketAssets || state.CFG?.assets || []).find((a) => Number(a.id) === Number(id))?.decimals ?? 7;
export const mSym = (id) => (state.CFG?.marketAssets || state.CFG?.assets || []).find((a) => Number(a.id) === Number(id))?.symbol || `#${id}`;
export const marketAssets = () => state.CFG?.marketAssets || state.CFG?.assets || [];

export async function marketRefresh(onUpdate) {
  if (!state.CFG?.market || !state.wallet?.provider) return;
  state.mkt.loading = true;
  state.mkt.err = null;
  try {
    const market = new ethers.Contract(state.CFG.market, MARKET_ABI, state.wallet.provider);
    const nextId = Number(await market.nextPositionId());
    const myPos = [];
    for (let i = 1; i < nextId; i++) {
      try {
        const [collateral, debt, owner, assetId, healthFactor] = await market.positions(i);
        if (owner.toLowerCase() === state.wallet.address.toLowerCase()) {
          myPos.push({
            positionId: i,
            collateral: BigInt(collateral),
            debt: BigInt(debt),
            owner,
            assetId: Number(assetId),
            healthFactor: Number(healthFactor),
          });
        }
      } catch { /* skip */ }
    }
    state.mkt.myPositions = myPos;
    state.mkt.loadedAt = Date.now();
  } catch (e) { state.mkt.err = e.message || String(e); }
  state.mkt.loading = false;
  onUpdate?.();
}

export async function openMarketPosition(assetId, toast, onUpdate) {
  if (state.mktBusy) return;
  state.mktBusy = true;
  state.proving = true;
  onUpdate?.();
  try {
    await submitMarket("openPosition", { assetId: String(assetId) });
    toast("Position opened");
    await marketRefresh(onUpdate);
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false;
  state.proving = false;
  onUpdate?.();
}

export async function supplyToMarket(positionId, amount, assetId, toast, onUpdate) {
  if (state.mktBusy) return;
  state.mktBusy = true;
  state.proving = true;
  onUpdate?.();
  try {
    const { handle, proof } = await encryptAmount(amount);
    const tokenAddr = assetId === 1 ? state.CFG.usdc : state.CFG.eurc;
    await erc20Approve(tokenAddr, state.CFG.market, amount);
    await submitMarket("supply", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Supplied to market");
    await marketRefresh(onUpdate);
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false;
  state.proving = false;
  onUpdate?.();
}

export async function borrowFromMarket(positionId, amount, toast, onUpdate) {
  if (state.mktBusy) return;
  state.mktBusy = true;
  state.proving = true;
  onUpdate?.();
  try {
    const { handle, proof } = await encryptAmount(amount);
    await submitMarket("borrow", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Borrowed from market");
    await marketRefresh(onUpdate);
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false;
  state.proving = false;
  onUpdate?.();
}

export async function repayToMarket(positionId, amount, assetId, toast, onUpdate) {
  if (state.mktBusy) return;
  state.mktBusy = true;
  state.proving = true;
  onUpdate?.();
  try {
    const { handle, proof } = await encryptAmount(amount);
    const tokenAddr = assetId === 1 ? state.CFG.usdc : state.CFG.eurc;
    await erc20Approve(tokenAddr, state.CFG.market, amount);
    await submitMarket("repay", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Repaid to market");
    await marketRefresh(onUpdate);
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false;
  state.proving = false;
  onUpdate?.();
}

// ─── Rendering helpers ───
function supplyPanel() {
  return marketAssets().map((a) => {
    const hasPos = state.mkt.myPositions.some((p) => p.assetId === a.id);
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
  const positions = state.mkt.myPositions;
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
  const positions = state.mkt.myPositions;
  if (!positions.length) return `<p class="empty" style="padding:20px">No positions yet.</p>`;
  return positions.map((p) => {
    const health = p.healthFactor > 0 ? (p.healthFactor / 100).toFixed(2) : "—";
    return `<div class="hrow" style="padding:12px 0;border-bottom:1px solid rgba(128,128,128,0.15)">
      <span class="hrow-main"><span class="hsym">Position #${p.positionId}</span><span class="muted small"> ${esc(mSym(p.assetId))} · health ${esc(health)}</span></span>
      <div class="lp-btns"><button class="lp-b" data-mktsupply="${p.assetId}" data-posid="${p.positionId}">Add Collateral</button></div>
    </div>`;
  }).join("");
}

export function lendingPanel() {
  const subTabs = [["lend", "Supply"], ["borrow", "Borrow"], ["positions", "My Positions"]];
  const subnav = `<nav class="subtabs">${subTabs.map(([k, l]) =>
    `<button class="subtab ${state.lendTab === k ? "on" : ""}" data-lendtab="${k}">${l}</button>`
  ).join("")}</nav>`;
  if (state.lendTab === "positions") return `<div class="panel">${subnav}${positionsPanel()}</div>`;
  if (state.lendTab === "borrow") return `<div class="panel">${subnav}${borrowPanel()}</div>`;
  return `<div class="panel">${subnav}${supplyPanel()}</div>`;
}
