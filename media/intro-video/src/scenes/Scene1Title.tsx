import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { SceneBase } from "../components/SceneBase";
import { colors, fonts } from "../theme";

export const Scene1Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleScale = spring({ frame, fps, config: { damping: 14, mass: 0.6 }, durationInFrames: 24 });
  const titleOpacity = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const subtitleOpacity = interpolate(frame, [18, 34], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const subtitleY = interpolate(frame, [18, 34], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <SceneBase audioSrc="audio/scene1.wav" audioStartFrame={15}>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: `radial-gradient(circle at 50% 42%, ${colors.panel} 0%, ${colors.bg} 70%)`,
        }}
      >
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 148,
            fontWeight: 800,
            color: colors.text,
            letterSpacing: -2,
            opacity: titleOpacity,
            transform: `scale(${0.85 + titleScale * 0.15})`,
          }}
        >
          Dev<span style={{ color: colors.accent }}>Bridge</span>
        </div>
        <div
          style={{
            marginTop: 28,
            fontFamily: fonts.mono,
            fontSize: 36,
            color: colors.textDim,
            opacity: subtitleOpacity,
            transform: `translateY(${subtitleY}px)`,
          }}
        >
          Claude Code, as an OpenAI-compatible API.
        </div>
      </div>
    </SceneBase>
  );
};
