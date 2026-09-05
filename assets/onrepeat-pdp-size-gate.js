/*
 * onrepeat-pdp-size-gate.js
 * ------------------------------------------------------------
 * On the product page no size is pre-selected (see product-variant-picker).
 * Add-to-cart and buy-now both happen through the slide-in size sheet (the
 * Sleek Quick Add bottom sheet), opened by the permanent sticky bar's two
 * buttons ([data-bb-gate][data-sleek-open]).
 *
 * This script keeps the two surfaces in sync: if the shopper HAS already chosen
 * a size in the on-page variant picker, we stamp that size onto the sticky
 * button so the sheet opens with the size shown as already selected. If nothing
 * is chosen yet, the sheet opens with no size selected (they pick it there).
 *
 * We read the size from the CHECKED RADIO (its value is the size label), not
 * from the product form's hidden id input: that input is only updated by the
 * theme AFTER the async variant re-render finishes, so reading it on click can
 * be stale (the sheet would show the previous/default size and need a second
 * open to catch up). The radio's checked state updates synchronously on tap, so
 * it is always current. The sheet matches its pills by this label.
 *
 * Purely additive and defensive: it runs in the capture phase (before the
 * sheet's own open handler) and only writes data-selected on the sticky bar's
 * own buttons. If it fails to load, the sheet still opens — just without the
 * pre-fill — so the flow degrades gracefully.
 */
(function () {
  'use strict';

  // The size label currently chosen on the page, or '' when none is chosen.
  // Only single-option (size-only) products auto-carry their selection; for
  // multi-option products we leave it to the shopper to choose in the sheet.
  function chosenSelection() {
    var picker = document.querySelector('variant-selects');
    if (!picker) return '';
    var fieldsets = picker.querySelectorAll('fieldset');
    if (fieldsets.length !== 1) return ''; // size-only products only
    var checked = fieldsets[0].querySelector('input[type="radio"]:checked');
    return checked && checked.value ? checked.value : '';
  }

  // Before the sheet opens from a sticky-bar button, stamp the current on-page
  // selection onto the trigger so the sheet reflects it (or clear it when none).
  document.addEventListener(
    'click',
    function (e) {
      var trigger = e.target.closest('[data-bb-gate][data-sleek-open]');
      if (!trigger) return;
      trigger.dataset.selected = chosenSelection();
    },
    true // capture: run before the sheet's bubble-phase open handler
  );
})();
