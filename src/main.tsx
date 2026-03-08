import React from "react";
import ReactDOM from "react-dom/client";
import VoiceWidget from "./VoiceWidget";
import "./voice-widget.css";

// Mount the widget into a container div.
// Your developer should add <div id="vizuara-voice-widget"></div> to their page.
const container = document.getElementById("vizuara-voice-widget");
if (container) {
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <VoiceWidget />
    </React.StrictMode>
  );
}
