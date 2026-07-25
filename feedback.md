# Wall — Feedback & Design Notes

## What is Wall?

Wall is a privacy wallet on ETH Sepolia that uses **iExec Nox** (TEE-based confidential computing) to encrypt balances and lending positions. Instead of zero-knowledge proofs, Wall relies on Nox handles and ACL to keep amounts confidential while remaining composable on-chain.

## What we built

### Core contracts
- **WallPool.sol** — Confidential pool with encrypted balances (deposit/withdraw/transfer). Each user's balance is an `euint256` handle; the actual value is never stored in plaintext.
- **WallMarket.sol** — Confidential lending market with encrypted collateral and debt positions. Supports supply, borrow, repay, and liquidation.
- **MockTokens.sol** — Test USDC and EURC (7 decimals, mintable) for Sepolia testing.

### Web wallet
- MetaMask integration for wallet connection
- Nox SDK (`@iexec-nox/handle`) for encrypting amounts client-side before sending to the relayer
- Relayer (Express) that submits encrypted operations to the pool/market contracts
- Faucet endpoint for minting test tokens
- Clean UI with Portfolio and Lending tabs

### Architecture
```
User (browser)                Relayer              Contracts (Sepolia)
     │                            │                       │
     ├── encrypt amount ──►       │                       │
     │   (Nox TEE client)         │                       │
     │                            │                       │
     ├── approve ERC20 ───────────────────────────────────┤
     │                            │                       │
     ├── submit {handle,proof} ──►│                       │
     │                            ├── deposit(withdraw)──►│
     │                            │   Nox.fromExternal()  │
     │                            │   Nox.add/sub()       │
     │                            │   Nox.allowThis()     │
     │                            │◄── event ─────────────┤
     │◄── txHash ────────────────│                       │
```

## What we learned

### Nox vs ZK proofs
- **Nox is simpler to integrate** — no circuit compilation, no trusted setup, no proof generation latency
- **Encrypted types compose naturally** — `euint256` values can be added, subtracted, and compared without decryption
- **ACL is powerful** — the auditor can decrypt any balance via `Nox.allow(auditor)`, while users can only see their own
- **Gas is lower** — no on-chain proof verification (just handle + proof bytes)
- **Tradeoff** — requires trust in the TEE; not trustless like ZK. Good for regulated/compliant privacy.

### Hackathon learnings
- Starting from an existing codebase (Wall on Stellar) and migrating to ETH + Nox was faster than building from scratch
- Foundry's `forge build` with `--use 0.8.35` is required for Nox contracts (they need Solidity ^0.8.35)
- The Nox compute contract addresses are chain-specific — Sepolia requires the exact address from `Nox.sol`
- `persistTransientHandle` reverts in constructors — use lazy initialization instead

## What's next

- [ ] End-to-end testing on Sepolia with real MetaMask + Nox encryption
- [ ] Add event scanning to reconstruct encrypted balances from on-chain events
- [ ] Implement auditor dashboard (decrypt positions via Nox ACL)
- [ ] Chrome extension integration (MetaMask from extension popup is limited)
- [ ] Multi-asset support (currently hardcoded to USDC/EURC)
- [ ] Gas estimation and relay fee model

## Running it

```bash
# Install deps
npm install

# Build contracts
~/.foundry/bin/forge build --use 0.8.35

# Run tests
~/.foundry/bin/forge test --use 0.8.35 -vv

# Start relayer + web server
RELAYER_PRIVATE_KEY=0x... node web/server.js

# Start Vite dev server
npm run web:dev
```

## Deployed contracts (Sepolia)

| Contract | Address |
|----------|---------|
| WallPool | `0x295e4b7aF572FE8D66f9fa3ae4B9AF1404b3418C` |
| WallMarket | `0xEB5a95Dac55b829dCbB3341B07b41c99E1Fb1169` |
| MockUSDC | `0xE2084A182c64fC3685ba26E3D832846af6aa54b8` |
| MockEURC | `0xeeb1C3C6d08fd802A292D7B97517F0C41416aF92` |
| Admin/Auditor | `0x3a8d93D5F52a26689b075A49E67F4f8924BeC84B` |
