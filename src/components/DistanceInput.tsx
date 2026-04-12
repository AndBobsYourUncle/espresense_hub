"use client";

import { useEffect, useState } from "react";
import {
  formatForInput,
  parseDistance,
  stepMetersFor,
  unitSuffix,
} from "@/lib/units";
import { useUnits } from "./UnitsProvider";

interface Props {
  /** Current value in meters (always — even when the UI is imperial). */
  valueMeters: number;
  /** Called with the new value in meters. */
  onChangeMeters: (m: number) => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Optional id linked to a label. */
  id?: string;
}

/**
 * Distance input that always reads/writes in meters but shows the current
 * value in the user's chosen unit system. Accepts free-form imperial input
 * (`210`, `17'6`, `17ft 6in`, …) and falls back to plain decimal in metric.
 *
 * - ↑ / ↓ nudges by one unit (1 in / 5 cm)
 * - Reformats on blur and on external value change (but never mid-typing)
 */
export default function DistanceInput({
  valueMeters,
  onChangeMeters,
  className,
  placeholder,
  autoFocus,
  id,
}: Props) {
  const { units } = useUnits();
  const [text, setText] = useState(() => formatForInput(valueMeters, units));
  const [focused, setFocused] = useState(false);

  // Reformat the displayed text whenever the external value or the unit
  // system changes — but only if the user isn't actively typing.
  useEffect(() => {
    if (!focused) {
      setText(formatForInput(valueMeters, units));
    }
    // We deliberately depend on `units` so toggling the unit system updates
    // the displayed text immediately for non-focused inputs.
  }, [valueMeters, units, focused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    const parsed = parseDistance(e.target.value, units);
    if (parsed != null) onChangeMeters(parsed);
  };

  const handleBlur = () => {
    setFocused(false);
    // Snap the displayed text back to canonical form.
    setText(formatForInput(valueMeters, units));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = valueMeters + stepMetersFor(units);
      onChangeMeters(next);
      // Force the display to update even though the input is focused — the
      // useEffect normally skips reformatting while the user is typing.
      setText(formatForInput(next, units));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = valueMeters - stepMetersFor(units);
      onChangeMeters(next);
      setText(formatForInput(next, units));
    }
  };

  return (
    <div className="flex items-baseline gap-1">
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={
          className ??
          "flex-1 font-mono text-sm bg-transparent border-b border-zinc-300 dark:border-zinc-700 focus:border-blue-500 outline-none text-zinc-900 dark:text-zinc-100"
        }
      />
      <span className="text-xs text-zinc-400">{unitSuffix(units)}</span>
    </div>
  );
}
