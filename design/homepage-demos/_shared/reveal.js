/*!
 * NaveReveal + NaveScroll — tiny scroll helpers for the homepage demos.
 *
 *   NaveReveal.init('.sr-hidden')            // adds .sr-visible when 15% in view
 *   NaveReveal.init('[data-reveal]', { threshold: 0.2, rootMargin: '0px 0px -10% 0px', once: true })
 *     - element may carry data-reveal="up|scale|left|right" to pick the class
 *     - add class .sr-stagger on a container to stagger its children (CSS)
 *
 *   NaveScroll.progress(el)                  // 0 when el's top enters at the viewport
 *                                            // bottom, 1 when el's bottom leaves at the top
 *   NaveScroll.progress(el, { start: 0.8, end: 0.2 })
 *     - start/end are viewport fractions (0 = top, 1 = bottom) where the element's
 *       top/bottom respectively hit; defaults start: 1, end: 0
 *   NaveScroll.pinProgress(el)               // for tall "pinned" sections: 0 when el's
 *                                            // top reaches the viewport top, 1 when its
 *                                            // bottom reaches the viewport bottom
 *   NaveScroll.pageProgress()                // 0..1 of the whole document
 *   NaveScroll.onScroll(fn)                  // rAF-throttled scroll + resize listener;
 *                                            // fn(scrollY) is also called once immediately.
 *                                            // Returns an unsubscribe function.
 *   NaveScroll.clamp(v, a, b), .lerp(a, b, t), .remap(v, inA, inB, outA, outB)   // utils
 *   NaveScroll.ease.inOut(t) / .out(t)       // smoothstep-ish easings
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  var NaveReveal = {
    init: function (selector, opts) {
      opts = opts || {};
      var nodes = typeof selector === 'string' ? document.querySelectorAll(selector) : selector;
      var once = opts.once !== false;
      var reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var classFor = function (el) {
        var v = el.getAttribute('data-reveal');
        return v && v !== 'up' ? 'sr-visible-' + v : 'sr-visible';
      };
      var show = function (el) { el.classList.remove('sr-hidden'); el.classList.add(classFor(el)); };
      if (!root.IntersectionObserver || reduced) {
        Array.prototype.forEach.call(nodes, show);
        return { disconnect: function () {} };
      }
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { show(e.target); if (once) io.unobserve(e.target); }
          else if (!once) { e.target.classList.remove(classFor(e.target)); e.target.classList.add('sr-hidden'); }
        });
      }, { threshold: opts.threshold != null ? opts.threshold : 0.15, rootMargin: opts.rootMargin || '0px 0px -5% 0px' });
      Array.prototype.forEach.call(nodes, function (el) { el.classList.add('sr-hidden'); io.observe(el); });
      return io;
    }
  };

  // ---------------------------------------------------------------------------
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function remap(v, inA, inB, outA, outB) { return lerp(outA, outB, clamp((v - inA) / (inB - inA || 1), 0, 1)); }
  function vh() { return root.innerHeight || document.documentElement.clientHeight || 1; }

  var NaveScroll = {
    clamp: clamp, lerp: lerp, remap: remap,
    ease: {
      inOut: function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); },
      out: function (t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); },
      in: function (t) { t = clamp(t, 0, 1); return t * t * t; }
    },

    /** 0..1 as `el` travels from (top at start*vh) to (bottom at end*vh). */
    progress: function (el, opts) {
      opts = opts || {};
      var start = opts.start != null ? opts.start : 1;
      var end = opts.end != null ? opts.end : 0;
      var r = el.getBoundingClientRect(), h = vh();
      var from = h * start;          // viewport y where r.top is at progress 0
      var to = h * end - r.height;   // viewport y where r.top is at progress 1
      return clamp((r.top - from) / (to - from || 1), 0, 1);
    },

    /** For sections taller than the viewport (sticky inner): 0 when top hits top, 1 when bottom hits bottom. */
    pinProgress: function (el) {
      var r = el.getBoundingClientRect(), h = vh();
      var travel = r.height - h;
      if (travel <= 0) return clamp(-r.top / (r.height || 1), 0, 1);
      return clamp(-r.top / travel, 0, 1);
    },

    pageProgress: function () {
      var d = document.documentElement;
      var max = (d.scrollHeight || 0) - vh();
      return max > 0 ? clamp((root.scrollY || d.scrollTop || 0) / max, 0, 1) : 0;
    },

    /** rAF-throttled scroll/resize subscription. Returns an unsubscribe fn. */
    onScroll: function (fn) {
      var ticking = false;
      var run = function () { ticking = false; fn(root.scrollY || document.documentElement.scrollTop || 0); };
      var req = function () { if (!ticking) { ticking = true; requestAnimationFrame(run); } };
      root.addEventListener('scroll', req, { passive: true });
      root.addEventListener('resize', req);
      req();
      return function () { root.removeEventListener('scroll', req); root.removeEventListener('resize', req); };
    }
  };

  root.NaveReveal = NaveReveal;
  root.NaveScroll = NaveScroll;
})(typeof window !== 'undefined' ? window : this);
