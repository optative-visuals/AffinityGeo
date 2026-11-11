// The React root.
import "maplibre-gl/dist/maplibre-gl.css";
import "./tokens.css";
import "./map/basemap.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
