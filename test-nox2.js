const { ethers } = require("ethers");
const { createEthersHandleClient } = require("@iexec-nox/handle");

async function test() {
  const provider = new ethers.JsonRpcProvider("http://localhost:8787/api/rpc");
  const w = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), provider);
  const noxClient = await createEthersHandleClient(w);
  const poolAddr = "0x295e4b7aF572FE8D66f9fa3ae4B9AF1404b3418C";
  const result = await noxClient.encryptInput(1000000000n, "uint256", poolAddr);
  console.log(JSON.stringify(result, null, 2));
}
test();
