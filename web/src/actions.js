import { ethers } from "ethers";
import { state } from "./state.js";
import { say, render, toast, swapPreview } from "./ui.js";
import { POOL_ABI, MARKET_ABI, API_BASE, RPC_URL } from "./constants.js";
import { encryptAmount, erc20Approve, decryptHandle } from "./wallet.js";
import { submitToRelayer, submitMarket } from "./api.js";
import { toRaw, decOf, toHuman, symOf, pushHistory } from "./utils.js";
import { $ } from "./utils.js";
import { EVENT_RPC_URL, getRecentBlockRange } from "./rpc.js";

export async function doDeposit(amount, assetId) {
  say("approving token transfer…");
  const tokenAddr = assetId === 1 ? state.CFG.usdc : state.CFG.eurc;
  await erc20Approve(tokenAddr, state.CFG.pool, amount);
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount, state.CFG.pool);
  say("submitting deposit via MetaMask…");
  const pool = new ethers.Contract(state.CFG.pool, POOL_ABI, state.wallet.signer);
  const tx = await pool.deposit(handle, ethers.hexlify(proof), assetId);
  await tx.wait();
  state.notes.push({ amount, assetId, txHash: tx.hash, ts: Date.now() });
  say("deposited into the wall");
}

export async function doWithdraw(amount, assetId) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount, state.CFG.pool);
  say("submitting withdrawal via MetaMask…");
  const pool = new ethers.Contract(state.CFG.pool, POOL_ABI, state.wallet.signer);
  const tx = await pool.withdraw(handle, ethers.hexlify(proof), assetId);
  await tx.wait();
  state.notes = state.notes.filter((n) => !(Number(n.assetId) === Number(assetId) && n.amount <= amount));
  say("withdrew from the wall");
}

export async function doTransfer(amount, assetId, toAddr) {
  say("encrypting amount via Nox…");
  const { handle, proof } = await encryptAmount(amount, state.CFG.pool);
  say("submitting transfer via MetaMask…");
  const pool = new ethers.Contract(state.CFG.pool, POOL_ABI, state.wallet.signer);
  const tx = await pool.transfer(toAddr, handle, ethers.hexlify(proof), assetId);
  await tx.wait();
  state.notes = state.notes.filter((n) => !(Number(n.assetId) === Number(assetId) && n.amount <= amount));
  say("sent successfully");
  return tx.hash;
}

export async function runSwap() {
  if (!state.wallet) return toast("Connect wallet first");
  const amtRaw = toRaw($("#swap-amt")?.value || "0", decOf(state.swapFrom));
  if (amtRaw <= 0n) return toast("Enter valid amount");
  
  const fromA = state.CFG.assets.find(a => a.id === state.swapFrom);
  const toA = state.CFG.assets.find(a => a.id === state.swapTo);
  if (!fromA || !toA) return toast("Invalid asset");
  const outRaw = swapPreview(amtRaw);
  
  const balanceOf = (id) => state.notes.filter((n) => Number(n.assetId) === Number(id)).reduce((a, n) => a + n.amount, 0n);
  if (balanceOf(state.swapFrom) < amtRaw) return toast("Insufficient private balance");
  
  state.proving = true; render();
  try {
    say("encrypting amounts via Nox…");
    const inputEnc = await encryptAmount(amtRaw, state.CFG.swap);
    const outputEnc = await encryptAmount(outRaw, state.CFG.swap);
    
    say("submitting swap via MetaMask…");
    const swapC = new ethers.Contract(state.CFG.swap, [
      "function swap(uint256,uint256,bytes32,bytes,bytes32,bytes) external"
    ], state.wallet.signer);
    
    const tx = await swapC.swap(
      state.swapFrom, state.swapTo,
      inputEnc.handle, ethers.hexlify(inputEnc.proof),
      outputEnc.handle, ethers.hexlify(outputEnc.proof)
    );
    await tx.wait();
    
    state.notes = state.notes.filter((n) => !(Number(n.assetId) === Number(state.swapFrom) && n.amount <= amtRaw));
    state.notes.push({ amount: outRaw, assetId: state.swapTo, txHash: tx.hash, ts: Date.now() });
    
    toast(`Swapped ${toHuman(amtRaw, decOf(state.swapFrom))} ${fromA.symbol} for ${toHuman(outRaw, decOf(state.swapTo))} ${toA.symbol}`);
    $("#swap-amt").value = "";
    $("#swap-preview").textContent = "0.0";
    rescan();
  } catch (e) {
    say("swap error: " + (e.message || String(e)));
  } finally {
    state.proving = false; render();
  }
}

