import { useEffect, useState } from 'react';

/** Decorative WebGL stays off the first paint so the hero CTA is not waiting on the Three.js chunk. */
export function useAfterFirstPaint() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const start = () => {
      if (!cancelled) setReady(true);
    };
    const idle = window.requestIdleCallback?.(start, { timeout: 1500 });
    const timer = idle == null ? window.setTimeout(start, 200) : undefined;
    return () => {
      cancelled = true;
      if (idle != null) window.cancelIdleCallback?.(idle);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);
  return ready;
}

export function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setPrefersReducedMotion(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return prefersReducedMotion;
}
