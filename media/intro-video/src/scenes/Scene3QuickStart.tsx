import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { SceneBase } from "../components/SceneBase";
import { WindowChrome } from "../components/WindowChrome";
import { typedSubstring } from "../components/typedText";
import { colors, fonts } from "../theme";

const LINE1 = "git clone https://github.com/dev-mian-zubair/devbridge.git";
const LINE2 = "npm install";
const LINE3 = "npm start";
const OUTPUT = "Server running on 127.0.0.1:3000";

const L1_START = 20;
const L1_DUR = 32;
const L2_START = L1_START + L1_DUR + 10;
const L2_DUR = 16;
const L3_START = L2_START + L2_DUR + 10;
const L3_DUR = 14;
const OUT_START = L3_START + L3_DUR + 14;
const OUT_DUR = 10;

const Cursor: React.FC<{ visible: boolean }> = ({ visible }) => {
  const frame = useCurrentFrame();
  const blink = Math.floor(frame / 15) % 2 === 0;
  return (
    <span
      style={{
        display: "inline-block",
        width: 14,
        height: 30,
        marginLeft: 4,
        background: colors.text,
        opacity: visible && blink ? 1 : 0,
        verticalAlign: "middle",
      }}
    />
  );
};

const PromptLine: React.FC<{
  text: string;
  start: number;
  dur: number;
  frame: number;
  active: boolean;
}> = ({ text, start, dur, frame, active }) => {
  const shown = typedSubstring(text, frame, start, dur);
  const started = frame >= start;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        fontFamily: fonts.mono,
        fontSize: 30,
        lineHeight: 1.6,
        color: colors.text,
        minHeight: 48,
      }}
    >
      {started && <span style={{ color: colors.accent2, marginRight: 14 }}>$</span>}
      <span>{shown}</span>
      <Cursor visible={active} />
    </div>
  );
};

export const Scene3QuickStart: React.FC = () => {
  const frame = useCurrentFrame();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const outputOpacity = interpolate(frame, [OUT_START, OUT_START + OUT_DUR], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const l1Active = frame >= L1_START && frame < L2_START;
  const l2Active = frame >= L2_START && frame < L3_START;
  const l3Active = frame >= L3_START && frame < OUT_START;

  return (
    <SceneBase audioSrc="audio/scene3.wav" audioStartFrame={15}>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 44,
            fontWeight: 700,
            color: colors.text,
            opacity: titleOpacity,
            marginBottom: 40,
          }}
        >
          Getting started takes three commands.
        </div>
        <WindowChrome title="devbridge — zsh" width={1180}>
          <PromptLine text={LINE1} start={L1_START} dur={L1_DUR} frame={frame} active={l1Active} />
          <PromptLine text={LINE2} start={L2_START} dur={L2_DUR} frame={frame} active={l2Active} />
          <PromptLine text={LINE3} start={L3_START} dur={L3_DUR} frame={frame} active={l3Active} />
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 30,
              color: colors.accent2,
              marginTop: 14,
              opacity: outputOpacity,
            }}
          >
            {OUTPUT}
          </div>
        </WindowChrome>
      </div>
    </SceneBase>
  );
};