export async function mintFaucet() {
  if (!state.wallet) return toast("Create or import a wallet first");
  try {
    const res = await fetch(`${API_BASE}/api/faucet?to=${state.wallet.address}`);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    toast("Minted 1000 USDC + 1000 EURC");
  } catch (e) { toast(e.message || "faucet failed"); }
}

export async function marketRefresh() {
  if (!state.CFG?.market || !state.wallet?.provider) return;
  state.mkt.loading = true; state.mkt.err = null;
  try {
    const market = new ethers.Contract(state.CFG.market, MARKET_ABI, state.wallet.provider);
    const nextId = Number(await market.nextPositionId());
    const myPos = [];
    for (let i = 1; i < nextId; i++) {
      try {
        const [collateral, debt, owner, assetId, healthFactor] = await market.positions(i);
        if (owner.toLowerCase() === state.wallet.address.toLowerCase()) {
          myPos.push({ positionId: i, collateral: BigInt(collateral), debt: BigInt(debt), owner, assetId: Number(assetId), healthFactor: Number(healthFactor) });
        }
      } catch { /* skip */ }
    }
    state.mkt.myPositions = myPos;
    state.mkt.loadedAt = Date.now();
  } catch (e) { state.mkt.err = e.message || String(e); }
  state.mkt.loading = false;
  if (state.view === "home" && state.tab === "lending") render();
}

