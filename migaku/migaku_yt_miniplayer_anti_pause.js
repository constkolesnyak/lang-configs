// ==UserScript==
// @name         Anti-Pause YouTube
// @namespace    constk.yt.antipause.v3
// @version      3.2
// @description  .
// @match        https://www.youtube.com/*
// @match        https://youtu.be/*
// @run-at       document-start
// @all-frames   true
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---- Tunables ----
    const WINDOW_MS = 2500; // main protection window after 'i'
    const MICRO_EXTEND_MS = 400; // extend window slightly when a late pause is seen
    const BURST_STEPS = [0, 16, 48, 96, 160, 240, 320, 480];
    const GUARD_INTERVAL_MS = 50; // interval guard cadence

    // ---- Utils ----
    const now = () => performance.now();

    function pickMainVideo() {
        const vids = Array.from(document.querySelectorAll('video'));
        if (!vids.length) return null;
        const w = innerWidth || 0,
            h = innerHeight || 0;
        const score = (v) => {
            const r = v.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            const vis =
                area > 0 &&
                r.bottom > 0 &&
                r.right > 0 &&
                r.left < w &&
                r.top < h;
            let s = area;
            if (vis) s += 1e6;
            if (!v.paused) s += 5e5;
            if (v.readyState >= 2) s += 2e5;
            return s;
        };
        return vids.sort((a, b) => score(b) - score(a))[0] || null;
    }

    function isEditable(t) {
        if (!t) return false;
        const tag = (t.tagName || '').toLowerCase();
        if (t.isContentEditable) return true;
        if (tag === 'input' || tag === 'textarea' || tag === 'select')
            return true;
        const root = t.getRootNode && t.getRootNode();
        return !!(root && root.host && root.host.isContentEditable);
    }

    function isBareIKey(e) {
        return (
            typeof e.key === 'string' &&
            e.key.toLowerCase() === 'i' &&
            !e.altKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.shiftKey
        );
    }

    // ---- State ----
    let windowUntil = 0;
    let trackedVideo = null;
    let lastWasPlaying = false;

    // Guards
    let guardInterval = null;
    let guardRAFActive = false;

    // Native refs
    const NativePause = HTMLMediaElement.prototype.pause;
    const NativePlay = HTMLMediaElement.prototype.play;
    const NativeAddEv = HTMLMediaElement.prototype.addEventListener;
    const NativeRemEv = HTMLMediaElement.prototype.removeEventListener;

    // ---- Core helpers ----
    function inWindowFor(el) {
        return !!(
            el &&
            el === trackedVideo &&
            lastWasPlaying &&
            now() <= windowUntil
        );
    }

    function extendWindow(ms) {
        windowUntil = Math.max(windowUntil, now() + ms);
    }

    function safePlay(el) {
        try {
            const p = NativePlay.call(el);
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {}
    }

    function playBurst(el) {
        try {
            requestAnimationFrame(() => safePlay(el));
        } catch {}
        BURST_STEPS.forEach((ms) => setTimeout(() => safePlay(el), ms));
    }

    function kickIfPaused(el) {
        if (!el) return;
        if (!inWindowFor(el)) return;
        if (el.paused) {
            safePlay(el);
            // tiny extend to catch cascaded pauses coming right after
            extendWindow(MICRO_EXTEND_MS);
        }
    }

    function startGuards() {
        stopGuards();
        // Interval guard
        guardInterval = setInterval(() => {
            if (!trackedVideo || now() > windowUntil) {
                stopGuards();
                return;
            }
            kickIfPaused(trackedVideo);
        }, GUARD_INTERVAL_MS);

        // Frame guard (rAF each frame)
        guardRAFActive = true;
        const loop = () => {
            if (!guardRAFActive) return;
            if (!trackedVideo || now() > windowUntil) {
                stopGuards();
                return;
            }
            kickIfPaused(trackedVideo);
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    function stopGuards() {
        if (guardInterval) {
            clearInterval(guardInterval);
            guardInterval = null;
        }
        guardRAFActive = false;
    }

    // ---- Capture snapshot BEFORE site handlers ----
    addEventListener(
        'keydown',
        (e) => {
            if (!isBareIKey(e) || isEditable(e.target)) return;
            const v = pickMainVideo();
            if (!v) return;
            trackedVideo = v;
            lastWasPlaying = !v.paused;
            windowUntil = now() + WINDOW_MS;
            if (lastWasPlaying) {
                startGuards();
            } else {
                // If it wasn't playing, no protection window
                stopGuards();
            }
        },
        true
    );

    // ---- Monkey-patch pause() so we can immediately re-assert play ----
    function patchedPause() {
        const el = this;
        const protect = inWindowFor(el);
        const ret = NativePause.apply(el, arguments);
        if (protect) {
            // Re-assert after native pause & after any microtasks queued by their pause handlers
            Promise.resolve().then(() => {
                kickIfPaused(el);
                playBurst(el);
            });
            // And once more a tick later
            setTimeout(() => {
                kickIfPaused(el);
            }, 0);
            extendWindow(MICRO_EXTEND_MS);
        }
        return ret;
    }
    try {
        Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
            value: patchedPause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    } catch {
        HTMLMediaElement.prototype.pause = patchedPause;
    }

    // ---- Wrap addEventListener on media elements for late pause-like events ----
    const REPLAY_TYPES = new Set(['pause', 'suspend', 'stalled', 'waiting']);
    const WRAPPED = new WeakMap(); // el -> Map<original, wrapped> per type
    function getMap(el) {
        let m = WRAPPED.get(el);
        if (!m) {
            m = new Map();
            WRAPPED.set(el, m);
        }
        return m;
    }

    function makeWrapped(el, type, original, opts) {
        const wrapped = function () {
            // Run their handler first
            try {
                return original.apply(this, arguments);
            } finally {
                if (inWindowFor(el)) {
                    // After their handler completes, re-assert play
                    Promise.resolve().then(() => kickIfPaused(el));
                    setTimeout(() => kickIfPaused(el), 0);
                }
            }
        };
        // For removeEventListener to work, we need to keep the mapping
        const key =
            type +
            '|' +
            (opts && typeof opts === 'object'
                ? JSON.stringify({
                      capture: !!opts.capture,
                      passive: !!opts.passive,
                      once: !!opts.once,
                  })
                : String(!!opts));
        const map = getMap(el);
        const byType = map.get(key) || new Map();
        byType.set(original, wrapped);
        map.set(key, byType);
        return wrapped;
    }

    function lookupWrapped(el, type, original, opts) {
        const key =
            type +
            '|' +
            (opts && typeof opts === 'object'
                ? JSON.stringify({
                      capture: !!opts.capture,
                      passive: !!opts.passive,
                      once: !!opts.once,
                  })
                : String(!!opts));
        const map = getMap(el).get(key);
        return map && map.get(original);
    }

    HTMLMediaElement.prototype.addEventListener = function (
        type,
        listener,
        opts
    ) {
        if (REPLAY_TYPES.has(String(type))) {
            const wrapped = makeWrapped(this, String(type), listener, opts);
            return NativeAddEv.call(this, type, wrapped, opts);
        }
        return NativeAddEv.call(this, type, listener, opts);
    };

    HTMLMediaElement.prototype.removeEventListener = function (
        type,
        listener,
        opts
    ) {
        if (REPLAY_TYPES.has(String(type))) {
            const wrapped = lookupWrapped(this, String(type), listener, opts);
            if (wrapped) {
                return NativeRemEv.call(this, type, wrapped, opts);
            }
        }
        return NativeRemEv.call(this, type, listener, opts);
    };

    // ---- Event-level nets ----
    addEventListener(
        'pause',
        (e) => {
            const el = e.target;
            if (el instanceof HTMLMediaElement && inWindowFor(el)) {
                // Let it bubble, then fix
                Promise.resolve().then(() => {
                    kickIfPaused(el);
                    playBurst(el);
                });
            }
        },
        true
    );

    // Media pipeline reloads / transitions
    ['emptied', 'loadedmetadata', 'canplay'].forEach((type) => {
        addEventListener(
            type,
            (e) => {
                const el = e.target;
                if (!(el instanceof HTMLMediaElement)) return;
                if (!inWindowFor(el)) return;
                // Slight delay to let the element become playable
                setTimeout(() => {
                    kickIfPaused(el);
                }, 10);
            },
            true
        );
    });

    // ---- SPA housekeeping ----
    function clearIfGone() {
        if (trackedVideo && !trackedVideo.isConnected) {
            trackedVideo = null;
            lastWasPlaying = false;
            windowUntil = 0;
            stopGuards();
        }
    }
    new MutationObserver(clearIfGone).observe(document.documentElement, {
        childList: true,
        subtree: true,
    });
    addEventListener('yt-navigate-finish', clearIfGone, true);

    addEventListener(
        'visibilitychange',
        () => {
            if (document.hidden) stopGuards();
        },
        true
    );
})();
