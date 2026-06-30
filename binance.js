import axios from 'axios';
import crypto from 'crypto';
import WebSocket from 'ws';

const BASE_URL     = 'https://testnet.binance.vision/api';
const WS_BASE      = 'wss://testnet.binance.vision/ws';
const BASE_URL_LIVE = 'https://api.binance.com/api';
const WS_BASE_LIVE  = 'wss://stream.binance.com:9443/ws';

export class BinanceClient {
  constructor(apiKey, secretKey, testnet = true) {
    this.apiKey    = apiKey;
    this.secretKey = secretKey;
    this.testnet   = testnet;
    this.baseUrl   = testnet ? BASE_URL : BASE_URL_LIVE;
    this.wsBase    = testnet ? WS_BASE  : WS_BASE_LIVE;
  }

  // ── Signature ──────────────────────────────────────────────────────────────
  _sign(params) {
    const query = new URLSearchParams(params).toString();
    return crypto.createHmac('sha256', this.secretKey).update(query).digest('hex');
  }

  // ── Authenticated request ──────────────────────────────────────────────────
  async _request(method, path, params = {}, signed = false) {
    if (signed) {
      params.timestamp = Date.now();
      params.signature = this._sign(params);
    }
    try {
      const res = await axios({
        method,
        url: `${this.baseUrl}${path}`,
        headers: { 'X-MBX-APIKEY': this.apiKey },
        params: method === 'GET' ? params : undefined,
        data:   method !== 'GET' ? new URLSearchParams(params).toString() : undefined,
      });
      return res.data;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      throw new Error(`Binance API error: ${msg}`);
    }
  }

  // ── Account ────────────────────────────────────────────────────────────────
  async getAccount()   { return this._request('GET', '/v3/account', {}, true); }
  async getBalance(asset) {
    const account = await this.getAccount();
    const bal = account.balances.find(b => b.asset === asset);
    return bal ? parseFloat(bal.free) : 0;
  }

  // ── Market Data ────────────────────────────────────────────────────────────
  async getPrice(symbol) {
    const data = await this._request('GET', '/v3/ticker/price', { symbol });
    return parseFloat(data.price);
  }

  async getKlines(symbol, interval = '1m', limit = 100) {
    const data = await this._request('GET', '/v3/klines', { symbol, interval, limit });
    return data.map(k => ({
      openTime:  k[0],
      open:      parseFloat(k[1]),
      high:      parseFloat(k[2]),
      low:       parseFloat(k[3]),
      close:     parseFloat(k[4]),
      volume:    parseFloat(k[5]),
      closeTime: k[6],
    }));
  }

  async get24hrStats(symbol) {
    return this._request('GET', '/v3/ticker/24hr', { symbol });
  }

  async getOrderBook(symbol, limit = 10) {
    return this._request('GET', '/v3/depth', { symbol, limit });
  }

  // ── Orders ─────────────────────────────────────────────────────────────────
  async placeMarketOrder(symbol, side, quantity) {
    return this._request('POST', '/v3/order', {
      symbol,
      side,           // BUY | SELL
      type: 'MARKET',
      quantity: quantity.toFixed(6),
    }, true);
  }

  async placeLimitOrder(symbol, side, quantity, price) {
    return this._request('POST', '/v3/order', {
      symbol,
      side,
      type:        'LIMIT',
      timeInForce: 'GTC',
      quantity:    quantity.toFixed(6),
      price:       price.toFixed(2),
    }, true);
  }

  async placeOCOOrder(symbol, side, quantity, price, stopPrice, stopLimitPrice) {
    return this._request('POST', '/v3/order/oco', {
      symbol,
      side,
      quantity:       quantity.toFixed(6),
      price:          price.toFixed(2),
      stopPrice:      stopPrice.toFixed(2),
      stopLimitPrice: stopLimitPrice.toFixed(2),
      stopLimitTimeInForce: 'GTC',
    }, true);
  }

  async cancelOrder(symbol, orderId) {
    return this._request('DELETE', '/v3/order', { symbol, orderId }, true);
  }

  async getOrder(symbol, orderId) {
    return this._request('GET', '/v3/order', { symbol, orderId }, true);
  }

  async getOpenOrders(symbol) {
    return this._request('GET', '/v3/openOrders', { symbol }, true);
  }

  // ── Symbol Info ────────────────────────────────────────────────────────────
  async getSymbolInfo(symbol) {
    const data = await this._request('GET', '/v3/exchangeInfo', { symbol });
    return data.symbols[0];
  }

  async getMinQty(symbol) {
    const info   = await this.getSymbolInfo(symbol);
    const filter = info.filters.find(f => f.filterType === 'LOT_SIZE');
    return parseFloat(filter?.minQty || '0.001');
  }

  // ── WebSocket price stream ─────────────────────────────────────────────────
  streamPrice(symbol, onPrice) {
    const ws = new WebSocket(`${this.wsBase}/${symbol.toLowerCase()}@trade`);
    ws.on('message', raw => {
      const data = JSON.parse(raw);
      onPrice(parseFloat(data.p), data);
    });
    ws.on('error', err => console.error(`[WS ${symbol}] error:`, err.message));
    ws.on('close', ()  => {
      console.log(`[WS ${symbol}] closed — reconnecting in 3s`);
      setTimeout(() => this.streamPrice(symbol, onPrice), 3000);
    });
    return ws;
  }
}
