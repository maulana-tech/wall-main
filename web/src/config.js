export const DEFAULT_ASSETS = Object.freeze([
  Object.freeze({ id: 1, symbol: "USDC", decimals: 7 }),
  Object.freeze({ id: 2, symbol: "EURC", decimals: 7 }),
]);

export function normalizeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  if (Array.isArray(config.assets) && config.assets.length > 0) return config;

  return {
    ...config,
    assets: DEFAULT_ASSETS.map((asset) => ({ ...asset })),
  };
}
