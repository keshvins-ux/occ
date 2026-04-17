import { createContext, useContext, useState, useEffect, useMemo } from "react";

// Dynamic presets — "This month" and "Last month" compute days on the fly
function buildPresets() {
  const now = new Date();
  const dayOfMonth = now.getDate(); // e.g. 18 on April 18th

  // Last month: full previous month
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0); // last day of prev month
  const lastMonthDays = lastMonthEnd.getDate(); // e.g. 31 for March
  const lastMonthTotalDays = dayOfMonth + lastMonthDays; // from 1st of last month to today

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const thisMonthName = monthNames[now.getMonth()];
  const lastMonthName = monthNames[(now.getMonth() + 11) % 12];

  return [
    { label: `This Month (${thisMonthName})`, days: dayOfMonth, key: "this_month" },
    { label: `Last Month (${lastMonthName})`, days: lastMonthTotalDays, key: "last_month" },
    { label: "90 days", days: 90, key: "90" },
    { label: "180 days", days: 180, key: "180" },
    { label: "365 days", days: 365, key: "365" },
  ];
}

export const DATE_PRESETS = buildPresets();

const STORAGE_KEY = "occ_date_range";

const DateRangeContext = createContext(null);

export function DateRangeProvider({ children }) {
  const [range, setRange] = useState(() => {
    // Rebuild presets fresh (days change daily for "This month")
    const presets = buildPresets();

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.key) {
          // Match by key so "This month" recalculates days correctly each day
          const match = presets.find((p) => p.key === parsed.key);
          if (match) return match;
        }
        // Fallback: if saved has a days value, use it
        if (parsed && parsed.days) return parsed;
      }
    } catch {}
    return presets[0]; // default: This Month
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ key: range.key, days: range.days, label: range.label }));
    } catch {}
  }, [range]);

  const value = useMemo(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - range.days);
    from.setHours(0, 0, 0, 0);

    // Previous period of equal length, for delta calculations
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
  if (!ctx) throw new Error("useDateRange must be used within DateRangeContext");
  return ctx;
}
