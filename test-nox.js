const { ethers } = require('ethers');
const { createEthersHandleClient } = require('@iexec-nox/handle');

async function test() {
  const provider = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');
  const w = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), provider);
  const noxClient = await createEthersHandleClient(w);
  console.log("Client created");
  try {
    const value = 100n; // BigInt test
    const result = await noxClient.encryptInput(value, 'uint256', '0x295e4b7aF572FE8D66f9fa3ae4B9AF1404b3418C');
    console.log("Encrypted!");
  } catch (e) {
    console.error("Encryption error:", e.message);
  }
}
test();
