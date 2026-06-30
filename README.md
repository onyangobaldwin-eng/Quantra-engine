# QUANTRA Engine — Setup & Deploy

## Project Structure
```
src/
├── index.js              ← HTTP server + API routes
├── core/
│   ├── binance.js        ← Binance REST + WebSocket client
│   ├── indicators.js     ← RSI, EMA, Bollinger Bands, MACD, ATR
│   ├── risk.js           ← Position sizing, stop loss, take profit
│   └── database.js       ← Supabase trade logging + fee ledger
└── bots/
    ├── botManager.js     ← Spawns and manages all bots
    ├── gridBot.js        ← Grid trading bot
    ├── dcaBot.js         ← DCA accumulation bot
    ├── momentumBot.js    ← EMA crossover momentum bot
    ├── arbitrageBot.js   ← Triangular arbitrage bot
    └── demoBot.js        ← Simulated 90% win rate demo bot
```

---

## Step 1 — Supabase Setup

1. Go to your Supabase project → **SQL Editor**
2. Paste the entire contents of `schema.sql`
3. Click **Run**
4. All tables, policies, and indexes are created

---

## Step 2 — Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
BINANCE_API_KEY=your_testnet_api_key
BINANCE_SECRET_KEY=your_testnet_secret_key
BINANCE_TESTNET=true

SUPABASE_URL=https://lksaoedypnxhvxkvcpaz.supabase.co
SUPABASE_ANON_KEY=your_anon_key

MIN_TRADING_CAPITAL=30
PLATFORM_FEE=2
PORT=3000
```

---

## Step 3 — Local Test

```bash
npm install
npm run dev
```

Visit `http://localhost:3000/health` — should return running status.

**Start a demo bot:**
```bash
curl -X POST http://localhost:3000/bots/start \
  -H "Content-Type: application/json" \
  -d '{
    "botId": "test-001",
    "userId": "your-supabase-user-id",
    "botType": "grid",
    "symbol": "BTCUSDT",
    "capital": 100,
    "mode": "demo"
  }'
```

---

## Step 4 — Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select the repo
4. Go to **Variables** → add all env vars from `.env`
5. Railway auto-deploys and gives you a public URL

Your engine URL will look like:
`https://quantra-engine-production.up.railway.app`

---

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/health` | Engine status + running bots |
| GET | `/bots` | List all active bots |
| POST | `/bots/start` | Start a new bot |
| DELETE | `/bots/stop/:botId` | Stop a specific bot |
| GET | `/wallet` | Owner wallet balance |
| POST | `/withdrawals/process` | Process user withdrawal + deduct $2 fee |

---

## Bot Types

| Bot | Best For | Strategy |
|-----|----------|----------|
| `grid` | Sideways markets | Bollinger Band range + limit orders |
| `dca` | Accumulation | RSI oversold entries + safety orders |
| `momentum` | Trending markets | EMA9/21 crossover + trailing stop |
| `arbitrage` | Any market | Triangular arbitrage across pairs |
| `demo` (any type) | New users | Simulated 90% win rate |

---

## Switching to Live Trading

1. Change `BINANCE_TESTNET=false` in Railway env vars
2. Update `BINANCE_API_KEY` and `BINANCE_SECRET_KEY` to real Binance keys
3. Redeploy

⚠️ Test thoroughly on testnet before going live. Real money is at stake.
