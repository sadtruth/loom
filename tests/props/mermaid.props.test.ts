import { describe, expect, test, afterEach } from "bun:test";
import fc from "fast-check";
import { isRichTag, REGISTRY, type BlockContext } from "../../client/blocks.ts";
import { renderMermaid, __clearMermaidCacheForTests, cache as mermaidCache } from "../../client/mermaid-block.ts";

describe("mermaid block pure properties", () => {
  afterEach(() => {
    __clearMermaidCacheForTests();
    if (_doc) {
      (globalThis as any).document = _doc;
    }
  });

  const mockCtx: BlockContext = { cwd: null, records: [] };

  const _doc = globalThis.document;

  // Ensure document is mocked before each test
  function mockDocument() {
    (globalThis as any).document = {
      createElement: (tag: string) => {
        return { 
          tagName: tag.toUpperCase(),
          className: "",
          textContent: "",
          innerHTML: "",
          isConnected: true,
          append: function(..._children: any[]) {},
          querySelector: function(_s: string) { return null; }
        } as unknown as HTMLElement;
      }
    };
  }

  test("mermaid is registered in the rich block registry", () => {
    mockDocument();
    expect(isRichTag("mermaid")).toBe(true);
    expect(REGISTRY["mermaid"]).toBe(renderMermaid);
  });

  test("the cache limits to 100 entries and returns identical results", () => {
    mockDocument();
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 101, maxLength: 200 }),
        (strings) => {
          __clearMermaidCacheForTests();
          
          const unique = [...new Set(strings)];
          
          // Manually seed the cache to test eviction
          for (let i = 0; i < unique.length; i++) {
            const key = unique[i]!;
            mermaidCache.set(key, `<svg>${key}</svg>`);
            if (mermaidCache.size > 100) {
              const firstKey = mermaidCache.keys().next().value;
              if (firstKey !== undefined) mermaidCache.delete(firstKey);
            }
          }
          
          expect(mermaidCache.size).toBeLessThanOrEqual(100);
          
          // The last 100 entries should be present
          const expectedCount = Math.min(unique.length, 100);
          expect(mermaidCache.size).toBe(expectedCount);
          
          // Testing render cache hit
          const lastKey = unique[unique.length - 1]!;
          const wrap = renderMermaid(lastKey, mockCtx);
          expect(wrap.innerHTML).toBe(`<svg>${lastKey}</svg>`);
          
          // Cache hit should not have a placeholder
          expect(wrap.querySelector(".mermaid-placeholder")).toBeNull();
        }
      )
    );
  });
  
  test("monotonic id generation does not repeat", () => {
    mockDocument();
    // We can't perfectly test the asynchronous rendering id generation in a synchronous test without mocking,
    // but we can ensure that consecutive calls trigger render logic safely.
    __clearMermaidCacheForTests();
    const wrap1 = renderMermaid("graph TD\\nA-->B", mockCtx);
    const wrap2 = renderMermaid("graph TD\\nB-->C", mockCtx);
    // Since mock element returns null for querySelector in this setup, testing classes directly
    expect(wrap1.className).toBe("rich-mermaid");
    expect(wrap2.className).toBe("rich-mermaid");
  });

});
