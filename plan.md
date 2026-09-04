1.  **Update `server/files.ts` kinds and constants:**
    *   Add `.bmp`, `.ico`, `.heic`, `.heif`, `.tif`, `.tiff` to `IMAGE_EXT`.
    *   Change `Kind` to `"markdown" | "text" | "image" | "page" | "pdf" | "download"`.
    *   Update `kindOf()`:
        *   Return `"pdf"` for `/\.pdf$/i`.
        *   Instead of returning `null`, return `"download"` at the end.
        *   Make sure `kindOf` is TOTAL (never returns null/undefined).
    *   Add `MAX_READ_BYTES = 10 * 1024 * 1024;` to increase the cap for JSON read path to 10MB. Keep `MAX_BYTES = 2 * 1024 * 1024` for the truncation point.

2.  **Update `/api/file` in `server/main.ts`:**
    *   Remove size limit for `raw=1`. When `raw=1` is true, return `new Response(Bun.file(verdict.path), { headers: { ... } })` so it streams without reading into memory. Note that `looksBinary` sniff won't happen if we return immediately, but we can do it only for the JSON path.
    *   Add `"pdf"` support for `raw=1`: `application/pdf`. Ensure CSP is set exactly to `"sandbox allow-scripts"`.
    *   For the JSON read path:
        *   Read file. Check size against `MAX_READ_BYTES` (10MB). If `> 10MB`, read first 2MB, otherwise read whole file. Or better, always read whole file if `< 10MB`, else read first 2MB. Wait, the requirement says "Above 10 MB it still returns the first 2 MB with `truncated: true`".
        *   Read first `min(file.size, 2MB + some buffer)` or we can just read first 2MB + a few bytes to safely truncate at UTF-8 boundary. Actually, `Bun.file().slice(0, 2MB).arrayBuffer()` might split a multi-byte character.
        *   Instead, read `slice(0, MAX_BYTES + 4)`. Find the correct UTF-8 boundary within `MAX_BYTES`.
        *   If file size > `MAX_BYTES`, set `truncated: true` and `bytes: file.size`.
        *   Run binary sniff (`looksBinary`) *after* reading bytes. If positive, change kind to `"download"`. No longer return 415.

3.  **Update `client/filepane.ts`:**
    *   Add `truncated?: boolean` to `FileResponse`.
    *   Update `IMAGE` regex to match the new image extensions.
    *   If `file.truncated` is true, show a visible note: `showing the first 2 MB of 14.3 MB — open raw` with a raw link.
    *   If `file.kind === "pdf"`, show an `<iframe>` pointing to the same path with `&raw=1`.
    *   If `file.kind === "download"`, render file name, size, open raw link, and download link.

4.  **Add `tests/props/files.props.test.ts`:**
    *   Test `kindOf` is total.
    *   Test path's kind depends only on its extension.
    *   Test truncation arithmetic.

5.  **Run Tests & Pre-commit:** Ensure `tsc` and tests pass.
