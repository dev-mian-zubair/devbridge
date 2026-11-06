import React from "react";
import { colors, fonts } from "../theme";

type WindowChromeProps = {
  title: string;
  width: number;
  children: React.ReactNode;
  accentDot?: string;
};

/**
 * A simple dark "window" frame (traffic-light dots + title bar) used for both
 * the terminal and code-editor style scenes. Deliberately plain — inspired by
 * cos's Terminal/CodeEditor look, but written from scratch and dependency-free.
 */
export const WindowChrome: React.FC<WindowChromeProps> = ({ title, width, children }) => {
  return (
    <div
      style={{
        width,
        borderRadius: 14,
        overflow: "hidden",
        background: colors.panel,
        border: `1px solid ${colors.panelBorder}`,
        boxShadow: "0 40px 90px rgba(0,0,0,0.55)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "16px 22px",
          background: colors.bgAlt,
          borderBottom: `1px solid ${colors.panelBorder}`,
        }}
      >
        <div style={{ width: 14, height: 14, borderRadius: 8, background: "#ff5f56" }} />
        <div style={{ width: 14, height: 14, borderRadius: 8, background: "#ffbd2e" }} />
        <div style={{ width: 14, height: 14, borderRadius: 8, background: "#27c93f" }} />
        <div
          style={{
            marginLeft: 16,
            fontFamily: fonts.mono,
            fontSize: 20,
            color: colors.textFaint,
          }}
        >
          {title}
        </div>
      </div>
      <div style={{ padding: "36px 44px" }}>{children}</div>
    </div>
  );
};
