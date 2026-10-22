import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { useLocation } from 'react-router-dom';

// Cubic-bezier easings typed as 4-tuples so framer-motion's `Easing` type
// accepts them (a bare array widens to `number[]`, which is not assignable).
const EASE_STANDARD: [number, number, number, number] = [0.4, 0, 0.2, 1];
const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1];

/**
 * Wraps page content with a Framer Motion enter/exit transition.
 *
 * - Calm rise on enter (6px upward over 0.35s, matching demo.html `@keyframes rise`)
 * - Clean fade-out on exit
 * - Keyed by pathname so transitions fire on every route change
 */
const PAGE_VARIANTS: Variants = {
  initial: {
    opacity: 0,
    y: 6,
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.35,
      ease: EASE_STANDARD,
    },
  },
  exit: {
    opacity: 0,
    y: -3,
    transition: {
      duration: 0.14,
      ease: EASE_IN,
    },
  },
};

interface PageTransitionProps {
  children: React.ReactNode;
  /** Set to true for routes inside NaveLayout (prevents layout shift) */
  layoutChild?: boolean;
}

export function PageTransition({ children, layoutChild }: PageTransitionProps) {
  const location = useLocation();

  if (location.pathname === '/') {
    return <>{children}</>;
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        variants={PAGE_VARIANTS}
        initial="initial"
        animate="animate"
        exit="exit"
        style={layoutChild ? { minHeight: '100%' } : undefined}
      >
        {children}
      </motion.div>
    </AnimatePresence>
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
      staggerChildren: 0.04,
      delayChildren: 0.04,
    },
  },
};

/** Stagger child — used on each child inside a stagger container */
export const staggerChild: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.3,
      ease: EASE_STANDARD,
    },
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
