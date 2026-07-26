const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");

const POOL_ABI = [
  "function admin() external view returns (address)",
  "function auditor() external view returns (address)",
  "function usdc() external view returns (address)",
  "function eurc() external view returns (address)",
  "function addViewer(address viewer) external",
];

const MARKET_ABI = [
  "function admin() external view returns (address)",
  "function auditor() external view returns (address)",
  "function oracle() external view returns (address)",
  "function nextPositionId() external view returns (uint256)",
];

async function deploy() {
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
  const privateKey = process.env.PRIVATE_KEY;
  const auditor = process.env.AUDITOR_ADDRESS;

  if (!privateKey) throw new Error("PRIVATE_KEY required");
  if (!auditor) throw new Error("AUDITOR_ADDRESS required");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  console.log("Deploying from:", signer.address);

  // Deploy mock tokens
  const MockUSDC = await ethers.getContractFactory("MockUSDC", signer);
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  console.log("USDC:", await usdc.getAddress());

  const MockEURC = await ethers.getContractFactory("MockEURC", signer);
  const eurc = await MockEURC.deploy();
  await eurc.waitForDeployment();
  console.log("EURC:", await eurc.getAddress());

  // Deploy pool
  const WallPool = await ethers.getContractFactory("WallPool", signer);
  const pool = await WallPool.deploy(
    await usdc.getAddress(),
    await eurc.getAddress(),
    auditor
  );
  await pool.waitForDeployment();
  console.log("Pool:", await pool.getAddress());

  // Deploy market
  const WallMarket = await ethers.getContractFactory("WallMarket", signer);
  const market = await WallMarket.deploy(
    await usdc.getAddress(),
    await eurc.getAddress(),
    signer.address,
    auditor
  );
  await market.waitForDeployment();
  console.log("Market:", await market.getAddress());

  // Save config
  const config = {
    pool: await pool.getAddress(),
    market: await market.getAddress(),
    usdc: await usdc.getAddress(),
    eurc: await eurc.getAddress(),
    auditor,
    admin: signer.address,
    rpc: rpcUrl,
    chainId: (await provider.getNetwork()).chainId.toString(),
  };

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(config, null, 2)
  );
  console.log("Config saved to:", CONFIG_PATH);

  return config;
}

if (require.main === module) {
  deploy().catch(console.error);
}

module.exports = { deploy };
