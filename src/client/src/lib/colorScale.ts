export type PaletteColor = [number, number, number];

export function colorForAverage(
  value: number | null,
  min: number,
  max: number,
  hidden = false,
  palette?: PaletteColor[]
): string {
  if (hidden) return "#9ca3af";
  if (value === null || Number.isNaN(value)) return "#e5e7eb";
  if (palette?.length) {
    return colorFromPalette(value, min, max, palette);
  }
  if (value === 0 || min === max) return "#f8fafc";

  if (value < 0) {
    const t = Math.min(1, Math.abs(value / Math.min(min, -1)));
    return interpolate("#f8fafc", "#2563eb", t);
  }

  const t = Math.min(1, value / Math.max(max, 1));
  return interpolate("#f8fafc", "#dc2626", t);
}

export function parsePaletteText(text: string): PaletteColor[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): PaletteColor[] => {
      const values = line.split(/\s+/).map(Number);
      if (values.length < 3 || values.some((value) => !Number.isFinite(value))) return [];
      return [[toRgb(values[0]), toRgb(values[1]), toRgb(values[2])]];
    });
}

export function paletteGradient(palette?: PaletteColor[]): string {
  if (!palette?.length) {
    return "linear-gradient(90deg, #2563eb, #f8fafc, #dc2626)";
  }

  const step = Math.max(1, Math.floor(palette.length / 8));
  const stops = palette
    .filter((_, index) => index % step === 0)
    .slice(0, 9)
    .map((color, index, colors) => `${rgb(color)} ${Math.round((index / Math.max(colors.length - 1, 1)) * 100)}%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function colorFromPalette(value: number, min: number, max: number, palette: PaletteColor[]): string {
  if (palette.length === 1 || min === max) return rgb(palette[0]);
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const index = t * (palette.length - 1);
  const lower = Math.floor(index);
  const upper = Math.min(palette.length - 1, lower + 1);
  const localT = index - lower;
  const color = palette[lower].map((channel, channelIndex) => (
    Math.round(channel + (palette[upper][channelIndex] - channel) * localT)
  )) as PaletteColor;
  return rgb(color);
}

function toRgb(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value <= 1 ? value * 255 : value)));
}

function rgb(color: PaletteColor): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function interpolate(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const rgb = a.map((channel, index) => Math.round(channel + (b[index] - channel) * t));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16)
  ];
}
