import React, { useState, useMemo } from 'react';
import { Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, ComposedChart, ReferenceLine, ReferenceArea } from 'recharts';

// ============================================================
// DATA GENERATION
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
// REGIME LOGIC
// ============================================================
const getSuRegime = (su) => {
  if (su < 7) return { name: 'Crisis', shift: 35, widening: 1.8, color: '#8b1a1a' };
  if (su < 10) return { name: 'Scarcity', shift: 18, widening: 1.4, color: '#c0392b' };
  if (su < 12) return { name: 'Tight', shift: 8, widening: 1.15, color: '#d68438' };
  if (su < 15) return { name: 'Balanced', shift: 0, widening: 1.0, color: '#5a8c3a' };
  if (su < 18) return { name: 'Ample', shift: -8, widening: 1.1, color: '#3a7ca5' };
  return { name: 'Oversupply', shift: -15, widening: 1.25, color: '#2a4d6e' };
};

// Weather Stress Index: combines temperature anomaly and precipitation deficit
// Both inputs on 0-100 scale where higher = more stress
const computeWSI = (tempAnomaly, precipAnomaly) => {
  // Temp anomaly: -5 to +10 °F from normal → 0 to 100 stress
  // Precip anomaly: -100% to +50% from normal → 100 to 0 stress
  const tempStress = Math.max(0, Math.min(100, ((tempAnomaly + 2) / 10) * 100));
  const precipStress = Math.max(0, Math.min(100, (-precipAnomaly + 20)));
  // Weighted combination - precipitation matters more during pollination
  return 0.4 * tempStress + 0.6 * precipStress;
};

const getWeatherRegime = (wsi) => {
  if (wsi > 75) return { name: 'Severe Drought', shift: 30, widening: 1.6, color: '#6b1515' };
  if (wsi > 55) return { name: 'Drought Stress', shift: 18, widening: 1.35, color: '#a0302a' };
  if (wsi > 40) return { name: 'Moderate Stress', shift: 8, widening: 1.15, color: '#c26a33' };
  if (wsi > 20) return { name: 'Neutral', shift: 0, widening: 1.0, color: '#8b6f3f' };
  return { name: 'Favorable', shift: -8, widening: 1.0, color: '#3a7c4e' };
};

// Weather effect fades outside pollination window
// Peak effect: weeks 26-32, tapering to zero outside
const weatherSensitivity = (week) => {
  if (week < 20 || week > 38) return 0;
  if (week >= 26 && week <= 32) return 1.0;
  if (week >= 20 && week < 26) return (week - 20) / 6;
  if (week > 32 && week <= 38) return (38 - week) / 6;
  return 0;
};

// ============================================================
// BASELINE COMPUTATION
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

    baseline.push({
      week: w,
      p10: percentile(0.10),
      p25: percentile(0.25),
      p50: percentile(0.50),
      p75: percentile(0.75),
      p90: percentile(0.90),
    });
  }
  return baseline;
};

