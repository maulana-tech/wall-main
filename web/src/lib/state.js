// ─── Shared mutable state ───
// All modules import from here. Single source of truth.

export const state = {
  CFG: null,
  wallet: null,
  noxClient: null,

  notes: [],
  history: [],
  localHist: [],

  view: "landing",   // "landing" | "home"
  sheet: null,
  tab: "portfolio",  // "portfolio" | "lending"
  lendTab: "lend",   // "lend" | "borrow" | "positions"
  asset: 1,
  proving: false,
  heartbeat: 0,

  prices: { eurUsd: 1.08 },

  mkt: {
    myPositions: [],
    loadedAt: 0,
    loading: false,
    err: null,
  },
  mktBusy: false,
  mktSheetData: null,
};
