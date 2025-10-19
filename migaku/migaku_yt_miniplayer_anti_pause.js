// ==UserScript==
// @name         YouTube i-key Anti-Pause (Migaku canceller)
// @namespace    constk.yt.antipause
// @version      1.0
// @description  When pressing "i" (miniplayer toggle) on YouTube, Migaku pauses; this replays if the video was playing before, so two pauses cancel out.
// @match        https://www.youtube.com/*
// @match        https://youtu.be/*
// @run-at       document-start
// @all-frames   true
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // --- config ---
  // Small delay lets other handlers (incl. Migaku) run first; tweak if needed.
  const AFTER_KEY_DELAY_MS = 60;

  // Ignore key events when user is typing/caret is in an input-ish element.
  function isEditable(target) {
    if (!target) return false;
    const tag = (target.tagName || "").toLowerCase();
    const editableTags = new Set(["input", "textarea", "select"]);
    if (editableTags.has(tag)) return true;
    if (target.isContentEditable) return true;
    // Also ignore when focused inside a shadow root editor (e.g. comment box)
    const root = target.getRootNode && target.getRootNode();
    return !!(root && root.host && root.host.isContentEditable);
  }

  function isBareIKey(e) {
    // YouTube uses lowercase 'i' in KeyboardEvent.key
    return (
      typeof e.key === "string" &&
      e.key.toLowerCase() === "i" &&
      !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
    );
  }

  function pickMainVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;

    // Prefer playing/ready & visible & largest area
    const score = v => {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const visible = area > 0 && rect.bottom > 0 && rect.right > 0 &&
                      rect.left < (window.innerWidth || 0) &&
                      rect.top < (window.innerHeight || 0);
      let s = area;
      if (visible) s += 1e6;
      if (!v.paused) s += 5e5;
      if (v.readyState >= 2) s += 2e5;
      return s;
    };

    return videos.sort((a,b) => score(b) - score(a))[0] || null;
  }

  // Track “was playing before the keypress”
  let lastWasPlaying = false;

  // Keydown first: capture playing state before Migaku/YouTube act
  window.addEventListener("keydown", (e) => {
    if (!isBareIKey(e) || isEditable(e.target)) return;
    const v = pickMainVideo();
    if (!v) return;
    lastWasPlaying = !v.paused; // true if it was playing right before "i"
    // Do NOT preventDefault — we want YT miniplayer toggle to still happen
  }, true); // capture to beat other listeners for the *snapshot* only

  // Keyup (or keydown again with a timeout) to restore play if Migaku paused it
  window.addEventListener("keyup", (e) => {
    if (!isBareIKey(e) || isEditable(e.target)) return;

    // Wait a tick so Migaku/YouTube handlers finish (Migaku pause happens fast)
    setTimeout(() => {
      const v = pickMainVideo();
      if (!v) return;

      // If it was playing before and is now paused, resume to cancel the pause.
      if (lastWasPlaying && v.paused) {
        // Some players need a direct call; ignore errors quietly.
        const p = v.play();
        if (p && typeof p.catch === "function") {
          p.catch(() => {/* ignore autoplay restrictions */});
        }
      }
    }, AFTER_KEY_DELAY_MS);
  }, false);

  // Also cover the case where sites only listen to keydown
  window.addEventListener("keydown", (e) => {
    if (!isBareIKey(e) || isEditable(e.target)) return;
    setTimeout(() => {
      const v = pickMainVideo();
      if (!v) return;
      if (lastWasPlaying && v.paused) {
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    }, AFTER_KEY_DELAY_MS);
  }, false);

})();
