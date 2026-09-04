function truncateUtf8(bytes, max) {
  if (bytes.length <= max) return bytes;
  let i = max - 1;
  while (i >= 0 && (bytes[i] & 0xC0) === 0x80) {
    i--;
  }
  if (i < 0) return bytes.slice(0, 0); // shouldn't happen for valid utf-8

  let seqLen = 1;
  const b = bytes[i];
  if ((b & 0xE0) === 0xC0) seqLen = 2;
  else if ((b & 0xF0) === 0xE0) seqLen = 3;
  else if ((b & 0xF8) === 0xF0) seqLen = 4;

  if (max - i < seqLen) {
    return bytes.slice(0, i);
  }
  return bytes.slice(0, max);
}

const bytes = new Uint8Array([0x41, 0x42, 0xC3, 0xA9, 0x43]); // A B é C
console.log(truncateUtf8(bytes, 3)); // should be [0x41, 0x42]
console.log(truncateUtf8(bytes, 4)); // should be [0x41, 0x42, 0xC3, 0xA9]

const b2 = new TextEncoder().encode("emoji 🚀 end"); // 🚀 is 4 bytes
console.log("length", b2.length);
console.log(new TextDecoder().decode(truncateUtf8(b2, 9))); // "emoji "
console.log(new TextDecoder().decode(truncateUtf8(b2, 10))); // "emoji 🚀" (it will truncate to "emoji ")
console.log(new TextDecoder().decode(truncateUtf8(b2, 11))); // "emoji "
console.log(new TextDecoder().decode(truncateUtf8(b2, 12))); // "emoji "
