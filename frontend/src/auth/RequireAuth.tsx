import type { JSX, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { Skeleton } from '../components/Skeleton';

/**
 * Gate for the authenticated shell.
 *
 * While /api/auth/me is in flight we render a skeleton rather than the login
 * page — otherwise a refresh on /dashboard would flash the login screen and
 * then jump back, which looks like a logout.
 */
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div style={{ padding: 24, display: 'grid', gap: 12, maxWidth: 520 }}>
        <Skeleton height="18px" width="180px" />
        <Skeleton height="72px" />
        <Skeleton height="72px" />
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
