/* ============================================================
   <card-swipe> — swipeable product-card image gallery.

   Engine: Swiper.js (assets/swiper-bundle.min.js).

   This element is a thin, lazy-mounting host: when the card nears the
   viewport it clones the sibling <template> images into a Swiper, and
   keeps the theme's OWN dots + (desktop) arrows + hover-peek so the look
   is byte-for-byte identical to the previous custom carousel.

   Why Swiper: its touch engine (touchAngle / threshold) reliably releases
   VERTICAL page scrolling to the browser on every engine — Chrome/Android
   and the Instagram / in-app WebViews included — which the old hand-rolled
   gesture code did not (it locked to a horizontal swipe on the first touch
   sample's sideways lead and preventDefault()'d the whole gesture, so it
   scrolled fine on Safari but stuck on Chrome).

   - Touch: Swiper finger-swipe, axis-aware (vertical scroll never hijacked).
     Disabled inside a mobile card-carousel (.slider--tablet) so the outer
     carousel keeps the horizontal gesture — dots/arrows still navigate here.
   - Desktop (no touch): hover-to-peek (mouse-x zones) + dots/arrows.
   - Lives inside the card's <a href>: a swipe is suppressed from navigating
     (Swiper preventClicks); a tap still opens the product. Dots/arrows stop
     their own clicks from bubbling to the <a>.
   ============================================================ */
