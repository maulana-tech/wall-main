// Relayer + config server for the web wallet. It only ever sees PUBLIC data —
// the encrypted handle, the proof, and the public recipient/amount. Nox handles
// the encrypted computation off-chain via TEE.
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const CONFIG = path.join(B, "web_config.json");

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

app.get("/api/config", (_req, res) => {
  if (!fs.existsSync(CONFIG)) return res.status(503).json({ error: "run scripts/deploy.js first" });
  res.json(JSON.parse(fs.readFileSync(CONFIG, "utf8")));
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

app.listen(8787, () => console.log("relayer + config server on http://localhost:8787"));
