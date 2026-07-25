const { createEthersHandleClient } = require("@iexec-nox/handle");
const { ethers } = require("ethers");

class NoxClient {
  constructor(provider, signer) {
    this.provider = provider;
    this.signer = signer;
    this.handleClient = null;
  }

  async init() {
    this.handleClient = await createEthersHandleClient(this.signer);
    return this;
  }

  async encryptInput(value) {
    if (!this.handleClient) throw new Error("NoxClient not initialized");
    const result = await this.handleClient.encryptInput(value);
    return {
      handle: result.handle,
      proof: result.proof,
    };
  }

  async decrypt(handle) {
    if (!this.handleClient) throw new Error("NoxClient not initialized");
    return await this.handleClient.decrypt(handle);
  }

  async publicDecrypt(handle, proof) {
    if (!this.handleClient) throw new Error("NoxClient not initialized");
    return await this.handleClient.publicDecrypt(handle, proof);
  }

  async viewACL(handle) {
    if (!this.handleClient) throw new Error("NoxClient not initialized");
    return await this.handleClient.viewACL(handle);
  }
}

async function createNoxClient(rpcUrl, privateKey) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const client = new NoxClient(provider, signer);
  return await client.init();
}

async function createNoxClientFromBrowser() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const client = new NoxClient(provider, signer);
  return await client.init();
}

module.exports = {
  NoxClient,
  createNoxClient,
  createNoxClientFromBrowser,
};
