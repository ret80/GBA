// Flag helpers for the SM83 (Game Boy) CPU.
//
// Flags are produced by small arithmetic helpers and a handful of precomputed
// lookup tables. Computing the tables once at module load keeps the hot path
// free of branches for the most common cases (INC/DEC/logic) and follows the
// "table-driven decode" approach used by modern interpreters.

export const FZ = 0x80; // zero
export const FN = 0x40; // subtract
export const FH = 0x20; // half carry / borrow
export const FC = 0x10; // carry / borrow
export const FLAG_MASK = 0xf0;

/** Flags after `INC r` for every possible input value. */
export const INC_FLAGS = new Uint8Array(256);
/** Flags after `DEC r` for every possible input value. */
export const DEC_FLAGS = new Uint8Array(256);
/** Flags after an AND/OR/XOR producing the given value. */
export const LOGIC_FLAGS = new Uint8Array(256);

for (let i = 0; i < 256; i++) {
  const inc = (i + 1) & 0xff;
  INC_FLAGS[i] = (inc === 0 ? FZ : 0) | ((i & 0x0f) === 0x0f ? FH : 0);

  const dec = (i - 1) & 0xff;
  DEC_FLAGS[i] = (dec === 0 ? FZ : 0) | FN | ((i & 0x0f) === 0 ? FH : 0);

  LOGIC_FLAGS[i] = i === 0 ? FZ : 0;
}

/** Flags produced by `ADD a, b` (carry-in separately for ADC). */
export function addFlags(a: number, b: number, carry = 0): number {
  const r = a + b + carry;
  let f = 0;
  if (((a & 0x0f) + (b & 0x0f) + carry) & 0x10) f |= FH;
  if (r & 0x100) f |= FC;
  if ((r & 0xff) === 0) f |= FZ;
  return f;
}

/** Flags produced by `SUB a, b` / `CP a, b` (borrow-in separately for SBC). */
export function subFlags(a: number, b: number, carry = 0): number {
  const r = a - b - carry;
  let f = FN;
  if (((a & 0x0f) - (b & 0x0f) - carry) < 0) f |= FH;
  if (r < 0) f |= FC;
  if ((r & 0xff) === 0) f |= FZ;
  return f;
}

/**
 * Flags for `ADD SP, e8` / `LD HL, SP+e8`: H and C are computed from the
 * unsigned low nibble/byte of the offset only, Z and N are always cleared.
 */
export function addSpFlags(sp: number, e8: number): number {
  let f = 0;
  if (((sp & 0x0f) + (e8 & 0x0f)) & 0x10) f |= FH;
  if (((sp & 0xff) + (e8 & 0xff)) & 0x100) f |= FC;
  return f;
}
