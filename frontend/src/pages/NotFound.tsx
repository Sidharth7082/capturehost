import { type JSX } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import notFoundEmptiness from '../assets/empty/not-found.webp';

/**
 * Catch-all for URLs that match no route. Without it the router renders the
 * layout with an empty content area — the sidebar says one thing, the page says
 * nothing, and it looks like the app broke rather than the link did.
 */
export function NotFound(): JSX.Element {
  return (
    <Card>
      <EmptyState
        illustration={{ src: notFoundEmptiness }}
        title="Page not found"
        description="This page doesn't exist or has moved."
        action={
          <Link className="button button--primary" to="/">
            Back to dashboard
          </Link>
        }
      />
    </Card>
  );
}
