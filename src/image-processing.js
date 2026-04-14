// Image processing for XTC conversion using Sharp
// Replaces the Canvas-based processing from xtcjs with Node.js Sharp

const sharp = require('sharp');

const DEVICE_DIMENSIONS = {
  X4: { width: 480, height: 800 },
  X3: { width: 528, height: 792 }
};

/**
 * Load an image and produce one or more processed page buffers.
 * All output pages are rotated 90° clockwise for landscape reading on the X4.
 *
 * - Portrait (tall) images: split into overlapping thirds, each rotated 90° CW
 *   so you read top→middle→bottom as separate landscape pages.
 * - Landscape (wide) images: rotated 90° CW and scaled to fit the screen.
 *
 * The target output for each page is 480×800 (the X4 screen held in landscape
 * means 800px wide × 480px tall, but stored as 480×800 rotated).
 *
 * @param {string} imagePath - path to image file
 * @param {object} options
 * @param {string} [options.device='X4'] - target device
 * @param {number} [options.contrast=0] - contrast level (0=off, 1-3)
 * @param {string} [options.splitMode='thirds'] - 'thirds', 'halves', or 'none'
 * @returns {Promise<Array<{ pixels: Float32Array, width: number, height: number }>>}
 */
async function loadAndProcessImage(imagePath, options = {}) {
  const device = options.device || 'X4';
  const contrastLevel = options.contrast || 0;
  const splitMode = options.splitMode || 'halves';
  const dims = DEVICE_DIMENSIONS[device] || DEVICE_DIMENSIONS.X4;

  // Target page size: 480×800 (stored portrait, but represents landscape viewing)
  const pageWidth = dims.width;   // 480
  const pageHeight = dims.height; // 800

  // Padding: margin so content doesn't get cut off by the device bezel
  const padding = options.padding != null ? options.padding : 0; // px on each side, 0 = no padding
  const innerWidth = pageWidth - padding * 2;
  const innerHeight = pageHeight - padding * 2;

  // Load image into buffer once (Sharp has issues extracting regions
  // from JPEG files at non-zero offsets, but works fine from buffers)
  const imgBuffer = await sharp(imagePath).toBuffer();
  const metadata = await sharp(imgBuffer).metadata();
  const srcWidth = metadata.width;
  const srcHeight = metadata.height;
  const isPortrait = srcHeight > srcWidth;

  const pages = [];

  if (isPortrait && splitMode !== 'none') {
    // PORTRAIT IMAGE: split into segments, rotate each 90° CW
    // When rotated, the wide dimension of the crop becomes the 800px width,
    // and the segment height becomes the 480px height.

    const numSegments = splitMode === 'halves' ? 2 : 3;

    // Evenly distribute segments with slight overlap (less for halves)
    const overlapRatio = numSegments === 2 ? 1.03 : 1.1;
    const segmentHeight = Math.floor(srcHeight / numSegments * overlapRatio);
    // Step between segment starts (ensures last segment ends at srcHeight)
    const step = numSegments > 1
      ? Math.floor((srcHeight - segmentHeight) / (numSegments - 1))
      : 0;

    for (let s = 0; s < numSegments; s++) {
      let y = s * step;
      let h = segmentHeight;

      // Clamp to image bounds
      if (y + h > srcHeight) {
        h = srcHeight - y;
      }
      if (h < 1) h = 1;

      // Two-step process: extract first, then rotate+resize
      // (Sharp has a bug chaining extract + rotate in one pipeline)
      const extractedPng = await sharp(imgBuffer)
        .extract({ left: 0, top: y, width: srcWidth, height: h })
        .png()
        .toBuffer();

      const segBuffer = await sharp(extractedPng)
        .rotate(90) // clockwise 90°
        .grayscale()
        .resize(innerWidth, innerHeight, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255 }
        })
        .extend({
          top: padding,
          bottom: padding,
          left: padding,
          right: padding,
          background: { r: 255, g: 255, b: 255 }
        })
        .raw()
        .toBuffer();

      const pixels = new Float32Array(pageWidth * pageHeight);
      for (let i = 0; i < pixels.length; i++) {
        pixels[i] = segBuffer[i];
      }

      if (contrastLevel > 0) {
        applyContrast(pixels, pageWidth, pageHeight, contrastLevel);
      }

      pages.push({ pixels, width: pageWidth, height: pageHeight });
    }
  } else {
    // LANDSCAPE IMAGE (or no-split mode): rotate 90° CW and scale to fit
    const processedBuffer = await sharp(imgBuffer)
      .rotate(90) // clockwise 90°
      .grayscale()
      .resize(innerWidth, innerHeight, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255 }
      })
      .extend({
        top: padding,
        bottom: padding,
        left: padding,
        right: padding,
        background: { r: 255, g: 255, b: 255 }
      })
      .raw()
      .toBuffer();

    const pixels = new Float32Array(pageWidth * pageHeight);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = processedBuffer[i];
    }

    if (contrastLevel > 0) {
      applyContrast(pixels, pageWidth, pageHeight, contrastLevel);
    }

    pages.push({ pixels, width: pageWidth, height: pageHeight });
  }

  return pages;
}

/**
 * Apply histogram-based contrast stretch
 * Ported from xtcjs image.ts
 */
function applyContrast(pixels, width, height, level) {
  const blackCutoff = 3 * level;
  const whiteCutoff = 3 + 9 * level;

  // Build histogram
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < pixels.length; i++) {
    histogram[Math.round(pixels[i])]++;
  }

  // Find cutoff points
  const totalPixels = width * height;
  const blackThreshold = totalPixels * blackCutoff / 100;
  const whiteThreshold = totalPixels * whiteCutoff / 100;

  let blackPoint = 0;
  let whitePoint = 255;
  let count = 0;

  for (let i = 0; i < 256; i++) {
    count += histogram[i];
    if (count >= blackThreshold) {
      blackPoint = i;
      break;
    }
  }

  count = 0;
  for (let i = 255; i >= 0; i--) {
    count += histogram[i];
    if (count >= whiteThreshold) {
      whitePoint = i;
      break;
    }
  }

  // Apply contrast stretch
  const range = whitePoint - blackPoint;
  if (range > 0) {
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = Math.max(0, Math.min(255, ((pixels[i] - blackPoint) / range) * 255));
    }
  }
}

module.exports = { loadAndProcessImage, DEVICE_DIMENSIONS };
