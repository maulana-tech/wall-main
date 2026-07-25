# AGENTS.md — Wall (privacy wallet on ETH Sepolia with Nox)

## What this is

Wall is a privacy wallet on **ETH Sepolia** using **iExec Nox** (TEE-based confidential computing). It provides:
- **Confidential Pool**: Encrypted balances via Nox handles (deposit/withdraw/transfer)
- **Confidential Market**: Lending/borrowing with encrypted positions
- **Auditor disclosure**: Selective disclosure via Nox ACL (auditor can decrypt)

Built for **WTF Hackathon Summer Edition** (iExec Nox challenge).

## Prerequisites

- Node 20.x
- Foundry (`forge`) — for Solidity compilation and testing
- MetaMask browser extension (for wallet connection)
- Nox JS SDK (`@iexec-nox/handle`)
- Sepolia ETH (from faucet)

## Key commands

```bash
npm install

# Build contracts
forge build --use 0.8.35

# Run tests
forge test --use 0.8.35 -vv

# Deploy to Sepolia
PRIVATE_KEY=0x... AUDITOR_ADDRESS=0x... node scripts/deploy.js

# Web wallet
npm run web:server   # relayer + config on :8787 (terminal 1)
npm run web:dev      # Vite dev server on :5173 (terminal 2)

# Chrome extension
npm run ext:build    # outputs to extension/dist
```

## Architecture

```
src/                 Solidity contracts (Foundry)
  WallPool.sol      Confidential pool with Nox encrypted balances
  WallMarket.sol    Confidential lending market
  mocks/             Test ERC-20 tokens (USDC, EURC)

circuits/            circom ZK circuits (reference/architecture docs)
  transfer.circom    Original ZK circuit (kept for reference)
  swap.circom        Swap circuit (kept for reference)
  elgamal.circom     Auditor encryption (kept for reference)

client/lib/          Off-chain core (CommonJS)
  nox-client.js      Nox JS SDK wrapper (encrypt/decrypt)
  eth.js             ethers.js chain interaction
  crypto.js          Poseidon hash, Note, Key (unchanged)
  tree.js            Off-chain Merkle tree (unchanged)
  encryption.js      NaCl box encryption (unchanged)
  auditor.js         Baby Jubjub ElGamal (unchanged)
  identity.js        Wallet identity derivation (unchanged)
  extdata.js         External data encoding (adapted for ETH addresses)
  transaction.js     Witness building (unchanged)

api/                 Vercel serverless relayers
  submit.js          Relayer for pool operations (ethers.js)
  config.js          Serves public wallet config

web/                 Vite + vanilla JS wallet UI
  src/main.js        Core wallet SPA
  src/eth-adapter.js ETH-specific chain interactions
  src/style.css      Styling (unchained)

test/                Foundry tests (Solidity)
script/              Foundry deployment scripts
```

## Conventions an agent must follow

- **Nox replaces ZK proofs for privacy.** The circom circuits are kept as architecture documentation but are NOT used at runtime. Privacy comes from Nox TEE (encrypted handles + ACL).
- **Foundry for Solidity.** Use `forge build --use 0.8.35` (Nox requires Solidity ^0.8.35).
- **Nox compute contract addresses are chain-specific.** See `lib/nox-protocol-contracts/contracts/sdk/Nox.sol` for the mapping (Localhost, Sepolia, Arbitrum Sepolia).
- **`Nox.allowThis()` and `Nox.allow()` after EVERY operation.** Forgetting these makes handles inaccessible on the next transaction.
- **Transient handles must be persisted.** Use `Nox.toTransientEuint256()` + `Nox.persistTransientHandle()` for initialization.
- **MetaMask for wallet connection.** Use MetaMask/ethers.js for all wallet interactions.
- **CommonJS throughout** (`"type": "commonjs"` in package.json). The web layer uses Vite to bundle for the browser.
- **`circuits/build/` is the state directory.** Config files like `web_config.json` are written here by deployment scripts.
- **`api/_config.js` is the deployed contract addresses config.** Referenced by both serverless functions and deployment scripts.

## Running on Sepolia

1. Get Sepolia ETH from faucet
2. Get test USDC/EURC (or deploy mocks)
3. Deploy contracts: `PRIVATE_KEY=0x... AUDITOR_ADDRESS=0x... node scripts/deploy.js`
4. Start the relayer and dev server (see Key commands above)

## Gotchas

- Nox operations are **asynchronous** (TEE computation happens off-chain). The contract emits events, and the Runner processes them.
- `Nox.add()`, `Nox.sub()` return **wrapping arithmetic** by default. Use `Nox.safeAdd()`/`Nox.safeSub()` for production.
- The Nox compute contract must be deployed on the target chain. Check `Nox.noxComputeContract()` for supported chains.
- The `encrypted-types` npm package provides Solidity types (`euint256`, `externalEuint256`, etc.).
- The web wallet proxies `/api` to `localhost:8787` via Vite's dev server proxy.
- Extension builds use `VITE_EXT=1` to disable Workers and `VITE_API_BASE` to point at the deployed relayer.
