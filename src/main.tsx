import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTheme } from "./theme";
import "./styles.css";

initTheme(); // set data-theme before first paint (no flash)

if (import.meta.env.PROD) {
  window.addEventListener(
    "contextmenu",
    (event) => {
      // Keep the native menu on text fields (copy/paste/spellcheck); the app
      // attaches its own menus elsewhere, so suppress the default there.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) {
        return;
      }
      event.preventDefault();
    },
    { capture: true }
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
