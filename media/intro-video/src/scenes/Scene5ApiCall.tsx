import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { SceneBase } from "../components/SceneBase";
import { WindowChrome } from "../components/WindowChrome";
import { colors, fonts } from "../theme";

type Token = { t: string; c?: string };
type Line = Token[];

const KW = colors.purple;
const STR = colors.accent2;
const PROP = colors.accent;
const PUNC = colors.textFaint;
const PLAIN = colors.text;

const LINES: Line[] = [
  [
    { t: "const ", c: KW },
    { t: "client", c: PLAIN },
    { t: " = ", c: PUNC },
    { t: "new ", c: KW },
    { t: "OpenAI", c: PROP },
    { t: "({", c: PUNC },
  ],
  [
    { t: "  baseURL: ", c: PROP },
    { t: "'http://127.0.0.1:3000/v1'", c: STR },
    { t: ",", c: PUNC },
  ],
  [
    { t: "  apiKey: ", c: PROP },
    { t: "'any-string'", c: STR },
    { t: ",", c: PUNC },
  ],
  [{ t: "})", c: PUNC }],
  [{ t: "", c: PUNC }],
  [
    { t: "await ", c: KW },
    { t: "client.chat.completions.create", c: PROP },
    { t: "({", c: PUNC },
  ],
  [
    { t: "  model: ", c: PROP },
    { t: "'sonnet'", c: STR },
    { t: ",", c: PUNC },
  ],
  [
    { t: "  messages: ", c: PROP },
    { t: "[{ role: ", c: PUNC },
    { t: "'user'", c: STR },
    { t: ", content: ", c: PUNC },
    { t: "'Hello!'", c: STR },
    { t: " }]", c: PUNC },
    { t: ",", c: PUNC },
  ],
  [{ t: "})", c: PUNC }],
];

const LINE_STAGGER = 8;
const LINE_START = 12;
const BUBBLE_START = LINE_START + LINES.length * LINE_STAGGER + 24;
const BUBBLE_DUR = 20;

export const Scene5ApiCall: React.FC = () => {
  const frame = useCurrentFrame();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const bubbleOpacity = interpolate(frame, [BUBBLE_START, BUBBLE_START + BUBBLE_DUR], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bubbleY = interpolate(frame, [BUBBLE_START, BUBBLE_START + BUBBLE_DUR], [18, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <SceneBase audioSrc="audio/scene5.wav" audioStartFrame={15}>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 30,
        }}
      >
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 38,
            fontWeight: 700,
            color: colors.text,
            opacity: titleOpacity,
          }}
        >
          Just the OpenAI SDK, pointed somewhere else.
        </div>

        <WindowChrome title="client.js" width={1020}>
          <div style={{ fontFamily: fonts.mono, fontSize: 25, lineHeight: 1.65 }}>
            {LINES.map((line, i) => {
              const start = LINE_START + i * LINE_STAGGER;
              const op = interpolate(frame, [start, start + 10], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });
              const x = interpolate(frame, [start, start + 10], [-14, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });
              return (
                <div
                  key={i}
                  style={{ opacity: op, transform: `translateX(${x}px)`, whiteSpace: "pre" }}
                >
                  {line.length === 0 || (line.length === 1 && line[0].t === "")
                    ? " "
                    : line.map((tok, j) => (
                        <span key={j} style={{ color: tok.c ?? PLAIN }}>
                          {tok.t}
                        </span>
                      ))}
                </div>
              );
            })}
          </div>
        </WindowChrome>

        <div
          style={{
            opacity: bubbleOpacity,
            transform: `translateY(${bubbleY}px)`,
            maxWidth: 560,
            background: colors.panel,
            border: `1px solid ${colors.panelBorder}`,
            borderRadius: 18,
            borderBottomLeftRadius: 4,
            padding: "16px 24px",
            fontFamily: fonts.sans,
            fontSize: 24,
            color: colors.text,
            alignSelf: "flex-start",
            marginLeft: 450,
          }}
        >
          Hello! How can I help?
        </div>
      </div>
    </SceneBase>
  );
};
