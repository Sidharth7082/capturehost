import { type JSX } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Card } from '../components/Card';
import { StatusPill } from '../components/StatusPill';
import { AuditSection } from './settings/AuditSection';
import { GithubSection } from './settings/GithubSection';
import { PasswordSection } from './settings/PasswordSection';
import { SessionsSection } from './settings/SessionsSection';
import { TwoFactorSection } from './settings/TwoFactorSection';
import { formatClockTime } from '../utils/format';
import './Settings.css';

/**
 * Settings: the security surface for the single admin account.
 *
 * Layout follows the dashboard rhythm — a summary card, then a responsive grid
 * of actionable panels. Backups and notifications stay labelled as future work
 * rather than pretending to exist.
 */
export function Settings(): JSX.Element {
  const { user } = useAuth();

  return (
    <div className="settings-page">
      <Card title="Account" subtitle="One admin account, created from the CLI">
        <div className="security-row">
          <span className="security-row__label">Username</span>
          <span className="security-row__value">{user?.username ?? '—'}</span>
        </div>
        <div className="security-row">
          <span className="security-row__label">Password hashing</span>
          <span className="security-row__value">
            <StatusPill label="argon2id · 64 MB · t=3" tone="success" dot={false} />
          </span>
        </div>
        <div className="security-row">
          <span className="security-row__label">Last password change</span>
          <span className="security-row__value">
            {user?.passwordChangedAt ? formatClockTime(user.passwordChangedAt) : 'never'}
          </span>
        </div>
        <div className="security-row">
          <span className="security-row__label">Two-factor</span>
          <span className="security-row__value">
            <StatusPill
              label={user?.totpEnabled ? 'Enabled' : 'Disabled'}
              tone={user?.totpEnabled ? 'success' : 'warning'}
            />
          </span>
        </div>
        <div className="security-row">
          <span className="security-row__label">Recovery codes left</span>
          <span className="security-row__value">{user?.recoveryCodesRemaining ?? 0}</span>
        </div>
      </Card>

      <div className="security-grid">
        <PasswordSection />
        <TwoFactorSection />
        <SessionsSection />
        <AuditSection />
      </div>

      <GithubSection />

      <Card title="Backups & notifications" subtitle="Arriving in Phase 6">
        <p className="form-hint" style={{ fontSize: 13 }}>
          Scheduled SQLite snapshots and failure notifications are not wired up yet. Nothing here
          is pretending to work: when they land, they will appear as real panels with real state.
        </p>
      </Card>
    </div>
  );
}
