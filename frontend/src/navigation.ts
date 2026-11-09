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
  /** Sidebar group. Explicit, so re-ordering the list cannot move items between groups. */
  section: 'host' | 'network' | 'system';
}

export const NAV_PAGES: readonly NavPage[] = [
  {
    path: '/',
    label: 'Dashboard',
    subtitle: 'Live health of this machine',
    icon: 'dashboard',
    ready: true,
    phase: 1,
    section: 'host',
  },
  {
    path: '/projects',
    label: 'Projects',
    subtitle: 'Repositories deployed from GitHub',
    icon: 'projects',
    ready: true,
    phase: 4,
    section: 'host',
  },
  {
    path: '/containers',
    label: 'Containers',
    subtitle: 'Docker workloads on this host',
    icon: 'containers',
    ready: true,
    phase: 3,
    section: 'host',
  },
  {
    path: '/domains',
    label: 'Domains',
    subtitle: 'Subdomains routed through Caddy',
    icon: 'domains',
    ready: true,
    phase: 5,
    section: 'network',
  },
  {
    path: '/backups',
    label: 'Backups',
    subtitle: 'Encrypted SQLite snapshots',
    icon: 'databases',
    ready: true,
    phase: 6,
    section: 'system',
  },
  {
    path: '/databases',
    label: 'Databases',
    subtitle: 'Postgres containers with volumes, backups and links',
    icon: 'databases',
    ready: true,
    phase: 7,
    section: 'network',
  },
  {
    path: '/notifications',
    label: 'Notifications',
    subtitle: 'Alerts and events',
    icon: 'bell',
    ready: true,
    phase: 6,
    section: 'system',
  },
  {
    path: '/security',
    label: 'Security check',
    subtitle: 'Configuration doctor',
    icon: 'check',
    ready: true,
    phase: 6,
    section: 'system',
  },
  {
    path: '/logs',
    label: 'Logs',
    subtitle: 'Audit trail of privileged actions',
    icon: 'logs',
    ready: true,
    phase: 2,
    section: 'system',
  },
  {
    path: '/settings',
    label: 'Settings',
    subtitle: 'Account, security and active sessions',
    icon: 'settings',
    ready: true,
    phase: 2,
    section: 'system',
  },
];

export function findPage(pathname: string): NavPage {
  const exact = NAV_PAGES.find((page) => page.path === pathname);
  if (exact) return exact;

  // Detail routes (/projects/1) keep the parent page's title in the topbar.
  const parent = NAV_PAGES.find((page) => page.path !== '/' && pathname.startsWith(`${page.path}/`));
  if (parent) return parent;

  // Unknown URL: the NotFound page owns the content, and the topbar must not
  // claim "Dashboard" over it. Not in NAV_PAGES, so it never shows in the sidebar.
  if (pathname !== '/') {
    return {
      path: pathname,
      label: 'Not found',
      subtitle: 'No page matches this address',
      icon: 'alert',
      ready: true,
      phase: 0,
      section: 'system' as const,
    };
  }

  return NAV_PAGES[0]!;
}
