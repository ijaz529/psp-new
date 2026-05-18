/**
 * Luhn (mod-10) check. Standard payment-card algorithm.
 * Skips non-digit characters, then validates from the right.
 */
export function isValidLuhn(input: string): boolean {
  const s = input.replace(/\D/g, '');
  if (s.length < 12 || s.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
