import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/noto-sans-jp/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import { App } from "./app/App";
import { parseViewerParams } from "./app/viewerParams";
import { GalleryPage } from "./gallery/GalleryPage";
import { VisualLanguagePrototype } from "./prototypes/visualLanguage/VisualLanguagePrototype";
import { RendererSpike } from "./spikes/renderer/RendererSpike";
import "./app/app.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

const prototype = new URLSearchParams(window.location.search).get("prototype");
const spike = new URLSearchParams(window.location.search).get("spike");
const params = parseViewerParams(window.location.search);
const showViewer =
  params.src !== null || params.dataset !== null || params.embed || params.forceViewer;
const app =
  spike === "renderer" ? (
    <RendererSpike />
  ) : prototype === "visual-language" ? (
    <VisualLanguagePrototype />
  ) : showViewer ? (
    <App />
  ) : (
    <GalleryPage />
  );

createRoot(root).render(<StrictMode>{app}</StrictMode>);
