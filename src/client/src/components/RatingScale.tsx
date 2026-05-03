import { ratingValues } from "../lib/validation";

type Props = {
  min: number;
  max: number;
  labels?: Record<string, string>;
  value: number | null;
  onChange: (value: number) => void;
};

export function RatingScale({ min, max, labels = {}, value, onChange }: Props) {
  return (
    <div className="rating-scale" role="radiogroup" aria-label="Rating">
      {ratingValues(min, max).map((rating) => {
        const numericLabel = rating > 0 ? `+${rating}` : String(rating);
        const textLabel = labels[String(rating)]?.trim();

        return (
          <button
            key={rating}
            type="button"
            role="radio"
            aria-checked={value === rating}
            className={value === rating ? "selected" : ""}
            onClick={() => onChange(rating)}
          >
            <span className="rating-scale__value">{numericLabel}</span>
            {textLabel ? <span className="rating-scale__label">{textLabel}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
