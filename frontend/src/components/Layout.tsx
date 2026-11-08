import { useCallback, useEffect, useState, type JSX } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { CommandPalette } from './CommandPalette';
import { Dropdown } from './Dropdown';
import { Icon } from './Icon';
import { useMetrics } from '../hooks/MetricsProvider';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { NAV_PAGES, findPage } from '../navigation';

const STATUS_TEXT = {
  live: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
} as const;

/**
 * App shell: sidebar, topbar, content outlet.
 *
 * Sidebar behaviour:
 *  - >= 900px: fixed rail, collapsible, state remembered in localStorage
 *  - < 900px: slide-over drawer opened by the hamburger, closed on navigation
 */
export function Layout(): JSX.Element {
  const location = useLocation();
  const page = findPage(location.pathname);
  const { status } = useMetrics();

  const isMobile = useMediaQuery('(max-width: 900px)');
  const [collapsed, setCollapsed] = useLocalStorage('capturehost.sidebar.collapsed', false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const hostname = typeof window === 'undefined' ? 'localhost' : window.location.hostname;

  // Cmd+K / Ctrl+K anywhere opens the palette.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Navigating on mobile must close the drawer, otherwise it covers the page.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const badgeState = status === 'live' ? 'live' : status === 'offline' ? 'offline' : 'reconnecting';

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <div
        className="shell"
        data-collapsed={!isMobile && collapsed ? 'true' : 'false'}
        data-drawer={drawerOpen ? 'open' : 'closed'}
      >
        <aside className="sidebar" aria-label="Main navigation">
          <div className="sidebar__brand">
            <span className="sidebar__logo" aria-hidden="true">
              CH
            </span>
            <span className="sidebar__name">CaptureHost</span>
            <span className="sidebar__version">v0.1.0</span>
          </div>

          <nav className="sidebar__nav">
            <p className="sidebar__section">Host</p>
            {NAV_PAGES.slice(0, 4).map((item) => (
              <NavItem key={item.path} item={item} />
            ))}
            <p className="sidebar__section">Network</p>
            {NAV_PAGES.slice(4, 7).map((item) => (
              <NavItem key={item.path} item={item} />
            ))}
            <p className="sidebar__section">System</p>
            {NAV_PAGES.slice(7).map((item) => (
              <NavItem key={item.path} item={item} />
            ))}
          </nav>

          <div className="sidebar__footer">
            <div className="server-badge" title={`${hostname} — ${STATUS_TEXT[status]}`}>
              <span className="server-badge__dot" data-state={badgeState} aria-hidden="true" />
              <span className="server-badge__text">
                <span className="server-badge__host">{hostname}</span>
                <span className="server-badge__state">{STATUS_TEXT[status]}</span>
              </span>
            </div>

            {!isMobile && (
              <button
                type="button"
                className="collapse-button"
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-pressed={collapsed}
              >
                <Icon name="chevron-left" />
                <span>Collapse</span>
              </button>
            )}
          </div>
        </aside>

        {isMobile && drawerOpen && (
          <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
        )}

        <div className="shell__main">
          <header className="topbar">
            {isMobile && (
              <button
                type="button"
                className="icon-button hamburger"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation"
                aria-expanded={drawerOpen}
              >
                <Icon name="menu" />
              </button>
            )}

            <div className="topbar__titles">
              <h1 className="topbar__title">{page.label}</h1>
              <p className="topbar__subtitle">{page.subtitle}</p>
            </div>

            <div className="topbar__actions">
              <button
                type="button"
                className="search-trigger"
                onClick={() => setPaletteOpen(true)}
                aria-label="Search pages (Control K)"
              >
                <Icon name="search" size={15} />
                <span className="search-trigger__label">Search…</span>
                <span className="search-trigger__key" aria-hidden="true">
                  ⌘K
                </span>
              </button>

              <button type="button" className="icon-button" aria-label="Notifications (available in Phase 6)">
                <Icon name="bell" />
                <span className="icon-button__dot" aria-hidden="true" />
              </button>

              <Dropdown
                trigger={<span aria-hidden="true">CH</span>}
                triggerClassName="avatar-button"
                triggerLabel="Account menu"
                items={[
                  { key: 'settings', label: 'Settings', icon: 'settings', onSelect: () => undefined },
                  {
                    key: 'signout',
                    label: 'Sign out',
                    icon: 'close',
                    danger: true,
                    dividerBefore: true,
                    onSelect: () => undefined,
                  },
                ]}
              />
            </div>
          </header>

          <main className="content" id="main-content">
            <Outlet />
          </main>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </>
  );
}

function NavItem({ item }: { item: (typeof NAV_PAGES)[number] }): JSX.Element {
  if (!item.ready) {
    return (
      <button type="button" className="nav-item" disabled aria-disabled="true" title={`${item.label} — Phase ${item.phase}`}>
        <Icon name={item.icon} className="nav-item__icon" />
        <span className="nav-item__label">{item.label}</span>
        <span className="tag-soon">Soon</span>
      </button>
    );
  }

  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      className="nav-item"
    >
      {({ isActive }) => (
        <>
          <Icon name={item.icon} className="nav-item__icon" />
          <span className="nav-item__label">{item.label}</span>
          {isActive && <span className="visually-hidden">(current page)</span>}
        </>
      )}
    </NavLink>
  );
}
