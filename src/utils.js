// Shared utilities — formatters, date helpers, sort helpers.

export const fmt = (n) =>
  `RM ${Number(n || 0).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const fmt0 = (n) => Number(n || 0).toLocaleString("en-MY");

export const fmtD = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-MY", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

export const fmtDShort = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-MY", { day: "2-digit", month: "short" })
    : "—";

export const fmtDLong = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-MY", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";

export const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  const d1 = new Date(a).getTime();
  const d2 = new Date(b).getTime();
  return Math.round((d2 - d1) / 86400000);
};

export const daysFromNow = (d) => daysBetween(new Date(), d);

export const daysAgo = (d) => daysBetween(d, new Date());

export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

export const startOfDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
};

// Generic sort helper
export function sortBy(arr, key, dir = "desc") {
  const copy = [...(arr || [])];
  copy.sort((a, b) => {
    const A = a?.[key];
    const B = b?.[key];
    if (A == null && B == null) return 0;
    if (A == null) return 1;
    if (B == null) return -1;
    if (typeof A === "number" && typeof B === "number") {
      return dir === "desc" ? B - A : A - B;
    }
    // Try date comparison
    const dA = Date.parse(A);
    const dB = Date.parse(B);
    if (!isNaN(dA) && !isNaN(dB)) {
      return dir === "desc" ? dB - dA : dA - dB;
    }
    return dir === "desc"
      ? String(B).localeCompare(String(A))
      : String(A).localeCompare(String(B));
  });
  return copy;
}

// Filter array by date window (looks at `dateKey` property)
export function filterByDateRange(arr, dateKey, days) {
  if (!arr || !days) return arr || [];
  const cutoff = startOfDaysAgo(days).getTime();
  return arr.filter((r) => {
    const t = Date.parse(r?.[dateKey]);
    return !isNaN(t) && t >= cutoff;
  });
}

// Safe JSON parse
export const safeJson = (s, fallback = null) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// Fetch helper with JSON parsing + error handling
export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const txt = await res.text();
  const data = safeJson(txt, null);
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

// Build date query string from a DateRange preset
// e.g. dateQs(range) → "&days=20&from=2026-04-01" or "&days=51&from=2026-03-01&to=2026-03-31"
export function dateQs(range) {
  let qs = `&days=${range.days}`;
  if (range.fromDate) qs += `&from=${range.fromDate}`;
  if (range.toDate) qs += `&to=${range.toDate}`;
  return qs;
}
