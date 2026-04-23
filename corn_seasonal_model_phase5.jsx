import React, { useState, useMemo } from 'react';
import { Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, ComposedChart, ReferenceLine, ReferenceArea, Bar, BarChart, Cell } from 'recharts';

// ============================================================
// DATA GENERATION (same as prior phases)
// ============================================================
const generateHistoricalData = () => {
  const years = 25;
  const currentYear = 2026;
  const startYear = currentYear - years;
  const data = {};

  const seasonalShape = Array.from({ length: 52 }, (_, i) => {
    const week = i + 1;
    const plantingPremium = 0.04 * Math.exp(-Math.pow((week - 22) / 8, 2));
    const pollinationPeak = 0.06 * Math.exp(-Math.pow((week - 28) / 4, 2));
    const harvestLow = -0.07 * Math.exp(-Math.pow((week - 40) / 5, 2));
    const winterRecovery = 0.02 * Math.exp(-Math.pow((week - 6) / 6, 2));
    return plantingPremium + pollinationPeak + harvestLow + winterRecovery;
  });

  for (let y = 0; y < years; y++) {
    const year = startYear + y;
    let basePrice;
    if (year >= 2020 && year <= 2022) basePrice = 6.5 + Math.random() * 1.3;
    else if (year >= 2010 && year <= 2013) basePrice = 5.8 + Math.random() * 1.5;
    else if (year >= 2014 && year <= 2019) basePrice = 3.8 + Math.random() * 0.6;
    else basePrice = 4.2 + (Math.random() - 0.5) * 1.2;
    basePrice = Math.max(3.0, basePrice);

    const yearData = [];
    for (let w = 0; w < 52; w++) {
      const seasonal = seasonalShape[w];
      const yearShock = (Math.random() - 0.5) * 0.1;
      const noise = (Math.random() - 0.5) * 0.03;
      const droughtBonus = (year % 7 === 0 && w >= 25 && w <= 32) ? 0.08 : 0;
      const price = basePrice * (1 + seasonal + yearShock + noise + droughtBonus);
      yearData.push({ week: w + 1, price: parseFloat(price.toFixed(2)), year });
    }
    data[year] = yearData;
  }
  return data;
};

const historicalData = generateHistoricalData();

// ============================================================
// REGIME FUNCTIONS (continuous, not bucketed, for MC)
// ============================================================
// Continuous S/U shift - smoother than buckets for MC
const suShift = (su) => {
  // Fit: high shift at low S/U, negative at high S/U
  return 45 * Math.exp(-(su - 5) / 4) - 20 + Math.max(0, (18 - su) * 0.5);
};
const suWiden = (su) => {
  if (su < 8) return 1.5;
  if (su < 12) return 1.2;
  if (su > 17) return 1.2;
  return 1.0;
};

const computeWSI = (tempAnomaly, precipAnomaly) => {
  const tempStress = Math.max(0, Math.min(100, ((tempAnomaly + 2) / 10) * 100));
  const precipStress = Math.max(0, Math.min(100, (-precipAnomaly + 20)));
  return 0.4 * tempStress + 0.6 * precipStress;
};
const weatherShift = (wsi) => {
  if (wsi < 20) return -8;
  return Math.min(35, (wsi - 30) * 0.6);
};

const weatherSensitivity = (week) => {
  if (week < 20 || week > 38) return 0;
  if (week >= 26 && week <= 32) return 1.0;
  if (week >= 20 && week < 26) return (week - 20) / 6;
  if (week > 32 && week <= 38) return (38 - week) / 6;
  return 0;
};

const cotMedianShift = (pct) => {
  // Asymmetric: extreme long = bearish, extreme short = bullish
  if (pct > 90) return -10;
  if (pct > 75) return -5;
  if (pct > 55) return -1;
  if (pct >= 40) return 0;
  if (pct >= 20) return 1;
  if (pct >= 10) return 5;
  return 10;
};

