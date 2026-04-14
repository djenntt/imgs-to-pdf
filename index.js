const puppeteer = require('puppeteer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const rimraf = require('rimraf');

// XTC conversion modules
const { applyDithering } = require('./src/dithering');
const { pixelsToXtg, pixelsToXth } = require('./src/xtg');
const { buildXtc } = require('./src/xtc');
const { loadAndProcessImage } = require('./src/image-processing');

/**
 * Download an image using the browser's fetch (keeps cookies/referer intact).
 * Falls back to navigating directly to the image URL if fetch fails.
 */
async function downloadImageViaBrowser(page, imageUrl, savePath) {
    // Try 1: fetch with Referer header (works for most CDNs)
    const result = await page.evaluate(async (url) => {
        try {
            const resp = await fetch(url, {
                headers: { 'Referer': document.location.href },
                credentials: 'include'
            });
            if (!resp.ok) return { error: `HTTP ${resp.status}` };
            const blob = await resp.blob();
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            return { base64 };
        } catch (e) {
            return { error: e.message };
        }
    }, imageUrl);

    if (result.base64) {
        fs.writeFileSync(savePath, Buffer.from(result.base64, 'base64'));
        return;
    }

    // Try 2: extract from already-loaded <img> via canvas
    const canvasResult = await page.evaluate(async (url) => {
        // Find an img element whose src or data-src matches this URL
        const imgs = Array.from(document.querySelectorAll('img'));
        const img = imgs.find(i => {
            const src = i.src || '';
            const dataSrc = i.getAttribute('data-src') || '';
            // Match by stripping query params for comparison
            const urlBase = url.split('?')[0];
            return src.split('?')[0] === urlBase || dataSrc.split('?')[0] === urlBase;
        });

        if (!img || !img.complete || img.naturalWidth === 0) return { error: 'Image not found or not loaded' };

        try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
            return { base64: dataUrl.split(',')[1] };
        } catch (e) {
            return { error: e.message };
        }
    }, imageUrl);

    if (canvasResult.base64) {
        fs.writeFileSync(savePath, Buffer.from(canvasResult.base64, 'base64'));
        return;
    }

    // Try 3: open image URL directly in a new page with proper referer
    const browser = page.browser();
    const imgPage = await browser.newPage();
    try {
        await imgPage.setExtraHTTPHeaders({ 'Referer': page.url() });
        const response = await imgPage.goto(imageUrl, { waitUntil: 'load', timeout: 30000 });
        if (!response || !response.ok()) {
            throw new Error(`HTTP ${response ? response.status() : 'no response'}`);
        }
        const buffer = await response.buffer();
        fs.writeFileSync(savePath, buffer);
    } finally {
        await imgPage.close();
    }
}

/**
 * Launch Puppeteer, scrape image URLs, download them, and save cache metadata.
 * Returns true on success, false on failure.
 *
 * Uses two strategies:
 *   1. Primary: fetch images via page.evaluate (works for most CDNs)
 *   2. Fallback: capture images via CDP network interception during page load
 *      (works when CDN blocks fetch/canvas/direct navigation)
 */
