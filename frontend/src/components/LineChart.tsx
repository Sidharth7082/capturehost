import { useMemo, useState, type JSX, type PointerEvent } from 'react';
import './LineChart.css';

export interface LineChartSeries<T> {
  key: string;
  label: string;
  color: string;
  accessor: (point: T) => number | null;
}

export interface LineChartProps<T> {
  data: T[];
  /** X value in epoch milliseconds. */
  x: (point: T) => number;
  series: LineChartSeries<T>[];
  height?: number;
  /** Fixed upper bound (e.g. 100 for percentages). Auto-scales when omitted. */
  max?: number;
  yTicks?: number;
  formatValue?: (value: number) => string;
  formatX?: (timestamp: number) => string;
  ariaLabel: string;
  emptyLabel?: string;
}

/** Viewbox width is arbitrary; only the aspect ratio and stroke rendering matter. */
const VIEW_WIDTH = 1000;

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const stepped = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return stepped * magnitude;
}

/**
 * SVG line chart, no charting library.
 *
 * - `preserveAspectRatio="none"` lets the path stretch to any container width.
 * - every stroked element uses `vector-effect: non-scaling-stroke`, so the
 *   stretch never turns lines into ribbons.
 * - axis labels are HTML, not SVG text, so they are never distorted.
 */
export function LineChart<T>({
  data,
  x,
  series,
  height = 220,
  max,
  yTicks = 4,
  formatValue = (value) => value.toFixed(0),
  formatX = (timestamp) => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  ariaLabel,
  emptyLabel = 'No data yet',
}: LineChartProps<T>): JSX.Element {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const domainMax = useMemo(() => {
    if (max !== undefined) return max;
    let peak = 0;
    for (const point of data) {
      for (const item of series) {
        const value = item.accessor(point);
        if (value !== null && value > peak) peak = value;
      }
    }
    return niceMax(peak * 1.15);
  }, [data, series, max]);

  const xMin = data.length > 0 ? x(data[0] as T) : 0;
  const xMax = data.length > 0 ? x(data[data.length - 1] as T) : 1;
  const xSpan = xMax - xMin || 1;

  const toX = (point: T): number => ((x(point) - xMin) / xSpan) * VIEW_WIDTH;
  const toY = (value: number): number => height - (Math.min(domainMax, Math.max(0, value)) / domainMax) * height;

  const paths = series.map((item) => {
    const commands: string[] = [];
    for (const point of data) {
      const value = item.accessor(point);
      if (value === null) continue;
      commands.push(`${commands.length === 0 ? 'M' : 'L'}${toX(point).toFixed(2)} ${toY(value).toFixed(2)}`);
    }
    return { ...item, path: commands.join(' ') };
  });

  const hoveredPoint = hoverIndex !== null ? data[hoverIndex] : undefined;
  const hoverRatio = hoverIndex !== null && data.length > 1 ? hoverIndex / (data.length - 1) : 0;

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (data.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHoverIndex(Math.round(ratio * (data.length - 1)));
  };

  if (data.length === 0) {
    return (
      <div className="line-chart">
        <div className="line-chart__empty">{emptyLabel}</div>
      </div>
    );
  }

  const gridLines = Array.from({ length: yTicks + 1 }, (_, index) => (height / yTicks) * index);
  const yLabels = Array.from({ length: yTicks + 1 }, (_, index) =>
    formatValue(domainMax - (domainMax / yTicks) * index),
  );

  const xTickCount = 5;
  const xLabels = Array.from({ length: xTickCount }, (_, index) => {
    const timestamp = xMin + (xSpan / (xTickCount - 1)) * index;
    return formatX(timestamp);
  });

  return (
    <div className="line-chart">
      <div className="line-chart__legend">
        {series.map((item) => (
          <span className="line-chart__legend-item" key={item.key}>
            <span className="line-chart__swatch" style={{ background: item.color }} aria-hidden="true" />
            {item.label}
          </span>
        ))}
      </div>

      <div className="line-chart__body" style={{ ['--chart-height' as string]: `${height}px` }}>
        <div className="line-chart__y-axis" aria-hidden="true">
          {yLabels.map((label, index) => (
            <span key={index}>{label}</span>
          ))}
        </div>

        <div
          className="line-chart__plot"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverIndex(null)}
          role="img"
          aria-label={ariaLabel}
        >
          <svg className="line-chart__svg" viewBox={`0 0 ${VIEW_WIDTH} ${height}`} preserveAspectRatio="none">
            {gridLines.map((y, index) => (
              <line
                key={`grid-${index}`}
                className="line-chart__grid"
                x1={0}
                x2={VIEW_WIDTH}
                y1={y}
                y2={y}
              />
            ))}

            {paths.map((item) => (
              <path
                key={item.key}
                className="line-chart__line"
                d={item.path}
                stroke={item.color}
                fill="none"
              />
            ))}

            {hoverIndex !== null && (
              <line
                className="line-chart__cursor"
                x1={toX(data[hoverIndex] as T)}
                x2={toX(data[hoverIndex] as T)}
                y1={0}
                y2={height}
              />
            )}

            {hoverIndex !== null &&
              series.map((item) => {
                const point = data[hoverIndex];
                if (!point) return null;
                const value = item.accessor(point);
                if (value === null) return null;
                return (
                  <circle
                    key={`dot-${item.key}`}
                    className="line-chart__dot"
                    cx={toX(point)}
                    cy={toY(value)}
                    r={3}
                    fill={item.color}
                  />
                );
              })}
          </svg>

          {hoveredPoint && (
            <div className="line-chart__tooltip" style={{ left: `${hoverRatio * 100}%` }}>
              <span className="line-chart__tooltip-time">{formatX(x(hoveredPoint))}</span>
              {series.map((item) => {
                const value = item.accessor(hoveredPoint);
                return (
                  <span className="line-chart__tooltip-row" key={item.key}>
                    <span className="line-chart__swatch" style={{ background: item.color }} aria-hidden="true" />
                    {item.label}
                    <span className="line-chart__tooltip-value">
                      {value === null ? '—' : formatValue(value)}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="line-chart__x-axis" aria-hidden="true">
        {xLabels.map((label, index) => (
          <span key={index}>{label}</span>
        ))}
      </div>
    </div>
  );
}
