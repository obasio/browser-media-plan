/**
 * browser-media-plan
 *
 * Two things, kept apart on purpose:
 *
 *  - `plan.ts` decides remux vs. re-encode. Pure, no imports, testable without
 *    a browser and without a media file.
 *  - `capabilities.ts` asks the browser what it can actually encode. Needs
 *    Mediabunny and a real browser.
 *
 * Import `plan.ts` alone if you already know your encoder support.
 */

export {
  planFor,
  isLossless,
  CONTAINER_VIDEO,
  CONTAINER_AUDIO,
  PREFERRED_VIDEO,
  PREFERRED_AUDIO,
} from "./plan.ts";

export type {
  TrackAction,
  TargetContainer,
  TrackProbe,
  MediaProbe,
  EncoderSupport,
  Intent,
  MediaPlan,
} from "./plan.ts";

export {
  detectEncoderSupport,
  canEncode,
  resetEncoderSupport,
} from "./capabilities.ts";

export type {
  VideoCodecName,
  AudioCodecName,
  DetectOptions,
} from "./capabilities.ts";
