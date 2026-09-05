/**
 * Virtual Try-On state machine.
 *
 * Keeps the screen transitions honest: only explicit, valid state transitions
 * are allowed. Invalid transitions are logged (once, per combo) and silently
 * ignored so a runtime bug never hangs the UI.
 *
 * Why a state machine at all:
 *   1. Analytics — every transition fires a single onTransition() hook, so
 *      the tracker only needs to listen in one place.
 *   2. Guardrails — prevents e.g. error → results by mistake.
 *   3. Debuggability — log the state history from the debug overlay.
 *
 * Exposed as a global: window.VtoStateMachine (no build step).
 */
(function () {
  'use strict';

  const States = Object.freeze({
    IDLE:       'idle',
    UPLOADING:  'uploading',   // processing a file through compression
    PREVIEW:    'preview',     // photo ready, awaiting "Try It On"
    GENERATING: 'generating',  // image-model request in flight
    RESULTS:    'results',     // rendered
    ERROR:      'error',
  });

  // Valid transitions. Any state may go to ERROR; any state may go to IDLE
  // (close). These broad rules are encoded in `isValid` below rather than
  // repeated here.
  const TRANSITIONS = {
    [States.IDLE]:       [States.UPLOADING, States.PREVIEW, States.GENERATING, States.RESULTS, States.ERROR],       // allow session restoration on load
    [States.UPLOADING]:  [States.PREVIEW, States.ERROR, States.IDLE],
    [States.PREVIEW]:    [States.UPLOADING, States.GENERATING, States.IDLE, States.ERROR],
    [States.GENERATING]: [States.RESULTS, States.ERROR, States.IDLE, States.PREVIEW],
    [States.RESULTS]:    [States.UPLOADING, States.GENERATING, States.IDLE, States.PREVIEW, States.ERROR],
    [States.ERROR]:      [States.IDLE, States.UPLOADING, States.PREVIEW, States.GENERATING],
  };

  function isValid(from, to) {
    if (from === to) return true;
    const allowed = TRANSITIONS[from] || [];
    return allowed.includes(to);
  }

  const HISTORY_CAP = 50;

  class VtoStateMachine {
    constructor({ onTransition } = {}) {
      this._state = States.IDLE;
      this._payload = null;
      this._history = [{ state: States.IDLE, at: Date.now() }];
      this._onTransition = onTransition || (() => {});
      this._warned = new Set();
    }

    get state()   { return this._state; }
    get payload() { return this._payload; }
    get history() { return this._history.slice(); }

    /**
     * Attempt to transition to `next`. Returns true on success.
     * Silently no-ops (but warns once) on invalid transitions.
     */
    setState(next, payload) {
      const prev = this._state;
      if (!Object.values(States).includes(next)) {
        console.error('[vto-state] unknown state:', next);
        return false;
      }
      if (!isValid(prev, next)) {
        const key = prev + '->' + next;
        if (!this._warned.has(key)) {
          this._warned.add(key);
          console.warn('[vto-state] invalid transition ignored:', key);
        }
        return false;
      }
      this._state = next;
      this._payload = payload || null;
      this._history.push({ state: next, from: prev, at: Date.now(), payload });
      if (this._history.length > HISTORY_CAP) this._history.shift();
      try {
        this._onTransition(next, prev, payload);
      } catch (err) {
        console.error('[vto-state] onTransition threw:', err);
      }
      return true;
    }

    reset() { return this.setState(States.IDLE); }

    /** Time spent in the current state, in ms. */
    timeInState() {
      const last = this._history[this._history.length - 1];
      return Date.now() - last.at;
    }
  }

  window.VtoStateMachine = VtoStateMachine;
  window.VtoStates = States;
})();
