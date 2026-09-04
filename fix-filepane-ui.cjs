const fs = require('fs');
let content = fs.readFileSync('client/filepane.ts', 'utf8');

const newHandlers = `
  if (file.kind === "pdf") {
    // PDF iframe pointing at &raw=1
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

  if (file.kind === "page") {
`;
content = content.replace('if (file.kind === "page") {', newHandlers.trim());

const codeViewCall = `  show(handles, codeView(shown, file.text));`;
const newCodeViewCall = `  if (file.truncated) {
    const noteEl = note("");
    noteEl.textContent = \`showing the first \${readableBytes(file.text.length)} of \${readableBytes(file.bytes)} — \`;
    const rawLink = document.createElement("a");
    rawLink.href = \`/api/file?\${query}&raw=1\`;
    rawLink.target = "_blank";
    rawLink.textContent = "open raw";
    noteEl.append(rawLink);
    show(handles, noteEl);
  }

  show(handles, codeView(shown, file.text));`;

// we need to insert the truncated banner before codeView (for text) AND renderMarkdown (for markdown)
const mdStart = `if (file.kind === "markdown") {`;
const newMdStart = `
  let truncNote: HTMLElement | null = null;
  if (file.truncated) {
    truncNote = note("");
    // Use length of text (in characters) roughly as bytes, or just hardcode 2MB.
    // Requirement says: "showing the first 2 MB of 14.3 MB — open raw"
    // Using readableBytes(MAX_BYTES) maybe better, but we don't have MAX_BYTES here.
    // Let's just use 2 MB literal for the 2MB limit.
    truncNote.textContent = \`showing the first 2 MB of \${readableBytes(file.bytes)} — \`;
    const rawLink = document.createElement("a");
    rawLink.href = \`/api/file?\${query}&raw=1\`;
    rawLink.target = "_blank";
    rawLink.textContent = "open raw";
    truncNote.append(rawLink);
  }

  if (file.kind === "markdown") {`;

content = content.replace('if (file.kind === "markdown") {', newMdStart.trim());

// Insert `if (truncNote) handles.body.append(truncNote);` before `article.append` for markdown?
// Wait, `show(handles, article)` clears everything and appends the article.
// So we should build a wrapper or just use `show()` properly.
