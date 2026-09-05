/* ============================================================
   ENHANCED MINI CART: UI HELPERS
   Static class for shared cart UI animations
   ============================================================ */

class CartEnhancedUI {
  static updateFreeDelivery(totalCents) {
    document.querySelectorAll('.cart-free-delivery').forEach((el) => {
      if (!el.classList.contains('is-visible')) {
        el.classList.add('is-visible');
      }
    });
  }

  static flipSubtotal(totalCents) {
    document.querySelectorAll('.totals__subtotal-value, .drawer .totals__subtotal-value').forEach((el) => {
      el.classList.add('is-flipping');
      el.addEventListener('animationend', () => el.classList.remove('is-flipping'), { once: true });
    });
  }
}

/* ============================================================
   CART FEEDBACK: announcements and visible failures
   ------------------------------------------------------------
   Two gaps this closes.

   1. Nothing in the cart was ever announced. The few aria-live regions in the
      markup sit INSIDE the subtree that onCartUpdate replaces wholesale, so the
      node carrying the announcement is destroyed and rebuilt and a screen reader
      is never told anything changed. The live region here is created once on
      <body>, outside every replaced container, so it survives the swap.

   2. Failures were console-only. A dropped connection rolled the quantity back
      with no message at all, which reads as "the button doesn't work".
      theme.toast() has been loaded on every page all along; the previous
      publish() to a 'toast:show' topic had no subscriber anywhere in the theme.
   ============================================================ */
const CartFeedback = (() => {
  let region = null;

  function liveRegion() {
    if (region && document.body.contains(region)) return region;
    region = document.createElement('div');
    region.className = 'sr-only cart-live-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    // Never inerted when a modal opens — see ModalElement._isAnnouncer. Without
    // this the region became an ordinary <body> sibling of the drawer and was
    // inerted exactly while the drawer was open, announcing nothing.
    region.setAttribute('data-modal-inert-exempt', '');
    document.body.appendChild(region);
    return region;
  }

  function announce(message) {
    if (!message) return;
    const el = liveRegion();
    // Re-announce even when the text is unchanged (e.g. two identical removals).
    el.textContent = '';
    window.requestAnimationFrame(() => { el.textContent = message; });
  }

  function error(target, message) {
    announce(message);

    try {
      if (window.theme && typeof theme.toast === 'function') {
        theme.toast({ message, variant: 'error' });
      }
    } catch (e) { /* toast is a nicety, never let it mask the real failure */ }

    // Inline, next to the row that failed, for people who never see the toast.
    const row = target && target.closest('.cart-item, .horizontal-product');
    if (!row) return;
    let note = row.querySelector('[data-cart-row-error]');
    if (!note) {
      note = document.createElement('p');
      note.setAttribute('data-cart-row-error', '');
      note.className = 'cart-row-error text-2sm';
      note.setAttribute('role', 'alert');
      row.appendChild(note);
    }
    note.textContent = message;
    clearTimeout(note._hideTimer);
    note._hideTimer = setTimeout(() => note.remove(), 6000);
  }

  function clear(target) {
    const row = target && target.closest('.cart-item, .horizontal-product');
    const note = row && row.querySelector('[data-cart-row-error]');
    if (note) note.remove();
  }

  return { announce, error, clear };
})();

window.theme = window.theme || {};
theme.cartFeedback = CartFeedback;

/* ============================================================
   CART STATE: survive the section swap
   ------------------------------------------------------------
   onCartUpdate replaces the whole cart container via innerHTML. That is the
   Section Rendering API working as designed, but every scrap of DOM state
   inside goes with it. Tapping + on a line used to:

     - scroll the drawer back to the top, so a shopper editing the fourth
       item lost their place on every single tap;
     - close the totals breakdown they had just opened;
     - DESTROY whatever they had typed into the cart note, since the textarea
       only persists to the server on `change` (i.e. on blur) — mid-sentence
       text was simply gone;
     - drop focus to the body, which is what forced the old code to re-arm a
       focus trap after every update just to put focus somewhere sane.

   Rather than diff the tree, capture the handful of things a person can
   actually be in the middle of and put them back. Keyed by data-index and
   element identity, both of which the server re-renders faithfully.
   ============================================================ */
const CartStatePreserver = (() => {
  function capture(container) {
    if (!container) return null;

    const scroller = container.closest('.drawer__content')?.querySelector('.drawer__scrollable')
      || container.querySelector('.drawer__scrollable')
      || document.querySelector('.cart-drawer .drawer__scrollable');

    const active = document.activeElement;
    const inContainer = active && container.contains(active);

    // A note the shopper is still typing has not reached the server yet, so the
    // re-rendered markup would come back with the OLD value and silently discard
    // their edit. Only carry it over while it is genuinely unsaved.
    const note = container.querySelector('[name="note"]');

    return {
      scrollTop: scroller ? scroller.scrollTop : null,
      details: [...container.querySelectorAll('details')].map((d) => ({
        cls: d.className, open: d.open
      })),
      note: note ? { value: note.value, start: note.selectionStart, end: note.selectionEnd,
                     focused: document.activeElement === note } : null,
      focus: inContainer ? {
        index: active.getAttribute('data-index'),
        name: active.getAttribute('name'),
        tag: active.tagName,
        start: typeof active.selectionStart === 'number' ? active.selectionStart : null
      } : null
    };
  }

  /* Any modal that is open right now and BELONGS to the subtree about to be
     replaced has to be closed first.

     ModalElement moves a modal to <body> when it opens (shouldAppendToBody), so
     it survives the innerHTML swap while its originalParentBeforeAppend now points
     at a detached node. Its close controls went with the old markup, nothing can
     reach it, and — because it never runs afterHide — the body scroll lock it took
     is never released. The whole page stays unscrollable until a reload.

     The drawer renders one of these per line (the volume-pricing modal) plus the
     cart-note modal, so this is reachable by opening any of them and then changing
     a quantity. */
  function closeOrphanableModals(container) {
    if (!container) return;
    for (const modal of document.querySelectorAll('[open]')) {
      if (typeof modal.hide !== 'function') continue;
      const home = modal.originalParentBeforeAppend;
      const belongsHere = container.contains(modal) || (home && container.contains(home));
      if (belongsHere) modal.hide();
    }
  }

  function restore(container, snap) {
    if (!container || !snap) return;

    for (const d of container.querySelectorAll('details')) {
      const was = snap.details.find((x) => x.cls === d.className);
      if (was) d.open = was.open;
    }

    const note = container.querySelector('[name="note"]');
    if (note && snap.note && note.value !== snap.note.value) {
      note.value = snap.note.value;
      if (snap.note.focused) {
        note.focus({ preventScroll: true });
        try { note.setSelectionRange(snap.note.start, snap.note.end); } catch (e) { /* not selectable */ }
      }
    }

    if (snap.focus && snap.focus.index) {
      const sel = snap.focus.name
        ? `[data-index="${CSS.escape(snap.focus.index)}"][name="${CSS.escape(snap.focus.name)}"]`
        : `[data-index="${CSS.escape(snap.focus.index)}"]`;
      const target = container.querySelector(sel);
      if (target) {
        target.focus({ preventScroll: true });
        if (snap.focus.start != null && typeof target.setSelectionRange === 'function') {
          try { target.setSelectionRange(snap.focus.start, snap.focus.start); } catch (e) { /* not selectable */ }
        }
      }
    }

    // Scroll last: focusing can itself scroll, so this has to win.
    if (snap.scrollTop != null) {
      const scroller = container.closest('.drawer__content')?.querySelector('.drawer__scrollable')
        || container.querySelector('.drawer__scrollable')
        || document.querySelector('.cart-drawer .drawer__scrollable');
      if (scroller) scroller.scrollTop = snap.scrollTop;
    }
  }

  return { capture, restore, closeOrphanableModals };
})();

