import { analyzeMarket } from '../core/indicators.js';
import { RiskManager }   from '../core/risk.js';
import { logTrade, logProfit, creditOwnerWallet, updateBotStatus } from '../core/database.js';

export class MomentumBot {
  constructor(client, config) {
    this.client   = client;
    this.config   = config;
    this.botId    = config.botId;
    this.userId   = config.userId;
    this.symbol   = config.symbol || 'SOLUSDT';
    this.capital  = config.capital;
    this.running  = false;
    this.position = null;
    this.totalPnL = 0;
    this.lastSignal = null;
    this.risk     = new RiskManager(this.capital, {
      maxRiskPct:     0.04,
      stopLossPct:    0.02,
      takeProfitPct:  0.06,
    });
  }

  log(msg) { console.log(`[MOMENTUM ${this.symbol}] ${msg}`); }

  // ── Signal detection — EMA cross + volume + RSI confluence ────────────────
  async getSignal() {
    const candles  = await this.client.getKlines(this.symbol, '15m', 100);
    const analysis = analyzeMarket(candles);
    const { signal, confidence, indicators } = analysis;
    const { rsi, ema9, ema21, atr, price, volSpike } = indicators;

    // Require high confidence — don't trade weak signals
    if (confidence < 65) return { signal: 'HOLD', price, confidence };

    // Long signal: EMA9 crosses above EMA21, RSI not overbought, volume confirms
    if (signal === 'BUY' && ema9 > ema21 && rsi < 65) {
      if (volSpike || confidence >= 75) {
        return { signal: 'BUY', price, confidence, atr };
      }
    }

    // Short signal: EMA9 crosses below EMA21, RSI not oversold
    if (signal === 'SELL' && ema9 < ema21 && rsi > 35) {
      if (volSpike || confidence >= 75) {
        return { signal: 'SELL', price, confidence, atr };
      }
    }

    return { signal: 'HOLD', price, confidence };
  }

  // ── Open long or short ────────────────────────────────────────────────────
  async openPosition(side, price, atr) {
    const qty    = this.risk.getPositionSize(price);
    const sl     = this.risk.getStopLoss(price, side, atr);
    const tp     = this.risk.getTakeProfit(price, side, atr);
    const minQty = await this.client.getMinQty(this.symbol);
    if (qty < minQty) return;

    const order = await this.client.placeMarketOrder(this.symbol, side, qty);
    const filled = parseFloat(order.fills?.[0]?.price || price);

    this.position = {
      side, qty, entryPrice: filled,
      stopLoss:   sl,
      takeProfit: tp,
      highWater:  filled,   // For trailing stop
    };

    const trade = await logTrade({
      userId: this.userId, botId: this.botId, botType: 'momentum',
      symbol: this.symbol, side,
      entryPrice: filled, quantity: qty, status: 'open', mode: 'real',
    });
    this.position.tradeId = trade?.id;

    this.log(`OPEN ${side} @ $${filled} | SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)} | Qty: ${qty.toFixed(6)}`);
  }

  // ── Manage open position with trailing stop ───────────────────────────────
  async managePosition(currentPrice) {
    if (!this.position) return;
    const { side, entryPrice, qty, stopLoss, takeProfit } = this.position;

    // Update trailing stop
    if (side === 'BUY' && currentPrice > this.position.highWater) {
      this.position.highWater = currentPrice;
      // Trail stop up at 1.5% below high
      this.position.stopLoss = currentPrice * 0.985;
    }

    // Take profit hit
    if (side === 'BUY'  && currentPrice >= takeProfit) return this.closePosition(currentPrice, 'take_profit');
    if (side === 'SELL' && currentPrice <= takeProfit) return this.closePosition(currentPrice, 'take_profit');

    // Stop loss hit
    if (side === 'BUY'  && currentPrice <= this.position.stopLoss) return this.closePosition(currentPrice, 'stop_loss');
    if (side === 'SELL' && currentPrice >= this.position.stopLoss) return this.closePosition(currentPrice, 'stop_loss');

    // Signal reversal — exit if momentum flips
    const { signal } = await this.getSignal();
    if (side === 'BUY'  && signal === 'SELL') return this.closePosition(currentPrice, 'signal_reversal');
    if (side === 'SELL' && signal === 'BUY')  return this.closePosition(currentPrice, 'signal_reversal');
  }

  async closePosition(currentPrice, reason) {
    if (!this.position) return;
    const { side, entryPrice, qty } = this.position;
    const exitSide = side === 'BUY' ? 'SELL' : 'BUY';

    const order    = await this.client.placeMarketOrder(this.symbol, exitSide, qty);
    const exitPrice = parseFloat(order.fills?.[0]?.price || currentPrice);
    const pnl      = this.risk.calcPnL(side, entryPrice, exitPrice, qty);
    const fee      = this.risk.calcPlatformFee(pnl);
    const netPnl   = pnl - fee;
    this.totalPnL += netPnl;

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
          const { signal, price, confidence, atr } = await this.getSignal();
          if (signal !== 'HOLD') {
            this.log(`Signal: ${signal} @ $${price} | Confidence: ${confidence}%`);
            await this.openPosition(signal, price, atr);
          }
        } else {
          await this.managePosition(currentPrice);
        }

        await updateBotStatus(this.botId, 'running', { total_pnl: this.totalPnL });
        await this._sleep(30000); // Check every 30 seconds

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