export async function openMarketPosition(assetId) {
  if (state.mktBusy) return;
  state.mktBusy = true; state.proving = true; render();
  try {
    await submitMarket("openPosition", { assetId: String(assetId) });
    toast("Position opened");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false; state.proving = false; render();
}

export async function supplyToMarket() {
  const v = $("#mkt-amt") ? $("#mkt-amt").value : ($("#s-amt") ? $("#s-amt").value : "");
  if (!v || isNaN(v)) return;
  const amount = toRaw(v, decOf(state.mktSheetData.assetId));
  if (amount <= 0n) return;
  
  state.proving = true; render();
  try {
    say("approving token transfer…");
    const tokenAddr = state.mktSheetData.assetId === 1 ? state.CFG.usdc : state.CFG.eurc;
    await erc20Approve(tokenAddr, state.CFG.market, amount);
    say("encrypting amount via Nox…");
    const { handle, proof } = await encryptAmount(amount, state.CFG.market);
    say("submitting supply via MetaMask…");
    const mkt = new ethers.Contract(state.CFG.market, [
      "function supply(bytes32,bytes,uint256) external"
    ], state.wallet.signer);
    const tx = await mkt.supply(handle, ethers.hexlify(proof), state.mktSheetData.assetId);
    await tx.wait();
    
    toast("Supply successful");
    state.sheet = null; rescan();
  } catch (e) { say("supply error: " + (e.message || String(e))); }
  finally { state.proving = false; render(); }
}

export async function borrowFromMarket(positionId, amount) {
  if (state.mktBusy) return;
  state.mktBusy = true; state.proving = true; render();
  try {
    const { handle, proof } = await encryptAmount(amount, state.CFG.market);
    await submitMarket("borrow", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
    });
    toast("Borrowed from market");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false; state.proving = false; render();
}

export async function repayToMarket(positionId, amount, assetId) {
  if (state.mktBusy) return;
  state.mktBusy = true; state.proving = true; render();
  try {
    const { handle, proof } = await encryptAmount(amount, state.CFG.market);
    await submitMarket("repay", {
      positionId: String(positionId),
      handle: ethers.hexlify(handle),
      handleProof: ethers.hexlify(proof),
      assetId: String(assetId),
    });
    toast("Repaid to market");
    await marketRefresh();
  } catch (e) { toast(e.message || "failed"); }
  state.mktBusy = false; state.proving = false; render();
}

export async function runDeposit(amt, assetId) {
  if (state.proving) return;
  state.proving = true; render();
  try {
    await doDeposit(amt, assetId);
    state.sheet = null;
    rescan();
  } catch (e) { say(e.message || String(e)); state.proving = false; render(); return; }
  state.proving = false; render();
}

export async function runAction(kind, args) {
  if (state.proving) return;
  state.proving = true; render();
  try {
    let hash;
    if (kind === "send") hash = await doTransfer(args.amt, args.assetId, args.addr);
    else if (kind === "withdraw") await doWithdraw(args.amt, args.assetId);
    pushHistory({ dir: kind, amount: args.amt.toString(), assetId: args.assetId, hash });
    state.sheet = null;
    rescan();
  } catch (e) { say(e.message || String(e)); state.proving = false; render(); return; }
  state.proving = false; render();
}

export async function fetchEvents() {
  if (!state.CFG?.pool) return [];
  const readProvider = new ethers.JsonRpcProvider(EVENT_RPC_URL, undefined, { batchMaxCount: 1 });
  const currentBlock = await readProvider.getBlockNumber();
  const { fromBlock, toBlock } = getRecentBlockRange(currentBlock);
  
  const pool = new ethers.Contract(state.CFG.pool, [
    "event Deposited(address indexed user, uint256 assetId, uint256 amount)",
    "event Withdrawn(address indexed user, uint256 assetId, uint256 amount)",
    "event Transferred(address indexed from, address indexed to, uint256 assetId, uint256 amount)",
  ], readProvider);
  const [deps, wds, trs] = await Promise.all([
    pool.queryFilter(pool.filters.Deposited(), fromBlock, toBlock),
    pool.queryFilter(pool.filters.Withdrawn(), fromBlock, toBlock),
    pool.queryFilter(pool.filters.Transferred(), fromBlock, toBlock),
  ]);
  let swaps = [];
  if (state.CFG.swap) {
    try {
      const swapC = new ethers.Contract(state.CFG.swap, ["event Swapped(address indexed user, uint256 fromAssetId, uint256 toAssetId)"], readProvider);
      const sw = await swapC.queryFilter(swapC.filters.Swapped(), fromBlock, toBlock);
      swaps = sw.map((e) => ({ ...e, type: "swap" }));
    } catch { /* skip */ }
  }
  return [...deps.map((e) => ({ ...e, type: "deposit" })), ...wds.map((e) => ({ ...e, type: "withdraw" })), ...trs.map((e) => ({ ...e, type: "transfer" })), ...swaps];
}

export async function rescan() {
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

    const readProvider = new ethers.JsonRpcProvider(state.CFG.rpc || RPC_URL, undefined, { batchMaxCount: 1 });
    const pool = new ethers.Contract(state.CFG.pool, POOL_ABI, readProvider);
    state.notes = [];
    for (const asset of state.CFG.assets || []) {
      const handle = await pool.getBalance(state.wallet.address, asset.id);
      if (handle && handle !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        say(`decrypting balance for ${asset.symbol} via TEE enclave...`);
        const decryptedAmount = await decryptHandle(handle);
        state.notes.push({ amount: BigInt(decryptedAmount), assetId: asset.id });
      }
    }
    
    say(`balance synchronized via TEE enclave`);
  } catch (e) { say("couldn't reach the network"); console.error(e); }
  if (!state.proving) render();
}
