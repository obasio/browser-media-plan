# browser-media-plan

Two small pieces of media logic that are easy to get wrong in the browser: deciding whether a file needs re-encoding at all, and finding out what the browser can actually encode.

No runtime dependencies. `planFor` is a pure function you can test without a browser and without a media file.

## Install

```
npm install browser-media-plan
```

`mediabunny` is an optional peer dependency, needed only by the capability probe. Import `browser-media-plan/plan` on its own if you already know your encoder support.

## 1. Remux first

A `.mov` holding H.264 video and AAC audio already contains exactly the bitstreams that would sit inside an `.mp4`. Turning it into MP4 is a container rewrite, not a recomputation of pixels. Re-encoding it costs minutes and quality and buys nothing.

```
REMUX FIRST → COPY CODECS → RE-ENCODE ONLY IF REQUIRED
```

A re-encode happens only when the change actually touches the pixels — different resolution, different frame rate, a crop, rotation baked into the frames, a target file size — or when the target container cannot carry the codec.

```ts
import { planFor, isLossless } from "browser-media-plan/plan";

const probe = {
  container: "mov",
  video: { codec: "avc", canDecode: true },
  audio: { codec: "aac", canDecode: true },
};
const support = { videoEncode: () => true, audioEncode: () => true };

const plan = planFor(probe, { target: "mp4" }, support);

plan.decision;    // "remux"
plan.video;       // "copy"
plan.audio;       // "copy"
isLossless(plan); // true — safe to tell a user "no quality loss"
```

### Transform, and only what has to change

```ts
planFor(probe, { target: "mp4", videoChanges: { resolution: true } }, support);
// decision: "reencode"
// video: "encode", videoTargetCodec: "avc"
// audio: "copy"            ← untouched
// reasons: ["video_encode:resolution_change", "audio_copy:aac"]
```

Recomputing a video track is no reason to recompute the sound. The two tracks are decided independently, and `reasons` records why each one came out the way it did.

`decision` is `"impossible"` when a track can be neither copied nor produced — a missing encoder, a codec the browser cannot decode, or a request that would leave the file with no tracks at all.

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

The browser's answers are cached for the session, because the query costs time and the answer does not change while the page is open.

### Codec policy

If your project must not *produce* a particular codec, gate it per call:

```ts
const support = await detectEncoderSupport({
  allow: (codec) => codec !== "avc" && codec !== "aac",
});
```

Anything that would need a blocked encoder then comes back as `"impossible"` rather than quietly producing a file you did not want. Remuxing an existing bitstream is unaffected: no encoder runs there, so `planFor` may still copy a codec this gate blocks.

The policy is applied per call and is never cached. Two calls with different policies in the same session do not affect each other.

> **The policy is a technical switch, not a legal clearance.** Blocking a codec here grants you no rights to the ones you leave enabled, and enabling one creates no obligation. Codec licensing is a separate question and this library takes no position on it.

If you already know your capabilities — from your own probe, or in a test — compose them directly, with no browser involved:

```ts
import { encoderSupportFrom } from "browser-media-plan/capabilities";

const support = encoderSupportFrom({
  video: new Set(["avc", "vp9"]),
  audio: new Set(["aac", "opus"]),
});
```

## Container rules

`CONTAINER_VIDEO` and `CONTAINER_AUDIO` are deliberately narrower than the specifications allow:

| Container | Video | Audio |
|---|---|---|
| `mp4` | avc, hevc | aac, mp3 |
| `mov` | avc, hevc | aac, mp3 |
| `webm` | vp8, vp9, av1 | opus, vorbis |
| `mkv` | avc, hevc, vp8, vp9, av1 | aac, opus, vorbis, mp3, flac |

MP4 can legally carry VP9, AV1 and Opus, but Safari and QuickTime will not play them. MP4 is the container people pick when they mean "plays everywhere"; a remuxed VP9-in-MP4 would be valid, instant, and silent on exactly the devices the choice was made for. Whoever wants to keep VP9 picks WebM, where it is copied instead.

## HEVC

HEVC can be *copied*: an iPhone recording remuxes into MP4 or MKV untouched, which is the fast path and the point of the library. It is never chosen as an encode target — `PREFERRED_VIDEO` picks H.264 for MP4/MOV/MKV and VP9 for WebM.

`canEncode("hevc")` still answers truthfully, because the probe asks the browser about every codec this library names rather than a shorter subset. Whether your browser can encode HEVC is a fact about the machine, and the library reports it instead of guessing.

## Codec identifiers

Pass short family names: `avc`, `hevc`, `vp8`, `vp9`, `av1`, `aac`, `opus`, `mp3`, `vorbis`, `flac`. Comparison is case-insensitive and trims whitespace. Full codec strings such as `avc1.42E01E` are not understood — reduce them to the family name first.

## Development

```
npm run typecheck
npm run build
npm test
```

38 tests, no browser required.

## License

MIT
