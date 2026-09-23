"use client";

import { useId, useState } from "react";

/**
 * A password input with a show/hide toggle.
 *
 * The toggle is a real button inside the field, not an icon with a click
 * handler: it has to be reachable by keyboard and announce its state, because
 * the people most helped by revealing a password are often the ones least able
 * to see whether it is revealed.
 *
 * `type` is swapped rather than using a text input with a masking font, so
 * password managers still recognise the field and browsers still offer to save
 * it.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  error,
  required = true,
  disabled = false,
  placeholder,
  children,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  autoComplete: "current-password" | "new-password";
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Rendered beside the label — a "Forgot password?" link, typically. */
  children?: React.ReactNode;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  const [visible, setVisible] = useState(false);

  return (
    <div className="field">
      <div className="labelrow">
        <label htmlFor={fieldId}>{label}</label>
        {children}
      </div>

      <div className="pwwrap">
        <input
          id={fieldId}
          type={visible ? "text" : "password"}
          required={required}
          disabled={disabled}
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="pwtoggle"
          // The control's name states what pressing it does; `aria-pressed`
          // carries the current state. Both, because either alone is ambiguous.
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff /> : <Eye />}
        </button>
      </div>

      {error ? (
        <div className="error">{error}</div>
      ) : hint ? (
        <div className="hint">{hint}</div>
      ) : null}
    </div>
  );
}

function Eye() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.4 3.3" />
      <path d="M6.2 6.2A18 18 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.1-1.4" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m3 3 18 18" />
    </svg>
  );
}
