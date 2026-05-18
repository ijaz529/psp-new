/**
 * Wire serialization helpers. Internal money values are bigint minor units;
 * over the wire we emit JSON numbers (since amounts comfortably fit in
 * Number.MAX_SAFE_INTEGER for any realistic payment).
 *
 * Throws if a value exceeds the safe range — a defensive check that should
 * never fire for real money in practice, but catches accidental overflow.
 */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function bigintToWire(amount: bigint): number {
  if (amount > MAX_SAFE || amount < -MAX_SAFE) {
    throw new Error(`amount ${amount} exceeds safe integer range for wire serialization`);
  }
  return Number(amount);
}

export function dateToUnix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}
