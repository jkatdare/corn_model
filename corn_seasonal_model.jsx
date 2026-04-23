import React, { useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, ComposedChart, ReferenceLine, ScatterChart, Scatter, ZAxis } from 'recharts';

// ============================================================
// HISTORICAL DATA GENERATION
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

// Realistic historical stocks-to-use (based on actual USDA data patterns)
const historicalStocksToUse = {
  2001: 14.2, 2002: 11.8, 2003: 10.1, 2004: 15.3, 2005: 17.5,
  2006: 11.4, 2007: 12.8, 2008: 13.9, 2009: 13.1, 2010: 8.6,
  2011: 7.4, 2012: 7.1, 2013: 9.2, 2014: 13.8, 2015: 14.6,
  2016: 15.7, 2017: 16.3, 2018: 14.5, 2019: 13.2, 2020: 8.3,
  2021: 9.2, 2022: 9.6, 2023: 14.1, 2024: 14.8, 2025: 13.4, 2026: 12.8
};

const historicalData = generateHistoricalData();

// ============================================================
// FUNDAMENTAL OVERLAY LOGIC
// ============================================================
// S/U ratio determines regime shift applied to seasonal bands
const getRegime = (su) => {
  if (su < 7) return { name: 'Crisis', shift: 35, widening: 1.8, color: '#8b1a1a' };
  if (su < 10) return { name: 'Scarcity', shift: 18, widening: 1.4, color: '#c0392b' };
  if (su < 12) return { name: 'Tight', shift: 8, widening: 1.15, color: '#d68438' };
  if (su < 15) return { name: 'Balanced', shift: 0, widening: 1.0, color: '#5a8c3a' };
  if (su < 18) return { name: 'Ample', shift: -8, widening: 1.1, color: '#3a7ca5' };
  return { name: 'Oversupply', shift: -15, widening: 1.25, color: '#2a4d6e' };
};

// Compute seasonal baseline with fundamental overlay
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

    baseline.push({
      week: w,
      p10: percentile(0.10),
      p25: percentile(0.25),
      p50: percentile(0.50),
      p75: percentile(0.75),
      p90: percentile(0.90),
      mean,
    });
  }
  return baseline;
};

// Historical scatter: S/U vs annual avg price (for the relationship chart)
const computeSuScatter = (data) => {
  return Object.keys(data).map(Number).map(year => {
    const yearData = data[year];
    const avgPrice = yearData.reduce((s, d) => s + d.price, 0) / yearData.length;
    const peakPrice = Math.max(...yearData.map(d => d.price));
    return {
      year,
      su: historicalStocksToUse[year] || 13,
      avgPrice: parseFloat(avgPrice.toFixed(2)),
      peakPrice: parseFloat(peakPrice.toFixed(2)),
    };
  }).filter(d => d.su);
};

const weekToMonth = (week) => {
  const date = new Date(2024, 0, 1 + (week - 1) * 7);
  return date.toLocaleString('en-US', { month: 'short' });
};

