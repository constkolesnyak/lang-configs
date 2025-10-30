// ==UserScript==
// @name         Anti-Pause YouTube
// @namespace    constk.yt.antipause.v3
// @version      3.0
// @description  Keep playback running when pressing "i" for miniplayer if the video was playing before. Neutralizes pause during a short window.
// @match        https://www.youtube.com/*
// @match        https://youtu.be/*
// @run-at       document-start
// @all-frames   true
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---- Tunables ----
    const WINDOW_MS = 1500; // how long after 'i' we neutralize pauses
    const BURST_MS = 250; // extra retry burst length after a pause
    const BURST_STEPS = [0, 16, 48, 96, 160, 240]; // ms offsets for retries

    // ---- Utils ----
    const now = () => performance.now();

    function pickMainVideo() {
        const vids = Array.from(document.querySelectorAll('video'));
        if (!vids.length) return null;
        const w = window.innerWidth || 0,
            h = window.innerHeight || 0;
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

    // ---- State ----
    let windowUntil = 0;
    let trackedVideo = null;
    let lastWasPlaying = false;

    // Snapshot BEFORE others (capture)
    window.addEventListener(
        'keydown',
        (e) => {
            if (!isBareIKey(e) || isEditable(e.target)) return;
            const v = pickMainVideo();
            if (!v) return;
            trackedVideo = v;
            lastWasPlaying = !v.paused;
            windowUntil = now() + WINDOW_MS;
        },
        true
    );

    // ---- Robust play() attempts ----
    function safePlay(el) {
        try {
            const p = el.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {}
    }

    function playBurst(el) {
        // rAF first (keeps user-gesture-ish timing tighter), then staggered timeouts
        try {
            requestAnimationFrame(() => safePlay(el));
        } catch {}
        BURST_STEPS.forEach((ms) => setTimeout(() => safePlay(el), ms));
    }

    function inProtectionWindowFor(el) {
        return !!(
            el &&
            el === trackedVideo &&
            lastWasPlaying &&
            now() <= windowUntil
        );
    }

    // ---- Patch pause() early + make hard to clobber ----
    const NativePause = HTMLMediaElement.prototype.pause;
    const NativePlay = HTMLMediaElement.prototype.play;

    function patchedPause() {
        const el = this;
        const protect = inProtectionWindowFor(el);

        // Call native pause so YouTube's miniplayer transition logic still sees a pause moment.
        const ret = NativePause.apply(el, arguments);

        if (protect) {
            // Try immediately and then a brief burst to race any late pausers.
            safePlay(el);
            playBurst(el);
            // Extend a tiny sub-window so late calls inside the same gesture still get covered.
            windowUntil = Math.max(windowUntil, now() + BURST_MS);
        }
        return ret;
    }

    // Define once, non-configurable & non-writable so other scripts can't replace it later.
    // (They can still keep a cached reference, but most don't.)
    try {
        Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
            value: patchedPause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    } catch {
        // Fallback if engine disallows; at least assign (might be overwritten later).
        HTMLMediaElement.prototype.pause = patchedPause;
    }

    // ---- Event-level safety net ----
    document.addEventListener(
        'pause',
        (e) => {
            const el = e.target;
            if (!(el instanceof HTMLMediaElement)) return;
            if (!inProtectionWindowFor(el)) return;
            safePlay(el);
            playBurst(el);
        },
        true
    );

    // ---- Auto-unpause on playlist transitions ----
    let shouldAutoPlay = false;
    let autoPlayTimeout = null;

    // When a video ends naturally, mark that we want autoplay
    document.addEventListener(
        'ended',
        (e) => {
            const el = e.target;
            if (!(el instanceof HTMLMediaElement)) return;
            shouldAutoPlay = true;
            // Clear flag after 5 seconds if nothing happens
            clearTimeout(autoPlayTimeout);
            autoPlayTimeout = setTimeout(() => {
                shouldAutoPlay = false;
            }, 5000);
        },
        true
    );

    // When the next video is ready to play, unpause it if we're in autoplay mode
    document.addEventListener(
        'canplay',
        (e) => {
            const el = e.target;
            if (!(el instanceof HTMLMediaElement)) return;
            if (shouldAutoPlay && el.paused) {
                safePlay(el);
                playBurst(el);
            }
        },
        true
    );

    // Clear the flag when video actually starts playing
    document.addEventListener(
        'playing',
        (e) => {
            const el = e.target;
            if (!(el instanceof HTMLMediaElement)) return;
            if (shouldAutoPlay && !el.paused) {
                shouldAutoPlay = false;
                clearTimeout(autoPlayTimeout);
            }
        },
        true
    );

    // ---- Clean up stale tracked video on SPA swaps ----
    const clearIfGone = () => {
        if (trackedVideo && !trackedVideo.isConnected) {
            trackedVideo = null;
            lastWasPlaying = false;
            windowUntil = 0;
        }
    };
    const mo = new MutationObserver(clearIfGone);
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // Also clear on yt-navigate
    window.addEventListener('yt-navigate-finish', clearIfGone, true);
})();
