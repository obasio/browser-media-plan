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
 * Import `browser-media-plan/plan` alone if you already know your encoder
 * support — that entry point has no dependencies at all.
 */

export {
  planFor,
  isLossless,
  CONTAINER_VIDEO,
  CONTAINER_AUDIO,
  PREFERRED_VIDEO,
  PREFERRED_AUDIO,
} from "./plan.js";

export type {
  TrackAction,
  TargetContainer,
  TrackProbe,
  MediaProbe,
  EncoderSupport,
  Intent,
  MediaPlan,
} from "./plan.js";

export {
  detectEncoderSupport,
  detectRawEncoderSupport,
  encoderSupportFrom,
  canEncode,
  resetEncoderSupport,
} from "./capabilities.js";

export type {
  VideoCodecName,
  AudioCodecName,
  RawEncoderSupport,
  DetectOptions,
} from "./capabilities.js";
