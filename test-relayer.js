const { ethers } = require("ethers");
async function test() {
  const depositPayload = {
    action: "deposit",
    handle: "0x12345678",
    handleProof: "0x12345678",
    assetId: "1"
  };
  const res = await fetch("http://localhost:8787/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(depositPayload)
  });
  console.log(await res.text());
}
test();
