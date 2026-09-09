/**
 * The decision: remux or re-encode.
 *
 * The principle, in this order:
 *
 *   REMUX FIRST → COPY CODECS → RE-ENCODE ONLY IF REQUIRED
 *
 * A .mov file holding H.264 and AAC already contains exactly the bitstreams
 * that would sit inside an .mp4. Recomputing them costs minutes and quality
 * and buys nothing — only the container has to be rewritten. Only when a
 * change touches the pixels themselves (different resolution, different frame
 * rate, rotation baked in) is a re-encode unavoidable.
 *
 * This module only computes. It deliberately has no imports: what the browser
 * can do is handed in as an `EncoderSupport` object. That way the decision can
 * be tested without a browser and without a media file — and this is exactly
 * the logic where a mistake is expensive.
 *
 * ON THE SEPARATION OF COPY AND ENCODE:
 * "copy" means an existing bitstream is written unchanged into a different
 * container. "encode" means a new bitstream is produced. Both cases are kept
 * apart here and stay distinguishable in the result, because only the first
 * one may be advertised to a user as lossless.
 */

/** What happens to a single track. */
export type TrackAction =
  /** Take the existing bitstream unchanged. No encoder involved. */
  | "copy"
  /** Produce a new bitstream. Only through the browser's own codecs. */
  | "encode"
  /** The track is dropped because the caller asked for that. */
  | "discard"
  /** There is no such track. */
  | "none"
  /** Neither copying nor encoding is possible. */
  | "unsupported";

export type TargetContainer = "mp4" | "webm" | "mkv" | "mov";

/** Video codecs each container is allowed to carry. */
export const CONTAINER_VIDEO: Record<TargetContainer, readonly string[]> = {
  // Deliberately narrower than the specification allows. MP4 can carry VP9 and
  // AV1, but Safari and QuickTime will not play them — and MP4 is the output
  // people pick when they mean "plays everywhere". A remuxed VP9-in-MP4 would
  // be formally valid and ready in seconds, yet silent on exactly the devices
  // the choice was made for. Whoever wants to keep VP9 picks WebM, where it is
  // copied.
  //
  // HEVC is in the list because existing iPhone recordings may be remuxed.
  // HEVC is never produced anywhere (see PREFERRED_VIDEO).
  mp4: ["avc", "hevc"],
  webm: ["vp8", "vp9", "av1"],
  // MKV carries practically everything, which makes it the container that most
  // often accepts a file with no recomputation at all.
  mkv: ["avc", "hevc", "vp8", "vp9", "av1"],
  // MOV is technically the same substrate as MP4 and is treated just as
  // strictly here: whoever picks MOV wants to open it in Apple software.
  mov: ["avc", "hevc"],
};

/** Audio codecs each container is allowed to carry. */
export const CONTAINER_AUDIO: Record<TargetContainer, readonly string[]> = {
  // Without Opus for the same reason: Opus-in-MP4 plays in Chrome and Firefox,
  // but not in Safari.
  mp4: ["aac", "mp3"],
  webm: ["opus", "vorbis"],
  mkv: ["aac", "opus", "vorbis", "mp3", "flac"],
  mov: ["aac", "mp3"],
};

/** What gets produced when something has to be produced. */
export const PREFERRED_VIDEO: Record<TargetContainer, string> = { mp4: "avc", webm: "vp9", mkv: "avc", mov: "avc" };
export const PREFERRED_AUDIO: Record<TargetContainer, string> = { mp4: "aac", webm: "opus", mkv: "aac", mov: "aac" };

export interface TrackProbe {
  /**
   * Short codec identifier as your analysis reports it: "avc", "hevc", "vp8",
   * "vp9", "av1", "aac", "opus", "mp3", "vorbis", "flac".
   *
   * Compared case-insensitively. Full codec strings such as "avc1.42E01E" are
   * not understood — reduce them to the family name first.
   */
  codec: string | null;
  /** Whether the browser can decode this track at all. */
  canDecode: boolean;
}

export interface MediaProbe {
  container: string;
  video: TrackProbe | null;
  audio: TrackProbe | null;
}

/**
 * What the browser can actually do right now.
 *
 * Determine this at runtime through `VideoEncoder.isConfigSupported` and
 * `AudioEncoder.isConfigSupported` (see `capabilities.ts`) — never from the
 * user agent. Only the result belongs here.
 */
export interface EncoderSupport {
  videoEncode: (codec: string) => boolean;
  audioEncode: (codec: string) => boolean;
}

/** What the caller intends to do with the file. */
export interface Intent {
  target: TargetContainer;
  /** Throw the audio track away. */
  dropAudio?: boolean;
  /** Throw the video track away (extract the audio). */
  dropVideo?: boolean;
  /**
   * Changes to the pixels themselves. Every one of these forces the video
   * track to be recomputed; there is no way around it.
   */
  videoChanges?: {
    resolution?: boolean;
    frameRate?: boolean;
    crop?: boolean;
    /** Rotation rendered into the frames instead of written to metadata. */
    rotationBakedIn?: boolean;
    mirror?: boolean;
    speed?: boolean;
    filter?: boolean;
    /** A target file size, which forces new bitrates. */
    targetSize?: boolean;
  };
  /** Changes that only concern the audio. */
  audioChanges?: {
    loudness?: boolean;
    sampleRate?: boolean;
    channels?: boolean;
    bitrate?: boolean;
  };
}

export interface MediaPlan {
  /** "remux" means no encoder runs at all, neither for video nor for audio. */
  decision: "remux" | "reencode" | "impossible";
  video: TrackAction;
  audio: TrackAction;
  /** Only set when the track is actually produced anew. */
  videoTargetCodec?: string;
  audioTargetCodec?: string;
  /** Machine-readable trail of why it was decided this way. For diagnostics. */
  reasons: string[];
}

