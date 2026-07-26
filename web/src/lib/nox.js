import { createEthersHandleClient } from "@iexec-nox/handle";
import { state } from "./state.js";

export async function initNox(signer) {
  state.noxClient = await createEthersHandleClient(signer);
}

export async function encryptAmount(value) {
  if (!state.noxClient) throw new Error("Wallet not initialized");
  const result = await state.noxClient.encryptInput(value);
  return { handle: result.handle, proof: result.proof };
}

export async function decryptHandle(handle) {
  if (!state.noxClient) throw new Error("Wallet not initialized");
  return await state.noxClient.decrypt(handle);
}
