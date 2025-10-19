// ==UserScript==
// @name         YouTube i-key Anti-Pause (Prototype-level canceller)
// @namespace    constk.yt.antipause.v2
// @version      2.0
// @description  Cancels Migaku's pause when pressing "i" for miniplayer by neutralizing pause calls within a short window, only if the video was playing before the keypress.
// @match        https://www.youtube.com/*
// @match        https://youtu.be/*
// @run-at       document-start
// @all-frames   true
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---- Tunables ----
    // For how long after "i" we neutralize pause calls.
    const WINDOW_MS = 1200;

    // Which video counts as "main"? We’ll pick the largest visible one.
    function pickMainVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (!videos.length) return null;
        const score = (v) => {
            const r = v.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            const visible =
                area > 0 &&
                r.bottom > 0 &&
                r.right > 0 &&
                r.left < (window.innerWidth || 0) &&
                r.top < (window.innerHeight || 0);
            let s = area;
            if (visible) s += 1e6;
            if (!v.paused) s += 5e5;
            if (v.readyState >= 2) s += 2e5;
            return s;
        };
        return videos.sort((a, b) => score(b) - score(a))[0] || null;
    }

    function isEditable(target) {
        if (!target) return false;
        const tag = (target.tagName || '').toLowerCase();
        if (target.isContentEditable) return true;
        if (tag === 'input' || tag === 'textarea' || tag === 'select')
            return true;
        const root = target.getRootNode && target.getRootNode();
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

    // ---- State for one-shot protection window ----
    let windowUntil = 0; // timestamp when protection window ends
    let trackedVideo = null; // the main video at keypress
    let lastWasPlaying = false; // snapshot: was it playing before key press?

    // Snapshot state on keydown BEFORE others run
    window.addEventListener(
        'keydown',
        (e) => {
            if (!isBareIKey(e) || isEditable(e.target)) return;
            const v = pickMainVideo();
            if (!v) return;
            trackedVideo = v;
            lastWasPlaying = !v.paused;
            windowUntil = performance.now() + WINDOW_MS;
        },
        true
    ); // capture to beat other listeners for snapshot

    // ---- Prototype-level cancel: neutralize pause during window ----
    const NativePause = HTMLMediaElement.prototype.pause;
    const NativePlay = HTMLMediaElement.prototype.play;

    function shouldNeutralizePauseOn(el) {
        // Only during window, for the same tracked video, and only if it was playing before
        if (!el || el !== trackedVideo) return false;
        if (performance.now() > windowUntil) return false;
        if (!lastWasPlaying) return false;
        return true;
    }

    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function patchedPause() {
            // Let pause happen, but if we’re in the protection window, immediately play again.
            const el = this;
            const inWindow = shouldNeutralizePauseOn(el);

            // Call native pause first so we don't break miniplayer transitions that expect a pause moment.
            try {
                return NativePause.apply(el, arguments);
            } finally {
                if (inWindow) {
                    // Queue a microtask to restore playback reliably, still within the same user gesture context.
                    Promise.resolve().then(() => {
                        try {
                            if (el.paused) {
                                const p = NativePlay.call(el);
                                if (p && typeof p.catch === 'function')
                                    p.catch(() => {});
                            }
                        } catch {}
                    });
                }
            }
        },
    });

    // ---- Event-level safety net: resume on 'pause' event during window ----
    // Some players might not use HTMLMediaElement.pause directly (rare), so we also listen to the event.
    document.addEventListener(
        'pause',
        (e) => {
            const el = e.target;
            if (!(el instanceof HTMLMediaElement)) return;
            if (!shouldNeutralizePauseOn(el)) return;
            // One more attempt to play if still paused
            try {
                if (el.paused) {
                    const p = el.play();
                    if (p && typeof p.catch === 'function') p.catch(() => {});
                }
            } catch {}
        },
        true
    );

    // ---- Keep listeners on the current main video as it changes (YouTube swaps video elements) ----
    // We don’t need per-video listeners because the prototype patch + capture listener handles it,
    // but we *do* want trackedVideo to always be the main one at the moment of keypress.
    // Our pickMainVideo() call on keydown already does this; nothing else needed here.

    // ---- Optional: clear stale window if user navigates or player swaps ----
    const clearIfGone = () => {
        if (trackedVideo && !trackedVideo.isConnected) {
            trackedVideo = null;
            lastWasPlaying = false;
            windowUntil = 0;
        }
    };
    const mo = new MutationObserver(clearIfGone);
    mo.observe(document.documentElement, { childList: true, subtree: true });
})();
