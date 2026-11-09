import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { MetricsProvider } from './hooks/MetricsProvider';
import { Containers } from './pages/Containers';
import { Dashboard } from './pages/Dashboard';
import { Backups } from './pages/Backups';
import { Notifications } from './pages/Notifications';
import { Security } from './pages/Security';
import { Domains } from './pages/Domains';
import { Login } from './pages/Login';
import { Logs } from './pages/Logs';
import { NotFound } from './pages/NotFound';
import { ProjectDetail } from './pages/ProjectDetail';
import { Projects } from './pages/Projects';
import { Settings } from './pages/Settings';
import { Databases } from './pages/Databases';
import { DatabaseDetail } from './pages/DatabaseDetail';

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
              <Route path="projects/:id" element={<ProjectDetail />} />
              <Route path="containers" element={<Containers />} />
              <Route path="domains" element={<Domains />} />
              <Route path="databases" element={<Databases />} />
              <Route path="databases/:id" element={<DatabaseDetail />} />
              <Route path="backups" element={<Backups />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="security" element={<Security />} />
              <Route path="logs" element={<Logs />} />
              <Route path="settings" element={<Settings />} />
              {/* TEMPORARY screenshot harness — removed before commit. */}
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
