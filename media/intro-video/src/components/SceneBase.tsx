import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { colors, CUT_FADE } from "../theme";

type SceneBaseProps = {
  children: React.ReactNode;
  audioSrc?: string;
  audioStartFrame?: number;
  background?: string;
};

/**
 * Wraps every scene with: a solid background, a quick fade-in/out so hard cuts
 * between scenes feel snappy rather than jarring, and an optional narration
 * Audio track placed at a fixed offset inside the scene's local timeline.
 */
export const SceneBase: React.FC<SceneBaseProps> = ({
  children,
  audioSrc,
  audioStartFrame = 15,
  background = colors.bg,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, CUT_FADE], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - CUT_FADE, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const opacity = Math.min(fadeIn, fadeOut);

  return (
    <AbsoluteFill style={{ backgroundColor: background }}>
      <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>
      {audioSrc ? (
        <Sequence from={audioStartFrame} layout="none">
          <Audio src={staticFile(audioSrc)} volume={1} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
