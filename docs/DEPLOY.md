# Deploying Slipstream

| Piece | Where | Why |
|---|---|---|
| Dashboard (React) | **Vercel** | Static site on a CDN |
| API + Socket.IO + simulator + replay | **Render** | Needs an always-on process for WebSockets and background clocks. Vercel functions are short-lived, so they can't hold sockets |
| Database | **MongoDB Atlas** (free M0) | |

Allow about 20 minutes. Everything below is on free tiers.

## 1. MongoDB Atlas

1. Sign in at https://cloud.mongodb.com and create a project.
2. **Create** a cluster: **M0 Free**, any region close to your Render region (for example Frankfurt or Oregon).
3. **Database Access → Add New Database User:** username `slipstream`, a generated password (copy it), role **Read and write to any database**.
4. **Network Access → Add IP Address → Allow access from anywhere** (`0.0.0.0/0`). Render's outbound IPs aren't fixed on the free plan.
5. **Database → Connect → Drivers** and copy the connection string. Add the database name after `.net/`:
   ```
   mongodb+srv://slipstream:<password>@<cluster>.mongodb.net/slipstream?retryWrites=true&w=majority
   ```

## 2. Backend on Render

1. Sign in at https://render.com with GitHub and allow access to the `Slipstream` repository.
2. **New → Blueprint**, pick the repository. Render reads [`render.yaml`](../render.yaml).
3. Fill in the values it asks for:
   - `MONGO_URI`: the Atlas string from step 1.
   - `CLIENT_ORIGIN`: enter `https://example.com` for now. You'll replace it with the real URLs in step 4.
   - `OPENF1_TOKEN`: leave empty unless you have an OpenF1 subscription. Past sessions work without it.
4. **Apply**. The first build takes about 3–5 minutes.
5. When it shows **Live**, open `https://<your-service>.onrender.com/api/health`. It should return `{"ok":true,"db":true,…}`.
   - The same URL also serves the dashboard, so the whole app already works from Render alone.
6. Copy the service URL, for example `https://slipstream-abcd.onrender.com`.

On first boot the server:
- creates the demo accounts (password `slipstream`);
- starts a race with the demo director;
- pre-downloads the first 15 minutes of the 2024 Brazilian GP from OpenF1.

## 3. Frontend on Vercel

1. Sign in at https://vercel.com with GitHub. **Add New → Project**, import `Slipstream`.
2. Settings:
   - **Root Directory:** `client`. Keep "Include files outside the root directory" **enabled**, because the dashboard imports the shared package.
   - **Framework Preset:** Vite. Build and install commands come from [`client/vercel.json`](../client/vercel.json): `cd .. && npm ci` and `npm run build`, output `dist`.
   - **Environment Variables:** `VITE_API_URL` = your Render URL from step 2 (no trailing slash).
3. **Deploy.** Copy the production URL, for example `https://slipstream.vercel.app`.

## 4. Connect them

On Render, open the service → **Environment** and set:

```
CLIENT_ORIGIN=https://slipstream.vercel.app,https://slipstream-abcd.onrender.com
```

Save. Render redeploys in about a minute. That's it: open the Vercel URL and sign in as `control`, `kestrel` or any team id, with password `slipstream`.

## 5. Check it

- [ ] `https://<render>/api/health` returns `ok: true, db: true`
- [ ] The Vercel site shows **LIVE** in the top bar, and cars move on the pit wall
- [ ] Sign in as `kestrel`: Telemetry shows the ghost-lap seam and live traces
- [ ] Real Data → pick a 2024 race: it opens within about 10 s and cars move
- [ ] Systems shows ingest at about 400 events/s

## Notes

- **Render free instances sleep after 15 minutes without traffic**, and the first request after that takes about 50 s. For a demo, open the site a minute early, or point a free uptime monitor (for example UptimeRobot) at `/api/health` every 10 minutes.
- **Storage.** Raw telemetry expires after 10 minutes on this blueprint (`TELEMETRY_TTL_MIN`). Laps, alerts, results and real-session chunks are kept. An M0 cluster has room for this plus several full real races.
- **Live feed.** To follow sessions in real time, add `OPENF1_TOKEN` (or `OPENF1_USERNAME` and `OPENF1_PASSWORD`) on Render.
- **One-service alternative.** Skip Vercel and use the Render URL directly: it serves the same dashboard (`SERVE_CLIENT=true`).
- **Docker.** `docker compose up --build` runs MongoDB and Slipstream locally on port 4000.
