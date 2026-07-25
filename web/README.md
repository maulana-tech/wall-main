# Wall — web wallet

The browser wallet for the confidential pool on ETH Sepolia. Uses **Nox** for
encrypted balances and **MetaMask** for wallet connection.

## Architecture

```
DEPOSIT (self-custodial):
  browser (encrypt) ──signed by YOUR MetaMask──▶ Sepolia pool
  Your own Ethereum account funds the deposit.

SEND / WITHDRAW (private):
  browser (encrypt) ──proof+handle──▶ relayer ──▶ Sepolia pool
  A relayer submits so your address never appears on-chain.
```

Identity: each Wall wallet is a shielded identity created in-app ("Create wallet"
→ a hex key). That is **separate** from your Ethereum account (MetaMask) — the
Ethereum account holds public funds; the Wall key owns private notes.

## Run

From the repo root, after deploying contracts:

```bash
npm run web:server   # relayer + config API on :8787   (terminal 1)
npm run web:dev      # Vite dev server on :5173          (terminal 2)
```

Open http://localhost:5173.

- **Deposit** deposits public USDC into the pool as a private note.
- **Send privately** pays another address — amount and parties hidden on-chain.
- **Withdraw** withdraws to a public Ethereum address.
- **Auditor view** — paste the auditor secret to reconstruct every note.

`npm run web:build` produces a static bundle in `web/dist`.
