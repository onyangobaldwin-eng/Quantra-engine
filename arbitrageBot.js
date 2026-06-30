import { logTrade, logProfit, creditOwnerWallet, updateBotStatus } from '../core/database.js';
import { RiskManager } from '../core/risk.js';

// Triangular arbitrage: BTC → ETH → BNB → BTC (or any valid triangle)
const TRIANGLES = [
  { a: 'BTCUSDT', b: 'ETHBTC',  c: 'ETHUSDT'  },
  { a: 'BTCUSDT', b: 'BNBBTC',  c: 'BNBUSDT'  },
  { a: 'ETHUSDT', b: 'BNBETH',  c: 'BNBUSDT'  },
  { a: 'BTCUSDT', b: 'SOLUSDT', c: 'SOLBTC'   },
];

const BINANCE_FEE  = 0.001; // 0.1% per trade
const MIN_PROFIT   = 0.002; // Only execute if >0.2% profit after fees

export class ArbitrageBot {
  constructor(client, config) {
    this.client   = client;
    this.config   = config;
    this.botId    = config.botId;
    this.userId   = config.userId;
    this.capital  = config.capital;
    this.running  = false;
    this.totalPnL = 0;
    this.scans    = 0;
    this.executed = 0;
    this.risk     = new RiskManager(this.capital);
  }

  log(msg) { console.log(`[ARB] ${msg}`); }

  // ── Scan one triangle for arbitrage opportunity ────────────────────────────
  async scanTriangle(triangle) {
    try {
      const [priceA, priceB, priceC] = await Promise.all([
        this.client.getPrice(triangle.a),
        this.client.getPrice(triangle.b),
        this.client.getPrice(triangle.c),
      ]);

      // Forward path: USDT → BTC → ETH → USDT
      const afterA   = this.capital / priceA;                  // USDT → BTC
      const afterB   = afterA / priceB;                         // BTC → ETH
      const afterC   = afterB * priceC;                         // ETH → USDT

      // Account for fees on all 3 legs
      const netResult = afterC * Math.pow(1 - BINANCE_FEE, 3);
      const profit    = netResult - this.capital;
      const profitPct = profit / this.capital;

      if (profitPct > MIN_PROFIT) {
        return {
          triangle,
          path:      `${triangle.a} → ${triangle.b} → ${triangle.c}`,
          profit,
          profitPct,
          prices:    { a: priceA, b: priceB, c: priceC },
          direction: 'forward',
        };
      }

      // Reverse path: USDT → ETH → BTC → USDT
      const afterC2  = this.capital / priceC;                  // USDT → ETH
      const afterB2  = afterC2 * priceB;                        // ETH → BTC
      const afterA2  = afterB2 * priceA;                        // BTC → USDT
      const netResult2 = afterA2 * Math.pow(1 - BINANCE_FEE, 3);
      const profit2    = netResult2 - this.capital;
      const profitPct2 = profit2 / this.capital;

      if (profitPct2 > MIN_PROFIT) {
        return {
          triangle,
          path:      `${triangle.c} → ${triangle.b} → ${triangle.a}`,
          profit:    profit2,
          profitPct: profitPct2,
          prices:    { a: priceA, b: priceB, c: priceC },
          direction: 'reverse',
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── Execute arbitrage ─────────────────────────────────────────────────────
  async executeArbitrage(opportunity) {
    const { triangle, direction, profit, profitPct, prices } = opportunity;
    this.log(`Executing: ${opportunity.path} | Profit: $${profit.toFixed(4)} (${(profitPct * 100).toFixed(3)}%)`);

    try {
      const tradeCapital = this.capital * 0.9; // Use 90% to leave buffer

      if (direction === 'forward') {
        // Leg 1: Buy BTC with USDT
        const btcQty = tradeCapital / prices.a;
        await this.client.placeMarketOrder(triangle.a, 'BUY', btcQty);
        await this._sleep(200);

        // Leg 2: Buy ETH with BTC
        const ethQty = btcQty / prices.b;
        await this.client.placeMarketOrder(triangle.b, 'BUY', ethQty);
        await this._sleep(200);

        // Leg 3: Sell ETH for USDT
        await this.client.placeMarketOrder(triangle.c, 'SELL', ethQty);

      } else {
        // Reverse path
        const ethQty = tradeCapital / prices.c;
        await this.client.placeMarketOrder(triangle.c, 'BUY', ethQty);
        await this._sleep(200);

        const btcQty = ethQty * prices.b;
        await this.client.placeMarketOrder(triangle.b, 'SELL', btcQty);
        await this._sleep(200);

        await this.client.placeMarketOrder(triangle.a, 'SELL', btcQty);
      }

      const fee    = this.risk.calcPlatformFee(profit);
      const netPnl = profit - fee;
      this.totalPnL += netPnl;
      this.executed++;

      const trade = await logTrade({
        userId: this.userId, botId: this.botId, botType: 'arbitrage',
        symbol: opportunity.path, side: 'ARB',
        entryPrice: this.capital, exitPrice: this.capital + profit,
        quantity: 1, pnl: netPnl, status: 'closed', mode: 'real',
      });

      if (profit > 0 && fee > 0) {
        await logProfit({
          userId: this.userId, botId: this.botId, tradeId: trade?.id,
          grossProfit: profit, fee, netProfit: netPnl,
        });
        await creditOwnerWallet(fee, trade?.id, this.userId);
      }

      this.log(`✓ Executed | Net PnL: $${netPnl.toFixed(4)}`);

    } catch (err) {
      this.log(`Execution failed: ${err.message}`);
    }
  }

  // ── Main loop — scan all triangles continuously ────────────────────────────
  async start() {
    this.running = true;
    this.log(`Starting | Capital: $${this.capital} | Triangles: ${TRIANGLES.length}`);
    await updateBotStatus(this.botId, 'running');

    while (this.running) {
      try {
        // Scan all triangles in parallel
        const results = await Promise.all(TRIANGLES.map(t => this.scanTriangle(t)));
        const opportunities = results.filter(Boolean);
        this.scans++;

        if (opportunities.length > 0) {
          // Take the best opportunity
          const best = opportunities.sort((a, b) => b.profitPct - a.profitPct)[0];
          await this.executeArbitrage(best);
        }

        if (this.scans % 100 === 0) {
          this.log(`Scans: ${this.scans} | Executed: ${this.executed} | PnL: $${this.totalPnL.toFixed(4)}`);
          await updateBotStatus(this.botId, 'running', { total_pnl: this.totalPnL });
        }

        await this._sleep(3000); // Scan every 3 seconds

      } catch (err) {
        this.log(`Scan error: ${err.message}`);
        await this._sleep(5000);
      }
    }
  }

  async stop() {
    this.running = false;
    await updateBotStatus(this.botId, 'stopped', { total_pnl: this.totalPnL });
    this.log(`Stopped | Scans: ${this.scans} | Executed: ${this.executed} | PnL: $${this.totalPnL.toFixed(4)}`);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
