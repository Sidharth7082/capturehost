import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { MetricsProvider } from './hooks/MetricsProvider';
import { Containers } from './pages/Containers';
import { Dashboard } from './pages/Dashboard';
import { Databases } from './pages/Databases';
import { Deployments } from './pages/Deployments';
import { Domains } from './pages/Domains';
import { Logs } from './pages/Logs';
import { Projects } from './pages/Projects';
import { Settings } from './pages/Settings';

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <MetricsProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="projects" element={<Projects />} />
              <Route path="containers" element={<Containers />} />
              <Route path="deployments" element={<Deployments />} />
              <Route path="domains" element={<Domains />} />
              <Route path="databases" element={<Databases />} />
              <Route path="logs" element={<Logs />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </MetricsProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
