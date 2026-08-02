import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/noto-sans-jp/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import { App } from "./app/App";
import { parseViewerParams } from "./app/viewerParams";
import { GalleryPage } from "./gallery/GalleryPage";
import { GraphEditingPrototype } from "./prototypes/graph-editing/GraphEditingPrototype";
import "./app/app.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

const prototype = new URLSearchParams(window.location.search).get("prototype");

const params = parseViewerParams(window.location.search);
const showViewer =
  params.src !== null || params.dataset !== null || params.embed || params.forceViewer;

createRoot(root).render(
  <StrictMode>
    {prototype === "graph-editing" ? (
      <GraphEditingPrototype />
    ) : showViewer ? (
      <App />
    ) : (
      <GalleryPage />
    )}
  </StrictMode>,
);
