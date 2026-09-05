/* ============================================================================
   THE ONREPEAT — bullet-proof background scroll lock for mobile drawers/modals.

   WHY THIS EXISTS
   The theme locks the page by adding `has-modal-open` to <body> which only sets
   `overflow:hidden` (+ `touch-action:none` on touch). On iOS Safari that does
   NOT reliably stop the page behind a bottom-sheet from scrolling, and the
   swipe-to-close gesture element (theme.js GestureElement) listens *passively*,
   so it cannot prevent the native scroll either. The result: the page drifts
   under the open drawer and the swipe-to-close feels unreliable.

   WHAT THIS DOES
   While any modal/drawer is open (body has `has-modal-open`/`has-modal-opening`),
   attach a single non-passive `touchmove` guard on the document that:
     • ALLOWS the move when the finger is over an element that can genuinely
       scroll in the gesture's direction (drawer content, search results,
       a horizontal row) and isn't at its scroll boundary — so internal
       scrolling still works.
     • PREVENTS the move otherwise (background page, the dim overlay, and the
       non-scrollable drawer header) — so the page can't scroll and the
       swipe-to-close gesture stays glued to the finger.

   preventDefault() only cancels the browser's native scroll; it does NOT stop
   the GestureElement's passive listener from reading touch coordinates, so
   swipe-to-close keeps working — it just no longer fights a scrolling page.

   Listeners are added only while something is open and removed as soon as it
   closes, so there is zero overhead during normal browsing. Touch-only;
   no-ops on non-touch devices and never changes layout (no position:fixed),
   so it can't introduce the scroll-jump the theme deliberately avoids.
   ========================================================================== */
(function () {
  'use strict';

  var isTouch =
    'ontouchstart' in window ||
    (navigator.maxTouchPoints || 0) > 0 ||
    (navigator.msMaxTouchPoints || 0) > 0;
  if (!isTouch || !document.body) return;

  var LOCK_CLASSES = ['has-modal-open', 'has-modal-opening'];
  var SCROLLY = /(auto|scroll|overlay)/;

  /* Controls that consume the drag themselves.
     This guard blocks a touchmove whenever no ancestor can absorb it as a
     scroll — which is the right call for the background page, but wrong for a
     control whose whole purpose is to be dragged. preventDefault() on touchmove
     cancels the browser's native handling of these: a range thumb stops
     following the finger, a textarea stops scrolling internally, a caret stops
     drag-selecting. The size guide's "Find my size" sliders were dead on every
     touch device because of exactly this — the finger moved horizontally over
     an element with nothing scrollable above it, so every move was cancelled.

     Standing down for them is safe: none of these can scroll the page behind,
     which is the only thing this guard exists to stop.

     [data-scroll-lock-allow] is the opt-out for anything custom that drives its
     own drag, so a future component does not have to be added to this list. */
  var SELF_HANDLED = 'input[type="range"],textarea,select,' +
    '[contenteditable=""],[contenteditable="true"],[draggable="true"],' +
    '[data-scroll-lock-allow]';

  var active = false;
  var startX = 0;
  var startY = 0;
  var startTarget = null;
  var startSelfHandled = false;

  function isSelfHandled(node) {
    var el = node && node.nodeType === 3 ? node.parentNode : node;
    if (!el || el.nodeType !== 1 || !el.closest) return false;
    try {
      return !!el.closest(SELF_HANDLED);
    } catch (err) {
      return false;
    }
  }

  function isLocked() {
    var cl = document.body.classList;
    for (var i = 0; i < LOCK_CLASSES.length; i++) {
      if (cl.contains(LOCK_CLASSES[i])) return true;
    }
    return false;
  }

  function onTouchStart(e) {
    if (!e.touches || e.touches.length !== 1) {
      startTarget = null;
      startSelfHandled = false;
      return;
    }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startTarget = e.target;
    /* Resolved once per gesture: the origin cannot change mid-drag, and a
       closest() walk on every touchmove would be wasted work. */
    startSelfHandled = isSelfHandled(e.target);
  }

  // Walk up from the touch's origin. If any ancestor can absorb the scroll in
  // the dominant gesture direction (and isn't pinned at that edge), let the
  // browser handle it. Otherwise the move would scroll the background — block it.
  function gestureCanScroll(deltaX, deltaY) {
    var el = startTarget;
    var horizontal = Math.abs(deltaX) > Math.abs(deltaY);

    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      var style;
      try {
        style = window.getComputedStyle(el);
      } catch (err) {
        style = null;
      }

      if (style) {
        if (horizontal) {
          if (SCROLLY.test(style.overflowX) && el.scrollWidth > el.clientWidth) {
            var atLeft = el.scrollLeft <= 0;
            var atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
            // deltaX > 0 = finger moves right = content scrolls toward its start
            if (!(atLeft && deltaX > 0) && !(atRight && deltaX < 0)) return true;
          }
        } else {
          if (SCROLLY.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
            var atTop = el.scrollTop <= 0;
            var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
            if (!(atTop && deltaY > 0) && !(atBottom && deltaY < 0)) return true;
          }
        }
      }

      el = el.parentNode;
      // hop out of any (light-DOM) shadow boundary just in case
      if (el && el.nodeType === 11 && el.host) el = el.host;
    }
    return false;
  }

  function onTouchMove(e) {
    if (!e.cancelable) return;             // mid-momentum: browser owns it
    if (e.touches && e.touches.length > 1) return; // pinch-zoom: leave it alone
    if (!startTarget) return;
    if (startSelfHandled) return;          // slider/textarea/etc: the control owns this drag

    var t = (e.touches && e.touches[0]) || e.changedTouches[0];
    if (!t) return;

    var deltaX = t.clientX - startX;
    var deltaY = t.clientY - startY;

    if (!gestureCanScroll(deltaX, deltaY)) {
      e.preventDefault();
    }
  }

  function enable() {
    if (active) return;
    active = true;
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
  }

  function disable() {
    if (!active) return;
    active = false;
    startTarget = null;
    document.removeEventListener('touchstart', onTouchStart, { passive: true });
    document.removeEventListener('touchmove', onTouchMove, { passive: false });
  }

  function sync() {
    if (isLocked()) enable();
    else disable();
  }

  var observer = new MutationObserver(sync);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // catch any drawer already open at load (e.g. server-rendered open state)
  sync();
})();
