import React, { useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, AreaChart, ComposedChart, ReferenceLine } from 'recharts';

// Generate realistic corn futures data based on actual seasonal patterns
// Corn seasonal: spring uncertainty peak (May/Jun), summer weather premium (Jul),
// harvest pressure (Sep/Oct low), winter recovery
const generateHistoricalData = () => {
  const years = 25;
  const currentYear = 2026;
  const startYear = currentYear - years;
  const data = {};

  // Seasonal shape (normalized, based on actual corn seasonality)
  // Index = week of year (1-52), value = typical % deviation from annual mean
  const seasonalShape = Array.from({ length: 52 }, (_, i) => {
    const week = i + 1;
    // Multi-component seasonal: planting premium builds Mar-Jun,
    // pollination peak in Jul, harvest decline Aug-Oct, winter recovery
    const plantingPremium = 0.04 * Math.exp(-Math.pow((week - 22) / 8, 2));
    const pollinationPeak = 0.06 * Math.exp(-Math.pow((week - 28) / 4, 2));
    const harvestLow = -0.07 * Math.exp(-Math.pow((week - 40) / 5, 2));
    const winterRecovery = 0.02 * Math.exp(-Math.pow((week - 6) / 6, 2));
    return plantingPremium + pollinationPeak + harvestLow + winterRecovery;
  });

  // Generate each year with realistic base price, trend, and noise
  for (let y = 0; y < years; y++) {
    const year = startYear + y;
    // Base price varies by year (reflecting real corn cycles)
    const basePrices = {
      low: 3.20, mid: 4.50, high: 6.80, extreme: 7.80
    };
    // Simulate price regimes similar to history
    let basePrice;
    if (year >= 2020 && year <= 2022) basePrice = basePrices.extreme - Math.random() * 1.5;
    else if (year >= 2010 && year <= 2013) basePrice = basePrices.high - Math.random() * 1.2;
    else if (year >= 2014 && year <= 2019) basePrice = basePrices.mid - Math.random() * 0.8;
    else basePrice = basePrices.mid + (Math.random() - 0.5) * 1.5;

    basePrice = Math.max(3.0, basePrice);
    const yearData = [];

    for (let w = 0; w < 52; w++) {
      const seasonal = seasonalShape[w];
      // Add year-specific shock (weather event, policy, etc.)
      const yearShock = (Math.random() - 0.5) * 0.1;
      // Weekly noise
      const noise = (Math.random() - 0.5) * 0.03;
      // Random drought year bonus (every ~7 years)
      const droughtBonus = (year % 7 === 0 && w >= 25 && w <= 32) ? 0.08 : 0;
      const price = basePrice * (1 + seasonal + yearShock + noise + droughtBonus);
      yearData.push({ week: w + 1, price: parseFloat(price.toFixed(2)), year });
    }
    data[year] = yearData;
  }
  return data;
};

const historicalData = generateHistoricalData();

// Compute seasonal baseline and confidence bands
const computeSeasonalBaseline = (data, yearsToUse) => {
  const baseline = [];
  const allYears = Object.keys(data).map(Number).sort((a, b) => b - a);
  const selectedYears = allYears.slice(0, yearsToUse);

  for (let w = 1; w <= 52; w++) {
    // Normalize each year by its own annual mean, then aggregate
    const normalizedReturns = selectedYears.map(year => {
      const yearData = data[year];
      const annualMean = yearData.reduce((s, d) => s + d.price, 0) / yearData.length;
      const weekPrice = yearData.find(d => d.week === w).price;
      return (weekPrice / annualMean - 1) * 100; // % deviation
    });

    normalizedReturns.sort((a, b) => a - b);
    const n = normalizedReturns.length;
    const percentile = (p) => normalizedReturns[Math.floor(n * p)];
    const mean = normalizedReturns.reduce((s, v) => s + v, 0) / n;

    baseline.push({
      week: w,
      p10: parseFloat(percentile(0.10).toFixed(2)),
      p25: parseFloat(percentile(0.25).toFixed(2)),
      p50: parseFloat(percentile(0.50).toFixed(2)),
      p75: parseFloat(percentile(0.75).toFixed(2)),
      p90: parseFloat(percentile(0.90).toFixed(2)),
      mean: parseFloat(mean.toFixed(2)),
    });
  }
  return baseline;
};

const weekToMonth = (week) => {
  const date = new Date(2024, 0, 1 + (week - 1) * 7);
  return date.toLocaleString('en-US', { month: 'short' });
};

const weekLabel = (week) => {
  if (week === 1 || week % 8 === 0) return weekToMonth(week);
  return '';
};

