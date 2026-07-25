// extDataHash binds external (non-private) transaction data into the proof.
// Encoding adapted for Ethereum: 20-byte address instead of Stellar strkey.
//   u32_be(20) || address_bytes(20)
//   || i128_be(ext_amount) || i128_be(fee)
//   || u32_be(len(enc1)) || enc1 || u32_be(len(enc2)) || enc2
// hash = keccak256(buffer) mod P. `recipient` is a 0x-prefixed hex address.
const { keccak256 } = require("js-sha3");
const { P } = require("./crypto");

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

// i128 two's complement, 16-byte big-endian (matches Rust i128::to_be_bytes).
function i128be(x) {
  const v = BigInt.asUintN(128, BigInt(x));
  return Buffer.from(v.toString(16).padStart(32, "0"), "hex");
}

function encodeExtData(ed) {
  const recipient = ed.recipient || "";
  // Ethereum: 20-byte address (strip 0x prefix)
  const addrHex = recipient.startsWith("0x") ? recipient.slice(2) : recipient;
  const addrBytes = Buffer.from(addrHex.padStart(40, "0"), "hex");
  const e1 = ed.encryptedOutput1 ? Buffer.from(ed.encryptedOutput1, "hex") : Buffer.alloc(0);
  const e2 = ed.encryptedOutput2 ? Buffer.from(ed.encryptedOutput2, "hex") : Buffer.alloc(0);
  return Buffer.concat([
    u32be(addrBytes.length), addrBytes,
    i128be(ed.extAmount ?? 0),
    i128be(ed.fee ?? 0),
    u32be(e1.length), e1,
    u32be(e2.length), e2,
  ]);
}

function extDataHash(ed) {
  return BigInt("0x" + keccak256(encodeExtData(ed))) % P;
}

module.exports = { encodeExtData, extDataHash };
