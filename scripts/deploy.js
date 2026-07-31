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

  const getFactory = (name, file) => {
    const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, "out", file || `${name}.sol`, `${name}.json`)));
    return new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  };

  // Deploy mock tokens
  const MockUSDC = getFactory("MockUSDC", "MockTokens.sol");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  console.log("USDC:", await usdc.getAddress());

  const MockEURC = getFactory("MockEURC", "MockTokens.sol");
  const eurc = await MockEURC.deploy();
  await eurc.waitForDeployment();
  console.log("EURC:", await eurc.getAddress());

  // Deploy pool
  const WallPool = getFactory("WallPool");
  const pool = await WallPool.deploy(
    await usdc.getAddress(),
    await eurc.getAddress(),
    auditor
  );
  await pool.waitForDeployment();
  console.log("Pool:", await pool.getAddress());

  // Deploy market
  const WallMarket = getFactory("WallMarket");
  const market = await WallMarket.deploy(
    await usdc.getAddress(),
    await eurc.getAddress(),
    signer.address,
    auditor
  );
  await market.waitForDeployment();
  console.log("Market:", await market.getAddress());

  // Deploy swap (fixed 1 EURC = 1.08 USDC)
  const WallSwap = getFactory("WallSwap");
  const swap = await WallSwap.deploy(
    await usdc.getAddress(),
    await eurc.getAddress(),
    10800000n // 1.08 * 1e7
  );
  await swap.waitForDeployment();
  console.log("Swap:", await swap.getAddress());

  // Fund swap contract with test tokens for liquidity
  await (await usdc.mint(await swap.getAddress(), 10000n * 10n ** 7n)).wait();
  await (await eurc.mint(await swap.getAddress(), 10000n * 10n ** 7n)).wait();
  console.log("Funded swap with 10000 USDC + 10000 EURC");

  // Save config
  const config = {
    pool: await pool.getAddress(),
    market: await market.getAddress(),
    swap: await swap.getAddress(),
    usdc: await usdc.getAddress(),
    eurc: await eurc.getAddress(),
    auditor,
    admin: signer.address,
    rpc: rpcUrl,
    chainId: (await provider.getNetwork()).chainId.toString(),
    assets: [
      { id: 1, symbol: "USDC", decimals: 7 },
      { id: 2, symbol: "EURC", decimals: 7 },
    ],
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
