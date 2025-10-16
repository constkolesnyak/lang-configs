// ==UserScript==
// @name         thelatinlibrary
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  try to take over the world!
// @author       You
// @match        http://www.thelatinlibrary.com/plautus/amphitruo.shtml
// @icon         https://www.google.com/s2/favicons?sz=64&domain=thelatinlibrary.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
// Get all <font> elements within the parent element
const fontElements = document.querySelectorAll("font");

// Loop through the <font> elements and remove them from the DOM
fontElements.forEach((fontElement) => {
  // Remove the <font> element from the DOM
  fontElement.remove();
});

// Get the innerHTML of the parent element
const originalHTML = document.documentElement.innerHTML;

// Replace all occurrences of '&nbsp;' with regular spaces in the innerHTML
const modifiedHTML = originalHTML.replace(/&nbsp;/g, '');

// Update the innerHTML of the parent element with the modified content
document.documentElement.innerHTML = modifiedHTML;






// Get the entire innerHTML of the DOM
const entireInnerHTML = document.documentElement.innerHTML;

// Use a regular expression to remove unnecessary quotes from attributes
const modifiedInnerHTML = entireInnerHTML.replace(/(\w+)="([^"]*?)"/g, (match, attr, value) => {
  if (!/\s/.test(value)) {
    // If the attribute value does not contain whitespace, remove the quotes
    return `${attr}=${value}`;
  } else {
    // Otherwise, keep the quotes as they are
    return match;
  }
});

// Update the innerHTML of the DOM with the modified content
document.documentElement.innerHTML = modifiedInnerHTML;

})();