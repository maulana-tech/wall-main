# Wall — Chrome extension

The full Wall wallet, packaged as an MV3 browser extension. Uses Nox for
encrypted balances and MetaMask for wallet connection.

## Build

```bash
npm install
npm run ext:build      # → extension/dist  (manifest + popup)
```

## Load in Chrome

1. `npm run ext:build`
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `extension/dist`.
4. Click the Wall icon. Create or restore a wallet.

## What's enforced by the manifest

`content_security_policy.extension_pages` allows `wasm-unsafe-eval` (for snarkjs
WASM) and pins `connect-src` to the relayer, the Sepolia RPC, and the
font CDN — nothing else. No remote scripts, no `eval`.
