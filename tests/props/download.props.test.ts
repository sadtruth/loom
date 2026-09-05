import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { contentDisposition } from "../../server/files.ts";

describe("contentDisposition", () => {
  test("returns single-line header", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const header = contentDisposition(name);
        expect(header).not.toContain("\r");
        expect(header).not.toContain("\n");
      })
    );
  });

  test("quoted filename contains no unescaped quote or raw backslash", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const header = contentDisposition(name);
        // Extract everything inside filename="..."
        const match = /filename="((?:[^"\\]|\\.)*?)"(?:;|$)/.exec(header);
        if (match) {
          const val = match[1];
          if (val === undefined) return;
          let i = 0;
          while (i < val.length) {
             if (val[i] === '\\') {
                 expect(i + 1).toBeLessThan(val.length);
                 expect(['\\', '"']).toContain(val[i + 1] as string);
                 i += 2;
             } else {
                 expect(val[i]).not.toBe('"');
                 i++;
             }
          }
        }
      })
    );
  });

  test("filename*= decodes exactly to original name", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const cleanName = name.replace(/[\x00-\x1F\x7F]/g, "");
        const header = contentDisposition(cleanName);
        const match = /filename\*=UTF-8''([^;]*)$/.exec(header);
        if (match && match[1] !== undefined) {
          expect(decodeURIComponent(match[1])).toBe(cleanName);
        }
      })
    );
  });

  test("never throws", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        expect(() => contentDisposition(name)).not.toThrow();
      })
    );
  });
});
