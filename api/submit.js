const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const CONFIG = path.join(__dirname, "..", "config.json");

const POOL_ABI = [
  "function deposit(bytes32 inputHandle, bytes inputProof, uint256 assetId) external",
  "function withdraw(bytes32 inputHandle, bytes inputProof, uint256 assetId) external",
  "function transfer(address to, bytes32 inputHandle, bytes inputProof, uint256 assetId) external",
];

const HEX = /^[0-9a-fA-F]+$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const INT = /^-?[0-9]+$/;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { action, handle, handleProof, recipient, extAmount, fee, assetId } = body;

  for (const [k, v, re] of [
    ["action", action, /^[a-z]+$/],
    ["handle", handle, HEX],
    ["handleProof", handleProof, HEX],
    ["recipient", recipient, ADDR],
    ["extAmount", String(extAmount ?? "0"), INT],
    ["fee", String(fee ?? "0"), INT],
    ["assetId", String(assetId ?? "1"), /^[12]$/],
  ]) {
    if (v !== undefined && v !== "" && !re.test(v)) {
      return res.status(400).json({ ok: false, error: `bad field: ${k}` });
    }
  }

  const secret = process.env.RELAYER_PRIVATE_KEY;
  if (!secret) {
    return res.status(500).json({ ok: false, error: "relayer not configured (RELAYER_PRIVATE_KEY)" });
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const provider = new ethers.JsonRpcProvider(config.rpc);
    const signer = new ethers.Wallet(secret, provider);
    const pool = new ethers.Contract(config.pool, POOL_ABI, signer);

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
};