(function () {
  if (window.customElements && customElements.get('card-swipe')) return;

  var cfg = (window.theme && theme.config) || {};
  var isTouch = cfg.isTouch || ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  var reduceMotion = !!cfg.motionReduced;
  var mqMobile = window.matchMedia ? window.matchMedia('(max-width: 767px)') : { matches: false };

  function throttle(fn, wait) {
    if (window.theme && theme.utils && theme.utils.throttle) return theme.utils.throttle(fn, wait);
    var last = 0;
    return function () {
      var now = Date.now();
      if (now - last >= (wait || 60)) { last = now; fn.apply(this, arguments); }
    };
  }

  class CardSwipe extends HTMLElement {
    constructor() {
      super();
      this._mounted = false;
      this._index = 0;
    }

    connectedCallback() {
      if (this._observing || this._mounted) return;
      this._observing = true;

      var mount = this.mount.bind(this);
      if (window.Motion && Motion.inView) {
        this._stopInView = Motion.inView(this, function () { mount(); }, { margin: '200px 0px 200px 0px' });
      } else if ('IntersectionObserver' in window) {
        this._io = new IntersectionObserver(function (entries, obs) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) { obs.disconnect(); mount(); break; }
          }
        }, { rootMargin: '200px 0px 200px 0px' });
        this._io.observe(this);
      } else {
        mount();
      }
    }

    disconnectedCallback() {
      if (this._io) this._io.disconnect();
      if (this._stopInView) this._stopInView();
      if (this.swiper && this.swiper.destroy) {
        try { this.swiper.destroy(true, true); } catch (e) {}
      }
    }

    get template() {
      var prev = this.previousElementSibling;
      if (prev && prev.tagName === 'TEMPLATE') return prev;
      return this.querySelector('template');
    }

    mount() {
      if (this._mounted) return;
      var tpl = this.template;
      if (!tpl) return;

      var frag = tpl.content.cloneNode(true);
      var media = frag.querySelectorAll('.media');
      this.count = media.length;
      if (this.count < 2) return;                 // nothing to swipe — keep the featured image
      if (typeof Swiper === 'undefined') return;  // engine missing — degrade to the featured image

      this._mounted = true;

      // Build the Swiper DOM: .swiper > .swiper-wrapper > .swiper-slide(.media)
      var container = document.createElement('div');
      container.className = 'swiper card-swipe__swiper';
      var wrapper = document.createElement('div');
      wrapper.className = 'swiper-wrapper';
      this.slides = [];
      for (var i = 0; i < media.length; i++) {
        var slide = document.createElement('div');
        slide.className = 'swiper-slide';
        slide.appendChild(media[i]);
        wrapper.appendChild(slide);
        this.slides.push(slide);
      }
      container.appendChild(wrapper);
      this.appendChild(container);
      this.swiperEl = container;

      this.setAttribute('role', 'group');

      this.buildDots();
      this.buildArrows();

      // Inside a mobile card-carousel we must not steal the horizontal gesture —
      // dots/arrows navigate there instead, the outer carousel keeps the swipe.
      var inMobileCarousel = !!this.closest('.slider--tablet');
      this._swipeEnabled = isTouch && !(inMobileCarousel && mqMobile.matches);

      var self = this;
      this.swiper = new Swiper(container, {
        slidesPerView: 1,
        spaceBetween: 0,
        speed: reduceMotion ? 0 : 350,
        threshold: 5,            // ignore sub-5px jitter before a swipe starts
        touchAngle: 45,          // >45° from horizontal => release to vertical page scroll
        resistanceRatio: 0.85,
        followFinger: true,
        allowTouchMove: this._swipeEnabled,  // finger-drag only where we own the gesture
        simulateTouch: false,                // desktop uses hover-peek + arrows, not mouse-drag
        watchOverflow: true,
        a11y: false,             // we keep our own aria on the dots/arrows
        on: {
          slideChange: function () { self._index = this.activeIndex; self.updateUI(); }
        }
      });

      // Desktop hover-to-peek (mouse-x zones). Programmatic slideTo ignores
      // allowTouchMove, so this works while finger-drag stays off on desktop.
      if (!isTouch) this.bindHover();
      this.addEventListener('keydown', this.onKeydown.bind(this));

      this.classList.add('is-ready');
      this.updateUI();
    }

    buildDots() {
      var self = this;
      var nav = document.createElement('div');
      nav.className = 'card-swipe__dots';
      this.dots = [];
      for (var i = 0; i < this.count; i++) {
        var dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'card-swipe__dot';
        dot.setAttribute('aria-label', 'Go to image ' + (i + 1));
        (function (idx) {
          dot.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();   // don't let the dot click bubble to the card <a>
            if (self.swiper) self.swiper.slideTo(idx);
          });
        })(i);
        nav.appendChild(dot);
        this.dots.push(dot);
      }
      this.appendChild(nav);
    }

    buildArrows() {
      this.prevBtn = this._makeArrow('prev', 'Previous image', 'M15 18l-6-6 6-6');
      this.nextBtn = this._makeArrow('next', 'Next image', 'M9 6l6 6-6 6');
    }

    _makeArrow(dir, label, path) {
      var self = this;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-swipe__arrow card-swipe__arrow--' + dir;
      btn.setAttribute('aria-label', label);
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (!self.swiper) return;
        if (dir === 'next') self.swiper.slideNext();
        else self.swiper.slidePrev();
      });
      this.appendChild(btn);
      return btn;
    }

    bindHover() {
      var self = this;
      var onMove = throttle(function (e) {
        if (!self.swiper) return;
        var w = self.clientWidth;
        if (!w) return;
        var x = e.clientX - self.getBoundingClientRect().left;
        var zone = Math.floor(x / (w / self.count));
        if (zone < 0) zone = 0;
        if (zone > self.count - 1) zone = self.count - 1;
        self.swiper.slideTo(zone);   // animated peek (matches the previous behaviour)
      }, 50);
      this.addEventListener('mousemove', onMove);
      this.addEventListener('mouseleave', function () { if (self.swiper) self.swiper.slideTo(0); });
    }

    onKeydown(e) {
      if (!this.swiper) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); this.swiper.slideNext(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.swiper.slidePrev(); }
    }

    updateUI() {
      var idx = this.swiper ? this.swiper.activeIndex : this._index;
      if (this.dots) {
        this.dots.forEach(function (d, i) {
          var on = i === idx;
          d.classList.toggle('is-active', on);
          if (on) d.setAttribute('aria-current', 'true');
          else d.removeAttribute('aria-current');
        });
      }
      if (this.prevBtn) this.prevBtn.disabled = this.swiper ? this.swiper.isBeginning : idx <= 0;
      if (this.nextBtn) this.nextBtn.disabled = this.swiper ? this.swiper.isEnd : idx >= this.count - 1;
    }
  }

  customElements.define('card-swipe', CardSwipe);
})();
