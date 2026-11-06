import React from "react";
import { Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { SceneBase } from "../components/SceneBase";
import { colors, fonts } from "../theme";

// Real dashboard screenshot is 1440x900. The "Sign In" button sits in the
// bottom-left sidebar, roughly centered at (139, 865) px in that screenshot
// (measured by eye from docs/screenshot.png).
const IMG_W = 1440;
const IMG_H = 900;
const BUTTON_CENTER = { x: 139 / IMG_W, y: 865 / IMG_H };
const BUTTON_SIZE = { w: 246 / IMG_W, h: 30 / IMG_H };

const DISPLAY_W = 1100;
const DISPLAY_H = (DISPLAY_W * IMG_H) / IMG_W;
const CHROME_H = 48;

const CURSOR_START = { x: 0.62, y: 0.42 };
const MOVE_START = 36;
const MOVE_END = 126;
const CLICK_FRAME = 132;
const CONNECTED_START = 156;
const CONNECTED_DUR = 22;

export const Scene4SignIn: React.FC = () => {
  const frame = useCurrentFrame();

  const frameOpacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const cursorOpacity = interpolate(frame, [20, 34], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const moveT = interpolate(frame, [MOVE_START, MOVE_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const cursorXFrac = interpolate(moveT, [0, 1], [CURSOR_START.x, BUTTON_CENTER.x]);
  const cursorYFrac = interpolate(moveT, [0, 1], [CURSOR_START.y, BUTTON_CENTER.y]);

  // click "press" squash right at the click frame
  const clickScale = interpolate(
    frame,
    [CLICK_FRAME - 4, CLICK_FRAME, CLICK_FRAME + 10],
    [1, 0.75, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const highlightOpacity = interpolate(
    frame,
    [MOVE_END - 10, MOVE_END + 10, CLICK_FRAME + 20, CLICK_FRAME + 40],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const connectedOpacity = interpolate(
    frame,
    [CONNECTED_START, CONNECTED_START + CONNECTED_DUR],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const connectedScale = interpolate(
    frame,
    [CONNECTED_START, CONNECTED_START + CONNECTED_DUR],
    [0.85, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.back(1.6)) }
  );

  const cursorPxX = cursorXFrac * DISPLAY_W;
  const cursorPxY = CHROME_H + cursorYFrac * DISPLAY_H;

  const btnLeft = (BUTTON_CENTER.x - BUTTON_SIZE.w / 2) * DISPLAY_W;
  const btnTop = CHROME_H + (BUTTON_CENTER.y - BUTTON_SIZE.h / 2) * DISPLAY_H;
  const btnW = BUTTON_SIZE.w * DISPLAY_W;
  const btnH = BUTTON_SIZE.h * DISPLAY_H;

  return (
    <SceneBase audioSrc="audio/scene4.wav" audioStartFrame={15}>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 36,
        }}
      >
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 38,
            fontWeight: 700,
            color: colors.text,
            textAlign: "center",
          }}
        >
          Sign in through Claude Code's own login flow.
        </div>

        <div
          style={{
            position: "relative",
            width: DISPLAY_W,
            height: DISPLAY_H + CHROME_H,
            opacity: frameOpacity,
            borderRadius: 14,
            overflow: "hidden",
            boxShadow: "0 40px 100px rgba(0,0,0,0.6)",
            border: `1px solid ${colors.panelBorder}`,
          }}
        >
          {/* browser chrome */}
          <div
            style={{
              height: CHROME_H,
              background: colors.bgAlt,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 18px",
              borderBottom: `1px solid ${colors.panelBorder}`,
            }}
          >
            <div style={{ width: 12, height: 12, borderRadius: 7, background: "#ff5f56" }} />
            <div style={{ width: 12, height: 12, borderRadius: 7, background: "#ffbd2e" }} />
            <div style={{ width: 12, height: 12, borderRadius: 7, background: "#27c93f" }} />
            <div
              style={{
                marginLeft: 14,
                fontFamily: fonts.mono,
                fontSize: 16,
                color: colors.textFaint,
                background: colors.panel,
                borderRadius: 6,
                padding: "5px 14px",
              }}
            >
              127.0.0.1:3000
            </div>
          </div>

          <Img
            src={staticFile("images/dashboard-screenshot.png")}
            style={{ width: DISPLAY_W, height: DISPLAY_H, display: "block" }}
          />

          {/* highlight pulse around Sign In button */}
          <div
            style={{
              position: "absolute",
              left: btnLeft - 6,
              top: btnTop - 6,
              width: btnW + 12,
              height: btnH + 12,
              borderRadius: 10,
              border: `3px solid ${colors.accent}`,
              boxShadow: `0 0 24px ${colors.accent}`,
              opacity: highlightOpacity,
              pointerEvents: "none",
            }}
          />

          {/* simulated cursor */}
          <div
            style={{
              position: "absolute",
              left: cursorPxX,
              top: cursorPxY,
              opacity: cursorOpacity,
              transform: `translate(-4px,-2px) scale(${clickScale})`,
              pointerEvents: "none",
            }}
          >
            <svg width="30" height="30" viewBox="0 0 30 30">
              <path
                d="M4 2 L4 24 L10 19 L13.5 26 L17 24.5 L13.5 17.5 L21 17.5 Z"
                fill="white"
                stroke="#111"
                strokeWidth="1.2"
              />
            </svg>
          </div>

          {/* connected overlay */}
          <div
            style={{
              position: "absolute",
              top: CHROME_H + 24,
              right: 24,
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "rgba(63,185,80,0.14)",
              border: `1px solid ${colors.accent2}`,
              borderRadius: 999,
              padding: "10px 20px",
              opacity: connectedOpacity,
              transform: `scale(${connectedScale})`,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20">
              <circle cx="10" cy="10" r="10" fill={colors.accent2} />
              <path
                d="M5.5 10.2 L8.3 13 L14.5 6.5"
                stroke={colors.bg}
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span style={{ fontFamily: fonts.mono, fontSize: 20, color: colors.accent2, fontWeight: 600 }}>
              Connected
            </span>
          </div>
        </div>

        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 26,
            color: colors.textDim,
          }}
        >
          No API keys, ever.
        </div>
      </div>
    </SceneBase>
  );
};
