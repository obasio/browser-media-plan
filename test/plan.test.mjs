import assert from "node:assert/strict";
import test from "node:test";

/**
 * The "remux or re-encode" decision.
 *
 * This is the logic where a mistake is expensive: a file wrongly classified as
 * "re-encode" costs minutes and quality, a file wrongly classified as "remux"
 * produces something that will not play. That is why `planFor` is a pure
 * function and is checked here without a browser and without a media file.
 */

const plan = await import("../src/plan.ts");

/** A browser that can do everything — the normal case on a desktop. */
const canDoAll = { videoEncode: () => true, audioEncode: () => true };
/** A browser without an H.264 encoder, but with VP9. */
const withoutH264 = { videoEncode: (c) => c !== "avc", audioEncode: () => true };

const probe = (v, a, decodable = true) => ({
  container: "mov",
  video: v ? { codec: v, canDecode: decodable } : null,
  audio: a ? { codec: a, canDecode: decodable } : null,
});

test("MOV with H.264 and AAC is only remuxed into MP4", () => {
  // The core case: both bitstreams already exist exactly as they would sit in
  // an MP4. Recomputing them costs time and quality and buys nothing.
  const p = plan.planFor(probe("avc", "aac"), { target: "mp4" }, canDoAll);
  assert.equal(p.decision, "remux");
  assert.equal(p.video, "copy");
  assert.equal(p.audio, "copy");
  assert.equal(p.videoTargetCodec, undefined, "copying must not pick an encoder");
  assert.equal(plan.isLossless(p), true);
});

test("the same rule holds for MKV, MPEG-TS and MP4 itself", () => {
  for (const container of ["mkv", "mpegts", "mp4"]) {
    const p = plan.planFor({ ...probe("avc", "aac"), container }, { target: "mp4" }, canDoAll);
    assert.equal(p.decision, "remux", `${container} should be remuxable`);
  }
});

test("video without audio and audio without video stay a remux", () => {
  const silent = plan.planFor(probe("avc", null), { target: "mp4" }, canDoAll);
  assert.equal(silent.decision, "remux");
  assert.equal(silent.audio, "none");

  const audioOnly = plan.planFor(probe(null, "aac"), { target: "mp4" }, canDoAll);
  assert.equal(audioOnly.decision, "remux");
  assert.equal(audioOnly.video, "none");
});

test("dropping the audio is no reason to recompute the video", () => {
  const p = plan.planFor(probe("avc", "aac"), { target: "mp4", dropAudio: true }, canDoAll);
  assert.equal(p.decision, "remux");
  assert.equal(p.video, "copy");
  assert.equal(p.audio, "discard");
});

test("every change to the pixels forces a re-encode", () => {
  for (const field of ["resolution", "frameRate", "crop", "rotationBakedIn", "mirror", "speed", "filter", "targetSize"]) {
    const p = plan.planFor(probe("avc", "aac"), { target: "mp4", videoChanges: { [field]: true } }, canDoAll);
    assert.equal(p.decision, "reencode", `${field} should force a re-encode`);
    assert.equal(p.video, "encode");
    assert.equal(p.videoTargetCodec, "avc");
    // The audio is untouched by this and keeps being copied.
    assert.equal(p.audio, "copy");
  }
});

test("audio changes leave the video alone", () => {
  const p = plan.planFor(probe("avc", "aac"), { target: "mp4", audioChanges: { loudness: true } }, canDoAll);
  assert.equal(p.video, "copy");
  assert.equal(p.audio, "encode");
  assert.equal(p.decision, "reencode");
});

test("a codec the target container cannot carry gets re-encoded", () => {
  // VP9 and Opus belong in WebM — they move there unchanged.
  const toWebm = plan.planFor(probe("vp9", "opus"), { target: "webm" }, canDoAll);
  assert.equal(toWebm.decision, "remux");

  // Vorbis does not fit into MP4, the video does.
  const mixed = plan.planFor(probe("avc", "vorbis"), { target: "mp4" }, canDoAll);
  assert.equal(mixed.video, "copy");
  assert.equal(mixed.audio, "encode");
  assert.equal(mixed.audioTargetCodec, "aac");
  // A copied video track next to a recomputed audio track is NOT a remux —
  // nothing here may be advertised as "without quality loss".
  assert.equal(mixed.decision, "reencode");
  assert.equal(plan.isLossless(mixed), false);
});

test("a missing encoder is reported instead of failing silently", () => {
  // VP9 into MP4 needs H.264, because VP9-in-MP4 would be silent in Safari and
  // QuickTime. Without an H.264 encoder that road is closed.
  const p = plan.planFor(probe("vp9", "aac"), { target: "mp4" }, withoutH264);
  assert.equal(p.decision, "impossible");
  assert.equal(p.video, "unsupported");
  assert.ok(p.reasons.some((r) => r.startsWith("video_encoder_missing")));

  // The same file passes as WebM — nothing is produced there at all.
  const asWebm = plan.planFor(probe("vp9", "opus"), { target: "webm" }, withoutH264);
  assert.equal(asWebm.decision, "remux");
});

test("what the browser cannot decode cannot be converted either", () => {
  const p = plan.planFor(probe("hevc", "aac", false), { target: "mp4", videoChanges: { resolution: true } }, canDoAll);
  assert.equal(p.decision, "impossible");
  assert.ok(p.reasons.some((r) => r.startsWith("video_cannot_decode")));
});

test("HEVC in MP4 may be remuxed without re-encoding", () => {
  // Existing bitstreams may be copied. HEVC is produced nowhere — which shows
  // up here as the absence of a target codec.
  const p = plan.planFor(probe("hevc", "aac"), { target: "mp4" }, canDoAll);
  assert.equal(p.decision, "remux");
  assert.equal(p.video, "copy");
  assert.equal(p.videoTargetCodec, undefined);
});

test("HEVC is never produced", () => {
  // Even with a pending change: the target is H.264 for MP4 and VP9 for WebM,
  // never HEVC. No path in the plan picks HEVC as a target codec.
  for (const target of ["mp4", "webm"]) {
    const p = plan.planFor(probe("hevc", "aac"), { target, videoChanges: { resolution: true } }, canDoAll);
    assert.notEqual(p.videoTargetCodec, "hevc");
  }
  assert.notEqual(plan.PREFERRED_VIDEO.mp4, "hevc");
  assert.notEqual(plan.PREFERRED_VIDEO.webm, "hevc");
});

test("H.264 or AAC are never produced for WebM", () => {
  const p = plan.planFor(probe("avc", "aac"), { target: "webm" }, canDoAll);
  assert.equal(p.video, "encode");
  assert.equal(p.videoTargetCodec, "vp9");
  assert.equal(p.audio, "encode");
  assert.equal(p.audioTargetCodec, "opus");
  assert.ok(!plan.CONTAINER_VIDEO.webm.includes("avc"));
  assert.ok(!plan.CONTAINER_AUDIO.webm.includes("aac"));
});

test("the reasons are machine-readable, not just human-readable", () => {
  // Diagnostics depend on this: it should be able to say why a file was
  // recomputed without anyone having to guess.
  const p = plan.planFor(probe("avc", "aac"), { target: "mp4", videoChanges: { resolution: true } }, canDoAll);
  assert.ok(p.reasons.includes("video_encode:resolution_change"));
  assert.ok(p.reasons.includes("audio_copy:aac"));
});
