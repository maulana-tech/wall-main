// Relayer + config server for the Wall web wallet. Handles pool operations
// (deposit/withdraw/transfer) and market operations (open/supply/borrow/repay/liquidate).
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG = path.join(ROOT, "config.json");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const HEX = /^[0-9a-fA-F]+$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const INT = /^-?[0-9]+$/;

const POOL_ABI = [
  "function deposit(bytes,bytes,uint256) external",
  "function withdraw(bytes,bytes,uint256) external",
  "function transfer(address,bytes,bytes,uint256) external",
];

const MARKET_ABI = [
  "function openPosition(uint256 assetId) external returns (uint256)",
  "function supply(uint256 positionId, bytes, bytes) external",
  "function borrow(uint256 positionId, bytes, bytes) external",
  "function repay(uint256 positionId, bytes, bytes) external",
  "function liquidate(uint256 positionId, bytes, bytes) external",
];

app.get("/api/config", (_req, res) => {
  if (!fs.existsSync(CONFIG)) return res.status(503).json({ error: "config not found — run scripts/deploy.js" });
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: "bad config: " + e.message });
  }
});

app.post("/api/submit", async (req, res) => {
  const { action, handle, handleProof, recipient, extAmount, fee, assetId } = req.body || {};
  for (const [k, v, re] of [
    ["action", action, /^[a-z]+$/],
    ["handle", handle, HEX],
    ["handleProof", handleProof, HEX],
    ["recipient", recipient, ADDR],
    ["extAmount", String(extAmount ?? "0"), INT],
    ["fee", String(fee ?? "0"), INT],
    ["assetId", String(assetId ?? "1"), /^[12]$/],
  ]) {
    if (v !== undefined && v !== "" && !re.test(v)) return res.status(400).json({ ok: false, error: `bad field: ${k}` });
  }

  const secret = process.env.RELAYER_PRIVATE_KEY;
  if (!secret) return res.status(500).json({ ok: false, error: "relayer not configured (RELAYER_PRIVATE_KEY)" });

  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const provider = new ethers.JsonRpcProvider(cfg.rpc);
    const signer = new ethers.Wallet(secret, provider);
    const pool = new ethers.Contract(cfg.pool, POOL_ABI, signer);

    let tx;
    switch (action) {
      case "deposit":
        tx = await pool.deposit(handle, handleProof, assetId);
        break;
      case "withdraw":
        tx = await pool.withdraw(handle, handleProof, assetId);
        break;
      case "transfer":
        tx = await pool.transfer(recipient, handle, handleProof, assetId);
        break;
      default:
        return res.status(400).json({ ok: false, error: `unknown action: ${action}` });
    }

    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 400) });
  }
});

app.post("/api/market", async (req, res) => {
  const { action, positionId, handle, handleProof, assetId } = req.body || {};
  for (const [k, v, re] of [
    ["action", action, /^[a-z]+$/],
    ["positionId", String(positionId ?? ""), /^[0-9]+$/],
    ["handle", handle, HEX],
    ["handleProof", handleProof, HEX],
    ["assetId", String(assetId ?? "1"), /^[12]$/],
  ]) {
    if (v !== undefined && v !== "" && !re.test(v)) return res.status(400).json({ ok: false, error: `bad field: ${k}` });
  }

  const secret = process.env.RELAYER_PRIVATE_KEY;
  if (!secret) return res.status(500).json({ ok: false, error: "relayer not configured (RELAYER_PRIVATE_KEY)" });

  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const provider = new ethers.JsonRpcProvider(cfg.rpc);
    const signer = new ethers.Wallet(secret, provider);
    const market = new ethers.Contract(cfg.market, MARKET_ABI, signer);

    let tx;
    switch (action) {
      case "openPosition":
        tx = await market.openPosition(assetId);
        break;
      case "supply":
        tx = await market.supply(positionId, handle, handleProof);
        break;
      case "borrow":
        tx = await market.borrow(positionId, handle, handleProof);
        break;
      case "repay":
        tx = await market.repay(positionId, handle, handleProof);
        break;
      case "liquidate":
        tx = await market.liquidate(positionId, handle, handleProof);
        break;
      default:
        return res.status(400).json({ ok: false, error: `unknown action: ${action}` });
    }

    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 400) });
  }
});

app.get("/api/faucet", async (req, res) => {
  const to = req.query.to;
  if (!to || !ADDR.test(to)) return res.status(400).json({ ok: false, error: "bad address" });

  const secret = process.env.RELAYER_PRIVATE_KEY;
  if (!secret) return res.status(500).json({ ok: false, error: "relayer not configured" });

  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const provider = new ethers.JsonRpcProvider(cfg.rpc);
    const signer = new ethers.Wallet(secret, provider);

    const MINT_ABI = ["function mint(address to, uint256 amount) external"];
    const usdc = new ethers.Contract(cfg.usdc, MINT_ABI, signer);
    const eurc = new ethers.Contract(cfg.eurc, MINT_ABI, signer);

    const amount = ethers.parseUnits("1000", 6);
    const [tx1, tx2] = await Promise.all([
      usdc.mint(to, amount),
      eurc.mint(to, amount),
    ]);
    await Promise.all([tx1.wait(), tx2.wait()]);
    res.json({ ok: true, message: "Minted 1000 USDC + 1000 EURC" });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 400) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Wall relayer + config on http://localhost:${PORT}`));
