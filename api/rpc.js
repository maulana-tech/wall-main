const fs = require("fs");
const path = require("path");

const CONFIG = path.join(__dirname, "..", "config.json");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

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
    res.status(502).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "RPC proxy error" },
      id: req.body?.id ?? null,
    });
  }
};
