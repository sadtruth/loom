# Infinite Canvas Integration Design

## 1. The pane seam
A new pane in loom is defined in `client/index.html` as a sibling to `<section id="transcript" class="pane">`. The smallest existing pane's registration as a template is the drawer pane (`client/index.html:144-159`):
```html
      <aside id="drawer" class="pane">
        <div id="opens" role="tablist"></div>
        <div class="pane-head">
          <button id="drawer-tasks" class="drawer-pick" type="button" title="...">tasks</button>
          <button id="drawer-protos" class="drawer-pick" type="button" title="...">prototypes</button>
          <button id="drawer-files" class="drawer-pick" type="button" title="...">files</button>
          <span id="drawer-count" class="count">0</span>
          <button id="drawer-collapse" class="icon" title="Collapse">›</button>
        </div>
        <div id="drawer-body" class="pane-body"></div>
      </aside>
```
To lay it out, we add CSS rules in `client/style.css` (around line 90-100 where `.pane` rules are).
To register it, we add a DOM node lookup in `client/store.ts` (e.g., `boardBody: need<HTMLElement>("board-body")`).
To route to it and show it, we modify `client/app.ts:2977` (`setCentre`) to support `"board"` as an option alongside `"record"` and `"session"`.
To persist it, it needs an `OpenKind` in `client/opens.ts:16` (`export type OpenKind = "session" | "record" | "file" | "board";`).

## 2. The bundling problem
The server uses Bun's on-demand bundler `Bun.serve` without a build step (`server/main.ts:2`). If we bundle a large React dependency like tldraw into the main entry point, `server/main.ts`'s on-demand bundler will stall on a cold request, delaying the boot of the entire app.

The iframe with a `postMessage` protocol is the only option that keeps `client/app.ts` pure TypeScript and preserves boot time. The iframe approach costs a separate request but isolates React completely. We will add a new server route in `server/main.ts` (e.g., `/board.html`) that serves a separate HTML page with its own script tag (e.g., `<script type="module" src="./board.tsx"></script>`) to trigger a separate Bun bundle just for the canvas.

We will reuse the iframe embed seam from `client/embed.ts:206-207`, which creates the iframe and applies `frame.sandbox.add("allow-scripts");`. This sandbox is sufficient for tldraw to run, but blocks local storage or direct API fetches (`client/embed.ts:187`). Therefore, persistence must be driven by `postMessage` back to the parent `client/app.ts`, which already has authenticated WebSocket and fetch access.
The exact `postMessage` protocol sent from the iframe to the parent:
```typescript
type BoardMessage =
  | { type: "board_update"; payload: any /* tldraw snapshot */ };
```

## 3. Where the board lives
The board should live as a file on disk to follow the existing file storage patterns, such as how mockups/prototypes are stored. When tied to a project, it lives in the project directory (`server/files.ts:60` uses `PROJECTS_ROOT`). Let's define the path convention as `mockups/board.tldraw.json` relative to the project directory.

The storage format is a JSON file containing the serialized tldraw document state. When two devices have the board open, the last write to the JSON file wins, and the server will broadcast the new file hash to clients (as it does for file edits in `server/files.ts:1506`).

## 4. The agent's channel
The agent runs as a child process via `server/input.ts:10`. It interacts with the workspace via file reading and writing. The smallest thing that works is the agent reading and writing the `mockups/board.tldraw.json` file.

To "add these shapes", the agent uses its file writing tool to rewrite `mockups/board.tldraw.json`.
The literal JSON payload is a tldraw snapshot:
```json
{
  "store": {
    "shape:123": { "id": "shape:123", "type": "geo", "props": { "w": 100, "h": 100, "geo": "rectangle" } }
  }
}
```
To "tell me what is on the board", the agent uses its file reading tool to read `mockups/board.tldraw.json`.

## 5. Turn-taking
The human signals "look at this now" using the existing chat interface in `client/app.ts`. The human types a message like "Look at the board" or "I updated the diagram" and presses send.
The agent signals "I have drawn, your turn" by writing the file and completing its text response in the transcript. The human sees the turn finish via the `drawStep` indication in `client/working.ts:194` settling.

## 6. Live update
When the agent updates the board file, it generates a file touch event in the transcript. The server parses the transcript in `server/transcript.ts` and pushes a WebSockets `Frame` of type `"append"` (`client/types.ts:169`, dispatched from `server/main.ts:375` inside the tailer callback).
The client receives this frame in `client/app.ts:4183`. We will hook into this to check if `frame.artifacts` (`client/types.ts:127`) includes an edit to `mockups/board.tldraw.json`. If it does, `client/app.ts` triggers a fetch of the new file content and sends it to the iframe via `postMessage`.

## 7. The build, in stages
**Stage 1:** A standalone HTML entry point (`server/main.ts` route + `client/board.html` + `client/board.tsx`) that renders an empty tldraw canvas.
*Delivers:* The React dependency bundled correctly by Bun without infecting `app.ts`.
*Touches:* `server/main.ts`, new files `client/board.html`, `client/board.tsx`.
*Check:* Open `/board.html` directly in the browser; fails if Bun throws a JSX compilation error or tldraw fails to load.

**Stage 2:** The pane integration and `postMessage` pipe.
*Delivers:* The canvas appearing as a pane inside loom, saving its state via `postMessage` to `app.ts`, which sends it to a `/api/file` write endpoint.
*Touches:* `client/index.html`, `client/style.css`, `client/store.ts`, `client/app.ts`, `client/opens.ts`, `client/filepane.ts`.
*Check:* Draw a box, reload the page, ensure the box is still there; fails if the `sandbox="allow-scripts"` blocks the `postMessage` dispatch.

**Stage 3:** Live updates from the agent.
*Delivers:* The board updating live when the agent modifies the underlying `.tldraw.json` file.
*Touches:* `client/app.ts` (the WebSocket `"append"` handler).
*Check:* Manually edit the JSON file on disk while the browser is open; fails if the iframe does not update to reflect the change.

## 8. What could make this a bad idea
1. **The Sandbox Trap:** `client/embed.ts:207` uses `<iframe sandbox="allow-scripts">`. tldraw might internally throw hard errors or refuse to mount if it detects that `localStorage` or `indexedDB` are completely inaccessible, rather than gracefully degrading.
2. **Sync Collisions:** The client saves by sending full snapshots to `/api/file` and the agent saves by overwriting the file. Since there is no CRDT logic or partial-update endpoint, if the human and agent draw at the exact same time, one will blindly overwrite the other's shapes.
3. **Bundle Bloat Timeout:** Even separated into its own route, the first time the owner clicks the board pane, `server/main.ts` will ask Bun to bundle tldraw and React on the fly. If this synchronous bundle step takes longer than the client's timeout (or blocks the main thread for other requests), the UI will freeze or show a broken pane.