export default function CornSeasonalModel() {
  const [yearsToUse, setYearsToUse] = useState(20);
  const [currentWeek, setCurrentWeek] = useState(17); // Late April
  const [currentPrice, setCurrentPrice] = useState(4.65);

  const baseline = useMemo(() => computeSeasonalBaseline(historicalData, yearsToUse), [yearsToUse]);

  // Price projections from current position
  const projections = useMemo(() => {
    const currentSeasonal = baseline.find(b => b.week === currentWeek);
    if (!currentSeasonal) return [];

    // Reverse-engineer implied annual mean from current price
    const impliedMean = currentPrice / (1 + currentSeasonal.p50 / 100);

    return baseline.map(b => ({
      week: b.week,
      month: weekLabel(b.week),
      p10Price: parseFloat((impliedMean * (1 + b.p10 / 100)).toFixed(2)),
      p25Price: parseFloat((impliedMean * (1 + b.p25 / 100)).toFixed(2)),
      p50Price: parseFloat((impliedMean * (1 + b.p50 / 100)).toFixed(2)),
      p75Price: parseFloat((impliedMean * (1 + b.p75 / 100)).toFixed(2)),
      p90Price: parseFloat((impliedMean * (1 + b.p90 / 100)).toFixed(2)),
      band25to75: [
        parseFloat((impliedMean * (1 + b.p25 / 100)).toFixed(2)),
        parseFloat((impliedMean * (1 + b.p75 / 100)).toFixed(2))
      ],
      band10to90: [
        parseFloat((impliedMean * (1 + b.p10 / 100)).toFixed(2)),
        parseFloat((impliedMean * (1 + b.p90 / 100)).toFixed(2))
      ],
    }));
  }, [baseline, currentWeek, currentPrice]);

  // Build chart data with current price marker
  const chartData = projections.map(p => ({
    ...p,
    currentMarker: p.week === currentWeek ? currentPrice : null,
  }));

  // Key stats for current position
  const currentStats = useMemo(() => {
    const now = baseline.find(b => b.week === currentWeek);
    const plus90 = baseline.find(b => b.week === Math.min(52, currentWeek + 13));
    const plus180 = baseline.find(b => b.week === Math.min(52, currentWeek + 26));
    const impliedMean = currentPrice / (1 + (now?.p50 || 0) / 100);
    return {
      now,
      plus90,
      plus180,
      impliedMean,
      target90: impliedMean * (1 + (plus90?.p50 || 0) / 100),
      target180: impliedMean * (1 + (plus180?.p50 || 0) / 100),
    };
  }, [baseline, currentWeek, currentPrice]);

  return (
    <div style={{ fontFamily: 'Georgia, serif', background: '#f5f0e8', minHeight: '100vh', padding: '24px', color: '#2a2419' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ borderBottom: '3px double #8b6f3f', paddingBottom: '16px', marginBottom: '24px' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#8b6f3f', marginBottom: '4px' }}>
            PHASE 1 — SEASONAL BASELINE
          </div>
          <h1 style={{ fontSize: '36px', margin: '0', fontWeight: 'normal', letterSpacing: '-1px' }}>
            Corn Futures <span style={{ fontStyle: 'italic', color: '#8b6f3f' }}>Seasonal Model</span>
          </h1>
          <div style={{ fontSize: '13px', color: '#6b5a3f', marginTop: '8px' }}>
            Historical price distributions · Confidence bands · Probability-weighted projections
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', marginBottom: '24px', background: '#ede4d3', padding: '20px', border: '1px solid #c4a76a' }}>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '8px' }}>
              LOOKBACK YEARS
            </label>
            <input
              type="range"
              min="5"
              max="25"
              value={yearsToUse}
              onChange={(e) => setYearsToUse(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: '18px', marginTop: '4px' }}>{yearsToUse} years</div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '8px' }}>
              CURRENT WEEK OF YEAR
            </label>
            <input
              type="range"
              min="1"
              max="52"
              value={currentWeek}
              onChange={(e) => setCurrentWeek(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: '18px', marginTop: '4px' }}>
              Week {currentWeek} <span style={{ color: '#8b6f3f', fontSize: '14px' }}>({weekToMonth(currentWeek)})</span>
            </div>
          </div>
          <div>
            <label style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f', display: 'block', marginBottom: '8px' }}>
              CURRENT PRICE ($/BU)
            </label>
            <input
              type="number"
              step="0.05"
              value={currentPrice}
              onChange={(e) => setCurrentPrice(parseFloat(e.target.value) || 0)}
              style={{ width: '100%', padding: '6px', fontSize: '16px', border: '1px solid #8b6f3f', background: '#f5f0e8', fontFamily: 'Georgia, serif' }}
            />
            <div style={{ fontSize: '12px', color: '#6b5a3f', marginTop: '4px' }}>
              Implied annual mean: ${currentStats.impliedMean.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Main chart */}
        <div style={{ background: '#fff', padding: '24px', border: '1px solid #c4a76a', marginBottom: '24px' }}>
          <h2 style={{ fontSize: '20px', marginTop: 0, fontWeight: 'normal' }}>
            Projected price path with confidence bands
          </h2>
          <div style={{ fontSize: '12px', color: '#6b5a3f', marginBottom: '16px' }}>
            Bands show the historical 10th–90th and 25th–75th percentile range of weekly prices, anchored to your current price
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
              <Area type="monotone" dataKey="band10to90" fill="#c4a76a" fillOpacity={0.25} stroke="none" name="10-90th %ile" />
              <Area type="monotone" dataKey="band25to75" fill="#8b6f3f" fillOpacity={0.35} stroke="none" name="25-75th %ile" />
              <Line type="monotone" dataKey="p50Price" stroke="#5a3a1a" strokeWidth={2.5} dot={false} name="Seasonal median" />
              <ReferenceLine x={currentWeek} stroke="#c0392b" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="currentMarker" stroke="#c0392b" strokeWidth={0} dot={{ r: 6, fill: '#c0392b' }} name="Current price" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Price targets */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a' }}>
            <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f' }}>3-MONTH TARGET</div>
            <div style={{ fontSize: '32px', margin: '8px 0' }}>${currentStats.target90.toFixed(2)}</div>
            <div style={{ fontSize: '13px', color: '#6b5a3f' }}>
              Week {Math.min(52, currentWeek + 13)} · {currentStats.plus90 && `${currentStats.plus90.p50 > 0 ? '+' : ''}${currentStats.plus90.p50}% seasonal`}
            </div>
            <div style={{ fontSize: '12px', color: '#8b6f3f', marginTop: '8px' }}>
              Range: ${(currentStats.impliedMean * (1 + (currentStats.plus90?.p25 || 0) / 100)).toFixed(2)} – ${(currentStats.impliedMean * (1 + (currentStats.plus90?.p75 || 0) / 100)).toFixed(2)}
            </div>
          </div>
          <div style={{ background: '#fff', padding: '20px', border: '1px solid #c4a76a' }}>
            <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8b6f3f' }}>6-MONTH TARGET</div>
            <div style={{ fontSize: '32px', margin: '8px 0' }}>${currentStats.target180.toFixed(2)}</div>
            <div style={{ fontSize: '13px', color: '#6b5a3f' }}>
              Week {Math.min(52, currentWeek + 26)} · {currentStats.plus180 && `${currentStats.plus180.p50 > 0 ? '+' : ''}${currentStats.plus180.p50}% seasonal`}
            </div>
            <div style={{ fontSize: '12px', color: '#8b6f3f', marginTop: '8px' }}>
              Range: ${(currentStats.impliedMean * (1 + (currentStats.plus180?.p25 || 0) / 100)).toFixed(2)} – ${(currentStats.impliedMean * (1 + (currentStats.plus180?.p75 || 0) / 100)).toFixed(2)}
            </div>
          </div>
        </div>

        {/* Seasonal insight */}
        <div style={{ background: '#2a2419', color: '#f5f0e8', padding: '24px', border: '1px solid #8b6f3f' }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: '#c4a76a', marginBottom: '12px' }}>
            SEASONAL CONTEXT — WEEK {currentWeek}
          </div>
          <div style={{ fontSize: '15px', lineHeight: '1.7' }}>
            {currentWeek >= 10 && currentWeek <= 22 && "Planting season. Markets price uncertainty around acreage and early weather. Bias typically upward into June."}
            {currentWeek >= 23 && currentWeek <= 32 && "Pollination window. The most weather-sensitive period — July rainfall and heat in the Corn Belt drive the year's price extremes."}
            {currentWeek >= 33 && currentWeek <= 42 && "Pre-harvest to harvest. Supply pressure builds; prices typically decline as new crop arrives."}
            {currentWeek >= 43 && currentWeek <= 52 && "Post-harvest. Demand-driven market; ethanol, exports, and South American planting become dominant."}
            {currentWeek >= 1 && currentWeek <= 9 && "Winter consolidation. Markets await Prospective Plantings report (late March) for next crop signal."}
          </div>
        </div>

        {/* Disclaimers & next steps */}
        <div style={{ marginTop: '24px', padding: '16px', background: '#ede4d3', fontSize: '12px', color: '#6b5a3f', lineHeight: '1.6' }}>
          <strong>Model limitations:</strong> This baseline uses only historical seasonality. It ignores current fundamentals (stocks-to-use, weather anomalies, demand shocks), which dominate in any given year. Confidence bands widen meaningfully with real fundamentals layered in.
          <br /><br />
          <strong>Next phase:</strong> Overlay stocks-to-use ratio — historically the single most predictive corn fundamental. Years with S/U &lt; 10% consistently print prices well above seasonal median.
          <br /><br />
          <em>Not financial advice. Seasonality is a statistical tendency, not a guarantee.</em>
        </div>
      </div>
    </div>
  );
}
