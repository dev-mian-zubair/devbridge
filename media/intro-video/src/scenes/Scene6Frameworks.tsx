import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { SceneBase } from "../components/SceneBase";
import { colors, fonts } from "../theme";

const CENTER = { x: 960, y: 640 };
const RADIUS = 370;
const CHIPS = [
  { label: "OpenAI SDK", angleDeg: -90 },
  { label: "Vercel AI SDK", angleDeg: -30 },
  { label: "LangChain", angleDeg: 30 },
  { label: "deepagents", angleDeg: 90 },
  { label: "CrewAI", angleDeg: 150 },
  { label: "OpenClaw", angleDeg: 210 },
];

const STAGGER = 18;
const START = 30;
const FADE_DUR = 18;

export const Scene6Frameworks: React.FC = () => {
  const frame = useCurrentFrame();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const hubOpacity = interpolate(frame, [6, 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const hubScale = interpolate(frame, [6, 26], [0.8, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.back(1.4)),
  });

  return (
    <SceneBase audioSrc="audio/scene6.wav" audioStartFrame={15}>
      <div style={{ width: "100%", height: "100%", position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: 70,
            left: 0,
            right: 0,
            textAlign: "center",
            fontFamily: fonts.sans,
            fontSize: 40,
            fontWeight: 700,
            color: colors.text,
            opacity: titleOpacity,
          }}
        >
          Works with the tools you already use.
        </div>

        <svg
          width="100%"
          height="100%"
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          {CHIPS.map((chip, i) => {
            const rad = (chip.angleDeg * Math.PI) / 180;
            const x = CENTER.x + RADIUS * Math.cos(rad);
            const y = CENTER.y + RADIUS * Math.sin(rad);
            const start = START + i * STAGGER;
            const op = interpolate(frame, [start, start + FADE_DUR], [0, 0.55], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <line
                key={chip.label}
                x1={CENTER.x}
                y1={CENTER.y}
                x2={x}
                y2={y}
                stroke={colors.panelBorder}
                strokeWidth={2}
                opacity={op}
              />
            );
          })}
        </svg>

        {/* hub */}
        <div
          style={{
            position: "absolute",
            left: CENTER.x,
            top: CENTER.y,
            transform: `translate(-50%,-50%) scale(${hubScale})`,
            opacity: hubOpacity,
            width: 210,
            height: 210,
            borderRadius: "50%",
            background: colors.panel,
            border: `2px solid ${colors.accent}`,
            boxShadow: `0 0 50px rgba(90,169,255,0.35)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            fontFamily: fonts.sans,
            fontSize: 30,
            fontWeight: 800,
            color: colors.text,
          }}
        >
          Dev<span style={{ color: colors.accent }}>Bridge</span>
        </div>

        {CHIPS.map((chip, i) => {
          const rad = (chip.angleDeg * Math.PI) / 180;
          const x = CENTER.x + RADIUS * Math.cos(rad);
          const y = CENTER.y + RADIUS * Math.sin(rad);
          const start = START + i * STAGGER;
          const op = interpolate(frame, [start, start + FADE_DUR], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const scale = interpolate(frame, [start, start + FADE_DUR], [0.6, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.out(Easing.back(1.5)),
          });
          return (
            <div
              key={chip.label}
              style={{
                position: "absolute",
                left: x,
                top: y,
                transform: `translate(-50%,-50%) scale(${scale})`,
                opacity: op,
                background: colors.bgAlt,
                border: `1px solid ${colors.panelBorder}`,
                borderRadius: 999,
                padding: "14px 28px",
                fontFamily: fonts.mono,
                fontSize: 23,
                color: colors.text,
                whiteSpace: "nowrap",
                boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
              }}
            >
              {chip.label}
            </div>
          );
        })}
      </div>
    </SceneBase>
  );
};
