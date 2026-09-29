import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: install the app-shell service worker. Production builds only — in dev
// Vite serves :5173 with HMR and a caching worker would fight it. The guard
// on "serviceWorker" covers non-secure origins (plain http://host.lan), where
// browsers hide the API entirely; installability needs real HTTPS
// (https://spark-dash.lan/) or loopback.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      console.warn("[sparkDash] service worker registration failed:", err);
    });
  });
}
