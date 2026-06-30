import { analyzeMarket, calculateRSI } from '../core/indicators.js';
import { RiskManager } from '../core/risk.js';
import { logTrade, logProfit, creditOwnerWallet, updateBotStatus } from '../core/database.js';

export class DCABot {
  constructor(client, config) {
    this.client       = client;
    this.config       = config;
    this.botId        = config.botId;
    this.userId       = config.userId;
    this.symbol       = config.symbol || 'ETHUSDT';
    this.capital      = config.capital;
    this.baseOrderPct = config.baseOrderPct || 0.1;   // 10% per base order
    this.safetyOrders = config.safetyOrders || 4;      // Max 4 DCA buys
    this.safetyPct    = config.safetyPct    || 0.015;  // 1.5% price drop triggers safety
    this.takeProfitPct = config.takeProfitPct || 0.04; // 4% TP
    this.running      = false;
    this.position     = null;   // Current open position
    this.totalPnL     = 0;
    this.risk         = new RiskManager(this.capital);
  }

  log(msg) { console.log(`[DCA ${this.symbol}] ${msg}`); }

  // ── Entry signal — RSI oversold + EMA confirmation ─────────────────────────
  async shouldEnter() {
    const candles  = await this.client.getKlines(this.symbol, '15m', 100);
    const analysis = analyzeMarket(candles);
    const { rsi, ema9, ema21, price } = analysis.indicators;

    // Strong buy: RSI < 35 and price near EMA support
    if (rsi && rsi < 35) {
      this.log(`Entry signal | RSI: ${rsi.toFixed(1)} | Price: $${price}`);
      return { enter: true, price, analysis };
    }

    // Moderate: RSI < 42 with EMA9 above EMA21 (uptrend context)
    if (rsi && rsi < 42 && ema9 && ema21 && ema9 > ema21) {
      this.log(`Moderate entry | RSI: ${rsi.toFixed(1)}`);
      return { enter: true, price, analysis };
    }

    return { enter: false, price, analysis };
  }

  // ── Open base position ─────────────────────────────────────────────────────
  async openPosition(price) {
    const baseAmount = this.capital * this.baseOrderPct;
    const qty = baseAmount / price;
    const minQty = await this.client.getMinQty(this.symbol);
    if (qty < minQty) {
      this.log(`Capital too low for base order. Min qty: ${minQty}`);
      return;
    }

    const order = await this.client.placeMarketOrder(this.symbol, 'BUY', qty);
    const filledPrice = parseFloat(order.fills?.[0]?.price || price);

    this.position = {
      entries:      [{ price: filledPrice, qty, amount: baseAmount }],
      avgPrice:     filledPrice,
      totalQty:     qty,
      totalCost:    baseAmount,
      safetyCount:  0,
      takeProfitPrice: filledPrice * (1 + this.takeProfitPct),
      orderId:      order.orderId,
    };

    const trade = await logTrade({
      userId: this.userId, botId: this.botId, botType: 'dca',
      symbol: this.symbol, side: 'BUY',
      entryPrice: filledPrice, quantity: qty, status: 'open', mode: 'real',
    });

    this.position.tradeId = trade?.id;
    this.log(`Base order: ${qty.toFixed(6)} @ $${filledPrice} | TP: $${this.position.takeProfitPrice.toFixed(2)}`);
  }

  // ── Safety order — DCA down on dip ────────────────────────────────────────
  async placeSafetyOrder(currentPrice) {
    if (!this.position) return;
    if (this.position.safetyCount >= this.safetyOrders) {
      this.log('Max safety orders reached');
      return;
    }

    // Exponential sizing — each safety order is 1.5x the previous
    const safetyMultiplier = Math.pow(1.5, this.position.safetyCount);
    const safetyAmount = (this.capital * this.baseOrderPct) * safetyMultiplier;
    const qty = safetyAmount / currentPrice;
    const minQty = await this.client.getMinQty(this.symbol);
    if (qty < minQty) return;

    const order = await this.client.placeMarketOrder(this.symbol, 'BUY', qty);
    const filledPrice = parseFloat(order.fills?.[0]?.price || currentPrice);

    this.position.entries.push({ price: filledPrice, qty, amount: safetyAmount });
    this.position.totalQty  += qty;
    this.position.totalCost += safetyAmount;
    this.position.avgPrice   = this.position.totalCost / this.position.totalQty;
    this.position.takeProfitPrice = this.position.avgPrice * (1 + this.takeProfitPct);
    this.position.safetyCount++;

    this.log(`Safety #${this.position.safetyCount}: ${qty.toFixed(6)} @ $${filledPrice} | New avg: $${this.position.avgPrice.toFixed(2)} | TP: $${this.position.takeProfitPrice.toFixed(2)}`);
  }

  // ── Close position at take profit ─────────────────────────────────────────
  async closePosition(currentPrice, reason = 'take_profit') {
    if (!this.position) return;

    const order = await this.client.placeMarketOrder(
      this.symbol, 'SELL', this.position.totalQty
    );
    const exitPrice = parseFloat(order.fills?.[0]?.price || currentPrice);
    const pnl       = this.risk.calcPnL('BUY', this.position.avgPrice, exitPrice, this.position.totalQty);
    const fee       = this.risk.calcPlatformFee(pnl);
    const netPnl    = pnl - fee;
    this.totalPnL  += netPnl;

    if (pnl > 0 && fee > 0) {
      await logProfit({
        userId: this.userId, botId: this.botId,
        tradeId: this.position.tradeId,
        grossProfit: pnl, fee, netProfit: netPnl,
      });
      await creditOwnerWallet(fee, this.position.tradeId, this.userId);
    }

    this.log(`CLOSE (${reason}) @ $${exitPrice} | PnL: $${pnl.toFixed(2)} | Fee: $${fee} | Net: $${netPnl.toFixed(2)}`);
    this.position = null;
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async start() {
    this.running = true;
    this.log(`Starting | Capital: $${this.capital}`);
    await updateBotStatus(this.botId, 'running');

    while (this.running) {
      try {
        const currentPrice = await this.client.getPrice(this.symbol);

        if (!this.position) {
          // No open position — look for entry
          const { enter } = await this.shouldEnter();
          if (enter) await this.openPosition(currentPrice);

        } else {
          // Have open position — manage it
          const dropFromAvg = (this.position.avgPrice - currentPrice) / this.position.avgPrice;
          const riseFromAvg = (currentPrice - this.position.avgPrice) / this.position.avgPrice;

          // Take profit
          if (currentPrice >= this.position.takeProfitPrice) {
            await this.closePosition(currentPrice, 'take_profit');

          // Safety order on dip
          } else if (dropFromAvg >= this.safetyPct) {
            await this.placeSafetyOrder(currentPrice);

          // Emergency stop — 20% loss
          } else if (dropFromAvg >= 0.20) {
            this.log('Emergency stop — 20% loss');
            await this.closePosition(currentPrice, 'stop_loss');
          }
        }

        await updateBotStatus(this.botId, 'running', { total_pnl: this.totalPnL });
        await this._sleep(60000); // Check every 60 seconds

      } catch (err) {
        this.log(`Loop error: ${err.message}`);
        await this._sleep(15000);
      }
    }
  }

  async stop() {
    this.running = false;
    if (this.position) {
      const price = await this.client.getPrice(this.symbol);
      await this.closePosition(price, 'manual_stop');
    }
    await updateBotStatus(this.botId, 'stopped', { total_pnl: this.totalPnL });
    this.log(`Stopped | Total PnL: $${this.totalPnL.toFixed(2)}`);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
