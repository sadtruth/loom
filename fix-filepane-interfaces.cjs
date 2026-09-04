const fs = require('fs');
let content = fs.readFileSync('client/filepane.ts', 'utf8');

content = content.replace(
  'kind: "markdown" | "text" | "dir" | "page";',
  'kind: "markdown" | "text" | "dir" | "page" | "pdf" | "download";\n  truncated?: boolean;'
);

content = content.replace(
  'const IMAGE = /\\.(png|jpe?g|gif|webp|avif)$/i;',
  'const IMAGE = /\\.(png|jpe?g|gif|webp|avif|bmp|ico|heic|heif|tif|tiff)$/i;'
);

fs.writeFileSync('client/filepane.ts', content);
