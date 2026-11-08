import type { JSX, SVGProps } from 'react';

/**
 * Inline SVG icon set.
 *
 * No icon font, no CDN, no dependency: each glyph is a couple of paths with
 * `stroke="currentColor"`, so icons inherit colour and scale with font-size
 * driven sizing. `aria-hidden` by default — the surrounding control carries
 * the accessible name.
 */
export type IconName =
  | 'dashboard'
  | 'projects'
  | 'containers'
  | 'deployments'
  | 'domains'
  | 'databases'
  | 'logs'
  | 'settings'
  | 'search'
  | 'bell'
  | 'menu'
  | 'close'
  | 'chevron-left'
  | 'chevron-down'
  | 'more'
  | 'plus'
  | 'cpu'
  | 'memory'
  | 'disk'
  | 'clock'
  | 'network'
  | 'gpu'
  | 'alert'
  | 'info'
  | 'check'
  | 'refresh';

const PATHS: Record<IconName, JSX.Element> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  projects: (
    <>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 18z" />
    </>
  ),
  containers: (
    <>
      <path d="M12 3 20 7.5v9L12 21 4 16.5v-9z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </>
  ),
  deployments: (
    <>
      <path d="M12 3v10" />
      <path d="m8 7 4-4 4 4" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>
  ),
  domains: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 9h17M3.5 15h17" />
      <path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
    </>
  ),
  databases: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  logs: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  bell: (
    <>
      <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6z" />
      <path d="M10.5 20a2 2 0 0 0 3 0" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  'chevron-left': <path d="m14 6-6 6 6 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
    </>
  ),
  memory: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M7 17v3M12 17v3M17 17v3M7 10v4M12 10v4M17 10v4" />
    </>
  ),
  disk: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  network: (
    <>
      <path d="M3 16.5h3l3-8 4 11 3-6h5" />
    </>
  ),
  gpu: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M7 17v3M17 17v3M8 9h8" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4 2.8 20h18.4z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  check: <path d="m5 13 4.5 4.5L19 7" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 4v4h-4" />
    </>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
