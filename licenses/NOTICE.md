# TTS third-party notices

The synthesis implementation in `tts-engine.worker.ts` is adapted from the
[Supertonic browser helper](https://github.com/supertone-oss-archive/supertonic/blob/main/web/helper.js)
by **Supertone Inc.** The original helper is MIT-licensed, copyright © 2025
Supertone Inc.; see `TTS_LICENSE_SUPERTONIC_CODE.txt`. This implementation has
been modified for TypeScript, a dedicated worker, incremental MP3 encoding,
chunk-level trimming, download progress, retry and backend fallback.

The separately downloaded **Supertonic 3** model and its voice styles are by
**Supertone Inc.**, copyright © 2026 Supertone Inc. They are distributed under
the BigScience Open RAIL-M License, including its use restrictions: see
`TTS_LICENSE_SUPERTONIC_MODEL.txt` and the [pinned model repository](https://huggingface.co/supertone-oss-archive/supertonic-3/tree/aafc6e32416a594460b32413efc49d7fe4ce6d46).
The license requires, among other things, notice and compliance with its use
restrictions, including disclosure of machine-generated content in contexts
specified by Attachment A. Operators must make the model license available to
recipients and ensure their terms satisfy its distribution and use conditions;
this source notice alone does not replace that obligation. The weights are not
included in this repository.

Inference uses [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)
by Microsoft and contributors, under the MIT license; see
`TTS_LICENSE_ONNXRUNTIME.txt`.

MP3 encoding uses [@breezystack/lamejs](https://github.com/breezystack/lamejs),
a browser/ES-module-compatible fork of [lamejs](https://github.com/zhuker/lamejs)
by Alex Zhukov, based on the [LAME encoder](https://lame.sourceforge.io/).
It is licensed under LGPL-3.0; see `TTS_LICENSE_LAMEJS.txt` and the full text in
`TTS_LICENSE_LGPL-3.0.txt`. Its source code is
available at the links above and in the npm package. When distributing the app,
provide the LGPL notices/source and meet the LGPL's requirements for replacement
or relinking of the encoder. No encoder source modifications are made here.
