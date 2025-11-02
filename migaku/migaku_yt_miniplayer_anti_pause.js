// ==UserScript==
// @name         Anti-Pause YouTube (aggressive + playlist continuity)
// @namespace    constk.yt.antipause.v3
// @version      3.3
// @description  Prevents unwanted pauses (miniplayer + playlist). Re-asserts play during protected windows, wraps pause listeners, guards across SPA/playlist handoffs.
// @match        https://www.youtube.com/*
// @match        https://youtu.be/*
// @run-at       document-start
// @all-frames   true
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---- Tunables ----
    const MINIPLAYER_WINDOW_MS = 2500; // after 'i'
    const MICRO_EXTEND_MS = 400; // extend on detected late pause
    const PLAYLIST_HANDOFF_MS = 7000; // protection window after playlist/queue handoff
    const BURST_STEPS = [0, 16, 48, 96, 160, 240, 320, 480];
    const GUARD_INTERVAL_MS = 50;

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

    // Protection windows:
    let miniplayerUntil = 0; // set after 'i' if it was playing
    let handoffUntil = 0; // playlist/queue/navigation handoff

    // Guards
    let guardInterval = null;
    let guardRAFActive = false;

    // Native refs
    const NativePause = HTMLMediaElement.prototype.pause;
    const NativePlay = HTMLMediaElement.prototype.play;
    const NativeAddEv = HTMLMediaElement.prototype.addEventListener;
    const NativeRemEv = HTMLMediaElement.prototype.removeEventListener;

    // ---- Core helpers ----
    function inAnyWindowFor(el) {
        const t = now();
        return !!(
            el &&
            el === trackedVideo &&
            lastWasPlaying &&
            (t <= miniplayerUntil || t <= handoffUntil)
        );
    }

    function extendMini(ms) {
        miniplayerUntil = Math.max(miniplayerUntil, now() + ms);
    }
    function extendHandoff(ms) {
        handoffUntil = Math.max(handoffUntil, now() + ms);
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

    function kickIfPaused(el, extendMs = MICRO_EXTEND_MS) {
        if (!el) return;
        if (!inAnyWindowFor(el)) return;
        if (el.paused) {
            safePlay(el);
            if (now() <= miniplayerUntil) extendMini(extendMs);
            if (now() <= handoffUntil) extendHandoff(extendMs);
        }
    }

    function startGuards() {
        stopGuards();
        guardInterval = setInterval(() => {
            if (!trackedVideo) {
                stopGuards();
                return;
            }
            if (now() > miniplayerUntil && now() > handoffUntil) {
                stopGuards();
                return;
            }
            kickIfPaused(trackedVideo);
        }, GUARD_INTERVAL_MS);

        guardRAFActive = true;
        const loop = () => {
            if (!guardRAFActive) return;
            if (
                !trackedVideo ||
                (now() > miniplayerUntil && now() > handoffUntil)
            ) {
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

    function ensureGuardsRunning() {
        if (now() <= miniplayerUntil || now() <= handoffUntil) {
            if (!guardInterval && !guardRAFActive) startGuards();
        }
    }

    // Keep lastWasPlaying in sync with the *current* main video
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

    // Detect new main video and refresh tracking
    function refreshTrackedVideo() {
        const v = pickMainVideo();
        if (v && v !== trackedVideo) {
            trackedVideo = v;
            // If we come into a new video during a playlist handoff, we want to auto-assert play
            bindPlayStateWatchers(v);
            if (now() <= handoffUntil) {
                // Wait for it to become playable, then kick
                setTimeout(() => {
                    if (v.paused) {
                        safePlay(v);
                        playBurst(v);
                    }
                }, 10);
            }
        }
    }

    // ---- MINIPLAYER: capture snapshot BEFORE site handlers ----
    addEventListener(
        'keydown',
        (e) => {
            if (!isBareIKey(e) || isEditable(e.target)) return;
            const v = pickMainVideo();
            if (!v) return;
            trackedVideo = v;
            lastWasPlaying = !v.paused;
            if (lastWasPlaying) {
                miniplayerUntil = now() + MINIPLAYER_WINDOW_MS;
                ensureGuardsRunning();
            } else {
                miniplayerUntil = 0;
            }
        },
        true
    );

    // ---- PLAYLIST HANDOFF TRIGGERS ----

    // 1) When current video ends naturally, expect an auto-advance handoff
    addEventListener(
        'ended',
        (e) => {
            const el = e.target;
            if (!(el instanceof HTMLMediaElement)) return;
            if (el === trackedVideo) {
                if (!el.loop) {
                    // if looping, don't handoff
                    // Only treat as handoff if we were actually playing
                    if (!el.paused) {
                        lastWasPlaying = true;
                        handoffUntil = now() + PLAYLIST_HANDOFF_MS;
                        ensureGuardsRunning();
                    }
                }
            }
        },
        true
    );

    // 2) Clicks inside playlist/queue side panel while video is currently playing
    addEventListener(
        'click',
        (e) => {
            // Be conservative: any click inside a container whose tag starts with 'YTD-' and contains 'PLAYLIST' likely triggers a playlist jump.
            let n = e.target;
            let playlistClick = false;
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
            if (!playlistClick) return;
            const v = pickMainVideo();
            if (v && !v.paused) {
                trackedVideo = v;
                lastWasPlaying = true;
                handoffUntil = now() + PLAYLIST_HANDOFF_MS;
                ensureGuardsRunning();
            }
        },
        true
    );

    // 3) SPA URL changes (pushState/replaceState/popstate) to a watch URL with playlist params
    (function wrapHistory() {
        const HP = history.pushState;
        const HR = history.replaceState;
        function handleURL(u) {
            if (urlHasPlaylist(u || location.href)) {
                const v = pickMainVideo();
                if (v && !v.paused) {
                    trackedVideo = v;
                    lastWasPlaying = true;
                    handoffUntil = now() + PLAYLIST_HANDOFF_MS;
                    ensureGuardsRunning();
                }
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

    // 4) YouTube’s internal navigation events
    addEventListener(
        'yt-navigate-start',
        () => {
            const v = pickMainVideo();
            if (v && !v.paused) {
                trackedVideo = v;
                lastWasPlaying = true;
                handoffUntil = now() + PLAYLIST_HANDOFF_MS;
                ensureGuardsRunning();
            }
        },
        true
    );

    // When a new media pipeline appears/changes during handoff, assert play
    [
        'emptied',
        'loadstart',
        'loadedmetadata',
        'canplay',
        'durationchange',
    ].forEach((type) => {
        addEventListener(
            type,
            (e) => {
                const el = e.target;
                if (!(el instanceof HTMLMediaElement)) return;
                refreshTrackedVideo(); // catch new <video> nodes
                if (now() <= handoffUntil && el === trackedVideo) {
                    setTimeout(() => {
                        kickIfPaused(el);
                    }, 10);
                }
            },
            true
        );
    });

    // ---- Monkey-patch pause() and wrap pause-like listeners (same hardening as v3.2) ----
    function patchedPause() {
        const el = this;
        const protect = inAnyWindowFor(el);
        const ret = NativePause.apply(el, arguments);
        if (protect) {
            Promise.resolve().then(() => {
                kickIfPaused(el);
                playBurst(el);
            });
            setTimeout(() => {
                kickIfPaused(el);
            }, 0);
            // Micro-extend whichever window(s) are active
            if (now() <= miniplayerUntil) extendMini(MICRO_EXTEND_MS);
            if (now() <= handoffUntil) extendHandoff(MICRO_EXTEND_MS);
            ensureGuardsRunning();
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

    const REPLAY_TYPES = new Set(['pause', 'suspend', 'stalled', 'waiting']);
    const WRAPPED = new WeakMap(); // el -> Map<key, Map<orig, wrapped>>
    function getMap(el) {
        let m = WRAPPED.get(el);
        if (!m) {
            m = new Map();
            WRAPPED.set(el, m);
        }
        return m;
    }
    function keyFor(type, opts) {
        return (
            type +
            '|' +
            (opts && typeof opts === 'object'
                ? JSON.stringify({
                      capture: !!opts.capture,
                      passive: !!opts.passive,
                      once: !!opts.once,
                  })
                : String(!!opts))
        );
    }
    function makeWrapped(el, type, original, opts) {
        const wrapped = function () {
            try {
                return original.apply(this, arguments);
            } finally {
                if (inAnyWindowFor(el)) {
                    Promise.resolve().then(() => kickIfPaused(el));
                    setTimeout(() => kickIfPaused(el), 0);
                    ensureGuardsRunning();
                }
            }
        };
        const map = getMap(el);
        const k = keyFor(type, opts);
        const byType = map.get(k) || new Map();
        byType.set(original, wrapped);
        map.set(k, byType);
        return wrapped;
    }
    function lookupWrapped(el, type, original, opts) {
        const map = getMap(el).get(keyFor(type, opts));
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
            if (wrapped) return NativeRemEv.call(this, type, wrapped, opts);
        }
        return NativeRemEv.call(this, type, listener, opts);
    };

    // Event-level net
    addEventListener(
        'pause',
        (e) => {
            const el = e.target;
            if (el instanceof HTMLMediaElement && inAnyWindowFor(el)) {
                Promise.resolve().then(() => {
                    kickIfPaused(el);
                    playBurst(el);
                });
                ensureGuardsRunning();
            }
        },
        true
    );

    // ---- SPA housekeeping ----
    function clearIfGone() {
        if (trackedVideo && !trackedVideo.isConnected) {
            trackedVideo = null;
            lastWasPlaying = false;
            miniplayerUntil = 0;
            handoffUntil = 0;
            stopGuards();
        }
    }
    new MutationObserver(() => {
        clearIfGone();
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
            if (document.hidden) stopGuards();
            else ensureGuardsRunning();
        },
        true
    );
})();