// ============================================================
// SEASONAL BASELINE (same as before)
// ============================================================
const computeSeasonalBaseline = (data, yearsToUse) => {
  const baseline = [];
  const allYears = Object.keys(data).map(Number).sort((a, b) => b - a);
  const selectedYears = allYears.slice(0, yearsToUse);

  for (let w = 1; w <= 52; w++) {
    const normalizedReturns = selectedYears.map(year => {
      const yearData = data[year];
      const annualMean = yearData.reduce((s, d) => s + d.price, 0) / yearData.length;
      const weekPrice = yearData.find(d => d.week === w).price;
      return (weekPrice / annualMean - 1) * 100;
    });

    normalizedReturns.sort((a, b) => a - b);
    const n = normalizedReturns.length;
    const percentile = (p) => normalizedReturns[Math.floor(n * p)];
    const mean = normalizedReturns.reduce((s, v) => s + v, 0) / n;
    const variance = normalizedReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / n;

    baseline.push({
      week: w,
      p50: percentile(0.50),
      mean,
      std: Math.sqrt(variance),
    });
  }
  return baseline;
};

// ============================================================
// MONTE CARLO SIMULATION
// ============================================================
// Box-Muller transform for normal random samples
const randn = () => {
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random() || 0.0001;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

// Draw correlated samples: weather-fundamentals correlation
// Drought tends to tighten S/U in subsequent periods
const drawCorrelated = (correlation) => {
  const z1 = randn();
  const z2 = randn();
  // Cholesky-style correlation
  const z2_corr = correlation * z1 + Math.sqrt(1 - correlation * correlation) * z2;
  return [z1, z2_corr];
};

const runMonteCarlo = (params, baseline, numSims, horizonWeek) => {
  const {
    currentWeek, currentPrice, stocksToUse, tempAnomaly,
    precipAnomaly, cotPercentile,
    suUncertainty, weatherUncertainty, cotUncertainty, priceNoise
  } = params;

  const results = [];

  for (let sim = 0; sim < numSims; sim++) {
    // Correlated draws: weather stress ↔ S/U tightening (negative correlation)
    const [weatherShock, suShock] = drawCorrelated(-0.35);
    const cotShock = randn();
    const priceShock = randn();

    // Perturbed inputs for this simulation
    const simSu = Math.max(5, stocksToUse + suShock * suUncertainty);
    const simTemp = tempAnomaly + weatherShock * weatherUncertainty;
    const simPrecip = precipAnomaly - weatherShock * weatherUncertainty * 10; // temp and precip anti-correlated
    const simCot = Math.max(0, Math.min(100, cotPercentile + cotShock * cotUncertainty * 10));
    const simWSI = computeWSI(simTemp, simPrecip);

    // Current week factors
    const currentSuShift = suShift(simSu);
    const currentWthShift = weatherShift(simWSI) * weatherSensitivity(currentWeek);
    const currentCotShift = cotMedianShift(simCot);
    const currentSeasonal = baseline.find(b => b.week === currentWeek)?.p50 || 0;
    const currentTotalShift = currentSeasonal + currentSuShift + currentWthShift + currentCotShift;

    // Horizon week factors
    const horSuShift = suShift(simSu);
    const horWthShift = weatherShift(simWSI) * weatherSensitivity(horizonWeek);
    const horCotShift = currentCotShift; // positioning less directly affects future
    const horSeasonal = baseline.find(b => b.week === horizonWeek)?.p50 || 0;
    const horTotalShift = horSeasonal + horSuShift + horWthShift + horCotShift;

    // Implied mean from current price
    const impliedMean = currentPrice / (1 + currentTotalShift / 100);

    // Project to horizon, with random noise
    const horStd = baseline.find(b => b.week === horizonWeek)?.std || 5;
    const noise = priceShock * horStd * priceNoise;
    const projected = impliedMean * (1 + (horTotalShift + noise) / 100);

    results.push(Math.max(1.5, projected));
  }

  results.sort((a, b) => a - b);
  return results;
};

// Compute statistics from MC results
const computeStats = (results) => {
  const n = results.length;
  if (n === 0) return null;
  const pct = (p) => results[Math.floor(n * p)];
  const mean = results.reduce((s, v) => s + v, 0) / n;
  const variance = results.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return {
    mean, std: Math.sqrt(variance),
    p05: pct(0.05), p10: pct(0.10), p25: pct(0.25),
    p50: pct(0.50), p75: pct(0.75), p90: pct(0.90), p95: pct(0.95),
    min: results[0], max: results[n - 1],
  };
};

// Build histogram from results
const buildHistogram = (results, numBins) => {
  if (results.length === 0) return [];
  const min = results[0];
  const max = results[results.length - 1];
  const binWidth = (max - min) / numBins;
  const bins = Array(numBins).fill(0).map((_, i) => ({
    binStart: min + i * binWidth,
    binEnd: min + (i + 1) * binWidth,
    center: parseFloat((min + (i + 0.5) * binWidth).toFixed(2)),
    count: 0,
  }));
  results.forEach(r => {
    const idx = Math.min(numBins - 1, Math.floor((r - min) / binWidth));
    bins[idx].count++;
  });
  return bins.map(b => ({ ...b, pct: (b.count / results.length) * 100 }));
};

const weekToMonth = (week) => {
  const date = new Date(2024, 0, 1 + (week - 1) * 7);
  return date.toLocaleString('en-US', { month: 'short' });
};
const weekLabel = (week) => (week === 1 || week % 8 === 0) ? weekToMonth(week) : '';

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function CornModelPhase5() {
  const [currentWeek, setCurrentWeek] = useState(20);
  const [currentPrice, setCurrentPrice] = useState(4.65);
  const [stocksToUse, setStocksToUse] = useState(12.8);
  const [tempAnomaly, setTempAnomaly] = useState(0);
  const [precipAnomaly, setPrecipAnomaly] = useState(0);
  const [cotPercentile, setCotPercentile] = useState(50);
  const [horizonWeeks, setHorizonWeeks] = useState(13);

  // Uncertainty parameters
  const [suUncertainty, setSuUncertainty] = useState(1.5);
  const [weatherUncertainty, setWeatherUncertainty] = useState(2.0);
  const [cotUncertainty, setCotUncertainty] = useState(1.5);
  const [priceNoise, setPriceNoise] = useState(1.0);

  const [numSims, setNumSims] = useState(5000);
  const [priceTarget, setPriceTarget] = useState(5.50);

  const baseline = useMemo(() => computeSeasonalBaseline(historicalData, 20), []);
  const horizonWeek = Math.min(52, currentWeek + horizonWeeks);

  // Run simulation
  const { pathResults, stats, histogram, probAboveTarget, probBelowCurrent } = useMemo(() => {
    const params = {
      currentWeek, currentPrice, stocksToUse, tempAnomaly,
      precipAnomaly, cotPercentile,
      suUncertainty, weatherUncertainty, cotUncertainty, priceNoise
    };

    const results = runMonteCarlo(params, baseline, numSims, horizonWeek);
    const stats = computeStats(results);
    const histogram = buildHistogram(results, 30);
    const probAboveTarget = results.filter(r => r > priceTarget).length / results.length;
    const probBelowCurrent = results.filter(r => r < currentPrice).length / results.length;

    // Also run path projections at multiple horizons for fan chart
    const horizons = [];
    for (let h = 1; h <= 26; h++) {
      const hWeek = Math.min(52, currentWeek + h);
      const hResults = runMonteCarlo(params, baseline, 1000, hWeek);
      const hStats = computeStats(hResults);
      horizons.push({
        week: hWeek,
        offset: h,
        p05: hStats.p05, p25: hStats.p25, p50: hStats.p50,
        p75: hStats.p75, p95: hStats.p95,
        band50: [hStats.p25, hStats.p75],
        band90: [hStats.p05, hStats.p95],
      });
    }
    horizons.unshift({
      week: currentWeek, offset: 0,
      p05: currentPrice, p25: currentPrice, p50: currentPrice,
      p75: currentPrice, p95: currentPrice,
      band50: [currentPrice, currentPrice],
      band90: [currentPrice, currentPrice],
    });

    return { pathResults: horizons, stats, histogram, probAboveTarget, probBelowCurrent };
  }, [currentWeek, currentPrice, stocksToUse, tempAnomaly, precipAnomaly, cotPercentile,
      suUncertainty, weatherUncertainty, cotUncertainty, priceNoise, numSims, horizonWeek, priceTarget, baseline]);

  // Color histogram bars: below current = red, above target = green
  const coloredHistogram = histogram.map(b => ({
    ...b,
    fill: b.center < currentPrice ? '#c0392b' :
          b.center > priceTarget ? '#3a7c4e' : '#8b6f3f'
  }));

  return (
    <div style={{ fontFamily: 'Georgia, serif', background: '#f5f0e8', minHeight: '100vh', padding: '24px', color: '#2a2419' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>

        <div style={{ borderBottom: '3px double #8b6f3f', paddingBottom: '16px', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#8b6f3f', marginBottom: '4px' }}>
            PHASE 5 — MONTE CARLO SIMULATION
          </div>
          <h1 style={{ fontSize: '36px', margin: '0', fontWeight: 'normal', letterSpacing: '-1px' }}>
            Corn Futures <span style={{ fontStyle: 'italic', color: '#8b6f3f' }}>Probability Model</span>
          </h1>
          <div style={{ fontSize: '13px', color: '#6b5a3f', marginTop: '8px' }}>
            {numSims.toLocaleString()} simulations · Correlated factor uncertainty · Full probability distributions
          </div>
        </div>

        {/* Key probability metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '12px', marginBottom: '20px' }}>
          <div style={{ background: '#3a7c4e', color: '#fff', padding: '16px' }}>
            <div style={{ fontSize: '10px', letterSpacing: '2px', opacity: 0.8 }}>P(PRICE &gt; ${priceTarget.toFixed(2)})</div>
            <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{(probAboveTarget * 100).toFixed(0)}%</div>
            <div style={{ fontSize: '11px', opacity: 0.8 }}>at week {horizonWeek}</div>
          </div>
          <div style={{ background: '#c0392b', color: '#fff', padding: '16px' }}>
            <div style={{ fontSize: '10px', letterSpacing: '2px', opacity: 0.8 }}>P(PRICE &lt; ${currentPrice.toFixed(2)})</div>
            <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{(probBelowCurrent * 100).toFixed(0)}%</div>
            <div style={{ fontSize: '11px', opacity: 0.8 }}>downside probability</div>
          </div>
          <div style={{ background: '#2a4d6e', color: '#fff', padding: '16px' }}>
            <div style={{ fontSize: '10px', letterSpacing: '2px', opacity: 0.8 }}>EXPECTED VALUE</div>
            <div style={{ fontSize: '32px', fontWeight: 'bold' }}>${stats?.mean.toFixed(2)}</div>
            <div style={{ fontSize: '11px', opacity: 0.8 }}>±${stats?.std.toFixed(2)} std</div>
          </div>
          <div style={{ background: '#2a2419', color: '#fff', padding: '16px' }}>
            <div style={{ fontSize: '10px', letterSpacing: '2px', opacity: 0.8 }}>VAR (5%)</div>
            <div style={{ fontSize: '32px', fontWeight: 'bold' }}>${stats?.p05.toFixed(2)}</div>
            <div style={{ fontSize: '11px', opacity: 0.8 }}>95% worst case</div>
          </div>
        </div>

        {/* Market state controls */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px', background: '#ede4d3', padding: '14px', border: '1px solid #c4a76a' }}>
          <div>
            <label style={{ fontSize: '10px', letterSpacing: '2px', color: '#8b6f3f' }}>CURRENT WEEK</label>
            <input type="range" min="1" max="52" value={currentWeek} onChange={(e) => setCurrentWeek(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '13px' }}>W{currentWeek} · {weekToMonth(currentWeek)}</div>
          </div>
          <div>
            <label style={{ fontSize: '10px', letterSpacing: '2px', color: '#8b6f3f' }}>CURRENT PRICE</label>
            <input type="number" step="0.05" value={currentPrice} onChange={(e) => setCurrentPrice(parseFloat(e.target.value) || 0)} style={{ width: '100%', padding: '4px', border: '1px solid #8b6f3f', background: '#f5f0e8', fontFamily: 'Georgia, serif' }} />
          </div>
          <div>
            <label style={{ fontSize: '10px', letterSpacing: '2px', color: '#8b6f3f' }}>HORIZON (WEEKS)</label>
            <input type="range" min="1" max="26" value={horizonWeeks} onChange={(e) => setHorizonWeeks(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '13px' }}>{horizonWeeks}w → {weekToMonth(horizonWeek)}</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '12px', marginBottom: '12px', background: '#ede4d3', padding: '14px', border: '1px solid #c4a76a' }}>
          <div>
            <label style={{ fontSize: '10px', letterSpacing: '2px', color: '#8b6f3f' }}>S/U %</label>
            <input type="range" min="5" max="22" step="0.1" value={stocksToUse} onChange={(e) => setStocksToUse(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '13px' }}>{stocksToUse.toFixed(1)}%</div>
          </div>
          <div>
            <label style={{ fontSize: '10px', letterSpacing: '2px', color: '#8b6f3f' }}>TEMP (°F)</label>
            <input type="range" min="-5" max="10" step="0.5" value={tempAnomaly} onChange={(e) => setTempAnomaly(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '13px' }}>{tempAnomaly > 0 ? '+' : ''}{tempAnomaly.toFixed(1)}°F</div>
          </div>
          <div>
            <label style={{ fontSize: '10px', letterSpacing: '2px', color: '#8b6f3f' }}>PRECIP (%)</label>
            <input type="range" min="-80" max="50" step="5" value={precipAnomaly} onChange={(e) => setPrecipAnomaly(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '13px' }}>{precipAnomaly > 0 ? '+' : ''}{precipAnomaly}%</div>
          </div>
          <div>
            <label style={{ fontSize: '10px', letterSpacing: '2px', color: '#8b6f3f' }}>COT %ILE</label>
            <input type="range" min="0" max="100" value={cotPercentile} onChange={(e) => setCotPercentile(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '13px' }}>{cotPercentile}</div>
          </div>
        </div>

        {/* Uncertainty controls */}
        <div style={{ background: '#2a2419', color: '#f5f0e8', padding: '14px', marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', letterSpacing: '2px', color: '#c4a76a', marginBottom: '10px' }}>UNCERTAINTY CALIBRATION · HOW UNCERTAIN ARE YOUR INPUTS?</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ fontSize: '10px', opacity: 0.7 }}>S/U ± (%)</label>
              <input type="range" min="0" max="4" step="0.1" value={suUncertainty} onChange={(e) => setSuUncertainty(parseFloat(e.target.value))} style={{ width: '100%' }} />
              <div style={{ fontSize: '12px' }}>±{suUncertainty.toFixed(1)}</div>
            </div>
            <div>
              <label style={{ fontSize: '10px', opacity: 0.7 }}>Weather ±</label>
              <input type="range" min="0" max="5" step="0.1" value={weatherUncertainty} onChange={(e) => setWeatherUncertainty(parseFloat(e.target.value))} style={{ width: '100%' }} />
              <div style={{ fontSize: '12px' }}>±{weatherUncertainty.toFixed(1)}</div>
            </div>
            <div>
              <label style={{ fontSize: '10px', opacity: 0.7 }}>COT ±</label>
              <input type="range" min="0" max="3" step="0.1" value={cotUncertainty} onChange={(e) => setCotUncertainty(parseFloat(e.target.value))} style={{ width: '100%' }} />
              <div style={{ fontSize: '12px' }}>±{cotUncertainty.toFixed(1)}</div>
            </div>
            <div>
              <label style={{ fontSize: '10px', opacity: 0.7 }}>Price noise ×</label>
              <input type="range" min="0.5" max="2.5" step="0.1" value={priceNoise} onChange={(e) => setPriceNoise(parseFloat(e.target.value))} style={{ width: '100%' }} />
              <div style={{ fontSize: '12px' }}>{priceNoise.toFixed(1)}×</div>
            </div>
            <div>
              <label style={{ fontSize: '10px', opacity: 0.7 }}>Simulations</label>
              <input type="range" min="1000" max="15000" step="1000" value={numSims} onChange={(e) => setNumSims(parseInt(e.target.value))} style={{ width: '100%' }} />
              <div style={{ fontSize: '12px' }}>{numSims.toLocaleString()}</div>
            </div>
          </div>
        </div>

        {/* Price target selector */}
        <div style={{ background: '#ede4d3', padding: '12px 16px', marginBottom: '24px', border: '1px solid #c4a76a', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f' }}>PRICE TARGET FOR PROBABILITY:</label>
          <input type="range" min="3" max="10" step="0.05" value={priceTarget} onChange={(e) => setPriceTarget(parseFloat(e.target.value))} style={{ flex: 1 }} />
          <div style={{ fontSize: '18px', minWidth: '70px', color: '#3a7c4e' }}>${priceTarget.toFixed(2)}</div>
        </div>

        {/* Fan chart */}
        <div style={{ background: '#fff', padding: '24px', border: '1px solid #c4a76a', marginBottom: '24px' }}>
          <h2 style={{ fontSize: '20px', marginTop: 0, marginBottom: '4px', fontWeight: 'normal' }}>
            Monte Carlo price fan
          </h2>
          <div style={{ fontSize: '12px', color: '#6b5a3f', marginBottom: '16px' }}>
            Inner band: 25th–75th percentile · Outer band: 5th–95th percentile · Line: median path
          </div>
          <ResponsiveContainer width="100%" height={400}>
            <ComposedChart data={pathResults}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d4c4a0" />
              <XAxis dataKey="week" tickFormatter={weekLabel} stroke="#6b5a3f" />
              <YAxis stroke="#6b5a3f" domain={['auto', 'auto']} tickFormatter={(v) => `$${v.toFixed(2)}`} />
              <Tooltip
                contentStyle={{ background: '#f5f0e8', border: '1px solid #8b6f3f', fontFamily: 'Georgia, serif' }}
                formatter={(v, n) => Array.isArray(v) ? [`$${v[0].toFixed(2)} – $${v[1].toFixed(2)}`, n] : [`$${v.toFixed(2)}`, n]}
                labelFormatter={(w) => `Week ${w}`}
              />
              <Legend />
              <Area type="monotone" dataKey="band90" fill="#8b6f3f" fillOpacity={0.18} stroke="none" name="5-95th %ile" />
              <Area type="monotone" dataKey="band50" fill="#8b6f3f" fillOpacity={0.35} stroke="none" name="25-75th %ile" />
              <Line type="monotone" dataKey="p50" stroke="#2a2419" strokeWidth={2.5} dot={false} name="Median" />
              <ReferenceLine y={currentPrice} stroke="#c0392b" strokeDasharray="4 4" label={{ value: 'Current', fill: '#c0392b', fontSize: 11, position: 'right' }} />
              <ReferenceLine y={priceTarget} stroke="#3a7c4e" strokeDasharray="4 4" label={{ value: 'Target', fill: '#3a7c4e', fontSize: 11, position: 'right' }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Distribution histogram */}
        <div style={{ background: '#fff', padding: '24px', border: '1px solid #c4a76a', marginBottom: '24px' }}>
          <h2 style={{ fontSize: '20px', marginTop: 0, marginBottom: '4px', fontWeight: 'normal' }}>
            Terminal price distribution at {weekToMonth(horizonWeek)}
          </h2>
          <div style={{ fontSize: '12px', color: '#6b5a3f', marginBottom: '16px' }}>
            <span style={{ color: '#c0392b' }}>Red: below current ${currentPrice.toFixed(2)}</span> · <span style={{ color: '#8b6f3f' }}>Brown: between</span> · <span style={{ color: '#3a7c4e' }}>Green: above target ${priceTarget.toFixed(2)}</span>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={coloredHistogram}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d4c4a0" />
              <XAxis dataKey="center" stroke="#6b5a3f" tickFormatter={(v) => `$${v.toFixed(2)}`} />
              <YAxis stroke="#6b5a3f" tickFormatter={(v) => `${v.toFixed(1)}%`} />
              <Tooltip
                contentStyle={{ background: '#f5f0e8', border: '1px solid #8b6f3f', fontFamily: 'Georgia, serif' }}
                formatter={(v, n, p) => [`${v.toFixed(2)}%`, 'probability']}
                labelFormatter={(v) => `~$${v.toFixed(2)}`}
              />
              <ReferenceLine x={currentPrice} stroke="#c0392b" strokeDasharray="4 4" />
              <ReferenceLine x={priceTarget} stroke="#3a7c4e" strokeDasharray="4 4" />
              <ReferenceLine x={stats?.mean} stroke="#2a2419" strokeDasharray="2 2" />
              <Bar dataKey="pct">
                {coloredHistogram.map((entry, index) => (
                  <Cell key={index} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Statistics table */}
        <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a', marginBottom: '24px' }}>
          <h3 style={{ fontSize: '14px', letterSpacing: '2px', color: '#8b6f3f', marginTop: 0, fontWeight: 'normal' }}>
            DISTRIBUTION STATISTICS
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', fontSize: '14px' }}>
            <div><div style={{ fontSize: '11px', color: '#8b6f3f' }}>5th %ile</div><div style={{ fontSize: '18px' }}>${stats?.p05.toFixed(2)}</div></div>
            <div><div style={{ fontSize: '11px', color: '#8b6f3f' }}>25th %ile</div><div style={{ fontSize: '18px' }}>${stats?.p25.toFixed(2)}</div></div>
            <div><div style={{ fontSize: '11px', color: '#8b6f3f' }}>MEDIAN</div><div style={{ fontSize: '18px', fontWeight: 'bold' }}>${stats?.p50.toFixed(2)}</div></div>
            <div><div style={{ fontSize: '11px', color: '#8b6f3f' }}>MEAN</div><div style={{ fontSize: '18px' }}>${stats?.mean.toFixed(2)}</div></div>
            <div><div style={{ fontSize: '11px', color: '#8b6f3f' }}>75th %ile</div><div style={{ fontSize: '18px' }}>${stats?.p75.toFixed(2)}</div></div>
            <div><div style={{ fontSize: '11px', color: '#8b6f3f' }}>95th %ile</div><div style={{ fontSize: '18px' }}>${stats?.p95.toFixed(2)}</div></div>
            <div><div style={{ fontSize: '11px', color: '#8b6f3f' }}>STD DEV</div><div style={{ fontSize: '18px' }}>${stats?.std.toFixed(2)}</div></div>
            <div><div style={{ fontSize: '11px', color: '#8b6f3f' }}>SKEW</div><div style={{ fontSize: '18px' }}>{stats && (stats.mean > stats.p50 ? 'Right' : stats.mean < stats.p50 ? 'Left' : 'Sym')}</div></div>
          </div>
        </div>

        {/* Trade sizing implications */}
        <div style={{ background: '#2a2419', color: '#f5f0e8', padding: '24px', border: '1px solid #8b6f3f', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#c4a76a', marginBottom: '12px' }}>TRADING IMPLICATIONS</div>
          <div style={{ fontSize: '15px', lineHeight: '1.8' }}>
            <strong>Expected return:</strong> {((stats?.mean / currentPrice - 1) * 100).toFixed(1)}% over {horizonWeeks} weeks.{' '}
            <strong>Probability of profit (long):</strong> {((1 - probBelowCurrent) * 100).toFixed(0)}%.{' '}
            <strong>Asymmetry:</strong> {stats && stats.mean > stats.p50 ? 'Right-skewed — small edge but large upside tail' : stats && stats.mean < stats.p50 ? 'Left-skewed — most paths up but tail risk down' : 'Symmetric distribution'}.
            <br /><br />
            <strong>Position sizing (Kelly approximation):</strong> With {(probAboveTarget * 100).toFixed(0)}% chance of reaching ${priceTarget.toFixed(2)} (a {((priceTarget / currentPrice - 1) * 100).toFixed(0)}% move) and downside VaR of ${stats?.p05.toFixed(2)} (a {((stats?.p05 / currentPrice - 1) * 100).toFixed(0)}% move), the edge-adjusted position size is modest. Real Kelly: size at {Math.max(0, ((probAboveTarget - 0.5) * 100)).toFixed(0)}% of max — and half-Kelly in practice.
            <br /><br />
            {probAboveTarget > 0.6 && <span style={{ color: '#5ca86b' }}><strong>Favorable setup:</strong> Probability of upside breakout materially exceeds 50%. Consider defined-risk long exposure.</span>}
            {probAboveTarget < 0.3 && <span style={{ color: '#e08080' }}><strong>Unfavorable long:</strong> Probability of reaching target is low. Either skip or consider short-side structures.</span>}
            {probAboveTarget >= 0.3 && probAboveTarget <= 0.6 && <span style={{ color: '#c4a76a' }}><strong>Mixed setup:</strong> Probabilities are roughly balanced. Wait for clearer setup or use non-directional structures (straddles).</span>}
          </div>
        </div>

        {/* Final notes */}
        <div style={{ padding: '16px', background: '#ede4d3', fontSize: '12px', color: '#6b5a3f', lineHeight: '1.6' }}>
          <strong>Model complete.</strong> You now have a full framework: seasonality (base rate) → fundamentals (S/U regime) → weather (conditional stress) → positioning (contrarian filter) → Monte Carlo (probabilistic outcomes with correlated factor uncertainty).
          <br /><br />
          <strong>What to do with it in practice:</strong> Use the probability outputs to size trades, not to pick direction alone. A 65% probability of $5.50 with $4.65 current price, at modest uncertainty, is a reasonable long. A 65% probability with huge uncertainty bands (wide histogram) is not — the expected value is the same but the volatility-adjusted return is worse.
          <br /><br />
          <strong>What's still missing for production:</strong> (1) Real data pipelines (USDA, NOAA, CFTC, CME), (2) backtesting framework to validate factor weights against actual P&L, (3) ensemble with non-seasonal regime detection (spec bubbles, macro shocks), (4) transaction cost and margin modeling, (5) multi-contract portfolio logic (crush spreads, inter-month spreads).
          <br /><br />
          <em>Not financial advice. All parameters are illustrative. Monte Carlo outputs look precise but are only as good as the input assumptions — garbage in, garbage out. Always backtest against out-of-sample data before risking capital.</em>
        </div>
      </div>
    </div>
  );
}
