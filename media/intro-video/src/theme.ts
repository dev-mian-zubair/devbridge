// Shared visual language for the DevBridge intro video.
// Dark theme chosen to match the real dashboard screenshot (docs/screenshot.png).

export const colors = {
  bg: "#15171a",
  bgAlt: "#1a1d21",
  panel: "#1e2126",
  panelBorder: "#2c3036",
  text: "#e8e9ea",
  textDim: "#9aa0a6",
  textFaint: "#6b7177",
  accent: "#5aa9ff", // blue - links / primary accent
  accent2: "#3fb950", // green - success / connected / terminal prompt
  danger: "#ff6b6b", // crossed-out / strikethrough red
  amber: "#e3b341", // badges
  purple: "#b894ff",
};

export const fonts = {
  sans: "'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', 'Menlo', 'Consolas', monospace",
};

export const FPS = 30;

// Lead-in before narration starts, and hold after it ends, per scene (frames).
export const LEAD_IN = 15; // 0.5s
export const HOLD = 24; // 0.8s

// Quick fade in/out applied inside each scene so hard cuts feel snappy, not jarring.
export const CUT_FADE = 8; // frames
