import { useEffect, useRef } from 'react';

/**
 * Progress through a tall section whose inner stage is sticky.
 * 0 when the section top hits the viewport top, 1 when the section bottom
 * hits the viewport bottom. Same measure as a pinned scroll track.
 */
export function usePinProgress<T extends HTMLElement>(
  enabled: boolean,
  onProgress: (progress: number) => void,
) {
  const ref = useRef<T>(null);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const height = window.innerHeight || 1;
      const travel = rect.height - height;
      const progress = travel <= 0 ? 0 : Math.min(1, Math.max(0, -rect.top / travel));
      onProgressRef.current(progress);
    };
    const request = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    request();
    window.addEventListener('scroll', request, { passive: true });
    window.addEventListener('resize', request);
    return () => {
      window.removeEventListener('scroll', request);
      window.removeEventListener('resize', request);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);

  return ref;
}
