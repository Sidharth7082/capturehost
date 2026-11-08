import type { CSSProperties, JSX } from 'react';
import './Skeleton.css';

export interface SkeletonProps {
  width?: string;
  height?: string;
  radius?: string;
  className?: string;
}

/** Loading placeholder. Marked aria-hidden: the parent owns the busy state. */
export function Skeleton({ width = '100%', height = '14px', radius = '6px', className = '' }: SkeletonProps): JSX.Element {
  const style: CSSProperties = { width, height, borderRadius: radius };
  return <span className={`skeleton ${className}`.trim()} style={style} aria-hidden="true" />;
}