async function downloadFromPage(url, cssSelector, imagesFolderPath, metaPath, errors) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox'
        ]
    });
    const page = await browser.newPage();

    // Mask headless detection
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Set up CDP to intercept image responses as they load
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    const capturedImages = new Map(); // url (without query) -> { requestId, url }

    client.on('Network.responseReceived', (event) => {
        const { requestId, response } = event;
        const mimeType = response.mimeType || '';
        if (mimeType.startsWith('image/')) {
            const urlBase = response.url.split('?')[0];
            capturedImages.set(urlBase, { requestId, url: response.url });
        }
    });

    // Navigate to the URL, retrying if we get redirected to an ad/popup
    const targetDomain = new URL(url).hostname;
    const MAX_NAV_ATTEMPTS = 10;

    for (let navAttempt = 1; navAttempt <= MAX_NAV_ATTEMPTS; navAttempt++) {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const currentHostname = (() => { try { return new URL(page.url()).hostname; } catch { return ''; } })();

        if (currentHostname === targetDomain) break;

        if (navAttempt < MAX_NAV_ATTEMPTS) {
            console.log(`  Redirected to ${currentHostname}, retrying navigation... (${navAttempt}/${MAX_NAV_ATTEMPTS})`);
        } else {
            console.error(`  Could not reach ${targetDomain} after ${MAX_NAV_ATTEMPTS} attempts, stuck on ${currentHostname}`);
        }
    }

    // Debug: log what the page actually looks like
    const pageTitle = await page.title();
    const imgCount = await page.evaluate((sel) => document.querySelectorAll(sel).length, cssSelector);
    const allImgCount = await page.evaluate(() => document.querySelectorAll('img').length);
    console.log(`  Page title: "${pageTitle}"`);
    console.log(`  Total <img> on page: ${allImgCount}, matching selector: ${imgCount}`);
    if (imgCount === 0) {
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
        console.log(`  Page text preview: ${bodyText.slice(0, 200)}`);
    }

    // Quick scroll to trigger lazy images
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 500;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= document.body.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
    await new Promise(r => setTimeout(r, 2000));

    const imageUrls = await page.evaluate((selector) => {
        const images = Array.from(document.querySelectorAll(selector));
        return images.map(img => img.getAttribute('data-src') || img.src).filter(src => src && src !== 'about:blank');
    }, cssSelector);

    console.log(`  Found ${imageUrls.length} images`);

    let downloadedCount = 0;
    let failed = false;
    const failedIndices = []; // track which images failed the fast method

    // === PASS 1: Fast fetch method ===
    for (let j = 0; j < imageUrls.length; j++) {
        const imageUrl = imageUrls[j];
        const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
        const fileName = `${String(j + 1).padStart(4, '0')}${ext}`;
        const savePath = path.join(imagesFolderPath, fileName);

        try {
            await downloadImageViaBrowser(page, imageUrl, savePath);
            downloadedCount++;
            process.stdout.write(`  Downloaded [${j + 1}/${imageUrls.length}] ${fileName}\r`);
        } catch (fetchError) {
            failedIndices.push(j);
        }
    }

    // === PASS 2: CDP fallback for anything that failed ===
    if (failedIndices.length > 0) {
        console.log(`\n  Fast method got ${downloadedCount}/${imageUrls.length}, using CDP fallback for ${failedIndices.length} remaining...`);

        // Scroll to each failed image to ensure it loads, then wait for all to complete
        await page.evaluate(async (selector) => {
            const imgs = Array.from(document.querySelectorAll(selector));
            for (const img of imgs) {
                img.scrollIntoView({ behavior: 'instant', block: 'center' });
                await new Promise(r => setTimeout(r, 150));
            }
        }, cssSelector);

        // Wait for all images to report loaded
        await page.evaluate(async (selector) => {
            const imgs = Array.from(document.querySelectorAll(selector));
            const start = Date.now();
            while (Date.now() - start < 15000) {
                if (imgs.every(img => img.complete && img.naturalWidth > 0)) break;
                await new Promise(r => setTimeout(r, 500));
            }
        }, cssSelector);

        // Give CDP a moment to capture the last responses
        await new Promise(r => setTimeout(r, 1000));

        for (const j of failedIndices) {
            const imageUrl = imageUrls[j];
            const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
            const fileName = `${String(j + 1).padStart(4, '0')}${ext}`;
            const savePath = path.join(imagesFolderPath, fileName);
            const urlBase = imageUrl.split('?')[0];
            const captured = capturedImages.get(urlBase);

            if (captured) {
                try {
                    const { body, base64Encoded } = await client.send('Network.getResponseBody', {
                        requestId: captured.requestId
                    });
                    const buffer = base64Encoded
                        ? Buffer.from(body, 'base64')
                        : Buffer.from(body);
                    fs.writeFileSync(savePath, buffer);
                    downloadedCount++;
                    process.stdout.write(`  Downloaded [${j + 1}/${imageUrls.length}] ${fileName} (CDP)\r`);
                } catch (cdpError) {
                    failed = true;
                    errors.push({ url: imageUrl, error: `cdp: ${cdpError.message}` });
                    console.error(`  Failed [${j + 1}/${imageUrls.length}] ${imageUrl}: ${cdpError.message}`);
                }
            } else {
                failed = true;
                errors.push({ url: imageUrl, error: 'not captured by CDP' });
                console.error(`  Failed [${j + 1}/${imageUrls.length}] ${imageUrl}: not captured by CDP`);
            }
        }
    }
    console.log(`  Downloaded ${downloadedCount}/${imageUrls.length} images`);

    await client.detach().catch(() => {});
    await browser.close();

    // Save cache metadata
    if (!failed) {
        fs.writeFileSync(metaPath, JSON.stringify({
            url,
            imageCount: imageUrls.length,
            cachedAt: new Date().toISOString()
        }, null, 2));
    }

    return !failed;
}

