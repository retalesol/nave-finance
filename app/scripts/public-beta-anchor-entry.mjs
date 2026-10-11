import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const anchor = require("@coral-xyz/anchor/dist/cjs/index.js");

export const BN = anchor.BN;
export const Program = anchor.Program;
export const AnchorProvider = anchor.AnchorProvider;
export const utils = anchor.utils;
export const setProvider = anchor.setProvider;
export const getProvider = anchor.getProvider;
export const web3 = anchor.web3;
export default anchor;
