// XTG/XTH page encoding for XTEink e-readers
// Ported from xtcjs (https://github.com/varo6/xtcjs) - MIT License

function createDigestSeed(data) {
  const digest = new Uint8Array(8);
  for (let i = 0; i < Math.min(8, data.length); i++) {
    digest[i] = data[i];
  }
  return digest;
}

function buildPageBuffer(magic, width, height, pixelData) {
  const digest = createDigestSeed(pixelData);
  const headerSize = 22;
  const totalSize = headerSize + pixelData.length;
  const buffer = Buffer.alloc(totalSize);

  // Magic bytes (XTG\0 or XTH\0)
  buffer[0] = magic.charCodeAt(0);
  buffer[1] = magic.charCodeAt(1);
  buffer[2] = magic.charCodeAt(2);
  buffer[3] = 0x00;

  // Dimensions (little-endian)
  buffer.writeUInt16LE(width, 4);
  buffer.writeUInt16LE(height, 6);

  // Reserved
  buffer[8] = 0;
  buffer[9] = 0;

  // Pixel data size (little-endian)
  buffer.writeUInt32LE(pixelData.length, 10);

  // Digest seed
  buffer.set(digest, 14);

  // Pixel data
  buffer.set(pixelData, headerSize);

  return buffer;
}

/**
 * Encode grayscale pixels to XTG format (1-bit monochrome)
 * @param {Float32Array|Uint8Array} pixels - dithered grayscale values (0 or 255 after dithering)
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function pixelsToXtg(pixels, width, height) {
  const rowBytes = Math.ceil(width / 8);
  const pixelData = new Uint8Array(rowBytes * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const bit = pixels[idx] >= 128 ? 1 : 0;
      const byteIndex = y * rowBytes + Math.floor(x / 8);
      const bitIndex = 7 - (x % 8);
      if (bit) {
        pixelData[byteIndex] |= 1 << bitIndex;
      }
    }
  }

  return buildPageBuffer('XTG', width, height, pixelData);
}

/**
 * Encode grayscale pixels to XTH format (2-bit, 4 grayscale levels)
 * @param {Float32Array|Uint8Array} pixels - dithered grayscale values
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function pixelsToXth(pixels, width, height) {
  const colBytes = Math.ceil(height / 8);
  const planeSize = colBytes * width;
  const plane0 = new Uint8Array(planeSize);
  const plane1 = new Uint8Array(planeSize);

  for (let x = 0; x < width; x++) {
    const targetCol = width - 1 - x;
    const colOffset = targetCol * colBytes;

    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      const value = get2BitLevel(pixels[idx]);
      const byteIndex = colOffset + (y >> 3);
      const bitIndex = 7 - (y & 7);

      if (value & 1) {
        plane0[byteIndex] |= 1 << bitIndex;
      }
      if (value & 2) {
        plane1[byteIndex] |= 1 << bitIndex;
      }
    }
  }

  const pixelData = new Uint8Array(planeSize * 2);
  pixelData.set(plane0);
  pixelData.set(plane1, planeSize);

  return buildPageBuffer('XTH', width, height, pixelData);
}

function get2BitLevel(value) {
  if (value >= 212) return 0;
  if (value >= 127) return 1;
  if (value >= 42) return 2;
  return 3;
}

module.exports = { pixelsToXtg, pixelsToXth };
