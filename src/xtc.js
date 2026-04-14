// XTC container format assembly for XTEink e-readers
// Ported from xtcjs (https://github.com/varo6/xtcjs) - MIT License

const HEADER_BASE_SIZE = 48;
const TOC_OFFSET_PTR_SIZE = 8;
const HEADER_WITH_METADATA_SIZE = HEADER_BASE_SIZE + TOC_OFFSET_PTR_SIZE; // 56
const INDEX_ENTRY_SIZE = 16;
const TITLE_SIZE = 128;
const AUTHOR_SIZE = 112;
const TOC_HEADER_SIZE = 16;
const TOC_ENTRY_SIZE = 96;
const TOC_TITLE_SIZE = 80;

const FLAG_HAS_METADATA_LOW = 0x01000100;
const FLAG_HAS_METADATA_HIGH = 0x00000001;

function getXtgDimensions(pageBuffer) {
  if (pageBuffer.length < 8) {
    return { width: 480, height: 800 };
  }
  return {
    width: pageBuffer.readUInt16LE(4),
    height: pageBuffer.readUInt16LE(6)
  };
}

function setBigUint64LE(buffer, offset, value) {
  const bigVal = BigInt(value);
  const low = Number(bigVal & 0xFFFFFFFFn);
  const high = Number(bigVal >> 32n);
  buffer.writeUInt32LE(low, offset);
  buffer.writeUInt32LE(high, offset + 4);
}

function writeMetadata(buffer, offset, metadata) {
  let currentOffset = offset;

  // Title (128 bytes, null-terminated)
  if (metadata.title) {
    const titleBytes = Buffer.from(metadata.title, 'utf8');
    const titleLen = Math.min(titleBytes.length, TITLE_SIZE - 1);
    titleBytes.copy(buffer, currentOffset, 0, titleLen);
  }
  currentOffset += TITLE_SIZE;

  // Author (112 bytes, null-terminated)
  if (metadata.author) {
    const authorBytes = Buffer.from(metadata.author, 'utf8');
    const authorLen = Math.min(authorBytes.length, AUTHOR_SIZE - 1);
    authorBytes.copy(buffer, currentOffset, 0, authorLen);
  }
  currentOffset += AUTHOR_SIZE;

  // TOC header (16 bytes)
  const tocEntries = metadata.toc || [];
  const timestamp = Math.floor(Date.now() / 1000);
  buffer.writeUInt32LE(timestamp, currentOffset);
  buffer.writeUInt16LE(0, currentOffset + 4);
  buffer.writeUInt16LE(tocEntries.length, currentOffset + 6);
  currentOffset += TOC_HEADER_SIZE;

  // TOC entries (96 bytes each)
  for (const entry of tocEntries) {
    const titleBytes = Buffer.from(entry.title, 'utf8');
    const titleLen = Math.min(titleBytes.length, TOC_TITLE_SIZE - 1);
    titleBytes.copy(buffer, currentOffset, 0, titleLen);
    buffer.writeUInt16LE(entry.startPage, currentOffset + TOC_TITLE_SIZE);
    buffer.writeUInt16LE(entry.endPage, currentOffset + TOC_TITLE_SIZE + 2);
    currentOffset += TOC_ENTRY_SIZE;
  }
}

/**
 * Build an XTC file from an array of encoded page buffers (XTG or XTH)
 * @param {Buffer[]} pageBuffers - array of XTG/XTH page buffers
 * @param {object} options
 * @param {boolean} [options.is2bit=false] - use XTCH header instead of XTC
 * @param {object} [options.metadata] - { title, author, toc: [{ title, startPage, endPage }] }
 * @returns {Buffer}
 */
function buildXtc(pageBuffers, options = {}) {
  const is2bit = options.is2bit || false;
  const pageCount = pageBuffers.length;
  const metadata = options.metadata;
  const hasMetadata = metadata && (metadata.title || metadata.author || (metadata.toc && metadata.toc.length > 0));

  // Calculate metadata section size
  let metadataSize = 0;
  let tocEntriesOffset = 0;

  if (hasMetadata) {
    metadataSize = TITLE_SIZE + AUTHOR_SIZE + TOC_HEADER_SIZE;
    const tocEntries = metadata.toc || [];
    if (tocEntries.length > 0) {
      metadataSize += tocEntries.length * TOC_ENTRY_SIZE;
    }
    tocEntriesOffset = HEADER_WITH_METADATA_SIZE + TITLE_SIZE + AUTHOR_SIZE + TOC_HEADER_SIZE;
  }

  const headerSize = hasMetadata ? HEADER_WITH_METADATA_SIZE : HEADER_BASE_SIZE;
  const metadataOffset = hasMetadata ? HEADER_WITH_METADATA_SIZE : 0;
  const indexOffset = headerSize + metadataSize;
  const dataOffset = indexOffset + (pageCount * INDEX_ENTRY_SIZE);

  let totalSize = dataOffset;
  for (const buf of pageBuffers) {
    totalSize += buf.length;
  }

  const buffer = Buffer.alloc(totalSize);

  // Header magic: XTC\0 or XTCH
  if (is2bit) {
    buffer[0] = 0x58; buffer[1] = 0x54; buffer[2] = 0x43; buffer[3] = 0x48;
  } else {
    buffer[0] = 0x58; buffer[1] = 0x54; buffer[2] = 0x43; buffer[3] = 0x00;
  }

  // Version
  buffer.writeUInt16LE(1, 4);

  // Page count
  buffer.writeUInt16LE(pageCount, 6);

  // Flags
  if (hasMetadata) {
    buffer.writeUInt32LE(FLAG_HAS_METADATA_LOW, 8);
    buffer.writeUInt32LE(FLAG_HAS_METADATA_HIGH, 12);
  }

  // Offsets
  setBigUint64LE(buffer, 16, metadataOffset);
  setBigUint64LE(buffer, 24, indexOffset);
  setBigUint64LE(buffer, 32, dataOffset);
  setBigUint64LE(buffer, 40, 0);

  if (hasMetadata) {
    setBigUint64LE(buffer, 48, tocEntriesOffset);
    writeMetadata(buffer, HEADER_WITH_METADATA_SIZE, metadata);
  }

  // Write page index
  let relOffset = dataOffset;
  for (let i = 0; i < pageCount; i++) {
    const pageBuf = pageBuffers[i];
    const entryOffset = indexOffset + i * INDEX_ENTRY_SIZE;
    const dimensions = getXtgDimensions(pageBuf);

    setBigUint64LE(buffer, entryOffset, relOffset);
    buffer.writeUInt32LE(pageBuf.length, entryOffset + 8);
    buffer.writeUInt16LE(dimensions.width, entryOffset + 12);
    buffer.writeUInt16LE(dimensions.height, entryOffset + 14);

    relOffset += pageBuf.length;
  }

  // Write page data
  let writeOffset = dataOffset;
  for (const pageBuf of pageBuffers) {
    pageBuf.copy(buffer, writeOffset);
    writeOffset += pageBuf.length;
  }

  return buffer;
}

module.exports = { buildXtc };
