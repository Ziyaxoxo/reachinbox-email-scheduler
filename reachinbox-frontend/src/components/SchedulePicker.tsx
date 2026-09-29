"use client";

import { useState, useRef, useEffect } from "react";
import { CalendarClock } from "lucide-react";
import { format } from "date-fns";
import { clsx } from "clsx";

interface SchedulePickerProps {
  value: Date;
  onChange: (date: Date) => void;
  minDate?: Date;
}

const QUICK = [
  { label: "10:00 AM", offset: 0, at: 10 },
  { label: "10:00 AM", offset: 1, at: 10 },
  { label: "11:00 AM", offset: 0, at: 11 },
  { label: "3:00 PM", offset: 0, at: 15 },
];

export function SchedulePicker({ value, onChange, minDate }: SchedulePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /**
   * Draft date and time held locally until the user confirms.
   *
   * Binding the inputs directly to `value` clobbered the other field: editing
   * the time republished a Date that still carried the old date, resetting the
   * date input and silently discarding the user's choice.
   */
  const [draftDate, setDraftDate] = useState(() => format(value, "yyyy-MM-dd"));
  const [draftTime, setDraftTime] = useState(() => format(value, "HH:mm"));

  useEffect(() => {
    if (!open) {
      setDraftDate(format(value, "yyyy-MM-dd"));
      setDraftTime(format(value, "HH:mm"));
    }
  }, [open, value]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function commit() {
    const [y, m, d] = draftDate.split("-").map(Number);
    const [hh, mm] = draftTime.split(":").map(Number);
    if (!y || !m || !d || typeof hh !== "number" || typeof mm !== "number") return;

    const next = new Date(value);
    next.setFullYear(y, m - 1, d);
    next.setHours(hh, mm, 0, 0);
    onChange(next);
    setOpen(false);
  }

  function pick(offset: number, hour: number) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(hour, 0, 0, 0);
    onChange(d);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Schedule send time, currently ${format(value, "MMM d, yyyy HH:mm")}`}
        className="btn-brand-outline btn-sm"
      >
        <CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />
        {format(value, "MMM d, yyyy · HH:mm")}
      </button>

      {open ? (
        <div className="popover" role="dialog" aria-label="Schedule email">
          <p className="text-xs font-medium text-ink-900 mb-2">Send Later</p>

          <p className="field-label">Pick date &amp; time</p>
          <div className="grid grid-cols-2 gap-1.5 mb-3">
            <label className="sr-only" htmlFor="sp-date">
              Date
            </label>
            <input
              id="sp-date"
              type="date"
              className="field field-sm"
              value={draftDate}
              min={minDate ? format(minDate, "yyyy-MM-dd") : undefined}
              onChange={(e) => setDraftDate(e.target.value)}
            />
            <label className="sr-only" htmlFor="sp-time">
              Time
            </label>
            <input
              id="sp-time"
              type="time"
              className="field field-sm"
              value={draftTime}
              onChange={(e) => setDraftTime(e.target.value)}
            />
          </div>

          <p className="field-label">Timezone</p>
          <p className="text-2xs text-ink-muted mb-2">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </p>

          <div className="border-t border-line pt-2 space-y-0.5">
            {QUICK.map((slot, i) => (
              <button
                key={`${slot.offset}-${slot.at}-${i}`}
                type="button"
                onClick={() => pick(slot.offset, slot.at)}
                className="popover-option"
              >
                {i === 1 ? "Tomorrow, " : ""}
                {slot.label}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-end gap-1.5 mt-2 pt-2 border-t border-line">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              className="btn-brand-outline btn-sm"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
