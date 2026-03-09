import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Settings from "./Settings";
import "./index.css";

const isSettings = window.location.hash === "#settings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isSettings ? <Settings /> : <App />}
  </React.StrictMode>,
);
