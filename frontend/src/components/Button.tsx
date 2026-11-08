import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  block?: boolean;
}

export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  block = false,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    'button',
    `button--${variant}`,
    size === 'sm' ? 'button--sm' : '',
    block ? 'button--block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} {...rest}>
      {icon}
      {children}
    </button>
  );
}
