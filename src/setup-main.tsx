import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import SetupWizard from "./components/SetupWizard";
import "./styles/setup.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SetupWizard />
  </React.StrictMode>,
);
