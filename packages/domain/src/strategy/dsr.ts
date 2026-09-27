/**
 * Probabilistic and deflated Sharpe ratios (Bailey & López de Prado 2012, 2014), a line-for-line
 * port of `services/quant/src/kora_quant/bt/dsr.py` so the api can deflate promotion evidence with
 * the trial count at the time of the check (IRTC R3-02). Same reference example in both test suites.
 *
 * - PSR(SR*) = Φ((SR − SR*)·√(T − 1) / √(1 − γ₃·SR + (γ₄ − 1)/4·SR²)), SR per period, γ₄ Pearson
 *   (non-excess) kurtosis.
 * - SR₀ = √V[SR]·((1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))), γ = Euler–Mascheroni.
 * - DSR = PSR(SR₀).
 */

const EULER_GAMMA = 0.5772156649015329;

/** Complementary error function (Numerical Recipes `erfcc`, relative error < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Standard normal quantile (Acklam's rational approximation plus one Halley refinement). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x: number;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export function expectedMaxSharpe(varSr: number, nTrials: number): number {
  if (nTrials <= 1 || !(varSr > 0)) return 0;
  const a = normInv(1 - 1 / nTrials);
  const b = normInv(1 - 1 / (nTrials * Math.E));
  return Math.sqrt(varSr) * ((1 - EULER_GAMMA) * a + EULER_GAMMA * b);
}

export function probabilisticSharpe(
  sr: number,
  benchmark: number,
  nObs: number,
  skew: number,
  kurtosis: number,
): number | null {
  if (nObs < 2 || ![sr, benchmark, skew, kurtosis].every(Number.isFinite)) return null;
  const denom = 1 - skew * sr + ((kurtosis - 1) / 4) * sr * sr;
  if (denom <= 0) return null;
  return normCdf(((sr - benchmark) * Math.sqrt(nObs - 1)) / Math.sqrt(denom));
}

/** (DSR, SR₀). With one trial this is the PSR against zero. */
export function deflatedSharpe(
  sr: number,
  nObs: number,
  skew: number,
  kurtosis: number,
  nTrials: number,
  varTrials: number,
): { dsr: number | null; sr0: number } {
  const sr0 = expectedMaxSharpe(varTrials, nTrials);
  return { dsr: probabilisticSharpe(sr, sr0, nObs, skew, kurtosis), sr0 };
}

/** Sample variance (ddof 1) of the trials' per-period Sharpes; 0 with fewer than two. */
export function trialSharpeVariance(sharpes: readonly number[]): number {
  const xs = sharpes.filter(Number.isFinite);
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}
