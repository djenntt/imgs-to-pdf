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
 * Download an image using the browser's fetch (keeps cookies/referer intact)
 */
async function downloadImageViaBrowser(page, imageUrl, savePath) {
    const base64 = await page.evaluate(async (url) => {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }, imageUrl);

    fs.writeFileSync(savePath, Buffer.from(base64, 'base64'));
}

/**
 * Launch Puppeteer, scrape image URLs, download them, and save cache metadata.
 * Returns true on success, false on failure.
 */
async function downloadFromPage(url, cssSelector, imagesFolderPath, metaPath, errors) {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Scroll down to trigger lazy-loaded images
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

    // Wait for lazy images to load
    await new Promise(r => setTimeout(r, 2000));

    const imageUrls = await page.evaluate((selector) => {
        const images = Array.from(document.querySelectorAll(selector));
        return images.map(img => img.getAttribute('data-src') || img.src).filter(src => src && src !== 'about:blank');
    }, cssSelector);

    console.log(`  Found ${imageUrls.length} images`);

    let failed = false;
    for (let j = 0; j < imageUrls.length; j++) {
        const imageUrl = imageUrls[j];
        const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
        const fileName = `${String(j + 1).padStart(4, '0')}${ext}`;
        const savePath = path.join(imagesFolderPath, fileName);

        try {
            await downloadImageViaBrowser(page, imageUrl, savePath);
            process.stdout.write(`  Downloaded [${j + 1}/${imageUrls.length}] ${fileName}\r`);
        } catch (error) {
            failed = true;
            errors.push({ url: imageUrl, error: error.message });
            console.error(`  Failed [${j + 1}/${imageUrls.length}] ${imageUrl}: ${error.message}`);
        }
    }
    console.log(`  Downloaded ${imageUrls.length - errors.length}/${imageUrls.length} images`);

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
    const urls = fs.readFileSync('urls.txt', 'utf8').split('\n').filter(Boolean);
    const baseName = process.argv[2] || 'output';
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
    const RETRY_DELAY = 5000; // 5 seconds between retries
    const failedChapters = [];

    /**
     * Process a single chapter: download (or use cache) + convert.
     * Returns true on success, false on failure.
     */
    async function processChapter(i) {
        const url = urls[i];
        const formattedSeq = formatSequenceNumber(i + 1, urls.length);
        let failed = false;

        const urlHash = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
        const imagesFolderPath = path.join(cacheDir, urlHash);
        const metaPath = path.join(imagesFolderPath, '.meta.json');

        // Check cache
        if (!noCache && fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const cachedImages = fs.readdirSync(imagesFolderPath)
                .filter(f => /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(f));

            if (cachedImages.length > 0 && cachedImages.length === meta.imageCount) {
                console.log(`\n[${formattedSeq}/${urls.length}] Cache hit: ${url}`);
                console.log(`  ${cachedImages.length} images in ./cache/${urlHash}/`);
            } else {
                console.log(`\n[${formattedSeq}/${urls.length}] Cache incomplete for: ${url}, re-downloading...`);
                rimraf.sync(imagesFolderPath);
                fs.mkdirSync(imagesFolderPath, { recursive: true });
                failed = !(await downloadFromPage(url, cssSelector, imagesFolderPath, metaPath, errors));
            }
        } else {
            if (noCache && fs.existsSync(imagesFolderPath)) {
                rimraf.sync(imagesFolderPath);
            }
            console.log(`\n[${formattedSeq}/${urls.length}] Fetching: ${url}`);
            if (!fs.existsSync(imagesFolderPath)) {
                fs.mkdirSync(imagesFolderPath, { recursive: true });
            }
            failed = !(await downloadFromPage(url, cssSelector, imagesFolderPath, metaPath, errors));
        }

        if (failed) return false;

        const outputName = `${baseName}_${formattedSeq}`;
        const outputFolderPath = path.join(isXtc ? './xtc' : './pdfs', baseName);
        if (!fs.existsSync(outputFolderPath)) {
            fs.mkdirSync(outputFolderPath, { recursive: true });
        }
        const outputPath = path.join(outputFolderPath, `${outputName}${outputExt}`);

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

    // Main loop: process each chapter with retries
    for (let i = 0; i < urls.length; i++) {
        let success = false;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                success = await processChapter(i);
                if (success) break;
            } catch (err) {
                const formattedSeq = formatSequenceNumber(i + 1, urls.length);
                console.error(`\n[${formattedSeq}/${urls.length}] ERROR (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
            }

            if (attempt < MAX_RETRIES) {
                console.log(`  Retrying in ${RETRY_DELAY / 1000}s... (attempt ${attempt + 1}/${MAX_RETRIES})`);
                await new Promise(r => setTimeout(r, RETRY_DELAY));
            }
        }

        if (!success) {
            const formattedSeq = formatSequenceNumber(i + 1, urls.length);
            failedChapters.push({ index: i + 1, url: urls[i] });
            console.error(`  Chapter ${formattedSeq} failed after ${MAX_RETRIES} attempts, moving on.`);
        }
    }

    // Summary
    console.log(`\n========================================`);
    console.log(`Done! Processed ${urls.length - failedChapters.length}/${urls.length} chapters.`);
    if (failedChapters.length > 0) {
        console.log(`\nFailed chapters (${failedChapters.length}):`);
        for (const ch of failedChapters) {
            console.log(`  #${ch.index}: ${ch.url}`);
        }
        console.log(`\nRe-run the same command to retry — cached chapters will be skipped.`);
    }
    if (errors.length > 0) {
        console.error(`\nImage download errors:`, errors);
    }
})();
