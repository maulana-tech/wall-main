const { ethers } = require("ethers");
const { createEthersHandleClient } = require("@iexec-nox/handle");

async function run() {
  console.log("Starting e2e test...");
  const provider = new ethers.JsonRpcProvider("http://localhost:8787/api/rpc");
  const w = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), provider);
  console.log("Test wallet:", w.address);

  // 1. Faucet
  console.log("Requesting faucet...");
  let res = await fetch(`http://localhost:8787/api/faucet?to=${w.address}`);
  let j = await res.json();
  if (!j.ok) throw new Error("Faucet failed: " + j.error);
  console.log("Faucet success!");

  // 2. Encrypt
  console.log("Initializing Nox Client...");
  const noxClient = await createEthersHandleClient(w);
  console.log("Encrypting 100 USDC...");
  const poolAddr = "0x295e4b7aF572FE8D66f9fa3ae4B9AF1404b3418C"; // from config.json
  const enc = await noxClient.encryptInput(1000000000n, "uint256", poolAddr);
  console.log("Encrypted!");

  // 3. Deposit
  console.log("Submitting deposit to relayer...");
  res = await fetch("http://localhost:8787/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "deposit",
      handle: ethers.hexlify(enc.handle),
      handleProof: ethers.hexlify(enc.handleProof),
      assetId: "1" // 1 = USDC
    })
  });
  j = await res.json();
  if (!j.ok) throw new Error("Deposit failed: " + j.error);
  console.log("Deposit success! txHash:", j.txHash);
}

run().catch(e => console.error(e));
