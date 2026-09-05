/**
 * Virtual Try-On (VTO) — OnRepeat.
 *
 * Highly performant, modular Virtual Try-On controller.
 * Splits features into logical internal classes to avoid main-thread overhead,
 * resolves same-origin CDN restrictions for HEIC off-main-thread processing,
 * implements resilient offline-mode suspension, and enables GPU idempotency.
 *
 * Plain ES6 — no build step. Depends on global `window.VtoStateMachine`
 * from assets/vto-state.js (loaded separately by the theme).
 */
(function () {
  'use strict';

  /**
   * Every element that can wear a try-on session.
   *
   * Deliberately the bare attribute rather than a class: a placement is
   * whatever renders `data-vto-tile`, and there are two on a product page —
   * the buy bar's 48px thumbnail and the gallery pill over the hero. Naming
   * one of them in the selector is what would let a new placement quietly
   * miss the state machine, which is the exact failure this indicator cannot
   * afford: a shopper who starts a render on the gallery pill and scrolls to
   * the buy bar must not find it sitting there at rest.
   */
  const VTO_TILE_SEL = '[data-vto-tile]';

  const API_URL = 'https://asia-south1-gen-lang-client-0263205017.cloudfunctions.net/virtual-tryon';
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
  /**
   * The long edge the customer's photo is resized to before it is sent.
   *
   * This was 1024 at quality 0.85, and it was the single biggest reason a
   * try-on came back wearing somebody else's face. Measured on a real 2400x2999
   * photograph run through this exact pipeline:
   *
   *   cap 1024 q0.85 →  819x1024,  90 KB — head 164x138 px
   *   cap 2048 q0.92 → 1639x2048, 450 KB — head 328x276 px
   *
   * A customer's photo is framed head to knee at best and head to toe often, so
   * a head barely 140px tall arrives with the eyes, nostrils and lip edges
   * already dissolved into JPEG mush. No prompt can preserve an identity that
   * was thrown away before the request was sent: the model cannot read a face
   * that is not there, so it does the only thing left and invents a plausible
   * one. That is exactly the complaint.
   *
   * The old ceiling was not protecting anything. 90 KB is 1.8% of the 5 MB
   * budget on the line below; 450 KB is 8.8%. Four times the facial detail
   * costs seven percent of a budget nothing was close to spending.
   */
  const MAX_IMAGE_DIMENSION = 2048;
  const IMAGE_QUALITY = 0.92;
  // Step-downs for the rare photo that still will not fit: quality first, since
  // dropping resolution is what costs identity. Only if every quality step is
  // exhausted does the long edge come down.
  const IMAGE_QUALITY_STEPS = [0.92, 0.86, 0.8];
  const IMAGE_DIMENSION_STEPS = [2048, 1600, 1280];
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  // Recent-looks strip. Fewer than GALLERY_MIN usable images and the strip is
  // not shown at all — three cards drifting past reads as a bug, not a gallery.
  const GALLERY_VISIBLE = 10;
  const GALLERY_MIN = 4;
  // The strip is decoration on a loading screen. If the pool of real looks is
  // slow to answer, the seeded assets are a perfectly good answer already.
  const GALLERY_FETCH_TIMEOUT_MS = 4000;
  // Per-image, not for the whole batch: one stalled thumbnail must not be able
  // to hold the other nine hostage.
  const GALLERY_PROBE_TIMEOUT_MS = 2500;
  // Sits just under the function's --timeout (240s) so a slow generation
  // surfaces the server's real error instead of a client-side abort. Raised from
  // 120s with the backend budget: the rewritten prompt measured up to 79s for a
  // back view, and front+back run in parallel, so 120s was aborting real work
  // that was still going to succeed. Keep in step with VTO_BUDGET_MS (210s),
  // VTO_CALL_TIMEOUT_MS (150s) and deploy.sh --timeout.
  const REQUEST_TIMEOUT_MS = 230000;
  // Upper bound of the "usually 20–45s" estimate printed in vto-modal.liquid.
  // Past it the sheet stops repeating an estimate it has already missed.
  const ELAPSED_ESTIMATE_MAX_S = 45;
  const STEP_TIMINGS = [0, 9000, 22000]; // paced hints; step 3 will hold until response
  const HISTORY_KEY = 'vto_history_v1';
  const PERSON_KEY = 'vto_person_v1';
  const HISTORY_MAX = 5;
  const DEBUG = /[?&]vto-debug=1/.test(location.search);

  const LOADING_HINTS = [
    "Analyzing body shape & proportions…",
    "Calibrating lighting and shadow directions…",
    "Measuring product shoulders and seams…",
    "Draping fabric texture over posture…",
    "Refining realistic neckline alignment…",
    "Perfecting cloth folds and drape…",
    "Optimizing rendering contrast and detail…",
    "Finalizing your virtual style representation…"
  ];

  // Dynamic HEIC worker code stringified
  const HEIC_WORKER_CODE = `
    self.onmessage = async function(e) {
      const { file } = e.data;
      try {
        self.importScripts('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
        if (typeof heic2any !== 'function') {
          throw new Error('heic2any library failed to load in Web Worker');
        }
        let result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
        if (Array.isArray(result)) {
          result = result[0];
        }
        self.postMessage({ success: true, blob: result });
      } catch (err) {
        self.postMessage({ success: false, error: err.message || err.toString() });
      }
    };
  `;

  // RFC4122-compliant client-side UUID generator for GPU idempotency
  function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Tiny helpers
  function $ (scope, sel) { return scope.querySelector(sel); }
  function $$ (scope, sel) { return Array.from(scope.querySelectorAll(sel)); }

  // Result images used to always be PNG. The backend now returns WebP by
  // default (~10x smaller, which matters because results live in IndexedDB),
  // and reports the type as `mimeType`. Anything persisted before that change
  // has no mime recorded, so PNG stays the fallback.
  const DEFAULT_RESULT_MIME = 'image/png';

  function toDataUrl(base64, mime) {
    if (!base64) return '';
    if (/^data:/.test(base64)) return base64;
    return 'data:' + (mime || DEFAULT_RESULT_MIME) + ';base64,' + base64;
  }



  function dataUrlToBlob(dataUrl) {
    return fetch(dataUrl).then((r) => r.blob());
  }

  function friendlyError(err) {
    if (!err) return 'Something went wrong. Please try again.';
    if (err.name === 'AbortError')  return 'Request took too long. Please try again.';
    if (err.status === 429)         return err.message || 'Too many try-ons. Please take a break and try again later.';
    if (err.status === 503)         return 'The AI model is busy right now. Please try again in a moment.';
    if (err.status === 422)         return err.message || 'This photo could not be processed. Try a different one.';
    if (err.status === 403)         return "We can't process this request from here. Please refresh and try again.";
    if (err.status === 400)         return err.message || 'The photo could not be processed. Try a different one.';
    if (err.status >= 500)          return 'The try-on service is having trouble. Please try again in a moment.';
    if (/NetworkError|Failed to fetch/i.test(err.message || '')) return 'No connection. Please check your internet and try again.';
    return err.message || 'Something went wrong. Please try again.';
  }

  // ── Consent and body answers ───────────────────────────────────────────
  //
  // Both are asked once and reused across every product, so they live in
  // localStorage rather than the per-tab session store. Every access is wrapped:
  // Safari in private mode throws on localStorage, and a throw here would take
  // the whole modal down for the sake of a remembered checkbox.
  const CONSENT_KEY = 'vto_consent_v1';
  const FIT_KEY = 'vto_fit_v1';

  function readConsent() {
    try { return localStorage.getItem(CONSENT_KEY) === 'yes'; } catch { return false; }
  }
  function writeConsent(agreed) {
    try { localStorage.setItem(CONSENT_KEY, agreed ? 'yes' : 'no'); } catch { /* not fatal */ }
  }

  // Range-checked on the way out as well as in: a value that has been sitting in
  // a browser since a previous version of this code is not to be trusted any
  // more than one off the wire.
  function readFitAnswers() {
    try {
      const raw = JSON.parse(localStorage.getItem(FIT_KEY) || 'null');
      if (!raw) return null;
      const h = Number(raw.heightCm), w = Number(raw.weightKg), b = Number(raw.buildIndex);
      if (!(h >= 140 && h <= 210) || !(w >= 35 && w <= 150) || !(b >= 0 && b <= 9)) return null;
      return { heightCm: h, weightKg: w, buildIndex: b };
    } catch { return null; }
  }
  function writeFitAnswers(a) {
    try { localStorage.setItem(FIT_KEY, JSON.stringify(a)); } catch { /* not fatal */ }
  }

  // ── The one-time attention glow ────────────────────────────────────────
  //
  // The try-on is the least discoverable thing on a product page: a small pill
  // in a corner, competing with a photograph. The glow points at it once.
  //
  // "Once" is doing real work here, and it is worth being precise about which
  // once, because the two obvious readings are both wrong on their own. Firing
  // on every product page forever turns a notifier into a nag across a
  // 92-product catalogue. Firing exactly once in a shopper's life means anyone
  // who lands mid-scroll, or on a page that had not finished settling, never
  // learns the feature exists at all.
  //
  // So: one bloom per product page, at most HINT_MAX_SHOWS times in total, and
  // never again once the shopper has opened the try-on even once. A notifier's
  // whole job is to tell you about something you do not know about yet; the
  // moment they open it, they know.
  const HINT_KEY = 'vto_hint_v1';
  const HINT_MAX_SHOWS = 3;
  // 0.7s delay + 1.9s animation, with slack. Only used to take the attribute
  // back off the element — see maybeShowHint().
  const HINT_LIFETIME_MS = 3000;

  function readHintState() {
    try {
      const raw = JSON.parse(localStorage.getItem(HINT_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return { shows: 0, done: false };
      // Range-checked on the way out, like every other stored value here: a
      // number that has been sitting in a browser since a previous version of
      // this code is not to be trusted more than one off the wire.
      const shows = Number(raw.shows);
      return { shows: shows >= 0 && shows < 1e4 ? Math.floor(shows) : 0, done: raw.done === true };
    } catch { return { shows: 0, done: false }; }
  }
  function writeHintState(s) {
    try { localStorage.setItem(HINT_KEY, JSON.stringify(s)); } catch { /* not fatal */ }
  }

  function feetInches(cm) {
    const total = Math.round(Number(cm) / 2.54);
    const ft = Math.floor(total / 12);
    return ft + "'" + (total - ft * 12) + '"';
  }

  // The size guide owns the fit rules. If it has not loaded, or this product has
  // no solvable chart, the try-on must not invent an answer — it degrades to no
  // fit context and no verdict rather than guessing.
  function sizeEngine() {
    const sc = window.OnRepeatSizeChart;
    return sc && typeof sc.solve === 'function' ? sc : null;
  }

  // IndexedDB asynchronous wrapper (zero connection leaks & watchdog-safe)
  //
  // Every settle path here is deliberate. The previous version rejected with
  // `req.target.error`, but `req` is the IDBRequest and `target` belongs to the
  // EVENT — so `req.target` was undefined and the handler threw a TypeError
  // instead of rejecting. The promise then never settled at all, and the
  // caller's `await` hung forever: on the generation success path that froze the
  // shopper on a spinner, holding a result that had already been paid for, with
  // the unload guard still armed. A storage error has to reject.
  //
  // Transaction-level failures are handled too. Hitting the storage quota
  // usually aborts the TRANSACTION rather than erroring the request, so a
  // request-only handler misses the exact case most likely to occur.
  const VtoDb = {
    dbName: 'vto_db_v1',
    storeName: 'vto_store',
    _db: null,

    // IDBRequest exposes `.error`; the event exposes `.target.error`. Take
    // whichever is present and never return undefined, so a rejection always
    // carries something a caller can log.
    _err(req, e, fallback) {
      return (req && req.error) ||
             (e && e.target && e.target.error) ||
             new Error(fallback);
    },

    getDb() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((resolve, reject) => {
        let req;
        try {
          req = indexedDB.open(this.dbName, 1);
        } catch (err) {
          // Safari in private mode and some locked-down browsers throw here.
          reject(err);
          return;
        }
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName);
          }
        };
        req.onsuccess = () => {
          this._db = req.result;
          this._db.onversionchange = () => {
            if (this._db) {
              this._db.close();
              this._db = null;
            }
          };
          resolve(req.result);
        };
        req.onerror = (e) => reject(this._err(req, e, 'IndexedDB could not be opened'));
        // Another tab holding an old version blocks the upgrade indefinitely.
        req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
      });
    },

    // Runs one request inside a transaction and settles exactly once, whether
    // the request errors, the transaction aborts, or the store is unreachable.
    _run(mode, make, read) {
      return this.getDb().then((db) => new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

        let tx, req;
        try {
          tx = db.transaction(this.storeName, mode);
          req = make(tx.objectStore(this.storeName));
        } catch (err) {
          done(reject, err);
          return;
        }

        req.onsuccess = () => done(resolve, read ? req.result : undefined);
        req.onerror = (e) => {
          // Stop the error reaching the transaction and aborting it twice over.
          if (e && e.preventDefault) e.preventDefault();
          done(reject, this._err(req, e, 'IndexedDB request failed'));
        };
        // A quota failure usually lands here rather than on the request.
        tx.onabort = (e) => done(reject, this._err(tx, e, 'IndexedDB transaction aborted'));
        tx.onerror = (e) => done(reject, this._err(tx, e, 'IndexedDB transaction failed'));
      }));
    },

    // Reads are advisory: a missing or unreadable store means "nothing saved".
    async get(key) {
      try {
        return await this._run('readonly', (store) => store.get(key), true);
      } catch (err) {
        console.warn('[vto-db] get failed:', err && err.message);
        return null;
      }
    },

    // Writes RESOLVE to true/false and never reject.
    //
    // Rejecting would be the tidier contract, but these are awaited from a
    // dozen places written on the assumption that storage cannot fail — the
    // generation success path, the upload handler, the cancel path — and in
    // several of them a thrown storage error would surface to the shopper as an
    // unrelated failure, or abort a generation over a cache write. A boolean
    // puts the decision with the one caller that actually has a recovery to
    // run: persistResult().
    async set(key, val) {
      try {
        await this._run('readwrite', (store) => store.put(val, key), false);
        return true;
      } catch (err) {
        console.warn('[vto-db] set failed:', key, err && err.message);
        return false;
      }
    },

    async remove(key) {
      try {
        await this._run('readwrite', (store) => store.delete(key), false);
        return true;
      } catch (err) {
        console.warn('[vto-db] remove failed:', key, err && err.message);
        return false;
      }
    }
  };

  // ─── Component: VTO Camera Controller ─────────────────────────────────
  class VtoCamera {
    constructor(vto) {
      this.vto = vto;
      this.stream = null;
      this.elements = null;
      this.facingMode = 'user';
    }

    async open() {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.vto.showError('Camera is not available on this device.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: this.facingMode, width: { ideal: 1280 }, height: { ideal: 1280 } },
        });
        this.stream = stream;

        if (this.vto.dropzone)    this.vto.dropzone.hidden    = true;
        if (this.vto.preview)     this.vto.preview.hidden     = true;
        if (this.vto.recentWrap)  this.vto.recentWrap.hidden  = true;

        const container = document.createElement('div');
        container.className = 'vto-camera-container';

        const video = document.createElement('video');
        video.autoplay    = true;
        video.playsInline = true;
        video.muted       = true;
        video.srcObject   = stream;
        // A selfie preview has to behave like a mirror: raise your right hand
        // and it must move on the right of the screen. The raw camera feed is
        // the opposite of that — it shows you as others see you — which makes
        // every framing correction go the wrong way. Every phone camera app
        // mirrors this preview, so not mirroring it reads as broken.
        //
        // The REAR camera must not be flipped: it is already showing the world
        // the right way round, and mirroring it would reverse any text in shot.
        video.classList.toggle('is-mirrored', this.facingMode === 'user');
        container.appendChild(video);

        // Flip camera button (only if multiple cameras available)
        const flipBtn = document.createElement('button');
        flipBtn.type = 'button';
        flipBtn.className = 'vto-camera-flip';
        flipBtn.setAttribute('aria-label', 'Flip camera');
        flipBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
        flipBtn.addEventListener('click', () => {
          this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
          this.stop();
          this.open();
        });
        container.appendChild(flipBtn);

        const actions = document.createElement('div');
        actions.className = 'vto-camera-actions';

        const captureBtn = document.createElement('button');
        captureBtn.type = 'button';
        captureBtn.className = 'vto-btn-primary';
        captureBtn.textContent = 'Capture Photo';
        captureBtn.addEventListener('click', () => this.capture(video));

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'vto-btn-ghost';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
          this.stop();
          this.vto.showUploadArea();
        });

        actions.appendChild(captureBtn);
        actions.appendChild(cancelBtn);

        const screen = this.vto.screens.upload;
        screen.appendChild(container);
        screen.appendChild(actions);

        this.elements = [container, actions];
      } catch (err) {
        console.error('[vto] camera:', err);
        this.vto.showError('Could not access camera. Please check permissions.');
      }
    }

    capture(video) {
      const scale = Math.min(
        MAX_IMAGE_DIMENSION / video.videoWidth,
        MAX_IMAGE_DIMENSION / video.videoHeight,
        1
      );
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(video.videoWidth  * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

      // Same quality as the upload path. A camera capture is the one photo we
      // control end to end, and it is the last place to be economical about the
      // detail the whole render depends on.
      const base64 = canvas.toDataURL('image/jpeg', IMAGE_QUALITY).split(',')[1];
      this.vto.state.personImage = base64;
      this.vto.persistPerson();
      this.vto.previewImg.src = 'data:image/jpeg;base64,' + base64;
      this.stop();
      this.vto.showPreview();
      this.vto.machine.setState(this.vto.States.PREVIEW);
      this.vto.track('vto_upload_success', { source: 'camera' });
    }

    stop() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      if (this.elements) {
        this.elements.forEach((el) => el.remove());
        this.elements = null;
      }
    }
  }

  // ─── Component: Size Chart Manager (CSS-Driven) ───────────────────────
  class VtoSizeChart {
    constructor(vto) {
      this.vto = vto;
      this.html = null;
      this.data = null;
      this.isOpen = false;
    }

    async open() {
      if (!this.vto.sizeChartSheet || !this.vto.sizeChartBody) return;

      this.vto.sizeChartSheet.hidden = false;
      void this.vto.sizeChartSheet.offsetWidth;
      this.vto.sizeChartSheet.classList.add('is-open');
      this.isOpen = true;

      // Per-product override (shirt chart for cuban shirts, t-shirt chart for tees).
      // Checked BEFORE the cached-html path so the half-inch values survive.
      const override = window.OnRepeatSizeChart && window.OnRepeatSizeChart.getChart(this.vto.productData.chartKey);
      if (override) {
        window.OnRepeatSizeChart.renderInto(this.vto.sizeChartBody, override);
        return;
      }

      if (this.html) {
        this.vto.sizeChartBody.innerHTML = this.html;
        this.wireTabs();
        return;
      }
      
      this.vto.sizeChartBody.innerHTML = '<div class="vto-sizechart__loading"><span class="vto-spinner"></span></div>';
      
      try {
        const res = await fetch('/pages/size-chart?section_id=main-page');
        if (!res.ok) throw new Error('Size chart not found');
        const html = await res.text();
        
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const content = doc.querySelector('#shopify-section-main-page .page.rte')
          || doc.querySelector('.page.rte')
          || doc.querySelector('.rte')
          || doc.body;
          
        if (!content) {
          this.vto.sizeChartBody.innerHTML = '<p class="vto-sizechart__empty">Size guide not available.</p>';
          return;
        }
        
        let sizes = null;
        let cols = ['body', 'chest', 'length', 'shoulder', 'sleeve'];
        const scriptEl = content.querySelector('script');
        if (scriptEl) {
          const text = scriptEl.textContent;
          const sizesMatch = text.match(/var\s+scSizes\s*=\s*(\[[\s\S]*?\])\s*;/);
          if (sizesMatch) {
            try {
              const jsonish = sizesMatch[1]
                .replace(/'/g, '"')
                .replace(/(\b\w+)\s*:/g, '"$1":')
                .replace(/,(\s*[\]}])/g, '$1');
              sizes = JSON.parse(jsonish);
            } catch (e) {
              console.warn('[vto-sizechart] could not parse scSizes', e);
            }
          }
          const colsMatch = text.match(/var\s+scCols\s*=\s*\[([^\]]*)\]/);
          if (colsMatch) {
            cols = colsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
          }
          scriptEl.remove();
        }
        
        if (sizes) {
          sizes.forEach((row) => {
            if (row.chest != null) {
              const num = Number(row.chest);
              if (!isNaN(num)) {
                row.chest = Math.round(num);
              }
            }
          });
        }
        cols = cols.filter((c) => c !== 'body');
        content.querySelectorAll('th').forEach((th) => {
          const text = (th.textContent || '').trim().toLowerCase();
          if (text.includes('body')) {
            th.remove();
          }
        });
        
        content.querySelectorAll('.sc-tab[onclick]').forEach((b) => b.removeAttribute('onclick'));
        
        // Build table ONCE with dual CM and INCH span representations inside cells
        const tbody = content.querySelector('tbody');
        if (tbody && sizes && sizes.length) {
          const fmtIn = (v) => {
            const num = Number(v);
            return isNaN(num) ? v : Math.round(num / 2.54);
          };
          tbody.innerHTML = sizes.map((row) => {
            const cells = cols.map((c) => {
              if (row[c] != null) {
                const num = Number(row[c]);
                const valCm = isNaN(num) ? row[c] : Math.round(num);
                const valIn = fmtIn(row[c]);
                return `<td>
                  <span class="vto-val-cm">${valCm}</span>
                  <span class="vto-val-in">${valIn}</span>
                </td>`;
              }
              return '<td></td>';
            }).join('');
            return '<tr><td><span class="sc-badge">' + (row.size || '') + '</span></td>' + cells + '</tr>';
          }).join('');
        }

        const cleanHtml = content.innerHTML.trim();
        if (cleanHtml.length < 20) {
          this.vto.sizeChartBody.innerHTML = '<p class="vto-sizechart__empty">Size guide not available.</p>';
          return;
        }
        
        this.html = cleanHtml;
        this.data = { sizes, cols };
        this.vto.sizeChartBody.innerHTML = cleanHtml;
        this.wireTabs();
        
      } catch (err) {
        console.error('[vto-sizechart] failed to load:', err);
        this.vto.sizeChartBody.innerHTML = '<p class="vto-sizechart__empty">Could not load size guide.</p>';
      }
    }

    close() {
      if (!this.vto.sizeChartSheet) return;
      this.vto.sizeChartSheet.classList.remove('is-open');
      this.isOpen = false;
      setTimeout(() => {
        if (!this.isOpen && this.vto.sizeChartSheet) {
          this.vto.sizeChartSheet.hidden = true;
        }
      }, 300);
    }

    wireTabs() {
      const tabs = this.vto.sizeChartBody.querySelectorAll('.sc-tab');
      if (!tabs.length) return;
      
      const tableContainer = this.vto.sizeChartBody.querySelector('.table-wrapper') || this.vto.sizeChartBody;
      
      // Reorder tabs: Inches first, Centimeters second
      const tabGroup = this.vto.sizeChartBody.querySelector('.sc-tab-group');
      if (tabGroup) {
        const tabsArr = Array.from(tabs);
        const inchTab = tabsArr.find(t => (t.textContent || '').trim().toLowerCase().includes('inch'));
        const cmTab = tabsArr.find(t => !(t.textContent || '').trim().toLowerCase().includes('inch'));
        if (inchTab && cmTab) {
          tabGroup.appendChild(inchTab);
          tabGroup.appendChild(cmTab);
        }
      }

      // Ensure Inches starts active
      let currentUnit = 'in';
      tabs.forEach((t) => {
        const text = (t.textContent || '').trim().toLowerCase();
        const isIn = text.includes('inch');
        t.classList.toggle('active', isIn);
      });
      tableContainer.classList.add('vto-unit-in');
      tableContainer.classList.remove('vto-unit-cm');

      tabs.forEach((tab) => {
        tab.addEventListener('click', (e) => {
          e.preventDefault();
          const text = (tab.textContent || '').trim().toLowerCase();
          const unit = text.includes('inch') ? 'in' : 'cm';
          if (currentUnit === unit) return;
          currentUnit = unit;
          
          tabs.forEach((t) => t.classList.remove('active'));
          tab.classList.add('active');
          
          // Pure CSS toggle
          if (unit === 'in') {
            tableContainer.classList.remove('vto-unit-cm');
            tableContainer.classList.add('vto-unit-in');
          } else {
            tableContainer.classList.remove('vto-unit-in');
            tableContainer.classList.add('vto-unit-cm');
          }
          
          // Fast unit header text replace (optional, lightweight)
          const { cols } = this.data || {};
          if (cols) {
            cols.forEach((c) => {
              const u = this.vto.sizeChartBody.querySelector('#sc-u-' + c);
              if (u) u.textContent = unit;
            });
          }
        });
      });
    }
  }

  // ─── Component: Cart Drawer Integration ────────────────────────────────
  class VtoCart {
    constructor(vto) {
      this.vto = vto;
    }

    populateVariantSelect() {
      if (!this.vto.variantSelect || !this.vto.sizePicker) return;
      const variants = this.vto.productData.variants || [];

      // If single variant or no variants, hide picker entirely
      if (variants.length <= 1) {
        this.vto.sizePicker.hidden = true;
        this.vto.variantSelect.innerHTML = '';
        if (variants[0]) {
          const opt = document.createElement('option');
          opt.value = variants[0].id;
          opt.textContent = variants[0].title || 'Default';
          this.vto.variantSelect.appendChild(opt);
        }
        return;
      }

      this.vto.sizePicker.hidden = false;
      this.vto.variantSelect.innerHTML = '';
      variants.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.id;
        const label = v.title || v.name || 'Variant';
        opt.textContent = v.available === false ? `${label} — Sold out` : label;
        if (v.available === false) opt.disabled = true;
        if (String(v.id) === String(this.vto.productData.defaultVariantId)) opt.selected = true;
        this.vto.variantSelect.appendChild(opt);
      });
    }

    onVariantChange() {
      if (!this.vto.variantSelect) return;
      this.vto.productData.defaultVariantId = this.vto.variantSelect.value;
    }

    selectSize(variantId) {
      this.vto.selectedVariantId = variantId;
      this.vto._sizeChosen = true;
      this.vto.refreshAtcLabel();
      if (this.vto.sizePills) this.vto.sizePills.classList.remove('vto-size--needed');
      this.vto.productData.defaultVariantId = this.vto.selectedVariantId;

      if (this.vto.variantSelect) {
        this.vto.variantSelect.value = this.vto.selectedVariantId;
      }
      this.syncSizeRail();
    }

    /**
     * Exactly one size may be marked on the rail, ever.
     *
     * The "recommended" dot and the checked pill are two independent pieces of
     * CSS — `li.is-recommended::after` draws a green dot, `input:checked +
     * label` fills the pill dark — and nothing kept them on the same size. A
     * shopper who had already picked a size and then ran the size guide got
     * BOTH: a dot on the suggestion and a filled pill on their own choice, two
     * sizes marked at once with no way to tell which one the buy button would
     * use.
     *
     * The fix is to stop treating the dot as a second, independent piece of
     * state. It is a decoration on the selection, so it is recomputed from the
     * selection every time the selection changes — here, and at the end of
     * whichever code path rebuilt the rail. That makes "one marked size" a
     * property of the rendering rather than something four call sites have to
     * remember to maintain.
     *
     * Deliberately NOT solved by force-selecting the recommendation instead:
     * renderVerdict() also runs on session restore and when reopening a look
     * from history, so that would silently move a shopper off a size they
     * chose on purpose — the exact thing the guard next to renderSizePills()
     * was written to prevent.
     */
    syncSizeRail() {
      const wrap = this.vto.sizePills;
      if (!wrap) return;
      const lis = Array.from(wrap.querySelectorAll('li'));
      lis.forEach((li) => li.classList.remove('is-recommended', 'is-selected'));

      const checked = wrap.querySelector('input[type="radio"]:checked');
      const checkedLi = checked ? checked.closest('li') : null;
      if (checkedLi) checkedLi.classList.add('is-selected');

      const rec = this.vto._fitResult && this.vto._fitResult.size;
      const label = checked && checked.nextElementSibling;
      const shown = label ? label.textContent.trim().toUpperCase() : '';
      // The dot still means "this is what we suggested" — it has not quietly
      // become a second way of drawing the selection. So it is shown only when
      // the selected size IS the suggestion. A shopper who overrides us gets
      // one mark, their own; the suggestion stays on record in the verdict
      // text above the rail rather than as a competing dot on the rail.
      const onSuggestion = !!rec && !!checkedLi && shown === String(rec).trim().toUpperCase();
      if (onSuggestion) checkedLi.classList.add('is-recommended');

      /* Once we have actually suggested something, the rail shows THAT SIZE
         and nothing else.
         A row of every size the piece comes in is a question, and the shopper
         has already answered it — they told us their height, weight and build,
         and the sentence directly above says which size that works out to.
         Offering five more underneath re-opens the decision at the exact
         moment we finished making it for them.
         Three conditions, all of them necessary:
           · a suggestion exists — with no fit answers there is nothing to
             collapse TO, and the rail stays a plain picker
           · the selected size IS that suggestion — otherwise collapsing would
             hide the shopper's own choice behind our advice, or worse, show
             our advice while a different size is what gets bought
           · they have not asked to see the sizes, which is sticky for the
             session: having asked once, they are not asked again. */
      const collapse = onSuggestion && lis.length > 1 && !this.vto._sizeRailExpanded;
      wrap.classList.toggle('vto-size__pills--one', collapse);
      // Also on the wrap, so the collapsed state can lay the single chip and
      // the "Change size" link out as one row. The rail and the link are
      // siblings, and only their shared parent can put them side by side.
      if (this.vto.sizePicker) this.vto.sizePicker.classList.toggle('vto-size--one', collapse);
      if (this.vto.sizeChangeBtn) this.vto.sizeChangeBtn.hidden = !collapse;
    }

    /* The way back to the full rail. Sticky on purpose — see above. */
    expandSizeRail() {
      this.vto._sizeRailExpanded = true;
      this.syncSizeRail();
      const wrap = this.vto.sizePills;
      if (!wrap) return;
      // Move focus onto the rail rather than leaving it on a button that has
      // just been hidden, which would drop it to <body>.
      const checked = wrap.querySelector('input[type="radio"]:checked')
        || wrap.querySelector('input[type="radio"]:not(:disabled)');
      if (checked && checked.nextElementSibling) checked.nextElementSibling.focus();
      this.vto.announce('All sizes shown.');
    }

    renderSizePills() {
      if (!this.vto.sizePills || !this.vto.sizePicker) return;
      const variants = this.vto.productData.variants || [];

      if (variants.length <= 1) {
        this.vto.sizePicker.hidden = true;
        this.vto.sizePills.innerHTML = '';
        this.vto.selectedVariantId = variants[0]?.id || null;
        return;
      }

      this.vto.sizePicker.hidden = false;
      this.vto.sizePills.innerHTML = '';

      const sizeIndex = this.vto.productData.sizeOptionIndex !== undefined ? this.vto.productData.sizeOptionIndex : -1;
      
      if (this.vto.sizeChartBtn) {
        this.vto.sizeChartBtn.hidden = (sizeIndex === -1);
      }

      const ul = document.createElement('ul');
      ul.className = 'swatches swatches--round-slight flex items-start flex-wrap gap-4';
      ul.style.listStyle = 'none';
      ul.style.padding = '0';
      ul.style.margin = '0';

      variants.forEach((v) => {
        const li = document.createElement('li');
        li.style.display = 'inline-block';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.id = `VtoSizePill-${v.id}`;
        radio.name = 'vto-size-choice';
        radio.value = v.id;
        radio.className = 'sr-only';
        if (v.available === false) {
          radio.classList.add('disabled');
          radio.disabled = true;
        }

        const label = document.createElement('label');
        label.setAttribute('for', radio.id);
        label.className = 'label-swatch inline-block text-sm font-medium leading-none cursor-pointer relative';
        
        let valLabel = 'Variant';
        if (sizeIndex >= 0 && v.options && v.options[sizeIndex]) {
          valLabel = v.options[sizeIndex];
        } else {
          valLabel = v.option1 || v.title || 'Variant';
        }
        label.textContent = valLabel;
        label.title = valLabel;

        // Pre-check ONLY a size the shopper actually chose.
        //
        // This used to check whichever variant matched defaultVariantId, which
        // on first open is product.selected_or_first_available_variant — the
        // first size in stock. So a shopper could try a piece on and tap Add to
        // bag having never touched the size rail, and be sent a size chosen for
        // them. The product page deliberately leaves size unselected on load
        // (see the inline script in product-variant-picker.liquid); the modal
        // was quietly undoing that decision, and an exchange is the shopper's
        // problem to discover.
        //
        // _sizeChosen is set by selectSize() and survives a resume, so coming
        // back to a generation still shows the size they picked.
        if (this.vto._sizeChosen && String(v.id) === String(this.vto.productData.defaultVariantId)) {
          radio.checked = true;
          this.vto.selectedVariantId = v.id;
        }

        li.appendChild(radio);
        li.appendChild(label);
        ul.appendChild(li);
      });

      this.vto.sizePills.appendChild(ul);
      // The rail was just rebuilt from scratch, which wipes every mark. This
      // is the only writer of the rail, and several paths reach it without
      // going on to render a verdict — reopening the modal, resuming a session
      // — so without this the rail comes back with nothing marked at all.
      this.syncSizeRail();
    }

    async addToCart() {
      if (!this.vto.atcBtn) return;
      // No fallback to defaultVariantId. If the shopper has not picked, say so
      // rather than adding a size for them. renderSizePills() sets this itself
      // when the product has only one variant, so a single-size piece still
      // adds in one tap.
      const variantId = this.vto.selectedVariantId;
      if (!variantId) {
        this.vto.showToast('Choose a size first.', { error: true });
        // A toast alone is easy to miss on a phone, and the rail may be below
        // the fold — put it on screen and in the keyboard path.
        if (this.vto.sizePills) {
          this.vto.sizePills.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          // Not :focus-visible — a script-driven focus() after a tap does not
          // match it, so a rule keyed on that would leave the shopper looking
          // at an unchanged screen. An explicit class says "this is what I am
          // waiting for" whatever the input was, and selectSize() clears it.
          this.vto.sizePills.classList.add('vto-size--needed');
          const first = this.vto.sizePills.querySelector('input[type="radio"]:not(:disabled)');
          if (first) first.focus();
        }
        this.vto.announce('Choose a size before adding to your bag.');
        return;
      }

      // theme.routes.cart_add_url is "/cart/add" — no ".js" — so the '/cart/add.js'
      // fallback below never applied. Posting there WITHOUT an Accept header makes
      // Shopify answer with the cart PAGE (text/html), the item is added, and then
      // res.json() throws on "<!doctype html>". Chrome words that "Unexpected token
      // '<'"; Safari words the same failure "The string did not match the expected
      // pattern", which is what shoppers were seeing. Accept: application/javascript
      // is what makes Shopify return JSON — the theme's own product form relies on
      // exactly this (theme.js:4979, product-bundle.js:58).
      const addUrl = (window.theme && window.theme.routes && window.theme.routes.cart_add_url) || '/cart/add.js';
      const addConfig = window.theme && window.theme.utils && window.theme.utils.fetchConfig
        ? window.theme.utils.fetchConfig('javascript')
        : { method: 'POST', headers: { 'Accept': 'application/javascript' } };
      addConfig.method = 'POST';
      addConfig.headers = addConfig.headers || {};
      addConfig.headers['X-Requested-With'] = 'XMLHttpRequest';
      // FormData must set its own multipart boundary.
      delete addConfig.headers['Content-Type'];

      this.vto.atcBtn.disabled = true;
      this.vto.atcBtn.setAttribute('aria-busy', 'true');
      if (this.vto.atcLabel) this.vto.atcLabel.textContent = 'Adding…';

      try {
        let sectionsToBundle = [];
        document.documentElement.dispatchEvent(new CustomEvent('cart:bundled-sections', { bubbles: true, detail: { sections: sectionsToBundle } }));

        const formData = new FormData();
        formData.append('id', variantId);
        formData.append('quantity', 1);
        formData.append('sections', sectionsToBundle.join(','));
        formData.append('sections_url', window.location.pathname);

        const res = await fetch(addUrl, { ...addConfig, body: formData });
        
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.description || err.message || 'Could not add to cart.');
        }

        const parsedState = await res.json();
        
        if (parsedState.status) {
          throw new Error(parsedState.description || parsedState.message || 'Could not add to cart.');
        }

        this.vto.track('vto_add_to_cart', {
          product_id: this.vto.productData.id,
          variant_id: variantId,
          source: 'vto_modal',
        });

        // Update theme cart state
        const cartUrl = (window.theme && window.theme.routes && window.theme.routes.cart_url) || '/cart.js';
        const cartConfig = window.theme && window.theme.utils && window.theme.utils.fetchConfig
          ? window.theme.utils.fetchConfig('json', 'GET')
          : { headers: { 'Accept': 'application/json' } };
        
        const cartJson = await (await fetch(cartUrl, cartConfig)).json();
        cartJson['sections'] = parsedState['sections'];

        if (window.theme && window.theme.pubsub) {
          window.theme.pubsub.publish(window.theme.pubsub.PUB_SUB_EVENTS.cartUpdate, {
            source: 'product-form',
            productVariantId: variantId,
            cart: cartJson
          });
        }

        document.dispatchEvent(new CustomEvent('ajaxProduct:added', {
          detail: {
            product: parsedState
          }
        }));

        this.vto.close();

        // Slide out cart drawer instantly
        const cartDrawer = document.querySelector('cart-drawer');
        if (cartDrawer) {
          cartDrawer.show();
        } else {
          document.dispatchEvent(new CustomEvent('cart:refresh', { detail: { open: true } }));
        }

      } catch (err) {
        console.error('[vto] atc error:', err);
        // Never surface a raw exception to a shopper. "The string did not match
        // the expected pattern" meant nothing to anyone; the real message is in
        // the console line above for us.
        this.vto.showToast('Could not add to cart. Please try again.', { error: true });
      } finally {
        this.vto.atcBtn.disabled = false;
        this.vto.atcBtn.removeAttribute('aria-busy');
        this.vto.refreshAtcLabel();
      }
    }
  }

  // ─── Main Controller: Virtual Try-On ──────────────────────────────────
  class VirtualTryOn {
    constructor() {
      this.modal = document.getElementById('VtoModal');
      if (!this.modal) return;

      this.storage = null;
      this.machine = new window.VtoStateMachine({
        onTransition: (next, prev, payload) => this.onStateChange(next, prev, payload),
      });
      this.States = window.VtoStates;

      this.state = {
        personImage: null,     // base64 jpeg
        frontImage: null,      // base64 result (mime in state.resultMime)
        backImage: null,       // base64 result (null if no back)
        resultMime: DEFAULT_RESULT_MIME,
        currentView: 'front',
        generating: false,
      };

      this.productData = {};
      this._stepTimers = [];
      this._currentController = null;
      this._previousFocus = null;
      this._modalOpenAt = 0;
      this._generateStartAt = 0;
      this._dragStartY = null;
      this._cancelIntent = false;
      this._abortInProgress = false;
      this._fetchLoopActive = false; // single-flight guard on runGenerationFetch
      this._minimized = false;       // modal collapsed to the floating pill
      this._elapsedTimer = null;     // 1s interval driving the elapsed counters
      this._beforeUnload = null;     // beforeunload guard while minimized + generating
      this.selectedVariantId = null; // currently chosen size pill → variant id
      this._sizeChosen = false;      // true only once the shopper picks one themselves

      // Consent and body answers both outlive a single try-on: they are asked
      // once and reused for every product. localStorage rather than the session
      // store, which is cleared per tab.
      this._consented = readConsent();
      this._fitAnswers = readFitAnswers();   // { heightCm, weightKg, buildIndex } | null
      this._fitStep = 1;
      this._fitResult = null;                // last OnRepeatSizeChart.solve() output
      this._rating = null;
      this.generationIdForFeedback = '';

      // Advanced persistence details
      this.generationId = '';        // UUID for GPU request idempotency
      this.isOffline = !navigator.onLine;
      this._offlineStartAt = null;
      this._originalLoadingTitle = '';
      this._originalLoadingHint = '';
      this._lookSeen = false;
      this._unloading = false;
      this._timeoutTriggered = false;

      // Initialize helper sub-controllers
      this.camera = new VtoCamera(this);
      this.sizeChart = new VtoSizeChart(this);
      this.cart = new VtoCart(this);

      this.cacheElements();
      this.bindEvents();
      this.restoreFromStorage();
      // After restoreFromStorage, never before: it settles any session carried
      // in from another page synchronously, and the hint must not fire onto a
      // pill that is already wearing one.
      this.maybeShowHint();

      if (DEBUG) {
        window.__vto = this;
        console.log('[vto] debug mode; instance at window.__vto');
        this.installHintMutationProbe();
      }
    }

    /**
     * Diagnostic for the garbled loading-hint text. Every write we make is a
     * full-replacement `textContent =`, which cannot composite two strings, and
     * the reported garble contained a glyph belonging to no LOADING_HINTS entry
     * — so the cause is either a foreign mutator or a WebKit paint artifact.
     * This tells the two apart: if the node ever gains a second child, a wrapper
     * element, or a mutation with a stack outside vto.js, it is a foreign
     * mutator. If it stays single-text-node throughout while the screen shows
     * garble, it is a paint artifact. Debug builds only (?vto-debug=1).
     */
    installHintMutationProbe() {
      const el = this.loadingHintEl;
      if (!el || typeof MutationObserver === 'undefined') return;
      new MutationObserver((records) => {
        for (const r of records) {
          console.warn('[vto-hint]', {
            type: r.type,
            childNodes: el.childNodes.length,
            html: el.innerHTML.slice(0, 120),
            oldValue: r.oldValue,
            added: Array.from(r.addedNodes).map((n) => n.nodeName),
            stack: new Error().stack,
          });
        }
      }).observe(el, { childList: true, characterData: true, subtree: true, characterDataOldValue: true });
      console.log('[vto] hint mutation probe installed');
    }

    // Element lookup
    cacheElements() {
      const m = this.modal;
      this.container      = $(m, '.vto-modal__container');
      this.closeButtons   = $$(m, '[data-vto-close]');
      this.screens = {
        upload:  $(m, '[data-vto-screen="upload"]'),
        fitconfirm: $(m, '[data-vto-screen="fitconfirm"]'),
        fit:     $(m, '[data-vto-screen="fit"]'),
        loading: $(m, '[data-vto-screen="loading"]'),
        results: $(m, '[data-vto-screen="results"]'),
        error:   $(m, '[data-vto-screen="error"]'),
      };
      this.gallery        = $(m, '[data-vto-gallery]');
      this.galleryTrack   = $(m, '[data-vto-gallery-track]');
      this.gallerySrc     = $(m, '[data-vto-gallery-src]');

      this.dropzone       = $(m, '[data-vto-dropzone]');
      this.fileInput      = $(m, '[data-vto-file-input]');
      this.uploadBtn      = $(m, '.vto-upload-btn');
      this.cameraBtn      = $(m, '[data-vto-camera]');
      this.recentWrap     = $(m, '[data-vto-recent]');
      this.recentList     = $(m, '[data-vto-recent-list]');

      this.preview        = $(m, '[data-vto-preview]');
      this.previewImg     = $(m, '[data-vto-preview-img]');
      this.changePhotoBtns = $$(m, '[data-vto-change-photo]');
      this.generateBtn    = $(m, '[data-vto-generate]');

      this.loadingSteps   = $$(m, '[data-vto-step]');
      this.cancelBtn      = $(m, '[data-vto-cancel]');

      this.resultWrap     = $(m, '[data-vto-result-wrap]');
      this.resultImg      = $(m, '[data-vto-result-img]');
      this.tabs           = $$(m, '[data-vto-tab]');
      this.tabIndicator   = $(m, '.vto-tabs__indicator');
      this.backTab        = $(m, '[data-vto-back-tab]');

      this.buyBar         = $(m, '[data-vto-buy-bar]');
      this.variantSelect  = $(m, '[data-vto-variant-select]'); 
      this.sizePicker     = $(m, '[data-vto-size-wrap]');
      this.sizePills      = $(m, '[data-vto-size-pills]');
      this.sizeChartBtn   = $(m, '[data-vto-size-chart]');
      this.sizeChangeBtn  = $(m, '[data-vto-size-change]');
      this.sizeChartSheet = $(m, '[data-vto-sizechart]');
      this.sizeChartBody  = $(m, '[data-vto-sizechart-body]');
      this.atcBtn         = $(m, '[data-vto-atc]');
      this.atcLabel       = $(m, '[data-vto-atc-label]');

      this.shareBtn       = $(m, '[data-vto-share]');
      this.downloadBtn    = $(m, '[data-vto-download]');
      this.retryBtns      = $$(m, '[data-vto-retry]');
      this.errorMsg       = $(m, '[data-vto-error-msg]');

      this.consentBox     = $(m, '[data-vto-consent]');
      this.consentWrap    = $(m, '[data-vto-consent-wrap]');
      this.uploadLock     = $(m, '[data-vto-upload-lock]');

      this.fitScreen      = $(m, '[data-vto-screen="fit"]');
      this.fitDots        = $$(m, '[data-vto-fit-dots] i');
      this.fitSteps       = $$(m, '[data-vto-fit-step]');
      this.fitInputs      = $$(m, '[data-vto-fit-in]');
      this.fitNextBtn     = $(m, '[data-vto-fit-next]');
      this.fitBackBtn     = $(m, '[data-vto-fit-back]');
      this.fitNounEl      = $(m, '[data-vto-fit-noun]');
      this.fitKickerEl    = $(m, '[data-vto-fit-kicker]');

      this.confirmOuts    = $$(m, '[data-vto-confirm]');
      this.confirmSizeEl  = $(m, '[data-vto-confirm-size]');
      this.confirmKeepBtn = $(m, '[data-vto-confirm-keep]');
      this.confirmEditBtn = $(m, '[data-vto-confirm-edit]');

      this.verdictWrap    = $(m, '[data-vto-verdict]');
      this.verdictSize    = $(m, '[data-vto-verdict-size]');
      this.verdictTone    = $(m, '[data-vto-verdict-tone]');
      this.verdictWhy     = $(m, '[data-vto-verdict-why]');

      this.reasonWrap     = $(m, '[data-vto-reason]');
      this.reasonBtns     = $$(m, '[data-vto-reason-btn]');
      this.thanksEl       = $(m, '[data-vto-feedback-thanks]');

      this.dragHandle     = $(m, '[data-vto-drag-handle]');
      this.toast          = $(m, '[data-vto-toast]');
      this.toastMsg       = $(m, '[data-vto-toast-msg]');
      this.toastLink      = $(m, '[data-vto-toast-link]');

      this.feedbackBtns   = $$(m, '[data-vto-feedback-btn]');
      this.feedbackWrap   = $(m, '[data-vto-feedback]');

      // Loading screen extras
      this.minimizeBtn    = $(m, '[data-vto-minimize]');
      this.elapsedEl      = $(m, '[data-vto-elapsed]');
      this.elapsedNoteEl  = $(m, '[data-vto-elapsed-note]');
      this.loadingTitleEl = $(m, '[data-vto-loading-title]');
      this.loadingHintEl  = $(m, '[data-vto-loading-hint]');

      this.modalTitleEl   = $(m, '.vto-modal__title');
      this.backBtn        = $(m, '[data-vto-back]');
      this.tipsEl         = $(m, '[data-vto-tips]');

      // The live region is a SIBLING of the modal, not a child: minimize()
      // hides the modal, and a hidden subtree is out of the accessibility tree,
      // so an announcer inside it goes silent exactly when it is needed most.
      this.announcer      = document.querySelector('[data-vto-announce]');
    }

    // Event binding
    bindEvents() {
      // Open triggers (delegated via data attribute query for dynamic markup support)
      document.addEventListener('click', (e) => {
        const triggerBtn = e.target.closest('[data-vto-trigger]');
        if (triggerBtn) {
          e.preventDefault();
          this.open(triggerBtn);
        }
      });

      // Tactile back button routing
      if (this.backBtn) {
        this.backBtn.addEventListener('click', () => {
          if (this.state.personImage) {
            this.machine.setState(this.States.PREVIEW);
            this.showScreen('upload');
            this.showPreview();
          } else {
            this.machine.setState(this.States.IDLE);
            this.showScreen('upload');
            this.showUploadArea();
          }
        });
      }

      // Close — during generation this minimises (keeps the request alive)
      // instead of cancelling; otherwise it closes as usual.
      this.closeButtons.forEach((el) => {
        el.addEventListener('click', () => this.dismiss());
      });

      // Escape (theme.a11y.trapFocus handles Tab cycling)
      document.addEventListener('keydown', (e) => {
        if (!this.modal.classList.contains('vto-modal--open')) return;
        if (e.key !== 'Escape') return;
        // Size chart takes precedence — close it before the modal.
        if (this.sizeChart.isOpen) this.sizeChart.close();
        else this.dismiss();
      });

      // Minimize ("Keep browsing") — fold the modal down into the buy bar tile.
      if (this.minimizeBtn) {
        this.minimizeBtn.addEventListener('click', () => this.minimize());
      }

      // Cancel and Retry live on the modal's loading and error screens, and
      // only there (bound below with the rest of the screen controls). They
      // used to be duplicated on the floating pill; with the pill gone the
      // minimised tile always leads back here rather than trying to be a
      // control in its own right.

      // The buy bar tile is the minimised session's only home, so it has to
      // survive the page moving underneath it — a sticky bar that scrolls out
      // of view, an orientation change, a bfcache restore.
      window.addEventListener('pageshow', () => {
        if (this._tileState) this.setTileState(this._tileState);
      });

      // File input
      if (this.uploadBtn) {
        this.uploadBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.fileInput.click();
        });
      }
      if (this.fileInput) {
        this.fileInput.addEventListener('change', (e) => {
          if (e.target.files[0]) this.handleFileSelect(e.target.files[0]);
        });
      }

      // Dropzone (click, drag, drop)
      if (this.dropzone) {
        this.dropzone.addEventListener('click', (e) => {
          if (!this._consented) { e.preventDefault(); this.nudgeConsent(); return; }
          if (!e.target.closest('button')) this.fileInput.click();
        });
        this.dropzone.addEventListener('dragover', (e) => {
          e.preventDefault();
          this.dropzone.classList.add('drag-over');
        });
        this.dropzone.addEventListener('dragleave', () => {
          this.dropzone.classList.remove('drag-over');
        });
        this.dropzone.addEventListener('drop', (e) => {
          e.preventDefault();
          this.dropzone.classList.remove('drag-over');
          if (e.dataTransfer.files[0]) this.handleFileSelect(e.dataTransfer.files[0]);
        });
      }

      // Camera
      if (this.cameraBtn) {
        this.cameraBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.camera.open();
        });
      }

      // Change photo
      this.changePhotoBtns.forEach((btn) => {
        btn.addEventListener('click', () => this.resetToUpload({ clearPerson: true }));
      });

      // Generate
      if (this.generateBtn) {
        this.generateBtn.addEventListener('click', () => {
          // The questions come BEFORE the request, which is what lets the model
          // cut the garment to this body.
          //
          // Stored answers used to skip straight past this, silently, forever.
          // That is wrong in both directions: a body that has changed could not
          // be corrected without clearing site data, and a shopper trying
          // something on for someone else was quietly handed their own numbers.
          // Every try-on now surfaces them and offers the choice — one tap to
          // keep, one to change.
          if (!this.canAskFit()) this.generate();
          else if (!this._fitAnswers) this.openFitStep();
          else this.openFitConfirm();
        });
      }

      // Cancel loading
      if (this.cancelBtn) {
        this.cancelBtn.addEventListener('click', () => this.cancelGenerate());
      }

      // Tabs
      this.tabs.forEach((tab) => {
        tab.addEventListener('click', () => this.switchTab(tab.dataset.vtoTab));
      });

      // Size pills change delegation (replaces click delegation)
      if (this.sizePills) {
        this.sizePills.addEventListener('change', (e) => {
          const radio = e.target.closest('input[name="vto-size-choice"]');
          if (radio) this.cart.selectSize(radio.value);
        });
      }

      // Size chart open/close
      if (this.sizeChartBtn) {
        this.sizeChartBtn.addEventListener('click', () => this.sizeChart.open());
      }
      if (this.sizeChangeBtn) {
        this.sizeChangeBtn.addEventListener('click', () => this.cart.expandSizeRail());
      }
      if (this.sizeChartSheet) {
        $$(this.sizeChartSheet, '[data-vto-sizechart-close]').forEach((el) => {
          el.addEventListener('click', () => this.sizeChart.close());
        });
      }

      // Add to cart
      if (this.atcBtn) {
        this.atcBtn.addEventListener('click', () => this.cart.addToCart());
      }

      // Share
      if (this.shareBtn) {
        this.shareBtn.addEventListener('click', () => this.share());
      }

      // Download
      if (this.downloadBtn) {
        this.downloadBtn.addEventListener('click', () => this.download());
      }

      // Retry (both error + results "New")
      // ── Consent gate ────────────────────────────────────────────────────
      if (this.consentBox) {
        this.consentBox.checked = this._consented;
        this.consentBox.addEventListener('change', () => {
          this._consented = this.consentBox.checked;
          writeConsent(this._consented);
          this.applyConsentGate();
          this.track(this._consented ? 'vto_consent_given' : 'vto_consent_withdrawn');
        });
      }
      this.applyConsentGate();

      // ── Fit step ────────────────────────────────────────────────────────
      this.fitInputs.forEach((input) => {
        input.addEventListener('input', () => this.onFitInput(input));
      });
      if (this.fitNextBtn) this.fitNextBtn.addEventListener('click', () => this.fitNext());
      if (this.fitBackBtn) this.fitBackBtn.addEventListener('click', () => this.fitBack());

      // ── Confirm saved measurements ──────────────────────────────────────
      if (this.confirmKeepBtn) {
        this.confirmKeepBtn.addEventListener('click', () => {
          this.track('vto_fit_reused', this._fitAnswers || {});
          this.generate();
        });
      }
      if (this.confirmEditBtn) {
        this.confirmEditBtn.addEventListener('click', () => {
          this._fitFrom = 'confirm';
          this.openFitStep();
        });
      }

      // ── Rating reasons ──────────────────────────────────────────────────
      this.reasonBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          this.reasonBtns.forEach((b) => b.classList.toggle('is-on', b === btn));
          this.sendFeedback('down', btn.dataset.vtoReasonBtn);
          if (this.thanksEl) this.thanksEl.hidden = false;
        });
      });

      // Two buttons share [data-vto-retry] and want different things.
      //
      // The results screen's says "New": start over, keep the photo, pick again.
      // The error screen's says "Try Again", and with the silent 503 retry gone
      // it is now the entire recovery path — so it has to actually try again
      // rather than drop the shopper on the preview screen to press a second
      // button. generate() mints a fresh generationId, and that is what makes it
      // a real attempt instead of a replay of the failure the backend recorded
      // against the old one.
      this.retryBtns.forEach((btn) => {
        const isErrorScreen = !!btn.closest('[data-vto-screen="error"]');
        btn.addEventListener('click', () => {
          if (isErrorScreen && this.state.personImage && !this.state.generating) {
            this.generate();
          } else {
            this.resetToUpload({ clearPerson: false });
          }
        });
      });

      // Feedback thumbs
      this.feedbackBtns.forEach((btn) => {
        btn.addEventListener('click', () => this.submitFeedback(btn.dataset.vtoFeedbackBtn));
      });

      // Mobile drag-to-close on drag handle + header
      if (this.dragHandle) this.bindDragToClose(this.dragHandle);
      const header = $(this.modal, '.vto-modal__header');
      if (header) this.bindDragToClose(header);

      // Recent try-ons delegation
      if (this.recentList) {
        this.recentList.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-vto-recent-item]');
          if (!btn) return;
          this.openHistoryItem(btn.dataset.vtoRecentItem);
        });
      }

      // Resilient connection monitors
      window.addEventListener('online', () => this.handleNetworkOnline());
      window.addEventListener('offline', () => this.handleNetworkOffline());

      // Page unload monitors to prevent aborted navigation fetches from wiping out generating states
      window.addEventListener('beforeunload', () => { this._unloading = true; });
      window.addEventListener('pagehide', () => { this._unloading = true; });

      // Back/forward restore. This theme is a multi-page app, so a swipe-back is
      // served from the bfcache: the DOM and this instance are thawed exactly as
      // they were, and neither DOMContentLoaded nor load fires again — only
      // pageshow, with persisted === true. Without this handler init() never
      // re-runs, so the pill and timer simply never come back, and _unloading
      // stays latched from the pagehide that put us here, which then swallows
      // every subsequent fetch error.
      window.addEventListener('pageshow', (event) => {
        // Clear the latch FIRST, and for every pageshow rather than only a
        // bfcache one. beforeunload/pagehide set it for navigations that never
        // happen — a tel: link, a download, a navigation the browser cancels —
        // and the only reset used to live below the persisted check, so one of
        // those left it latched for the life of the page and every later
        // generation error was swallowed by the guard in runGenerationFetch.
        this._unloading = false;
        if (!event.persisted) return;
        this.handleRestoredFromBfcache();
      });

      // Same latch, the other way back: a tab that is hidden and shown again
      // fires visibilitychange but not pageshow.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this._unloading = false;
      });
    }

    /**
     * Re-synchronise after a bfcache restore. The instance survived, but the
     * fetch that was in flight when we navigated away did not — it was aborted,
     * and the abort was deliberately swallowed to preserve the session. So the
     * job is still recorded as generating with nothing driving it.
     */
    handleRestoredFromBfcache() {
      const session = this.loadActiveSessionSync();
      if (!session || session.state !== 'generating' || !session.generationId) return;

      // Trust the persisted start time over anything left in memory.
      this._generateStartAt = session.startTime || this._generateStartAt;
      if (!this._generateStartAt) return;

      if (Date.now() - this._generateStartAt > REQUEST_TIMEOUT_MS) {
        this.machine.setState(this.States.IDLE);
        this.clearActiveSessionSync();
        this.clearTileState({ persist: false });
        return;
      }

      this.generationId = session.generationId;
      this.state.generating = true;
      this._cancelIntent = false;

      // Repaint the pill and restart the counter, then re-attach to the job.
      // Same generationId, so the backend serves the in-flight or cached result
      // rather than billing a second generation.
      this.startLoadingSteps({ resume: true });

      // Do NOT assert minimized here. A bfcache restore thaws the sheet exactly
      // as it was frozen, so a shopper who left with the loading screen open
      // comes back to it still open — and claiming minimized makes the success
      // path send the finished look to the 48px tile instead of the screen they
      // are staring at, leaving a spinner that never resolves on a generation
      // that actually succeeded. The DOM is the truth after a thaw; the
      // persisted flag (written by saveActiveSessionSync) is the fallback.
      const sheetOpen = !!(this.modal && this.modal.classList.contains('vto-modal--open'));
      this._minimized = sheetOpen ? false : session.minimized !== false;
      if (this._minimized) this.showTileState('generating');
      this.runGenerationFetch();
    }

    // Open / close
    async open(triggerBtn) {
      const productId = triggerBtn.dataset.productId || '';

      // Before the early returns below, not after: every path through this
      // method means the shopper found the try-on, which is the moment the
      // hint has done its job and stops being owed one.
      this.retireHint();

      // A tile that is currently wearing a session is a "back to my try-on"
      // control, not a "try this garment on" one — and on a page the session was
      // carried to, the two products differ, so nothing downstream would work
      // this out. Route it home before any of the product-matching logic runs.
      if (this._minimized && triggerBtn.dataset.vtoTileState) {
        // Closing the sheet should put focus back on the tile they tapped.
        this._previousFocus = triggerBtn;
        this.restoreModal();
        return;
      }

      // Load active session synchronously
      const session = this.loadActiveSessionSync();
      const isSameProduct = String(this.productData.id) === String(productId) || (session && String(session.productId) === String(productId));

      // Clear any cancel intent left over from a previous run. cancelGenerate()
      // sets this and nothing reset it, so one dismissed sheet made every later
      // generation abort itself the moment it started.
      if (!this.state.generating) this._cancelIntent = false;

      // If a generation is actively in flight for any product, restore the active loading modal and show a toast
      if (this.state.generating) {
        this.showToast('Generating your look, please wait...');
        this.restoreModal();
        return;
      }

      // If a completed/error session is minimized for the SAME product, restore it
      if (isSameProduct && this._minimized) {
        this.restoreModal();
        return;
      }

      this._previousFocus = document.activeElement;

      // Parse new product data from trigger
      let variants = [];
      try {
        variants = JSON.parse(triggerBtn.dataset.variants || '[]');
      } catch (e) { variants = []; }

      this.productData = {
        id:               productId,
        title:            triggerBtn.dataset.productTitle || '',
        chartKey:         triggerBtn.dataset.scChart || '',
        url:              triggerBtn.dataset.productUrl || '',
        frontImage:       this.ensureAbsoluteUrl(triggerBtn.dataset.frontImage || ''),
        backImage:        this.ensureAbsoluteUrl(triggerBtn.dataset.backImage  || ''),
        fitHint:          triggerBtn.dataset.fitHint || '',
        defaultVariantId: triggerBtn.dataset.defaultVariantId || '',
        sizeOptionIndex:  parseInt(triggerBtn.dataset.sizeOptionIndex, 10),
        variants,
      };

      this.cart.renderSizePills();
      this.clearTileState(); // the modal is taking over from the tile
      this._minimized = false;

      let targetScreen = 'upload';

      if (isSameProduct && session && session.state === 'results') {
        const results = await VtoDb.get('vto_active_results');
        if (results) {
          this.state.frontImage = results.frontImage;
          this.state.backImage = results.backImage || null;
          this.state.resultMime = results.mimeType || DEFAULT_RESULT_MIME;
          this.state.currentView = 'front';
          this.machine.setState(this.States.RESULTS);
          targetScreen = 'results';
        }
      } else {
        this.state.frontImage = null;
        this.state.backImage  = null;
        this.state.currentView = 'front';
        await VtoDb.remove('vto_active_results');
        
        if (this.state.personImage) {
          this.machine.setState(this.States.PREVIEW);
          targetScreen = 'preview';
        } else {
          this.machine.setState(this.States.IDLE);
          targetScreen = 'upload';
        }
      }

      // Reveal modal. A close or fold still counting down would otherwise fire
      // its fuse a moment from now and hide the sheet we are opening.
      clearTimeout(this._closeTimer);
      clearTimeout(this._foldTimer);
      this.container.classList.remove('vto-modal__container--folding');
      this.modal.classList.remove('vto-modal--folding');
      this.modal.hidden = false;
      if (window.theme?.scrollLock) {
        window.theme.scrollLock.acquire();
        this._scrollLockHeld = true;
      } else {
        document.body.style.overflow = 'hidden';
      }
      triggerBtn.setAttribute('aria-expanded', 'true');

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.modal.classList.add('vto-modal--open');
          // Defer focus trap until the entrance transition lands so the
          // first focusable element is actually visible/tabbable.
          setTimeout(() => {
            const closeBtn = $(this.modal, '.vto-modal__close');
            if (window.theme?.a11y?.trapFocus) {
              window.theme.a11y.trapFocus(this.modal, closeBtn || this.container);
            } else if (closeBtn) {
              closeBtn.focus();
            }
          }, 120);
        });
      });

      // Show appropriate screen
      if (targetScreen === 'results') {
        this.showScreen('results');
        if (this.state.frontImage) {
          this.revealResultImage(this.resultSrc(this.state.frontImage));
        }
        if (this.backTab) {
          this.backTab.hidden = !this.state.backImage;
        }
        this.updateTabs(this.state.currentView || 'front');
      } else if (targetScreen === 'preview') {
        this.showScreen('upload');
        this.showPreview();
      } else {
        this.showScreen('upload');
        this.showUploadArea();
      }

      // Defer loading history and rendering recent UI to a macro task 
      // after the entrance transition starts to prevent INP on the click interaction.
      setTimeout(() => {
        this.refreshRecentUi();
      }, 150);
      this._modalOpenAt = Date.now();
      this.track('vto_modal_open', { product_id: this.productData.id, product_title: this.productData.title });
    }

    close() {
      if (!this.modal.classList.contains('vto-modal--open')) return;

      // Only cancel something that is actually running. This used to fire
      // unconditionally, which left _cancelIntent latched true and destroyed a
      // finished result (and its pill) just because the sheet was dismissed.
      if (this.state.generating) this.cancelGenerate({ silent: true });

      // Make sure the size-chart sheet never lingers for the next open.
      this.sizeChart.close();

      this.modal.classList.remove('vto-modal--open');
      this.camera.stop();
      this.hideToast();

      // Same fuse the fold uses, and for the same reason: under
      // prefers-reduced-motion the container has `transition: none`, so
      // transitionend never fires — the modal would never be marked hidden and
      // this listener would leak, waking up later on a subsequent fold and
      // hiding the sheet in the middle of it.
      const settle = () => {
        clearTimeout(this._closeTimer);
        this.container.removeEventListener('transitionend', onEnd);
        this.modal.hidden = true;
      };
      const onEnd = (e) => { if (e.target === this.container) settle(); };
      this.container.addEventListener('transitionend', onEnd);
      clearTimeout(this._closeTimer);
      this._closeTimer = setTimeout(settle, 600);

      if (this._scrollLockHeld && window.theme?.scrollLock) {
        window.theme.scrollLock.release();
        this._scrollLockHeld = false;
      } else {
        document.body.style.overflow = '';
      }
      document.querySelectorAll('[data-vto-trigger]').forEach((btn) => {
        btn.setAttribute('aria-expanded', 'false');
      });

      // Release focus trap + restore focus to the trigger.
      if (window.theme?.a11y?.removeTrapFocus) {
        window.theme.a11y.removeTrapFocus(this._previousFocus || undefined);
      } else if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
        try { this._previousFocus.focus(); } catch { /* noop */ }
      }

      this.track('vto_modal_close', {
        product_id: this.productData.id,
        time_on_modal_ms: Date.now() - this._modalOpenAt,
      });

      // Closing a finished or failed try-on is the shopper saying they are done
      // with it. The look is still in the session and in Recent try-ons, and the
      // tile still reopens it — but it stops wearing a maroon "VIEW" ring on
      // every page for the rest of the visit. This is what the floating pill's
      // dismiss button used to do, moved to the gesture that already means it.
      if (this.machine.state === this.States.RESULTS || this.machine.state === this.States.ERROR) {
        this._lookSeen = true;
      }
      this._minimized = false;
      this.clearTileState({ persist: false });

      this.machine.setState(this.States.IDLE);
    }

    // Dismiss intent: while a generation is running, the X / overlay / Esc
    // should keep the request alive and collapse to the tile — not cancel.
    dismiss() {
      if (this.state.generating) this.minimize();
      else this.close();
    }

    // Collapse the modal onto the buy bar's tile WITHOUT cancelling generation.
    minimize() {
      if (!this.modal.classList.contains('vto-modal--open')) return;
      this._minimized = true;

      this.camera.stop();
      this.hideToast();

      // Dress the tile BEFORE folding: the sheet needs somewhere to fold into,
      // and the ring should already be lit when it lands.
      this.showTileState(this.tileStateForSession() || 'generating');

      // Releasing the lock first matters. It restores the page's scroll
      // position, and the tile's rect has to be measured on the layout the
      // shopper is about to be looking at, not the locked one.
      if (this._scrollLockHeld && window.theme?.scrollLock) {
        window.theme.scrollLock.release();
        this._scrollLockHeld = false;
      } else {
        document.body.style.overflow = '';
      }

      this.foldToTile();

      if (window.theme?.a11y?.removeTrapFocus) {
        window.theme.a11y.removeTrapFocus(this._previousFocus || undefined);
      }
      // Focus follows the sheet down. The tile is where the session now lives,
      // so it is where a keyboard user must land — otherwise focus falls back
      // to <body> and they have to Tab through the page to reach their try-on.
      const host = this.dressedTile();
      if (host && typeof host.focus === 'function') {
        try { host.focus({ preventScroll: true }); } catch { host.focus(); }
      }

      this.armUnloadGuard();
      this.announce("Still creating your look — you can keep browsing. We'll let you know when it's ready.");
      this.track('vto_minimize', { product_id: this.productData.id, has_tile: !!host });
      this.saveActiveSessionSync();
    }

    // The fold. The sheet scales and travels to the tile so the shopper sees
    // where their try-on went, instead of a panel vanishing and a ring
    // appearing somewhere else a moment later.
    //
    // Transform and opacity only — animating the sheet's box would relayout the
    // page behind it every frame. When there is no tile to fold into (a page
    // with no buy bar) the modal just leaves by its normal transition.
    foldToTile() {
      const host = this.dressedTile();
      const box = this.container.getBoundingClientRect();
      const target = host ? host.getBoundingClientRect() : null;

      // Whatever happens, the modal MUST end up hidden. transitionend is not
      // guaranteed — a transition can be interrupted, or never start at all if
      // the element is display:none by the time it would run — so the timer is
      // the authority and the event is just the fast path.
      const settle = () => {
        this.container.removeEventListener('transitionend', onEnd);
        clearTimeout(this._foldTimer);
        this.modal.hidden = true;
        this.container.classList.remove('vto-modal__container--folding');
        this.modal.classList.remove('vto-modal--folding');
        this.container.style.removeProperty('--vto-fold-x');
        this.container.style.removeProperty('--vto-fold-y');
        this.container.style.removeProperty('--vto-fold-scale');
      };
      // Keyed on transform: opacity finishes ~60ms earlier and would cut the
      // fold short. With reduced motion there is no transform transition at
      // all, and the timer below is what settles it.
      const onEnd = (e) => { if (e.target === this.container && e.propertyName === 'transform') settle(); };
      this.container.addEventListener('transitionend', onEnd);
      clearTimeout(this._foldTimer);
      this._foldTimer = setTimeout(settle, 600);

      if (target && box.width && box.height && target.width) {
        // transform-origin is the container's own top-left, so the translation
        // is a plain corner-to-corner delta with no moving anchor to correct
        // for. Scale is driven by width; the sheet is taller than it is wide,
        // so matching width keeps the fold reading as "into that square".
        this.container.style.setProperty('--vto-fold-x', (target.left - box.left) + 'px');
        this.container.style.setProperty('--vto-fold-y', (target.top - box.top) + 'px');
        this.container.style.setProperty('--vto-fold-scale', String(Math.max(target.width / box.width, 0.04)));
        this.container.classList.add('vto-modal__container--folding');
        this.modal.classList.add('vto-modal--folding');
      }

      // Removing this last: with the folding class already applied, the sheet
      // transitions from open straight to the tile rather than dropping to its
      // default closed transform first.
      this.modal.classList.remove('vto-modal--open');
    }

    // The reverse. Pins the sheet at the tile's geometry for one committed
    // frame; restoreModal() releases it in the same frame it opens, so the
    // sheet grows out of the tile. Returns false when there is nothing to grow
    // from — no tile, or a shopper who has asked for less motion — and the
    // modal opens with its ordinary entrance instead.
    /* The sheet arrives from the bottom. Every time, from every trigger.
     *
     * There used to be a startUnfold(rect) here that measured whichever tile
     * had been tapped and set an inline transform placing the sheet on top of
     * it, so a restored session appeared to grow out of that tile. It was a
     * nice idea with one control. With three — the buy bar's thumbnail, the
     * gallery pill over the hero, and the bar's own button — the same gesture
     * produced three different animations, and two of them came from the
     * middle of the screen, which is not a thing sheets do. A shopper who
     * tapped the gallery pill saw the sheet expand out of the middle of the
     * photograph; one who tapped the buy bar saw it rise; nothing about the
     * page had changed between the two.
     *
     * So the entrance is now a property of the SHEET rather than of whatever
     * opened it, and it lives entirely in CSS (.vto-modal--open, which on
     * mobile animates translateY(100%) to 0). That also means the reduced
     * motion and safe-area handling apply to every path for free, instead of
     * to every path except this one.
     *
     * Minimising still folds down into the tile, and should: that gesture is
     * answering "where did my try-on go", which is a question about a
     * specific tile. Coming back is not.
     */
    clearEntranceTransform() {
      const c = this.container;
      if (!c) return;
      c.style.removeProperty('transition');
      c.style.removeProperty('transform');
      c.style.removeProperty('transform-origin');
    }

    prefersReducedMotion() {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
      catch { return false; }
    }

    // Bring the (still-running or finished) session back into the modal.
    // Does NOT reset productData/state — only re-reveals the right screen.
    restoreModal({ to } = {}) {
      this._minimized = false;
      this.disarmUnloadGuard();
      clearTimeout(this._closeTimer);

      this.clearTileState();

      // A fold still in flight would otherwise hide the modal mid-open.
      clearTimeout(this._foldTimer);
      this.container.classList.remove('vto-modal__container--folding');
      this.modal.classList.remove('vto-modal--folding');
      // A fold that was interrupted can leave an inline transform behind, and
      // an inline transform outranks the class that drives the entrance — the
      // sheet would sit wherever the fold had got to and never travel.
      this.clearEntranceTransform();

      this.modal.hidden = false;
      if (window.theme?.scrollLock) {
        window.theme.scrollLock.acquire();
        this._scrollLockHeld = true;
      } else {
        document.body.style.overflow = 'hidden';
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.modal.classList.add('vto-modal--open');
          setTimeout(() => {
            const closeBtn = $(this.modal, '.vto-modal__close');
            if (window.theme?.a11y?.trapFocus) {
              window.theme.a11y.trapFocus(this.modal, closeBtn || this.container);
            } else if (closeBtn) {
              closeBtn.focus();
            }
          }, 120);
        });
      });

      // Pick the screen: explicit override, else mirror the current state.
      const screen = to
        || (this.state.generating ? 'loading'
          : this.machine.state === this.States.ERROR ? 'error'
          : this.machine.state === this.States.RESULTS ? 'results'
          : 'upload');
      this.showScreen(screen);

      if (screen === 'results') {
        if (this.state.frontImage) {
          this.revealResultImage(this.resultSrc(this.state.frontImage));
        }
        if (this.backTab) {
          this.backTab.hidden = !this.state.backImage;
        }
        this.updateTabs(this.state.currentView || 'front');
      }

      document.querySelectorAll('[data-vto-trigger]').forEach((btn) => {
        btn.setAttribute('aria-expanded', 'true');
      });
      this.track('vto_restore', { product_id: this.productData.id, screen });
      this.saveActiveSessionSync();
    }

    // ── The minimised try-on ───────────────────────────────────────
    //
    // The buy bar's own 48px product thumbnail IS the minimised try-on. There
    // is no floating copy: the previous build kept one as a fallback, and when
    // the fallback misfired the shopper got both at once — a live tile floating
    // over the buy bar card, on top of "Size guide", while the real thumbnail
    // sat idle showing nothing.
    //
    // Two consequences are deliberate. On a page with no buy bar nothing is
    // shown at all; the session keeps running and reappears on the next product
    // page. And the tile's only action is reopening the modal — cancel, retry
    // and the elapsed counter live on the modal's own screens.

    // The tile that should host the session right now.
    //
    // Preference, not a strict match. A tile for the product being tried on is
    // the natural host; failing that, ANY on-screen buy bar tile will do. The
    // shopper has walked from the polo to the joggers and their try-on is still
    // running — a try-on they cannot see is a try-on they think they lost.
    //
    // The old version demanded an exact data-product-id match and returned null
    // otherwise, which is what sent every carried session to the floating copy.
    hostTile() {
      const tiles = $$(document, VTO_TILE_SEL).filter((el) => {
        // getClientRects() is empty for display:none and for a tile inside a
        // collapsed container — cheaper and more honest than reading styles.
        if (!el.getClientRects().length) return false;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      });
      if (!tiles.length) return null;
      const id = this.productData && this.productData.id;
      if (id) {
        const own = tiles.find((el) => String(el.dataset.productId) === String(id));
        if (own) return own;
      }
      return tiles[0];
    }

    // The tile currently wearing the session, if any. Dressing is what makes a
    // tile the host, so this is always the same element hostTile() picked —
    // reading it back from the DOM keeps the two from drifting apart.
    dressedTile() {
      const all = this.dressedTiles();
      if (!all.length) return null;
      // Several tiles can wear the same session now (the gallery pill and the
      // buy bar both belong to the product on screen). The ones that take
      // FOCUS and the fold animation must be a tile the shopper can actually
      // see, so a visible one wins; the first is only a fallback for the case
      // where everything has scrolled away.
      return all.find((el) => el.getClientRects().length) || all[0];
    }

    /**
     * Point at the try-on pill once, if it has not been pointed at enough.
     *
     * Styling and timing live in assets/vto-gallery-pill.css; this decides only
     * whether the glow is earned. Every reason to stay quiet is a reason the
     * shopper would find it noise rather than news:
     *
     *   · no hintable placement on this page — nothing to point at
     *   · the pill is already carrying a session — it is visibly working, and
     *     a glow saying "there is a try-on here" would be telling them
     *     something they can already see
     *   · they have opened the try-on before — they know
     *   · it has been shown its full number of times — they have had their
     *     chance to notice, and past that it is a nag
     *
     * The attribute is taken back off once the animation is over. Left on, a
     * section re-render would replay the glow, which is the one thing a
     * once-only notifier must not do.
     */
    maybeShowHint() {
      const el = document.querySelector('[data-vto-hintable]');
      if (!el) return;
      if (el.dataset.vtoTileState || this._tileState) return;

      const state = readHintState();
      if (state.done || state.shows >= HINT_MAX_SHOWS) return;
      writeHintState({ shows: state.shows + 1, done: false });

      el.dataset.vtoHint = '1';
      // A timer rather than animationend: the glow is two animations on two
      // pseudo-elements, both of which report through this same element, so
      // the first to finish would cut the second off mid-bloom.
      this._hintTimer = setTimeout(() => { delete el.dataset.vtoHint; }, HINT_LIFETIME_MS);
    }

    // They have seen what it does. Called from open(), which is the only way in.
    retireHint() {
      clearTimeout(this._hintTimer);
      document.querySelectorAll('[data-vto-hint]').forEach((el) => { delete el.dataset.vtoHint; });
      const state = readHintState();
      if (!state.done) writeHintState({ shows: state.shows, done: true });
    }

    // Every tile currently wearing the session.
    dressedTiles() {
      return $$(document, VTO_TILE_SEL + '[data-vto-tile-state]');
    }

    // Is the host showing a session that belongs to a different product?
    isCarried(el) {
      const id = this.productData && this.productData.id;
      return !!(el && id && String(el.dataset.productId) !== String(id));
    }

    setTileState(state) {
      this._tileState = state;
      const host = state ? this.hostTile() : null;
      const sessionId = this.productData && this.productData.id;
      $$(document, VTO_TILE_SEL).forEach((el) => {
        // The host always wears it. So does any OTHER tile for the same
        // product — a PDP shows two (the gallery pill and the buy bar's
        // thumbnail), and one of them silently sitting at rest while the other
        // counts down is two different accounts of one job.
        //
        // Everything else is handed back exactly as it was found. A tile left
        // carrying a stale ring, a "VIEW" label or another product's image
        // after the shopper scrolls is worse than no indicator at all.
        const sameProduct = state && sessionId != null
          && String(el.dataset.productId) === String(sessionId);
        if (el === host || sameProduct) this.dressTile(el, state);
        else this.resetTile(el);
      });
      this.applyTileLabel(state);
      this.setTileProgress(this._tilePct || 0);
    }

    // Paint a session onto a tile.
    dressTile(el, state) {
      el.dataset.vtoTileState = state;
      if (this.isCarried(el)) el.dataset.vtoTileCarried = 'true';
      else delete el.dataset.vtoTileCarried;
      if (this._tileOffline) el.dataset.vtoTileOffline = 'true';
      else delete el.dataset.vtoTileOffline;
      this.setTileImage(el, state);
    }

    // Connection lost mid-render. The pill had a whole offline skin; the tile
    // says it by going still — a label that keeps pulsing while nothing is
    // happening is the one thing a progress indicator must never do.
    setTileOffline(v) {
      this._tileOffline = !!v;
      this.dressedTiles().forEach((el) => {
        if (this._tileOffline) el.dataset.vtoTileOffline = 'true';
        else delete el.dataset.vtoTileOffline;
      });
      // The flag changes what a placement with room is supposed to be saying,
      // and it can flip in either direction mid-render.
      this.applyTileLabel(this._tileState);
    }

    // What the tile shows.
    //
    //   look     → the finished result. The strongest signal that something is
    //              waiting, and the only state where the tile stops being a
    //              picture of a garment.
    //   garment  → the reference image of the garment being tried on. Only when
    //              the tile is carrying another product's session.
    //   own      → the buy bar's own thumbnail, untouched.
    //
    // A tile already showing its own product is left alone in the non-ready
    // states: it is the same garment, at the merchant's crop and resolution,
    // and swapping it for the 1024px reference would be a pointless download
    // and a visible flicker.
    //
    // The key guard matters more than it looks. setTileState() re-runs on every
    // scroll frame, and both the alternatives here are expensive to even
    // compute — resultSrc() rebuilds a multi-megabyte data URL from base64, and
    // comparing two such URLs is not cheap either. A four-character dataset
    // read settles it instead.
    setTileImage(el, state) {
      // A placement with no thumbnail (the gallery pill is an icon) has nothing
      // to swap, and injecting an <img> into it would wreck its layout.
      if (el.dataset.vtoTileNoimg !== undefined) return;
      const key = (state === 'ready' && this.state.frontImage) ? 'look'
        : (this.isCarried(el) ? 'garment' : 'own');
      if (el.dataset.vtoTileImgKey === key) return;

      const wanted = key === 'look' ? this.lookSrc()
        : key === 'garment' ? (this.productData && this.productData.frontImage) || ''
        : '';
      if (!wanted) { this.restoreTileImage(el); el.dataset.vtoTileImgKey = key; return; }

      let img = $(el, 'img');
      if (!img) {
        // A product with no media renders no <img> at all, so there is nothing
        // to swap — give the tile one, and take it away again on reset.
        img = document.createElement('img');
        img.className = 'vto-tile__img';
        img.alt = '';
        img.dataset.vtoTileInjected = 'true';
        el.insertBefore(img, el.firstChild);
      }
      if (el.dataset.vtoTileOrigSrc === undefined) {
        el.dataset.vtoTileOrigSrc    = img.getAttribute('src') || '';
        el.dataset.vtoTileOrigSrcset = img.getAttribute('srcset') || '';
        el.dataset.vtoTileOrigSizes  = img.getAttribute('sizes') || '';
      }
      // srcset wins over src in every browser, so it has to go or the tile
      // keeps rendering the product thumbnail it was served with.
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.setAttribute('src', wanted);
      el.dataset.vtoTileImgKey = key;
    }

    // The result as a data URL, built once per result rather than per paint.
    lookSrc() {
      if (this._lookSrcFrom !== this.state.frontImage) {
        this._lookSrcFrom = this.state.frontImage;
        this._lookSrcUrl = this.resultSrc(this.state.frontImage);
      }
      return this._lookSrcUrl;
    }

    restoreTileImage(el) {
      if (el.dataset.vtoTileNoimg !== undefined) return;
      delete el.dataset.vtoTileImgKey;
      const img = $(el, 'img');
      if (img) {
        if (img.dataset.vtoTileInjected === 'true') {
          img.remove();
        } else if (el.dataset.vtoTileOrigSrc !== undefined) {
          const src = el.dataset.vtoTileOrigSrc;
          const set = el.dataset.vtoTileOrigSrcset;
          const sizes = el.dataset.vtoTileOrigSizes;
          if (src) img.setAttribute('src', src); else img.removeAttribute('src');
          if (set) img.setAttribute('srcset', set); else img.removeAttribute('srcset');
          if (sizes) img.setAttribute('sizes', sizes); else img.removeAttribute('sizes');
        }
      }
      delete el.dataset.vtoTileOrigSrc;
      delete el.dataset.vtoTileOrigSrcset;
      delete el.dataset.vtoTileOrigSizes;
    }

    // Returns a tile to its resting state: the thumbnail the buy bar has always
    // shown, with no ring, no pulse, its own image and its original label.
    resetTile(el) {
      if (!el) return;
      delete el.dataset.vtoTileState;
      delete el.dataset.vtoTileCarried;
      delete el.dataset.vtoTileOffline;
      el.style.removeProperty('--vto-pct');
      this.restoreTileImage(el);
      const label = $(el, '[data-vto-tile-label]');
      if (label) label.textContent = 'Try on';
      // Hidden at rest by CSS and rewritten on the next tick, so a stale number
      // here is invisible today — but this function's whole contract is that
      // the tile is handed back exactly as it was found, and a placement that
      // shows the percentage in some other way would inherit the last render's.
      const pct = $(el, '[data-vto-tile-pct]');
      if (pct) pct.textContent = '';
      const title = el.dataset.productTitle || '';
      el.setAttribute('aria-label', 'Virtual Try-On' + (title ? ' for ' + title : ''));
    }

    applyTileLabel(state) {
      // A placement may carry its own wording, as data-vto-label-<key>. The buy
      // bar's strip is 7.5px and can only ever say "View"; the gallery pill has
      // room for "View look" and for naming the states the narrow tile has to
      // convey by pulse alone ("Creating", "Paused"). Every key falls back to
      // the tile's short form, so a placement that declares nothing keeps
      // exactly the copy it has always had.
      //
      // 'offline' is not a state of its own — a dropped connection keeps the
      // session in 'generating' and adds the offline flag — but it needs its
      // own word, because a label that still reads "Creating" while nothing is
      // being created is the one thing this indicator must never say.
      const key = this._tileOffline && state === 'generating' ? 'offline'
        : state === 'ready' ? 'ready'
        : state === 'error' ? 'error'
        : state === 'generating' ? 'generating'
        : 'idle';
      const short = state === 'ready' ? 'View' : state === 'error' ? 'Retry' : 'Try on';
      this.dressedTiles().forEach((el) => {
        const label = $(el, '[data-vto-tile-label]');
        if (label) {
          const custom = el.dataset['vtoLabel' + key.charAt(0).toUpperCase() + key.slice(1)];
          // A placement that names 'generating' but not 'offline' would snap
          // back to the generic word at the worst moment; the running copy is
          // the nearer fallback.
          const dflt = key === 'offline' ? (el.dataset.vtoLabelGenerating || short) : short;
          label.textContent = custom || dflt;
        }
        this.applyTileName(el, state);
      });
    }

    // The tile's accessible name.
    //
    // Deliberately WITHOUT the percentage. minimize() moves focus here, and a
    // focused element whose name changes is re-announced — a name carrying a
    // per-second counter would talk over the shopper for the whole render. The
    // ring shows progress to those who can see it; the live region carries the
    // two moments that matter to everyone ("still creating", "ready").
    //
    // When the tile is hosting another product's session the name has to say
    // so. It is the only thing distinguishing "your look, from the page you
    // were just on" from "try this garment on", and the white lift the CSS adds
    // says nothing to a screen reader.
    applyTileName(el, state) {
      const owner = this.isCarried(el) && this.productData && this.productData.title
        ? ' for ' + this.productData.title
        : '';
      const name =
        state === 'generating' && this._tileOffline
                               ? 'Try-on paused' + owner + ' — connection lost. Open.'
        : state === 'generating' ? 'Try-on in progress' + owner + '. Open.'
        : state === 'ready'    ? 'Your try-on' + owner + ' is ready. Open.'
        : state === 'error'    ? 'Try-on' + owner + ' failed. Open to try again.'
        :                        'Virtual Try-On';
      if (el.getAttribute('aria-label') !== name) el.setAttribute('aria-label', name);
    }

    setTileProgress(pct) {
      const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      this._tilePct = v;
      this.dressedTiles().forEach((el) => {
        el.style.setProperty('--vto-pct', String(v));
        // Optional: a placement wide enough to show the number as well as the
        // ring. The buy bar tile has no room and simply has no such element.
        const out = $(el, '[data-vto-tile-pct]');
        if (out) out.textContent = v + '%';
      });
    }

    // The host can change without the session changing: the bar scrolls out of
    // view, the viewport rotates, a lazily-rendered section pushes it around.
    // Cheap enough to run on scroll — one querySelectorAll and a rect — but
    // rAF-gated so a fling does not run it per frame.
    watchTileHost() {
      if (this._tileHostWatching) return;
      this._tileHostWatching = true;
      let queued = false;
      this._tileHostHandler = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          if (this._tileState) this.setTileState(this._tileState);
        });
      };
      window.addEventListener('scroll', this._tileHostHandler, { passive: true });
      window.addEventListener('resize', this._tileHostHandler, { passive: true });
    }

    unwatchTileHost() {
      if (!this._tileHostWatching) return;
      window.removeEventListener('scroll', this._tileHostHandler);
      window.removeEventListener('resize', this._tileHostHandler);
      this._tileHostWatching = false;
    }

    // ── Showing and clearing the minimised state ───────────────────
    showTileState(state) {
      this.setTileState(state);
      this.watchTileHost();

      // A settle pass. showTileState() runs at moments when the page has not
      // finished laying out — immediately after a scroll lock is released, or
      // during restoreFromStorage() on a page whose sticky bar has not been
      // positioned yet. Measuring then can find no host and silently show the
      // shopper nothing, which is precisely the failure this rewrite exists to
      // remove. Two frames and a beat later, re-decide.
      clearTimeout(this._tileSettleTimer);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (this._tileState) this.setTileState(this._tileState);
      }));
      this._tileSettleTimer = setTimeout(() => {
        if (this._tileState) this.setTileState(this._tileState);
      }, 400);
    }

    clearTileState({ persist = true } = {}) {
      // The buy bar's tile is borrowed, not owned. It has to be handed back
      // looking exactly as it did — otherwise a finished try-on leaves a maroon
      // ring and a "VIEW" label sitting on the bar for the rest of the session.
      this._tileState = null;
      this._tilePct = 0;
      clearTimeout(this._tileSettleTimer);
      this.unwatchTileHost();
      $$(document, VTO_TILE_SEL).forEach((el) => this.resetTile(el));
      if (persist) this.saveActiveSessionSync();
    }

    // The state the tile should be showing for the session as it stands.
    tileStateForSession() {
      if (this.state.generating) return 'generating';
      if (this.machine.state === this.States.RESULTS) return 'ready';
      if (this.machine.state === this.States.ERROR) return 'error';
      return null;
    }

    // ── Resilient Connection Event Handlers ──────────────────────────
    handleNetworkOffline() {
      if (!this.state.generating) return;
      this.isOffline = true;
      this._offlineStartAt = Date.now();
      
      // Pause elapsed timer and pacing step timers
      this.stopElapsedTimer();
      this._stepTimers.forEach(clearTimeout);
      
      // Abort active fetch request
      if (this._currentController) {
        try { this._currentController.abort(); } catch { /* noop */ }
      }

      // Store original title/hint if they exist
      if (this.loadingTitleEl && !this._originalLoadingTitle) {
        this._originalLoadingTitle = this.loadingTitleEl.textContent || 'Creating your look';
      }
      if (this.loadingHintEl && !this._originalLoadingHint) {
        this._originalLoadingHint = this.loadingHintEl.textContent || '';
      }

      // Display offline notice on loading screen
      if (this.loadingTitleEl) {
        this.loadingTitleEl.textContent = 'Connection Lost';
      }
      if (this.loadingHintEl) {
        this.loadingHintEl.textContent = 'Please check your internet connection. We will automatically resume the try-on as soon as you are back online.';
      }
      
      // Update progress FAB pill state
      // The tile has no offline skin and does not need one: the ring stops
      // advancing the moment the elapsed timer stops, which is the honest
      // signal. The words go to the live region and to the modal's own screen.
      this.setTileOffline(true);

      this.announce('Connection lost. Waiting for internet to resume try-on.');
      this.track('vto_network_offline');
    }

    handleNetworkOnline() {
      if (!this.state.generating || !this.isOffline) return;
      this.isOffline = false;
      
      const offlineDuration = this._offlineStartAt ? (Date.now() - this._offlineStartAt) : 0;
      this._offlineStartAt = null;
      
      if (this._generateStartAt) {
        this._generateStartAt += offlineDuration;
      }
      
      // Restore previous title/hint on loading screen
      if (this.loadingTitleEl && this._originalLoadingTitle) {
        this.loadingTitleEl.textContent = this._originalLoadingTitle;
      }
      if (this.loadingHintEl && this._originalLoadingHint) {
        this.loadingHintEl.textContent = this._originalLoadingHint;
      }
      
      this.setTileOffline(false);

      // Update IndexedDB start time so page refreshes stay aligned
      VtoDb.get('vto_active_generation').then((activeGen) => {
        if (activeGen) {
          activeGen.startTime = this._generateStartAt;
          VtoDb.set('vto_active_generation', activeGen);
        }
      });

      // Resume loading steps and timers
      this.startLoadingSteps({ resume: true });

      this.announce('Connection restored. Resuming try-on.');
      this.track('vto_network_online');
      
      // Re-trigger fetch call
      this.runGenerationFetch();
    }

    // The upper bound of the estimate printed in the sheet. Kept next to the
    // timer that reads it rather than only in the Liquid, so the two cannot
    // drift; the default text is captured from the DOM so the wording stays
    // the merchant-editable copy in vto-modal.liquid.
    // ── Elapsed counter (presentation only) ────────────────────────
    startElapsedTimer() {
      this.stopElapsedTimer();
      if (this.elapsedNoteEl && this._elapsedNoteDefault == null) {
        this._elapsedNoteDefault = this.elapsedNoteEl.textContent;
      }
      const tick = () => {
        const secs = Math.max(0, Math.round((Date.now() - this._generateStartAt) / 1000));
        const text = secs + 's';
        if (this.elapsedEl)     this.elapsedEl.textContent = text;

        // Once the wait passes the estimate, stop repeating the estimate. The
        // sheet used to hold "usually 20-45s" forever — the Liquid wrote it once
        // and nothing ever touched it again — so at 64s it read "64s · usually
        // 20-45s", which tells a waiting shopper only that we are overdue and
        // not keeping track. Past the window, say what is actually true.
        if (this.elapsedNoteEl) {
          const note = secs > ELAPSED_ESTIMATE_MAX_S ? 'taking longer than usual' : (this._elapsedNoteDefault || '');
          if (this.elapsedNoteEl.textContent !== note) this.elapsedNoteEl.textContent = note;
        }

        // Paced progress onto whichever tile is hosting it.
        this.setTileProgress(this.calculatePacedPercent(secs));

        // Long-tail reassurance so a slow run never feels stuck. Fires past the
        // measured typical completion window (40–50s at quality=medium).
        if (secs === 55) {
          const msg = 'Almost there — finalizing your look';
          const lastStep = this.loadingSteps[this.loadingSteps.length - 1];
          const lbl = lastStep && lastStep.querySelector('.vto-step__label');
          if (lbl) lbl.textContent = msg;
          if (this.loadingHintEl) this.loadingHintEl.textContent = 'Hang tight — high-quality looks are worth the extra few seconds.';
        }
      };
      tick();
      this._elapsedTimer = setInterval(tick, 1000);
    }

    stopElapsedTimer() {
      if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
    }

    // ── Accidental-navigation guard while minimized + generating ───
    armUnloadGuard() {
      // No-op to allow seamless page transitions without crash or warning dialogues
    }

    disarmUnloadGuard() {
      // No-op to allow seamless page transitions without crash or warning dialogues
    }

    // State machine reactions
    onStateChange(next, prev, payload) {
      if (DEBUG) console.log('[vto-state]', prev, '→', next, payload);
      // Analytics wiring hooks directly off significant transitions
      if (next === this.States.GENERATING)  this.track('vto_generate_start', { product_id: this.productData.id });
      if (next === this.States.RESULTS)     this.track('vto_generate_success', { product_id: this.productData.id, duration_ms: Date.now() - this._generateStartAt });
      if (next === this.States.ERROR)       this.track('vto_generate_error', { product_id: this.productData.id, message: payload?.message });

      // Drive the floating pill when the user has minimised and walked away.
      if (this._minimized) {
        if (next === this.States.RESULTS) {
          this.showTileState('ready');
          this.disarmUnloadGuard();
          this.announce('Your try-on is ready. Open the notification to view your look.');
        } else if (next === this.States.ERROR) {
          this.showTileState('error');
          this.disarmUnloadGuard();
          this.announce('Your try-on could not be completed.');
        }
      }

      // Visual feedback during UPLOADING state.
      //
      // These used to assign `disabled = isUploading` outright, which would
      // re-enable the controls on every state change and quietly reopen the
      // consent gate. Both conditions have to hold.
      const isUploading = (next === this.States.UPLOADING);
      const locked = isUploading || !this._consented;
      if (this.dropzone) {
        this.dropzone.classList.toggle('is-uploading', isUploading);
      }
      if (this.uploadBtn) {
        this.uploadBtn.disabled = locked;
      }
      if (this.cameraBtn) {
        this.cameraBtn.disabled = locked;
      }
      if (this.fileInput) {
        this.fileInput.disabled = locked;
      }

      this.saveActiveSessionSync();
    }

    // Screen transitions
    showScreen(name) {
      if (this.backBtn) {
        this.backBtn.hidden = (name === 'upload');
      }
      Object.entries(this.screens).forEach(([key, el]) => {
        if (!el) return;
        if (key === name) {
          el.hidden = false;
          el.classList.remove('vto-screen--enter');
          void el.offsetWidth;
          el.classList.add('vto-screen--enter');
          el.addEventListener('animationend', () => {
            el.classList.remove('vto-screen--enter');
          }, { once: true });
        } else {
          el.hidden = true;
          el.classList.remove('vto-screen--enter');
        }
      });

      // Contextual title on the results screen.
      //
      // A "View Original Product" link used to be injected here, directly
      // under the image. It is gone: the product page is what the modal is
      // sitting on top of, so the link led back to where the shopper already
      // was — and it landed between the result and the size rail, which is the
      // one place nothing should stand.
      // The results screen pins its buy block and lets the image take the rest,
      // which only works if the container has a definite height to divide up.
      // It is content-sized on every other screen (an upload card should not be
      // stretched to 88vh), so the fill is switched on for results alone.
      const container = this.modal && this.modal.querySelector('.vto-modal__container');
      if (container) container.classList.toggle('is-filled', name === 'results');

      if (name === 'results' && this.modalTitleEl) {
        this.modalTitleEl.textContent = this.productData.title
          ? 'Try-On: ' + this.productData.title
          : 'Virtual Try-On';
      }
    }

    showUploadArea() {
      if (this.dropzone) this.dropzone.hidden = false;
      if (this.tipsEl)   this.tipsEl.hidden   = false;
      if (this.preview)  this.preview.hidden  = true;
      this.refreshRecentUi();
    }

    showPreview() {
      // Ensure the preview <img> always reflects the current person photo.
      if (this.previewImg && this.state.personImage) {
        this.previewImg.src = 'data:image/jpeg;base64,' + this.state.personImage;
      }
      if (this.dropzone) this.dropzone.hidden = true;
      if (this.tipsEl)   this.tipsEl.hidden   = true;
      if (this.preview)  this.preview.hidden  = false;
      this.refreshRecentUi();

      // Restrict try-on to product pages
      const onProductPage = !!document.querySelector('[data-vto-trigger]');
      if (this.generateBtn) {
        if (!onProductPage) {
          this.generateBtn.disabled = true;
          this.generateBtn.title = "Visit a product page to try on.";
          this.generateBtn.style.opacity = '0.5';
          this.generateBtn.style.cursor = 'not-allowed';
          
          let notice = $(this.screens.upload, '.vto-non-product-notice');
          if (!notice) {
            notice = document.createElement('p');
            notice.className = 'vto-non-product-notice';
            notice.style.fontSize = '12.5px';
            notice.style.color = 'var(--vto-red)';
            notice.style.textAlign = 'center';
            notice.style.marginTop = '12px';
            notice.style.fontWeight = '500';
            notice.textContent = 'Please navigate to a product page to try on this garment.';
            this.generateBtn.parentNode.insertBefore(notice, this.generateBtn.nextSibling);
          }
          notice.hidden = false;
        } else {
          this.generateBtn.disabled = false;
          this.generateBtn.style.opacity = '';
          this.generateBtn.style.cursor = '';
          const notice = $(this.screens.upload, '.vto-non-product-notice');
          if (notice) notice.hidden = true;
        }
      }
    }

    resetToUpload({ clearPerson = true } = {}) {
      // Reset the generation bookkeeping. Without this, state.generating stays
      // true forever after a reset, which permanently latches the guards in
      // open() ("Generating your look, please wait…") and generate() — leaving
      // the shopper with no working retry path at all.
      this._cancelIntent    = false;
      this.state.generating = false;
      this.generationId     = '';
      this._generateStartAt = 0;
      this.stopElapsedTimer();
      this.clearLoadingSteps();
      this.clearTileState({ persist: false });
      this.clearActiveSessionSync();

      if (clearPerson) {
        this.state.personImage = null;
        VtoDb.remove(PERSON_KEY);
      }
      this.state.frontImage  = null;
      this.state.backImage   = null;
      if (this.fileInput)     this.fileInput.value = '';
      if (this.previewImg)    this.previewImg.src  = '';
      if (this.backTab)       this.backTab.hidden  = false;

      this.machine.setState(clearPerson ? this.States.IDLE : (this.state.personImage ? this.States.PREVIEW : this.States.IDLE));

      this.showScreen('upload');
      if (this.state.personImage) this.showPreview(); else this.showUploadArea();
    }

    // File handling — uses createImageBitmap for EXIF and Blob Worker for HEIC conversion
    async handleFileSelect(file) {
      if (!ALLOWED_TYPES.includes(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
        this.showError('Please upload a JPEG, PNG, or WebP image.');
        this.track('vto_upload_error', { reason: 'bad_type', type: file.type });
        return;
      }
      if (file.size > MAX_FILE_SIZE * 2) {
        this.showError('Image is too large. Please use an image under 5 MB.');
        this.track('vto_upload_error', { reason: 'too_large', bytes: file.size });
        return;
      }

      this.machine.setState(this.States.UPLOADING);
      this.track('vto_upload_start', { bytes: file.size, type: file.type });

      try {
        const base64 = await this.compressImage(file);
        this.state.personImage = base64;
        await this.persistPerson();
        this.previewImg.src = 'data:image/jpeg;base64,' + base64;
        this.showPreview();
        this.machine.setState(this.States.PREVIEW);
        this.announce('Photo ready. Tap Try It On to continue.');
        this.track('vto_upload_success');
      } catch (err) {
        if (err && err.heic) {
          this.showError("HEIC photos aren't supported yet. Please convert to JPEG and try again.");
        } else if (file.size > MAX_FILE_SIZE) {
          this.showError('Image is too large. Please use an image under 5 MB.');
        } else {
          this.showError('Failed to process image. Please try another photo.');
        }
        this.track('vto_upload_error', { reason: 'compress_fail', message: err?.message });
      }
    }

    // Off-main-thread CPU-intensive HEIC processing inside a Blob Web Worker
    processHeicInWorker(file) {
      return new Promise((resolve, reject) => {
        try {
          const blob = new Blob([HEIC_WORKER_CODE], { type: 'application/javascript' });
          const workerUrl = URL.createObjectURL(blob);
          const worker = new Worker(workerUrl);

          worker.onmessage = (e) => {
            const { success, blob: resultBlob, error } = e.data;
            worker.terminate();
            URL.revokeObjectURL(workerUrl);

            if (success) {
              resolve(resultBlob);
            } else {
              reject(new Error(error || 'HEIC conversion failed'));
            }
          };

          worker.onerror = (err) => {
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            reject(err);
          };

          worker.postMessage({ file });
        } catch (err) {
          reject(err);
        }
      });
    }

    async loadHeicScript() {
      if (typeof window.heic2any === 'function') return;
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load HEIC converter library'));
        document.head.appendChild(script);
      });
    }

    /**
     * Compress an image client-side using Web Worker for HEIC conversion,
     * and createImageBitmap when available for high-speed, EXIF-aware resizing.
     */
    async compressImage(file) {
      const isHeic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type);
      let source = file;

      if (isHeic) {
        try {
          source = await this.processHeicInWorker(file);
        } catch (workerErr) {
          console.warn('[vto-heic] Background Worker failed, using fallback:', workerErr.message);
          try {
            await this.loadHeicScript();
          } catch (loadErr) {
            console.error('[vto-heic] Failed to load heic2any on-demand:', loadErr.message);
          }
          if (typeof window.heic2any === 'function') {
            source = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
          } else {
            const err = new Error('HEIC not supported');
            err.heic = true;
            throw err;
          }
        }
      }

      // Preferred path: createImageBitmap with EXIF-aware orientation.
      if (typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
          return this.bitmapToBase64(bitmap);
        } catch (err) {
          console.warn('[vto] createImageBitmap failed, using legacy path:', err.message);
        }
      }
      return this.legacyCompressImage(source);
    }

    /**
     * Encode the customer's photo as large as the budget allows.
     *
     * Resolution is identity here, so the ladder gives it up last: try the full
     * long edge at every quality step first, and only then step the long edge
     * down. The old version made one attempt and threw "Image still too large
     * after compression" at the shopper — which, with the ceiling now four
     * times higher, would have turned a fixable photo into a dead end.
     *
     * In practice the first attempt wins: a 2400x2999 photograph encodes to
     * 450 KB at 2048/0.92, under a tenth of the budget. The ladder exists for
     * the pathological case — a very wide panorama, or a photograph of noise —
     * not for the ordinary one.
     */
    bitmapToBase64(bitmap) {
      const src = { width: bitmap.width, height: bitmap.height };
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      try {
        for (const dim of IMAGE_DIMENSION_STEPS) {
          let { width, height } = src;
          if (width > dim || height > dim) {
            if (width > height) {
              height = Math.round((height * dim) / width);
              width  = dim;
            } else {
              width  = Math.round((width * dim) / height);
              height = dim;
            }
          }
          // A photo already smaller than this step comes out at the size the
          // previous step produced, and re-encoding identical pixels at the
          // same three qualities can only give the same three answers.
          if (canvas.width === width && canvas.height === height) continue;
          // Redraw per dimension, not per quality: the pixels only change when
          // the dimension does, and drawImage is the expensive half.
          canvas.width  = width;
          canvas.height = height;
          ctx.drawImage(bitmap, 0, 0, width, height);

          for (const q of IMAGE_QUALITY_STEPS) {
            const base64 = canvas.toDataURL('image/jpeg', q).split(',')[1];
            if (base64.length * 0.75 <= MAX_FILE_SIZE) return base64;
          }
        }
      } finally {
        if (bitmap.close) bitmap.close();
      }

      // The same failure the shopper saw before, now reached after nine
      // attempts rather than one.
      throw new Error('Image still too large after compression');
    }

    legacyCompressImage(file) {
      return new Promise((resolve, reject) => {
        const img    = new Image();
        const reader = new FileReader();
        reader.onload = (e) => {
          img.onload = () => {
            try { resolve(this.bitmapToBase64(img)); }
            catch (err) { reject(err); }
          };
          img.onerror = () => reject(new Error('Failed to load image'));
          img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
    }

    // Generate loading steps
    startLoadingSteps({ resume = false } = {}) {
      this.clearLoadingSteps();
      const steps = Array.from(this.loadingSteps);
      
      const elapsedMs = resume ? (Date.now() - this._generateStartAt) : 0;
      
      let currentStepIndex = 0;
      if (elapsedMs >= STEP_TIMINGS[2]) {
        currentStepIndex = 2;
      } else if (elapsedMs >= STEP_TIMINGS[1]) {
        currentStepIndex = 1;
      }
      
      steps.forEach((s, idx) => {
        if (idx < currentStepIndex) {
          s.classList.add('is-done');
        } else if (idx === currentStepIndex) {
          s.classList.add('is-active');
          const label = s.querySelector('.vto-step__label')?.textContent || '';
          this.announce(label);
        }
      });
      
      this.startElapsedTimer();

      STEP_TIMINGS.forEach((delay, i) => {
        if (i <= currentStepIndex) return;
        
        const remainingDelay = Math.max(0, delay - elapsedMs);
        const timer = setTimeout(() => {
          steps[i - 1]?.classList.remove('is-active');
          steps[i - 1]?.classList.add('is-done');
          steps[i]?.classList.add('is-active');
          const label = steps[i]?.querySelector('.vto-step__label')?.textContent || '';
          this.announce(label);
        }, remainingDelay);
        this._stepTimers.push(timer);
      });

      this.startLoadingTextRotation();
    }

    startLoadingTextRotation() {
      this.stopLoadingTextRotation();
      let index = 0;
      if (this.loadingHintEl) {
        this.loadingHintEl.textContent = LOADING_HINTS[0];
      }
      this._loadingTextTimer = setInterval(() => {
        index = (index + 1) % LOADING_HINTS.length;
        if (this.loadingHintEl) {
          this.loadingHintEl.style.transition = 'opacity 0.25s ease';
          this.loadingHintEl.style.opacity = '0';
          setTimeout(() => {
            if (this.loadingHintEl) {
              this.loadingHintEl.textContent = LOADING_HINTS[index];
              this.loadingHintEl.style.opacity = '1';
            }
          }, 250);
        }
      }, 5000);
    }

    stopLoadingTextRotation() {
      if (this._loadingTextTimer) {
        clearInterval(this._loadingTextTimer);
        this._loadingTextTimer = null;
      }
      if (this.loadingHintEl) {
        this.loadingHintEl.style.opacity = '';
        this.loadingHintEl.style.transition = '';
      }
    }

    clearLoadingSteps() {
      this._stepTimers.forEach(clearTimeout);
      this._stepTimers = [];
      this.loadingSteps.forEach((s) => s.classList.remove('is-active', 'is-done'));
      this.stopElapsedTimer();
      this.stopLoadingTextRotation();
    }

    finishLoadingSteps() {
      this.clearLoadingSteps();
      this.loadingSteps.forEach((s) => s.classList.add('is-done'));
    }

    // Render the answer to the question the shopper actually came with.
    //
    // The wording is whatever the size guide would say on the product page —
    // whyHtml is that exact string — so the two cannot drift into disagreeing
    // about somebody's size.
    renderVerdict() {
      if (!this._fitResult) this.buildFitContext();   // populates _fitResult
      const r = this._fitResult;
      if (!r || !this.verdictWrap) {
        if (this.verdictWrap) this.verdictWrap.hidden = true;
        return;
      }
      this.verdictWrap.hidden = false;
      this.refreshAtcLabel();
      if (this.verdictSize) this.verdictSize.textContent = r.size;
      if (this.verdictTone) this.verdictTone.textContent = r.toneWord || '';
      // whyHtml is built by the size guide from its own numbers, not from
      // anything a shopper typed, so the markup in it is ours.
      if (this.verdictWhy) this.verdictWhy.innerHTML = r.whyHtml || '';

      // Pre-select the recommendation. This is not the substitution the audit
      // removed: the shopper answered three questions and the reason is on
      // screen above the rail. Silently picking the first size in stock for
      // somebody who told us nothing is a different thing entirely.
      const pill = this.sizePills && Array.from(
        this.sizePills.querySelectorAll('input[type="radio"]:not(:disabled)')
      ).find((i) => {
        const label = i.nextElementSibling;
        return label && label.textContent.trim().toUpperCase() === String(r.size).toUpperCase();
      });
      // The mark is NOT set here any more. It used to be pinned to the
      // recommendation while the checked pill could be something else, which
      // put two marks on the rail at once. It is now a decoration on whatever
      // is selected, recomputed by syncSizeRail() — so selecting below marks
      // the recommendation, and declining to select leaves exactly one mark on
      // the size the shopper already chose.
      if (pill && !this._sizeChosen) {
        pill.checked = true;
        this.cart.selectSize(pill.value);   // calls syncSizeRail()
      } else {
        this.cart.syncSizeRail();
      }
      this.announce('We suggest size ' + r.size + ' for you.');
    }

    // One record per generation, so a rating can be read against the product,
    // the size and the model that produced it. Fire-and-forget: a shopper who
    // rates a look must never be shown an error for their trouble.
    sendFeedback(rating, reason) {
      if (!this.generationIdForFeedback) return;
      const payload = {
        generationId: this.generationIdForFeedback,
        productId: this.productData.id || '',
        variantId: this.selectedVariantId || '',
        rating: rating,
        reason: reason || null,
        sizeRecommended: (this._fitResult && this._fitResult.size) || null,
        sizeChosen: this._sizeChosen ? this.sizeLabelFor(this.selectedVariantId) : null,
      };
      this.track('vto_feedback', payload);
      try {
        const body = JSON.stringify(payload);
        // sendBeacon survives the shopper closing the modal or the tab, which
        // is exactly when a rating tends to be given.
        if (navigator.sendBeacon) {
          navigator.sendBeacon(API_URL + '/feedback', new Blob([body], { type: 'application/json' }));
        } else {
          fetch(API_URL + '/feedback', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: body, keepalive: true,
          }).catch(() => {});
        }
      } catch { /* a rating is never worth an error */ }
    }

    // "Add to Cart" alone makes a shopper look back up the page for the price.
    // theme.Currency.formatMoney is the storefront's own formatter, so the
    // figure matches the product page exactly, including its INR handling.
    priceFor(variantId) {
      const v = (this.productData.variants || []).find((x) => String(x.id) === String(variantId));
      const cents = v && v.price;
      if (cents == null) return '';
      try {
        const f = window.theme && window.theme.Currency && window.theme.Currency.formatMoney;
        if (f) return f(cents);
      } catch { /* fall through to the plain form */ }
      return '\u20b9' + Math.round(Number(cents) / 100).toLocaleString('en-IN');
    }

    refreshAtcLabel() {
      if (!this.atcLabel) return;
      const id = this.selectedVariantId;
      const price = id ? this.priceFor(id) : '';
      this.atcLabel.textContent = price ? 'Add to Cart \u00b7 ' + price : 'Add to Cart';
    }

    sizeLabelFor(variantId) {
      const v = (this.productData.variants || []).find((x) => String(x.id) === String(variantId));
      if (!v) return null;
      const idx = this.productData.sizeOptionIndex;
      if (idx >= 0 && v.options && v.options[idx]) return v.options[idx];
      return v.option1 || v.title || null;
    }

    // Pressing a locked control should say why, not do nothing.
    nudgeConsent() {
      if (this.consentWrap) {
        this.consentWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        this.consentWrap.classList.remove('is-nudge');
        void this.consentWrap.offsetWidth;
        this.consentWrap.classList.add('is-nudge');
      }
      if (this.consentBox) this.consentBox.focus({ preventScroll: true });
      this.announce('Please agree to the Privacy Policy before adding a photo.');
    }

    // Camera, Library, the file input AND the drop zone all go inert together.
    // Disabling only the buttons would leave a drag-and-drop route around the
    // checkbox, which is the whole thing the gate exists to prevent.
    applyConsentGate() {
      const on = !!this._consented;
      // Agreed once, gone for good. It is a gate, not a standing notice — a
      // shopper who has already agreed should not be asked again on every
      // product. The line under the upload card still names the Privacy Policy,
      // and withdrawal is through Contact us, as the card itself said.
      if (this.consentWrap) {
        this.consentWrap.classList.toggle('is-agreed', on);
        this.consentWrap.hidden = on;
      }
      if (this.dropzone) this.dropzone.classList.toggle('is-locked', !on);
      if (this.fileInput) this.fileInput.disabled = !on;
      if (this.uploadBtn) this.uploadBtn.disabled = !on;
      if (this.cameraBtn) this.cameraBtn.disabled = !on;
    }

    // ── Fit step ──────────────────────────────────────────────────────────
    //
    // Required, and it carries no skip: the ease, tone and build have to reach
    // the model with the generation request or the garment cannot be cut to
    // this body, which is the entire reason the step exists.
    //
    // The one exception is a product whose chart cannot be solved — a
    // one-size piece, or a chart with no measurements on the solve column.
    // Demanding three answers we cannot use would be a toll gate, so those
    // products go straight to the render.
    canAskFit() {
      const sc = sizeEngine();
      return !!(sc && this.productData.chartKey && sc.canSolve(this.productData.chartKey));
    }

    // Shown on every try-on once measurements exist, in place of silently
    // reusing them. Renders the stored values AND the size they imply for this
    // product, because "178cm, 72kg" is not something a shopper can sanity-check
    // but "we'll cut this to an M" is.
    openFitConfirm() {
      const a = this._fitAnswers;
      if (!a) { this.openFitStep(); return; }

      const sc = sizeEngine();
      const list = (sc && typeof sc.builds === 'function' && sc.builds()) || [];
      const buildLabel = (list[Number(a.buildIndex)] || {}).label || 'Average';

      const set = (key, html) => {
        const el = this.confirmOuts.find((n) => n.dataset.vtoConfirm === key);
        if (el) el.innerHTML = html;
      };
      // textContent for anything derived from stored values; the two <small>
      // units are the only markup here and they are ours, not the shopper's.
      set('height', String(Number(a.heightCm)) + '<small>cm</small>');
      set('weight', String(Number(a.weightKg)) + '<small>kg</small>');
      const buildEl = this.confirmOuts.find((n) => n.dataset.vtoConfirm === 'build');
      if (buildEl) buildEl.textContent = buildLabel;
      const altEl = this.confirmOuts.find((n) => n.dataset.vtoConfirm === 'heightAlt');
      if (altEl) altEl.textContent = feetInches(a.heightCm);

      if (this.confirmSizeEl) {
        const solved = sc && this.productData.chartKey
          ? sc.solve(this.productData.chartKey, a.heightCm, a.weightKg, a.buildIndex)
          : null;
        if (solved && solved.size) {
          // "size M", not "a M" / "an M". The article depends on how the label
          // is pronounced — "an M", "an L", "an XL", but "a Small" — and sizes
          // here can be letters or words. Dropping it is correct for all of them.
          this.confirmSizeEl.textContent = 'We’ll cut this one to size ' + solved.size + '.';
          this.confirmSizeEl.hidden = false;
        } else {
          this.confirmSizeEl.hidden = true;
        }
      }

      this._fitFrom = 'preview';
      this.showScreen('fitconfirm');
      // Focus the primary action so the one-tap path stays one tap, including
      // on a keyboard.
      if (this.confirmKeepBtn) this.confirmKeepBtn.focus({ preventScroll: true });
      this.announce('Using your saved measurements: ' + a.heightCm + ' centimetres, ' +
        a.weightKg + ' kilograms, ' + buildLabel + ' build.');
    }

    openFitStep() {
      const a = this._fitAnswers || { heightCm: 175, weightKg: 70, buildIndex: 1 };
      const set = (key, val) => {
        const input = this.fitInputs.find((i) => i.dataset.vtoFitIn === key);
        if (input) { input.value = val; this.onFitInput(input); }
      };
      set('height', a.heightCm);
      set('weight', a.weightKg);
      set('build', a.buildIndex);

      const sc = sizeEngine();
      if (this.fitNounEl && sc) {
        const probe = sc.solve(this.productData.chartKey, a.heightCm, a.weightKg, a.buildIndex);
        if (probe && probe.noun) this.fitNounEl.textContent = 'This fine-tunes the ' + probe.noun + ' estimate';
      }

      // "Answered once, and every try-on after this one is cut to them" is the
      // right promise the first time and a wrong one when they are here to
      // change an answer they have already given.
      const editing = this._fitFrom === 'confirm';
      if (this.fitKickerEl) {
        this.fitKickerEl.textContent = editing
          ? 'Update your measurements. Every try-on after this one uses the new ones.'
          : 'Three questions. Answered once, and every try-on after this one is cut to them.';
      }

      this._fitStep = 1;
      this.renderFitStep();
      this.showScreen('fit');
      this.announce(editing
        ? 'Update your measurements. Three questions.'
        : 'Three quick questions so we can size this for you.');
    }

    renderFitStep() {
      this.fitSteps.forEach((el) => {
        el.hidden = Number(el.dataset.vtoFitStep) !== this._fitStep;
      });
      this.fitDots.forEach((d, i) => d.classList.toggle('is-on', i < this._fitStep));
      // Back is available on question 1 when there is a confirm screen behind
      // it to go back TO — otherwise question 1 is the start and Back is a lie.
      if (this.fitBackBtn) {
        this.fitBackBtn.hidden = this._fitStep === 1 && this._fitFrom !== 'confirm';
      }
      if (this.fitNextBtn) this.fitNextBtn.textContent = this._fitStep === 3 ? 'Try it on' : 'Next';
      const active = this.fitSteps.find((el) => !el.hidden);
      const input = active && active.querySelector('[data-vto-fit-in]');
      if (input) input.focus({ preventScroll: true });
    }

    onFitInput(input) {
      const key = input.dataset.vtoFitIn;
      const out = (k) => this.modal.querySelector('[data-vto-fit-out="' + k + '"]');
      if (key === 'build') {
        const sc = sizeEngine();
        const list = (sc && typeof sc.builds === 'function' && sc.builds()) || [];
        const label = (list[Number(input.value)] || {}).label || 'Average';
        const el = out('build');
        if (el) el.textContent = label;
        // A slider whose values are words: read the word, not the index.
        input.setAttribute('aria-valuetext', label);
        input.max = String(Math.max(0, list.length - 1));
        return;
      }
      const el = out(key);
      if (el) el.textContent = input.value;
      if (key === 'height') {
        const alt = out('heightAlt');
        if (alt) alt.textContent = feetInches(input.value);
      }
    }

    fitBack() {
      // Back from the first question returns wherever the shopper came from.
      // Arriving via "Enter new measurements" and being dropped on the photo
      // preview would strand them: their saved answers are still there, but the
      // screen offering them is two steps away.
      if (this._fitStep <= 1) {
        if (this._fitFrom === 'confirm' && this._fitAnswers) this.openFitConfirm();
        else { this.showScreen('upload'); this.showPreview(); }
        return;
      }
      this._fitStep -= 1;
      this.renderFitStep();
    }

    fitNext() {
      if (this._fitStep < 3) { this._fitStep += 1; this.renderFitStep(); return; }
      const val = (k) => {
        const i = this.fitInputs.find((x) => x.dataset.vtoFitIn === k);
        return i ? Number(i.value) : NaN;
      };
      const answers = { heightCm: val('height'), weightKg: val('weight'), buildIndex: val('build') };
      this._fitAnswers = answers;
      writeFitAnswers(answers);
      this.track('vto_fit_answered', answers);
      this.generate();
    }

    // Everything the backend needs to cut the garment to this body, resolved
    // through the size guide's own engine so the modal and the product page
    // cannot disagree. Null when there is nothing trustworthy to send.
    buildFitContext() {
      const sc = sizeEngine();
      const a = this._fitAnswers;
      if (!sc || !a || !this.productData.chartKey) { this._fitResult = null; return null; }

      const r = sc.solve(this.productData.chartKey, a.heightCm, a.weightKg, a.buildIndex);
      this._fitResult = r;
      if (!r) return null;

      const round1 = (n) => Math.round(n * 10) / 10;
      return {
        size: r.size,
        tone: r.tone,
        easeIn: round1(r.easeIn),
        heightCm: a.heightCm,
        chestIn: round1(r.chestIn),
        waistIn: round1(r.waistIn),
        build: String(r.buildLabel || '').toLowerCase(),
      };
    }

    async generate() {
      if (this.state.generating || !this.state.personImage) return;

      // Enforce online availability
      if (navigator.onLine === false) {
        this.showError('No connection. Please check your internet connection.');
        return;
      }

      // The garment reference has to be a real image URL. Shopify's image_url
      // filter can emit a protocol-relative one, which the backend normalises,
      // so both forms are accepted. Anything else — a history entry saved
      // before reference URLs were recorded, or a product rendered without
      // them — would otherwise be posted and come back as a confusing "this
      // product's images couldn't be loaded", after a round trip.
      if (!/^(https?:)?\/\//i.test(this.productData.frontImage || '')) {
        this.showError('Open this product to try it on again.');
        this.track('vto_generate_blocked', { reason: 'no_front_reference' });
        return;
      }

      this.state.generating = true;
      this.isOffline = false;

      // Assign idempotency UUID for the backend GPU execution optimization
      this.generationId = generateUuid();
      // Same ordering requirement as in restoreFromStorage: setState persists
      // the session, so the start time has to exist before the transition or
      // this run inherits the previous run's timestamp.
      this._generateStartAt = Date.now();
      this.machine.setState(this.States.GENERATING);
      
      // Store original modal text states for dynamic network switches
      this._originalLoadingTitle = this.loadingTitleEl?.textContent || 'Creating your look';
      this._originalLoadingHint = this.loadingHintEl?.textContent || '';

      this.showScreen('loading');
      this.startLoadingSteps();
      // Rebuilt per generation, not once per page: a fresh shuffle each time is
      // the whole point, and building it on page load would fetch a dozen
      // images for a shopper who never opens the try-on.
      this.buildGallery();

      // Write generation parameters to IndexedDB
      const genState = {
        generationId: this.generationId,
        productId: this.productData.id,
        productTitle: this.productData.title,
        productUrl: this.productData.url,
        frontProductImageUrl: this.productData.frontImage,
        backProductImageUrl: this.productData.backImage || null,
        fitHint: this.productData.fitHint || '',
        fitAnswers: this._fitAnswers || null,
        chartKey: this.productData.chartKey || '',
        defaultVariantId: this.productData.defaultVariantId,
        startTime: this._generateStartAt,
        personImage: this.state.personImage,
        variants: this.productData.variants || [],
        sizeOptionIndex: this.productData.sizeOptionIndex
      };
      await VtoDb.set('vto_active_generation', genState);

      await this.runGenerationFetch();
    }

    cancelGenerate({ silent = false } = {}) {
      this._cancelIntent = true;
      if (this._currentController) {
        try { this._currentController.abort(); } catch { /* already aborted */ }
      }
      
      this.clearLoadingSteps();
      this.disarmUnloadGuard();
      
      // Cleanup storage on cancel
      this.generationId = '';
      this.state.frontImage = null;
      this.state.backImage = null;
      this.clearActiveSessionSync();
      VtoDb.remove('vto_active_results').catch(() => {});
      
      const wasMinimized = this._minimized;
      this._minimized = false;
      this.state.generating = false;
      // clearTileState() ends in saveActiveSessionSync(), which re-persisted the
      // session we just cleared — as state:'generating' with an empty
      // generationId. The next page load then treated that as a live job and
      // fired a brand-new billed generation. Suppress the write here; the
      // session is already gone and must stay gone.
      this.clearTileState({ persist: false });

      if (!silent) {
        if (wasMinimized) {
          if (window.theme?.toast) window.theme.toast({ message: 'Try-on cancelled' });
          else this.announce('Try-on cancelled');
        } else {
          this.resetToUpload({ clearPerson: false });
          this.announce('Try-on cancelled');
        }
        this.track('vto_generate_cancel', { minimized: wasMinimized });
      }
    }

    // Results: reveal / tabs
    revealResultImage(src) {
      if (!this.resultImg || !this.resultWrap) return;
      this.resultWrap.classList.add('is-loading');
      this.resultImg.classList.add('is-loading');
      this.resultImg.classList.remove('is-loaded');

      this.resultImg.onload = () => {
        this.resultWrap.classList.remove('is-loading');
        this.resultImg.classList.remove('is-loading');
        this.resultImg.classList.add('is-loaded');
      };
      this.resultImg.src = src;
    }

    switchTab(view) {
      if (view === this.state.currentView) return;
      const imageData = view === 'front' ? this.state.frontImage : this.state.backImage;
      if (!imageData) return;

      this.state.currentView = view;
      this.revealResultImage(this.resultSrc(imageData));
      this.updateTabs(view);
      this.track('vto_result_tab_switch', { view });
    }

    updateTabs(active) {
      this.tabs.forEach((tab) => {
        const isActive = tab.dataset.vtoTab === active;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      if (this.tabIndicator) {
        this.tabIndicator.classList.toggle('on-back', active === 'back');
      }
    }

    // Build a data URL for a result image using whatever format the backend
    // actually returned for this session.
    resultSrc(base64) {
      return toDataUrl(base64, this.state.resultMime);
    }

    /**
     * Results travel as WebP, but downloads and shares go out as PNG.
     * The async Clipboard API only reliably accepts image/png, and a .webp
     * attachment still trips up plenty of chat/social apps — so convert once,
     * on the rare user-initiated action, rather than paying for PNG on the wire.
     */
    async resultAsPngBlob(base64) {
      const blob = await dataUrlToBlob(this.resultSrc(base64));
      if ((this.state.resultMime || DEFAULT_RESULT_MIME) === 'image/png') return blob;
      try {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width  = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        if (bitmap.close) bitmap.close();
        const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        return png || blob;
      } catch (err) {
        console.warn('[vto] PNG conversion failed, using original format:', err.message);
        return blob;
      }
    }

    // Download
    async download() {
      const imageData = this.state.currentView === 'front'
        ? this.state.frontImage
        : this.state.backImage;
      if (!imageData) return;
      const slug = (this.productData.title || 'onrepeat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      const blob = await this.resultAsPngBlob(imageData);
      const url  = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `onrepeat-tryon-${slug}-${this.state.currentView}.png`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.track('vto_download_click', { view: this.state.currentView });
    }

    // Share
    async share() {
      const imageData = this.state.currentView === 'front'
        ? this.state.frontImage
        : this.state.backImage;
      if (!imageData) return;
      const productUrl = this.productData.url ? (location.origin + this.productData.url) : location.href;

      try {
        const blob = await this.resultAsPngBlob(imageData);
        const file = new File([blob], `onrepeat-tryon-${this.state.currentView}.png`, { type: 'image/png' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: 'My OnRepeat try-on',
            text: 'Check out how this looks on me!',
            url: productUrl,
          });
          this.track('vto_share_click', { method: 'web_share' });
          return;
        }

        // Desktop fallback — copy image to clipboard
        if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          this.showToast('Copied — paste anywhere to share.');
          this.track('vto_share_click', { method: 'clipboard' });
          return;
        }

        // Ultimate fallback — trigger download
        this.download();
        this.showToast('Image downloaded. Share it anywhere!');
      } catch (err) {
        if (err?.name === 'AbortError') return; // user cancelled share sheet
        console.error('[vto] share:', err);
        this.showToast('Sharing not available on this device.');
      }
    }

    // Toast
    showToast(msg, { action = false, error = false } = {}) {
      if (!this.toast) return;
      if (this.toastMsg)  this.toastMsg.textContent = msg;
      if (this.toastLink) this.toastLink.hidden = !action;
      // Show the icon that matches the message. Announcing a failure next to a
      // green tick reads as "it worked", which is worse than no icon at all.
      const okIcon  = $(this.toast, '[data-vto-toast-icon="success"]');
      const errIcon = $(this.toast, '[data-vto-toast-icon="error"]');
      if (okIcon)  okIcon.hidden  = error;
      if (errIcon) errIcon.hidden = !error;
      this.toast.classList.toggle('vto-toast--error', !!error);
      this.toast.hidden = false;
      void this.toast.offsetWidth; // reflow so the transition runs
      this.toast.classList.add('is-visible');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => this.hideToast(), 3500);
    }

    hideToast() {
      if (!this.toast) return;
      clearTimeout(this._toastTimer);
      this.toast.classList.remove('is-visible');
      this._toastTimer = setTimeout(() => {
        if (this.toast && !this.toast.classList.contains('is-visible')) {
          this.toast.hidden = true;
        }
      }, 300);
    }

    // Feedback thumbs
    refreshFeedbackUi() {
      // Resets the widget, NOT the id it reports against. This used to clear
      // generationIdForFeedback too, and it runs immediately after the success
      // path sets it — so every rating was dropped on the floor before it could
      // be sent.
      this._rating = null;
      if (this.feedbackWrap) delete this.feedbackWrap.dataset.submitted;
      this.feedbackBtns.forEach((b) => {
        b.classList.remove('is-selected');
        b.setAttribute('aria-pressed', 'false');
      });
      this.reasonBtns.forEach((b) => b.classList.remove('is-on'));
      if (this.reasonWrap) this.reasonWrap.hidden = true;
      if (this.thanksEl) this.thanksEl.hidden = true;
    }

    // A thumbs-up is the whole answer. A thumbs-down is only the start of one:
    // "not my face" and "garment wrong" call for completely different fixes,
    // and a bare score cannot tell them apart — so the reasons open and the
    // record is sent when one is picked.
    submitFeedback(rating) {
      if (!this.feedbackWrap) return;
      if (this._rating === rating) return;
      this._rating = rating;

      this.feedbackBtns.forEach((b) => {
        const on = b.dataset.vtoFeedbackBtn === rating;
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-pressed', String(on));
      });

      if (rating === 'down') {
        if (this.reasonWrap) this.reasonWrap.hidden = false;
        if (this.thanksEl) this.thanksEl.hidden = true;
        this.announce('Thanks. What was off?');
        return;   // the record goes with the reason
      }

      this.reasonBtns.forEach((b) => b.classList.remove('is-on'));
      if (this.reasonWrap) this.reasonWrap.hidden = true;
      if (this.thanksEl) this.thanksEl.hidden = false;
      this.sendFeedback('up', null);
      this.announce('Thanks for the feedback.');
    }

    // Error screen
    showError(message) {
      if (this.errorMsg) this.errorMsg.textContent = message;
      this.showScreen('error');
      this.announce(message);
    }

    // sessionStorage persistence + history (instant synchronous storage)
    saveActiveSessionSync() {
      try {
        const sessionState = {
          state: this.machine.state,
          minimized: this._minimized || false,
          productId: this.productData.id || '',
          productTitle: this.productData.title || '',
          productUrl: this.productData.url || '',
          frontProductImageUrl: this.productData.frontImage || '',
          backProductImageUrl: this.productData.backImage || null,
          fitHint: this.productData.fitHint || '',
          defaultVariantId: this.productData.defaultVariantId || '',
          sizeOptionIndex: this.productData.sizeOptionIndex || 0,
          variants: this.productData.variants || [],
          sizeChosen: this._sizeChosen || false,
          fitAnswers: this._fitAnswers || null,
          chartKey: this.productData.chartKey || '',
          generationId: this.generationId || '',
          startTime: this._generateStartAt || 0,
          dismissed: this._lookSeen || false,
          error: this.machine.payload?.message || null
        };
        sessionStorage.setItem('vto_active_session_state', JSON.stringify(sessionState));
      } catch (err) {
        console.warn('[vto-session] failed to save active session state:', err.message);
      }
    }

    loadActiveSessionSync() {
      try {
        const val = sessionStorage.getItem('vto_active_session_state');
        return val ? JSON.parse(val) : null;
      } catch (err) {
        console.warn('[vto-session] failed to load active session state:', err.message);
        return null;
      }
    }

    clearActiveSessionSync() {
      try {
        sessionStorage.removeItem('vto_active_session_state');
      } catch (err) {
        console.warn('[vto-session] failed to clear active session state:', err.message);
      }
    }

    async persistPerson() {
      if (!this.state.personImage) return;
      await VtoDb.set(PERSON_KEY, this.state.personImage);
    }

    async loadHistory() {
      const items = await VtoDb.get(HISTORY_KEY);
      return Array.isArray(items) ? items : [];
    }

    // Returns whether the write landed, so persistResult() can react to a full
    // store rather than assuming the history was saved.
    async saveHistory(items) {
      return VtoDb.set(HISTORY_KEY, items);
    }

    async appendToHistory(frontImage, backImage, mimeType) {
      const items = await this.loadHistory();
      const id = 'h_' + Date.now();
      items.unshift({
        id,
        productId:        this.productData.id,
        productTitle:     this.productData.title,
        productUrl:       this.productData.url,
        // The garment reference URLs, kept separate from the generated images
        // below. Reopening an entry has to restore the product it was made
        // from, and the result is not that.
        frontProductImageUrl: this.productData.frontImage || '',
        backProductImageUrl:  this.productData.backImage || null,
        fitHint:              this.productData.fitHint || '',
        chartKey:             this.productData.chartKey || '',
        frontImage,
        backImage,
        mimeType:         mimeType || DEFAULT_RESULT_MIME,
        personImage:      this.state.personImage,
        defaultVariantId: this.productData.defaultVariantId,
        sizeOptionIndex:  this.productData.sizeOptionIndex,
        variants:         this.productData.variants || [],
        at:               Date.now(),
      });
      while (items.length > HISTORY_MAX) items.pop();
      return this.saveHistory(items);
    }

    // Store a finished result without ever being able to lose it.
    //
    // Persisting is a convenience: it feeds the recent-try-ons strip and lets a
    // refresh put the shopper back on their result. It is not the result.
    // These entries are large — two images plus the photo, and an order of
    // magnitude larger again if the backend's webp transcode degraded to PNG —
    // so IndexedDB can refuse them once the browser's quota is reached. Storage
    // failures used to be able to take the whole result down with them; now
    // each write reports a boolean and a false drops the oldest history and
    // tries once more. If it still fails the shopper keeps the result on screen
    // and simply has no saved copy of it.
    async persistResult(data) {
      const mime = this.state.resultMime;
      const attempt = async (write) => {
        if (await write()) return;
        console.warn('[vto-db] result write failed, pruning history and retrying');
        await this.pruneHistory(1);
        if (!(await write())) console.warn('[vto-db] result not persisted');
      };

      await attempt(() => VtoDb.set('vto_active_results', {
        frontImage: data.frontImage,
        backImage: data.backImage || null,
        mimeType: mime,
      }));
      await attempt(() => this.appendToHistory(data.frontImage, data.backImage, mime));
    }

    async pruneHistory(keep = 2) {
      const items = (await this.loadHistory()).slice(0, keep);
      await this.saveHistory(items);
    }

    // ── Recent looks, shown while the render runs ─────────────────────────
    //
    // Seed try-ons generated with the same prompt and model the shopper is
    // waiting on. Not captioned as other customers' work, because they are made
    // from the store's own catalogue photography — see the note in the snippet.
    async buildGallery() {
      const wrap = this.gallery, track = this.galleryTrack, src = this.gallerySrc;
      if (!wrap || !track || !src) return;

      let seeded;
      try { seeded = JSON.parse(src.textContent); } catch { seeded = null; }
      if (!Array.isArray(seeded)) seeded = [];

      // Fisher-Yates. `sort(() => Math.random() - 0.5)` is not a shuffle — it
      // is heavily biased toward the original order, so the same few images
      // would lead the strip on nearly every generation.
      const shuffle = (arr) => {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      };

      // Real customer looks first, seeded catalogue looks topping up the rest.
      // The fetch is bounded and never fatal: the carousel is decoration on a
      // loading screen, and a slow or dead gallery endpoint must not be the
      // reason a shopper stares at a blank panel while their render runs.
      let live = [];
      try {
        const ctrl = new AbortController();
        const bail = setTimeout(() => ctrl.abort(), GALLERY_FETCH_TIMEOUT_MS);
        const res = await fetch(API_URL + '/gallery?limit=' + GALLERY_VISIBLE, { signal: ctrl.signal });
        clearTimeout(bail);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.looks)) {
            live = data.looks.map((l) => l && l.url).filter((u) => typeof u === 'string');
          }
        }
      } catch { /* offline, aborted, or the endpoint is down — seeded is enough */ }

      const picks = [...shuffle(live), ...shuffle(seeded)].slice(0, GALLERY_VISIBLE);
      if (!picks.length) { wrap.hidden = true; return; }

      // Probe before building. Seeded cards are theme assets referenced by a
      // generated filename list, and live ones are bucket objects that may have
      // been taken down since the pool was cached — either can go missing
      // without this code knowing, and an unprobed card drifts past as an empty
      // grey box.
      //
      // Each probe is raced against a timer. Without one, a single thumbnail
      // that neither loads nor errors — a stalled connection, a slow CDN edge —
      // leaves Promise.all pending forever and the strip never appears at all.
      // Measured: a hung bucket image held the whole strip for 12.5s before
      // giving up on its own. A card that cannot arrive promptly is not worth
      // waiting for; there are nine others.
      const ok = (await Promise.all(picks.map((u) => new Promise((resolve) => {
        const img = new Image();
        const done = (val) => { clearTimeout(timer); resolve(val); };
        const timer = setTimeout(() => done(null), GALLERY_PROBE_TIMEOUT_MS);
        img.onload  = () => done(u);
        img.onerror = () => done(null);
        img.src = u;
      })))).filter(Boolean);

      if (ok.length < GALLERY_MIN) { wrap.hidden = true; return; }

      track.innerHTML = '';
      // Appended twice on purpose: the drift animation translates exactly -50%,
      // so the second copy must be identical for the wrap-around to be seamless.
      for (let copy = 0; copy < 2; copy++) {
        ok.forEach((url) => {
          const card = document.createElement('div');
          card.className = 'vto-gallery__card';
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';            // decorative; the track is aria-hidden
          img.decoding = 'async';
          card.appendChild(img);
          track.appendChild(card);
        });
      }
      wrap.hidden = false;
    }

    async refreshRecentUi() {
      if (!this.recentWrap || !this.recentList) return;
      const items = await this.loadHistory();
      if (!items.length) { this.recentWrap.hidden = true; return; }
      this.recentWrap.hidden = false;
      this.recentList.innerHTML = '';
      items.forEach((it) => {
        const card = document.createElement('div');
        card.className = 'vto-recent__card';

        const thumbBtn = document.createElement('button');
        thumbBtn.type = 'button';
        thumbBtn.className = 'vto-recent__thumb-btn';
        thumbBtn.dataset.vtoRecentItem = it.id;
        thumbBtn.setAttribute('aria-label', 'Try on ' + (it.productTitle || 'product'));
        const img = document.createElement('img');
        img.alt = '';
        img.src = toDataUrl(it.frontImage, it.mimeType);
        thumbBtn.appendChild(img);

        const info = document.createElement('div');
        info.className = 'vto-recent__info';

        const title = document.createElement('div');
        title.className = 'vto-recent__title';
        title.textContent = it.productTitle || 'Product';

        const actions = document.createElement('div');
        actions.className = 'vto-recent__actions';

        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'vto-recent__load-btn';
        loadBtn.dataset.vtoRecentItem = it.id;
        loadBtn.textContent = 'Try On';

        const viewLink = document.createElement('a');
        viewLink.className = 'vto-recent__view-link';
        viewLink.href = it.productUrl || '#';
        viewLink.textContent = 'View';

        actions.appendChild(loadBtn);
        actions.appendChild(viewLink);
        info.appendChild(title);
        info.appendChild(actions);

        card.appendChild(thumbBtn);
        card.appendChild(info);

        this.recentList.appendChild(card);
      });
    }

    async openHistoryItem(id) {
      const items = await this.loadHistory();
      const it = items.find((h) => h.id === id);
      if (!it) return;

      // Restore full product context from the historical item so that
      // adding to cart operates on the actual try-on product, not the active page product!
      //
      // productData.frontImage is the GARMENT reference URL sent to the backend,
      // not the picture on screen. This used to be filled with it.frontImage —
      // the generated result — so after reopening a past try-on, regenerating
      // posted a base64 blob where a CDN URL belongs and the shopper was told
      // the product's images could not be loaded. Entries written before this
      // change have no reference URL; generate() catches that and says
      // something useful instead of letting it reach the backend.
      this.productData = {
        id:               it.productId,
        title:            it.productTitle || 'Product',
        url:              it.productUrl || '',
        frontImage:       it.frontProductImageUrl || '',
        backImage:        it.backProductImageUrl || null,
        fitHint:          it.fitHint || '',
        chartKey:         it.chartKey || '',
        defaultVariantId: it.defaultVariantId || '',
        sizeOptionIndex:  it.sizeOptionIndex !== undefined ? it.sizeOptionIndex : 0,
        variants:         it.variants || [],
      };

      this.selectedVariantId = null;
      this._sizeChosen = false;
      this._fitResult = null;   // different product, different chart
      this.cart.renderSizePills();

      this.state.frontImage  = it.frontImage;
      this.state.backImage   = it.backImage || null;
      this.state.resultMime  = it.mimeType || DEFAULT_RESULT_MIME;
      this.state.personImage = it.personImage || this.state.personImage;
      this.state.currentView = 'front';
      this.showScreen('results');
      this.updateTabs('front');
      if (this.backTab) this.backTab.hidden = !this.state.backImage;
      this.revealResultImage(toDataUrl(it.frontImage, it.mimeType));

      // Save to IndexedDB so that page refresh/navigation restores this correct historical image context
      await VtoDb.set('vto_active_results', {
        frontImage: it.frontImage,
        backImage: it.backImage || null,
        mimeType: this.state.resultMime
      });

      this.machine.setState(this.States.RESULTS);
      this.renderVerdict();
      this.track('vto_history_reopen');
    }

    async restoreFromStorage() {
      // 1. Restore person image from general PERSON_KEY if it exists (legacy safety)
      const p = await VtoDb.get(PERSON_KEY);
      if (p) {
        this.state.personImage = p;
      }

      // 2. Load unified active session synchronously from sessionStorage
      const session = this.loadActiveSessionSync();
      if (!session) return;

      // Restore basic properties
      this._minimized = session.minimized || false;
      this._lookSeen = session.dismissed || false;
      // Restore BEFORE productData, because renderSizePills() reads it.
      this._sizeChosen = session.sizeChosen || false;
      if (session.fitAnswers) this._fitAnswers = session.fitAnswers;
      if (this._sizeChosen) this.selectedVariantId = session.defaultVariantId || null;
      
      // Restore product context
      this.productData = {
        id:               session.productId || '',
        title:            session.productTitle || '',
        url:              session.productUrl || '',
        frontImage:       session.frontProductImageUrl || '',
        backImage:        session.backProductImageUrl || null,
        fitHint:          session.fitHint || '',
        chartKey:         session.chartKey || '',
        defaultVariantId: session.defaultVariantId || '',
        sizeOptionIndex:  session.sizeOptionIndex || 0,
        variants:         session.variants || [],
      };

      if (session.state === 'generating') {
        const elapsedMs = Date.now() - session.startTime;

        if (elapsedMs > REQUEST_TIMEOUT_MS) {
          // Clear expired active generation and restore to idle
          this.machine.setState(this.States.IDLE);
          this.clearActiveSessionSync();
          return;
        }

        // Restore parameters for ongoing generation.
        this.cart.renderSizePills();

        // A session with no generationId is unrecoverable: minting a fresh one
        // here would defeat the backend idempotency store and bill a second
        // generation for work already paid for. Treat it as dead instead.
        if (!session.generationId) {
          this.machine.setState(this.States.IDLE);
          this.clearActiveSessionSync();
          return;
        }
        this.generationId = session.generationId;
        this.state.generating = true;

        // _generateStartAt MUST be assigned before setState. setState ->
        // onStateChange -> saveActiveSessionSync persists `_generateStartAt || 0`,
        // so transitioning first writes startTime:0 back over the good value.
        // Two navigations later `Date.now() - 0` exceeds REQUEST_TIMEOUT_MS, the
        // session is judged expired and wiped, and the paid-for result is lost.
        this._generateStartAt = session.startTime;
        this.machine.setState(this.States.GENERATING);

        // Restore original modal text states
        this._originalLoadingTitle = this.loadingTitleEl?.textContent || 'Creating your look';
        this._originalLoadingHint = this.loadingHintEl?.textContent || '';

        // If page is restored while offline, display notice immediately
        if (navigator.onLine === false) {
          this.isOffline = true;
          this._offlineStartAt = Date.now();
          this.startLoadingSteps({ resume: true });
          this.stopElapsedTimer();
          this._stepTimers.forEach(clearTimeout);

          this._minimized = true;
          this.showTileState('generating');
          this.armUnloadGuard();
          this.setTileOffline(true);

          if (this.loadingTitleEl) this.loadingTitleEl.textContent = 'Connection Lost';
          if (this.loadingHintEl) this.loadingHintEl.textContent = 'Please check your internet connection. We will automatically resume the try-on as soon as you are back online.';
          return;
        }

        // Resume loading steps and timer
        this.startLoadingSteps({ resume: true });

        // The session is minimised by definition: this is a fresh page, the
        // modal is closed, and the render is still running. The buy bar's tile
        // picks it up — on THIS page's product or, if the shopper has walked to
        // another garment, on whatever tile the bar is showing.
        this._minimized = true;
        this.showTileState('generating');
        this.armUnloadGuard();

        // Run fetch request to resume
        this.runGenerationFetch();

      } else if (session.state === 'results') {
        // Retrieve heavy results images from IndexedDB asynchronously
        const results = await VtoDb.get('vto_active_results');
        if (results) {
          this.state.frontImage = results.frontImage;
          this.state.backImage = results.backImage || null;
          this.state.resultMime = results.mimeType || DEFAULT_RESULT_MIME;
          this.state.currentView = 'front';
          
          // Eased transition from IDLE -> RESULTS (now permitted in vto-state.js)
          this.machine.setState(this.States.RESULTS);
          this.renderVerdict();

          // A finished look follows the shopper from page to page until they
          // have actually seen it — closing the results modal is what marks it
          // seen and hands the thumbnail back.
          if (!this._lookSeen) {
            this._minimized = true;
            this.showTileState('ready');
          }
        }

      } else if (session.state === 'error') {
        this.machine.setState(this.States.ERROR, { message: session.error || 'Failed to complete try-on' });
        if (!this._lookSeen) {
          this._minimized = true;
          this.showTileState('error');
        }
      } else if (session.state === 'preview' && this.state.personImage) {
        this.machine.setState(this.States.PREVIEW);
        this.cart.renderSizePills();
      }
    }

    async runGenerationFetch() {
      // Four things can start this loop: generate(), restoreFromStorage(),
      // handleNetworkOnline() and the bfcache restore. Two running at once would
      // share a single _currentController, so each would abort the other's
      // request and both would race to write the result. The backend dedupes on
      // generationId so this never double-billed, but the client state did get
      // corrupted. One loop at a time.
      if (this._fetchLoopActive) return;
      this._fetchLoopActive = true;
      try {
        return await this._runGenerationFetchLoop();
      } finally {
        this._fetchLoopActive = false;
      }
    }

    async _runGenerationFetchLoop() {
      // One attempt, deliberately.
      //
      // This used to retry a 503 up to MAX_RETRIES times with the SAME
      // generationId. That could not work: the backend records every outcome
      // against the id, 5xx included, and replays it — on purpose, so one
      // upstream blip is not billed three times. So each "retry" re-fetched the
      // cached failure, held the shopper on a "Busy — retrying (1/2)…" step for
      // about nine seconds, and ended on the same error. And with the shared
      // store unreachable the identical loop DID re-run, billing three
      // generations for one try-on.
      //
      // Genuine upstream blips are already retried server-side inside
      // withRetry() before any response reaches here, and a network failure
      // that never reached the server is handled below by preserving the
      // session for resume rather than by retrying. What is left is the error
      // screen, whose "Try Again" mints a fresh id: one deliberate,
      // user-initiated charge.
      if (this._cancelIntent) {
        this._cancelIntent = false;
        return;
      }

      {
        this._timeoutTriggered = false;
        this._currentController = new AbortController();
        const timeout = setTimeout(() => {
          this._timeoutTriggered = true;
          this._currentController.abort();
        }, REQUEST_TIMEOUT_MS);

        try {
          const response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            signal:  this._currentController.signal,
            body: JSON.stringify({
              generationId:         this.generationId,
              personImage:          this.state.personImage,
              frontProductImageUrl: this.productData.frontImage,
              backProductImageUrl:  this.productData.backImage || null,
              productTitle:         this.productData.title,
              fitHint:              this.productData.fitHint || null,
              // The whole reason the questions come before the request: ease,
              // tone and build reach the model, so the garment is cut to this
              // body instead of guessed at. Null when the chart cannot be
              // solved, which the backend treats as no context rather than
              // bad context.
              fitContext:           this.buildFitContext(),
            }),
          });

          clearTimeout(timeout);

          if (!response.ok) {
            let body = {};
            try { body = await response.json(); } catch { /* non-JSON error */ }
            const error = new Error(body.error || `Server error (${response.status})`);
            error.status = response.status;
            throw error;
          }

          const data = await response.json();
          if (!data.success || !data.frontImage) {
            // A 200 with no image means the backend answered but has nothing to
            // show. friendlyError() falls through to err.message for anything
            // without a status, so a bare "No images returned" would be read out
            // to the shopper verbatim.
            const empty = new Error("The try-on came back empty. Please try again.");
            empty.status = 502;
            throw empty;
          }

          this.state.frontImage  = data.frontImage;
          this.state.backImage   = data.backImage || null;
          this.state.resultMime  = data.mimeType || DEFAULT_RESULT_MIME;
          this.state.currentView = 'front';

          // generationId is cleared below, but a rating given a minute later
          // still has to name the render it is about.
          this.generationIdForFeedback = this.generationId;
          await VtoDb.remove('vto_active_generation');
          this.generationId = '';

          this.finishLoadingSteps();
          
          // Close the ring before the state flips to ready, so the border
          // completes rather than jumping from 90-odd per cent to a full frame.
          this.setTileProgress(100);

          if (this.backTab) this.backTab.hidden = !this.state.backImage;
          this.revealResultImage(this.resultSrc(data.frontImage));
          await this.persistResult(data);
          this.refreshFeedbackUi();
          this.renderVerdict();
          
          this.announce('Your try-on is ready');
          this.state.generating = false;
          this.machine.setState(this.States.RESULTS);
          this._cancelIntent = false;

          if (this._minimized) {
            this.showTileState('ready');
            this.disarmUnloadGuard();
          } else {
            this.showScreen('results');
            this.updateTabs('front');
          }
          return;

        } catch (err) {
          clearTimeout(timeout);
          // A 503 used to be retried here, with the SAME generationId. That is
          // now dead weight: the backend records every outcome against the id,
          // including 5xx, and replays it — deliberately, so an upstream blip
          // cannot be billed three times. So the retry re-fetched the cached
          // failure, showed "Busy — retrying (1/2)…" for about nine seconds,
          // and arrived at the same error. Worse, with the shared store
          // unreachable the identical loop DOES re-run and bills three
          // generations. Either way the loop never helped.
          //
          // Upstream blips are already retried server-side inside withRetry(),
          // before any of this. What is left is the error screen, whose "Try
          // Again" mints a fresh id — one deliberate, user-initiated charge.
          // The loop is kept for the retry-after-delay structure around it, but
          // nothing re-enters it any more.

          // Check for all major browser-navigation and page-unload network abort errors
          // (specifically WebKit's 'TypeError: Load failed' on iOS Safari, and Chrome's 'Failed to fetch')
          const isNavAbort = err.name === 'AbortError' || 
                             /Load failed|Failed to fetch|Network request failed/i.test(err.message || '');

          // `_unloading` used to short-circuit on its own, ahead of isNavAbort.
          // That made it a blanket mute: while it was set, a 500, a 429 or the
          // client's own 230s timeout all returned here silently, leaving
          // state.generating true and the sheet spinning forever with no error
          // screen. It now only silences failures that ARE a navigation abort —
          // which is the only thing it was ever meant to explain.
          if ((this._unloading || isNavAbort) && !this._cancelIntent && !this._timeoutTriggered) {
            console.log('[vto-network] Fetch interrupted by page unload/navigation abort. Preserving session.');
            return;
          }

          if (err.name === 'AbortError' && this._cancelIntent) {
            this._cancelIntent = false;
            this.state.generating = false;
            await VtoDb.remove('vto_active_generation');
            this.generationId = '';
            return;
          }

          // Catch aborted requests due to connection loss, keep state alive
          if (this.isOffline) {
            console.log('[vto-network] Fetch call suspended due to offline state.');
            return;
          }

          this.clearLoadingSteps();
          const message = friendlyError(err);
          this.showError(message);
          this.state.generating = false;
          this.machine.setState(this.States.ERROR, { message });
          this._cancelIntent = false;
          await VtoDb.remove('vto_active_generation');
          this.generationId = '';
          return;
        } finally {
          this._currentController = null;
        }
      }
      // Every branch of the try/catch above returns, so there is no trailing
      // failure path here. There used to be one, reachable only when the loop
      // broke on a cancel — which showed a cancelling shopper a "Something went
      // wrong" error screen.
    }

    calculatePacedPercent(secs) {
      if (secs <= 5) return Math.round(0 + (secs / 5) * 20); // 0% to 20%
      if (secs <= 15) return Math.round(20 + ((secs - 5) / 10) * 35); // 20% to 55%
      if (secs <= 35) return Math.round(55 + ((secs - 15) / 20) * 33); // 55% to 88%
      return Math.min(95, Math.round(88 + ((secs - 35) / 85) * 7)); // crawl to 95%
    }

    // Mobile drag-to-close
    bindDragToClose(target) {
      target.addEventListener('pointerdown', (e) => {
        if (window.innerWidth > 640) return; // mobile only
        if (e.target.closest('button, select, input, textarea, a')) return;
        this._dragStartY = e.clientY;
        target.setPointerCapture?.(e.pointerId);
      });
      target.addEventListener('pointermove', (e) => {
        if (this._dragStartY == null) return;
        const dy = e.clientY - this._dragStartY;
        if (dy < 0) return; // ignore upward
        this._dragCurrentY = dy;
        this.container.style.transform = `translateY(${dy}px)`;
        this.container.style.transition = 'none';
      });
      const release = () => {
        if (this._dragStartY == null) return;
        const dy = this._dragCurrentY || 0;
        this.container.style.transform = '';
        this.container.style.transition = '';
        this._dragStartY = null;
        this._dragCurrentY = null;
        if (dy > 100) this.dismiss();
      };
      target.addEventListener('pointerup', release);
      target.addEventListener('pointercancel', release);
    }

    // Announce for screen readers
    announce(msg) {
      if (!this.announcer) return;
      // Nudge the live region: clear then set, so repeated messages re-announce.
      this.announcer.textContent = '';
      setTimeout(() => { if (this.announcer) this.announcer.textContent = msg; }, 40);
    }

    // Analytics
    track(event, props = {}) {
      const payload = { event, ...props, ts: Date.now() };
      try { if (window.gtag)       window.gtag('event', event, props); } catch {}
      try { if (window.dataLayer)  window.dataLayer.push(payload); }      catch {}
      try { if (window.analytics && window.analytics.publish) {
        window.analytics.publish(event, props);
      } } catch {}
      if (DEBUG) console.log('[vto-track]', event, props);
    }

    // Utils
    ensureAbsoluteUrl(url) {
      if (!url) return url;
      if (url.startsWith('//')) return 'https:' + url;
      return url;
    }
  }

  // Init
  function init() {
    if (!window.VtoStateMachine) {
      console.error('[vto] vto-state.js not loaded');
      return;
    }
    new VirtualTryOn();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
