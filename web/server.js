// Relayer + config server for the Wall web wallet. Handles pool operations
// (deposit/withdraw/transfer) and market operations (open/supply/borrow/repay/liquidate).
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
const CONFIG = path.join(ROOT, "config.json");

// Load .env (simple parser — no dotenv dependency needed)
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const HEX = /^(0x)?[0-9a-fA-F]+$/;
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
    const ERC20 = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];
    switch (action) {
      case "deposit": {
        const tokenAddr = String(assetId) === "1" ? cfg.usdc : cfg.eurc;
        const token = new ethers.Contract(tokenAddr, ERC20, signer);
        const allowance = await token.allowance(signer.address, cfg.pool);
        if (allowance < ethers.MaxUint256 / 2n) {
          const appTx = await token.approve(cfg.pool, ethers.MaxUint256);
          await appTx.wait();
        }
        tx = await pool.deposit(handle, handleProof, assetId);
        break;
      }
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
    const ERC20 = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];

    // Helper: ensure relayer has approved the market contract for the given token
    async function ensureMarketAllowance(aid) {
      const tokenAddr = String(aid) === "1" ? cfg.usdc : cfg.eurc;
      const token = new ethers.Contract(tokenAddr, ERC20, signer);
      const allowance = await token.allowance(signer.address, cfg.market);
      if (allowance < ethers.MaxUint256 / 2n) {
        const appTx = await token.approve(cfg.market, ethers.MaxUint256);
        await appTx.wait();
      }
    }

    switch (action) {
      case "openPosition":
        tx = await market.openPosition(assetId);
        break;
      case "supply":
        await ensureMarketAllowance(assetId);
        tx = await market.supply(positionId, handle, handleProof);
        break;
      case "borrow":
        tx = await market.borrow(positionId, handle, handleProof);
        break;
      case "repay":
        await ensureMarketAllowance(assetId);
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
    const tx1 = await usdc.mint(to, amount);
    await tx1.wait();
    const tx2 = await eurc.mint(to, amount);
    await tx2.wait();
    res.json({ ok: true, message: "Minted 1000 USDC + 1000 EURC" });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 400) });
  }
});

// ---------- RPC proxy (avoids browser CORS / 403 issues) ----------
app.post("/api/rpc", async (req, res) => {
  try {
    const cfg = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : {};
    const rpcUrl = cfg.rpc || "https://ethereum-sepolia-rpc.publicnode.com";
    const upstream = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.text();
    res.setHeader("Content-Type", "application/json");
    res.status(upstream.status).end(data);
  } catch (e) {
    res.status(502).json({ jsonrpc: "2.0", error: { code: -32603, message: "RPC proxy error: " + String(e.message || e).slice(0, 200) }, id: req.body?.id ?? null });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Wall relayer + config on http://localhost:${PORT}`));
