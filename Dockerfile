# One image: Express + Socket.IO server, the embedded simulator and the built dashboard.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY simulator/package.json simulator/
COPY client/package.json client/
COPY loadtest/package.json loadtest/
RUN npm ci
COPY . .
# empty API URL = same origin as the server that serves the dashboard
RUN VITE_API_URL= npm run build -w client

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY simulator/package.json simulator/
COPY client/package.json client/
COPY loadtest/package.json loadtest/
RUN npm ci --omit=dev -w server -w shared -w simulator && npm cache clean --force
COPY shared shared
COPY server server
COPY simulator simulator
COPY --from=build /app/client/dist client/dist
ENV PORT=4000 SERVE_CLIENT=true EMBED_SIMULATOR=true
EXPOSE 4000
USER node
CMD ["node", "server/src/index.js"]