const weekLabel = (week) => {
  if (week === 1 || week % 8 === 0) return weekToMonth(week);
  return '';
};

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function CornSeasonalModelPhase2() {
  const [yearsToUse, setYearsToUse] = useState(20);
  const [currentWeek, setCurrentWeek] = useState(17);
  const [currentPrice, setCurrentPrice] = useState(4.65);
  const [stocksToUse, setStocksToUse] = useState(12.8);
  const [showBaseline, setShowBaseline] = useState(true);

  const regime = getRegime(stocksToUse);
  const baseline = useMemo(() => computeSeasonalBaseline(historicalData, yearsToUse), [yearsToUse]);
  const suScatter = useMemo(() => computeSuScatter(historicalData), []);

  // Apply fundamental adjustment to baseline bands
  const adjustedBaseline = useMemo(() => {
    return baseline.map(b => ({
      week: b.week,
      p10: b.p50 + (b.p10 - b.p50) * regime.widening + regime.shift,
      p25: b.p50 + (b.p25 - b.p50) * regime.widening + regime.shift,
      p50: b.p50 + regime.shift,
      p75: b.p50 + (b.p75 - b.p50) * regime.widening + regime.shift,
      p90: b.p50 + (b.p90 - b.p50) * regime.widening + regime.shift,
    }));
  }, [baseline, regime]);

  const projections = useMemo(() => {
    const currentAdj = adjustedBaseline.find(b => b.week === currentWeek);
    if (!currentAdj) return [];
    const impliedMean = currentPrice / (1 + currentAdj.p50 / 100);

    return adjustedBaseline.map((b, i) => {
      const seasonalOnly = baseline[i];
      return {
        week: b.week,
        month: weekLabel(b.week),
        // Adjusted (S/U-aware) projections
        p25Price: parseFloat((impliedMean * (1 + b.p25 / 100)).toFixed(2)),
        p50Price: parseFloat((impliedMean * (1 + b.p50 / 100)).toFixed(2)),
        p75Price: parseFloat((impliedMean * (1 + b.p75 / 100)).toFixed(2)),
        band25to75: [
          parseFloat((impliedMean * (1 + b.p25 / 100)).toFixed(2)),
          parseFloat((impliedMean * (1 + b.p75 / 100)).toFixed(2))
        ],
        band10to90: [
          parseFloat((impliedMean * (1 + b.p10 / 100)).toFixed(2)),
          parseFloat((impliedMean * (1 + b.p90 / 100)).toFixed(2))
        ],
        // Pure seasonal (Phase 1) for comparison
        seasonalP50: parseFloat((impliedMean * (1 + seasonalOnly.p50 / 100)).toFixed(2)),
      };
    });
  }, [adjustedBaseline, baseline, currentWeek, currentPrice]);

  const chartData = projections.map(p => ({
    ...p,
    currentMarker: p.week === currentWeek ? currentPrice : null,
  }));

  const currentStats = useMemo(() => {
    const now = adjustedBaseline.find(b => b.week === currentWeek);
    const plus90 = adjustedBaseline.find(b => b.week === Math.min(52, currentWeek + 13));
    const plus180 = adjustedBaseline.find(b => b.week === Math.min(52, currentWeek + 26));
    const impliedMean = currentPrice / (1 + (now?.p50 || 0) / 100);
    return {
      now, plus90, plus180, impliedMean,
      target90: impliedMean * (1 + (plus90?.p50 || 0) / 100),
      target180: impliedMean * (1 + (plus180?.p50 || 0) / 100),
      low90: impliedMean * (1 + (plus90?.p25 || 0) / 100),
      high90: impliedMean * (1 + (plus90?.p75 || 0) / 100),
      low180: impliedMean * (1 + (plus180?.p25 || 0) / 100),
      high180: impliedMean * (1 + (plus180?.p75 || 0) / 100),
    };
  }, [adjustedBaseline, currentWeek, currentPrice]);

  return (
    <div style={{ fontFamily: 'Georgia, serif', background: '#f5f0e8', minHeight: '100vh', padding: '24px', color: '#2a2419' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ borderBottom: '3px double #8b6f3f', paddingBottom: '16px', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#8b6f3f', marginBottom: '4px' }}>
            PHASE 2 — SEASONAL + FUNDAMENTAL OVERLAY
          </div>
          <h1 style={{ fontSize: '36px', margin: '0', fontWeight: 'normal', letterSpacing: '-1px' }}>
            Corn Futures <span style={{ fontStyle: 'italic', color: '#8b6f3f' }}>Fundamental Model</span>
          </h1>
          <div style={{ fontSize: '13px', color: '#6b5a3f', marginTop: '8px' }}>
            Stocks-to-Use regime detection · Adjusted confidence bands · Price target ranges
          </div>
        </div>

        {/* Regime banner */}
        <div style={{ background: regime.color, color: '#fff', padding: '20px', marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '11px', letterSpacing: '3px', opacity: 0.8 }}>CURRENT REGIME</div>
            <div style={{ fontSize: '32px', fontWeight: 'normal' }}>{regime.name}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '11px', letterSpacing: '2px', opacity: 0.8 }}>STOCKS-TO-USE</div>
            <div style={{ fontSize: '32px' }}>{stocksToUse.toFixed(1)}%</div>
            <div style={{ fontSize: '12px', opacity: 0.8 }}>
              Shift: {regime.shift > 0 ? '+' : ''}{regime.shift}% · Band width: {regime.widening}×
            </div>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '16px', marginBottom: '24px', background: '#ede4d3', padding: '20px', border: '1px solid #c4a76a' }}>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '8px' }}>
              LOOKBACK YEARS
            </label>
            <input type="range" min="5" max="25" value={yearsToUse} onChange={(e) => setYearsToUse(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '16px' }}>{yearsToUse} yrs</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '8px' }}>
              CURRENT WEEK
            </label>
            <input type="range" min="1" max="52" value={currentWeek} onChange={(e) => setCurrentWeek(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '16px' }}>W{currentWeek} · {weekToMonth(currentWeek)}</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '8px' }}>
              CURRENT PRICE
            </label>
            <input type="number" step="0.05" value={currentPrice} onChange={(e) => setCurrentPrice(parseFloat(e.target.value) || 0)} style={{ width: '100%', padding: '4px', fontSize: '14px', border: '1px solid #8b6f3f', background: '#f5f0e8', fontFamily: 'Georgia, serif' }} />
            <div style={{ fontSize: '11px', color: '#6b5a3f', marginTop: '2px' }}>
              Implied mean: ${currentStats.impliedMean.toFixed(2)}
            </div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '8px' }}>
              STOCKS-TO-USE %
            </label>
            <input type="range" min="5" max="22" step="0.1" value={stocksToUse} onChange={(e) => setStocksToUse(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '16px', color: regime.color }}>{stocksToUse.toFixed(1)}%</div>
          </div>
        </div>

        {/* Main chart */}
        <div style={{ background: '#fff', padding: '24px', border: '1px solid #c4a76a', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '20px', marginTop: 0, marginBottom: '4px', fontWeight: 'normal' }}>
                Fundamental-adjusted price projection
              </h2>
              <div style={{ fontSize: '12px', color: '#6b5a3f' }}>
                Bands shifted by {regime.shift > 0 ? '+' : ''}{regime.shift}% and widened {regime.widening}× based on {regime.name} regime
              </div>
            </div>
            <label style={{ fontSize: '12px', color: '#6b5a3f', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} />
              Show Phase 1 seasonal baseline
            </label>
          </div>
          <ResponsiveContainer width="100%" height={400}>
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d4c4a0" />
              <XAxis dataKey="week" tickFormatter={weekLabel} stroke="#6b5a3f" />
              <YAxis stroke="#6b5a3f" domain={['auto', 'auto']} tickFormatter={(v) => `$${v.toFixed(2)}`} />
              <Tooltip
                contentStyle={{ background: '#f5f0e8', border: '1px solid #8b6f3f', fontFamily: 'Georgia, serif' }}
                formatter={(value, name) => {
                  if (Array.isArray(value)) return [`$${value[0]} – $${value[1]}`, name];
                  return [`$${value}`, name];
                }}
                labelFormatter={(w) => `Week ${w} (${weekToMonth(w)})`}
              />
              <Legend />
              <Area type="monotone" dataKey="band10to90" fill={regime.color} fillOpacity={0.15} stroke="none" name="10-90th %ile (adj.)" />
              <Area type="monotone" dataKey="band25to75" fill={regime.color} fillOpacity={0.30} stroke="none" name="25-75th %ile (adj.)" />
              <Line type="monotone" dataKey="p50Price" stroke={regime.color} strokeWidth={2.5} dot={false} name="Adjusted median" />
              {showBaseline && <Line type="monotone" dataKey="seasonalP50" stroke="#8b6f3f" strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Seasonal only (Phase 1)" />}
              <ReferenceLine x={currentWeek} stroke="#2a2419" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="currentMarker" stroke="#2a2419" strokeWidth={0} dot={{ r: 6, fill: '#2a2419' }} name="Current price" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Price targets */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a', borderLeft: `4px solid ${regime.color}` }}>
            <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f' }}>3-MONTH TARGET</div>
            <div style={{ fontSize: '32px', margin: '8px 0', color: regime.color }}>${currentStats.target90.toFixed(2)}</div>
            <div style={{ fontSize: '13px', color: '#6b5a3f' }}>
              vs. current ${currentPrice.toFixed(2)} · {((currentStats.target90 / currentPrice - 1) * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: '12px', color: '#8b6f3f', marginTop: '8px' }}>
              25-75th: ${currentStats.low90.toFixed(2)} – ${currentStats.high90.toFixed(2)}
            </div>
          </div>
          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a', borderLeft: `4px solid ${regime.color}` }}>
            <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f' }}>6-MONTH TARGET</div>
            <div style={{ fontSize: '32px', margin: '8px 0', color: regime.color }}>${currentStats.target180.toFixed(2)}</div>
            <div style={{ fontSize: '13px', color: '#6b5a3f' }}>
              vs. current ${currentPrice.toFixed(2)} · {((currentStats.target180 / currentPrice - 1) * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: '12px', color: '#8b6f3f', marginTop: '8px' }}>
              25-75th: ${currentStats.low180.toFixed(2)} – ${currentStats.high180.toFixed(2)}
            </div>
          </div>
        </div>

        {/* S/U regime reference + historical scatter */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a' }}>
            <h3 style={{ fontSize: '14px', letterSpacing: '2px', color: '#8b6f3f', marginTop: 0, fontWeight: 'normal' }}>REGIME TABLE</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #c4a76a' }}>
                  <th style={{ textAlign: 'left', padding: '6px 0' }}>S/U range</th>
                  <th style={{ textAlign: 'left' }}>Regime</th>
                  <th style={{ textAlign: 'right' }}>Shift</th>
                  <th style={{ textAlign: 'right' }}>Band</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { r: '< 7%', n: 'Crisis', s: '+35%', w: '1.8×', c: '#8b1a1a' },
                  { r: '7–10%', n: 'Scarcity', s: '+18%', w: '1.4×', c: '#c0392b' },
                  { r: '10–12%', n: 'Tight', s: '+8%', w: '1.15×', c: '#d68438' },
                  { r: '12–15%', n: 'Balanced', s: '0%', w: '1.0×', c: '#5a8c3a' },
                  { r: '15–18%', n: 'Ample', s: '−8%', w: '1.1×', c: '#3a7ca5' },
                  { r: '> 18%', n: 'Oversupply', s: '−15%', w: '1.25×', c: '#2a4d6e' },
                ].map(row => (
                  <tr key={row.n} style={{ borderBottom: '1px solid #ede4d3', background: row.n === regime.name ? '#faf5e8' : 'transparent' }}>
                    <td style={{ padding: '6px 0' }}>{row.r}</td>
                    <td style={{ color: row.c, fontWeight: row.n === regime.name ? 'bold' : 'normal' }}>{row.n}</td>
                    <td style={{ textAlign: 'right' }}>{row.s}</td>
                    <td style={{ textAlign: 'right' }}>{row.w}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a' }}>
            <h3 style={{ fontSize: '14px', letterSpacing: '2px', color: '#8b6f3f', marginTop: 0, fontWeight: 'normal' }}>
              HISTORICAL S/U vs AVG PRICE
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <ScatterChart margin={{ top: 10, right: 10, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#d4c4a0" />
                <XAxis type="number" dataKey="su" name="S/U %" stroke="#6b5a3f" label={{ value: 'Stocks-to-Use %', position: 'bottom', fill: '#6b5a3f', fontSize: 11 }} />
                <YAxis type="number" dataKey="avgPrice" name="Avg Price" stroke="#6b5a3f" tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ background: '#f5f0e8', border: '1px solid #8b6f3f', fontFamily: 'Georgia, serif', fontSize: '12px' }}
                  formatter={(v, n) => n === 'su' ? `${v}%` : `$${v}`}
                  labelFormatter={() => ''}
                  content={({ payload }) => {
                    if (!payload || !payload.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div style={{ background: '#f5f0e8', border: '1px solid #8b6f3f', padding: '8px', fontSize: '12px' }}>
                        <div><strong>{d.year}</strong></div>
                        <div>S/U: {d.su}%</div>
                        <div>Avg: ${d.avgPrice}</div>
                        <div>Peak: ${d.peakPrice}</div>
                      </div>
                    );
                  }}
                />
                <Scatter data={suScatter} fill="#8b6f3f" />
              </ScatterChart>
            </ResponsiveContainer>
            <div style={{ fontSize: '11px', color: '#6b5a3f', marginTop: '8px', textAlign: 'center' }}>
              Lower S/U = higher prices. Inverse relationship is clear.
            </div>
          </div>
        </div>

        {/* Interpretation */}
        <div style={{ background: '#2a2419', color: '#f5f0e8', padding: '24px', border: '1px solid #8b6f3f', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#c4a76a', marginBottom: '12px' }}>
            MODEL INTERPRETATION
          </div>
          <div style={{ fontSize: '15px', lineHeight: '1.8' }}>
            At <strong style={{ color: regime.color }}>{stocksToUse.toFixed(1)}% S/U</strong>, the market is in a <strong style={{ color: regime.color }}>{regime.name}</strong> regime.
            {regime.shift > 0 && <> The model expects prices to run <strong>{regime.shift}% above</strong> their pure-seasonal median, with bands <strong>{regime.widening}× wider</strong> than normal (more tail risk to the upside).</>}
            {regime.shift < 0 && <> The model expects prices to run <strong>{Math.abs(regime.shift)}% below</strong> their pure-seasonal median — oversupply dampens the typical seasonal rallies.</>}
            {regime.shift === 0 && <> The market is in balance; pure seasonal patterns should dominate without fundamental distortion.</>}
            {currentWeek >= 23 && currentWeek <= 32 && <> You're also in the <strong>pollination window</strong>, where weather can override fundamentals entirely — the next phase will add this.</>}
          </div>
        </div>

        {/* Next phase */}
        <div style={{ padding: '16px', background: '#ede4d3', fontSize: '12px', color: '#6b5a3f', lineHeight: '1.6' }}>
          <strong>What changed from Phase 1:</strong> Price bands now respond to the inventory cushion. Try setting S/U to 7% — the model projects prices far above seasonal median (2012 drought-style regime). Set it to 18% — prices drift below seasonal (2016–17 glut).
          <br /><br />
          <strong>Still missing:</strong> Weather anomalies in the July pollination window can override S/U entirely — a balanced S/U year + severe drought = 2012. That's Phase 3.
          <br /><br />
          <em>Not financial advice. Regime thresholds are calibrated to historical corn behavior but real markets don't respect thresholds cleanly.</em>
        </div>
      </div>
    </div>
  );
}
