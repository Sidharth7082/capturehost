import { type JSX } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';

/**
 * Catch-all for URLs that match no route. Without it the router renders the
 * layout with an empty content area — the sidebar says one thing, the page says
 * nothing, and it looks like the app broke rather than the link did.
 */
export function NotFound(): JSX.Element {
  return (
    <Card>
      <EmptyState
        icon="search"
        title="This page does not exist"
        description="The address does not match anything in CaptureHost. It may have been removed, or the link may be mistyped."
        action={
          <Link className="button button--primary" to="/">
            Back to dashboard
          </Link>
        }
      />
    </Card>
  );
}
