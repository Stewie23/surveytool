export const DEFAULT_MAP_PALETTE = "batlow";

export const MAP_PALETTE_IDS = [
  "batlow",
  "batlowW",
  "batlowK",
  "glasgow",
  "lipari",
  "navia",
  "hawaii",
  "buda",
  "imola",
  "oslo",
  "grayC",
  "nuuk",
  "devon",
  "lajolla",
  "bamako",
  "davos",
  "bilbao",
  "lapaz",
  "acton",
  "turku",
  "tokyo"
] as const;

export type MapPaletteId = typeof MAP_PALETTE_IDS[number];

export function isMapPaletteId(value: string): value is MapPaletteId {
  return (MAP_PALETTE_IDS as readonly string[]).includes(value);
}