theme.cartState = CartStatePreserver;

/* ============================================================
   CART SUMMARY: a <details> that closes as smoothly as it opens
   ------------------------------------------------------------
   The drawer's totals card animates its height with the
   grid-template-rows 0fr/1fr trick, driven off the [open]
   attribute. Opening looks right: the browser sets `open`, the
   content starts being rendered, and the transition runs.

   Closing does not. Removing `open` stops the content being
   rendered in the same frame, so there is no height left to
   transition from and the card snaps shut — the jerk you see.

   So: intercept the close, mark the element `data-closing` (CSS
   takes the rows back to 0fr while `open` is still set), and only
   drop `open` once the transition has finished. Opening is left
   entirely to the browser.

   Progressive enhancement — with this script absent the card is
   still a working <details>, it just snaps shut as before. Defined
   once at load, so the elements the Section Rendering API swaps in
   upgrade on their own.
   ============================================================ */
class CartSummary extends HTMLElement {
  connectedCallback() {
    this.details = this.querySelector('details');
    this.wrap = this.querySelector('.cart-summary__wrap');
    if (!this.details || !this.wrap || this.bound) return;
    this.bound = true;

    const summary = this.details.querySelector('summary');
    if (!summary) return;

    summary.addEventListener('click', (event) => {
      // Opening: let the browser do it, the CSS transition handles the rest.
      if (!this.details.open) return;

      event.preventDefault();

      // Respect the user's motion setting rather than making them sit through
      // a transition they asked not to see — and the transitionend below would
      // never fire anyway, since the reduced-motion block disables it.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        this.details.open = false;
        return;
      }

      this.setAttribute('data-closing', '');

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.details.open = false;
        this.removeAttribute('data-closing');
      };

      // The chevron transitions too, so only the height counts as done.
      this.wrap.addEventListener('transitionend', (e) => {
        if (e.propertyName === 'grid-template-rows') finish();
      });

      // A transition that never starts (display:none ancestor, an interrupted
      // drawer close) must not leave the card stuck half-shut.
      const timer = window.setTimeout(finish, 420);
    });
  }

  disconnectedCallback() {
    this.removeAttribute('data-closing');
  }
}

if (!customElements.get('cart-summary')) {
  customElements.define('cart-summary', CartSummary);
}

/* ============================================================
   ENHANCED MINI CART: PROGRESS-BAR FEEDBACK
   Snapshots + replays the reward-bar transition across DOM swaps,
   flashes an acknowledgment on every update, celebrates tier
   crossings, and emits micro-toasts on subtotal deltas.
   Shared by CartDrawer.onCartRefresh and CartItems.onCartUpdate.
   ============================================================ */
const CartRewardFeedback = (() => {
  let lastTotalCents = null;
  let lastToastTier = 0;

  const formatMoney = (cents) => {
    // The cart AJAX API always reports INR; theme.currencyDisplay is the
    // display authority (see js-variables.liquid).
    if (theme && theme.currencyDisplay && theme.currencyDisplay.usd && theme.money) {
      return theme.money.format(cents);
    }
    const fmt = (theme && theme.settings && (theme.settings.moneyWithCurrencyFormat || theme.settings.moneyFormat)) || '₹{{amount_no_decimals}}';
    const val = Math.round(cents / 100);
    return fmt.replace(/\{\{amount[^}]*\}\}/g, val.toLocaleString('en-IN'));
  };

  function snapshot(container) {
    if (!container) return null;
    const bar = container.querySelector('.free-shipping-bar');
    const fill = container.querySelector('.reward-fill');
    const thumb = container.querySelector('.reward-thumb');
    if (!bar || !fill || !thumb) return null;
    return {
      progress: fill.style.getPropertyValue('--progress') || '0%',
      thumb: thumb.style.getPropertyValue('--thumb') || '0%',
      activeTier: parseInt(bar.dataset.activeTier, 10) || 0,
      tierAmounts: (bar.dataset.tierAmounts || '').split(',').map((s) => parseFloat(s) || 0),
    };
  }

  function replay(container, snap) {
    if (!container || !snap) return;
    const fill = container.querySelector('.reward-fill');
    const thumb = container.querySelector('.reward-thumb');
    if (!fill || !thumb) return;
    const finalProgress = fill.style.getPropertyValue('--progress') || '0%';
    const finalThumb = thumb.style.getPropertyValue('--thumb') || '0%';
    fill.style.setProperty('--progress', snap.progress);
    thumb.style.setProperty('--thumb', snap.thumb);
    void fill.offsetWidth;
    requestAnimationFrame(() => {
      fill.style.setProperty('--progress', finalProgress);
      thumb.style.setProperty('--thumb', finalThumb);
    });
  }

  function acknowledge(container) {
    if (!container) return;
    const track = container.querySelector('.reward-track');
    if (!track) return;
    track.classList.remove('is-acknowledging');
    void track.offsetWidth;
    track.classList.add('is-acknowledging');
    setTimeout(() => track.classList.remove('is-acknowledging'), 750);
  }

  function celebrate(container, prevTier, newTier) {
    if (!container || newTier <= prevTier) return;
    for (let i = prevTier; i < newTier; i++) {
      const dot = container.querySelector(`.reward-dot[data-tier="${i + 1}"]`);
      if (!dot) continue;
      dot.classList.remove('just-unlocked');
      void dot.offsetWidth;
      dot.classList.add('just-unlocked');
      setTimeout(() => dot.classList.remove('just-unlocked'), 950);
    }
  }

  function process(container, opts) {
    opts = opts || {};
    if (!container) return;
    const post = snapshot(container);
    if (!post) return;
    replay(container, opts.snap);
    acknowledge(container);
    if (opts.snap) {
      celebrate(container, opts.snap.activeTier, post.activeTier);
    }
  }

  return { snapshot, replay, acknowledge, celebrate, process, formatMoney };
})();

class TabList extends HTMLUListElement {
  constructor() {
    super();

    this.controls.forEach((button) => button.addEventListener('click', this.handleButtonClick.bind(this)));
  }

  get controls() {
    return this._controls = this._controls || Array.from(this.querySelectorAll('[aria-controls]'));
  }

