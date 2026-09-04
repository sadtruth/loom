const fs = require('fs');
let content = fs.readFileSync('server/files.ts', 'utf8');

const newTruncateCode = `
/**
 * Truncates a byte array at a given max length, taking care not to split a UTF-8 character.
 */
export function truncateUtf8(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  let i = max - 1;
  while (i >= 0 && (bytes[i]! & 0xC0) === 0x80) {
    i -= 1;
  }
  if (i < 0) return bytes.slice(0, 0);

  let seqLen = 1;
  const b = bytes[i]!;
  if ((b & 0xE0) === 0xC0) seqLen = 2;
  else if ((b & 0xF0) === 0xE0) seqLen = 3;
  else if ((b & 0xF8) === 0xF0) seqLen = 4;

  if (max - i < seqLen) {
    return bytes.slice(0, i);
  }
  return bytes.slice(0, max);
}
`;

content = content.replace(/\/\*\*\n \* Truncates a byte array[\s\S]+}$/m, newTruncateCode.trim());
fs.writeFileSync('server/files.ts', content);
