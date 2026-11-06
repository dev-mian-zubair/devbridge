import React from "react";
import { Series } from "remotion";
import { Scene1Title } from "./scenes/Scene1Title";
import { Scene2Why } from "./scenes/Scene2Why";
import { Scene3QuickStart } from "./scenes/Scene3QuickStart";
import { Scene4SignIn } from "./scenes/Scene4SignIn";
import { Scene5ApiCall } from "./scenes/Scene5ApiCall";
import { Scene6Frameworks } from "./scenes/Scene6Frameworks";
import { Scene7Closing } from "./scenes/Scene7Closing";

// Each scene's duration = 15f lead-in + narration (ceil'd, measured via ffprobe)
// + hold, bumped up where the scene's visual beats (typing, cursor move, chip
// stagger) need more room than the narration alone would give.
export const SCENE_DURATIONS = {
  scene1: 90, // title: "This is DevBridge." (50f audio)
  scene2: 630, // why: longest VO (584f audio)
  scene3: 180, // quick start: terminal typing needs more time than its 73f VO
  scene4: 300, // sign in: cursor move + click + connected beat (249f audio)
  scene5: 200, // api call: code reveal + chat bubble (127f audio)
  scene6: 340, // frameworks: 6-chip stagger (292f audio)
  scene7: 240, // closing: fade to black (176f audio)
};

export const TOTAL_DURATION = Object.values(SCENE_DURATIONS).reduce((a, b) => a + b, 0);

export const Intro: React.FC = () => {
  return (
    <Series>
      <Series.Sequence durationInFrames={SCENE_DURATIONS.scene1}>
        <Scene1Title />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENE_DURATIONS.scene2}>
        <Scene2Why />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENE_DURATIONS.scene3}>
        <Scene3QuickStart />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENE_DURATIONS.scene4}>
        <Scene4SignIn />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENE_DURATIONS.scene5}>
        <Scene5ApiCall />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENE_DURATIONS.scene6}>
        <Scene6Frameworks />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENE_DURATIONS.scene7}>
        <Scene7Closing />
      </Series.Sequence>
    </Series>
  );
};