/**
 * Codec identifiers are compared case-insensitively and trimmed, because
 * probes disagree about casing and an unnoticed "AVC" would silently turn a
 * remux into a re-encode.
 */
function normalise(codec: string | null | undefined): string | null {
  if (typeof codec !== "string") return null;
  const value = codec.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

/** The first pixel-touching change found, or null if there is none. */
function videoReason(changes: Intent["videoChanges"]): string | null {
  if (!changes) return null;
  if (changes.resolution) return "resolution_change";
  if (changes.frameRate) return "framerate_change";
  if (changes.crop) return "crop";
  if (changes.rotationBakedIn) return "rotation_baked_in";
  if (changes.mirror) return "mirror";
  if (changes.speed) return "speed_change";
  if (changes.filter) return "filter";
  if (changes.targetSize) return "target_size";
  return null;
}

/** The first sample-touching change found, or null if there is none. */
function audioReason(changes: Intent["audioChanges"]): string | null {
  if (!changes) return null;
  if (changes.loudness) return "loudness_change";
  if (changes.sampleRate) return "sample_rate_change";
  if (changes.channels) return "channel_change";
  if (changes.bitrate) return "bitrate_change";
  return null;
}

/**
 * The plan for one file.
 *
 * A pure function: same inputs, same result, no side effects.
 *
 * @throws if `intent.target` is not one of the four supported containers.
 */
export function planFor(probe: MediaProbe, intent: Intent, support: EncoderSupport): MediaPlan {
  const reasons: string[] = [];
  const target = intent.target;
  const videoAllowed = CONTAINER_VIDEO[target];
  const audioAllowed = CONTAINER_AUDIO[target];

  // A caller coming from plain JavaScript can pass anything. Failing here with
  // a readable message beats a TypeError three lines down.
  if (!videoAllowed || !audioAllowed) {
    throw new Error(`Unsupported target container: ${String(target)}. Expected one of mp4, webm, mkv, mov.`);
  }

  // --- Video track ----------------------------------------------------
  let video: TrackAction;
  let videoTargetCodec: string | undefined;
  const videoCodec = normalise(probe.video?.codec);

  if (intent.dropVideo) {
    video = "discard";
    reasons.push("video_discarded_by_user");
  } else if (!videoCodec) {
    video = "none";
  } else {
    const reason = videoReason(intent.videoChanges);
    const fitsContainer = videoAllowed.includes(videoCodec);
    if (!reason && fitsContainer) {
      // The regular case, and the whole point of this module: the existing
      // bitstream moves into the new container unchanged. Note that copying
      // does not require a decoder — `canDecode` is irrelevant here.
      video = "copy";
      reasons.push(`video_copy:${videoCodec}`);
    } else {
      const targetCodec = PREFERRED_VIDEO[target];
      if (!probe.video?.canDecode) {
        // Re-encoding presupposes being able to decode first.
        video = "unsupported";
        reasons.push(`video_cannot_decode:${videoCodec}`);
      } else if (support.videoEncode(targetCodec)) {
        video = "encode";
        videoTargetCodec = targetCodec;
        reasons.push(reason ? `video_encode:${reason}` : `video_encode:container_mismatch:${videoCodec}`);
      } else {
        video = "unsupported";
        reasons.push(`video_encoder_missing:${targetCodec}`);
      }
    }
  }

  // --- Audio track ----------------------------------------------------
  let audio: TrackAction;
  let audioTargetCodec: string | undefined;
  const audioCodec = normalise(probe.audio?.codec);

  if (intent.dropAudio) {
    audio = "discard";
    reasons.push("audio_discarded_by_user");
  } else if (!audioCodec) {
    audio = "none";
  } else {
    const reason = audioReason(intent.audioChanges);
    const fitsContainer = audioAllowed.includes(audioCodec);
    if (!reason && fitsContainer) {
      audio = "copy";
      reasons.push(`audio_copy:${audioCodec}`);
    } else {
      const targetCodec = PREFERRED_AUDIO[target];
      if (!probe.audio?.canDecode) {
        audio = "unsupported";
        reasons.push(`audio_cannot_decode:${audioCodec}`);
      } else if (support.audioEncode(targetCodec)) {
        audio = "encode";
        audioTargetCodec = targetCodec;
        reasons.push(reason ? `audio_encode:${reason}` : `audio_encode:container_mismatch:${audioCodec}`);
      } else {
        audio = "unsupported";
        reasons.push(`audio_encoder_missing:${targetCodec}`);
      }
    }
  }

  // --- Overall verdict ------------------------------------------------
  const blocked = video === "unsupported" || audio === "unsupported";

  // A container with no tracks in it is not a media file. This happens when a
  // caller drops both tracks, or hands in a probe that found neither — and it
  // is better caught here than written to disk as an unplayable file.
  const empty = (video === "none" || video === "discard") && (audio === "none" || audio === "discard");
  if (empty && !blocked) reasons.push("no_tracks_left");

  // "remux" only when no encoder runs at all. A copied video track next to a
  // recomputed audio track is not a remux — an encoder runs there, and no
  // interface built on this should claim "without quality loss".
  const remux = !blocked && !empty && video !== "encode" && audio !== "encode";

  return {
    decision: blocked || empty ? "impossible" : remux ? "remux" : "reencode",
    video,
    audio,
    videoTargetCodec,
    audioTargetCodec,
    reasons,
  };
}

/**
 * Whether a file passes through without any recomputation.
 *
 * This is the question that decides whether an interface may show "fast, no
 * quality loss".
 */
export function isLossless(plan: MediaPlan): boolean {
  return plan.decision === "remux";
}
