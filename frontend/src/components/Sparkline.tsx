import type { JSX } from 'react';
import './Sparkline.css';

export interface SparklineProps {
  values: number[];
  /** Domain maximum. Percentages use 100, network charts use their own peak. */
  max?: number;
  tone?: 'accent' | 'success' | 'warning' | 'danger' | 'info';
}

const TONE_COLOR: Record<NonNullable<SparklineProps['tone']>, string> = {
  accent: 'var(--series-cpu)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  info: 'var(--info)',
};

/**
 * Decorative mini chart for stat cards.
 *
 * Hand-rolled path building: a fixed 100x30 viewBox stretched with
 * preserveAspectRatio="none" means no measuring, no ResizeObserver, no library.
 */
export function Sparkline({ values, max, tone = 'accent' }: SparklineProps): JSX.Element {
  const color = TONE_COLOR[tone];
  const width = 100;
  const height = 30;

  if (values.length < 2) {
    return <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" />;
  }

  const domainMax = max ?? Math.max(...values, 1);
  const stepX = width / (values.length - 1);

  const points = values.map((value, index) => {
    const clamped = Math.min(domainMax, Math.max(0, value));
    const x = index * stepX;
    // y is inverted: SVG origin is top-left.
    const y = height - (clamped / domainMax) * (height - 2) - 1;
    return [x, y] as const;
  });

  const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="sparkline__area" d={area} fill={color} />
      <path className="sparkline__line" d={line} stroke={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
