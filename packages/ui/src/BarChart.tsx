'use client';
import { EmptyState } from './primitives';

/**
 * Single-series horizontal bar chart: one hue (brand primary), labels/values in text ink,
 * thin bars with rounded data-ends, per-bar hover tooltip, table fallback via the caller.
 * Multi-series comparisons should be separate small charts, not extra colours.
 */
export function BarChart({ data, format = (n) => n.toLocaleString(), label }: { data: { label: string; value: number }[]; format?: (n: number) => string; label: string }) {
  if (!data.length) return <EmptyState title="No data for this period" />;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <figure aria-label={label} className="space-y-1.5">
      {data.map((d) => (
        <div key={d.label} className="group grid grid-cols-[minmax(6rem,30%)_1fr_auto] items-center gap-2 text-xs" title={`${d.label}: ${format(d.value)}`}>
          <span className="truncate text-muted-foreground">{d.label}</span>
          <span className="h-3 rounded-e bg-muted">
            <span className="block h-3 rounded-e-[4px] bg-primary transition-opacity group-hover:opacity-80" style={{ width: `${Math.max(0, (d.value / max) * 100)}%` }} />
          </span>
          <span className="tabular-nums text-foreground">{format(d.value)}</span>
        </div>
      ))}
    </figure>
  );
}
