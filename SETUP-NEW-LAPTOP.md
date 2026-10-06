# Moving Talkboard to the other laptop

Written for Windows + PowerShell. Nothing here touches your friend's own Git or GitHub setup.

## 1. Install (about 10 minutes)

- Node.js LTS from nodejs.org (version 20 or newer)
- Git for Windows from git-scm.com
- GitHub CLI from cli.github.com (optional, makes the push one command)
- Wispr Flow, signed in with your new Gmail through the referral link
- OBS for the video

Check in a new PowerShell window:

```powershell
node -v
git --version
gh --version
```

## 2. Run it

Unzip `talkboard.zip` somewhere simple, like `C:\dev\talkboard`, then:

```powershell
cd C:\dev\talkboard
npm install
copy .env.example .env.local
notepad .env.local
```

(Mac or Linux: `cp .env.example .env.local`.)

Get a key at Google AI Studio (aistudio.google.com, signed in with the new Gmail), create an API key, and paste it into `.env.local`:

```
GEMINI_API_KEY=paste-it-here
GEMINI_MODEL=
```

Leave `GEMINI_MODEL` empty unless you need a specific model. The server tries `gemini-flash-latest` first and falls back to `gemini-2.5-flash` if a name is retired.

Save, then:

```powershell
npm run dev
```

Open http://localhost:5173 and type: `Users hit a load balancer, three API servers, Postgres with a Redis cache.` then press Enter. The history entry should be tagged **Gemini**.

If it says **Rules** with a yellow "Gemini unavailable" bar, read the reason in the bar:

| Reason | Fix |
| --- | --- |
| GEMINI_API_KEY is not set on the server | `.env.local` is missing, misnamed (`.env.local.txt` is a common Windows trap) or in the wrong folder. Restart `npm run dev` after fixing. |
| API key not valid | Copy the key again from AI Studio. |
| Resource has been exhausted / quota | Free-tier rate limit. Wait a minute, speak a bit slower, or set `GEMINI_MODEL` to a Flash-Lite model from AI Studio. |
| model not found / HTTP 404 | Both default models failed. Pick a Flash model AI Studio lists for your key and put its exact name in `GEMINI_MODEL`. |

The app keeps working on the built-in rules either way, so the demo never dies on stage.

## 3. Wispr Flow setup

- **Dictionary:** Kafka, Redis, Postgres, Kubernetes, load balancer, CDN, sharding, rate limiter
- **Snippets:**
  - `microservices starter` types: Users hit a CDN and a load balancer, which routes to an API gateway, then auth, orders and payments services, each with its own Postgres database, and a Redis cache in front of orders.
  - `grill me` types: review my design
- Click into the big text box, hold the hotkey, speak, release, press Enter.

## 4. Push to your new GitHub account

Use **local** Git settings only, so your friend's global config stays untouched:

```powershell
cd C:\dev\talkboard
git init
git config user.name "Your Name"
git config user.email "your-new-gmail@gmail.com"
gh auth login          # GitHub.com, HTTPS, log in with a web browser: sign in as the NEW account
gh auth setup-git
gh auth status         # must show the new account
git add .
git status             # .env.local and node_modules must NOT be listed
git commit -m "Talkboard: voice-first system design interview coach"
gh repo create talkboard --public --source=. --push
```

Without the GitHub CLI: create an empty public repo named `talkboard` on github.com (new account), then:

```powershell
git remote add origin https://github.com/NEW-USERNAME/talkboard.git
git branch -M main
git push -u origin main
```

If a sign-in window appears, choose the new account. If Git pushes as your friend's account without asking, open Windows Credential Manager, remove the `git:https://github.com` entry, and push again.

When you're done on that PC: `gh auth logout`.

## 5. Deploy on Vercel

Simplest: sign up on vercel.com with "Continue with GitHub" using the **new** GitHub account (free Hobby plan). Your friend's Vercel account can't see repos owned by your new GitHub account unless you grant it access, so a fresh Vercel login saves time.

1. Add New, Project, import `talkboard`. Framework: Vite (auto).
2. Settings, Environment Variables: `GEMINI_API_KEY` = your key (all environments).
3. Deploy. If you added the key after the first deploy, redeploy once.
4. Open the live link in an Incognito window and run the demo script from the README.

## 6. Recording tips

- Hide the intro panel if you need more board space; zoom the browser to 110 to 125 percent for a readable video.
- Leave a few seconds between sentences. The free Gemini tier only allows a handful of requests per minute.
- Show the Wispr Dictionary and Snippets screens once; they are half the story.

## 7. Editing with Claude Code (optional)

`CLAUDE.md` in the project root describes the architecture, rules and file map, so Claude Code picks up the context when you open the folder. Run `npm run typecheck` after any change.

## 8. Getting it back to your own PC later

Once it's on GitHub, just `git clone` it on your repaired laptop. If you want a zip instead, zip the folder but leave out `node_modules` and `.env.local`.
