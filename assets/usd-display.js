/* ============================================================
   USD display: geo auto-switch + first-arrival toast.
   Loaded (deferred) only while the usd_display_enabled setting is on.

   What it does
   - Records any manual use of the footer country pill as a preference that
     suppresses auto-switching forever.
   - On a US-context arrival, shows a one-time dismissible toast naming the
     arrangement (USD display, INR billing) with a switch-back action.
   - For a first-time visitor in the IN context, switches to the US market
     once when Shopify's own geo detection says the browser is in the US —
     guarded against bots, broken storage and redirect loops.

   What it must never do
   - Fight a human: a stored preference (OnRepeat:currency-pref) wins forever,
     and auto-switching happens at most once per browser (OnRepeat:usd-auto).
   - Loop: the session flag (OnRepeat:usd-attempt) is set BEFORE navigating, so
     a failing POST cannot retrigger; if storage cannot be written, the
     switch is abandoned rather than risked.
   - Touch checkout: this file changes market context only. The cart stays
     INR; Razorpay Magic Checkout reads the INR cart server-side.

   The hidden POST replicates the rendered localization form's exact fields.
   _method=put is REQUIRED — Shopify's /localization route 404s without the
   Rails method override (verified against the live store).
   ============================================================ */
(() => {
  'use strict';

  const LS = { pref: 'OnRepeat:currency-pref', auto: 'OnRepeat:usd-auto', toast: 'OnRepeat:usd-toast' };
  const SS = { geo: 'OnRepeat:geo', attempt: 'OnRepeat:usd-attempt' };

  const cd = (window.theme && theme.currencyDisplay) || null;
  if (!cd || !cd.available) return;

  const store = {
    get(key, session) {
      try { return (session ? sessionStorage : localStorage).getItem(key); } catch (e) { return null; }
    },
    set(key, value, session) {
      try { (session ? sessionStorage : localStorage).setItem(key, value); return true; } catch (e) { return false; }
    }
  };

  const pillForm = document.getElementById('localization_country_form_footer');

  /* Any submit of the footer switcher — pill button or select form — is the
     shopper speaking. Remember it and never auto-switch again. */
  if (pillForm) {
    pillForm.addEventListener('submit', (event) => {
      const source = (event.submitter && event.submitter.value)
        || (pillForm.querySelector('select[name="country_code"]') || {}).value;
      if (source) store.set(LS.pref, source);
    });
  }

  /* Switching market re-prices the cart against the other market's price list.
     Razorpay Magic Checkout resumes a previously created order from
     /cart?magic_order_id=… and re-fetches its details; if the cart no longer
     matches that order's total it returns CHECKOUT_PRICE_MISMATCH_ERROR and the
     shopper gets "The prices for items in your cart have been updated".
     Returning to that URL after a switch makes the mismatch certain, so the
     resume key never survives a switch — the shopper lands on a clean cart and
     Magic Checkout builds a fresh order at the new prices. */
  function returnTo() {
    const url = new URL(location.href);
    url.searchParams.delete('magic_order_id');
    return url.pathname + url.search;
  }

  function submitLocalization(code) {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = '/localization';
    form.style.display = 'none';
    const fields = {
      form_type: 'localization',
      utf8: '✓',
      _method: 'put',
      country_code: code,
      return_to: returnTo()
    };
    for (const name of Object.keys(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = fields[name];
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  }

  /* ---- one-time toast on arriving in the USD context ------------------- */
  const TOAST_CSS = `
.onrepeat-usd-toast { position:fixed; left:12px; right:12px; bottom:16px; z-index:9999;
  display:grid; grid-template-columns:1fr auto; gap:10px 8px; align-items:start;
  padding:14px 12px 14px 18px;
  background:#f6f2ea; border:1px solid #e4dccc; border-radius:14px;
  box-shadow:0 10px 30px rgb(0 0 0 / .18); color:#5c1011;
  font:500 13.5px/1.5 var(--font-body-family, Inter, sans-serif); }
.onrepeat-usd-toast__txt strong { font-weight:700; }
.onrepeat-usd-toast__switch { grid-column:1; justify-self:start; border:1px solid #5c1011; background:transparent; color:#5c1011;
  border-radius:999px; padding:9px 16px; font:600 12.5px/1 inherit; cursor:pointer; white-space:nowrap; }
.onrepeat-usd-toast__close { grid-column:2; grid-row:1; width:34px; height:34px; display:grid; place-items:center;
  border:0; background:transparent; color:#780e09; font-size:17px; cursor:pointer; border-radius:50%; margin-top:-4px; }
.onrepeat-usd-toast__switch:focus-visible, .onrepeat-usd-toast__close:focus-visible { outline:2px solid #5c1011; outline-offset:2px; }
/* Never sit on top of the cart drawer's checkout button. The toast is fixed to
   the bottom of the viewport, which is exactly where the drawer puts Check out —
   it covered the CTA and the billing disclosure. The theme flags an open modal
   on <html>, so the toast steps aside for the duration and comes back after. */
html.has-modal-open .onrepeat-usd-toast,
html.has-modal-opening .onrepeat-usd-toast,
body.has-modal-open .onrepeat-usd-toast,
body.has-modal-opening .onrepeat-usd-toast { opacity:0; pointer-events:none; transform:translateY(8px); }
.onrepeat-usd-toast { transition:opacity .2s ease, transform .2s ease; }
.onrepeat-usd-toast.is-leaving { opacity:0; transform:translateY(8px); pointer-events:none; }
@media (min-width: 750px) { .onrepeat-usd-toast { left:auto; right:24px; bottom:24px; max-width:430px; } }
@media (prefers-reduced-motion: reduce) { .onrepeat-usd-toast { transition:none; } }`;

  function showToast() {
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    document.head.appendChild(style);

    const toast = document.createElement('div');
    toast.className = 'onrepeat-usd-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('data-modal-inert-exempt', '');
    toast.innerHTML =
      '<div class="onrepeat-usd-toast__txt">Showing prices in <strong>USD $</strong> for your convenience · billed in INR at checkout.</div>' +
      '<button class="onrepeat-usd-toast__close" type="button" aria-label="Dismiss">×</button>' +
      '<button class="onrepeat-usd-toast__switch" type="button">Switch to ₹ INR</button>';

    // Dismissing is permanent either way; the timer exists so the notice cannot
    // linger over the storefront if the shopper simply reads it and moves on.
    let timer = null;
    const dismiss = (remember) => {
      if (timer) clearTimeout(timer);
      if (remember) store.set(LS.toast, '1');
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 250);
    };

    toast.querySelector('.onrepeat-usd-toast__close').addEventListener('click', () => dismiss(true));
    toast.querySelector('.onrepeat-usd-toast__switch').addEventListener('click', () => {
      store.set(LS.toast, '1');
      store.set(LS.pref, 'IN');
      submitLocalization('IN');
    });

    document.body.appendChild(toast);
    timer = setTimeout(() => dismiss(true), 9000);
  }

  if (cd.usd) {
    if (!store.get(LS.toast)) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showToast, { once: true });
      } else {
        showToast();
      }
    }
    return; // already in the USD context — nothing to switch
  }

  /* ---- auto-switch: IN context, first visit, genuinely-US browser ------ */
  if (cd.country !== 'IN') return;          // some third context; leave it be
  if (store.get(LS.pref)) return;           // a human already chose
  if (store.get(LS.auto)) return;           // one auto-switch per browser, ever
  if (store.get(SS.attempt, true)) return;  // an attempt already ran this session
  if (!pillForm) return;                    // no switcher rendered on this page

  /* Never re-price a cart the shopper is already committed to. Switching market
     applies the other market's price list, so a shopper who has added items and
     is on their way to pay would watch their total change underneath them — and
     if Razorpay has already created an order for that cart, checkout fails
     outright with a price mismatch. Auto-switching is a convenience for someone
     who has just arrived; past that point it is only ever a surprise. The
     footer pill stays available, because choosing it is deliberate. */
  if (new URLSearchParams(location.search).has('magic_order_id')) return;
  if (/^\/(cart|checkouts?)(\/|$)/.test(location.pathname)) return;
  if (typeof theme.cartItemCount === 'number' && theme.cartItemCount > 0) return;
  if (navigator.webdriver) return;
  if (!navigator.cookieEnabled) return;     // the context cookie could not stick
  if (/bot|crawl|spider|slurp|bingpreview|googlebot|baidu|yandex|duckduck|facebookexternalhit|ia_archiver|lighthouse|headless|phantom|pingdom|gtmetrix/i.test(navigator.userAgent)) return;

  async function detectUS() {
    const cached = store.get(SS.geo, true);
    if (cached) return cached === 'US';
    try {
      const response = await fetch('/browsing_context_suggestions.json', { headers: { Accept: 'application/json' } });
      if (!response.ok) return false;
      const data = await response.json();
      const detected = data && data.detected_values && data.detected_values.country && data.detected_values.country.handle;
      if (detected) store.set(SS.geo, detected, true);
      return detected === 'US';
    } catch (e) {
      return false;
    }
  }

  let fired = false;
  async function attempt() {
    if (fired) return;
    fired = true;
    if (!(await detectUS())) return;
    // If either flag cannot be persisted, do not navigate: a browser that
    // forgets the guards would auto-switch on every page load.
    if (!store.set(LS.auto, '1')) return;
    if (!store.set(SS.attempt, '1', true)) return;
    submitLocalization('US');
  }

  /* Arm on real interaction, or on visible idle a few seconds after load —
     crawlers that execute JS rarely produce either. */
  ['pointerdown', 'keydown', 'touchstart'].forEach((type) => {
    addEventListener(type, attempt, { once: true, passive: true });
  });
  const idleAttempt = () => { if (document.visibilityState === 'visible') attempt(); };
  if ('requestIdleCallback' in window) {
    setTimeout(() => requestIdleCallback(idleAttempt, { timeout: 3000 }), 4000);
  } else {
    setTimeout(idleAttempt, 5000);
  }
})();
