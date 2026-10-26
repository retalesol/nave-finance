import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { RELAYER_SWEEP_RESERVE_WEI, sweepExcess } from "./relayerSweep.js";

test("sweep leaves the 0.05 reserve and sends only the excess", () => {
  const reserve = RELAYER_SWEEP_RESERVE_WEI;
  assert.equal(reserve, parseEther("0.05"));
  assert.equal(sweepExcess(parseEther("0.08"), reserve), parseEther("0.03"));
  assert.equal(parseEther("0.08") - sweepExcess(parseEther("0.08"), reserve), reserve);
  assert.equal(sweepExcess(reserve, reserve), 0n);
  assert.equal(sweepExcess(parseEther("0.049"), reserve), 0n);
  assert.equal(sweepExcess(0n, reserve), 0n);
  assert.equal(sweepExcess(parseEther("0.050000000000000001"), reserve), 1n);
});
