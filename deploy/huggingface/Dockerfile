# Hugging Face Docker Space for Slipstream: builds the app from GitHub main.
# Copy this file, start.sh and README.md to the root of the Space repository.
FROM node:22-alpine AS build
RUN apk add --no-cache git
WORKDIR /src
# this file changes whenever main moves, so a rebuild always picks up the latest commit
ADD https://api.github.com/repos/Ivan825/Slipstream/git/refs/heads/main /tmp/main.json
RUN git clone --depth 1 https://github.com/Ivan825/Slipstream.git . && npm ci && VITE_API_URL= npm run build -w client

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/shared/package.json shared/
COPY --from=build /src/server/package.json server/
COPY --from=build /src/simulator/package.json simulator/
COPY --from=build /src/client/package.json client/
COPY --from=build /src/loadtest/package.json loadtest/
RUN npm ci --omit=dev -w server -w shared -w simulator && npm cache clean --force
COPY --from=build /src/shared shared
COPY --from=build /src/server server
COPY --from=build /src/simulator simulator
COPY --from=build /src/client/dist client/dist
COPY --chmod=755 start.sh ./

# same settings as render.yaml; MONGO_URI (and optionally JWT_SECRET / INGEST_SECRET) come from Space secrets
ENV PORT=4000 SERVE_CLIENT=true EMBED_SIMULATOR=true DEMO_DIRECTOR=true \
    REPLAY_AUTO_IMPORT=true REPLAY_SESSION=9636 \
    SIM_HZ=10 STRATEGY_EVERY_SEC=6 TELEMETRY_TTL_MIN=10 SIM_KEEP_SESSIONS=10 REPLAY_CACHE_MB=150 \
    TELEMETRY_PERSIST_EVERY=10 IDLE_AFTER_MIN=15 \
    CLIENT_ORIGIN=https://slipstream-flax.vercel.app,https://ivan825-slipstream.hf.space \
    KEEP_AWAKE_URL=https://ivan825-slipstream.hf.space
EXPOSE 4000
USER node
CMD ["./start.sh"]
