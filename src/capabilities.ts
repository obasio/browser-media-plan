import type { EncoderSupport } from "./plan.ts";

/**
 * What the browser really can do — asked, not guessed.
 *
 * Never derive this from the user agent: the same Chrome build encodes H.264
 * on one machine and refuses on the next, because it depends on the hardware
 * and on what the operating system ships. The honest answer comes from
 * `VideoEncoder.isConfigSupported` and `AudioEncoder.isConfigSupported`;
 * Mediabunny wraps both in `canEncodeVideo` / `canEncodeAudio`.
 *
 * The answers are cached, because the query itself costs time and the result
 * does not change during a session.
 *
 * Mediabunny is an optional peer dependency and is imported lazily, so this
 * module can be bundled into pages that never touch media.
 */

export type VideoCodecName = "avc" | "hevc" | "vp8" | "vp9" | "av1";
export type AudioCodecName = "aac" | "opus" | "mp3" | "vorbis" | "flac";

/** Codecs worth asking about. Kept short: each query costs time. */
const VIDEO_CANDIDATES: VideoCodecName[] = ["avc", "vp9", "av1", "vp8"];
const AUDIO_CANDIDATES: AudioCodecName[] = ["aac", "opus"];

export interface DetectOptions {
  /**
   * An extra gate on top of what the browser reports.
   *
   * Return `false` for a codec that this project must not *produce*, even
   * where the browser could. Projects have such constraints for reasons that
   * are none of this library's business — licensing, platform policy, an
   * output format decision. Remuxing an existing bitstream is unaffected: no
   * encoder runs there.
   *
   * Default: everything the browser reports is allowed.
   */
  allow?: (codec: string) => boolean;
}

let cached: EncoderSupport | null = null;
let inFlight: Promise<EncoderSupport> | null = null;

/**
 * Ask once what can be encoded here.
 *
 * Deliberately probed with small, unremarkable dimensions: the only question
 * is whether the codec exists at all, not how fast it is.
 */
export async function detectEncoderSupport(options: DetectOptions = {}): Promise<EncoderSupport> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  const allow = options.allow ?? (() => true);

  inFlight = (async () => {
    const bunny = await import("mediabunny");
    const video = new Set<string>();
    const audio = new Set<string>();

    await Promise.all([
      ...VIDEO_CANDIDATES.map(async (codec) => {
        try {
          if (await bunny.canEncodeVideo(codec, { width: 640, height: 360 })) video.add(codec);
        } catch {
          // An encoder whose very query throws is not available.
        }
      }),
      ...AUDIO_CANDIDATES.map(async (codec) => {
        try {
          if (await bunny.canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48_000 })) audio.add(codec);
        } catch {
          // Same here.
        }
      }),
    ]);

    // The caller's policy sits on top of the browser's abilities: what the
    // browser could do but must not do counts as unavailable from the outside.
    // That way `planFor` decides correctly without knowing the policy exists.
    cached = {
      videoEncode: (codec: string) => video.has(codec) && allow(codec),
      audioEncode: (codec: string) => audio.has(codec) && allow(codec),
    };
    return cached;
  })();

  return inFlight;
}

/** Convenience: can this one codec be produced here and now? */
export async function canEncode(codec: VideoCodecName | AudioCodecName, options?: DetectOptions): Promise<boolean> {
  const support = await detectEncoderSupport(options);
  return (VIDEO_CANDIDATES as string[]).includes(codec)
    ? support.videoEncode(codec)
    : support.audioEncode(codec);
}

/** For tests: forget what was cached. */
export function resetEncoderSupport(): void {
  cached = null;
  inFlight = null;
}
