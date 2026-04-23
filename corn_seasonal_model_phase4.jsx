import React, { useState, useMemo } from 'react';
import { Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, ComposedChart, ReferenceLine, ReferenceArea, Bar } from 'recharts';

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

const computeWSI = (tempAnomaly, precipAnomaly) => {
  const tempStress = Math.max(0, Math.min(100, ((tempAnomaly + 2) / 10) * 100));
  const precipStress = Math.max(0, Math.min(100, (-precipAnomaly + 20)));
  return 0.4 * tempStress + 0.6 * precipStress;
};

const getWeatherRegime = (wsi) => {
  if (wsi > 75) return { name: 'Severe Drought', shift: 30, widening: 1.6, color: '#6b1515' };
  if (wsi > 55) return { name: 'Drought Stress', shift: 18, widening: 1.35, color: '#a0302a' };
  if (wsi > 40) return { name: 'Moderate Stress', shift: 8, widening: 1.15, color: '#c26a33' };
  if (wsi > 20) return { name: 'Neutral', shift: 0, widening: 1.0, color: '#8b6f3f' };
  return { name: 'Favorable', shift: -8, widening: 1.0, color: '#3a7c4e' };
};

const weatherSensitivity = (week) => {
  if (week < 20 || week > 38) return 0;
  if (week >= 26 && week <= 32) return 1.0;
  if (week >= 20 && week < 26) return (week - 20) / 6;
  if (week > 32 && week <= 38) return (38 - week) / 6;
  return 0;
};

