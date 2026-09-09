import type { EncoderSupport } from "./plan.js";

/**
 * What the browser really can do — asked, not guessed.
 *
 * Never derive this from the user agent: the same Chrome build encodes H.264
 * on one machine and refuses on the next, because it depends on the hardware
 * and on what the operating system ships. The honest answer comes from
 * `VideoEncoder.isConfigSupported` and `AudioEncoder.isConfigSupported`;
 * Mediabunny wraps both in `canEncodeVideo` / `canEncodeAudio`.
 *
 * Only the browser's answers are cached. A caller policy (`allow`) is applied
 * fresh on every call and never stored, so two calls with different policies
 * cannot contaminate each other.
 *
 * Mediabunny is an optional peer dependency and is imported lazily, so this
 * module can be bundled into pages that never touch media.
 */

export type VideoCodecName = "avc" | "hevc" | "vp8" | "vp9" | "av1";
export type AudioCodecName = "aac" | "opus" | "mp3" | "vorbis" | "flac";

/** Codecs worth asking about. Kept short: each query costs time. */
const VIDEO_CANDIDATES: readonly VideoCodecName[] = ["avc", "vp9", "av1", "vp8"];
const AUDIO_CANDIDATES: readonly AudioCodecName[] = ["aac", "opus"];

/** What the browser reported, before any caller policy is applied. */
export interface RawEncoderSupport {
  video: ReadonlySet<string>;
  audio: ReadonlySet<string>;
}

export interface DetectOptions {
  /**
   * An extra gate on top of what the browser reports.
   *
   * Return `false` for a codec this project must not *produce*, even where the
   * browser could. Projects have such constraints for reasons that are none of
   * this library's business — licensing, platform policy, an output format
   * decision.
   *
   * This is a technical switch, not a legal clearance: blocking a codec here
   * does not grant you any rights to the ones you leave enabled, and enabling
   * one does not create an obligation. Decide the legal question separately.
   *
   * Remuxing an existing bitstream is unaffected either way — no encoder runs
   * there, so `planFor` can still copy a codec this gate blocks.
   *
   * Default: everything the browser reports is allowed.
   */
  allow?: (codec: string) => boolean;
}

let cached: RawEncoderSupport | null = null;
let inFlight: Promise<RawEncoderSupport> | null = null;

/**
 * Test seam. Replaces the browser probe so the caching and policy behaviour
 * can be exercised without a browser. Not part of the public contract.
 */
let probeOverride: (() => Promise<RawEncoderSupport>) | null = null;

/** @internal */
export function __setEncoderProbe(probe: (() => Promise<RawEncoderSupport>) | null): void {
  probeOverride = probe;
  cached = null;
  inFlight = null;
}

/**
 * Ask the browser once what it can encode.
 *
 * Deliberately probed with small, unremarkable dimensions: the only question
 * is whether the codec exists at all, not how fast it is.
 */
async function probeBrowser(): Promise<RawEncoderSupport> {
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

  return { video, audio };
}

/**
 * The browser's own answers, cached for the session.
 *
 * Cached because the query costs time and the answer does not change while the
 * page is open. Concurrent callers share one probe.
 */
export async function detectRawEncoderSupport(): Promise<RawEncoderSupport> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (probeOverride ?? probeBrowser)()
    .then((raw) => {
      cached = raw;
      return raw;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Compose an `EncoderSupport` from known capabilities and an optional policy.
 *
 * Pure and synchronous — useful when you already know what your target can do,
 * for instance from your own probe or from a fixture in a test.
 */
export function encoderSupportFrom(raw: RawEncoderSupport, options: DetectOptions = {}): EncoderSupport {
  const allow = options.allow ?? (() => true);
  return {
    // The policy sits on top of the browser's abilities: what the browser
    // could do but must not do counts as unavailable from the outside. That
    // way `planFor` decides correctly without knowing the policy exists.
    videoEncode: (codec: string) => raw.video.has(codec) && allow(codec),
    audioEncode: (codec: string) => raw.audio.has(codec) && allow(codec),
  };
}

/**
 * What can be encoded here and now, under this call's policy.
 *
 * The browser probe is cached; the policy is not. Calling this twice with
 * different `allow` functions yields two independent results.
 */
export async function detectEncoderSupport(options: DetectOptions = {}): Promise<EncoderSupport> {
  return encoderSupportFrom(await detectRawEncoderSupport(), options);
}

/** Convenience: can this one codec be produced here and now? */
export async function canEncode(
  codec: VideoCodecName | AudioCodecName,
  options?: DetectOptions,
): Promise<boolean> {
  const support = await detectEncoderSupport(options);
  return (VIDEO_CANDIDATES as readonly string[]).includes(codec)
    ? support.videoEncode(codec)
    : support.audioEncode(codec);
}

/** Forget the cached browser answers. Mainly useful in tests. */
export function resetEncoderSupport(): void {
  cached = null;
  inFlight = null;
}
