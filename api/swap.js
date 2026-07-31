const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const CONFIG = path.join(__dirname, "..", "config.json");

const SWAP_ABI = [
  "function swap(bytes32 inputHandle, bytes inputProof, bytes32 outputHandle, bytes outputProof, uint256 fromAssetId, uint256 toAssetId) external",
  "function rate() external view returns (uint256)",
];

const HEX = /^(0x)?[0-9a-fA-F]+$/;
const INT = /^[0-9]+$/;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { action, inputHandle, inputProof, outputHandle, outputProof, fromAssetId, toAssetId } = body;

  if (action !== "swap") {
    return res.status(400).json({ ok: false, error: `unknown action: ${action}` });
  }

  for (const [k, v, re] of [
    ["inputHandle", inputHandle, HEX],
    ["inputProof", inputProof, HEX],
    ["outputHandle", outputHandle, HEX],
    ["outputProof", outputProof, HEX],
    ["fromAssetId", String(fromAssetId ?? ""), INT],
    ["toAssetId", String(toAssetId ?? ""), INT],
  ]) {
    if (!v || !re.test(v)) {
      return res.status(400).json({ ok: false, error: `bad field: ${k}` });
    }
  }

  const secret = process.env.RELAYER_PRIVATE_KEY;
  if (!secret) {
    return res.status(500).json({ ok: false, error: "relayer not configured (RELAYER_PRIVATE_KEY)" });
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    if (!config.swap) {
      return res.status(500).json({ ok: false, error: "swap contract not deployed" });
    }
    const provider = new ethers.JsonRpcProvider(config.rpc);
    const signer = new ethers.Wallet(secret, provider);
    const swap = new ethers.Contract(config.swap, SWAP_ABI, signer);

    const tx = await swap.swap(
      inputHandle,
      inputProof,
      outputHandle,
      outputProof,
      fromAssetId,
      toAssetId
    );

    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 400) });
  }
};
