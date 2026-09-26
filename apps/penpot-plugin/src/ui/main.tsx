import { useAppStore } from "@microflow/design-bridge/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Penpot passes its theme in the URL: `#/?theme=dark` for version 2 manifests.
const theme = new URLSearchParams(location.hash.replace(/^#\/?/, "") || location.search).get("theme");
useAppStore.getState().setDarkMode(theme === "dark");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
