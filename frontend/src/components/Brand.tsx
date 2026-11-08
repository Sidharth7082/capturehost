import { type JSX } from 'react';
import './Brand.css';

export interface BrandProps {
  /**
   * `sidebar` is the inline lockup (mark + wordmark) that sits at the top of the
   * rail; `login` stacks it above the sign-in form. The mark is decorative in
   * both: the product name is real text next to it, so a screen reader does not
   * read it twice.
   */
  variant?: 'sidebar' | 'login';
}

/**
 * The CaptureHost lockup: the C mark plus "Capture" in the normal text colour and
 * "Host" in the indigo accent.
 *
 * The mark is a fixed 30px (44px on the login card) with explicit width/height on
 * the element, so it reserves its box before the image decodes — a logo that
 * arrives late must not shift the sidebar.
 */
export function Brand({ variant = 'sidebar' }: BrandProps): JSX.Element {
  return (
    <span className={`brand brand--${variant}`}>
      <img
        className="brand__mark"
        src="/brand/logo-mark-transparent.svg"
        alt=""
        aria-hidden="true"
        width={variant === 'login' ? 44 : 30}
        height={variant === 'login' ? 44 : 30}
        decoding="async"
      />
      <span className="brand__name">
        Capture<span className="brand__name-accent">Host</span>
      </span>
    </span>
  );
}
