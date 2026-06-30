import { analyzeMarket } from '../core/indicators.js';
import { RiskManager }   from '../core/risk.js';
import { logTrade, updateTrade, logProfit, creditOwnerWallet, updateBotStatus } from '../core/database.js';

export class GridBot {
  constructor(client, config) {
    this.client   = client;
    this.config   = config;
    this.botId    = config.botId;
    this.userId   = config.userId;
    this.symbol   = config.symbol || 'BTCUSDT';
    this.capital  = config.capital;
    this.gridLevels = config.gridLevels || 8;
    this.running  = false;
    this.grids    = [];       // Active grid orders
    this.trades   = [];       // Open positions
    this.totalPnL = 0;
    this.risk     = new RiskManager(this.capital, {
      stopLossPct:    0.03,
      takeProfitPct:  0.03,
    });
  }

  log(msg) { console.log(`[GRID ${this.symbol}] ${msg}`); }

  // ── Setup grid levels ──────────────────────────────────────────────────────
  async setupGrid() {
    const candles = await this.client.getKlines(this.symbol, '1h', 100);
    const analysis = analyzeMarket(candles);
    const price   = analysis.indicators.price;
    const bb      = analysis.indicators.bb;

    // Use Bollinger Bands to define grid range
    const rangeHigh = bb ? bb.upper : price * 1.06;
    const rangeLow  = bb ? bb.lower : price * 0.94;
    const step      = (rangeHigh - rangeLow) / this.gridLevels;

    this.grids = [];
    for (let i = 0; i <= this.gridLevels; i++) {
      this.grids.push({
        price:     parseFloat((rangeLow + step * i).toFixed(2)),
        hasBuy:    false,
        hasSell:   false,
        orderId:   null,
      });
    }

    this.log(`Grid set: $${rangeLow.toFixed(2)} → $${rangeHigh.toFixed(2)} | ${this.gridLevels} levels`);
    return { price, rangeHigh, rangeLow, step };
  }

  // ── Place initial grid orders ──────────────────────────────────────────────
  async placeGridOrders(currentPrice) {
    const capitalPerGrid = (this.capital / this.gridLevels) * 0.9; // 90% deployed

    for (const grid of this.grids) {
      try {
        const qty = capitalPerGrid / grid.price;
        const minQty = await this.client.getMinQty(this.symbol);
        if (qty < minQty) continue;

        if (grid.price < currentPrice && !grid.hasBuy) {
          // Place buy limit below current price
          const order = await this.client.placeLimitOrder(this.symbol, 'BUY', qty, grid.price);
          grid.hasBuy  = true;
          grid.orderId = order.orderId;
          this.log(`BUY limit @ $${grid.price} qty:${qty.toFixed(6)}`);
        } else if (grid.price > currentPrice && !grid.hasSell) {
          // Place sell limit above current price
          const order = await this.client.placeLimitOrder(this.symbol, 'SELL', qty, grid.price);
          grid.hasSell = true;
          grid.orderId = order.orderId;
          this.log(`SELL limit @ $${grid.price} qty:${qty.toFixed(6)}`);
        }

        await this._sleep(200); // Rate limit
      } catch (err) {
        this.log(`Order error at $${grid.price}: ${err.message}`);
      }
    }
  }

  // ── Monitor filled orders ──────────────────────────────────────────────────
  async checkFilledOrders() {
    for (const grid of this.grids) {
      if (!grid.orderId) continue;
      try {
        const order = await this.client.getOrder(this.symbol, grid.orderId);
        if (order.status === 'FILLED') {
          await this._handleFilledOrder(grid, order);
        }
      } catch (err) {
        // Order may not exist yet
      }
    }
  }

  async _handleFilledOrder(grid, order) {
    const side     = order.side;
    const price    = parseFloat(order.price);
    const qty      = parseFloat(order.executedQty);
    const step     = (this.grids[1]?.price - this.grids[0]?.price) || price * 0.01;

    this.log(`✓ ${side} filled @ $${price}`);

    // Log to DB
    const trade = await logTrade({
      userId:     this.userId,
      botId:      this.botId,
      botType:    'grid',
      symbol:     this.symbol,
      side,
      entryPrice: price,
      quantity:   qty,
      status:     'closed',
      mode:       'real',
    });

    // Calculate grid profit (spread between buy and sell)
    if (side === 'SELL') {
      const buyPrice  = price - step;
      const pnl       = this.risk.calcPnL('BUY', buyPrice, price, qty);
      const fee       = this.risk.calcPlatformFee(pnl);
      const netPnl    = pnl - fee;
      this.totalPnL  += netPnl;

      if (pnl > 0 && fee > 0) {
        await logProfit({ userId: this.userId, botId: this.botId, tradeId: trade?.id, grossProfit: pnl, fee, netProfit: netPnl });
        await creditOwnerWallet(fee, trade?.id, this.userId);
      }

      this.log(`PnL: $${pnl.toFixed(2)} | Fee: $${fee} | Net: $${netPnl.toFixed(2)}`);
    }

    // Replace filled order with new one on opposite side
    grid.orderId = null;
    grid.hasBuy  = false;
    grid.hasSell = false;
    await this._sleep(500);

    const currentPrice = await this.client.getPrice(this.symbol);
    const capitalPerGrid = (this.capital / this.gridLevels) * 0.9;
    const newQty = capitalPerGrid / grid.price;
    const minQty = await this.client.getMinQty(this.symbol);
    if (newQty < minQty) return;

    if (side === 'BUY') {
      // Place sell above
      const sellPrice = price + step;
      const order = await this.client.placeLimitOrder(this.symbol, 'SELL', newQty, sellPrice);
      grid.hasSell = true;
      grid.orderId = order.orderId;
    } else {
      // Place buy below
      const buyPrice = price - step;
      if (buyPrice > 0) {
        const order = await this.client.placeLimitOrder(this.symbol, 'BUY', newQty, buyPrice);
        grid.hasBuy  = true;
        grid.orderId = order.orderId;
      }
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async start() {
    this.running = true;
    this.log(`Starting | Capital: $${this.capital} | Levels: ${this.gridLevels}`);

    await updateBotStatus(this.botId, 'running');
    const { price } = await this.setupGrid();
    await this.placeGridOrders(price);

    let iteration = 0;
    while (this.running) {
      try {
        await this.checkFilledOrders();
        iteration++;

        // Re-analyze every 30 mins — rebuild grid if market shifted
        if (iteration % 60 === 0) {
          this.log('Re-evaluating grid range...');
          const currentPrice = await this.client.getPrice(this.symbol);
          const allOutside = this.grids.every(g =>
            currentPrice > g.price * 1.1 || currentPrice < g.price * 0.9
          );
          if (allOutside) {
            this.log('Price outside grid — rebuilding...');
            await this.setupGrid();
            await this.placeGridOrders(currentPrice);
          }
        }

        await updateBotStatus(this.botId, 'running', { total_pnl: this.totalPnL });
        await this._sleep(30000); // Check every 30 seconds
      } catch (err) {
        this.log(`Loop error: ${err.message}`);
        await this._sleep(10000);
      }
    }
  }

  async stop() {
    this.running = false;
    // Cancel all open orders
    for (const grid of this.grids) {
      if (grid.orderId) {
        try { await this.client.cancelOrder(this.symbol, grid.orderId); } catch {}
      }
    }
    await updateBotStatus(this.botId, 'stopped', { total_pnl: this.totalPnL });
    this.log(`Stopped | Total PnL: $${this.totalPnL.toFixed(2)}`);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
