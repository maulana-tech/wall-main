const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "circuits/build");
const CONFIG = path.join(B, "web_config.json");

module.exports = (req, res) => {
  if (!fs.existsSync(CONFIG)) {
    return res.status(503).json({ error: "run scripts/deploy.js first" });
  }
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.end(fs.readFileSync(CONFIG, "utf8"));
};
