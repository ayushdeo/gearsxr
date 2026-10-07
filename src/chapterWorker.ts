// Runs bond-change detection off the main thread so long trajectories don't
// freeze the viewer. One "detect" message in, "progress" messages and a final
// "result" (or "error") out; the token lets the panel drop stale runs.

import { detectBondEvents, type DetectOptions } from "./chapterDetect";
import type { Trajectory } from "./xyzParser";

interface DetectMessage {
  type: "detect";
  token: number;
  trajectory: Trajectory;
  options: DetectOptions;
}

self.onmessage = (event: MessageEvent<DetectMessage>) => {
  const { token, trajectory, options } = event.data;
  const post = (message: unknown) => (self as unknown as Worker).postMessage(message);
  try {
    const events = detectBondEvents(trajectory, options, (framesDone, totalFrames) =>
      post({ type: "progress", token, framesDone, totalFrames }),
    );
    post({ type: "result", token, events });
  } catch (err) {
    post({ type: "error", token, message: (err as Error).message });
  }
};
