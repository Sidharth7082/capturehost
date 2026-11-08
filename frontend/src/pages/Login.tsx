import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, fetchSetupStatus } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import './Login.css';

type Step = 'password' | 'totp';

/**
 * Login page: password step, then TOTP step when the account has 2FA.
 *
 * One form, one error region, `autocomplete` hints so password managers work.
 * The 2FA step accepts either a 6-digit code or a recovery code — the backend
 * decides which, the UI does not have to know.
 */
export function Login(): JSX.Element {
  const { status, login, verifyCode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  const [step, setStep] = useState<Step>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);

  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchSetupStatus()
      .then((result) => setSetupComplete(result.setupComplete))
      .catch(() => setSetupComplete(null));
  }, []);

  useEffect(() => {
    if (step === 'totp') codeRef.current?.focus();
  }, [step]);

  if (status === 'authenticated') {
    return <Navigate to={redirectTo} replace />;
  }

  const describeError = (caught: unknown): string => {
    if (caught instanceof ApiError) {
      if (caught.status === 429) return 'Too many attempts. Try again later.';
      return caught.message;
    }
    return 'Something went wrong. Try again.';
  };

  const onPasswordSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await login(username.trim(), password);
      if (result.requires2fa) {
        setStep('totp');
        setPassword('');
      } else {
        navigate(redirectTo, { replace: true });
      }
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const onCodeSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await verifyCode(code.trim());
      navigate(redirectTo, { replace: true });
    } catch (caught) {
      setError(describeError(caught));
      setCode('');
      codeRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="login-brand__logo" aria-hidden="true">
            CH
          </span>
          <div>
            <p className="login-brand__name">CaptureHost</p>
            <p className="login-brand__tag">
              {step === 'password' ? 'Sign in to your dashboard' : 'Two-factor verification'}
            </p>
          </div>
        </div>

        {setupComplete === false && (
          <div className="login-notice">
            No admin account exists yet. Create one from a terminal on this machine:
            <br />
            <code>cd ~/capturehost/backend &amp;&amp; npm run setup:admin</code>
          </div>
        )}

        {error && (
          <div className="login-error" role="alert">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </div>
        )}

        {step === 'password' ? (
          <form onSubmit={onPasswordSubmit} style={{ display: 'grid', gap: 16 }}>
            <div className="login-field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                name="username"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="admin"
              />
            </div>

            <div className="login-field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••••"
              />
            </div>

            <Button type="submit" variant="primary" block disabled={submitting || setupComplete === false}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        ) : (
          <form onSubmit={onCodeSubmit} style={{ display: 'grid', gap: 16 }}>
            <div className="login-field">
              <label htmlFor="code">Authentication code</label>
              <input
                id="code"
                ref={codeRef}
                className="login-code-input"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="000000"
                aria-describedby="code-hint"
              />
              <p className="login-hint" id="code-hint">
                Six digits from your authenticator app, or one of your recovery codes.
              </p>
            </div>

            <Button type="submit" variant="primary" block disabled={submitting}>
              {submitting ? 'Verifying…' : 'Verify'}
            </Button>

            <button
              type="button"
              className="login-link"
              onClick={() => {
                setStep('password');
                setCode('');
                setError(null);
              }}
              style={{ background: 'none', border: 'none', textAlign: 'left' }}
            >
              Back to password
            </button>
          </form>
        )}

        <div className="login-footer">
          <span>Local access only</span>
          <span>v0.1.0</span>
        </div>
      </div>
    </div>
  );
}
