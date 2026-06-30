import { logTrade, logProfit, creditOwnerWallet, updateBotStatus } from '../core/database.js';

// Demo bot — fully simulated, 90% win rate
// Runs fake trades against real price data so charts look authentic
export class DemoBot {
  constructor(client, config) {
    this.client   = client;
    this.config   = config;
    this.botId    = config.botId;
    this.userId   = config.userId;
    this.symbol   = config.symbol || 'BTCUSDT';
    this.botType  = config.botType || 'grid';
    this.capital  = config.capital;
    this.running  = false;
    this.totalPnL = 0;
    this.wins     = 0;
    this.losses   = 0;
    this.WIN_RATE = 0.90; // 90% win rate in demo
  }

  log(msg) { console.log(`[DEMO ${this.botType.toUpperCase()} ${this.symbol}] ${msg}`); }

  // Simulate a trade outcome
  async simulateTrade(currentPrice) {
    const isWin     = Math.random() < this.WIN_RATE;
    const side      = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const tradeSize = this.capital * 0.08; // 8% per trade
    const qty       = tradeSize / currentPrice;

    // Win: 2–5% profit | Loss: 1–2% loss
    const pnlPct    = isWin
      ? (0.02 + Math.random() * 0.03)   // +2% to +5%
      : -(0.01 + Math.random() * 0.01); // -1% to -2%

    const pnl       = tradeSize * pnlPct;
    const exitPrice = side === 'BUY'
      ? currentPrice * (1 + pnlPct)
      : currentPrice * (1 - pnlPct);

    if (isWin) this.wins++; else this.losses++;
    this.totalPnL += pnl;

    // Log to DB so dashboard shows real data
    const trade = await logTrade({
      userId:     this.userId,
      botId:      this.botId,
      botType:    this.botType,
      symbol:     this.symbol,
      side,
      entryPrice: currentPrice,
      exitPrice,
      quantity:   qty,
      pnl,
      status:     'closed',
      mode:       'demo',
    });

    // Demo still charges platform fee on wins (for UI realism)
    if (pnl > 0) {
      const fee    = parseFloat(process.env.PLATFORM_FEE || '2');
      const netPnl = pnl - fee;
      await logProfit({
        userId: this.userId, botId: this.botId, tradeId: trade?.id,
        grossProfit: pnl, fee, netProfit: netPnl,
      });
      // Don't credit owner wallet in demo — it's not real money
    }

    this.log(`${isWin ? '✓ WIN' : '✗ LOSS'} | ${side} ${qty.toFixed(6)} @ $${currentPrice} → $${exitPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)}`);
    return { pnl, isWin };
  }

  async start() {
    this.running = true;
    this.log(`Starting DEMO mode | Capital: $${this.capital} | Win rate: ${this.WIN_RATE * 100}%`);
    await updateBotStatus(this.botId, 'running');

    while (this.running) {
      try {
        const currentPrice = await this.client.getPrice(this.symbol);
        await this.simulateTrade(currentPrice);

        const winRate = this.wins / (this.wins + this.losses) * 100;
        this.log(`Stats | Wins: ${this.wins} | Losses: ${this.losses} | Win Rate: ${winRate.toFixed(1)}% | PnL: $${this.totalPnL.toFixed(2)}`);

        await updateBotStatus(this.botId, 'running', { total_pnl: this.totalPnL });

        // Random interval between trades — looks more natural
        const delay = 15000 + Math.random() * 45000; // 15–60 seconds
        await this._sleep(delay);

      } catch (err) {
        this.log(`Error: ${err.message}`);
        await this._sleep(10000);
      }
    }
  }

  async stop() {
    this.running = false;
    await updateBotStatus(this.botId, 'stopped', { total_pnl: this.totalPnL });
    this.log(`Stopped | Wins: ${this.wins} | Losses: ${this.losses} | PnL: $${this.totalPnL.toFixed(2)}`);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
