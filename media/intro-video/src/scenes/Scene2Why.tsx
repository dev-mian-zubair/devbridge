import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { SceneBase } from "../components/SceneBase";
import { colors, fonts } from "../theme";

export const Scene2Why: React.FC = () => {
  const frame = useCurrentFrame();

  const oldOpacity = interpolate(frame, [10, 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // strike-through draws across the old url
  const strikeWidth = interpolate(frame, [55, 85], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // old url fades/shrinks away, new url fades/grows in
  const swapProgress = interpolate(frame, [100, 135], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const oldFade = 1 - swapProgress;
  const newOpacity = interpolate(frame, [100, 135], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const badgeOpacity = interpolate(frame, [160, 185], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const badgeY = interpolate(frame, [160, 185], [14, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const captionOpacity = interpolate(frame, [205, 230], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <SceneBase audioSrc="audio/scene2.wav" audioStartFrame={15}>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 160px",
        }}
      >
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 26,
            minHeight: 170,
            justifyContent: "center",
          }}
        >
          {/* old endpoint, struck through, then fades out */}
          <div
            style={{
              position: "absolute",
              display: "flex",
              alignItems: "center",
              opacity: oldOpacity * oldFade,
              transform: `translateY(${-swapProgress * 40}px) scale(${1 - swapProgress * 0.08})`,
            }}
          >
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 54,
                color: colors.textDim,
                position: "relative",
                padding: "4px 0",
              }}
            >
              api.openai.com
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: "50%",
                  height: 4,
                  width: `${strikeWidth}%`,
                  background: colors.danger,
                  borderRadius: 2,
                }}
              />
            </span>
          </div>

          {/* new endpoint fades in below, then becomes the main focus */}
          <div
            style={{
              opacity: newOpacity,
              transform: `translateY(${(1 - swapProgress) * 30}px) scale(${0.92 + swapProgress * 0.08})`,
              fontFamily: fonts.mono,
              fontSize: 58,
              fontWeight: 600,
              color: colors.accent2,
              marginTop: 90,
            }}
          >
            http://127.0.0.1:3000/v1
          </div>
        </div>

        <div
          style={{
            marginTop: 56,
            opacity: badgeOpacity,
            transform: `translateY(${badgeY}px)`,
            fontFamily: fonts.sans,
            fontSize: 26,
            fontWeight: 600,
            color: colors.bg,
            background: colors.amber,
            padding: "12px 28px",
            borderRadius: 999,
            letterSpacing: 0.2,
          }}
        >
          subscription, not per-token
        </div>

        <div
          style={{
            marginTop: 64,
            maxWidth: 1280,
            textAlign: "center",
            fontFamily: fonts.sans,
            fontSize: 30,
            lineHeight: 1.5,
            color: colors.textDim,
            opacity: captionOpacity,
          }}
        >
          Any OpenAI-compatible tool can point at it — without paying API rates
          on top of a subscription you already have.
        </div>
      </div>
    </SceneBase>
  );
};
