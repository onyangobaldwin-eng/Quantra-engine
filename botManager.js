import { BinanceClient } from '../core/binance.js';
import { GridBot }       from './gridBot.js';
import { DCABot }        from './dcaBot.js';
import { MomentumBot }   from './momentumBot.js';
import { ArbitrageBot }  from './arbitrageBot.js';
import { DemoBot }       from './demoBot.js';
import { getActiveBots, updateBotStatus } from '../core/database.js';

// Default pairs per bot type
const DEFAULT_PAIRS = {
  grid:      ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT'],
  dca:       ['ETHUSDT', 'BTCUSDT', 'SOLUSDT',  'BNBUSDT', 'XRPUSDT'],
  momentum:  ['SOLUSDT', 'BTCUSDT', 'ETHUSDT',  'AVAXUSDT','DOTUSDT'],
  arbitrage: ['BTCUSDT'],
};

export class BotManager {
  constructor() {
    this.activeBots = new Map(); // botId → { instance, config }
  }

  log(msg) { console.log(`[MANAGER] ${msg}`); }

  // ── Spawn a bot ────────────────────────────────────────────────────────────
  async spawnBot(botConfig) {
    const { botId, userId, botType, symbol, capital, mode,
            apiKey, secretKey } = botConfig;

    if (this.activeBots.has(botId)) {
      this.log(`Bot ${botId} already running`);
      return;
    }

    const isDemo  = mode === 'demo';
    const client  = new BinanceClient(
      isDemo ? process.env.BINANCE_API_KEY    : apiKey,
      isDemo ? process.env.BINANCE_SECRET_KEY : secretKey,
      process.env.BINANCE_TESTNET === 'true'
    );

    const config = { botId, userId, symbol, capital };
    let bot;

    if (isDemo) {
      bot = new DemoBot(client, { ...config, botType });
    } else {
      switch (botType) {
        case 'grid':      bot = new GridBot(client, config);      break;
        case 'dca':       bot = new DCABot(client, config);       break;
        case 'momentum':  bot = new MomentumBot(client, config);  break;
        case 'arbitrage': bot = new ArbitrageBot(client, config); break;
        default:
          this.log(`Unknown bot type: ${botType}`);
          return;
      }
    }

    this.activeBots.set(botId, { bot, config: botConfig });
    this.log(`Spawning ${isDemo ? '[DEMO]' : '[REAL]'} ${botType.toUpperCase()} | ${symbol} | $${capital} | User: ${userId}`);

    // Run in background — don't await
    bot.start().catch(err => {
      this.log(`Bot ${botId} crashed: ${err.message}`);
      this.activeBots.delete(botId);
      updateBotStatus(botId, 'error');
    });
  }

  // ── Stop a bot ─────────────────────────────────────────────────────────────
  async stopBot(botId) {
    const entry = this.activeBots.get(botId);
    if (!entry) { this.log(`Bot ${botId} not found`); return; }
    await entry.bot.stop();
    this.activeBots.delete(botId);
    this.log(`Bot ${botId} stopped`);
  }

  // ── Stop all bots ──────────────────────────────────────────────────────────
  async stopAll() {
    this.log(`Stopping ${this.activeBots.size} bots...`);
    await Promise.all([...this.activeBots.keys()].map(id => this.stopBot(id)));
  }

  // ── Load and resume bots from DB on startup ────────────────────────────────
  async loadFromDB() {
    this.log('Loading active bots from database...');
    const bots = await getActiveBots();
    this.log(`Found ${bots.length} bots to resume`);

    for (const bot of bots) {
      await this.spawnBot({
        botId:     bot.id,
        userId:    bot.user_id,
        botType:   bot.bot_type,
        symbol:    bot.symbol,
        capital:   bot.capital,
        mode:      bot.mode,
        apiKey:    bot.users?.binance_api_key,
        secretKey: bot.users?.binance_secret_key,
      });
      await new Promise(r => setTimeout(r, 500)); // Stagger startup
    }
  }

  status() {
    return {
      total:   this.activeBots.size,
      running: [...this.activeBots.values()].map(e => ({
        botId:   e.config.botId,
        type:    e.config.botType,
        symbol:  e.config.symbol,
        capital: e.config.capital,
        mode:    e.config.mode,
      })),
    };
  }
}
