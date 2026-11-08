import { useState, type FormEvent, type JSX } from 'react';
import { ApiError, changePassword } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';

/**
 * Password change. Requires the current password (a stolen session alone must
 * not be enough to take over the account) and ends every other session.
 */
export function PasswordSection(): JSX.Element {
  const { reloadUser } = useAuth();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (next !== confirm) {
      setError('The new passwords do not match');
      return;
    }
    if (next.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }

    setSaving(true);
    try {
      const result = await changePassword(current, next);
      setSuccess(
        result.revokedSessions > 0
          ? `Password changed. ${result.revokedSessions} other session(s) signed out.`
          : 'Password changed.',
      );
      setCurrent('');
      setNext('');
      setConfirm('');
      await reloadUser();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change the password');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Password" subtitle="argon2id · at least 12 characters">
      <form className="form-stack" onSubmit={onSubmit}>
        <div className="form-field">
          <label htmlFor="current-password">Current password</label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
          />
        </div>

        <div className="form-field">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            required
            aria-describedby="password-hint"
          />
          <p className="form-hint" id="password-hint">
            Changing this signs out every other device immediately.
          </p>
        </div>

        <div className="form-field">
          <label htmlFor="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        {success && <p className="form-success" role="status">{success}</p>}

        <div>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Change password'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