function formatSequenceNumber(number, totalUrls) {
    const length = totalUrls.toString().length;
    return number.toString().padStart(length, '0');
}

/**
 * Convert a folder of images to a single XTC file
 */
async function convertImagesToXtc(imagesFolderPath, outputPath, options = {}) {
    const dithering = options.dithering || 'sierra-lite';
    const is2bit = options.is2bit || false;
    const contrast = options.contrast || 1;
    const device = options.device || 'X4';
    const splitMode = options.splitMode || 'thirds';
    const title = options.title || '';
    const author = options.author || '';

    // Get sorted list of image files (sort numerically for proper page order)
    const imageFiles = fs.readdirSync(imagesFolderPath)
        .filter(f => /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(f))
        .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
            const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
            return numA - numB;
        });

    if (imageFiles.length === 0) {
        throw new Error(`No image files found in ${imagesFolderPath}`);
    }

    console.log(`Processing ${imageFiles.length} images for XTC (${is2bit ? '2-bit' : '1-bit'}, dithering: ${dithering}, split: ${splitMode})...`);

    const pageBuffers = [];

    for (let i = 0; i < imageFiles.length; i++) {
        const imagePath = path.join(imagesFolderPath, imageFiles[i]);

        // loadAndProcessImage now returns an array of pages
        // (portrait images get split into thirds, landscape just rotated)
        const processedPages = await loadAndProcessImage(imagePath, {
            device,
            contrast,
            splitMode,
            padding: options.padding != null ? options.padding : 0
        });

        const splitInfo = processedPages.length > 1 ? ` -> ${processedPages.length} pages` : '';
        console.log(`  [${i + 1}/${imageFiles.length}] ${imageFiles[i]}${splitInfo}`);

        for (const { pixels, width, height } of processedPages) {
            // Apply dithering
            applyDithering(pixels, width, height, dithering, is2bit);

            // Encode to XTG or XTH
            const pageBuffer = is2bit
                ? pixelsToXth(pixels, width, height)
                : pixelsToXtg(pixels, width, height);

            pageBuffers.push(pageBuffer);
        }
    }

    // Build metadata if provided
    const metadata = (title || author) ? {
        title: title || undefined,
        author: author || undefined,
        toc: []
    } : undefined;

    // Assemble XTC file
    const xtcBuffer = buildXtc(pageBuffers, { is2bit, metadata });

    fs.writeFileSync(outputPath, xtcBuffer);
    console.log(`XTC file created: ${outputPath} (${(xtcBuffer.length / 1024).toFixed(1)} KB, ${pageBuffers.length} pages from ${imageFiles.length} images)`);
}

/**
 * Convert images to PDF using ImageMagick (original behavior)
 */
function convertImagesToPdf(imagesFolderPath, pdfPath) {
    return new Promise((resolve, reject) => {
        const convertCommand = `magick convert ${imagesFolderPath}/*.* ${pdfPath}`;
        exec(convertCommand, (error, _stdout, stderr) => {
            if (error) {
                reject(new Error(`ImageMagick error: ${error.message}`));
                return;
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
            }
            resolve();
        });
    });
}

function printUsage() {
    console.log(`
Usage: node index.js <name> [format] [cssSelector] [options]

Arguments:
  name          Base name for output files (default: 'output')
                Also checks for <name>.txt for URLs (e.g. 'berserk' reads berserk.txt, falls back to urls.txt)
  format        Output format: 'pdf', 'pdfclean', 'xtc', or 'xtcclean' (default: 'pdf')
  cssSelector   CSS selector for images on the page (default: 'img')

XTC Options (set via environment variables):
  DITHERING     Algorithm: sierra-lite, floyd, atkinson, ordered, none (default: sierra-lite)
  SPLIT         Page split mode: halves, thirds, none (default: halves)
  IS_2BIT       Set to '0' to disable 2-bit grayscale (default: on / 4 levels)
  CONTRAST      Contrast level 0-3 (default: 0 = off)
  DEVICE        Target device: X4 or X3 (default: X4)
  PADDING       Bezel padding in pixels per side (default: 0)
  RETRIES       Max attempts per chapter before giving up (default: 3)
  TITLE         Book title for XTC metadata
  AUTHOR        Book author for XTC metadata

  Portrait images are split into segments and rotated 90° CW for landscape reading.
  Landscape images are rotated 90° CW and scaled to fit without splitting.

  Images are cached in ./cache/ by URL hash. Re-running the same URL skips downloading.
  Use --no-cache to force re-download.

Examples:
  node index.js manga xtc 'img.chapter-page'
  SPLIT=thirds node index.js manga xtc 'img'
  DITHERING=atkinson SPLIT=none node index.js manga xtc 'img'
  TITLE="My Book" AUTHOR="Author" node index.js book xtc
  node index.js manga xtc 'img' --no-cache
`);
}

