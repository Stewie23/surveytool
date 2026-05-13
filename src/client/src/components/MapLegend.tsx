import { paletteGradient, type PaletteColor } from "../lib/colorScale";

type Props = {
  palette?: PaletteColor[];
};

export function MapLegend({ palette }: Props) {
  return (
    <div className="legend" aria-label="Map legend">
      <div className="legend__scale">
        <i style={{ background: paletteGradient(palette) }} />
        <span>
          <b>Low</b>
          <b>High</b>
        </span>
      </div>
      <span><i className="nodata" /> No data</span>
      <span><i className="hidden" /> Low sample</span>
    </div>
  );
}