// COT positioning: percentile score 0-100
// Higher = more net long managed money = more bearish contrarian signal
const getCotRegime = (percentile) => {
  if (percentile > 90) return {
    name: 'Extreme Long',
    upCap: -12,      // caps upside
    downExtend: 8,   // extends downside risk
    widening: 1.25,
    color: '#8b1a1a',
    bias: 'bearish'
  };
  if (percentile > 75) return {
    name: 'Crowded Long',
    upCap: -6,
    downExtend: 4,
    widening: 1.1,
    color: '#c0392b',
    bias: 'bearish'
  };
  if (percentile > 55) return {
    name: 'Elevated Long',
    upCap: -2,
    downExtend: 1,
    widening: 1.0,
    color: '#d68438',
    bias: 'mildly bearish'
  };
  if (percentile >= 40) return {
    name: 'Neutral',
    upCap: 0,
    downExtend: 0,
    widening: 1.0,
    color: '#8b6f3f',
    bias: 'none'
  };
  if (percentile >= 20) return {
    name: 'Elevated Short',
    upCap: 2,
    downExtend: -1,
    widening: 1.0,
    color: '#6b8e4e',
    bias: 'mildly bullish'
  };
  if (percentile >= 10) return {
    name: 'Crowded Short',
    upCap: 6,
    downExtend: -4,
    widening: 1.1,
    color: '#3a7ca5',
    bias: 'bullish'
  };
  return {
    name: 'Extreme Short',
    upCap: 12,
    downExtend: -8,
    widening: 1.25,
    color: '#2a4d6e',
    bias: 'bullish'
  };
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
export default function CornModelPhase4() {
  const [yearsToUse, setYearsToUse] = useState(20);
  const [currentWeek, setCurrentWeek] = useState(27);
  const [currentPrice, setCurrentPrice] = useState(4.65);
  const [stocksToUse, setStocksToUse] = useState(12.8);
  const [tempAnomaly, setTempAnomaly] = useState(0);
  const [precipAnomaly, setPrecipAnomaly] = useState(0);
  const [cotPercentile, setCotPercentile] = useState(50);

  const [showLayers, setShowLayers] = useState({ seasonal: false, su: false, weather: false });

  const suRegime = getSuRegime(stocksToUse);
  const wsi = computeWSI(tempAnomaly, precipAnomaly);
  const weatherRegime = getWeatherRegime(wsi);
  const cotRegime = getCotRegime(cotPercentile);
  const baseline = useMemo(() => computeSeasonalBaseline(historicalData, yearsToUse), [yearsToUse]);

  // Apply all four layers
  const adjustedBaseline = useMemo(() => {
    return baseline.map(b => {
      const sensitivity = weatherSensitivity(b.week);
      const weatherShift = weatherRegime.shift * sensitivity;
      const weatherWiden = 1 + (weatherRegime.widening - 1) * sensitivity;

      // Total shift (additive)
      const fundShift = suRegime.shift + weatherShift;
      const fundWiden = suRegime.widening * weatherWiden;

      // Seasonal + fundamentals
      const sf_p10 = b.p50 + (b.p10 - b.p50) * fundWiden + fundShift;
      const sf_p25 = b.p50 + (b.p25 - b.p50) * fundWiden + fundShift;
      const sf_p50 = b.p50 + fundShift;
      const sf_p75 = b.p50 + (b.p75 - b.p50) * fundWiden + fundShift;
      const sf_p90 = b.p50 + (b.p90 - b.p50) * fundWiden + fundShift;

      // Apply COT asymmetrically: upCap affects upper tail, downExtend affects lower tail
      // Median shifts by average of the two effects
      const cotMedianShift = (cotRegime.upCap + cotRegime.downExtend) / 2;

      const full_p50 = sf_p50 + cotMedianShift;
      const full_p75 = sf_p75 + cotRegime.upCap;
      const full_p90 = sf_p90 + cotRegime.upCap * 1.3;
      const full_p25 = sf_p25 + cotRegime.downExtend;
      const full_p10 = sf_p10 + cotRegime.downExtend * 1.3;

      // Widen if positioning is extreme
      const finalWiden = cotRegime.widening;
      const final_p10 = full_p50 + (full_p10 - full_p50) * finalWiden;
      const final_p25 = full_p50 + (full_p25 - full_p50) * finalWiden;
      const final_p75 = full_p50 + (full_p75 - full_p50) * finalWiden;
      const final_p90 = full_p50 + (full_p90 - full_p50) * finalWiden;

      return {
        week: b.week,
        // Full model
        p10: final_p10, p25: final_p25, p50: full_p50, p75: final_p75, p90: final_p90,
        // Comparison layers
        seasonal_p50: b.p50,
        su_p50: b.p50 + suRegime.shift,
        sw_p50: sf_p50, // seasonal + S/U + weather
      };
    });
  }, [baseline, suRegime, weatherRegime, cotRegime]);

  const projections = useMemo(() => {
    const currentAdj = adjustedBaseline.find(b => b.week === currentWeek);
    if (!currentAdj) return [];
    const impliedMean = currentPrice / (1 + currentAdj.p50 / 100);

    return adjustedBaseline.map(b => ({
      week: b.week,
      month: weekLabel(b.week),
      p50Price: parseFloat((impliedMean * (1 + b.p50 / 100)).toFixed(2)),
      band25to75: [
        parseFloat((impliedMean * (1 + b.p25 / 100)).toFixed(2)),
        parseFloat((impliedMean * (1 + b.p75 / 100)).toFixed(2))
      ],
      band10to90: [
        parseFloat((impliedMean * (1 + b.p10 / 100)).toFixed(2)),
        parseFloat((impliedMean * (1 + b.p90 / 100)).toFixed(2))
      ],
      seasonal_p50: parseFloat((impliedMean * (1 + b.seasonal_p50 / 100)).toFixed(2)),
      su_p50: parseFloat((impliedMean * (1 + b.su_p50 / 100)).toFixed(2)),
      sw_p50: parseFloat((impliedMean * (1 + b.sw_p50 / 100)).toFixed(2)),
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
      extreme90Low: impliedMean * (1 + (plus90?.p10 || 0) / 100),
      extreme90High: impliedMean * (1 + (plus90?.p90 || 0) / 100),
    };
  }, [adjustedBaseline, currentWeek, currentPrice]);

  // Composite signal strength
  const signalStrength = useMemo(() => {
    let bullishScore = 0;
    let bearishScore = 0;

    if (suRegime.shift > 15) bullishScore += 2;
    else if (suRegime.shift > 5) bullishScore += 1;
    else if (suRegime.shift < -10) bearishScore += 2;
    else if (suRegime.shift < 0) bearishScore += 1;

    if (weatherSensitivity(currentWeek) > 0.5) {
      if (wsi > 55) bullishScore += 2;
      else if (wsi > 40) bullishScore += 1;
      else if (wsi < 20) bearishScore += 1;
    }

    if (cotPercentile > 85) bearishScore += 2;
    else if (cotPercentile > 70) bearishScore += 1;
    else if (cotPercentile < 15) bullishScore += 2;
    else if (cotPercentile < 30) bullishScore += 1;

    const net = bullishScore - bearishScore;
    if (net >= 3) return { label: 'Strong Bullish', color: '#2a7c3a', net };
    if (net >= 1) return { label: 'Bullish', color: '#5a8c3a', net };
    if (net === 0) return { label: 'Neutral', color: '#8b6f3f', net };
    if (net >= -2) return { label: 'Bearish', color: '#c0392b', net };
    return { label: 'Strong Bearish', color: '#8b1a1a', net };
  }, [suRegime, weatherRegime, cotPercentile, currentWeek, wsi]);

  const inPollination = currentWeek >= 26 && currentWeek <= 32;
  const weatherActive = weatherSensitivity(currentWeek) > 0;

  return (
    <div style={{ fontFamily: 'Georgia, serif', background: '#f5f0e8', minHeight: '100vh', padding: '24px', color: '#2a2419' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>

        <div style={{ borderBottom: '3px double #8b6f3f', paddingBottom: '16px', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#8b6f3f', marginBottom: '4px' }}>
            PHASE 4 — FULL MULTI-FACTOR MODEL
          </div>
          <h1 style={{ fontSize: '36px', margin: '0', fontWeight: 'normal', letterSpacing: '-1px' }}>
            Corn Futures <span style={{ fontStyle: 'italic', color: '#8b6f3f' }}>Composite Model</span>
          </h1>
          <div style={{ fontSize: '13px', color: '#6b5a3f', marginTop: '8px' }}>
            Seasonal + Fundamental + Weather + Positioning · Composite signal scoring
          </div>
        </div>

        {/* Composite signal banner */}
        <div style={{ background: signalStrength.color, color: '#fff', padding: '20px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '11px', letterSpacing: '3px', opacity: 0.8 }}>COMPOSITE SIGNAL</div>
            <div style={{ fontSize: '32px' }}>{signalStrength.label}</div>
          </div>
          <div style={{ fontSize: '48px', fontWeight: 'bold', opacity: 0.3 }}>
            {signalStrength.net > 0 ? '+' : ''}{signalStrength.net}
          </div>
        </div>

        {/* Four regime banners */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px', marginBottom: '24px' }}>
          <div style={{ background: suRegime.color, color: '#fff', padding: '12px' }}>
            <div style={{ fontSize: '9px', letterSpacing: '2px', opacity: 0.8 }}>FUNDAMENTALS</div>
            <div style={{ fontSize: '18px' }}>{suRegime.name}</div>
            <div style={{ fontSize: '11px', opacity: 0.8 }}>S/U: {stocksToUse.toFixed(1)}%</div>
          </div>
          <div style={{ background: weatherActive ? weatherRegime.color : '#8b8572', color: '#fff', padding: '12px' }}>
            <div style={{ fontSize: '9px', letterSpacing: '2px', opacity: 0.8 }}>WEATHER</div>
            <div style={{ fontSize: '18px' }}>{weatherActive ? weatherRegime.name : 'Dormant'}</div>
            <div style={{ fontSize: '11px', opacity: 0.8 }}>WSI: {wsi.toFixed(0)}</div>
          </div>
          <div style={{ background: cotRegime.color, color: '#fff', padding: '12px' }}>
            <div style={{ fontSize: '9px', letterSpacing: '2px', opacity: 0.8 }}>POSITIONING</div>
            <div style={{ fontSize: '18px' }}>{cotRegime.name}</div>
            <div style={{ fontSize: '11px', opacity: 0.8 }}>%ile: {cotPercentile}</div>
          </div>
          <div style={{ background: '#2a2419', color: '#fff', padding: '12px' }}>
            <div style={{ fontSize: '9px', letterSpacing: '2px', opacity: 0.8 }}>TIMING</div>
            <div style={{ fontSize: '18px' }}>{weekToMonth(currentWeek)} W{currentWeek}</div>
            <div style={{ fontSize: '11px', opacity: 0.8 }}>{inPollination ? '★ Pollination' : 'Non-critical'}</div>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '16px', background: '#ede4d3', padding: '16px', border: '1px solid #c4a76a' }}>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>LOOKBACK YEARS</label>
            <input type="range" min="5" max="25" value={yearsToUse} onChange={(e) => setYearsToUse(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '14px' }}>{yearsToUse} yrs</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>CURRENT WEEK</label>
            <input type="range" min="1" max="52" value={currentWeek} onChange={(e) => setCurrentWeek(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '14px' }}>W{currentWeek} · {weekToMonth(currentWeek)}</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>CURRENT PRICE</label>
            <input type="number" step="0.05" value={currentPrice} onChange={(e) => setCurrentPrice(parseFloat(e.target.value) || 0)} style={{ width: '100%', padding: '4px', fontSize: '13px', border: '1px solid #8b6f3f', background: '#f5f0e8', fontFamily: 'Georgia, serif' }} />
            <div style={{ fontSize: '11px', color: '#6b5a3f' }}>Mean: ${currentStats.impliedMean.toFixed(2)}</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '16px', marginBottom: '24px', background: '#ede4d3', padding: '16px', border: '1px solid #c4a76a' }}>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>STOCKS-TO-USE %</label>
            <input type="range" min="5" max="22" step="0.1" value={stocksToUse} onChange={(e) => setStocksToUse(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '14px', color: suRegime.color }}>{stocksToUse.toFixed(1)}%</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>TEMP (°F)</label>
            <input type="range" min="-5" max="10" step="0.5" value={tempAnomaly} onChange={(e) => setTempAnomaly(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '14px' }}>{tempAnomaly > 0 ? '+' : ''}{tempAnomaly.toFixed(1)}°F</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>PRECIP (%)</label>
            <input type="range" min="-80" max="50" step="5" value={precipAnomaly} onChange={(e) => setPrecipAnomaly(parseFloat(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '14px' }}>{precipAnomaly > 0 ? '+' : ''}{precipAnomaly}%</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '6px' }}>COT %ILE</label>
            <input type="range" min="0" max="100" value={cotPercentile} onChange={(e) => setCotPercentile(parseInt(e.target.value))} style={{ width: '100%' }} />
            <div style={{ fontSize: '14px', color: cotRegime.color }}>{cotPercentile}</div>
          </div>
        </div>

        {/* Scenario presets */}
        <div style={{ background: '#fff', padding: '12px 16px', marginBottom: '24px', border: '1px solid #c4a76a' }}>
          <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', marginBottom: '8px' }}>HISTORICAL SCENARIOS WITH POSITIONING</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {[
              { name: 'June 2022 Top', su: 9.6, temp: 2, precip: -15, week: 24, cot: 92, label: 'Tight S/U but extreme long positioning' },
              { name: '2012 Drought', su: 12.8, temp: 6, precip: -55, week: 28, cot: 50, label: 'Balanced S/U → July stress, neutral pos.' },
              { name: '2019 Wet Spring', su: 14.5, temp: -2, precip: 40, week: 22, cot: 20, label: 'Oversupply concerns + short positioning' },
              { name: '2020 Reset', su: 8.3, temp: 0, precip: 0, week: 30, cot: 15, label: 'Scarcity + short positioning = bullish setup' },
              { name: '2016 Glut', su: 15.7, temp: 0, precip: 10, week: 28, cot: 30, label: 'Ample supply, bearish fundamentals' },
              { name: 'Reset', su: 13, temp: 0, precip: 0, week: 17, cot: 50, label: 'Baseline' },
            ].map(s => (
              <button key={s.name} onClick={() => { setStocksToUse(s.su); setTempAnomaly(s.temp); setPrecipAnomaly(s.precip); setCurrentWeek(s.week); setCotPercentile(s.cot); }}
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
              <h2 style={{ fontSize: '20px', marginTop: 0, marginBottom: '4px', fontWeight: 'normal' }}>Composite price projection</h2>
              <div style={{ fontSize: '12px', color: '#6b5a3f' }}>
                All four layers combined. Positioning asymmetrically caps upside when crowded long, extends downside.
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', fontSize: '11px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input type="checkbox" checked={showLayers.seasonal} onChange={(e) => setShowLayers({ ...showLayers, seasonal: e.target.checked })} />
                Seasonal only
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input type="checkbox" checked={showLayers.su} onChange={(e) => setShowLayers({ ...showLayers, su: e.target.checked })} />
                + S/U
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input type="checkbox" checked={showLayers.weather} onChange={(e) => setShowLayers({ ...showLayers, weather: e.target.checked })} />
                + Weather
              </label>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={440}>
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
              <ReferenceArea x1={26} x2={32} fill="#c0392b" fillOpacity={0.06} />
              <Area type="monotone" dataKey="band10to90" fill={signalStrength.color} fillOpacity={0.15} stroke="none" name="10-90th %ile" />
              <Area type="monotone" dataKey="band25to75" fill={signalStrength.color} fillOpacity={0.30} stroke="none" name="25-75th %ile" />
              <Line type="monotone" dataKey="p50Price" stroke={signalStrength.color} strokeWidth={2.5} dot={false} name="Full model median" />
              {showLayers.seasonal && <Line type="monotone" dataKey="seasonal_p50" stroke="#8b6f3f" strokeWidth={1.2} strokeDasharray="2 3" dot={false} name="Seasonal" />}
              {showLayers.su && <Line type="monotone" dataKey="su_p50" stroke="#c26a33" strokeWidth={1.2} strokeDasharray="4 4" dot={false} name="+ S/U" />}
              {showLayers.weather && <Line type="monotone" dataKey="sw_p50" stroke="#6b8e4e" strokeWidth={1.2} strokeDasharray="6 3" dot={false} name="+ Weather" />}
              <ReferenceLine x={currentWeek} stroke="#2a2419" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="currentMarker" stroke="#2a2419" strokeWidth={0} dot={{ r: 6, fill: '#2a2419' }} name="Current" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Price targets with full range */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a', borderLeft: `4px solid ${signalStrength.color}` }}>
            <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f' }}>3-MONTH TARGET</div>
            <div style={{ fontSize: '32px', margin: '8px 0', color: signalStrength.color }}>${currentStats.target90.toFixed(2)}</div>
            <div style={{ fontSize: '13px', color: '#6b5a3f', marginBottom: '8px' }}>
              vs. ${currentPrice.toFixed(2)} · {((currentStats.target90 / currentPrice - 1) * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: '12px', color: '#8b6f3f', borderTop: '1px solid #ede4d3', paddingTop: '8px' }}>
              Likely: ${currentStats.low90.toFixed(2)} – ${currentStats.high90.toFixed(2)}<br />
              Extreme: ${currentStats.extreme90Low.toFixed(2)} – ${currentStats.extreme90High.toFixed(2)}
            </div>
          </div>
          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a', borderLeft: `4px solid ${signalStrength.color}` }}>
            <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f' }}>6-MONTH TARGET</div>
            <div style={{ fontSize: '32px', margin: '8px 0', color: signalStrength.color }}>${currentStats.target180.toFixed(2)}</div>
            <div style={{ fontSize: '13px', color: '#6b5a3f', marginBottom: '8px' }}>
              vs. ${currentPrice.toFixed(2)} · {((currentStats.target180 / currentPrice - 1) * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: '12px', color: '#8b6f3f', borderTop: '1px solid #ede4d3', paddingTop: '8px' }}>
              Likely: ${currentStats.low180.toFixed(2)} – ${currentStats.high180.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Factor contribution breakdown */}
        <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a', marginBottom: '24px' }}>
          <h3 style={{ fontSize: '14px', letterSpacing: '2px', color: '#8b6f3f', marginTop: 0, fontWeight: 'normal' }}>
            FACTOR CONTRIBUTIONS AT CURRENT WEEK
          </h3>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart
              data={[
                { factor: 'Seasonal', value: baseline.find(b => b.week === currentWeek)?.p50 || 0, color: '#8b6f3f' },
                { factor: 'S/U Regime', value: suRegime.shift, color: suRegime.color },
                { factor: 'Weather', value: weatherRegime.shift * weatherSensitivity(currentWeek), color: weatherRegime.color },
                { factor: 'Positioning', value: (cotRegime.upCap + cotRegime.downExtend) / 2, color: cotRegime.color },
              ]}
              layout="vertical"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#d4c4a0" />
              <XAxis type="number" stroke="#6b5a3f" tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`} domain={[-30, 30]} />
              <YAxis type="category" dataKey="factor" stroke="#6b5a3f" width={100} />
              <Tooltip contentStyle={{ background: '#f5f0e8', border: '1px solid #8b6f3f', fontFamily: 'Georgia, serif' }} formatter={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`} />
              <ReferenceLine x={0} stroke="#2a2419" />
              <Bar dataKey="value" fill="#8b6f3f">
                {[
                  { factor: 'Seasonal', value: baseline.find(b => b.week === currentWeek)?.p50 || 0, color: '#8b6f3f' },
                  { factor: 'S/U Regime', value: suRegime.shift, color: suRegime.color },
                  { factor: 'Weather', value: weatherRegime.shift * weatherSensitivity(currentWeek), color: weatherRegime.color },
                  { factor: 'Positioning', value: (cotRegime.upCap + cotRegime.downExtend) / 2, color: cotRegime.color },
                ].map((entry, i) => <rect key={i} fill={entry.color} />)}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ fontSize: '11px', color: '#6b5a3f', textAlign: 'center' }}>
            Each factor's % contribution to the median price projection at week {currentWeek}
          </div>
        </div>

        {/* Synthesis */}
        <div style={{ background: '#2a2419', color: '#f5f0e8', padding: '24px', border: '1px solid #8b6f3f', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#c4a76a', marginBottom: '12px' }}>COMPOSITE READ</div>
          <div style={{ fontSize: '15px', lineHeight: '1.8' }}>
            <strong>Signal:</strong> {signalStrength.label} ({signalStrength.net > 0 ? '+' : ''}{signalStrength.net} net score).{' '}
            <strong>Fundamentals</strong> ({suRegime.name}) contribute {suRegime.shift > 0 ? '+' : ''}{suRegime.shift}%.{' '}
            <strong>Weather</strong> ({weatherActive ? weatherRegime.name : 'dormant'}) contributes {(weatherRegime.shift * weatherSensitivity(currentWeek)).toFixed(0)}%.{' '}
            <strong>Positioning</strong> ({cotRegime.name}, {cotRegime.bias}) {cotRegime.bias === 'bearish' ? 'caps upside' : cotRegime.bias === 'bullish' ? 'supports upside' : 'is neutral'}.
            {cotPercentile > 85 && suRegime.shift > 10 && <> <strong style={{ color: '#d68438' }}>⚠ Classic June 2022 setup — bullish fundamentals but crowded positioning increases reversal risk despite the fundamental case.</strong></>}
            {cotPercentile < 15 && suRegime.shift < -5 && <> <strong style={{ color: '#3a7c4e' }}>✓ Capitulation setup — bearish fundamentals with washed-out positioning often marks durable lows.</strong></>}
          </div>
        </div>

        <div style={{ padding: '16px', background: '#ede4d3', fontSize: '12px', color: '#6b5a3f', lineHeight: '1.6' }}>
          <strong>What changed from Phase 3:</strong> COT positioning now acts as an asymmetric filter — crowded long caps the upper band and extends the lower band. The <em>June 2022 Top</em> preset shows this perfectly: tight S/U said "buy," but positioning at the 92nd percentile flagged exhaustion risk. Prices peaked days later.
          <br /><br />
          <strong>Phase 5 (final):</strong> Monte Carlo wrapper. Instead of deterministic percentile bands, we'll run 10,000 simulations with correlated factor uncertainty and produce full probability distributions — "35% chance of &gt; $6 by Sep" type outputs.
          <br /><br />
          <em>Not financial advice. COT reports lag by 3 days and positioning extremes can persist — "crowded" isn't a timing signal on its own.</em>
        </div>
      </div>
    </div>
  );
}
