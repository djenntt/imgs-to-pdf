# imgs-to-pdf

A Node.js tool for batch-downloading images from web pages and converting them into PDF or XTC format for e-readers. Built with Puppeteer for browser-based scraping and Sharp for image processing.

## Features

- Batch downloads images from a list of URLs using Puppeteer (headless Chrome)
- Converts to PDF (via ImageMagick) or XTC/XTCH format (for XteInk e-readers like the X4)
- XTC output supports 1-bit monochrome (XTG) or 2-bit grayscale with 4 levels (XTH)
- Multiple dithering algorithms: Sierra-Lite, Floyd-Steinberg, Atkinson, Ordered, or none
- Portrait images are automatically split into segments and rotated 90° CW for landscape reading on e-ink displays
- URL-based image caching so re-runs skip already-downloaded pages
- Output file detection so already-converted entries are skipped entirely
- Smart retry system with a failed queue that retries between successful downloads
- Handles ad popups and redirects by detecting when the page lands on the wrong domain
- Two download strategies: fast fetch (for most CDNs) with automatic CDP fallback (for sites that block fetch)
- Anti-bot detection stealth (custom user agent, webdriver flag masking)

## Requirements

- Node.js
- ImageMagick (only needed for PDF output)

## Installation

```bash
npm install
```

## Quick Start

1. Create a text file with one URL per line (e.g., `my-content.txt`)
2. Run the script with the base name matching the text file:

```bash
node index.js my-content xtc 'img.page-image'
```

This reads `my-content.txt`, downloads images from each URL, and outputs XTC files to `xtc/my-content/`.

## Usage

```
node index.js <name> [format] [cssSelector] [options]
```

### Arguments

- `name` - Base name for output files. The script looks for `<name>.txt` for URLs first, then falls back to `urls.txt`.
- `format` - Output format (default: `pdf`):
  - `pdf` - Convert to PDF
  - `pdfclean` - Convert to PDF, then delete cached images
  - `xtc` - Convert to XTC for e-readers
  - `xtcclean` - Convert to XTC, then delete cached images
- `cssSelector` - CSS selector to target images on the page (default: `img`)

### Options

- `--no-cache` - Force re-download of all images (ignores cache)
- `--help` / `-h` - Show help

### Environment Variables (XTC options)

| Variable | Description | Default |
|----------|-------------|---------|
| `DITHERING` | Algorithm: `sierra-lite`, `floyd`, `atkinson`, `ordered`, `none` | `sierra-lite` |
| `SPLIT` | Page split mode: `halves`, `thirds`, `none` | `halves` |
| `IS_2BIT` | Set to `0` to use 1-bit monochrome instead of 2-bit grayscale | on (2-bit) |
| `CONTRAST` | Contrast level 0-3 | `0` (off) |
| `DEVICE` | Target device: `X4` (480x800) or `X3` (528x792) | `X4` |
| `PADDING` | Bezel padding in pixels per side | `0` |
| `RETRIES` | Max attempts per chapter before giving up | `3` |
| `TITLE` | Title for XTC metadata | auto from URL |
| `AUTHOR` | Author for XTC metadata | (empty) |

## Examples

```bash
# Basic XTC conversion
node index.js my-content xtc 'img.page-image'

# Run multiple jobs in parallel (separate terminals)
node index.js project-one xtc 'img.page-image'
node index.js project-two xtc 'img.reader-image'

# PDF output
node index.js my-content pdf 'img.content-image'

# Custom dithering and split mode
SPLIT=thirds DITHERING=atkinson node index.js my-content xtc 'img'

# 1-bit monochrome (smaller files, less detail)
IS_2BIT=0 node index.js my-content xtc 'img'

# Force re-download
node index.js my-content xtc 'img' --no-cache

# Add metadata
TITLE="My Publication" AUTHOR="Author Name" node index.js my-content xtc 'img.page-image'
```

## URL Files

Create a text file named `<name>.txt` with one URL per line:

```
https://example.com/issue/my-content-1
https://example.com/issue/my-content-2
https://example.com/issue/my-content-3
...
```

Output files are named using the number extracted from the URL slug (e.g., `my-content_001.xtc`, `my-content_002.5.xtc`).

## How It Works

1. Reads URLs from the text file
2. For each URL, checks if the output file already exists (skips if so)
3. Checks the image cache (skips download if cached)
4. Launches headless Chrome, navigates to the page, scrolls to trigger lazy-loaded images
5. Downloads images via browser fetch, with CDP (Chrome DevTools Protocol) as a fallback for stubborn CDNs
6. Processes images with Sharp: splits portrait pages, rotates for landscape reading, applies dithering
7. Encodes to XTG/XTH page buffers and assembles the XTC container
8. Failed entries are queued and retried between successful ones

## Caching

Images are cached in `./cache/` under folders named by MD5 hash of the URL. Re-running the same command skips already-downloaded content. Output files in `./xtc/` or `./pdfs/` are also checked, so fully completed entries are skipped entirely.

## Disclaimer

This script is intended for personal use and educational purposes. Ensure you have the right to download and convert content from the provided URLs. Respect copyright laws and the terms of service of the websites you are accessing.
