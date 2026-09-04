import { truncateUtf8 } from "./server/files.ts";

const bytes = new Uint8Array([0x41, 0x42, 0xC3, 0xA9, 0x43]); // A B é C
console.log(truncateUtf8(bytes, 3)); // should be [0x41, 0x42]
console.log(truncateUtf8(bytes, 4)); // should be [0x41, 0x42, 0xC3, 0xA9]
