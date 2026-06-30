// ── Technical Indicators ─────────────────────────────────────────────────────
// Pure functions — take price arrays, return signal values

// RSI — Relative Strength Index
export function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// EMA — Exponential Moving Average
export function calculateEMA(closes, period) {
  if (closes.length < period) return null;
  const k   = 2 / (period + 1);
  let ema   = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// SMA — Simple Moving Average
export function calculateSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Bollinger Bands
export function calculateBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice  = closes.slice(-period);
  const sma    = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const std    = Math.sqrt(variance);
  return {
    upper:  sma + stdDev * std,
    middle: sma,
    lower:  sma - stdDev * std,
    std,
  };
}

// MACD
export function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast   = calculateEMA(closes, fast);
  const emaSlow   = calculateEMA(closes, slow);
  const macdLine  = emaFast - emaSlow;
  // Approximate signal line
  const macdValues = [];
  for (let i = slow; i <= closes.length; i++) {
    const f = calculateEMA(closes.slice(0, i), fast);
    const s = calculateEMA(closes.slice(0, i), slow);
    if (f && s) macdValues.push(f - s);
  }
  const signalLine = calculateEMA(macdValues, signal);
  return {
    macd:      macdLine,
    signal:    signalLine,
    histogram: macdLine - (signalLine || 0),
  };
}

// Volume spike detection
export function detectVolumeSpike(volumes, period = 20, threshold = 1.5) {
  if (volumes.length < period) return false;
  const avgVolume  = calculateSMA(volumes.slice(-period - 1, -1), period);
  const lastVolume = volumes[volumes.length - 1];
  return lastVolume > avgVolume * threshold;
}

// ATR — Average True Range (volatility)
export function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high  = candles[i].high;
    const low   = candles[i].low;
    const pClose= candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)));
  }
  return calculateSMA(trueRanges, period);
}

// Full market analysis — returns a unified signal object
export function analyzeMarket(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);

  const rsi      = calculateRSI(closes, 14);
  const ema9     = calculateEMA(closes, 9);
  const ema21    = calculateEMA(closes, 21);
  const ema50    = calculateEMA(closes, 50);
  const bb       = calculateBollingerBands(closes, 20, 2);
  const macd     = calculateMACD(closes);
  const atr      = calculateATR(candles, 14);
  const volSpike = detectVolumeSpike(volumes);
  const price    = closes[closes.length - 1];

  // Signal scoring — weighted confluence
  let bullScore = 0, bearScore = 0;

  if (rsi !== null) {
    if (rsi < 30) bullScore += 3;       // Oversold → strong buy signal
    else if (rsi < 45) bullScore += 1;
    if (rsi > 70) bearScore += 3;       // Overbought → strong sell signal
    else if (rsi > 55) bearScore += 1;
  }

  if (ema9 && ema21) {
    if (ema9 > ema21) bullScore += 2;   // Golden cross
    else bearScore += 2;                // Death cross
  }

  if (ema21 && ema50) {
    if (ema21 > ema50) bullScore += 1;
    else bearScore += 1;
  }

  if (bb) {
    if (price <= bb.lower)  bullScore += 2;  // Price at lower band → bounce likely
    if (price >= bb.upper)  bearScore += 2;  // Price at upper band → reversal likely
  }

  if (macd) {
    if (macd.histogram > 0) bullScore += 1;
    else bearScore += 1;
  }

  if (volSpike) {
    // Volume spike amplifies existing signal
    if (bullScore > bearScore) bullScore += 1;
    else bearScore += 1;
  }

  const totalScore = bullScore + bearScore;
  const signal = bullScore > bearScore + 1 ? 'BUY'
               : bearScore > bullScore + 1 ? 'SELL'
               : 'HOLD';

  const confidence = totalScore > 0
    ? Math.round((Math.max(bullScore, bearScore) / totalScore) * 100)
    : 50;

  return {
    signal,
    confidence,
    bullScore,
    bearScore,
    indicators: { rsi, ema9, ema21, ema50, bb, macd, atr, volSpike, price },
  };
}
