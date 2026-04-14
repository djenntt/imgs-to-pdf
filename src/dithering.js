// Dithering algorithms for e-ink displays
// Ported from xtcjs (https://github.com/varo6/xtcjs) - MIT License

function quantizePixel(value, is2bit) {
  if (!is2bit) {
    return value >= 128 ? 255 : 0;
  }
  if (value < 42) return 0;
  if (value < 127) return 85;
  if (value < 212) return 170;
  return 255;
}

/**
 * Simple threshold - no dithering
 */
function applyThreshold(pixels, width, height, is2bit) {
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = quantizePixel(pixels[i], is2bit);
  }
}

/**
 * Sierra Lite dithering - lighter than Floyd-Steinberg, preserves fine details
 */
function applySierraLite(pixels, width, height, is2bit) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = pixels[idx];
      const newPixel = quantizePixel(oldPixel, is2bit);
      pixels[idx] = newPixel;
      const error = oldPixel - newPixel;

      if (x + 1 < width) pixels[idx + 1] += error * 2 / 4;
      if (y + 1 < height) {
        if (x > 0) pixels[idx + width - 1] += error * 1 / 4;
        pixels[idx + width] += error * 1 / 4;
      }
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, pixels[i]));
  }
}

/**
 * Atkinson dithering - creates lighter images, only distributes 75% of error
 */
function applyAtkinson(pixels, width, height, is2bit) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = pixels[idx];
      const newPixel = quantizePixel(oldPixel, is2bit);
      pixels[idx] = newPixel;
      const error = (oldPixel - newPixel) / 8;

      if (x + 1 < width) pixels[idx + 1] += error;
      if (x + 2 < width) pixels[idx + 2] += error;
      if (y + 1 < height) {
        if (x > 0) pixels[idx + width - 1] += error;
        pixels[idx + width] += error;
        if (x + 1 < width) pixels[idx + width + 1] += error;
      }
      if (y + 2 < height) {
        pixels[idx + width * 2] += error;
      }
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, pixels[i]));
  }
}

/**
 * Floyd-Steinberg dithering - the classic, good balance
 */
function applyFloydSteinberg(pixels, width, height, is2bit) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = pixels[idx];
      const newPixel = quantizePixel(oldPixel, is2bit);
      pixels[idx] = newPixel;
      const error = oldPixel - newPixel;

      if (x + 1 < width) pixels[idx + 1] += error * 7 / 16;
      if (y + 1 < height) {
        if (x > 0) pixels[idx + width - 1] += error * 3 / 16;
        pixels[idx + width] += error * 5 / 16;
        if (x + 1 < width) pixels[idx + width + 1] += error * 1 / 16;
      }
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, pixels[i]));
  }
}

/**
 * Ordered/Bayer dithering - creates regular patterns
 */
function applyOrdered(pixels, width, height, is2bit) {
  const bayer = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const matrixValue = bayer[y % 4][x % 4];

      if (is2bit) {
        const adjusted = pixels[idx] + (((matrixValue + 0.5) / 16) - 0.5) * 64;
        pixels[idx] = quantizePixel(Math.max(0, Math.min(255, adjusted)), true);
      } else {
        const threshold = (matrixValue / 16) * 255;
        pixels[idx] = pixels[idx] > threshold ? 255 : 0;
      }
    }
  }
}

/**
 * Apply dithering to a grayscale pixel array (Float32Array, one value per pixel)
 * @param {Float32Array} pixels - grayscale values (0-255), modified in place
 * @param {number} width
 * @param {number} height
 * @param {string} algorithm - 'none'|'sierra-lite'|'atkinson'|'floyd'|'ordered'
 * @param {boolean} is2bit - use 4-level grayscale instead of 1-bit
 */
function applyDithering(pixels, width, height, algorithm, is2bit = false) {
  switch (algorithm) {
    case 'none':
      applyThreshold(pixels, width, height, is2bit);
      break;
    case 'sierra-lite':
      applySierraLite(pixels, width, height, is2bit);
      break;
    case 'atkinson':
      applyAtkinson(pixels, width, height, is2bit);
      break;
    case 'floyd':
      applyFloydSteinberg(pixels, width, height, is2bit);
      break;
    case 'ordered':
      applyOrdered(pixels, width, height, is2bit);
      break;
    default:
      applyFloydSteinberg(pixels, width, height, is2bit);
  }
}

module.exports = { applyDithering };
