#!/usr/bin/env node
/**
 * Reads a private key (base58 or JSON byte array) from argv[2] and writes
 * a Solana keypair JSON file to the path in argv[3].
 */
import { writeFileSync, chmodSync } from "node:fs";

const input = process.argv[2]?.trim();
const outPath = process.argv[3];

if (!input || !outPath) {
  console.error("Usage: parse-keypair.mjs <private-key> <output-path>");
  process.exit(1);
}

function decodeBase58(str) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map = new Map([...alphabet].map((c, i) => [c, i]));
  let zeros = 0;
  for (const c of str) {
    if (c === "1") zeros++;
    else break;
  }
  let num = 0n;
  for (const c of str) {
    const val = map.get(c);
    if (val === undefined) throw new Error("Invalid base58 character");
    num = num * 58n + BigInt(val);
  }
  let bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 255n));
    num >>= 8n;
  }
  bytes = [...Array(zeros).fill(0), ...bytes];
  return Uint8Array.from(bytes);
}

function parseSecretKey(raw) {
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error("JSON key must be a 64-byte array");
    }
    return Uint8Array.from(arr);
  }
  const decoded = decodeBase58(raw);
  if (decoded.length !== 64) {
    throw new Error(`Expected 64-byte secret key, got ${decoded.length} bytes`);
  }
  return decoded;
}

try {
  const secret = parseSecretKey(input);
  writeFileSync(outPath, JSON.stringify([...secret]));
  chmodSync(outPath, 0o600);
} catch (err) {
  console.error(`Invalid private key: ${err.message}`);
  process.exit(1);
}
