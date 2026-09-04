const fs = require('fs');
let content = fs.readFileSync('server/main.ts', 'utf8');

// Also need to import MAX_READ_BYTES and truncateUtf8
content = content.replace(
  'MAX_BYTES, guardFrom, kindOf, listDir, locate, looksBinary, resolveWiki, wikiScope',
  'MAX_BYTES, MAX_READ_BYTES, truncateUtf8, guardFrom, kindOf, listDir, locate, looksBinary, resolveWiki, wikiScope'
);

const oldCode = `
      const kind = kindOf(verdict.path);
      if (kind === null) return new Response("not a readable kind", { status: 415 });

      const file = Bun.file(verdict.path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      if (file.size > MAX_BYTES) return new Response("too large to read here", { status: 413 });
      if (kind === "image") return new Response(file);

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksBinary(bytes)) return new Response("binary", { status: 415 });
      // \`raw=1\` serves the document itself — how a prototype opens in its own browser tab. The CSP
      // sandbox keeps it opaque-origin there, the same stance the iframe block takes: it may run,
      // it may not reach the loom API or storage the cookie would otherwise hand it.
      if (new URL(req.url).searchParams.get("raw") === "1") {
        const html = /\\.html?$/i.test(verdict.path);
        // SVG is deliberately NOT an image to \`kindOf\` — the file pane reads it as source — so an
        // \`img\` pointing here got a JSON document and drew nothing (SPEC 166). Only \`raw=1\` says
        // "serve the file itself", and the sandbox header below already denies it everything.
        const svg = /\\.svg$/i.test(verdict.path);
        return new Response(bytes, {
          headers: {
            "content-type": html
              ? "text/html; charset=utf-8"
              : svg
                ? "image/svg+xml; charset=utf-8"
                : "text/plain; charset=utf-8",
            "content-security-policy": "sandbox allow-scripts",
          },
        });
      }
      return json({ path: verdict.path, kind, bytes: file.size, text: new TextDecoder().decode(bytes) });
`;

const newCode = `
      let kind = kindOf(verdict.path);

      const file = Bun.file(verdict.path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });

      // \`raw=1\` serves the document itself — how a prototype opens in its own browser tab. The CSP
      // sandbox keeps it opaque-origin there, the same stance the iframe block takes: it may run,
      // it may not reach the loom API or storage the cookie would otherwise hand it.
      if (new URL(req.url).searchParams.get("raw") === "1") {
        const html = /\\.html?$/i.test(verdict.path);
        // SVG is deliberately NOT an image to \`kindOf\` — the file pane reads it as source — so an
        // \`img\` pointing here got a JSON document and drew nothing (SPEC 166). Only \`raw=1\` says
        // "serve the file itself", and the sandbox header below already denies it everything.
        const svg = /\\.svg$/i.test(verdict.path);
        const pdf = /\\.pdf$/i.test(verdict.path);
        return new Response(file, {
          headers: {
            "content-type": html
              ? "text/html; charset=utf-8"
              : svg
                ? "image/svg+xml; charset=utf-8"
                : pdf
                  ? "application/pdf"
                  : "text/plain; charset=utf-8",
            "content-security-policy": "sandbox allow-scripts",
          },
        });
      }

      if (kind === "image") return new Response(file);

      if (file.size > MAX_READ_BYTES) return new Response("too large to read here", { status: 413 });

      const truncated = file.size > MAX_BYTES;
      // Read up to MAX_BYTES + 4 to ensure we have enough bytes to find a boundary
      const sliceSize = truncated ? MAX_BYTES + 4 : file.size;
      const rawBytes = new Uint8Array(await file.slice(0, sliceSize).arrayBuffer());
      const bytes = truncated ? truncateUtf8(rawBytes, MAX_BYTES) : rawBytes;

      if (looksBinary(bytes)) {
        kind = "download";
      }

      return json({
        path: verdict.path,
        kind,
        bytes: file.size,
        text: kind === "download" ? "" : new TextDecoder().decode(bytes),
        truncated: truncated && kind !== "download" ? true : undefined
      });
`;

content = content.replace(oldCode.trim(), newCode.trim());
fs.writeFileSync('server/main.ts', content);
