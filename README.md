# browser-media-plan

Two small pieces of media logic that are easy to get wrong in the browser.

## 1. Remux first

A `.mov` holding H.264 video and AAC audio already contains exactly the bitstreams that would sit inside an `.mp4`. Turning it into MP4 is a container rewrite, not a recomputation of pixels. Re-encoding it costs minutes and quality and buys nothing.

The rule this library implements, in this order:

```
REMUX FIRST → COPY CODECS → RE-ENCODE ONLY IF REQUIRED
```

A re-encode happens only when the change actually touches the pixels — different resolution, different frame rate, a crop, rotation baked into the frames, a target file size — or when the target container cannot carry the codec.

```ts
import { planFor, isLossless } from "browser-media-plan/plan";

const plan = planFor(
  {
    container: "mov",
    video: { codec: "avc", canDecode: true },
    audio: { codec: "aac", canDecode: true },
  },
  { target: "mp4" },
  { videoEncode: () => true, audioEncode: () => true },
);

plan.decision;   // "remux"
plan.video;      // "copy"
plan.audio;      // "copy"
isLossless(plan) // true — safe to tell a user "no quality loss"
```

Ask for a resolution change and the same file becomes:

```ts
planFor(probe, { target: "mp4", videoChanges: { resolution: true } }, support);
// decision: "reencode", video: "encode", videoTargetCodec: "avc", audio: "copy"
```

Note what stays true there: the audio is still copied. Recomputing a video track is no reason to recompute the sound.

`planFor` is a pure function with no imports. It can be tested without a browser and without a media file, which is the point — this is the logic where a mistake is expensive.

## 2. Never infer codec support from the user agent

The same Chrome build encodes H.264 on one machine and refuses on the next, because it depends on the hardware and on what the operating system ships. The honest answer comes from `VideoEncoder.isConfigSupported` and `AudioEncoder.isConfigSupported`.

```ts
import { detectEncoderSupport } from "browser-media-plan/capabilities";

const support = await detectEncoderSupport();
const plan = planFor(probe, intent, support);

if (plan.decision === "impossible") {
  // Say so before the run starts, instead of failing halfway
  // through a two-gigabyte file.
}
```

The result is cached for the session, because the query costs time and the answer does not change.

If your project must not *produce* a particular codec — for licensing, platform policy, or an output-format decision — gate it:

```ts
const support = await detectEncoderSupport({
  allow: (codec) => codec !== "avc" && codec !== "aac",
});
```

Anything that would need a blocked encoder then comes back as `impossible` rather than silently producing a file you did not want. Remuxing an existing bitstream is unaffected: no encoder runs there.

## Container rules

`CONTAINER_VIDEO` and `CONTAINER_AUDIO` are deliberately narrower than the specifications allow:

| Container | Video | Audio |
|---|---|---|
| `mp4` | avc, hevc | aac, mp3 |
| `mov` | avc, hevc | aac, mp3 |
| `webm` | vp8, vp9, av1 | opus, vorbis |
| `mkv` | avc, hevc, vp8, vp9, av1 | aac, opus, vorbis, mp3, flac |

MP4 can legally carry VP9, AV1 and Opus, but Safari and QuickTime will not play them. MP4 is the container people pick when they mean "plays everywhere"; a remuxed VP9-in-MP4 would be valid, instant, and silent on exactly the devices the choice was made for. Whoever wants to keep VP9 picks WebM, where it is copied instead.

HEVC appears in the *copy* lists so existing iPhone recordings can be remuxed. It is never chosen as an encode target.

## Install

```
npm install browser-media-plan mediabunny
```

`mediabunny` is an optional peer dependency, needed only by `capabilities`. Import `browser-media-plan/plan` on its own if you already know your encoder support — that entry point has no dependencies at all.

## Tests

```
npm test
```

13 tests, no browser required.

## License

MIT