  handleButtonClick(event) {
    event.preventDefault();

    this.controls.forEach((button) => {
      button.setAttribute('aria-expanded', 'false');

      const panel = document.getElementById(button.getAttribute('aria-controls'));
      panel?.removeAttribute('open');
    });

    const target = event.currentTarget;
    target.setAttribute('aria-expanded', 'true');

    const panel = document.getElementById(target.getAttribute('aria-controls'));
    panel?.setAttribute('open', '');
  }

  reset() {
    const firstControl = this.controls[0];
    firstControl.dispatchEvent(new Event('click'));
  }
}
customElements.define('tab-list', TabList, { extends: 'ul' });

class CartDrawer extends DrawerElement {
  constructor() {
    super();

    this.onPrepareBundledSectionsListener = this.onPrepareBundledSections.bind(this);
    this.onCartRefreshListener = this.onCartRefresh.bind(this);
  }

  get sectionId() {
    return this.getAttribute('data-section-id');
  }

  get shouldAppendToBody() {
    return false;
  }

  get recentlyViewed() {
    return this.querySelector('recently-viewed');
  }

  get tabList() {
    return this.querySelector('[is="tab-list"]');
  }

  connectedCallback() {
    super.connectedCallback();

    document.addEventListener('cart:bundled-sections', this.onPrepareBundledSectionsListener);
    document.addEventListener('cart:refresh', this.onCartRefreshListener);
    if (this.recentlyViewed) {
      this.recentlyViewed.addEventListener('is-empty', this.onRecentlyViewedEmpty.bind(this));
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    document.removeEventListener('cart:bundled-sections', this.onPrepareBundledSectionsListener);
    document.removeEventListener('cart:refresh', this.onCartRefreshListener);
  }

  onPrepareBundledSections(event) {
    event.detail.sections.push(this.sectionId);
  }

  onRecentlyViewedEmpty() {
    this.recentlyViewed.innerHTML = `
    <div class="drawer__scrollable relative flex justify-center items-start grow shrink text-center">
      <div class="drawer__empty grid gap-5 md:gap-8">
        <h2 class="drawer__empty-text heading leading-none tracking-tight">${theme.strings.recentlyViewedEmpty}</h2>
      </div>
    </div>
    `;
  }

  async onCartRefresh(event) {
    const id = `MiniCart-${this.sectionId}`;
    const mount = document.getElementById(id);
    if (!mount) return;

    // Cancel any in-flight refresh.
    if (this._refreshAbort) this._refreshAbort.abort();
    this._refreshAbort = new AbortController();

    try {
      const url = `${theme.routes.cart_url}?sections=${encodeURIComponent(this.sectionId)}`;
      const response = await fetch(url, { signal: this._refreshAbort.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Cart section fetch failed: ${response.status}`);
      const data = await response.json();
      const html = data && data[this.sectionId];
      // Shopify returns null for sections that failed to render even on 200.
      if (!html) throw new Error('Cart section returned null');
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const source = parsed.getElementById(id);
      if (source) {
        const snap = CartRewardFeedback.snapshot(mount);
        mount.innerHTML = source.innerHTML;
        CartRewardFeedback.process(mount, { snap });
      }
    }
    catch (error) {
      if (error.name !== 'AbortError') {
        console.error('[cart-drawer] refresh failed', error);
      }
    }
    finally {
      this._refreshAbort = null;
    }

    if (event && event.detail && event.detail.open === true) {
      this.show();
    }
  }

  show(focusElement = null, animate = true) {
    super.show(focusElement, animate);

    if (this.tabList) {
      this.tabList.reset();

      if (this.open) {
        theme.a11y.trapFocus(this, this.focusElement);
      }
    }
  }
}
customElements.define('cart-drawer', CartDrawer);

class CartRemoveButton extends HTMLAnchorElement {
  constructor() {
    super();

    this.addEventListener('click', (event) => {
      const cartItems = this.closest('cart-items');
      // No <cart-items> ancestor means the JS path is unavailable — let the href
      // (/cart/change?id=…&quantity=0) do the work rather than throwing on null
      // and leaving a dead button.
      if (!cartItems) return;

      event.preventDefault();
      const row = this.closest('.cart-item, .horizontal-product');
      const title = row && row.querySelector('[data-cart-item-title], .horizontal-product__title, .cart__item-title');
      // Hand the specific wording to onCartUpdate rather than announcing it here.
      // Announcing now meant the generic "Cart updated: N items…" replaced it a
      // few hundred milliseconds later, usually before it had been read out.
      CartItems.pendingAnnouncement = title
        ? `${title.textContent.trim()} removed from your cart`
        : 'Item removed from your cart';
      cartItems.updateQuantity(this.getAttribute('data-index'), 0);
    });
  }
}
customElements.define('cart-remove-button', CartRemoveButton, { extends: 'a' });

class CartItems extends HTMLElement {
  cartUpdateUnsubscriber = undefined;

  constructor() {
    super();

    // Debounce PER LINE. A single shared debounce meant that changing line A and
    // then line B inside the window made B's timer cancel A's — A's change was
    // never sent at all, and B's re-render reset A's input, so the shopper watched
    // their own click get undone.
    this._changeTimers = new Map();
    this._onChange = this.onChangeDebounced.bind(this);
    this.addEventListener('change', this._onChange);
    this.cartUpdateUnsubscriber = theme.pubsub.subscribe(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, this.onCartUpdate.bind(this));
  }

  get sectionId() {
    return this.getAttribute('data-section-id');
  }

  disconnectedCallback() {
    if (this.cartUpdateUnsubscriber) {
      this.cartUpdateUnsubscriber();
    }
    if (this._onChange) {
      this.removeEventListener('change', this._onChange);
    }
    this._changeTimers.forEach((id) => clearTimeout(id));
    this._changeTimers.clear();
  }

  onChangeDebounced(event) {
    const target = event.target;
    if (!target || !target.matches('input[data-index]')) return;
    const line = target.getAttribute('data-index');

    // Capture the control the shopper actually used now, while it still has focus.
    // Reading document.activeElement 120ms later can land on <body> once the
    // re-render has moved focus, which breaks focus restore after the swap.
    const activeName = document.activeElement ? document.activeElement.getAttribute('name') : null;

    clearTimeout(this._changeTimers.get(line));
    this._changeTimers.set(line, setTimeout(() => {
      this._changeTimers.delete(line);
      this.validateQuantity(target, activeName);
    }, 120));
  }

  onCartUpdate(event) {
    if (event.cart.errors) {
      this.onCartError(event.cart.errors, event.target);
      return;
    }

    // One render per change: if this update needs a duplicate-line merge (and isn't
    // our own post-merge event), let CartDedupe perform the atomic merge and render
    // from THAT result — so the intermediate split state is never painted.
    if (event.source !== 'cart-dedupe' && window.CartDedupe && window.CartDedupe.handle(event.cart)) {
      return;
    }

    const sections = event.cart.sections || {};
    const sectionHTML = sections[this.sectionId];
    const sectionToRender = sectionHTML ? new DOMParser().parseFromString(sectionHTML, 'text/html') : null;
    const totalCents = event.cart.original_total_price ?? event.cart.total_price;

    const miniCart = document.querySelector(`#MiniCart-${this.sectionId}`);
    if (miniCart && sectionToRender) {
      const updatedElement = sectionToRender.querySelector(`#MiniCart-${this.sectionId}`);
      if (updatedElement) {
        const snap = CartRewardFeedback.snapshot(miniCart);
        const state = CartStatePreserver.capture(miniCart);
        CartStatePreserver.closeOrphanableModals(miniCart);
        miniCart.innerHTML = updatedElement.innerHTML;
        CartRewardFeedback.process(miniCart, { snap, totalCents });
        CartStatePreserver.restore(miniCart, state);
      }
    }

    const mainCart = document.querySelector(`#MainCart-${this.sectionId}`);
    if (mainCart && sectionToRender) {
      const updatedElement = sectionToRender.querySelector(`#MainCart-${this.sectionId}`);
      if (updatedElement) {
        const snap = CartRewardFeedback.snapshot(mainCart);
        const state = CartStatePreserver.capture(mainCart);
        CartStatePreserver.closeOrphanableModals(mainCart);
        mainCart.innerHTML = updatedElement.innerHTML;
        // totalCents already consumed by miniCart path (if present); pass
        // anyway — emitDeltaToast is idempotent (second call has 0 delta).
        CartRewardFeedback.process(mainCart, { snap, totalCents });
        CartStatePreserver.restore(mainCart, state);
      }
      else {
        mainCart.closest('.cart')?.classList.add('is-empty');
        mainCart.remove();
      }
    }

    // Focus handling. The old code called trapFocus() after EVERY cart update,
    // including on the /cart page, where <main-cart> is an ordinary page region
    // and not a modal — so changing a quantity wrapped Tab inside the cart and a
    // keyboard user could no longer reach the header or footer. It also yanked
    // focus onto the first product title on every single + click.
    //
    // Trap only inside the drawer, and only while it is actually open. Everywhere
    // else, put focus back on the control the shopper was using and otherwise
    // leave it exactly where they left it.
    const drawer = document.querySelector('cart-drawer');
    const drawerIsOpen = !!(drawer && drawer.open);

    const lineItem = document.getElementById(`CartItem-${event.line}`) || document.getElementById(`CartDrawer-Item-${event.line}`);
    const returnTo = lineItem && event.name ? lineItem.querySelector(`[name="${event.name}"]`) : null;

    if (drawerIsOpen) {
      if (returnTo) {
        theme.a11y.trapFocus(miniCart || drawer, returnTo);
      }
      else if (event.cart.item_count === 0 && miniCart) {
        theme.a11y.trapFocus(miniCart, miniCart.querySelector('a'));
      }
      else {
        // No elementToFocus: trapFocus would otherwise jump to the drawer's first
        // focusable and undo the focus CartStatePreserver has just restored.
        // Re-arm the trap around whatever now holds focus.
        const held = document.activeElement;
        const inside = held && (miniCart || drawer) && (miniCart || drawer).contains(held);
        theme.a11y.trapFocus(miniCart || drawer, inside ? held : undefined);
      }
    }
    else if (returnTo) {
      returnTo.focus({ preventScroll: true });
    }
    else if (event.cart.item_count === 0) {
      const emptyLink = document.querySelector('.empty-state__link');
      if (emptyLink) emptyLink.focus({ preventScroll: true });
    }

    // A caller may have set a more specific message (e.g. which item was removed);
    // it wins over the generic summary, and is consumed once.
    const pending = CartItems.pendingAnnouncement;
    CartItems.pendingAnnouncement = null;
    theme.cartFeedback.announce(pending || this.updateMessage(event.cart));

    document.dispatchEvent(new CustomEvent('cart:updated', {
      detail: {
        cart: event.cart
      }
    }));

    // Pulse cart count badges
    document.querySelectorAll('cart-count').forEach((badge) => {
      badge.classList.remove('is-updating');
      void badge.offsetWidth;
      badge.classList.add('is-updating');
      badge.addEventListener('animationend', () => badge.classList.remove('is-updating'), { once: true });
    });

    // Flip subtotal animation
    CartEnhancedUI.flipSubtotal();
  }

  // Short spoken summary of the new cart state. Everything a sighted shopper reads
  // off the drawer after a change — count and total — with no markup to wade through.
  updateMessage(cart) {
    if (!cart) return '';
    if (!cart.item_count) return 'Your cart is empty';
    const items = `${cart.item_count} ${cart.item_count === 1 ? 'item' : 'items'}`;
    const total = CartRewardFeedback.formatMoney
      ? CartRewardFeedback.formatMoney(cart.total_price)
      : `₹${Math.round(cart.total_price / 100).toLocaleString('en-IN')}`;
    return `Cart updated: ${items}, total ${total}`;
  }

  onCartError(errors, target) {
    const message = typeof errors === 'string' ? errors : (errors && errors.message) || 'We couldn\'t update your cart. Please try again.';
    if (target) {
      this.disableLoading(target.getAttribute('data-index'));
      this._rollbackOptimistic(target);
      this.setValidity(target, message);
      theme.cartFeedback.error(target, message);
      // Every refusal ends up here — Shopify sends them two different ways
      // (a 4xx JSON body, and a 200 whose cart carries an `errors` string when
      // change.js clamps a line), and the rollback above cannot be trusted on
      // its own either way. It restores the value from before the optimistic
      // write, which is only the truth if the server applied nothing, and a
      // burst of taps chains those baselines: three quick presses queue three
      // jobs, the first rolls back and clears the marker, and the rest land on
      // whatever the chain left behind rather than on what the cart holds.
      // Asking the cart settles it in one hop, from the one authority there is.
      this._reconcileLine(target.getAttribute('data-index'), target);
      return;
    }
    // No target — most often a failed remove, since CartRemoveButton passes none.
    // This used to navigate the whole page to /cart, throwing the shopper out of
    // the drawer over what is usually a transient error. Surface it in place; the
    // cart on screen is still the cart the server has.
    theme.cartFeedback.error(null, message);
  }

  _abortControllers = new Map();

  // Mutations run one at a time. The old code guarded only against two requests
  // for the SAME line, so changing line A and line B together left two overlapping
  // /cart/change.js calls in flight, each returning a whole cart. Whichever landed
  // last won — and if that was A's, the drawer painted a cart that no longer had
  // B's change in it, silently disagreeing with the server until the next reload.
  //
  // STATIC, not per-instance. onCartUpdate replaces the cart container via
  // innerHTML, which disconnects this <cart-items> and upgrades a new one with a
  // fresh, empty queue — so an instance field only serialised within a single
  // render generation. Tap +A, +B, let A's render land, then tap +C and C would
  // be sent straight into the queue of a brand-new instance, overlapping B: the
  // very race this exists to prevent. The queue belongs to the cart, not to the
  // element that happens to be representing it right now.
  static _queue = Promise.resolve();

  // The last word on what a line holds, from the cart itself.
  //
  // Only ever runs after a rejected change, so it costs nothing on the happy
  // path. /cart.js is small and uncached-but-cheap; the line is found by key,
  // which is exactly what data-index carries on every quantity input.
  //
  // A line the server no longer has (the rejection removed it, or it was
  // cleared in another tab) asks the section to re-render rather than guessing
  // at a number for a row that should not be on screen.
  _reconcileLine(line, target) {
    if (!target || !line) return;
    return fetch(`${theme.routes.cart_url}.js`, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((cart) => {
        if (!cart || !Array.isArray(cart.items)) return;
        const item = cart.items.filter((i) => i.key === line)[0];
        if (!item) {
          document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
          return;
        }
        const truth = String(item.quantity);
        const live = target.isConnected ? target : this._liveTarget(line, null, target);
        if (!live) return;
        const shown = String(live.value);
        // Written to both: `value` is what is on screen, `defaultValue` is the
        // baseline setValidity() restores to on the NEXT failure. Leaving the
        // latter stale is what let a second rejected tap land on a number the
        // cart had already refused.
        live.value = truth;
        live.defaultValue = truth;
        delete live.dataset.optimistic;
        delete live.dataset.previousValue;
        // The stepper's +/- enable off input.max, and QuantityInput only
        // re-checks on its own events — so a value corrected from underneath it
        // would leave + live at the ceiling until the next interaction.
        const host = live.closest('quantity-input');
        if (host && typeof host.validateQtyRules === 'function') host.validateQtyRules();
        // A number that had to be corrected means the box disagreed with the
        // cart, so everything derived from the cart — line total, the offer
        // ladder, the footer — is suspect too. One section render settles all
        // of it. When the box was already right (the server applied nothing),
        // nothing else moved either, and this costs nothing.
        if (shown !== truth) {
          document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
        }
      })
      .catch(() => {
        // Reconciliation is a safety net, not the mechanism — the rollback has
        // already run and the error is already on screen. Staying quiet here
        // avoids reporting a second failure for one refused tap.
      });
  }

  _rollbackOptimistic(target) {
    if (!target || target.dataset.optimistic !== 'true') return;
    const previous = target.dataset.previousValue;
    if (previous != null) {
      target.value = previous;
      // defaultValue is the baseline setValidity() restores to. Leaving it on the
      // rejected quantity meant a second failure rolled back to a value the server
      // had already refused.
      target.defaultValue = previous;
    }
    delete target.dataset.optimistic;
    delete target.dataset.previousValue;
  }

  // How many jobs are outstanding per line, so a completing job cannot clear a
  // spinner that a still-queued job for the same line owns.
  static _pending = new Map();

  // Set by a caller that knows something more useful than "cart updated".
  static pendingAnnouncement = null;

  updateQuantity(line, quantity, name, target) {
    CartItems._pending.set(line, (CartItems._pending.get(line) || 0) + 1);
    this.enableLoading(line);

    // Optimistic: remember the previous value so we can roll back on error.
    if (target) {
      target.dataset.previousValue = target.defaultValue;
      target.dataset.optimistic = 'true';
      target.defaultValue = String(quantity);
    }

    CartItems._queue = CartItems._queue
      .catch(() => {})
      .then(() => this._sendQuantity(line, quantity, name, target));
    return CartItems._queue;
  }

  // Re-find the live control for a line. A job that waited in the queue may have
  // had its `target` detached by an earlier job's re-render; writing the rollback
  // or the inline error into that orphan means the shopper sees neither.
  _liveTarget(line, name, target) {
    if (target && target.isConnected) return target;
    if (!line) return target;
    const sel = name
      ? `[data-index="${CSS.escape(line)}"][name="${CSS.escape(name)}"]`
      : `[data-index="${CSS.escape(line)}"]`;
    return document.querySelector(sel) || target;
  }

  _sendQuantity(line, quantity, name, target) {
    // Cancel any in-flight request for the same line.
    const prev = this._abortControllers.get(line);
    if (prev) prev.abort();
    const controller = new AbortController();
    this._abortControllers.set(line, controller);

    let sectionsToBundle = [];
    document.documentElement.dispatchEvent(new CustomEvent('cart:bundled-sections', { bubbles: true, detail: { sections: sectionsToBundle } }));

    const body = JSON.stringify({
      id: line,
      quantity,
      sections: sectionsToBundle,
      sections_url: window.location.pathname
    });

    return fetch(`${theme.routes.cart_change_url}`, { ...theme.utils.fetchConfig(), body, signal: controller.signal })
      .then((response) => {
        // Shopify sends its validation failures as 4xx with a JSON body, so a bad
        // status is not on its own an error — but an HTML error page or a 5xx is,
        // and .json() on one of those used to reject into a console-only handler.
        return response.text().then((text) => {
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
          if (!parsed) {
            throw new Error(`Cart returned ${response.status} with a non-JSON body`);
          }
          return parsed;
        });
      })
      .then((parsedState) => {
        if (this._abortControllers.get(line) === controller) this._abortControllers.delete(line);
        if (parsedState && parsedState.status && parsedState.status >= 400) {
          // Shopify returns { status, message, description } on validation failure.
          // onCartError reconciles the control against the cart itself.
          this.onCartError(parsedState.description || parsedState.message, this._liveTarget(line, name, target));
          return;
        }
        // Success: clear optimistic markers; onCartUpdate will reconcile DOM.
        if (target) {
          delete target.dataset.optimistic;
          delete target.dataset.previousValue;
        }
        theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, { source: 'cart-items', cart: parsedState, target, line, name });
      })
      .catch((error) => {
        if (error.name === 'AbortError') return; // superseded — ignore.
        console.error('[cart-items] updateQuantity failed', error);
        this.disableLoading(line);
        const live = this._liveTarget(line, name, target);
        this._rollbackOptimistic(live);
        // Previously this failed completely silently: the number snapped back with
        // no explanation and the shopper had no idea the cart had not changed.
        theme.cartFeedback.error(
          live,
          (theme.cartStrings && theme.cartStrings.updateFailed) || "We couldn't update your cart. Please check your connection and try again."
        );
      })
      .finally(() => {
        // The success path used to rely on the section re-render replacing the
        // spinner's node. Any path that skips the render (no sections in the
        // payload, a dedupe short-circuit) left it spinning forever.
        //
        // Only the LAST outstanding job for this line clears it: two taps more
        // than the debounce apart enqueue two jobs, and the first to finish
        // would otherwise hide a spinner the second still needs.
        const left = (CartItems._pending.get(line) || 1) - 1;
        if (left > 0) { CartItems._pending.set(line, left); return; }
        CartItems._pending.delete(line);
        this.disableLoading(line);
      });
  }

  enableLoading(line) {
    const loader = document.getElementById(`Loader-${this.sectionId}-${line}`);
    if (loader) loader.hidden = false;
  }

  disableLoading(line) {
    const loader = document.getElementById(`Loader-${this.sectionId}-${line}`);
    if (loader) loader.hidden = true;
  }

  setValidity(target, message) {
    target.setCustomValidity(message);
    target.reportValidity();
    target.value = target.defaultValue;
    target.select();
  }

  validateQuantity(target, activeName) {
    if (!target) return;
    const index = target.getAttribute('data-index');
    const raw = String(target.value).trim();
    const inputValue = Number.parseInt(raw, 10);

    // Anything non-numeric used to fall straight through: every comparison below
    // is false against NaN, so no message was set and NaN was posted as the new
    // quantity, which serialises to "quantity": null.
    if (raw === '' || !Number.isInteger(inputValue) || inputValue < 0) {
      this.setValidity(target, (theme.cartStrings && theme.cartStrings.quantityInvalid) || 'Enter a whole number.');
      return;
    }

    // A blank data-min/step attribute parses to NaN, and `x % NaN !== 0` is always
    // true — which raised a step error on every perfectly valid quantity.
    const min = Number.parseInt(target.getAttribute('data-min'), 10) || 1;
    const max = Number.parseInt(target.max, 10);
    const step = Number.parseInt(target.step, 10) || 1;
    let message = '';

    // 0 means "remove this line", which is exactly what the markup's min="0"
    // advertises. It used to be rejected against data-min (normally 1), so typing
    // 0 raised a validation error instead of removing the item.
    if (inputValue > 0 && inputValue < min) {
      message = theme.quickOrderListStrings.minError.replace('[min]', String(min));
    }
    else if (Number.isInteger(max) && inputValue > max) {
      message = theme.quickOrderListStrings.maxError.replace('[max]', String(max));
    }
    else if (inputValue > 0 && inputValue % step !== 0) {
      message = theme.quickOrderListStrings.stepError.replace('[step]', String(step));
    }

    if (message) {
      this.setValidity(target, message);
    }
    else {
      target.setCustomValidity('');
      target.reportValidity();
      theme.cartFeedback.clear(target);
      this.updateQuantity(index, inputValue, activeName || target.getAttribute('name'), target);
    }
  }
}
customElements.define('cart-items', CartItems);

class CartNote extends HTMLElement {
  constructor() {
    super();

    this._onChangeDebounced = theme.utils.debounce(this.onChange.bind(this), 300);
    this.addEventListener('change', this._onChangeDebounced);
  }

  disconnectedCallback() {
    if (this._onChangeDebounced) {
      this.removeEventListener('change', this._onChangeDebounced);
    }
  }

  onChange(event) {
    const body = JSON.stringify({ note: event.target.value });
    fetch(`${theme.routes.cart_update_url}`, { ...theme.utils.fetchConfig(), ...{ body } })
      .then((response) => {
        if (!response.ok) throw new Error('Failed to save note');
      })
      .catch((error) => {
        console.error(error);
        if (theme?.pubsub) theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS?.toastShow || 'toast:show', { message: 'Failed to save cart note. Please try again.' });
      });
  }
}
customElements.define('cart-note', CartNote);

class MainCart extends HTMLElement {
  connectedCallback() {
    this._onPrepareBundledSections = this.onPrepareBundledSections.bind(this);
    document.addEventListener('cart:bundled-sections', this._onPrepareBundledSections);
  }

  disconnectedCallback() {
    if (this._onPrepareBundledSections) {
      document.removeEventListener('cart:bundled-sections', this._onPrepareBundledSections);
    }
  }

  get sectionId() {
    return this.getAttribute('data-section-id');
  }

  onPrepareBundledSections(event) {
    event.detail.sections.push(this.sectionId);
  }
}
customElements.define('main-cart', MainCart);

class CountryProvince extends HTMLElement {
  constructor() {
    super();

    this.provinceElement = this.querySelector('[name="address[province]"]');
    this.countryElement = this.querySelector('[name="address[country]"]');
    this.countryElement.addEventListener('change', this.handleCountryChange.bind(this));

    if (this.getAttribute('country') !== '') {
      this.countryElement.selectedIndex = Math.max(0, Array.from(this.countryElement.options).findIndex((option) => option.textContent === this.getAttribute('data-country')));
      this.countryElement.dispatchEvent(new Event('change'));
    }
    else {
      this.handleCountryChange();
    }
  }

  handleCountryChange() {
    const option = this.countryElement.options[this.countryElement.selectedIndex], provinces = JSON.parse(option.getAttribute('data-provinces'));
    this.provinceElement.parentElement.hidden = provinces.length === 0;

    if (provinces.length === 0) {
      return;
    }

    this.provinceElement.innerHTML = '';

    provinces.forEach((data) => {
      const selected = data[1] === this.getAttribute('data-province');
      this.provinceElement.options.add(new Option(data[1], data[0], selected, selected));
    });
  }
}
customElements.define('country-province', CountryProvince);

class ShippingCalculator extends HTMLFormElement {
  constructor() {
    super();

    this.submitButton = this.querySelector('[type="submit"]');
    this.resultsElement = this.lastElementChild;

    this.submitButton.addEventListener('click', this.handleFormSubmit.bind(this));
  }

  handleFormSubmit(event) {
    event.preventDefault();

    this.abortController?.abort();
    this.abortController = new AbortController();

    const zip = this.querySelector('[name="address[zip]"]').value,
      country = this.querySelector('[name="address[country]"]').value,
      province = this.querySelector('[name="address[province]"]').value;

    this.submitButton.setAttribute('aria-busy', 'true');

    const body = JSON.stringify({
      shipping_address: { zip, country, province }
    });
    let sectionUrl = `${theme.routes.cart_url}/shipping_rates.json`;

    // remove double `/` in case shop might have /en or language in URL
    sectionUrl = sectionUrl.replace('//', '/');

    fetch(sectionUrl, { ...theme.utils.fetchConfig('javascript'), ...{ body }, signal: this.abortController.signal })
      .then((response) => response.json())
      .then((parsedState) => {
        if (parsedState.shipping_rates) {
          this.formatShippingRates(parsedState.shipping_rates);
        }
        else {
          this.formatError(parsedState);
        }
      })
      .catch((error) => {
        if (error.name === 'AbortError') {
          console.log('Fetch aborted by user');
        }
        else {
          console.error(error);
        }
      })
      .finally(() => {
        this.resultsElement.hidden = false;
        this.submitButton.removeAttribute('aria-busy');
      });

  }

  _buildAlert(variant, messageText, items) {
    const wrapper = document.createElement('div');
    wrapper.className = `alert alert--${variant} grid gap-2 text-sm leading-tight`;

    const p = document.createElement('p');
    p.textContent = messageText;
    wrapper.appendChild(p);

    if (items && items.length) {
      const ul = document.createElement('ul');
      ul.className = 'list-disc grid gap-2';
      ul.setAttribute('role', 'list');
      items.forEach((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        ul.appendChild(li);
      });
      wrapper.appendChild(ul);
    }

    this.resultsElement.replaceChildren(wrapper);
  }

  formatError(errors) {
    const items = Object.keys(errors).map((errorKey) => String(errors[errorKey]));
    this._buildAlert('error', theme.shippingCalculatorStrings.error, items);
  }

  formatShippingRates(shippingRates) {
    const items = shippingRates.map(({ presentment_name, currency, price }) =>
      `${presentment_name}: ${currency} ${price}`
    );
    const variant = shippingRates.length === 0 ? 'error' : 'success';
    const message = shippingRates.length === 0
      ? theme.shippingCalculatorStrings.notFound
      : shippingRates.length === 1
        ? theme.shippingCalculatorStrings.oneResult
        : theme.shippingCalculatorStrings.multipleResults;
    this._buildAlert(variant, message, items);
  }
}
customElements.define('shipping-calculator', ShippingCalculator, { extends: 'form' });

/* ============================================================
   ENHANCED MINI CART: DELIVERY ETA CALCULATOR
   Runs on mount, calculates dynamic arrival date
   ============================================================ */

class CartDeliveryETA extends HTMLElement {
  connectedCallback() {
    this._render();
    // Also update on cart change (price reflects new total)
    document.addEventListener('cart:updated', this._onCartUpdated = this._handleCartUpdate.bind(this));
  }

  disconnectedCallback() {
    document.removeEventListener('cart:updated', this._onCartUpdated);
  }

  _handleCartUpdate(event) {
    const priceEl = this.querySelector('.js-eta-price');
    if (!priceEl) return;
    const newTotal = event.detail.cart.total_price;
    if (theme.currencyDisplay && theme.currencyDisplay.usd && theme.money) {
      priceEl.textContent = theme.money.format(newTotal);
      return;
    }
    const moneyFormat = theme.settings.moneyWithCurrencyFormat || theme.settings.moneyFormat || '₹{{amount_no_decimals}}';
    const val = Math.round(newTotal / 100);
    priceEl.textContent = moneyFormat.replace(/\{\{amount[^}]*\}\}/g, val.toLocaleString('en-IN'));
  }

  _render() {
    const cutoffHour = parseInt(this.dataset.cutoff, 10) || 14; // 2 PM IST
    const minDays    = parseInt(this.dataset.minDays, 10) || 3;
    const maxDays    = parseInt(this.dataset.maxDays, 10) || 4;

    // Attempt to parse dynamic timezone offset from dataset, fallback to local timezone
    const tzOffsetStr = this.dataset.tzOffset || "+0530";
    let tzOffsetMillis = 0;
    try {
      const sign = tzOffsetStr[0] === '-' ? -1 : 1;
      const parsedHours = parseInt(tzOffsetStr.slice(1, 3), 10) || 0;
      const parsedMinutes = parseInt(tzOffsetStr.slice(3, 5), 10) || 0;
      tzOffsetMillis = sign * ((parsedHours * 60) + parsedMinutes) * 60 * 1000;
    } catch (e) {
      tzOffsetMillis = 5.5 * 60 * 60 * 1000; // fallback IST
    }

    const now = new Date();
    const localNow = new Date(now.getTime() + (now.getTimezoneOffset() * 60 * 1000) + tzOffsetMillis);
    const shipsToday = localNow.getHours() < cutoffHour && localNow.getDay() !== 0;

    const shipDate = new Date(localNow);
    if (!shipsToday) {
      shipDate.setDate(shipDate.getDate() + 1);
    }
    // Skip Sunday for ship date
    if (shipDate.getDay() === 0) shipDate.setDate(shipDate.getDate() + 1);

    // Calculate min/max delivery dates
    const deliveryMin = new Date(shipDate);
    deliveryMin.setDate(deliveryMin.getDate() + minDays);
    while (deliveryMin.getDay() === 0) deliveryMin.setDate(deliveryMin.getDate() + 1);

    const deliveryMax = new Date(shipDate);
    deliveryMax.setDate(deliveryMax.getDate() + maxDays);
    while (deliveryMax.getDay() === 0) deliveryMax.setDate(deliveryMax.getDate() + 1);

    const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const minStr = `${DAYS[deliveryMin.getDay()]}, ${MONTHS[deliveryMin.getMonth()]} ${deliveryMin.getDate()}`;
    const maxDate = deliveryMax.getDate();
    const arrivalStr = deliveryMin.getMonth() === deliveryMax.getMonth()
      ? `Arriving ${minStr}–${maxDate}`
      : `Arriving ${minStr}–${DAYS[deliveryMax.getDay()]}, ${MONTHS[deliveryMax.getMonth()]} ${maxDate}`;

    const shipLabelEl   = this.querySelector('.js-ship-label');
    const arrivalLabelEl = this.querySelector('.js-arrival-label');

    if (shipLabelEl) {
      shipLabelEl.textContent = shipsToday ? 'Ships Today' : 'Ships Tomorrow';
    }
    if (arrivalLabelEl) {
      arrivalLabelEl.textContent = arrivalStr;
    }
  }
}
customElements.define('cart-delivery-eta', CartDeliveryETA);



/* ============================================================
   ENHANCED MINI CART: INLINE VARIANT SWITCHER
   Safely adds the new variant and removes the old one.
   ============================================================ */
class CartVariantSwitcher {
  static async swapVariant(button) {
    if (button.classList.contains('is-disabled') || button.classList.contains('is-active')) return;
    
    // Disable buttons while processing
    const container = button.closest('.cart-size-switcher');
    const buttons = container.querySelectorAll('.cart-size-pill');
    // Capture BEFORE overwriting: this used to read innerText after setting it to
    // '...', so originalLabel was the spinner on every path — the success
    // announcement said "Size changed to ...", and a failure left the pill
    // permanently reading '...' while re-enabling it as a clickable blank.
    const originalLabel = button.innerText;
    buttons.forEach(b => b.classList.add('is-disabled'));
    button.innerText = '...';
    const newVariantId = button.getAttribute('data-variant-id');
    const oldLineKey = button.getAttribute('data-line-key');
    const quantity = Number.parseInt(button.getAttribute('data-qty'), 10);

    if (!newVariantId || !oldLineKey || !Number.isInteger(quantity) || quantity < 1) {
      buttons.forEach((b) => b.classList.remove('is-disabled'));
      button.innerText = originalLabel;
      return;
    }

    try {
      // The `updates` map is ABSOLUTE, not additive. Sending { newVariantId: qty }
      // blindly meant that swapping M→L when L was already in the cart at qty 2
      // *replaced* that 2 with the swapped quantity, silently destroying it. Read
      // the cart first and add to whatever the target variant already holds.
      const currentRes = await fetch(window.Shopify.routes.root + 'cart.js', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin'
      });
      if (!currentRes.ok) throw new Error(`cart.js returned ${currentRes.status}`);
      const current = await currentRes.json();

      const existing = (current.items || [])
        .filter((it) => String(it.variant_id) === String(newVariantId) && it.key !== oldLineKey)
        .reduce((sum, it) => sum + it.quantity, 0);

      let sectionsToBundle = [];
      document.documentElement.dispatchEvent(new CustomEvent('cart:bundled-sections', { bubbles: true, detail: { sections: sectionsToBundle } }));

      const response = await fetch(window.Shopify.routes.root + 'cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          updates: {
            [oldLineKey]: 0,
            [newVariantId]: existing + quantity
          },
          // Without these the response carries no rendered sections, so
          // CartItems.onCartUpdate had nothing to render and returned early —
          // the drawer never refreshed and this pill stayed stuck showing '...'.
          sections: sectionsToBundle,
          sections_url: window.location.pathname
        })
      });

      if (!response.ok) throw new Error('Network response was not ok');
      const cartData = await response.json();

      if (theme && theme.pubsub) {
        theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, {
          source: 'cart-items',
          cart: cartData
        });
        theme.cartFeedback.announce(`Size changed to ${originalLabel.trim()}`);
      } else {
        window.location.reload();
      }

    } catch (error) {
      console.error('Error swapping variant:', error);
      buttons.forEach(b => b.classList.remove('is-disabled'));
      button.innerText = originalLabel;
      theme.cartFeedback.error(button, "We couldn't change the size. Please try again.");
    }
  }
}
window.CartVariantSwitcher = CartVariantSwitcher;

