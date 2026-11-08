import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { MetricsProvider } from './hooks/MetricsProvider';
import { Containers } from './pages/Containers';
import { Dashboard } from './pages/Dashboard';
import { Databases } from './pages/Databases';
import { Deployments } from './pages/Deployments';
import { Domains } from './pages/Domains';
import { Login } from './pages/Login';
import { Logs } from './pages/Logs';
import { Projects } from './pages/Projects';
import { Settings } from './pages/Settings';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              element={
                <RequireAuth>
                  {/* Metrics sockets only exist once there is a session. */}
                  <MetricsProvider>
                    <Layout />
                  </MetricsProvider>
                </RequireAuth>
              }
            >
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
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
