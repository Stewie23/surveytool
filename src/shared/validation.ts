export function isValidPostalCode(value: string): boolean {
  return /^\d{5}$/.test(value.trim());
}
