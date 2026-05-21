// dispatch — entry point

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

// CSS — shell first (base tokens + layout), then screen-specific
import "./styles/shell.css";
import "./styles/issues.css";
import "./styles/ticket-detail.css";
import "./styles/settings.css";
import "./styles/analytics.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
