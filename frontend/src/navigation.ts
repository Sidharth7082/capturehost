import type { IconName } from './components/Icon';

/**
 * Single source of truth for navigation, topbar titles and the command palette.
 * `ready: false` renders a disabled item with a "Soon" tag — the sidebar shows
 * the roadmap instead of hiding it, which is honest about what exists.
 */
export interface NavPage {
  path: string;
  label: string;
  subtitle: string;
  icon: IconName;
  ready: boolean;
  phase: number;
}

export const NAV_PAGES: readonly NavPage[] = [
  {
    path: '/',
    label: 'Dashboard',
    subtitle: 'Live health of this machine',
    icon: 'dashboard',
    ready: true,
    phase: 1,
  },
  {
    path: '/projects',
    label: 'Projects',
    subtitle: 'Repositories deployed from GitHub',
    icon: 'projects',
    ready: true,
    phase: 4,
  },
  {
    path: '/containers',
    label: 'Containers',
    subtitle: 'Docker workloads on this host',
    icon: 'containers',
    ready: true,
    phase: 3,
  },
  {
    path: '/deployments',
    label: 'Deployments',
    subtitle: 'Per-project history lives on each project page',
    icon: 'deployments',
    ready: false,
    phase: 4,
  },
  {
    path: '/domains',
    label: 'Domains',
    subtitle: 'Subdomains routed through Caddy',
    icon: 'domains',
    ready: true,
    phase: 5,
  },
  {
    path: '/databases',
    label: 'Databases',
    subtitle: 'SQLite files and backup status',
    icon: 'databases',
    ready: false,
    phase: 6,
  },
  {
    path: '/logs',
    label: 'Logs',
    subtitle: 'Audit trail of privileged actions',
    icon: 'logs',
    ready: true,
    phase: 2,
  },
  {
    path: '/settings',
    label: 'Settings',
    subtitle: 'Account, security and active sessions',
    icon: 'settings',
    ready: true,
    phase: 2,
  },
];

export function findPage(pathname: string): NavPage {
  const exact = NAV_PAGES.find((page) => page.path === pathname);
  if (exact) return exact;

  // Detail routes (/projects/1) keep the parent page's title in the topbar.
  const parent = NAV_PAGES.find((page) => page.path !== '/' && pathname.startsWith(`${page.path}/`));
  return parent ?? NAV_PAGES[0]!;
}
