import { createContext, useContext, useState, useEffect, useMemo } from "react";

export const DATE_PRESETS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "180 days", days: 180 },
  { label: "365 days", days: 365 },
];

const STORAGE_KEY = "occ_date_range";

const DateRangeContext = createContext(null);

export function DateRangeProvider({ children }) {
  const [range, setRange] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.days) return parsed;
      }
    } catch {}
    return DATE_PRESETS[2]; // default 90 days
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(range));
    } catch {}
  }, [range]);

  const value = useMemo(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - range.days);
    from.setHours(0, 0, 0, 0);

    // Previous period of equal length, for MoM/delta calculations
    const prevTo = new Date(from);
    prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo);
    prevFrom.setDate(prevFrom.getDate() - range.days);

    return {
      range,
      setRange,
      from,
      to,
      prevFrom,
      prevTo,
      days: range.days,
      label: range.label,
    };
  }, [range]);

  return (
    <DateRangeContext.Provider value={value}>
      {children}
    </DateRangeContext.Provider>
  );
}

export function useDateRange() {
  const ctx = useContext(DateRangeContext);
  if (!ctx) throw new Error("useDateRange must be used within DateRangeProvider");
  return ctx;
}
