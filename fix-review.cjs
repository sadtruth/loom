const fs = require('fs');

// 1. Fix server/main.ts - don't return 413 for >10MB, still read first 2MB.
// Also fix the raw=1 issue for images.
let mainTs = fs.readFileSync('server/main.ts', 'utf8');

// We will reconstruct the /api/file logic cleanly.
const mainOldCode = `
      let kind = kindOf(verdict.path);

      const file = Bun.file(verdict.path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });

      // \\\`raw=1\\\` serves the document itself — how a prototype opens in its own browser tab. The CSP
      // sandbox keeps it opaque-origin there, the same stance the iframe block takes: it may run,
      // it may not reach the loom API or storage the cookie would otherwise hand it.
      if (new URL(req.url).searchParams.get("raw") === "1") {
        const html = /\\\\.html?$/i.test(verdict.path);
        // SVG is deliberately NOT an image to \\\`kindOf\\\` — the file pane reads it as source — so an
        // \\\`img\\\` pointing here got a JSON document and drew nothing (SPEC 166). Only \\\`raw=1\\\` says
        // "serve the file itself", and the sandbox header below already denies it everything.
        const svg = /\\\\.svg$/i.test(verdict.path);
        const pdf = /\\\\.pdf$/i.test(verdict.path);
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

// It seems my previous replace was very messy. Let's just find the function bounds.
let m1 = mainTs.indexOf('"/api/file": async (req) => {');
let m2 = mainTs.indexOf('"/api/models": {');
if (m1 > -1 && m2 > -1) {
  const fileApiBody = `"/api/file": async (req) => {
      const denied = requireAuth(req);
      if (denied !== null) return denied;
      const params = new URL(req.url).searchParams;
      // \`wiki=\` is a note NAME, not a path: \`[[A note]]\` says which note without saying where it is,
      // so the vault index answers that before the guard sees anything (link kind 11). The answer is
      // then judged like any other path — the index only ever proposes.
      const wiki = params.get("wiki");
      let raw = params.get("path");
      if (wiki !== null && wiki.length > 0) {
        const found = await resolveWiki(wikiScope(GUARD, VAULT_ROOT), wiki);
        if (found === null) return new Response(\`no note named "\${wiki}" in the vault\`, { status: 404 });
        raw = found;
      }
      if (raw === null) return new Response("path required", { status: 400 });
      // \`base\` is the session's cwd, sent by the client so a RELATIVE chip resolves against the tree
      // the prose was written about and not only the record directory (SPEC 143).
      // \`record\` is the record the reader has open: a second ladder, tried only when the session's
      // own missed (SPEC 245).
      const verdict = await locate(GUARD, raw, params.get("base"), params.get("record"));
      if (!verdict.ok) return new Response(verdict.reason, { status: verdict.status });

      // A directory answers with a LISTING rather than the 404 it used to give: a chip to a folder
      // is a normal thing to write, and the pane draws each entry as a chip of its own (SPEC 141).
      let entry: Stats;
      try {
        entry = await stat(verdict.path);
      } catch {
        return new Response("not found", { status: 404 });
      }
      if (entry.isDirectory()) {
        return json({ path: verdict.path, kind: "dir", bytes: 0, text: "", entries: await listDir(verdict.path) });
      }

      let kind = kindOf(verdict.path);

      const file = Bun.file(verdict.path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });

      // \`raw=1\` serves the document itself — how a prototype opens in its own browser tab. The CSP
      // sandbox keeps it opaque-origin there, the same stance the iframe block takes: it may run,
      // it may not reach the loom API or storage the cookie would otherwise hand it.
      if (new URL(req.url).searchParams.get("raw") === "1") {
        const html = /\\.html?$/i.test(verdict.path);
        const svg = /\\.svg$/i.test(verdict.path);
        const pdf = /\\.pdf$/i.test(verdict.path);

        let contentType = "text/plain; charset=utf-8";
        if (html) contentType = "text/html; charset=utf-8";
        else if (svg) contentType = "image/svg+xml; charset=utf-8";
        else if (pdf) contentType = "application/pdf";
        else if (kind === "image") {
          // If it's another image kind, we shouldn't force text/plain.
          // We can use Bun's default by not overriding it or we can just send the file response directly.
          // Let's use file.type for standard images since Bun resolves it.
          contentType = file.type;
        }

        return new Response(file, {
          headers: {
            "content-type": contentType,
            "content-security-policy": "sandbox allow-scripts",
          },
        });
      }

      if (kind === "image") return new Response(file);

      // JSON path reads max 10MB into memory. But it ALWAYS returns something.
      // If > 10MB it still truncates to 2MB, same as between 2MB and 10MB.
      // So actually, if >10MB we don't reject. We just read 2MB anyway.

      const truncated = file.size > MAX_BYTES;
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
    },

    `;

  mainTs = mainTs.substring(0, m1) + fileApiBody + mainTs.substring(m2);
  fs.writeFileSync('server/main.ts', mainTs);
}

// 2. Fix client/filepane.ts
let filePaneTs = fs.readFileSync('client/filepane.ts', 'utf8');
// Inject the pdf and download handlers before the page handler.
let pageIdx = filePaneTs.indexOf('if (file.kind === "page") {');
if (pageIdx > -1) {
  const injectedHandlers = `
  if (file.kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "file-embed";
    frame.src = \`/api/file?\${query}&raw=1\`;
    show(handles, frame);
    return;
  }

  if (file.kind === "download") {
    const box = document.createElement("div");
    box.className = "file-note file-download";
    box.append(Object.assign(document.createElement("p"), { textContent: \`\${base(shown)} (\${readableBytes(file.bytes)})\` }));

    const actions = document.createElement("div");
    actions.className = "file-roots";

    const rawLink = document.createElement("a");
    rawLink.href = \`/api/file?\${query}&raw=1\`;
    rawLink.target = "_blank";
    rawLink.textContent = "open raw in tab";

    const dlLink = document.createElement("a");
    dlLink.href = \`/api/file?\${query}&raw=1\`;
    dlLink.download = base(shown);
    dlLink.textContent = "download";

    actions.append(rawLink, " · ", dlLink);
    box.append(actions);

    show(handles, box);
    return;
  }

  `;
  filePaneTs = filePaneTs.substring(0, pageIdx) + injectedHandlers + filePaneTs.substring(pageIdx);
  fs.writeFileSync('client/filepane.ts', filePaneTs);
}
