import type { Variants } from 'framer-motion';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { isPayAppPath } from '../lib/pay/paths';

// Cubic-bezier easings typed as 4-tuples so framer-motion's `Easing` type
// accepts them (a bare array widens to `number[]`, which is not assignable).
const EASE_STANDARD: [number, number, number, number] = [0.4, 0, 0.2, 1];
const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1];

interface PageTransitionProps {
  children: ReactNode;
  /** Kept so existing call sites compile. The shell no longer shifts around the page. */
  layoutChild?: boolean;
}

/**
 * One fade for the incoming page. The previous page is not held on screen,
 * and Nave Pay keeps a single shell so moving between books does not remount it.
 */
export function PageTransition({ children }: PageTransitionProps) {
  const { pathname } = useLocation();
  if (pathname === '/') return <>{children}</>;
  const key = isPayAppPath(pathname) ? 'pay' : pathname;
  return (
    <div key={key} className="nave-route">
      {children}
    </div>
  );
}

/**
 * Micro-interaction helpers — reusable motion props for common patterns.
 * `hoverLift` is intentionally a no-op under the calm paper design system.
 */
export const hoverLift: Record<string, never> = {};

/** Stagger container — wrap children with staggered entrance */
export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0,
      delayChildren: 0,
    },
  },
};

/** Child of a stagger container. Sections arrive with the page, not after it. */
export const staggerChild: Variants = {
  initial: { opacity: 1, y: 0 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0 },
  },
};

/** Scale-in for modals and drawers */
export const scaleIn: Variants = {
  initial: { opacity: 0, y: 14, scale: 0.98 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] },
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    transition: { duration: 0.15 },
  },
};

/** Slide-in from right (drawers) */
export const slideRight: Variants = {
  initial: { x: '100%' },
  animate: {
    x: 0,
    transition: { duration: 0.25, ease: EASE_STANDARD },
  },
  exit: {
    x: '100%',
    transition: { duration: 0.2, ease: EASE_IN },
  },
};

/** Fade overlay (backdrop for modals/drawers) */
export const fadeOverlay: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};
