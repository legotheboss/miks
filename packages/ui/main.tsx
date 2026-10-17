import { colors, getBuilderVarCSS } from "crosswing/colors";
import { CrosswingApp } from "crosswing/app";
import { CrosswingDesktopRootStyle } from "crosswing/containers";
import { fonts, GlobalFontFace } from "crosswing/fonts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createGlobalStyle } from "styled-components";
import { App } from "./App";

const RootStyle = createGlobalStyle`
  body {
    ${getBuilderVarCSS([colors.textBackground])}
    background: ${colors.textBackground()};
  }
`;

// A native app's chrome: the system font, not crosswing's web fonts.
const systemUI: GlobalFontFace = {
  family: `ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif`,
  weight: "normal",
  style: "normal",
  fallback: "sans-serif",
};

const miksFonts = [
  fonts.display.override({ face: systemUI, weight: "400" }),
  fonts.displayMedium.override({ face: systemUI, weight: "500" }),
  fonts.displayBold.override({ face: systemUI, weight: "600" }),
];

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <CrosswingDesktopRootStyle />
    <RootStyle />
    <CrosswingApp faces={[systemUI]} fonts={miksFonts}>
      <App />
    </CrosswingApp>
  </StrictMode>,
);
