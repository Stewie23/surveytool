import { isValidPostalCode } from "../lib/validation";

type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
};

export function PostalCodeInput({ value, onChange, disabled = false, error }: Props) {
  const validationError = value.length > 0 && !isValidPostalCode(value) ? "Enter exactly 5 digits." : undefined;
  const message = error ?? validationError;
  return (
    <label className="field">
      <span>Postleitzahl</span>
      <input
        inputMode="numeric"
        autoComplete="postal-code"
        disabled={disabled}
        maxLength={5}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 5))}
        aria-describedby={message ? "postal-code-error" : undefined}
        aria-invalid={Boolean(message)}
        placeholder="10115"
      />
      {message ? (
        <small className="field__error" id="postal-code-error" role="alert">
          {message}
        </small>
      ) : null}
    </label>
  );
}
