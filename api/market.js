const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const CONFIG = path.join(__dirname, "..", "config.json");

const MARKET_ABI = [
  "function openPosition(uint256 assetId) external returns (uint256)",
  "function supply(uint256 positionId, bytes, bytes) external",
  "function borrow(uint256 positionId, bytes, bytes) external",
  "function repay(uint256 positionId, bytes, bytes) external",
  "function liquidate(uint256 positionId, bytes, bytes) external",
];

const HEX = /^[0-9a-fA-F]+$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { action, positionId, handle, handleProof, assetId } = body;

  for (const [k, v, re] of [
    ["action", action, /^[a-z]+$/],
    ["positionId", String(positionId ?? ""), /^[0-9]+$/],
    ["handle", handle, HEX],
    ["handleProof", handleProof, HEX],
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
    const market = new ethers.Contract(config.market, MARKET_ABI, signer);

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
};
