const fs = require('fs');
let content = fs.readFileSync('client/filepane.ts', 'utf8');

// Undo the half-baked change
content = content.replace(
  `let truncNote: HTMLElement | null = null;
  if (file.truncated) {
    truncNote = note("");
    // Use length of text (in characters) roughly as bytes, or just hardcode 2MB.
    // Requirement says: "showing the first 2 MB of 14.3 MB — open raw"
    // Using readableBytes(MAX_BYTES) maybe better, but we don't have MAX_BYTES here.
    // Let's just use 2 MB literal for the 2MB limit.
    truncNote.textContent = \\\`showing the first 2 MB of \\\${readableBytes(file.bytes)} — \\\`;
    const rawLink = document.createElement("a");
    rawLink.href = \\\`/api/file?\\\${query}&raw=1\\\`;
    rawLink.target = "_blank";
    rawLink.textContent = "open raw";
    truncNote.append(rawLink);
  }

  if (file.kind === "markdown") {`,
  `if (file.kind === "markdown") {`
);

// We should append the truncNote to a container and then append the actual content, passing the container to `show`.
const newMdStart = `
  let container: HTMLElement | null = null;
  if (file.truncated) {
    container = document.createElement("div");
    const truncNote = note("");
    truncNote.textContent = \`showing the first 2 MB of \${readableBytes(file.bytes)} — \`;
    const rawLink = document.createElement("a");
    rawLink.href = \`/api/file?\${query}&raw=1\`;
    rawLink.target = "_blank";
    rawLink.textContent = "open raw";
    truncNote.append(rawLink);
    container.append(truncNote);
  }

  if (file.kind === "markdown") {
    const article = document.createElement("article");
    article.className = "file-md";
    // \`lines: true\` — the rendered blocks carry the source line they start at, so a \`:86\` chip can
    // land inside a record instead of reporting that the file has no such line (item 13).
    article.append(renderMarkdown(file.text, ctx, { lines: true }));

    if (container) {
      container.append(article);
      show(handles, container);
    } else {
      show(handles, article);
    }

    if (place !== undefined) landOn(handles, article, place);
    return;
  }

  const cv = codeView(shown, file.text);
  if (container) {
    container.append(cv);
    show(handles, container);
  } else {
    show(handles, cv);
  }

  if (place !== undefined) landOn(handles, handles.body, place);
}
`;

// Regex replace the old markdown block and code view block:
const regex = /if \(file\.kind === "markdown"\) \{[\s\S]+if \(place !== undefined\) landOn\(handles, handles\.body, place\);\n\}/;
content = content.replace(regex, newMdStart.trim() + "\n}");

fs.writeFileSync('client/filepane.ts', content);
