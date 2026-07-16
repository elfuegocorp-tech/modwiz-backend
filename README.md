# modwiz-backend

A tiny backend with one job: hold your Anthropic (Claude) API key safely and
let the Modwiz app talk to Merlin without that key ever being inside the app
itself. If the key shipped inside the app, anyone could pull it out of the
app bundle and run up charges on your Anthropic account — this backend is
what prevents that.

It has exactly one endpoint: `POST /api/merlin-chat`. The app sends it the
conversation so far; it checks that the request really comes from a logged-in
Modwiz Mastery user, then asks Claude to reply as Merlin, and sends the reply
back. No database, nothing else — on purpose, to keep this first version
simple.

## One-time setup

You'll need:
- A **GitHub account** (free) — Vercel deploys straight from a GitHub repo.
- A **Vercel account** (free) — sign up at vercel.com, "Continue with GitHub" is easiest.
- An **Anthropic API key** — from console.anthropic.com → API Keys → Create Key. Starts with `sk-ant-`. Keep it secret; never paste it into the app code or commit it to GitHub.

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
   - Name: `ANTHROPIC_API_KEY`
   - Value: your `sk-ant-...` key
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

A working response looks like `{"reply":"..."}`. A `401` means the login credentials didn't check out against modwizmastery.com; a `502` means Claude itself failed (check the `ANTHROPIC_API_KEY` value in Vercel's project settings).

## Redeploying after a code change

Any time you edit files in this folder and want the change live: `git add -A && git commit -m "..." && git push`. Vercel redeploys automatically on every push to `main` — no manual step needed after the first setup.
