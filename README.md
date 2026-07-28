# modwiz-backend

A tiny backend with one job: hold your AWS credentials safely and let the
Modwiz app talk to Merlin (Claude via AWS Bedrock) without those credentials
ever being inside the app itself. If they shipped inside the app, anyone
could pull them out of the app bundle and run up charges on your AWS
account — this backend is what prevents that.

It has exactly one endpoint: `POST /api/merlin-chat`. The app sends it the
conversation so far; it checks that the request really comes from a logged-in
Modwiz Mastery user, then asks Claude to reply as Merlin, and sends the reply
back. No database, nothing else — on purpose, to keep this first version
simple.

## One-time setup

You'll need:
- A **GitHub account** (free) — Vercel deploys straight from a GitHub repo.
- A **Vercel account** (free) — sign up at vercel.com, "Continue with GitHub" is easiest.
- An **AWS IAM user with Bedrock access** — Access Key ID + Secret Access Key, scoped to `bedrock:InvokeModel`/`InvokeModelWithResponseStream`. Same AWS account Luna (the WhatsApp bot) runs on, but its own dedicated IAM user — don't reuse Luna's `n8n-bedrock` credentials here. Keep both secret; never paste them into the app code or commit them to GitHub.

## Step 1 — Push this folder to its own GitHub repo

In Terminal:

```sh
cd /Users/rhezaelfuego/modwiz-backend
git init
git add .
git commit -m "Initial Merlin backend"
```

Then on github.com: **New repository** → name it `modwiz-backend` → **Create repository** (leave it empty, no README/gitignore — you already have those). GitHub will show you commands like:

```sh
git remote add origin https://github.com/YOUR-USERNAME/modwiz-backend.git
git branch -M main
git push -u origin main
```

Run those (copy the exact URL GitHub shows you, it'll have your username in it).

## Step 2 — Import into Vercel

1. Go to vercel.com → **Add New...** → **Project**.
2. Pick the `modwiz-backend` repo you just pushed.
3. Vercel will detect it as a plain Node project — you don't need to change any build settings.
4. Before clicking Deploy, open **Environment Variables** and add:
   - `AWS_ACCESS_KEY_ID` — your IAM user's access key
   - `AWS_SECRET_ACCESS_KEY` — your IAM user's secret key
   - `AWS_REGION` — `us-east-1` (same region Luna's Bedrock setup uses)
5. Click **Deploy**.

When it finishes, Vercel gives you a URL like `https://modwiz-backend-xyz123.vercel.app`. Your real endpoint is that URL plus `/api/merlin-chat`, e.g.:

```
https://modwiz-backend-xyz123.vercel.app/api/merlin-chat
```

## Step 3 — Point the app at it

In the `modwiz-app` project, open `constants/merlin.ts` and replace the placeholder URL with your real one from Step 2:

```ts
export const MERLIN_API_URL = 'https://modwiz-backend-xyz123.vercel.app/api/merlin-chat';
```

Save, reload the app, and Merlin should respond in the Wizard AI tab.

## Testing the endpoint directly (optional)

You can check the backend is alive without opening the app, using `curl` in Terminal — replace the URL and swap in a real WordPress username/app-password for the `Authorization` header (the same one the app uses to log in):

```sh
curl -X POST https://modwiz-backend-xyz123.vercel.app/api/merlin-chat \
  -H "Content-Type: application/json" \
  -u "your-wp-username:your-wp-app-password" \
  -d '{"messages":[{"role":"user","content":"Hello Merlin"}]}'
```

A working response looks like `{"reply":"..."}`. A `401` means the login credentials didn't check out against modwizmastery.com; a `502` means Claude/Bedrock itself failed (check the `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` values in Vercel's project settings, and that the IAM user actually has Bedrock permissions).

## Redeploying after a code change

Any time you edit files in this folder and want the change live: `git add -A && git commit -m "..." && git push`. Vercel redeploys automatically on every push to `main` — no manual step needed after the first setup.

## Today's Wisdom feature

Three more endpoints live here, all for the "Today's Wisdom" feature (users submit a quote + video + story; Modwiz reviews before it goes live). Same rule as Merlin: every request must come from a logged-in Modwiz Mastery user, and every secret key stays server-side.

- `GET /api/wisdom-background-search?query=...&page=...` — searches Unsplash for portrait-orientation photos to use as the quote card background.
- `POST /api/wisdom-background-select` — pings Unsplash's required "download" tracking URL once a user actually picks a photo (not on every search result — that would blow through the free rate limit fast).
- `POST /api/wisdom-video-upload-auth` — creates a video slot on Bunny Stream and hands the app a short-lived signed upload authorization, so the phone can upload the video **directly to Bunny** (bypassing this backend entirely — Vercel's free tier can't handle a multi-minute video in one request body) without ever seeing the permanent Bunny Stream API key.
- `POST /api/wisdom-card-upload` — receives the small composited quote-card JPEG (rendered in the app) as base64 and uploads it to a dedicated Bunny Storage Zone.

### Extra setup for this feature

1. **Unsplash**: go to unsplash.com/developers → "New Application" → accept the guidelines → copy the **Access Key**. Free tier is 50 requests/hour, which is plenty for browsing backgrounds.
2. **Bunny Stream** (video hosting): in your Bunny.net dashboard, create a new **Stream Video Library** (separate product from Storage Zones — this is the one built for video, with adaptive playback). Note its **Library ID**, generate/copy its **API Key** from the library's API page, and note its **Pull Zone hostname** too (shown on the library's overview page, looks like `vz-xxxxxxxx-xxx.b-cdn.net`) — the app plays Wisdom videos through this the same direct way it already plays lesson videos, not through an embedded player.
3. **Bunny Storage Zone** (for the small quote-card images): create a **new** Storage Zone — don't reuse `modwiz-audio` — e.g. name it `modwiz-wisdom`, and attach a Pull Zone to it the same way you did for `modwizaudio`. Note the zone name, its **password** (Storage Zone → FTP & API Access), and which region hostname it uses (usually `storage.bunnycdn.com` unless you picked a specific region).
4. Add all seven new values from `.env.example` to the Vercel project's Environment Variables (same place you added the AWS credentials), then redeploy (Vercel → Deployments → ⋯ → Redeploy, or just push any commit).

### Testing directly with curl

```sh
curl "https://your-backend.vercel.app/api/wisdom-background-search?query=peace" \
  -u "your-wp-username:your-wp-app-password"

curl -X POST https://your-backend.vercel.app/api/wisdom-video-upload-auth \
  -u "your-wp-username:your-wp-app-password" \
  -H "Content-Type: application/json" -d '{"title":"test upload"}'
```
