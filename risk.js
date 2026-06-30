// ── Risk Manager ─────────────────────────────────────────────────────────────
// Controls how much to risk per trade and when to cut losses

const MIN_CAPITAL   = parseFloat(process.env.MIN_TRADING_CAPITAL || '30');
const MAX_RISK_PCT  = 0.05;   // Max 5% of capital per trade
const DEFAULT_SL    = 0.025;  // 2.5% stop loss
const DEFAULT_TP    = 0.05;   // 5% take profit

export class RiskManager {
  constructor(capital, config = {}) {
    this.capital     = capital;
    this.maxRiskPct  = config.maxRiskPct  || MAX_RISK_PCT;
    this.stopLossPct = config.stopLossPct || DEFAULT_SL;
    this.takeProfitPct = config.takeProfitPct || DEFAULT_TP;
  }

  // How many units to buy given price and risk tolerance
  getPositionSize(price, stopLossPct = this.stopLossPct) {
    if (this.capital < MIN_CAPITAL) {
      throw new Error(`Minimum trading capital is $${MIN_CAPITAL}`);
    }
    const riskAmount = this.capital * this.maxRiskPct;
    const riskPerUnit = price * stopLossPct;
    const qty = riskAmount / riskPerUnit;
    return Math.max(qty, 0.001); // Binance minimum
  }

  // Stop loss price
  getStopLoss(entryPrice, side, atr = null) {
    // ATR-based stop is smarter — uses market volatility
    const slDistance = atr
      ? atr * 1.5
      : entryPrice * this.stopLossPct;

    return side === 'BUY'
      ? entryPrice - slDistance
      : entryPrice + slDistance;
  }

  // Take profit price
  getTakeProfit(entryPrice, side, atr = null) {
    // 2:1 reward/risk ratio minimum
    const tpDistance = atr
      ? atr * 3
      : entryPrice * this.takeProfitPct;

    return side === 'BUY'
      ? entryPrice + tpDistance
      : entryPrice - tpDistance;
  }

  // Check if trade should be force-closed (drawdown protection)
  shouldForceClose(currentCapital) {
    const drawdown = (this.capital - currentCapital) / this.capital;
    return drawdown >= 0.15; // Force close all if 15% drawdown
  }

  // Calculate PnL
  calcPnL(side, entryPrice, exitPrice, quantity) {
    const raw = side === 'BUY'
      ? (exitPrice - entryPrice) * quantity
      : (entryPrice - exitPrice) * quantity;
    const fee = (entryPrice + exitPrice) * quantity * 0.001; // 0.1% Binance fee
    return raw - fee;
  }

  // Platform fee logic — only on profits
  calcPlatformFee(pnl) {
    if (pnl <= 0) return 0;
    return parseFloat(process.env.PLATFORM_FEE || '2');
  }
}