const weekToMonth = (week) => {
  const date = new Date(2024, 0, 1 + (week - 1) * 7);
  return date.toLocaleString('en-US', { month: 'short' });
};
const weekLabel = (week) => (week === 1 || week % 8 === 0) ? weekToMonth(week) : '';

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function CornModelPhase3() {
  const [yearsToUse, setYearsToUse] = useState(20);
  const [currentWeek, setCurrentWeek] = useState(27); // Mid-July default for weather demo
  const [currentPrice, setCurrentPrice] = useState(4.65);
  const [stocksToUse, setStocksToUse] = useState(12.8);
  const [tempAnomaly, setTempAnomaly] = useState(0); // °F from normal
  const [precipAnomaly, setPrecipAnomaly] = useState(0); // % from normal
  const [showBaseline, setShowBaseline] = useState(false);
  const [showSuOnly, setShowSuOnly] = useState(false);

  const suRegime = getSuRegime(stocksToUse);
  const wsi = computeWSI(tempAnomaly, precipAnomaly);
  const weatherRegime = getWeatherRegime(wsi);
  const baseline = useMemo(() => computeSeasonalBaseline(historicalData, yearsToUse), [yearsToUse]);

  // Apply fundamental adjustments (S/U + weather, week-dependent)
  const adjustedBaseline = useMemo(() => {
    return baseline.map(b => {
      const sensitivity = weatherSensitivity(b.week);
      const weatherShift = weatherRegime.shift * sensitivity;
      const weatherWiden = 1 + (weatherRegime.widening - 1) * sensitivity;

      const totalShift = suRegime.shift + weatherShift;
      const totalWiden = suRegime.widening * weatherWiden;

      return {
        week: b.week,
        p10: b.p50 + (b.p10 - b.p50) * totalWiden + totalShift,
        p25: b.p50 + (b.p25 - b.p50) * totalWiden + totalShift,
        p50: b.p50 + totalShift,
        p75: b.p50 + (b.p75 - b.p50) * totalWiden + totalShift,
        p90: b.p50 + (b.p90 - b.p50) * totalWiden + totalShift,
        // S/U only (for comparison toggle)
        su_p50: b.p50 + suRegime.shift,
        su_p25: b.p50 + (b.p25 - b.p50) * suRegime.widening + suRegime.shift,
        su_p75: b.p50 + (b.p75 - b.p50) * suRegime.widening + suRegime.shift,
        // Pure seasonal
        seasonal_p50: b.p50,
      };
    });
  }, [baseline, suRegime, weatherRegime]);

  const projections = useMemo(() => {
    const currentAdj = adjustedBaseline.find(b => b.week === currentWeek);
    if (!currentAdj) return [];
    const impliedMean = currentPrice / (1 + currentAdj.p50 / 100);

    return adjustedBaseline.map(b => ({
      week: b.week,
      month: weekLabel(b.week),
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
      suOnly_p50: parseFloat((impliedMean * (1 + b.su_p50 / 100)).toFixed(2)),
      seasonal_p50: parseFloat((impliedMean * (1 + b.seasonal_p50 / 100)).toFixed(2)),
    }));
  }, [adjustedBaseline, currentWeek, currentPrice]);

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
      impliedMean,
      target90: impliedMean * (1 + (plus90?.p50 || 0) / 100),
      target180: impliedMean * (1 + (plus180?.p50 || 0) / 100),
      low90: impliedMean * (1 + (plus90?.p25 || 0) / 100),
      high90: impliedMean * (1 + (plus90?.p75 || 0) / 100),
      low180: impliedMean * (1 + (plus180?.p25 || 0) / 100),
      high180: impliedMean * (1 + (plus180?.p75 || 0) / 100),
    };
  }, [adjustedBaseline, currentWeek, currentPrice]);

  const inPollination = currentWeek >= 26 && currentWeek <= 32;
  const weatherActive = weatherSensitivity(currentWeek) > 0;

  return (
    <div style={{ fontFamily: 'Georgia, serif', background: '#f5f0e8', minHeight: '100vh', padding: '24px', color: '#2a2419' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>

        <div style={{ borderBottom: '3px double #8b6f3f', paddingBottom: '16px', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#8b6f3f', marginBottom: '4px' }}>
            PHASE 3 — SEASONAL + S/U + WEATHER
          </div>
          <h1 style={{ fontSize: '36px', margin: '0', fontWeight: 'normal', letterSpacing: '-1px' }}>
            Corn Futures <span style={{ fontStyle: 'italic', color: '#8b6f3f' }}>Weather-Aware Model</span>
          </h1>
          <div style={{ fontSize: '13px', color: '#6b5a3f', marginTop: '8px' }}>
            Pollination window detection · Multi-regime overlay · Conditional stress amplification
          </div>
        </div>

        {/* Dual regime banner */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
          <div style={{ background: suRegime.color, color: '#fff', padding: '16px' }}>
            <div style={{ fontSize: '10px', letterSpacing: '2px', opacity: 0.8 }}>FUNDAMENTAL REGIME</div>
            <div style={{ fontSize: '24px' }}>{suRegime.name}</div>
            <div style={{ fontSize: '12px', opacity: 0.8 }}>
              S/U: {stocksToUse.toFixed(1)}% · Shift: {suRegime.shift > 0 ? '+' : ''}{suRegime.shift}%
            </div>
          </div>
          <div style={{ background: weatherActive ? weatherRegime.color : '#8b8572', color: '#fff', padding: '16px', position: 'relative' }}>
            <div style={{ fontSize: '10px', letterSpacing: '2px', opacity: 0.8 }}>WEATHER REGIME</div>
            <div style={{ fontSize: '24px' }}>
              {weatherActive ? weatherRegime.name : 'Dormant'}
            </div>
            <div style={{ fontSize: '12px', opacity: 0.8 }}>
              WSI: {wsi.toFixed(0)} · Sensitivity: {(weatherSensitivity(currentWeek) * 100).toFixed(0)}%
            </div>
            {!weatherActive && (
              <div style={{ position: 'absolute', top: '8px', right: '8px', fontSize: '10px', opacity: 0.7 }}>
                outside pollination window
              </div>
            )}
          </div>
        </div>

        {/* Controls row 1: timing + price */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '16px', background: '#ede4d3', padding: '16px', border: '1px solid #c4a76a' }}>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>LOOKBACK YEARS</label>
            <input type="range" min="5" max="25" value={yearsToUse} onChange={(e) => setYearsToUse(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '15px' }}>{yearsToUse} yrs</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>CURRENT WEEK</label>
            <input type="range" min="1" max="52" value={currentWeek} onChange={(e) => setCurrentWeek(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '15px' }}>W{currentWeek} · {weekToMonth(currentWeek)} {inPollination && <span style={{ color: '#c0392b', fontSize: '11px', fontWeight: 'bold' }}>★ POLLINATION</span>}</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>CURRENT PRICE ($/BU)</label>
            <input type="number" step="0.05" value={currentPrice} onChange={(e) => setCurrentPrice(parseFloat(e.target.value) || 0)} style={{ width: '100%', padding: '4px', fontSize: '14px', border: '1px solid #8b6f3f', background: '#f5f0e8', fontFamily: 'Georgia, serif' }} />
            <div style={{ fontSize: '11px', color: '#6b5a3f' }}>Implied mean: ${currentStats.impliedMean.toFixed(2)}</div>
          </div>
        </div>

        {/* Controls row 2: fundamentals + weather */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '24px', background: '#ede4d3', padding: '16px', border: '1px solid #c4a76a' }}>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>STOCKS-TO-USE %</label>
            <input type="range" min="5" max="22" step="0.1" value={stocksToUse} onChange={(e) => setStocksToUse(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '15px', color: suRegime.color }}>{stocksToUse.toFixed(1)}%</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>TEMP ANOMALY (°F)</label>
            <input type="range" min="-5" max="10" step="0.5" value={tempAnomaly} onChange={(e) => setTempAnomaly(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '15px', color: tempAnomaly > 3 ? '#c0392b' : tempAnomaly < -1 ? '#3a7ca5' : '#2a2419' }}>
              {tempAnomaly > 0 ? '+' : ''}{tempAnomaly.toFixed(1)}°F vs. normal
            </div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>PRECIP ANOMALY (%)</label>
            <input type="range" min="-80" max="50" step="5" value={precipAnomaly} onChange={(e) => setPrecipAnomaly(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '15px', color: precipAnomaly < -30 ? '#c0392b' : precipAnomaly > 15 ? '#3a7c4e' : '#2a2419' }}>
              {precipAnomaly > 0 ? '+' : ''}{precipAnomaly}% vs. normal
            </div>
          </div>
        </div>

        {/* Scenario presets */}
        <div style={{ background: '#fff', padding: '12px 16px', marginBottom: '24px', border: '1px solid #c4a76a' }}>
          <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', marginBottom: '8px' }}>HISTORICAL SCENARIO PRESETS</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {[
              { name: '2012 Drought', su: 12.8, temp: 6, precip: -55, week: 28, label: 'Balanced S/U → July drought' },
              { name: '2016 Glut', su: 15.7, temp: 0, precip: 10, week: 28, label: 'Record yields, ample supply' },
              { name: '2020 COVID', su: 8.3, temp: 1, precip: -10, week: 28, label: 'Tight stocks, demand shock' },
              { name: '2022 Tight', su: 9.6, temp: 3, precip: -25, week: 28, label: 'Scarcity + stress' },
              { name: 'Reset Normal', su: 13, temp: 0, precip: 0, week: 17, label: 'Baseline conditions' },
            ].map(s => (
              <button key={s.name} onClick={() => { setStocksToUse(s.su); setTempAnomaly(s.temp); setPrecipAnomaly(s.precip); setCurrentWeek(s.week); }}
                style={{ background: '#2a2419', color: '#f5f0e8', border: 'none', padding: '6px 12px', fontSize: '12px', fontFamily: 'Georgia, serif', cursor: 'pointer', letterSpacing: '1px' }}
                title={s.label}>
                {s.name}
              </button>
            ))}
          </div>
        </div>

        {/* Main chart */}
        <div style={{ background: '#fff', padding: '24px', border: '1px solid #c4a76a', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h2 style={{ fontSize: '20px', marginTop: 0, marginBottom: '4px', fontWeight: 'normal' }}>
                Full model projection
              </h2>
              <div style={{ fontSize: '12px', color: '#6b5a3f' }}>
                Bands reflect seasonal patterns + {suRegime.name} S/U regime + {weatherRegime.name} weather (active weeks 20–38)
              </div>
            </div>
            <div style={{ display: 'flex', gap: '16px' }}>
              <label style={{ fontSize: '12px', color: '#6b5a3f', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input type="checkbox" checked={showSuOnly} onChange={(e) => setShowSuOnly(e.target.checked)} />
                Show S/U-only line
              </label>
              <label style={{ fontSize: '12px', color: '#6b5a3f', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} />
                Show seasonal-only line
              </label>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={420}>
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
              {/* Pollination window shading */}
              <ReferenceArea x1={26} x2={32} fill="#c0392b" fillOpacity={0.06} label={{ value: 'Pollination', position: 'top', fill: '#c0392b', fontSize: 11 }} />
              <ReferenceArea x1={20} x2={38} fill="#c0392b" fillOpacity={0.02} />
              <Area type="monotone" dataKey="band10to90" fill={weatherActive ? weatherRegime.color : suRegime.color} fillOpacity={0.15} stroke="none" name="10-90th %ile" />
              <Area type="monotone" dataKey="band25to75" fill={weatherActive ? weatherRegime.color : suRegime.color} fillOpacity={0.30} stroke="none" name="25-75th %ile" />
              <Line type="monotone" dataKey="p50Price" stroke={weatherActive ? weatherRegime.color : suRegime.color} strokeWidth={2.5} dot={false} name="Full model median" />
              {showSuOnly && <Line type="monotone" dataKey="suOnly_p50" stroke="#c26a33" strokeWidth={1.5} strokeDasharray="4 4" dot={false} name="S/U only (Phase 2)" />}
              {showBaseline && <Line type="monotone" dataKey="seasonal_p50" stroke="#8b6f3f" strokeWidth={1.5} strokeDasharray="2 3" dot={false} name="Seasonal only (Phase 1)" />}
              <ReferenceLine x={currentWeek} stroke="#2a2419" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="currentMarker" stroke="#2a2419" strokeWidth={0} dot={{ r: 6, fill: '#2a2419' }} name="Current price" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Price targets */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a', borderLeft: `4px solid ${weatherActive ? weatherRegime.color : suRegime.color}` }}>
            <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f' }}>3-MONTH TARGET</div>
            <div style={{ fontSize: '32px', margin: '8px 0', color: weatherActive ? weatherRegime.color : suRegime.color }}>
              ${currentStats.target90.toFixed(2)}
            </div>
            <div style={{ fontSize: '13px', color: '#6b5a3f' }}>
              vs. ${currentPrice.toFixed(2)} · {((currentStats.target90 / currentPrice - 1) * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: '12px', color: '#8b6f3f', marginTop: '8px' }}>
              25-75th: ${currentStats.low90.toFixed(2)} – ${currentStats.high90.toFixed(2)}
            </div>
          </div>
          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a', borderLeft: `4px solid ${weatherActive ? weatherRegime.color : suRegime.color}` }}>
            <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f' }}>6-MONTH TARGET</div>
            <div style={{ fontSize: '32px', margin: '8px 0', color: weatherActive ? weatherRegime.color : suRegime.color }}>
              ${currentStats.target180.toFixed(2)}
            </div>
            <div style={{ fontSize: '13px', color: '#6b5a3f' }}>
              vs. ${currentPrice.toFixed(2)} · {((currentStats.target180 / currentPrice - 1) * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: '12px', color: '#8b6f3f', marginTop: '8px' }}>
              25-75th: ${currentStats.low180.toFixed(2)} – ${currentStats.high180.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Weather sensitivity curve */}
        <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a', marginBottom: '24px' }}>
          <h3 style={{ fontSize: '14px', letterSpacing: '2px', color: '#8b6f3f', marginTop: 0, fontWeight: 'normal' }}>
            WEATHER EFFECT BY WEEK
          </h3>
          <div style={{ fontSize: '12px', color: '#6b5a3f', marginBottom: '12px' }}>
            Weather stress only affects price projections during the corn reproductive window (weeks 20–38), peaking during pollination (26–32)
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <ComposedChart data={Array.from({ length: 52 }, (_, i) => ({ week: i + 1, sensitivity: weatherSensitivity(i + 1) * 100 }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d4c4a0" />
              <XAxis dataKey="week" tickFormatter={weekLabel} stroke="#6b5a3f" />
              <YAxis stroke="#6b5a3f" tickFormatter={(v) => `${v}%`} />
              <Tooltip contentStyle={{ background: '#f5f0e8', border: '1px solid #8b6f3f', fontFamily: 'Georgia, serif' }} labelFormatter={(w) => `Week ${w}`} formatter={(v) => `${v.toFixed(0)}%`} />
              <Area type="monotone" dataKey="sensitivity" fill="#c0392b" fillOpacity={0.3} stroke="#c0392b" strokeWidth={2} name="Weather sensitivity" />
              <ReferenceLine x={currentWeek} stroke="#2a2419" strokeDasharray="4 4" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Interpretation */}
        <div style={{ background: '#2a2419', color: '#f5f0e8', padding: '24px', border: '1px solid #8b6f3f', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#c4a76a', marginBottom: '12px' }}>MODEL SYNTHESIS</div>
          <div style={{ fontSize: '15px', lineHeight: '1.8' }}>
            <strong>Fundamentals:</strong> S/U at {stocksToUse.toFixed(1)}% ({suRegime.name} regime) shifts the seasonal baseline by {suRegime.shift > 0 ? '+' : ''}{suRegime.shift}%.
            {weatherActive ? (
              <> <strong>Weather:</strong> WSI of {wsi.toFixed(0)} ({weatherRegime.name}) adds another {(weatherRegime.shift * weatherSensitivity(currentWeek)).toFixed(0)}% at current sensitivity ({(weatherSensitivity(currentWeek) * 100).toFixed(0)}%).</>
            ) : (
              <> <strong>Weather:</strong> Outside pollination window — weather anomalies have minimal direct price impact.</>
            )}
            {inPollination && wsi > 55 && <> <strong style={{ color: '#c0392b' }}>You are in the critical pollination window with significant stress — this is a 2012-type setup where prices can move 40%+ in weeks.</strong></>}
            {inPollination && wsi < 20 && <> The pollination window with favorable weather points toward bumper crop pricing — rare but strongly bearish.</>}
          </div>
        </div>

        {/* Next phase teaser */}
        <div style={{ padding: '16px', background: '#ede4d3', fontSize: '12px', color: '#6b5a3f', lineHeight: '1.6' }}>
          <strong>What changed from Phase 2:</strong> Weather now modifies projections but only during the reproductive window. Try the <em>2012 Drought</em> preset — balanced S/U (not alarming on its own) + July heat + severe precip deficit → huge upside projection. That's exactly the dynamic that caught markets off guard in 2012.
          <br /><br />
          <strong>Still missing:</strong> Positioning data (COT report) — when managed money is maximally long going into pollination, rallies tend to exhaust faster. Phase 4 adds this as a contrarian filter.
          <br /><br />
          <em>Not financial advice. Weather coefficients are illustrative; real-world implementations use NOAA gridded data and often yield-model outputs rather than simple anomalies.</em>
        </div>
      </div>
    </div>
  );
}
