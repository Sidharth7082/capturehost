import { createContext, useCallback, useContext, useMemo, useState, type JSX, type ReactNode } from 'react';
import { Icon } from './Icon';
import './Toast.css';

export type ToastTone = 'success' | 'danger' | 'warning' | 'info';

interface ToastRecord {
  id: number;
  title: string;
  message?: string;
  tone: ToastTone;
}

interface ToastContextValue {
  push: (title: string, options?: { message?: string; tone?: ToastTone }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DISMISS_MS = 5000;

const TONE_ICON: Record<ToastTone, 'check' | 'alert' | 'info'> = {
  success: 'check',
  danger: 'alert',
  warning: 'alert',
  info: 'info',
};

/**
 * Minimal toast system: a provider, a hook and a fixed viewport.
 * Toasts auto-dismiss and can be closed by hand. The viewport is a polite
 * live region so the message is announced, not just drawn.
 */
export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback<ToastContextValue['push']>(
    (title, options) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [
        ...current,
        { id, title, message: options?.message, tone: options?.tone ?? 'info' },
      ]);
      window.setTimeout(() => dismiss(id), DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div className="toast" data-tone={toast.tone} key={toast.id}>
            <span className="toast__icon">
              <Icon name={TONE_ICON[toast.tone]} size={15} />
            </span>
            <div className="toast__body">
              <p className="toast__title">{toast.title}</p>
              {toast.message && <p className="toast__message">{toast.message}</p>}
            </div>
            <button
              type="button"
              className="toast__close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
