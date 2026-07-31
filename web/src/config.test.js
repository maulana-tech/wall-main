import { describe, expect, test } from "bun:test";
import { normalizeConfig } from "./config.js";

describe("normalizeConfig", () => {
  test("adds the deployed mock assets when the API config omits them", () => {
    expect(normalizeConfig({ pool: "0xpool" })).toEqual({
      pool: "0xpool",
      assets: [
        { id: 1, symbol: "USDC", decimals: 7 },
        { id: 2, symbol: "EURC", decimals: 7 },
      ],
    });
  });

  test("preserves an explicitly configured asset list", () => {
    const assets = [{ id: 9, symbol: "TEST", decimals: 18 }];
    expect(normalizeConfig({ assets }).assets).toBe(assets);
  });
});
