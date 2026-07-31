const { ethers } = require("ethers");
const { createEthersHandleClient } = require("@iexec-nox/handle");
async function test() {
  const provider = new ethers.JsonRpcProvider("http://localhost:8787/api/rpc");
  const w = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), provider);
  const noxClient = await createEthersHandleClient(w);
  console.log("SDK Compute Contract:", noxClient.config.smartContractAddress);
}
test();
