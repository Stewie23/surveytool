export function isValidPostalCode(value: string): boolean {
  return /^\d{5}$/.test(value.trim());
}

export function ratingValues(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}
