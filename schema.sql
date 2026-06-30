-- ── QUANTRA Database Schema ──────────────────────────────────────────────────
-- Run this in Supabase → SQL Editor

-- Users table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.users (
  id                UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name         TEXT,
  binance_api_key   TEXT,      -- Encrypted in production
  binance_secret_key TEXT,     -- Encrypted in production
  capital           NUMERIC DEFAULT 0,
  mode              TEXT DEFAULT 'demo',  -- demo | real
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Bots table
CREATE TABLE IF NOT EXISTS public.bots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES public.users(id) ON DELETE CASCADE,
  bot_type    TEXT NOT NULL,   -- grid | dca | momentum | arbitrage
  symbol      TEXT NOT NULL,
  capital     NUMERIC NOT NULL,
  status      TEXT DEFAULT 'stopped',  -- running | stopped | error | paused
  mode        TEXT DEFAULT 'demo',
  total_pnl   NUMERIC DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Trades table
CREATE TABLE IF NOT EXISTS public.trades (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES public.users(id) ON DELETE CASCADE,
  bot_id      UUID REFERENCES public.bots(id) ON DELETE CASCADE,
  bot_type    TEXT,
  symbol      TEXT,
  side        TEXT,            -- BUY | SELL | ARB
  entry_price NUMERIC,
  exit_price  NUMERIC,
  quantity    NUMERIC,
  pnl         NUMERIC DEFAULT 0,
  status      TEXT,            -- open | closed | stopped
  exchange    TEXT DEFAULT 'binance',
  mode        TEXT DEFAULT 'real',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Profits table
CREATE TABLE IF NOT EXISTS public.profits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES public.users(id) ON DELETE CASCADE,
  bot_id        UUID REFERENCES public.bots(id) ON DELETE CASCADE,
  trade_id      UUID REFERENCES public.trades(id) ON DELETE SET NULL,
  gross_profit  NUMERIC,
  platform_fee  NUMERIC DEFAULT 2,
  net_profit    NUMERIC,
  settled       BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Owner wallet (single row)
CREATE TABLE IF NOT EXISTS public.owner_wallet (
  id          TEXT PRIMARY KEY DEFAULT 'owner',
  balance     NUMERIC DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Fee transactions log
CREATE TABLE IF NOT EXISTS public.fee_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id    UUID,
  user_id     UUID,
  amount      NUMERIC,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- User capital tracking
CREATE TABLE IF NOT EXISTS public.user_capital (
  user_id     UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  total       NUMERIC DEFAULT 0,
  deployed    NUMERIC DEFAULT 0,
  available   NUMERIC DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Withdrawals
CREATE TABLE IF NOT EXISTS public.withdrawals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES public.users(id) ON DELETE CASCADE,
  amount        NUMERIC,
  platform_fee  NUMERIC DEFAULT 2,
  net_amount    NUMERIC,
  status        TEXT DEFAULT 'pending',  -- pending | processed | rejected
  requested_at  TIMESTAMPTZ DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

-- ── Row Level Security ─────────────────────────────────────────────────────
ALTER TABLE public.users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bots        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profits     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_capital ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawals ENABLE ROW LEVEL SECURITY;

-- Users can only see their own data
CREATE POLICY "users_own_data"    ON public.users        FOR ALL USING (auth.uid() = id);
CREATE POLICY "bots_own_data"     ON public.bots         FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "trades_own_data"   ON public.trades       FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "profits_own_data"  ON public.profits      FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "capital_own_data"  ON public.user_capital FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "withdrawals_own"   ON public.withdrawals  FOR ALL USING (auth.uid() = user_id);

-- Owner wallet is private (no public policy)
-- Access only via service role key on backend

-- ── Insert default owner wallet row ───────────────────────────────────────
INSERT INTO public.owner_wallet (id, balance) VALUES ('owner', 0)
ON CONFLICT (id) DO NOTHING;

-- ── Indexes for performance ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trades_user_id  ON public.trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_bot_id   ON public.trades(bot_id);
CREATE INDEX IF NOT EXISTS idx_profits_user_id ON public.profits(user_id);
CREATE INDEX IF NOT EXISTS idx_bots_status     ON public.bots(status);
CREATE INDEX IF NOT EXISTS idx_bots_user_id    ON public.bots(user_id);
