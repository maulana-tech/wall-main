import { describe, expect, test } from "bun:test";
import { getRecentBlockRange } from "./rpc.js";

describe("getRecentBlockRange", () => {
  test("limits event scans to the latest 10,000 blocks", () => {
    const range = getRecentBlockRange(49_100);

    expect(range).toEqual({ fromBlock: 39_101, toBlock: 49_100 });
    expect(range.toBlock - range.fromBlock + 1).toBe(10_000);
  });

  test("does not produce a negative start block", () => {
    expect(getRecentBlockRange(500)).toEqual({ fromBlock: 0, toBlock: 500 });
  });
});
