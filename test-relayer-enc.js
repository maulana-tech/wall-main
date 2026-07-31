const { ethers } = require("ethers");
const { createEthersHandleClient } = require("@iexec-nox/handle");
const fs = require("fs");

async function run() {
  const env = fs.readFileSync(".env", "utf8").split("\n").find(l => l.startsWith("RELAYER_PRIVATE_KEY="));
  const relayerSecret = env ? env.split("=")[1].trim() : null;
  if(!relayerSecret) throw new Error("No relayer secret in env");
  const relayer = new ethers.Wallet(relayerSecret);
  console.log("Relayer:", relayer.address);

  const provider = new ethers.JsonRpcProvider("http://localhost:8787/api/rpc");
  const w = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), provider);
  console.log("Test wallet:", w.address);

  let res = await fetch(`http://localhost:8787/api/faucet?to=${w.address}`);
  await res.json();

  const noxClient = await createEthersHandleClient(w);
  
  // Encrypt for Relayer instead of Pool!
  const enc = await noxClient.encryptInput(1000000000n, "uint256", relayer.address);
  
  res = await fetch("http://localhost:8787/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "deposit",
      handle: ethers.hexlify(enc.handle),
      handleProof: ethers.hexlify(enc.handleProof),
      assetId: "1"
    })
  });
  console.log(await res.json());
}
run().catch(e => console.error(e));
