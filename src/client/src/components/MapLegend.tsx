export function MapLegend() {
  return (
    <div className="legend" aria-label="Map legend">
      <span><i className="negative" /> Negative</span>
      <span><i className="neutral" /> Neutral</span>
      <span><i className="positive" /> Positive</span>
      <span><i className="nodata" /> No data</span>
      <span><i className="hidden" /> Low sample</span>
    </div>
  );
}
