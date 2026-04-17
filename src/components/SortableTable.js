import { useState, useMemo } from "react";
import Ic from "./Ic";
import { BRAND, COLORS } from "../theme";
import { sortBy } from "../utils";

/**
 * Sortable table. Columns are declared as:
 *   { key, label, align, sortable, render, cellStyle }
 *
 * - `key`         : field in row object (for sorting + render fallback)
 * - `label`       : column header text
 * - `align`       : "left" | "right" | "center"
 * - `sortable`    : boolean (default true if key is set)
 * - `render`      : (row) => ReactNode — optional custom renderer
 * - `cellStyle`   : style object applied to <td>
 *
 * `defaultSort` : { key, dir } — default is first date-ish column desc.
 */
export default function SortableTable({
  columns,
  rows,
  rowKey = (r, i) => r?.id || r?._key || i,
  defaultSort,
  onRowClick,
  rowStyle,
  emptyMessage = "No data to display",
  stickyHeader = false,
}) {
  const [sort, setSort] = useState(() => {
    if (defaultSort) return defaultSort;
    // Auto-detect: first column with key "date" or containing "date"
    const dateCol = columns.find(
      (c) => c.key === "date" || (c.key && c.key.toLowerCase().includes("date"))
    );
    if (dateCol) return { key: dateCol.key, dir: "desc" };
    const firstKey = columns.find((c) => c.key && c.sortable !== false);
    return firstKey ? { key: firstKey.key, dir: "desc" } : { key: null, dir: "desc" };
  });

  const sorted = useMemo(() => {
    if (!sort.key) return rows || [];
    return sortBy(rows || [], sort.key, sort.dir);
  }, [rows, sort]);

  const onSort = (key) => {
    setSort((s) => ({
      key,
      dir: s.key === key && s.dir === "desc" ? "asc" : "desc",
    }));
  };

  return (
    <div style={{ overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead
          style={
            stickyHeader
              ? { position: "sticky", top: 0, background: COLORS.surface, zIndex: 1 }
              : undefined
          }
        >
          <tr>
            {columns.map((c) => {
              const sortable = c.sortable !== false && !!c.key;
              const isActive = sortable && sort.key === c.key;
              const dir = isActive ? sort.dir : null;
              return (
                <th
                  key={c.key || c.label}
                  onClick={() => sortable && onSort(c.key)}
                  style={{
                    padding: "14px 20px",
                    textAlign: c.align || "left",
                    fontSize: 11,
                    color: isActive ? BRAND.accent : COLORS.textFaint,
                    fontWeight: 600,
                    letterSpacing: "0.03em",
                    textTransform: "uppercase",
                    borderBottom: `1px solid ${COLORS.borderFaint}`,
                    whiteSpace: "nowrap",
                    cursor: sortable ? "pointer" : "default",
                    userSelect: "none",
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      justifyContent:
                        c.align === "right"
                          ? "flex-end"
                          : c.align === "center"
                          ? "center"
                          : "flex-start",
                    }}
                  >
                    {c.label}
                    {sortable && (
                      <span style={{ opacity: isActive ? 1 : 0.3 }}>
                        <Ic
                          name={dir === "asc" ? "asc" : "desc"}
                          size={10}
                          color={isActive ? BRAND.accent : COLORS.textFaint}
                        />
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: "40px 20px",
                  textAlign: "center",
                  fontSize: 13,
                  color: COLORS.textFaint,
                }}
              >
                {emptyMessage}
              </td>
            </tr>
          )}
          {sorted.map((row, i) => {
            const extraRowStyle = typeof rowStyle === "function" ? rowStyle(row) : rowStyle || {};
            return (
              <tr
                key={rowKey(row, i)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{
                  borderBottom: `1px solid ${COLORS.borderGhost}`,
                  cursor: onRowClick ? "pointer" : "default",
                  ...extraRowStyle,
                }}
              >
                {columns.map((c) => (
                  <td
                    key={c.key || c.label}
                    style={{
                      padding: "15px 20px",
                      textAlign: c.align || "left",
                      fontSize: 13,
                      color: COLORS.textSecondary,
                      whiteSpace: "nowrap",
                      ...(c.cellStyle || {}),
                    }}
                  >
                    {c.render ? c.render(row) : row[c.key]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
