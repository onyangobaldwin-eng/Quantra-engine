import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Trade Logging ─────────────────────────────────────────────────────────────
export async function logTrade({
  userId, botId, botType, symbol, side,
  entryPrice, exitPrice, quantity, pnl,
  status, exchange = 'binance', mode = 'real'
}) {
  const { data, error } = await sb.from('trades').insert({
    user_id:     userId,
    bot_id:      botId,
    bot_type:    botType,
    symbol,
    side,
    entry_price: entryPrice,
    exit_price:  exitPrice,
    quantity,
    pnl,
    status,       // open | closed | stopped
    exchange,
    mode,         // real | demo
    created_at:   new Date().toISOString(),
  }).select().single();
  if (error) console.error('[DB] logTrade error:', error.message);
  return data;
}

export async function updateTrade(tradeId, updates) {
  const { error } = await sb.from('trades').update({
    ...updates,
    updated_at: new Date().toISOString(),
  }).eq('id', tradeId);
  if (error) console.error('[DB] updateTrade error:', error.message);
}

// ── Profit & Fee Tracking ─────────────────────────────────────────────────────
export async function logProfit({ userId, botId, tradeId, grossProfit, fee, netProfit }) {
  const { error } = await sb.from('profits').insert({
    user_id:      userId,
    bot_id:       botId,
    trade_id:     tradeId,
    gross_profit: grossProfit,
    platform_fee: fee,
    net_profit:   netProfit,
    settled:      false,
    created_at:   new Date().toISOString(),
  });
  if (error) console.error('[DB] logProfit error:', error.message);
}

// ── Owner Wallet ──────────────────────────────────────────────────────────────
export async function creditOwnerWallet(amount, tradeId, userId) {
  // Upsert owner wallet row (single row, id = 'owner')
  const { data: current } = await sb
    .from('owner_wallet')
    .select('balance')
    .eq('id', 'owner')
    .single();

  const newBalance = (current?.balance || 0) + amount;

  await sb.from('owner_wallet').upsert({
    id:         'owner',
    balance:    newBalance,
    updated_at: new Date().toISOString(),
  });

  // Log the fee transaction
  await sb.from('fee_transactions').insert({
    trade_id:   tradeId,
    user_id:    userId,
    amount,
    created_at: new Date().toISOString(),
  });

  console.log(`[WALLET] +$${amount} fee credited. Total: $${newBalance.toFixed(2)}`);
}

// ── User Capital Tracking ─────────────────────────────────────────────────────
export async function getUserCapital(userId) {
  const { data } = await sb
    .from('user_capital')
    .select('*')
    .eq('user_id', userId)
    .single();
  return data;
}

export async function updateUserCapital(userId, updates) {
  await sb.from('user_capital').upsert({
    user_id:    userId,
    ...updates,
    updated_at: new Date().toISOString(),
  });
}

// ── Bot Config ────────────────────────────────────────────────────────────────
export async function getActiveBots() {
  const { data, error } = await sb
    .from('bots')
    .select('*, users(binance_api_key, binance_secret_key)')
    .eq('status', 'running');
  if (error) console.error('[DB] getActiveBots error:', error.message);
  return data || [];
}

export async function updateBotStatus(botId, status, stats = {}) {
  await sb.from('bots').update({
    status,
    ...stats,
    updated_at: new Date().toISOString(),
  }).eq('id', botId);
}

// ── Pending Withdrawals ───────────────────────────────────────────────────────
export async function getPendingWithdrawals() {
  const { data } = await sb
    .from('withdrawals')
    .select('*')
    .eq('status', 'pending');
  return data || [];
}

export async function processWithdrawal(withdrawalId, fee) {
  await sb.from('withdrawals').update({
    status:       'processed',
    platform_fee: fee,
    processed_at: new Date().toISOString(),
  }).eq('id', withdrawalId);
}

export { sb };