/* ============================================================
   CART: de-duplicate lines of the same variant (atomic, ONE render)
   ------------------------------------------------------------
   Some add paths attach hidden line-item properties (e.g. `_free_gift`, or
   `_bundle_parent_variant_id` from an external bundle app) that stop Shopify
   from merging otherwise-identical variants, so the same tee can show up as
   two separate lines (e.g. qty 3 + qty 2).

   We merge lines of the same variant + selling plan + SAME PER-UNIT PRICE — a
   uniform order discount (e.g. 5% off) keeps the per-unit price equal across the
   split lines so they merge, while a genuinely free / BXGY / discounted-bundle
   line has a different per-unit price and is left untouched so its pricing stays
   correct.

   The merge is a single ATOMIC POST /cart/update.js (Section Rendering API),
   computed from a freshly-fetched cart so it can never hit a stale line-item key
   (keys change when discounts re-allocate) or clobber a concurrent change.
   CartItems.onCartUpdate calls handle() first and skips its own render while a
   merge is pending, so the shopper sees exactly ONE render and never the split.
   ============================================================ */
window.CartDedupe = window.CartDedupe || (function () {
  let busy = false;

  // Eligible to merge: real positive price/qty, not a zeroed/free line, not an
  // explicit free gift. The real safety is the per-unit-price group key below.
  function isMergeable(item) {
    if (!item || !(item.price > 0) || !(item.quantity > 0)) return false;
    if (!(item.final_line_price > 0)) return false; // skip free / fully-zeroed lines
    if (item.properties && item.properties._free_gift) return false;
    return true;
  }

  function propCount(item) {
    return Object.keys(item.properties || {}).length;
  }

  // All groups of >= 2 lines sharing variant id + selling plan + per-unit price.
  function findGroups(cart) {
    if (!cart || !Array.isArray(cart.items)) return [];
    const groups = new Map();
    cart.items.forEach((item) => {
      if (!isMergeable(item)) return;
      const sp = item.selling_plan_allocation ? item.selling_plan_allocation.selling_plan.id : '';
      const unitPrice = Math.round(item.final_line_price / item.quantity);
      const groupKey = item.id + '|' + sp + '|' + unitPrice;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(item);
    });
    return Array.from(groups.values()).filter((lines) => lines.length >= 2);
  }

  function bundledSectionIds() {
    const sections = [];
    document.documentElement.dispatchEvent(
      new CustomEvent('cart:bundled-sections', { bubbles: true, detail: { sections } })
    );
    return sections;
  }

  // Re-fetch the freshest cart, fold EVERY duplicate group into one line each, and
  // apply it atomically via a SINGLE /cart/update.js — so a concurrent add can't be
  // clobbered and no stale line-item key is used. Always publishes one 'cart-dedupe'
  // cartUpdate (with re-rendered sections), which renders exactly once.
  function runMerge(fallbackCart) {
    busy = true;
    fetch(`${theme.routes.cart_url}`, { ...theme.utils.fetchConfig('json', 'GET') })
      .then((r) => r.json())
      .then((cart) => {
        const updates = {};
        findGroups(cart).forEach((lines) => {
          lines.sort((a, b) => propCount(a) - propCount(b));
          const keeper = lines[0];
          updates[keeper.key] = lines.reduce((sum, l) => sum + l.quantity, 0);
          lines.slice(1).forEach((l) => { updates[l.key] = 0; });
        });
        // Empty `updates` is a harmless no-op that still returns rendered sections,
        // guaranteeing the originating change is painted exactly once.
        const body = JSON.stringify({
          updates,
          sections: bundledSectionIds(),
          sections_url: window.location.pathname,
        });
        return fetch(`${theme.routes.cart_update_url}`, { ...theme.utils.fetchConfig(), body }).then((r) => r.json());
      })
      .then((state) => {
        theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, { source: 'cart-dedupe', cart: state });
      })
      .catch((error) => {
        console.error('[cart-dedupe] merge failed', error);
        // Graceful degradation: still render the originating change (we suppressed
        // its render expecting the merge to render). Worst case shows the un-merged
        // state; the next interaction will re-merge.
        if (fallbackCart) {
          theme.pubsub.publish(theme.pubsub.PUB_SUB_EVENTS.cartUpdate, { source: 'cart-dedupe', cart: fallbackCart });
        }
      })
      .finally(() => { busy = false; });
  }

  // Called by CartItems.onCartUpdate before it renders. Returns true if the caller
  // should SKIP rendering because a merge (and its single render) is on the way.
  function handle(cart) {
    if (busy) return true;                 // a merge render is already coming
    if (findGroups(cart).length === 0) return false;
    runMerge(cart);
    return true;
  }

  // Heal a cart that is already split on first load (no cartUpdate fires for it).
  //
  // This used to run on EVERY page of the site, unconditionally: an extra
  // GET /cart.js on every product page, collection page and article view, to look
  // for a duplicate-line condition that is rare and needs at least two lines to
  // exist at all. theme.cartItemCount is rendered from Liquid, so the check is
  // free — a cart of 0 or 1 line cannot be split, and the request is skipped.
  //
  // Deferred to first idle either way, so it never competes with rendering.
  if (typeof theme !== 'undefined' && theme.pubsub) {
    const initialPass = () => {
      const known = typeof theme.cartItemCount === 'number' ? theme.cartItemCount : null;
      if (known !== null && known < 2) return;
      fetch(`${theme.routes.cart_url}`, { ...theme.utils.fetchConfig('json', 'GET') })
        .then((r) => (r.ok ? r.json() : null))
        .then((cart) => { if (cart) handle(cart); })
        .catch(() => {});
    };
    const schedule = () => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(initialPass, { timeout: 3000 });
      else setTimeout(initialPass, 0);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', schedule);
    } else {
      schedule();
    }
  }

  return { handle };
})();

/* ============================================================
   USD billing disclosure refresher (US display context only).
   The disclosure above checkout names the REAL INR amount Razorpay will
   charge, so it must never route through the USD formatters — it formats
   INR inline, matching Liquid's `money` filter ("₹10,167.30"). Section
   re-renders update it server-side; this keeps it live in between.
   ============================================================ */
document.addEventListener('cart:updated', (event) => {
  const els = document.querySelectorAll('.js-usd-billed');
  if (!els.length) return;
  const cart = event.detail && event.detail.cart;
  if (!cart || cart.total_price == null) return;
  const [int, dec] = (cart.total_price / 100).toFixed(2).split('.');
  const inr = '₹' + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
  els.forEach((el) => { el.textContent = inr; });
});
