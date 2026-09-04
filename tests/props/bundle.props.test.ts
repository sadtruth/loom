/**
 * Bundle-identity helper properties (client/bundle.ts, R2/R4).
 *
 * P-bundle-1: sameBundle is true when page and HTML share the same file name.
 * P-bundle-2: sameBundle is false when page and HTML have different file names.
 * P-bundle-3: sameBundle is true when HTML has no module script (unbundled page must not reload).
 * P-bundle-4: all three Bun path shapes are handled by bundleNameOf.
 * P-bundle-5: styleHashOf recovers the hash from both stylesheet shapes.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { bundleNameOf, sameBundle, styleHashOf } from "../../client/bundle.ts";

/** Arbitrary lowercase hex hash of fixed length. */
const arbHash = fc.stringMatching(/^[a-z0-9]{8,16}$/);

describe("bundleNameOf and sameBundle properties", () => {
  test("P-bundle-1: same name → sameBundle true (all three path shapes)", () => {
    fc.assert(
      fc.property(arbHash, (hash) => {
        const name = `chunk-${hash}.js`;

        // /_bun/client/ shape (development: true)
        const html1 = `<script type="module" src="/_bun/client/${name}"></script>`;
        expect(sameBundle(`/_bun/client/${name}`, html1)).toBe(true);

        // /chunk- shape (development: {hmr:false})
        const html2 = `<script type="module" src="/chunk-${hash}.js"></script>`;
        expect(sameBundle(`/chunk-${hash}.js`, html2)).toBe(true);

        // /../chunk- shape (development: false / production)
        const html3 = `<script type="module" src="/../chunk-${hash}.js"></script>`;
        // Browser normalises /../chunk-x.js to /chunk-x.js, so pageSrc would be /chunk-x.js
        expect(sameBundle(`/chunk-${hash}.js`, html3)).toBe(true);
      }),
    );
  });

  test("P-bundle-2: different hashes → sameBundle false", () => {
    fc.assert(
      fc.property(arbHash, arbHash, (hashA, hashB) => {
        fc.pre(hashA !== hashB);
        const html = `<script type="module" src="/chunk-${hashB}.js"></script>`;
        expect(sameBundle(`/chunk-${hashA}.js`, html)).toBe(false);
      }),
    );
  });

  test("P-bundle-3: HTML with no module script → sameBundle true (unbundled page must not reload)", () => {
    const noScript = "<html><body>hello</body></html>";
    expect(sameBundle("/chunk-abc.js", noScript)).toBe(true);
    expect(sameBundle("/_bun/client/abc.js", noScript)).toBe(true);
  });

  test("P-bundle-4: bundleNameOf extracts correct file name from all three path shapes", () => {
    fc.assert(
      fc.property(arbHash, (hash) => {
        const name = `chunk-${hash}.js`;

        expect(bundleNameOf(`<script type="module" src="/_bun/client/${name}"></script>`)).toBe(name);
        expect(bundleNameOf(`<script type="module" src="/chunk-${hash}.js"></script>`)).toBe(`chunk-${hash}.js`);
        expect(bundleNameOf(`<script type="module" src="/../chunk-${hash}.js"></script>`)).toBe(`chunk-${hash}.js`);
      }),
    );
  });

  test("P-bundle-4: bundleNameOf returns null when there is no module script", () => {
    expect(bundleNameOf("<html><body></body></html>")).toBeNull();
    expect(bundleNameOf("<script src='/app.js'></script>")).toBeNull(); // no type=module
    expect(bundleNameOf("")).toBeNull();
  });

  test("P-bundle-4: bundleNameOf ignores query strings", () => {
    fc.assert(
      fc.property(arbHash, (hash) => {
        const html = `<script type="module" src="/chunk-${hash}.js?v=123"></script>`;
        expect(bundleNameOf(html)).toBe(`chunk-${hash}.js`);
      }),
    );
  });
});

describe("styleHashOf properties", () => {
  test("P-bundle-5: styleHashOf recovers hash from /chunk-<hash>.css shape", () => {
    fc.assert(
      fc.property(arbHash, (hash) => {
        expect(styleHashOf(`/chunk-${hash}.css`)).toBe(hash);
        expect(styleHashOf(`https://localhost:4173/chunk-${hash}.css`)).toBe(hash);
      }),
    );
  });

  test("P-bundle-5: styleHashOf recovers hash from /_bun/asset/<hash>.css shape", () => {
    fc.assert(
      fc.property(arbHash, (hash) => {
        expect(styleHashOf(`/_bun/asset/${hash}.css`)).toBe(hash);
        expect(styleHashOf(`https://localhost:4173/_bun/asset/${hash}.css`)).toBe(hash);
      }),
    );
  });

  test("P-bundle-5: styleHashOf returns null when href is not a known stylesheet shape", () => {
    expect(styleHashOf("")).toBeNull();
    expect(styleHashOf("/style.css")).toBeNull();
    expect(styleHashOf("/app.js")).toBeNull();
  });
});
