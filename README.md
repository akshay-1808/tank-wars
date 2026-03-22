# 🎮 Tank Wars — Online Multiplayer

Play with anyone, anywhere in the world. No LAN needed.

---

## 🚀 Deploy to Railway (Free)

### Step 1 — Create a GitHub repo

```bash
# Inside your tank-wars folder:
git init
git add .
git commit -m "Tank Wars initial commit"
```

Then go to https://github.com/new and create a **new public repo** called `tank-wars`.

```bash
git remote add origin https://github.com/YOUR_USERNAME/tank-wars.git
git branch -M main
git push -u origin main
```

---

### Step 2 — Deploy on Railway

1. Go to **https://railway.app** and sign in with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `tank-wars` repo
4. Railway auto-detects Node.js and deploys it
5. Click **"Settings"** → **"Networking"** → **"Generate Domain"**
6. You'll get a URL like `tank-wars-production.up.railway.app`

That's it — your game is live! 🎉

---

### Step 3 — Play

- Open your Railway URL in any browser
- Click **CREATE LOBBY** → share the **4-digit ID** with friends
- Friends open the same URL, enter the ID, click **JOIN LOBBY**
- Admin clicks **▶ START GAME**

---

## 🕹️ Controls

| Key | Action |
|-----|--------|
| `W A S D` | Move |
| `Mouse` | Aim |
| `Hold Left Click` | Fire |

## 🎁 Power-ups

| Icon | Effect |
|------|--------|
| 🛡️ Shield | Immune to bullets for 6s |
| ⚡ Rapid Fire | 2× fire rate for 6s |
| 💥 Spread | Triple shot for 6s |
| ❤️ HP | +40 health |

## ⏱️ Rules
- 10 minute rounds
- Kill = +100 pts, Power-up = +10 pts
- 3 second spawn protection after respawn
- Highest score when timer ends wins

---

## 💻 Run Locally

```bash
npm install
node server.js
# Open http://localhost:3000
```
