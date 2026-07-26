const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const CONFIG = path.join(__dirname, "config.json");
const ADDR = /^0x[0-9a-fA-F]{40}$/;

module.exports = async (req, res) => {
  const to = req.query.to;
  if (!to || !ADDR.test(to)) return res.status(400).json({ ok: false, error: "bad address" });

  const secret = process.env.RELAYER_PRIVATE_KEY;
  if (!secret) return res.status(500).json({ ok: false, error: "relayer not configured" });

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const provider = new ethers.JsonRpcProvider(config.rpc);
    const signer = new ethers.Wallet(secret, provider);

    const MINT_ABI = ["function mint(address to, uint256 amount) external"];
    const usdc = new ethers.Contract(config.usdc, MINT_ABI, signer);
    const eurc = new ethers.Contract(config.eurc, MINT_ABI, signer);

    const amount = ethers.parseUnits("1000", 7);
    const [tx1, tx2] = await Promise.all([
      usdc.mint(to, amount),
      eurc.mint(to, amount),
    ]);
    await Promise.all([tx1.wait(), tx2.wait()]);
    res.json({ ok: true, message: "Minted 1000 USDC + 1000 EURC" });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 400) });
  }
};
