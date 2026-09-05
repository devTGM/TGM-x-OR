/*
 * onrepeat-perf.js — Off-screen animation pause
 * ------------------------------------------------------------
 * Many of the theme's decorative components run *infinite* CSS animations
 * (marquees, shimmers, pulses, the cart reward bar, the money-back card, the
 * GWP carousel, etc.). Left alone, they keep compositing every frame forever —
 * even when scrolled far out of view or sitting in a closed cart drawer —
 * which wastes CPU/GPU and battery.
 *
 * This script is PURELY ADDITIVE and visually safe: it watches a fixed list of
 * known animated containers with a single IntersectionObserver and toggles the
 * class `onrepeat-anim-paused` ONLY while an element is outside the viewport
 * (plus a 300px buffer). The companion stylesheet (onrepeat-perf.css) uses that
 * class to set `animation-play-state: paused`. Elements that are on-screen are
 * never touched, so the visible result is identical — animations simply stop
 * doing invisible work and resume just before they scroll back into view.
 *
 * Newly-added containers (AJAX cart drawer, infinite-scroll product cards) are
 * picked up via a MutationObserver that inspects ONLY each mutation's added
 * nodes — never the whole document — so it stays cheap during scrolling and
 * card-carousel swiping. No edits to theme.js or any component are required.
 */
(function () {
  'use strict';

  if (!('IntersectionObserver' in window)) return;

  // Containers that host looping animations. Matching nothing is a harmless
  // no-op, so this list only ever helps — it can never break a page.
  var SELECTOR = [
    'marquee-element',        // sale marquee + scrolling-text (incl. parallax ones that don't self-pause)
    'logo-list',              // logo bar marquee
    '.sold-out-badge',        // sold-out shimmer
    '.onrepeat-rtag',            // rotating product tag (infinite slide loop)
    '.onrepeat-buy-area',        // add-to-cart shimmer / buy-now spinner
    '.cart-trust-bar',        // cart trust bar scroll
    '.reward-track-container', // free-gift reward bar pulses
    '.free-shipping-bar',     // reward / free-shipping bar
    '.smb',                   // money-back promise card (drift + spin + shimmer)
    '.sgwp',                  // reward ladder (bar fill + tier transitions)
    '.scarcity-badge'         // cart scarcity pulse
  ].join(',');

  var PAUSED_CLASS = 'onrepeat-anim-paused';
  var observed = new WeakSet();

  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i].target;
      // Off-screen -> pause; on-screen (or within the 300px buffer) -> resume.
      el.classList.toggle(PAUSED_CLASS, !entries[i].isIntersecting);
    }
  }, { rootMargin: '300px 0px 300px 0px' });

  function watch(el) {
    if (!observed.has(el)) {
      observed.add(el);
      io.observe(el);
    }
  }

  // Inspect a single newly-added node (and its descendants) — proportional to
  // what was added, NOT the whole document.
  function watchSubtree(node) {
    if (node.nodeType !== 1) return; // elements only
    if (node.matches && node.matches(SELECTOR)) watch(node);
    if (node.querySelectorAll) {
      var inner = node.querySelectorAll(SELECTOR);
      for (var i = 0; i < inner.length; i++) watch(inner[i]);
    }
  }

  function start() {
    // One full pass for everything present at load.
    var nodes = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i++) watch(nodes[i]);

    // The cart drawer, GWP and reward bar can be (re)rendered by AJAX, and
    // product grids can grow via infinite scroll. Catch only the *added* nodes
    // so this never re-scans the document while the user scrolls or swipes.
    // We observe childList only (not attributes), so lazy-image src/class swaps
    // during scroll do NOT trigger this, and the class toggles above cannot
    // feed back into it.
    if ('MutationObserver' in window && document.body) {
      new MutationObserver(function (records) {
        for (var r = 0; r < records.length; r++) {
          var added = records[r].addedNodes;
          for (var a = 0; a < added.length; a++) watchSubtree(added[a]);
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
