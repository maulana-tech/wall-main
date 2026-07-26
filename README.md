# Wall — Private Payments on Ethereum

A privacy wallet on **ETH Sepolia** using **iExec Nox** (TEE-based confidential computing). Balances and lending positions are encrypted on-chain via Nox handles — amounts are never stored in plaintext.

Built for **WTF Hackathon Summer Edition** (iExec Nox challenge).

## What it does

- **Confidential Pool**: Deposit, withdraw, and transfer ERC-20 tokens with encrypted balances via Nox
- **Confidential Market**: Lend, borrow, and repay with encrypted collateral/debt positions
- **Auditor disclosure**: Selective disclosure via Nox ACL — the auditor can decrypt any balance
- **Faucet**: Mint test USDC/EURC on Sepolia for testing

## How Nox is used

Wall replaces zero-knowledge proofs with Nox TEE encryption:

1. User encrypts the amount client-side via `@iexec-nox/handle`
2. Encrypted handle + proof are submitted to the relayer
3. Relayer calls the pool/market contract
4. Contract decrypts via `Nox.fromExternal()`, computes on encrypted data
5. Result is stored as an `euint256` handle — never plaintext

The auditor (set at deploy time) can decrypt any balance via `Nox.allow(auditor)`.

## Architecture

```
User (browser)                Relayer (Vercel)         Contracts (Sepolia)
     │                              │                       │
     ├── encrypt amount ─────►      │                       │
     │   (@iexec-nox/handle)        │                       │
     │                              │                       │
     ├── approve ERC20 ─────────────────────────────────────┤
     │                              │                       │
     ├── submit {handle, proof} ──► │                       │
     │                              ├── deposit/withdraw ──►│
     │                              │   Nox.fromExternal()  │
     │                              │   Nox.add/sub()       │
     │                              │   Nox.allowThis()     │
     │                              │◄── event ─────────────┤
     │◄── txHash ──────────────────│                       │
```

## Deployed contracts (Sepolia)

| Contract | Address |
|----------|---------|
| WallPool | [`0x295e4b7aF572FE8D66f9fa3ae4B9AF1404b3418C`](https://sepolia.etherscan.io/address/0x295e4b7aF572FE8D66f9fa3ae4B9AF1404b3418C) |
| WallMarket | [`0xEB5a95Dac55b829dCbB3341B07b41c99E1Fb1169`](https://sepolia.etherscan.io/address/0xEB5a95Dac55b829dCbB3341B07b41c99E1Fb1169) |
| MockUSDC | [`0xE2084A182c64fC3685ba26E3D832846af6aa54b8`](https://sepolia.etherscan.io/address/0xE2084A182c64fC3685ba26E3D832846af6aa54b8) |
| MockEURC | [`0xeeb1C3C6d08fd802A292D7B97517F0C41416aF92`](https://sepolia.etherscan.io/address/0xeeb1C3C6d08fd802A292D7B97517F0C41416aF92) |

## Setup

### Prerequisites
- Node.js 20.x
- Foundry (`forge`) — for Solidity compilation
- MetaMask browser extension
- Sepolia ETH (from faucet)

### Install
```bash
git clone https://github.com/maulana-tech/wall-main.git
cd wall-main
npm install
```

### Build contracts
```bash
forge build --use 0.8.35
```

### Run tests
```bash
forge test --use 0.8.35 -vv
```

### Run locally
```bash
# Terminal 1: relayer + config server
RELAYER_PRIVATE_KEY=0x... node web/server.js

# Terminal 2: Vite dev server
npm run web:dev
```

Open http://localhost:5173, connect MetaMask to Sepolia, and use the faucet button to get test tokens.

### Deploy to Vercel
```bash
vercel deploy --prod
```

Set `RELAYER_PRIVATE_KEY` in Vercel dashboard → Settings → Environment Variables.

## Project structure

```
src/                 Solidity contracts
  WallPool.sol       Confidential pool with Nox encrypted balances
  WallMarket.sol     Confidential lending market
  mocks/             Test ERC-20 tokens (USDC, EURC)

client/lib/          Off-chain core (CommonJS)
  nox-client.js      Nox JS SDK wrapper (encrypt/decrypt)
  eth.js             ethers.js chain interaction (ABIs + classes)

api/                 Vercel serverless functions
  submit.js          Relayer for pool operations
  market.js          Relayer for market operations
  faucet.js          Test token minting
  config.js          Serves public wallet config

web/                 Vite + vanilla JS wallet UI
  src/main.js        Core wallet SPA
  server.js          Express relayer (local dev)

test/                Foundry tests
script/              Foundry deployment scripts
```

## Tech stack

- **Smart contracts**: Solidity ^0.8.35, Foundry, OpenZeppelin
- **Privacy**: iExec Nox Protocol (`@iexec-nox/handle`, `@iexec-nox/nox-protocol-contracts`)
- **Frontend**: Vite, vanilla JavaScript, ethers.js
- **Backend**: Express (local dev), Vercel Serverless Functions (production)
- **Wallet**: MetaMask (Sepolia testnet)

## License

MIT
