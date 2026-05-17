# Global Conquest — Multiplayer Server

WebSocket server for Global Conquest. Handles room creation, matchmaking, and relaying game state between players.

---

## Deploy on Railway (recommended — free tier, 1-click)

1. Go to https://railway.app and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Push this `server/` folder to a GitHub repo, or use **Deploy from local** with the Railway CLI:
   ```
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```
4. Railway auto-detects `package.json` and runs `npm start`
5. Go to your project → **Settings → Networking → Generate Domain**
6. Copy the URL — it looks like `your-app.up.railway.app`
7. In `code.html`, set:
   ```js
   const WS_SERVER = 'wss://your-app.up.railway.app';
   ```

---

## Deploy on Render (also free)

1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo (push the server folder)
3. Set:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Environment:** Node
4. Click Deploy. Copy the `.onrender.com` URL.
5. In `code.html`, set:
   ```js
   const WS_SERVER = 'wss://your-app.onrender.com';
   ```

> ⚠️ Render free tier spins down after 15 min of inactivity (cold start ~30s).
> Railway free tier stays warm. Recommended for games.

---

## Local development

```bash
npm install
npm start
# Server runs on ws://localhost:8080
```

In `code.html` change `WS_SERVER` to `ws://localhost:8080` for local testing.

---

## Architecture

```
Player (Host)          Server              Player 2 / 3 / 4
     │                    │                       │
     │── create_room ─────▶│                       │
     │◀─ room_created ─────│                       │
     │                    │◀──── join_room ────────│
     │◀─ player_joined ───│──── room_joined ──────▶│
     │── start_game ──────▶│                       │
     │◀─ countdown(5) ─────│──── countdown(5) ────▶│
     │◀─ game_start ───────│──── game_start ───────▶│
     │                    │                       │
     │  [Host runs sim]   │                       │
     │── game_state ──────▶│──── game_state ───────▶│
     │                    │◀─── player_action ─────│
     │◀─ player_action ───│                       │
```

The **host** runs the authoritative game simulation. Other players send
input actions; the host processes them and broadcasts updated state every
~100ms. If the host disconnects, the next connected player is promoted.
