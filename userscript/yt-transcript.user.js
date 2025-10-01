// ==UserScript==
// @name         YouTube Transcript Extractor (userscript)
// @namespace    https://github.com/withLinda/youtube-closed-caption-tool
// @version      1.0.0
// @description  Mirrors console.js: extracts YouTube captions, shows floating UI, and exports TXT/MD/PDF.
// @author       withLinda
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://youtube.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @require      https://raw.githubusercontent.com/withLinda/youtube-closed-caption-tool/main/console.js
// ==/UserScript==

/**
 * This userscript intentionally contains no logic.
 * It mirrors behavior by @requiring the canonical console.js (single source of truth).
 * If console.js is updated, users get the same behavior here without code drift.
 */

(function () {
  // Optional safety guard to prevent accidental double-initialization if Tampermonkey re-runs on SPA nav:
  const FLAG = '__YT_TRANSCRIPT_EXTRACTOR_USERSCRIPT__';
  if (window[FLAG]) return;
  window[FLAG] = true;
  // console.js is an IIFE and will execute automatically when required.
})();
