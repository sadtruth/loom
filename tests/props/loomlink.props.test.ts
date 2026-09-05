import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { loomFileUrl, pathFromLoomUrl } from "../../client/paths.ts";

describe("loomFileUrl and pathFromLoomUrl", () => {
  test("Round-trip pathFromLoomUrl(loomFileUrl(origin, p)) === p", () => {
    fc.assert(
      fc.property(
        fc.webUrl(),
        fc.string(),
        (origin, path) => {
          const url = loomFileUrl(origin, path);
          expect(pathFromLoomUrl(url)).toBe(path);
        }
      )
    );
  });

  test("The generated URL never contains a raw space or a raw #", () => {
    fc.assert(
      fc.property(
        fc.webUrl(),
        fc.string(),
        (origin, path) => {
          const url = loomFileUrl(origin, path);
          const queryString = url.substring(origin.length);
          expect(queryString).not.toContain(" ");
          expect(queryString).not.toContain("#");
        }
      )
    );
  });

  test("pathFromLoomUrl returns null for a URL with no file parameter, and never throws", () => {
    fc.assert(
      fc.property(
        fc.string(),
        (url) => {
          let result;
          try {
            result = pathFromLoomUrl(url);
          } catch (e) {
            expect().fail("Should not throw");
          }
          if (result !== null) {
            try {
              const u = new URL(url);
              expect(u.searchParams.has("file")).toBe(true);
            } catch {
              expect(result === null).toBe(true);
            }
          }
        }
      )
    );
  });
});
