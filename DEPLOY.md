# Arabic Flashcard App — Deployment Guide

## What you're deploying

- **Frontend**: React + Vite app
- **Backend**: 2 Vercel serverless functions (Claude proxy + DALL-E proxy)
- **Host**: Vercel (free forever for personal projects)
- **URL**: `your-app-name.vercel.app` (free subdomain, or add your own domain)

---

## One-time setup (~15 minutes)

### Step 1 — Install tools (if not already installed)

```bash
# Install Node.js — download from https://nodejs.org (LTS version)
# Install Git — download from https://git-scm.com

# Verify both work:
node --version    # should show v18 or higher
git --version     # should show git version
```

### Step 2 — Install Claude Code (for future edits)

```bash
npm install -g @anthropic-ai/claude-code
```

### Step 3 — Create a GitHub repository

1. Go to **github.com** → sign in or create account
2. Click **"New repository"** (green button)
3. Name it: `arabic-flashcard-app`
4. Set to **Private** (recommended)
5. Click **"Create repository"**
6. Copy the repository URL shown (e.g. `https://github.com/yourname/arabic-flashcard-app.git`)

### Step 4 — Push the project to GitHub

Open a terminal, navigate to this project folder, then run:

```bash
cd /path/to/arabic-flashcard-deploy   # wherever you put this folder

git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/arabic-flashcard-app.git
git push -u origin main
```

### Step 5 — Connect to Vercel

1. Go to **vercel.com** → sign in with GitHub
2. Click **"Add New Project"**
3. Find your `arabic-flashcard-app` repo and click **"Import"**
4. Vercel auto-detects Vite — leave all settings as-is
5. Click **"Deploy"** — first deploy takes ~1 minute

You now have a live URL like `arabic-flashcard-app.vercel.app` ✅

### Step 6 — Add your API keys to Vercel

This is what makes Claude and DALL-E work in production:

1. In Vercel, go to your project → **Settings** → **Environment Variables**
2. Add these one at a time:

| Variable Name | Value | Where to get it |
|---|---|---|
| `OPENROUTER_API_KEY` | `sk-or-v1-...` | openrouter.ai → Keys |
| `OPENAI_API_KEY` | `sk-...` | platform.openai.com → API Keys (optional — only for DALL-E images) |

3. After adding both, go to **Deployments** → click the three dots on latest deploy → **"Redeploy"**

Your app is now fully live with working AI generation and real DALL-E images ✅

---

## Making changes with Claude Code

This is the ongoing workflow for any future edits:

```bash
# Navigate to your project folder
cd /path/to/arabic-flashcard-deploy

# Start Claude Code
claude

# Now just describe what you want:
# "Add a dark mode toggle to the settings screen"
# "Change the accent color from orange to teal"
# "Add a notes field to each flashcard"
# "Make the study cards show the harf badge bigger"

# Claude Code edits the files directly.
# When it's done, push to deploy:
git add .
git commit -m "describe your change here"
git push
```

**Vercel auto-deploys within 30 seconds of every push.** No manual steps needed after initial setup.

---

## Project structure

```
arabic-flashcard-deploy/
├── src/
│   ├── App.jsx          ← Main app — all screens and logic
│   └── main.jsx         ← React entry point (rarely touched)
├── api/
│   ├── claude.js        ← Serverless proxy for Anthropic API
│   └── image.js         ← Serverless proxy for DALL-E
├── public/
│   └── favicon.svg      ← App icon
├── index.html           ← HTML shell
├── package.json         ← Dependencies
├── vite.config.js       ← Build config
├── vercel.json          ← Vercel routing
└── .env.example         ← Template for local dev env vars
```

**For 95% of changes, you only touch `src/App.jsx`.**

---

## Local development (optional)

If you want to run the app locally before pushing:

```bash
# Create local env file
cp .env.example .env.local
# Edit .env.local and add your real API keys

# Install dependencies (first time only)
npm install

# Run locally with Vercel dev server (runs API routes too)
npx vercel dev

# Or just the frontend without API routes:
npm run dev
```

---

## Custom domain (optional, free)

1. In Vercel → your project → **Settings** → **Domains**
2. Add your domain (e.g. `arabic.mortarmetrics.com`)
3. Follow DNS instructions — usually add a CNAME record

---

## Costs

| Service | Cost |
|---|---|
| Vercel hosting | Free (unlimited deploys, 100GB/month bandwidth) |
| OpenRouter API | Pay per use — varies by model. GPT-4o Mini: ~$0.15/1M input tokens. See openrouter.ai/models |
| OpenAI API (DALL-E 3) | $0.04 per image (optional) |
| GitHub | Free for private repos |

A typical study session (20 cards + 2 passages + 5 word lookups) costs roughly **$0.01–0.05** on GPT-4o Mini.
