import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTheme } from "./theme";
import "./styles.css";

initTheme(); // set data-theme before first paint (no flash)

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