(async () => {
    const errors = [];
    let sequenceNumber = 1;
    const baseName = process.argv[2] || 'output';

    // Look for <baseName>.txt first, fall back to urls.txt
    const urlsFile = fs.existsSync(`${baseName}.txt`) ? `${baseName}.txt` : 'urls.txt';
    console.log(`Reading URLs from: ${urlsFile}`);
    const urls = fs.readFileSync(urlsFile, 'utf8').split('\n').filter(Boolean);
    const format = process.argv[3] || 'pdf';
    const cssSelector = process.argv[4] || 'img';

    const isXtc = format === 'xtc' || format === 'xtcclean';
    const shouldClean = format === 'pdfclean' || format === 'xtcclean';
    const outputExt = isXtc ? '.xtc' : '.pdf';

    const noCache = process.argv.includes('--no-cache');

    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        printUsage();
        process.exit(0);
    }

    // XTC options from environment variables
    const xtcOptions = {
        dithering: process.env.DITHERING || 'sierra-lite',
        splitMode: process.env.SPLIT || 'halves',
        is2bit: process.env.IS_2BIT !== '0',
        contrast: parseInt(process.env.CONTRAST || '0', 10),
        device: process.env.DEVICE || 'X4',
        padding: process.env.PADDING ? parseInt(process.env.PADDING, 10) : 0,
        title: process.env.TITLE || '',
        author: process.env.AUTHOR || ''
    };

    console.log(`Output format: ${isXtc ? 'XTC' : 'PDF'}`);
    if (isXtc) {
        console.log(`  Device: ${xtcOptions.device}, Dithering: ${xtcOptions.dithering}, Split: ${xtcOptions.splitMode}, 2-bit: ${xtcOptions.is2bit}`);
    }

    const cacheDir = './cache';
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const MAX_RETRIES = parseInt(process.env.RETRIES || '3', 10);

    /**
     * Process a single chapter: download (or use cache) + convert.
     * Returns true on success, false on failure.
     */
    async function processChapter(index) {
        const url = urls[index];
        const formattedSeq = formatSequenceNumber(index + 1, urls.length);

        const urlHash = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
        const imagesFolderPath = path.join(cacheDir, urlHash);
        const metaPath = path.join(imagesFolderPath, '.meta.json');

        // Check if we have a valid cache — cache miss is not a failure, just means we need to fetch
        let cached = false;

        if (!noCache && fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const cachedImages = fs.readdirSync(imagesFolderPath)
                .filter(f => /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(f));

            if (cachedImages.length > 0 && cachedImages.length === meta.imageCount) {
                console.log(`\n[${formattedSeq}/${urls.length}] Cache hit: ${url}`);
                console.log(`  ${cachedImages.length} images in ./cache/${urlHash}/`);
                cached = true;
            } else {
                // Incomplete cache, clean it up so we can re-fetch
                rimraf.sync(imagesFolderPath);
            }
        }

        if (!cached) {
            if (noCache && fs.existsSync(imagesFolderPath)) {
                rimraf.sync(imagesFolderPath);
            }
            console.log(`\n[${formattedSeq}/${urls.length}] Fetching: ${url}`);
            if (!fs.existsSync(imagesFolderPath)) {
                fs.mkdirSync(imagesFolderPath, { recursive: true });
            }
            const downloadOk = await downloadFromPage(url, cssSelector, imagesFolderPath, metaPath, errors);
            if (!downloadOk) return false;
        }

        // Extract chapter number from URL slug (e.g. "chapter-11.5" -> "011.5", "chapter-3" -> "003")
        const chapterMatch = url.match(/chapter[- ](\d+(?:\.\d+)?)\/?$/i);
        let chapterNum;
        if (chapterMatch) {
            const parts = chapterMatch[1].split('.');
            const padded = parts[0].padStart(3, '0');
            chapterNum = parts.length > 1 ? `${padded}.${parts[1]}` : padded;
        } else {
            chapterNum = formatSequenceNumber(index + 1, urls.length);
        }
        const outputName = `${baseName}_${chapterNum}`;
        const outputFolderPath = path.join(isXtc ? './xtc' : './pdfs', baseName);
        if (!fs.existsSync(outputFolderPath)) {
            fs.mkdirSync(outputFolderPath, { recursive: true });
        }
        const outputPath = path.join(outputFolderPath, `${outputName}${outputExt}`);

        // Skip if output file already exists
        if (fs.existsSync(outputPath)) {
            console.log(`  Output already exists: ${outputPath}, skipping.`);
            return true;
        }

        // Auto-generate title from URL if not explicitly set
        let chapterTitle = xtcOptions.title;
        if (!chapterTitle) {
            const urlMatch = url.match(/\/([^/]+)\/?$/);
            if (urlMatch) {
                chapterTitle = urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            } else {
                chapterTitle = `${baseName} ${formattedSeq}`;
            }
        }

        if (isXtc) {
            await convertImagesToXtc(imagesFolderPath, outputPath, {
                ...xtcOptions,
                title: chapterTitle
            });
        } else {
            await convertImagesToPdf(imagesFolderPath, outputPath);
            console.log(`Images converted to PDF: ${outputPath}`);
        }

        if (shouldClean) {
            rimraf.sync(imagesFolderPath);
            console.log('Images folder removed.');
        }

        return true;
    }

    const failedQueue = []; // chapter indices that failed
    const permanentlyFailed = [];
    let completed = 0;

    /**
     * Try a chapter up to MAX_RETRIES times immediately.
     * Returns true if it eventually succeeds, false if all attempts fail.
     */
    async function tryWithRetries(index) {
        const seq = formatSequenceNumber(index + 1, urls.length);

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const success = await processChapter(index);
                if (success) return true;
            } catch (err) {
                console.error(`  [${seq}] ERROR: ${err.message}`);
            }

            if (attempt < MAX_RETRIES) {
                console.log(`  [${seq}] Attempt ${attempt}/${MAX_RETRIES} failed, retrying...`);
            } else {
                console.log(`  [${seq}] Failed all ${MAX_RETRIES} attempts.`);
            }
        }

        return false;
    }

    /**
     * Go through the entire failed queue, giving each item 3 tries.
     * Items that succeed are removed. Items that fail stay in the queue.
     */
    async function drainFailedQueue() {
        if (failedQueue.length === 0) return;

        console.log(`\n  >> Processing failed queue (${failedQueue.length} chapters)...`);
        const stillFailed = [];

        for (const index of failedQueue) {
            const seq = formatSequenceNumber(index + 1, urls.length);
            console.log(`\n  >> Retrying chapter ${seq} from failed queue`);

            const success = await tryWithRetries(index);
            if (success) {
                completed++;
                console.log(`  >> Chapter ${seq} recovered!`);
            } else {
                stillFailed.push(index);
                console.log(`  >> Chapter ${seq} still failing, stays in queue.`);
            }
        }

        // Replace the queue with whatever's still failing
        failedQueue.length = 0;
        failedQueue.push(...stillFailed);

        if (failedQueue.length > 0) {
            console.log(`\n  >> ${failedQueue.length} chapters still in failed queue.`);
        } else {
            console.log(`\n  >> Failed queue cleared!`);
        }
    }

    // Main loop
    for (let i = 0; i < urls.length; i++) {
        const success = await tryWithRetries(i);

        if (success) {
            completed++;
            // After a success, sweep through the entire failed queue
            await drainFailedQueue();
        } else {
            const seq = formatSequenceNumber(i + 1, urls.length);
            failedQueue.push(i);
            console.log(`  Queued chapter ${seq} for later (${failedQueue.length} in failed queue)`);
        }
    }

    // Final drain after all new chapters are done
    if (failedQueue.length > 0) {
        console.log(`\n========================================`);
        console.log(`All new chapters done. Final retry of ${failedQueue.length} failed chapters...`);
        await drainFailedQueue();
    }

    // Anything left is permanently failed
    for (const index of failedQueue) {
        permanentlyFailed.push({ index: index + 1, url: urls[index] });
    }

    // Summary
    console.log(`\n========================================`);
    console.log(`Done! Completed ${completed}/${urls.length} chapters.`);
    if (permanentlyFailed.length > 0) {
        console.log(`\nFailed chapters (${permanentlyFailed.length}):`);
        for (const ch of permanentlyFailed) {
            console.log(`  #${ch.index}: ${ch.url}`);
        }
        console.log(`\nRe-run the same command to retry — cached chapters will be skipped.`);
    }
    if (errors.length > 0) {
        console.error(`\nImage download errors:`, errors);
    }
})();
