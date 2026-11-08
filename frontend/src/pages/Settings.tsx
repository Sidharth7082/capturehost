import { type JSX } from 'react';
import { Card } from '../components/Card';
import { PagePlaceholder } from './PagePlaceholder';

export function Settings(): JSX.Element {
  return (
    <PagePlaceholder
      phase={6}
      title="Settings"
      description="Account security, notification targets and backup schedule."
    >
      <div className="settings-grid">
        <Card title="Account" subtitle="Single admin account">
          <div className="settings-group">
            <div className="settings-row">
              <span className="settings-row__label">Username</span>
              <span>admin</span>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">Password</span>
              <span>argon2id · change in Phase 2</span>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">Two-factor</span>
              <span>Not configured</span>
            </div>
          </div>
        </Card>

        <Card title="Backups" subtitle="SQLite snapshots">
          <div className="settings-group">
            <div className="settings-row">
              <span className="settings-row__label">Schedule</span>
              <span>Daily</span>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">Retention</span>
              <span>7 days</span>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">Last backup</span>
              <span>—</span>
            </div>
          </div>
        </Card>

        <Card title="Notifications" subtitle="Deployment failures">
          <div className="settings-group">
            <div className="settings-row">
              <span className="settings-row__label">Channel</span>
              <span>Not configured</span>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">On failure</span>
              <span>Enabled</span>
            </div>
          </div>
        </Card>
      </div>
    </PagePlaceholder>
  );
}
