import { createContext, useContext, type JSX, type ReactNode } from 'react';
import { useMetricsSocket, type UseMetricsSocketResult } from './useMetricsSocket';

const MetricsContext = createContext<UseMetricsSocketResult | null>(null);

/**
 * Exactly one WebSocket per page.
 *
 * The sidebar badge and the dashboard cards both need the same live data; if
 * each called useMetricsSocket() themselves the browser would open two sockets
 * (and reconnect twice). One provider, one connection.
 */
export function MetricsProvider({ children }: { children: ReactNode }): JSX.Element {
  const metrics = useMetricsSocket();
  return <MetricsContext.Provider value={metrics}>{children}</MetricsContext.Provider>;
}

export function useMetrics(): UseMetricsSocketResult {
  const context = useContext(MetricsContext);
  if (!context) throw new Error('useMetrics must be used inside <MetricsProvider>');
  return context;
}
