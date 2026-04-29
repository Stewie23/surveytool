import { ratingValues } from "../lib/validation";

type Props = {
  min: number;
  max: number;
  value: number | null;
  onChange: (value: number) => void;
};

export function RatingScale({ min, max, value, onChange }: Props) {
  return (
    <div className="rating-scale" role="radiogroup" aria-label="Rating">
      {ratingValues(min, max).map((rating) => (
        <button
          key={rating}
          type="button"
          role="radio"
          aria-checked={value === rating}
          className={value === rating ? "selected" : ""}
          onClick={() => onChange(rating)}
        >
          {rating > 0 ? `+${rating}` : rating}
        </button>
      ))}
    </div>
  );
}
