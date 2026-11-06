import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { SceneBase } from "../components/SceneBase";
import { colors, fonts } from "../theme";

export const Scene7Closing: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const wordmarkOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const wordmarkScale = interpolate(frame, [0, 22], [0.9, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.back(1.3)),
  });

  const lineOpacity = interpolate(frame, [26, 46], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const chipsOpacity = interpolate(frame, [54, 76], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const chipsY = interpolate(frame, [54, 76], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // fade to black over the last ~34 frames
  const fadeToBlack = interpolate(
    frame,
    [durationInFrames - 34, durationInFrames - 2],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <>
    <SceneBase audioSrc="audio/scene7.wav" audioStartFrame={15}>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 34,
          background: `radial-gradient(circle at 50% 46%, ${colors.panel} 0%, ${colors.bg} 72%)`,
        }}
      >
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 110,
            fontWeight: 800,
            color: colors.text,
            letterSpacing: -1.5,
            opacity: wordmarkOpacity,
            transform: `scale(${wordmarkScale})`,
          }}
        >
          Dev<span style={{ color: colors.accent }}>Bridge</span>
        </div>

        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 32,
            color: colors.textDim,
            opacity: lineOpacity,
          }}
        >
          github.com/dev-mian-zubair/devbridge
        </div>

        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: 10,
            opacity: chipsOpacity,
            transform: `translateY(${chipsY}px)`,
          }}
        >
          {["Local only", "No credentials stored", "MIT licensed"].map((t) => (
            <div
              key={t}
              style={{
                fontFamily: fonts.sans,
                fontSize: 21,
                fontWeight: 600,
                color: colors.bg,
                background: colors.accent2,
                padding: "10px 22px",
                borderRadius: 999,
              }}
            >
              {t}
            </div>
          ))}
        </div>

        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 24,
            color: colors.textFaint,
            opacity: chipsOpacity,
            marginTop: 6,
          }}
        >
          ⭐ Star it on GitHub
        </div>
      </div>
    </SceneBase>
    <AbsoluteFill
      style={{
        background: "#000",
        opacity: fadeToBlack,
        pointerEvents: "none",
      }}
    />
    </>
  );
};
