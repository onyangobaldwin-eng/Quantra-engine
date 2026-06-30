import 'dotenv/config';
import http       from 'http';
import { BotManager } from './bots/botManager.js';
import { sb }         from './core/database.js';

const manager = new BotManager();
const PORT    = process.env.PORT || 3000;

// ── Simple JSON response helper ────────────────────────────────────────────
function respond(res, status, data) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') return respond(res, 200, {});

  try {
    // ── Health check ──────────────────────────────────────────────────────
    if (path === '/health' && method === 'GET') {
      return respond(res, 200, {
        status:   'running',
        bots:     manager.status(),
        uptime:   process.uptime(),
        time:     new Date().toISOString(),
      });
    }

    // ── Start a bot ───────────────────────────────────────────────────────
    if (path === '/bots/start' && method === 'POST') {
      const body = await parseBody(req);
      const { botId, userId, botType, symbol, capital, mode, apiKey, secretKey } = body;

      if (!botId || !userId || !botType || !capital) {
        return respond(res, 400, { error: 'Missing required fields: botId, userId, botType, capital' });
      }
      if (capital < parseFloat(process.env.MIN_TRADING_CAPITAL || '30')) {
        return respond(res, 400, { error: `Minimum capital is $${process.env.MIN_TRADING_CAPITAL || 30}` });
      }
      if (mode !== 'demo' && (!apiKey || !secretKey)) {
        return respond(res, 400, { error: 'API key and secret required for real trading' });
      }

      await manager.spawnBot({ botId, userId, botType, symbol, capital, mode, apiKey, secretKey });
      return respond(res, 200, { success: true, message: `Bot ${botId} started` });
    }

    // ── Stop a bot ────────────────────────────────────────────────────────
    if (path.startsWith('/bots/stop/') && method === 'DELETE') {
      const botId = path.split('/')[3];
      await manager.stopBot(botId);
      return respond(res, 200, { success: true, message: `Bot ${botId} stopped` });
    }

    // ── List running bots ─────────────────────────────────────────────────
    if (path === '/bots' && method === 'GET') {
      return respond(res, 200, manager.status());
    }

    // ── Owner wallet balance ──────────────────────────────────────────────
    if (path === '/wallet' && method === 'GET') {
      const { data } = await sb.from('owner_wallet').select('balance').eq('id', 'owner').single();
      return respond(res, 200, { balance: data?.balance || 0 });
    }

    // ── Pending withdrawals (process $2 fee) ──────────────────────────────
    if (path === '/withdrawals/process' && method === 'POST') {
      const body = await parseBody(req);
      const { withdrawalId, userId, amount } = body;

      // Get user's accumulated profits
      const { data: profits } = await sb
        .from('profits')
        .select('net_profit')
        .eq('user_id', userId)
        .eq('settled', false);

      const totalProfit = profits?.reduce((a, b) => a + b.net_profit, 0) || 0;
      const fee = parseFloat(process.env.PLATFORM_FEE || '2');

      if (totalProfit < fee) {
        return respond(res, 400, { error: 'Insufficient profit to cover platform fee' });
      }

      const netWithdrawal = amount - fee;

      // Mark profits as settled
      await sb.from('profits').update({ settled: true }).eq('user_id', userId).eq('settled', false);

      // Credit owner wallet
      const { data: wallet } = await sb.from('owner_wallet').select('balance').eq('id', 'owner').single();
      await sb.from('owner_wallet').upsert({ id: 'owner', balance: (wallet?.balance || 0) + fee });

      return respond(res, 200, {
        success:        true,
        grossAmount:    amount,
        platformFee:    fee,
        netWithdrawal,
        message:        `Withdrawal processed. $${fee} platform fee deducted.`,
      });
    }

    respond(res, 404, { error: 'Route not found' });

  } catch (err) {
    console.error('[SERVER ERROR]', err.message);
    respond(res, 500, { error: err.message });
  }
});

// ── Startup ────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════╗
║   QUANTRA Engine v1.0 — RUNNING       ║
║   Port: ${PORT}                           ║
║   Testnet: ${process.env.BINANCE_TESTNET === 'true' ? 'YES' : 'NO (LIVE)'}                    ║
╚═══════════════════════════════════════╝
  `);

  // Resume any bots that were running before restart
  await manager.loadFromDB();
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await manager.stopAll();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await manager.stopAll();
  process.exit(0);
});
