import { interpolate } from "remotion";

/**
 * Returns the substring of `text` that should be visible at `frame`, typing
 * it out between [startFrame, startFrame + durationFrames].
 */
export const typedSubstring = (
  text: string,
  frame: number,
  startFrame: number,
  durationFrames: number
): string => {
  const count = interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [0, text.length],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return text.slice(0, Math.floor(count));
};

export const isDoneTyping = (
  frame: number,
  startFrame: number,
  durationFrames: number
): boolean => frame >= startFrame + durationFrames;
