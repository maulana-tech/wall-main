import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";

export async function connectMetaMask() {
  if (!window.ethereum) throw new Error("MetaMask is required");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const noxClient = await createEthersHandleClient(signer);
  return { signer, address, noxClient };
}

export async function executeTx(signer, contractAddress, abi, method, args) {
  const contract = new ethers.Contract(contractAddress, abi, signer);
  const tx = await contract[method](...args);
  return await tx.wait();
}
