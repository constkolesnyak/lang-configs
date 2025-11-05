// ==UserScript==
// @name         MediaFire Folder to CSV
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Scroll through a MediaFire folder, collect file name, downloads, size (MB), URL and modified date, and export them to CSV
// @match        https://www.mediafire.com/folder/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Parse downloads and size_mb from either title or li text
    function parseStats(fullTitle, liText) {
        let downloads = '';
        let size_mb = '';

        // Try parsing from title first
        if (fullTitle) {
            const downloadsMatch = fullTitle.match(/Downloads:\s*([\d,]+)/i);
            if (downloadsMatch) {
                downloads = downloadsMatch[1].replace(/,/g, '');
            }
            const sizeMatch = fullTitle.match(
                /Size:\s*([\d\.]+)\s*(GB|MB|KB)/i
            );
            if (sizeMatch) {
                let size = parseFloat(sizeMatch[1]);
                const unit = sizeMatch[2].toUpperCase();
                if (unit === 'GB') {
                    size = size * 1024;
                } else if (unit === 'KB') {
                    size = size / 1024;
                }
                size_mb = String(Math.round(size * 1000) / 1000);
            }
        }

        // If not found in title, try li text
        if (!downloads || !size_mb) {
            const downloadsMatch2 =
                liText && liText.match(/Downloads:\s*([\d,]+)/i);
            if (downloadsMatch2) {
                downloads = downloadsMatch2[1].replace(/,/g, '');
            }
            const sizeMatch2 =
                liText && liText.match(/Size:\s*([\d\.]+)\s*(GB|MB|KB)/i);
            if (sizeMatch2) {
                let size = parseFloat(sizeMatch2[1]);
                const unit = sizeMatch2[2].toUpperCase();
                if (unit === 'GB') {
                    size = size * 1024;
                } else if (unit === 'KB') {
                    size = size / 1024;
                }
                size_mb = String(Math.round(size * 1000) / 1000);
            }
        }

        return { downloads, size_mb };
    }

    // Collect visible files into resultMap
    function collectVisibleFiles(resultMap) {
        const anchors = Array.from(
            document.querySelectorAll('a[href*="/file"]')
        ).filter((a) => a.getAttribute('title'));
        anchors.forEach((a) => {
            const url = a.href;
            if (resultMap.has(url)) return;
            const fullTitle = a.getAttribute('title');
            const name = fullTitle.split(',')[0].trim();
            const li = a.closest('li');
            const liText = li ? li.textContent : '';
            const { downloads, size_mb } = parseStats(fullTitle, liText);
            const modMatch = liText.match(
                /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/
            );
            const modified = modMatch ? modMatch[0] : '';
            resultMap.set(url, { name, downloads, size_mb, url, modified });
        });
    }

    // Scroll down by adjusting documentElement.scrollTop and collect new entries
    async function scrollAndCollectAll() {
        // Scroll to the very top first
        document.documentElement.scrollTop = 0;
        await wait(1000);

        const resultMap = new Map();
        let unchanged = 0;
        let prevY = -1;
        while (unchanged < 3) {
            collectVisibleFiles(resultMap);

            // Scroll down by 70% of viewport height
            const increment = Math.floor(window.innerHeight * 0.7);
            document.documentElement.scrollTop += increment;

            await wait(1500);

            const currentY = document.documentElement.scrollTop;
            if (currentY === prevY) {
                unchanged++;
            } else {
                unchanged = 0;
                prevY = currentY;
            }
        }

        // Final collection
        collectVisibleFiles(resultMap);
        return Array.from(resultMap.values());
    }

    function toCSV(items) {
        const lines = ['name,downloads,size_mb,url,modified'];
        items.forEach((item) => {
            const n = item.name.replace(/"/g, '""');
            const d = item.downloads;
            const s = item.size_mb;
            const u = item.url.replace(/"/g, '""');
            const m = item.modified.replace(/"/g, '""');
            lines.push(`"${n}",${d},${s},"${u}","${m}"`);
        });
        return lines.join('\n');
    }

    function downloadCSV(csvText, filename = 'mediafire_folder.csv') {
        const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    async function runExport(button) {
        try {
            button.disabled = true;
            button.textContent = 'Collecting...';
            const rows = await scrollAndCollectAll();
            button.textContent = 'Creating CSV...';
            const csv = toCSV(rows);
            downloadCSV(csv);
        } finally {
            button.disabled = false;
            button.textContent = 'Export CSV';
        }
    }

    function addExportButton() {
        const button = document.createElement('button');
        button.textContent = 'Export CSV';
        Object.assign(button.style, {
            position: 'fixed',
            bottom: '10px',
            right: '10px',
            padding: '10px 15px',
            zIndex: 10000,
            backgroundColor: '#007bff',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
        });
        button.addEventListener('click', () => runExport(button));
        document.body.appendChild(button);
    }

    window.addEventListener('load', addExportButton);
})();
