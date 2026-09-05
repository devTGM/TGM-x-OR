/*
 * Theme toast / snackbar system.
 * Public API: theme.toast({ message, variant, duration, action })
 *   variant:  'success' | 'error' | 'info' (default 'info')
 *   duration: ms, default 4000. Pass 0 to keep open until dismissed.
 *   action:   { label, onClick } — optional button inside the toast.
 * The first call lazily creates <toast-container> in <body>.
 */
(function () {
  'use strict';
  window.theme = window.theme || {};
  if (window.theme.toast) return;

  const ICONS = {
    success:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  class ToastContainer extends HTMLElement {
    connectedCallback() {
      this.setAttribute('role', 'region');
      this.setAttribute('aria-label', 'Notifications');
    }

    show({ message, variant = 'info', duration = 4000, action } = {}) {
      if (!message) return null;
      const v = ICONS[variant] ? variant : 'info';
      const toast = document.createElement('div');
      toast.className = `toast toast--${v}`;
      toast.setAttribute('role', v === 'error' ? 'alert' : 'status');
      toast.setAttribute('aria-live', v === 'error' ? 'assertive' : 'polite');

      const icon = document.createElement('span');
      icon.className = 'toast__icon';
      icon.innerHTML = ICONS[v];
      toast.appendChild(icon);

      const body = document.createElement('div');
      body.className = 'toast__body';
      body.textContent = message;
      toast.appendChild(body);

      if (action && action.label && typeof action.onClick === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast__action';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
          try { action.onClick(); } finally { dismiss(); }
        });
        toast.appendChild(btn);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast__close';
      close.setAttribute('aria-label', 'Dismiss notification');
      close.innerHTML = '&times;';
      close.addEventListener('click', dismiss);
      toast.appendChild(close);

      this.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('is-visible'));

      let timer = null;
      function dismiss() {
        if (!toast.isConnected) return;
        clearTimeout(timer);
        toast.classList.remove('is-visible');
        toast.classList.add('is-leaving');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        setTimeout(() => { if (toast.isConnected) toast.remove(); }, 500);
      }
      if (duration > 0) timer = setTimeout(dismiss, duration);

      return { dismiss };
    }
  }
  customElements.define('toast-container', ToastContainer);

  function ensureContainer() {
    let el = document.querySelector('toast-container');
    if (!el) {
      el = document.createElement('toast-container');
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  window.theme.toast = function toast(opts) {
    return ensureContainer().show(opts || {});
  };
})();
