export const EVENT_RPC_URL = "https://sepolia.drpc.org";
export const MAX_EVENT_BLOCKS = 10_000;

export function getRecentBlockRange(currentBlock, maxBlocks = MAX_EVENT_BLOCKS) {
  if (!Number.isSafeInteger(currentBlock) || currentBlock < 0) {
    throw new RangeError("currentBlock must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks <= 0) {
    throw new RangeError("maxBlocks must be a positive safe integer");
  }

  return {
    fromBlock: Math.max(0, currentBlock - maxBlocks + 1),
    toBlock: currentBlock,
  };
}
