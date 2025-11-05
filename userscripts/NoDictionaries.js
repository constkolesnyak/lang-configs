// ==UserScript==
// @name         NoDictionaries
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  try to take over the world!
// @author       You
// @match        https://nodictionaries.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=nodictionaries.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    document.body.className='high-contrast';
    Effect.Highlight = Class.create(Effect.Base, {});

})();