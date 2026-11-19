---
title: Slipstream
emoji: 🏎️
colorFrom: red
colorTo: gray
sdk: docker
app_port: 4000
pinned: false
license: mit
short_description: Real-time race telemetry, timing and strategy pit wall
---

Slipstream on a Hugging Face Docker Space. The image is built from
https://github.com/Ivan825/Slipstream (branch `main`); see `deploy/huggingface/` there.

Set `MONGO_URI` under Settings → Variables and secrets. `JWT_SECRET` and `INGEST_SECRET`
are optional secrets: when missing, random ones are generated at boot (sign-ins then last until a restart).
