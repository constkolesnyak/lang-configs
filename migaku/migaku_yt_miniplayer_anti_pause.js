// ==UserScript==
// @name         Anti-Pause YouTube
// @namespace    constk.yt.antipause.v3
// @version      3.5
// @description  No-op pause() during 'i' and handoffs. Works in all views (default/theater/fullscreen/miniplayer). Also guards playlist/SPA handoffs.
// @match        https://www.youtube.com/*
// @match        https://youtu.be/*
// @run-at       document-start
// @all-frames   true
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---- Tunables ----
    const MINIPLAYER_WINDOW_MS = 2500; // coverage after 'i'
    const MICRO_EXTEND_MS = 400;
    const PLAYLIST_HANDOFF_MS = 7000;
    const GUARD_INTERVAL_MS = 40;
    const BURST_STEPS = [0, 16, 32, 64, 96, 160, 240, 360, 480, 640];
    const I_COMBO_GRACE_MS = 240; // presses within this merge
    const POST_KEY_KICKS_MS = [0, 24, 48, 96, 160, 240];

    // ---- Utils ----
    const now = () => performance.now();
    const isEditable = (t) => {
        if (!t) return false;
        const tag = (t.tagName || '').toLowerCase();
        if (t.isContentEditable) return true;
        if (tag === 'input' || tag === 'textarea' || tag === 'select')
            return true;
        const root = t.getRootNode && t.getRootNode();
        return !!(root && root.host && root.host.isContentEditable);
    };
    const isBareIKey = (e) =>
        typeof e.key === 'string' &&
        e.key.toLowerCase() === 'i' &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey;

    function pickMainVideo() {
        // Prefer the main player if present; otherwise best visible
        const prefer = document.querySelector(
            'video.html5-main-video, #movie_player video, ytd-player video'
        );
        if (prefer) return prefer;
        const vids = Array.from(document.querySelectorAll('video'));
        let best = null,
            bestScore = -1;
        const w = innerWidth || 0,
            h = innerHeight || 0;
        for (const v of vids) {
            const r = v.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            const vis =
                area > 0 &&
                r.bottom > 0 &&
                r.right > 0 &&
                r.left < w &&
                r.top < h;
            let s =
                area +
                (vis ? 1e6 : 0) +
                (!v.paused ? 5e5 : 0) +
                (v.readyState >= 2 ? 2e5 : 0);
            if (s > bestScore) {
                best = v;
                bestScore = s;
            }
        }
        return best;
    }

    function urlHasPlaylist(u) {
        try {
            const url = new URL(u, location.href);
            return (
                url.pathname.includes('/watch') &&
                (url.searchParams.has('list') || url.searchParams.has('index'))
            );
        } catch {
            return false;
        }
    }

    // ---- State ----
    let trackedVideo = null;
    let lastWasPlaying = false;

    let miniplayerUntil = 0; // after 'i' (only if it was playing)
    let handoffUntil = 0; // playlist / SPA handoff

    // i-combo shield
    let iComboUntil = 0; // always set on 'i'
    let iComboLatchedPlay = false; // latched "was playing" for the burst
    let lastIPressAt = 0;

    // Guards
    let guardInterval = null,
        guardRAF = false;

    // Native refs
    const NativePause = HTMLMediaElement.prototype.pause;
    const NativePlay = HTMLMediaElement.prototype.play;
    const NativeAddEv = HTMLMediaElement.prototype.addEventListener;
    const NativeRemEv = HTMLMediaElement.prototype.removeEventListener;

    // ---- Windows & checks ----
    const inMini = () => now() <= miniplayerUntil;
    const inHandoff = () => now() <= handoffUntil;
    const inICombo = () => now() <= iComboUntil && iComboLatchedPlay;

    // IMPORTANT: during i-combo, protect *any* <video>; otherwise protect the tracked one
    function isProtected(el) {
        if (!(el instanceof HTMLMediaElement)) return false;
        if (inICombo()) return true;
        const win = inMini() || inHandoff();
        return win && (trackedVideo ? el === trackedVideo : true);
    }

    function extendMini(ms) {
        miniplayerUntil = Math.max(miniplayerUntil, now() + ms);
    }
    function extendHandoff(ms) {
        handoffUntil = Math.max(handoffUntil, now() + ms);
    }
    function extendICombo(ms) {
        iComboUntil = Math.max(iComboUntil, now() + ms);
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
        for (const ms of BURST_STEPS) setTimeout(() => safePlay(el), ms);
    }
    function postKeyKicks(el) {
        for (const ms of POST_KEY_KICKS_MS) setTimeout(() => safePlay(el), ms);
    }

    function ensureGuards() {
        if (inMini() || inHandoff() || inICombo()) {
            if (!guardInterval && !guardRAF) {
                guardInterval = setInterval(() => {
                    const vids = document.querySelectorAll('video');
                    vids.forEach((v) => {
                        if (isProtected(v) && v.paused) safePlay(v);
                    });
                }, GUARD_INTERVAL_MS);
                guardRAF = true;
                const loop = () => {
                    if (!guardRAF) return;
                    const vids = document.querySelectorAll('video');
                    vids.forEach((v) => {
                        if (isProtected(v) && v.paused) safePlay(v);
                    });
                    requestAnimationFrame(loop);
                };
                requestAnimationFrame(loop);
            }
        } else {
            if (guardInterval) {
                clearInterval(guardInterval);
                guardInterval = null;
            }
            guardRAF = false;
        }
    }

    function bindPlayStateWatchers(el) {
        if (!el) return;
        el.addEventListener(
            'playing',
            () => {
                if (el === trackedVideo) lastWasPlaying = true;
            },
            { capture: true }
        );
        el.addEventListener(
            'pause',
            () => {
                if (el === trackedVideo) lastWasPlaying = false;
            },
            { capture: true }
        );
    }

    function refreshTrackedVideo() {
        const v = pickMainVideo();
        if (v && v !== trackedVideo) {
            trackedVideo = v;
            bindPlayStateWatchers(v);
            if (inHandoff() || inICombo())
                setTimeout(() => {
                    if (v.paused) playBurst(v);
                }, 10);
        }
    }

    // ---- i-combo shield (keydown + keyup) ----
    function handleIPress(e) {
        if (!isBareIKey(e) || isEditable(e.target)) return;
        const v = pickMainVideo();
        if (v) trackedVideo = v;

        const t = now();
        const newCombo = t - lastIPressAt > I_COMBO_GRACE_MS;
        if (newCombo) {
            iComboLatchedPlay = v ? !v.paused : true; // if we can't read, assume true
        } else {
            iComboLatchedPlay = iComboLatchedPlay || (v ? !v.paused : true);
        }
        lastIPressAt = t;

        extendICombo(MINIPLAYER_WINDOW_MS);
        if (v && !v.paused) {
            lastWasPlaying = true;
            extendMini(MINIPLAYER_WINDOW_MS);
        }
        ensureGuards();
        if (v) postKeyKicks(v);
    }
    addEventListener('keydown', handleIPress, true);
    addEventListener('keyup', handleIPress, true);

    // ---- Playlist / SPA triggers ----
    addEventListener(
        'ended',
        (e) => {
            const el = e.target;
            if (!(el instanceof HTMLMediaElement)) return;
            if (!el.loop && !el.paused) {
                handoffUntil = now() + PLAYLIST_HANDOFF_MS;
                ensureGuards();
            }
        },
        true
    );

    addEventListener(
        'click',
        (e) => {
            let n = e.target,
                playlistClick = false;
            for (let i = 0; n && i < 6; i++, n = n.parentNode) {
                const tn = (n.tagName || '').toUpperCase();
                if (
                    tn.startsWith('YTD-') &&
                    (tn.includes('PLAYLIST') || tn.includes('QUEUE'))
                ) {
                    playlistClick = true;
                    break;
                }
            }
            if (playlistClick) {
                handoffUntil = now() + PLAYLIST_HANDOFF_MS;
                ensureGuards();
            }
        },
        true
    );

    (function wrapHistory() {
        const HP = history.pushState,
            HR = history.replaceState;
        function handleURL(u) {
            if (urlHasPlaylist(u || location.href)) {
                handoffUntil = now() + PLAYLIST_HANDOFF_MS;
                ensureGuards();
            }
        }
        history.pushState = function () {
            const r = HP.apply(this, arguments);
            handleURL(arguments[2]);
            return r;
        };
        history.replaceState = function () {
            const r = HR.apply(this, arguments);
            handleURL(arguments[2]);
            return r;
        };
        addEventListener('popstate', () => handleURL(location.href), true);
    })();

    addEventListener(
        'yt-navigate-start',
        () => {
            handoffUntil = now() + PLAYLIST_HANDOFF_MS;
            ensureGuards();
        },
        true
    );

    [
        'emptied',
        'loadstart',
        'loadedmetadata',
        'canplay',
        'durationchange',
    ].forEach((type) => {
        addEventListener(
            type,
            () => {
                refreshTrackedVideo();
            },
            true
        );
    });

    // ---- HARDENING: make pause() a NO-OP during protection windows ----
    function patchedPause() {
        const el = this;
        if (isProtected(el)) {
            // Skip native pause entirely; immediately reinforce play.
            Promise.resolve().then(() => safePlay(el));
            return; // no-op
        }
        return NativePause.apply(el, arguments);
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

    // Also wrap pause-like events to re-assert if anything slips
    const REPLAY_TYPES = new Set(['pause', 'suspend', 'stalled', 'waiting']);
    addEventListener(
        'pause',
        (e) => {
            const el = e.target;
            if (el instanceof HTMLMediaElement && isProtected(el)) {
                // keep it playing aggressively
                safePlay(el);
                playBurst(el);
                extendMini(MICRO_EXTEND_MS);
                extendHandoff(MICRO_EXTEND_MS);
                extendICombo(MICRO_EXTEND_MS);
                ensureGuards();
            }
        },
        true
    );

    // ---- Housekeeping ----
    new MutationObserver(() => {
        refreshTrackedVideo();
    }).observe(document.documentElement, { childList: true, subtree: true });

    addEventListener(
        'yt-navigate-finish',
        () => {
            refreshTrackedVideo();
        },
        true
    );

    addEventListener(
        'visibilitychange',
        () => {
            if (document.hidden) {
                if (guardInterval) {
                    clearInterval(guardInterval);
                    guardInterval = null;
                }
                guardRAF = false;
            } else ensureGuards();
        },
        true
    );
})();
