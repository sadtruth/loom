const fs = require('fs');
let content = fs.readFileSync('server/files.ts', 'utf8');

// Update IMAGE_EXT
content = content.replace(
  'const IMAGE_EXT = /\\.(png|jpe?g|gif|webp|avif|svg)$/i;',
  'const IMAGE_EXT = /\\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|heif|tif|tiff)$/i;'
);

// Update Kind
content = content.replace(
  'export type Kind = "markdown" | "text" | "image" | "page";',
  'export type Kind = "markdown" | "text" | "image" | "page" | "pdf" | "download";'
);

// Update kindOf
const kindOfOld = `export function kindOf(path: string): Kind | null {
  if (IMAGE_EXT.test(path) && !/\\.svg$/i.test(path)) return "image";
  if (/\\.(md|markdown)$/i.test(path)) return "markdown";
  // BEFORE \`TEXT_EXT\`, which also claims \`html?\` — and claiming it is how every prototype link ever
  // written opened as highlighted markup instead of as a page (item 10, 24 links in the audit).
  if (/\\.html?$/i.test(path)) return "page";
  if (TEXT_EXT.test(path)) return "text";
  if (!/\\.[A-Za-z0-9]{1,8}$/.test(path)) return "text"; // README, Makefile, LICENSE…
  return null;
}`;
const kindOfNew = `export function kindOf(path: string): Kind {
  if (/\\.pdf$/i.test(path)) return "pdf";
  if (IMAGE_EXT.test(path) && !/\\.svg$/i.test(path)) return "image";
  if (/\\.(md|markdown)$/i.test(path)) return "markdown";
  // BEFORE \`TEXT_EXT\`, which also claims \`html?\` — and claiming it is how every prototype link ever
  // written opened as highlighted markup instead of as a page (item 10, 24 links in the audit).
  if (/\\.html?$/i.test(path)) return "page";
  if (TEXT_EXT.test(path)) return "text";
  if (!/\\.[A-Za-z0-9]{1,8}$/.test(path)) return "text"; // README, Makefile, LICENSE…
  return "download";
}`;
content = content.replace(kindOfOld, kindOfNew);

// Add MAX_READ_BYTES
content = content.replace(
  'export const MAX_BYTES = 2 * 1024 * 1024;',
  'export const MAX_BYTES = 2 * 1024 * 1024;\nexport const MAX_READ_BYTES = 10 * 1024 * 1024;'
);

// Add truncateUtf8 function
const truncateCode = `
/**
 * Truncates a byte array at a given max length, taking care not to split a UTF-8 character.
 */
export function truncateUtf8(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  let end = max;
  // Look backwards for a UTF-8 starting byte or a single-byte ASCII character.
  // 10xxxxxx (0x80 to 0xBF) is a continuation byte.
  // 0xxxxxxx (0x00 to 0x7F) is ASCII (single byte).
  // 110xxxxx, 1110xxxx, 11110xxx (0xC0 to 0xF7) are starting bytes.
  while (end > 0 && (bytes[end] & 0xC0) === 0x80) {
    end--;
  }
  // Now \`end\` points to the first byte of a sequence. If that byte is not ASCII (it's a multi-byte
  // sequence start), we'll exclude the whole sequence to ensure truncation is clean.
  if (end > 0 && (bytes[end] & 0x80) !== 0) {
    // Drop the incomplete multi-byte sequence
    return bytes.slice(0, end);
  }
  // Otherwise, it was an ASCII byte, so it's safe to include up to \`max\` if we didn't back up.
  // Actually, wait: if it was ASCII, \`end\` will still be \`max\`. So \`bytes.slice(0, max)\` is fine.
  return bytes.slice(0, max);
}
`;
content += truncateCode;

fs.writeFileSync('server/files.ts', content);
console.log("Updated server/files.ts");
