const fs = require("fs");
const path = require("path");

const CONFIG = path.join(__dirname, "..", "config.json");

module.exports = (req, res) => {
  if (!fs.existsSync(CONFIG)) {
    return res.status(503).json({ error: "config not found" });
  }
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.end(fs.readFileSync(CONFIG, "utf8"));
};
