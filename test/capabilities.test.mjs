import assert from "node:assert/strict";
import test from "node:test";

/**
 * Caching what the browser can do is right — caching the caller's policy on
 * top of it is a bug. The browser's answer is a fact about the machine and
 * does not change while the page is open. A policy is a decision the caller
 * makes per call, and two callers may decide differently in the same session.
 *
 * These tests use the internal probe seam so the behaviour can be checked
 * without a browser and without Mediabunny.
 */

const caps = await import("../dist/capabilities.js");

const raw = (video, audio) => ({ video: new Set(video), audio: new Set(audio) });

/** A probe that records how often it was asked. */
function countingProbe(answer) {
  const state = { calls: 0 };
  return [
    async () => {
      state.calls += 1;
      return answer;
    },
    state,
  ];
}

test("the browser is asked once, no matter how many callers ask", async () => {
  const [probe, state] = countingProbe(raw(["avc", "vp9"], ["aac", "opus"]));
  caps.__setEncoderProbe(probe);

  await caps.detectEncoderSupport();
  await caps.detectEncoderSupport();
  await caps.detectEncoderSupport({ allow: () => false });

  assert.equal(state.calls, 1);
});

test("concurrent callers share a single probe", async () => {
  const [probe, state] = countingProbe(raw(["avc"], ["aac"]));
  caps.__setEncoderProbe(probe);

  await Promise.all([
    caps.detectEncoderSupport(),
    caps.detectEncoderSupport(),
    caps.detectRawEncoderSupport(),
  ]);

  assert.equal(state.calls, 1);
});

test("a policy from one call does not leak into the next", async () => {
  // The bug this guards against: caching the composed result meant the second
  // caller silently inherited the first caller's policy for the whole session.
  const [probe] = countingProbe(raw(["avc", "vp9"], ["aac", "opus"]));
  caps.__setEncoderProbe(probe);

  const streng = await caps.detectEncoderSupport({ allow: (c) => c !== "avc" && c !== "aac" });
  assert.equal(streng.videoEncode("avc"), false);
  assert.equal(streng.audioEncode("aac"), false);
  assert.equal(streng.videoEncode("vp9"), true);

  const offen = await caps.detectEncoderSupport();
  assert.equal(offen.videoEncode("avc"), true, "the later call must not inherit the earlier policy");
  assert.equal(offen.audioEncode("aac"), true);

  // And the strict result still behaves as it did — it is its own object.
  assert.equal(streng.videoEncode("avc"), false);
});

test("policies apply in either order", async () => {
  const [probe] = countingProbe(raw(["avc"], ["aac"]));
  caps.__setEncoderProbe(probe);

  const offen = await caps.detectEncoderSupport();
  const streng = await caps.detectEncoderSupport({ allow: () => false });

  assert.equal(offen.videoEncode("avc"), true);
  assert.equal(streng.videoEncode("avc"), false);
});

test("a policy can never widen what the browser reported", async () => {
  const [probe] = countingProbe(raw(["vp9"], ["opus"]));
  caps.__setEncoderProbe(probe);

  const alles = await caps.detectEncoderSupport({ allow: () => true });
  assert.equal(alles.videoEncode("avc"), false, "the browser has no H.264 encoder here");
  assert.equal(alles.videoEncode("vp9"), true);
});

test("canEncode respects the policy of its own call", async () => {
  const [probe] = countingProbe(raw(["avc", "vp9"], ["aac"]));
  caps.__setEncoderProbe(probe);

  assert.equal(await caps.canEncode("avc"), true);
  assert.equal(await caps.canEncode("avc", { allow: (c) => c !== "avc" }), false);
  assert.equal(await caps.canEncode("avc"), true, "the blocked call must not stick");
  assert.equal(await caps.canEncode("aac"), true);
});

test("encoderSupportFrom is pure and needs no browser", () => {
  const support = caps.encoderSupportFrom(raw(["avc"], ["aac"]), { allow: (c) => c !== "aac" });
  assert.equal(support.videoEncode("avc"), true);
  assert.equal(support.audioEncode("aac"), false);
  assert.equal(support.videoEncode("vp9"), false);
});

test("resetEncoderSupport forgets the browser answer", async () => {
  const [probe, state] = countingProbe(raw(["avc"], ["aac"]));
  caps.__setEncoderProbe(probe);

  await caps.detectEncoderSupport();
  caps.resetEncoderSupport();
  await caps.detectEncoderSupport();

  assert.equal(state.calls, 2);
});

test("a failed probe is not cached as an answer", async () => {
  let calls = 0;
  caps.__setEncoderProbe(async () => {
    calls += 1;
    if (calls === 1) throw new Error("probe exploded");
    return raw(["avc"], ["aac"]);
  });

  await assert.rejects(() => caps.detectEncoderSupport(), /probe exploded/);
  const support = await caps.detectEncoderSupport();
  assert.equal(support.videoEncode("avc"), true, "a retry after a failure must work");
  assert.equal(calls, 2);
});

test("HEVC is asked about as a video codec, not an audio one", async () => {
  // The bug: canEncode fell through to the audio branch for any codec that was
  // not in the shorter probe list, so HEVC was answered from the audio set. It
  // returned false by accident, which is the right answer for the wrong reason
  // and would have flipped the moment the probe list changed.
  const [probe] = countingProbe(raw(["avc", "hevc"], ["aac"]));
  caps.__setEncoderProbe(probe);

  assert.equal(await caps.canEncode("hevc"), true);

  const support = await caps.detectEncoderSupport();
  assert.equal(support.videoEncode("hevc"), true);
  assert.equal(support.audioEncode("hevc"), false, "HEVC must never be looked up in the audio set");
});

test("a browser without an HEVC encoder answers honestly", async () => {
  const [probe] = countingProbe(raw(["avc"], ["aac"]));
  caps.__setEncoderProbe(probe);
  assert.equal(await caps.canEncode("hevc"), false);
});

test("every declared codec can actually be asked about", async () => {
  // The type says these names are askable. If the probe never gathered them,
  // the answer would be a permanent false regardless of the browser.
  const alle = ["avc", "hevc", "vp8", "vp9", "av1", "aac", "opus", "mp3", "vorbis", "flac"];
  const [probe] = countingProbe(raw(["avc", "hevc", "vp8", "vp9", "av1"], ["aac", "opus", "mp3", "vorbis", "flac"]));
  caps.__setEncoderProbe(probe);

  for (const codec of alle) {
    assert.equal(await caps.canEncode(codec), true, `${codec} should be answerable`);
  }
});

test("an unknown codec name is false, not silently audio", async () => {
  const [probe] = countingProbe(raw(["avc"], ["aac"]));
  caps.__setEncoderProbe(probe);
  assert.equal(await caps.canEncode("prores"), false);
  assert.equal(await caps.canEncode("nonsense"), false);
});

test("the video and audio sets stay separate", async () => {
  // A name in the wrong set must not leak across.
  const [probe] = countingProbe(raw(["avc"], ["avc"]));
  caps.__setEncoderProbe(probe);
  const support = await caps.detectEncoderSupport();
  assert.equal(support.videoEncode("avc"), true);
  assert.equal(support.audioEncode("aac"), false);
});

test("the seam is released again", () => {
  // Leaving the override in place would make every later import lie.
  caps.__setEncoderProbe(null);
  assert.equal(typeof caps.detectEncoderSupport, "function");
});
