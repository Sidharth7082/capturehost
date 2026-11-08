import type { JSX } from 'react';
import { Icon, type IconName } from './Icon';
import { Skeleton } from './Skeleton';
import { Sparkline } from './Sparkline';
import './StatCard.css';

export type StatTone = 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface StatCardProps {
  icon: IconName;
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: StatTone;
  /** 0-100. Renders a thin usage bar; omit for non-percentage stats. */
  percent?: number;
  spark?: number[];
  /** Domain for the sparkline. Percentages should pass 100 so a flat series
   *  sits where it belongs instead of being scaled to the top of the box. */
  sparkMax?: number;
  loading?: boolean;
}

/** Tone follows utilisation: quiet until it matters, red when it really matters. */
function toneForPercent(percent: number): StatTone {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warning';
  return 'accent';
}

export function StatCard({
  icon,
  label,
  value,
  unit,
  hint,
  tone,
  percent,
  spark,
  sparkMax,
  loading = false,
}: StatCardProps): JSX.Element {
  const resolvedTone = tone ?? (percent === undefined ? 'accent' : toneForPercent(percent));

  if (loading) {
    return (
      <div className="stat-card" aria-busy="true">
        <div className="stat-card__top">
          <Skeleton width="26px" height="26px" radius="7px" />
          <Skeleton width="60px" height="12px" />
        </div>
        <Skeleton width="90px" height="28px" />
        <Skeleton width="100%" height="4px" />
      </div>
    );
  }

  return (
    <div className="stat-card">
      <div className="stat-card__top">
        <span className="stat-card__icon" data-tone={resolvedTone}>
          <Icon name={icon} size={15} />
        </span>
        <span className="stat-card__label">{label}</span>
      </div>

      <div className="stat-card__value-row">
        <span className="stat-card__value">{value}</span>
        {unit && <span className="stat-card__unit">{unit}</span>}
      </div>

      {percent !== undefined ? (
        <div
          className="stat-card__track"
          role="progressbar"
          aria-label={`${label} usage`}
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="stat-card__fill"
            data-tone={resolvedTone}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      ) : null}

      {spark && spark.length > 1 && (
        <div className="stat-card__spark">
          <Sparkline values={spark} max={sparkMax} tone={resolvedTone} />
        </div>
      )}

      {hint && <span className="stat-card__hint">{hint}</span>}
    </div>
  );
}
