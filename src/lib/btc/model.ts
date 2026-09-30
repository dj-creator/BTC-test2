import type { Candle, MarketQuote, ModelView } from "./types";

const FEE = 0.02;
const BUFFER = 0.01;

function tanh(n: number) {
  return Math.tanh(n);
}

export function realizedSigma(candles: Candle[]) {
  if (candles.length < 20) return null;
  const rets: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1]?.c;
    const cur = candles[i]?.c;
    if (!prev || !cur || prev <= 0 || cur <= 0) continue;
    rets.push(Math.log(cur / prev));
  }
  if (rets.length < 20) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const perMin = Math.sqrt(variance);
  return { perMin, sigma15: perMin * Math.sqrt(15) };
}

export function momentum5(candles: Candle[]) {
  if (candles.length < 6) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 6];
  if (!last || !prev || prev.c <= 0) return null;
  return (last.c - prev.c) / prev.c;
}

type WindowRow = { open: number; close: number; start: number };

export function fifteenMinuteWindows(candles: Candle[], excludeStart?: number): WindowRow[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const start = Math.floor(c.t / 900) * 900;
    const list = buckets.get(start) ?? [];
    list.push(c);
    buckets.set(start, list);
  }
  const rows: WindowRow[] = [];
  for (const [start, list] of buckets) {
    if (excludeStart != null && start === excludeStart) continue;
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) continue;
    rows.push({ start, open: first.o, close: last.c });
  }
  rows.sort((a, b) => b.start - a.start);
  return rows;
}

export function buildModel(input: {
  candles: Candle[];
  spot: number | null;
  market: MarketQuote | null;
  now: number;
  forceNegative?: boolean;
}): ModelView {
  const { candles, spot, market, now } = input;
  const sigma = realizedSigma(candles);
  const mom = momentum5(candles);
  const enough = candles.length >= 60 && sigma != null && spot != null;
  const closeTime = market?.closeTime ?? null;
  const tauMin = closeTime ? Math.max((closeTime - now) / 60000, 0.05) : 7.5;
  const inSettle = closeTime != null && now >= closeTime - 60_000 && now < closeTime + 5_000;
  const regime: ModelView["regime"] = inSettle
    ? "settlement-minute"
    : mom != null && sigma != null && Math.abs(mom) > sigma.sigma15 * 0.35
      ? "trend"
      : "chop";
  const volLabel =
    sigma == null ? "unknown vol" : sigma.sigma15 > 0.004 ? "elevated vol" : sigma.sigma15 < 0.0012 ? "quiet vol" : "normal vol";

  const strike = market?.strike ?? null;
  const windowStart = market ? Math.floor(market.openTime / 1000 / 900) * 900 : undefined;
  const history = fifteenMinuteWindows(candles, windowStart);
  let matches = 0;
  if (sigma && history.length && spot && strike) {
    const gap = Math.abs((spot - strike) / strike);
    const similar = history.filter((w) => Math.abs(Math.abs((w.close - w.open) / w.open) - gap) < Math.max(sigma.sigma15 * 0.8, 0.0006));
    matches = (similar.length >= 6 ? similar : history.slice(0, 20)).length;
  }

  if (!enough || !market) {
    return {
      paused: true,
      reason: !market
        ? "Waiting for a Kalshi market"
        : candles.length < 60
          ? "No continuous 60-minute volatility history"
          : "Waiting for valid model inputs",
      pUp: null,
      yesAsk: market?.yesAsk ?? null,
      noAsk: market?.noAsk ?? null,
      modelMinusAsk: null,
      feeAware: null,
      afterBuffer: null,
      breakevenYes: null,
      matches,
      volLabel,
      regime,
      call: "PAUSED",
      momentum: mom,
      sigmaDollar: sigma && spot ? spot * sigma.sigma15 : null,
      sigmaToStrike: null,
    };
  }

  let p = 0.5;
  if (mom != null) p += 0.16 * tanh(mom / Math.max(sigma.sigma15, 0.0004));
  let sigmaToStrike: number | null = null;
  if (strike) {
    const dist = (spot - strike) / strike;
    sigmaToStrike = dist / (sigma.sigma15 * Math.sqrt(tauMin / 15));
    p += 0.14 * tanh(sigmaToStrike / 1.5);
  }
  if (inSettle && strike) {
    const dist = (spot - strike) / strike;
    p = 0.5 + 0.45 * tanh(dist / Math.max(sigma.perMin, 0.0002));
  }
  p = Math.min(0.92, Math.max(0.08, p));

  const yesAsk = input.forceNegative ? 0.9 : market.yesAsk;
  const noAsk = market.noAsk;
  const modelMinusAsk = yesAsk == null ? null : p - yesAsk;
  const feeAware = modelMinusAsk == null ? null : modelMinusAsk - FEE;
  const afterBuffer = feeAware == null ? null : feeAware - BUFFER;
  const breakevenYes = p - FEE - BUFFER;
  const noEdge = noAsk == null ? null : 1 - p - noAsk - FEE - BUFFER;

  let call: ModelView["call"] = "NO TRADE";
  if (afterBuffer != null && afterBuffer > 0 && (noEdge == null || afterBuffer >= noEdge)) call = "WATCH YES";
  else if (noEdge != null && noEdge > 0) call = "WATCH NO";

  return {
    paused: false,
    reason: null,
    pUp: p,
    yesAsk,
    noAsk,
    modelMinusAsk,
    feeAware,
    afterBuffer,
    breakevenYes,
    matches,
    volLabel,
    regime,
    call,
    momentum: mom,
    sigmaDollar: spot * sigma.sigma15,
    sigmaToStrike,
  };
}
