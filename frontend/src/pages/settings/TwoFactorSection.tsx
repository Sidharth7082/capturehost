import { useState, type FormEvent, type JSX } from 'react';
import { ApiError, confirmTotp, disableTotp, startTotpSetup, type TotpSetupResponse } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { StatusPill } from '../../components/StatusPill';

type Phase = 'idle' | 'scanning' | 'showing-codes';

/**
 * Enable / disable TOTP.
 *
 * Setup is two steps on purpose: the secret is stored encrypted but not
 * activated until the user proves they can generate a code from it. That is
 * what stops someone locking themselves out with a mistyped secret.
 */
export function TwoFactorSection(): JSX.Element {
  const { user, reloadUser } = useAuth();

  const [phase, setPhase] = useState<Phase>('idle');
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enabled = user?.totpEnabled ?? false;

  const describe = (caught: unknown): string =>
    caught instanceof ApiError ? caught.message : 'Request failed';

  const beginSetup = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      setSetup(await startTotpSetup());
      setPhase('scanning');
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await confirmTotp(code.trim());
      setCodes(result.recoveryCodes);
      setPhase('showing-codes');
      setCode('');
      await reloadUser();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await disableTotp(password, code.trim());
      setPassword('');
      setCode('');
      await reloadUser();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Two-factor authentication"
      subtitle="TOTP from any authenticator app"
      actions={<StatusPill label={enabled ? 'Enabled' : 'Disabled'} tone={enabled ? 'success' : 'neutral'} />}
    >
      {error && <p className="form-error" role="alert" style={{ marginBottom: 12 }}>{error}</p>}

      {/* --- not enabled, idle --- */}
      {!enabled && phase === 'idle' && (
        <div className="form-stack">
          <p className="form-hint" style={{ fontSize: 13 }}>
            A code from your phone on top of the password. Strongly recommended — with the
            dashboard able to start containers, a stolen password is expensive.
          </p>
          <div>
            <Button variant="primary" onClick={() => void beginSetup()} disabled={busy}>
              {busy ? 'Preparing…' : 'Enable 2FA'}
            </Button>
          </div>
        </div>
      )}

      {/* --- scanning the QR --- */}
      {!enabled && phase === 'scanning' && setup && (
        <form className="form-stack" onSubmit={confirmSetup}>
          <div className="qr-wrap">
            <img src={setup.qrDataUrl} alt="Two-factor QR code — scan with your authenticator app" />
          </div>
          <p className="form-hint">
            Scan the code, or type this secret into your app:
          </p>
          <code className="secret-code">{setup.secret}</code>

          <div className="form-field">
            <label htmlFor="confirm-code">Enter the 6-digit code to confirm</label>
            <input
              id="confirm-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="000000"
              required
              autoFocus
            />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Confirming…' : 'Confirm and enable'}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setPhase('idle');
                setSetup(null);
                setCode('');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* --- recovery codes, shown exactly once --- */}
      {phase === 'showing-codes' && (
        <div className="form-stack">
          <p className="form-hint" style={{ fontSize: 13 }}>
            Two-factor is on. These recovery codes are shown once — store them somewhere
            offline. Each one works exactly once if you lose your phone.
          </p>
          <div className="recovery-grid">
            {codes.map((recoveryCode) => (
              <span className="recovery-code" key={recoveryCode}>
                {recoveryCode}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="primary"
              onClick={() => {
                void navigator.clipboard?.writeText(codes.join('\n')).catch(() => undefined);
              }}
            >
              Copy codes
            </Button>
            <Button
              onClick={() => {
                setPhase('idle');
                setSetup(null);
                setCodes([]);
              }}
            >
              I have saved them
            </Button>
          </div>
        </div>
      )}

      {/* --- enabled: disable form (hidden while the one-time codes are on screen) --- */}
      {enabled && phase !== 'showing-codes' && (
        <form className="form-stack" onSubmit={turnOff}>
          <p className="form-hint" style={{ fontSize: 13 }}>
            {user?.recoveryCodesRemaining ?? 0} recovery codes unused. To turn two-factor off you
            need your password and a current code.
          </p>

          <div className="form-field">
            <label htmlFor="disable-password">Password</label>
            <input
              id="disable-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          <div className="form-field">
            <label htmlFor="disable-code">Authenticator code</label>
            <input
              id="disable-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="000000"
              required
            />
          </div>

          <div>
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? 'Disabling…' : 'Disable 2FA'}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
