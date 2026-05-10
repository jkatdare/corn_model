"""
Corn Futures Probability Model — Streamlit App
Converted from corn_seasonal_model_phase5.jsx
"""

import streamlit as st
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import datetime

# ──────────────────────────────────────────────
# PAGE CONFIG
# ──────────────────────────────────────────────
st.set_page_config(
    page_title="Corn Futures Probability Model",
    page_icon="🌽",
    layout="wide",
)

# Custom CSS for the farm-ledger aesthetic
st.markdown("""
<style>
    .stApp { background-color: #f5f0e8; }
    .metric-card {
        padding: 16px; border-radius: 4px; color: white;
        text-align: center; margin-bottom: 8px;
    }
    .metric-title { font-size: 11px; letter-spacing: 2px; opacity: 0.8; }
    .metric-value { font-size: 32px; font-weight: bold; }
    .metric-sub   { font-size: 11px; opacity: 0.8; }
    .green-card  { background-color: #3a7c4e; }
    .red-card    { background-color: #c0392b; }
    .blue-card   { background-color: #2a4d6e; }
    .dark-card   { background-color: #2a2419; }
    .section-header {
        font-size: 11px; letter-spacing: 3px; color: #8b6f3f;
        margin-bottom: 4px;
    }
    h1, h2, h3 { font-family: Georgia, serif !important; }
</style>
""", unsafe_allow_html=True)

# ──────────────────────────────────────────────
# DATA GENERATION
# ──────────────────────────────────────────────
@st.cache_data
def generate_historical_data():
    years = 25
    current_year = 2026
    start_year = current_year - years

    seasonal_shape = []
    for i in range(52):
        week = i + 1
        planting_premium  =  0.04 * np.exp(-((week - 22) / 8) ** 2)
        pollination_peak  =  0.06 * np.exp(-((week - 28) / 4) ** 2)
        harvest_low       = -0.07 * np.exp(-((week - 40) / 5) ** 2)
        winter_recovery   =  0.02 * np.exp(-((week -  6) / 6) ** 2)
        seasonal_shape.append(planting_premium + pollination_peak + harvest_low + winter_recovery)

    rng = np.random.default_rng(42)
    data = {}
    for y in range(years):
        year = start_year + y
        if 2020 <= year <= 2022:
            base_price = 6.5 + rng.random() * 1.3
        elif 2010 <= year <= 2013:
            base_price = 5.8 + rng.random() * 1.5
        elif 2014 <= year <= 2019:
            base_price = 3.8 + rng.random() * 0.6
        else:
            base_price = 4.2 + (rng.random() - 0.5) * 1.2
        base_price = max(3.0, base_price)

        year_data = []
        for w in range(52):
            seasonal   = seasonal_shape[w]
            year_shock = (rng.random() - 0.5) * 0.1
            noise      = (rng.random() - 0.5) * 0.03
            drought    = 0.08 if (year % 7 == 0 and 25 <= w <= 32) else 0
            price = base_price * (1 + seasonal + year_shock + noise + drought)
            year_data.append({"week": w + 1, "price": round(price, 2), "year": year})
        data[year] = year_data
    return data


historical_data = generate_historical_data()


# ──────────────────────────────────────────────
# REGIME FUNCTIONS
# ──────────────────────────────────────────────
def su_shift(su):
    return 45 * np.exp(-(su - 5) / 4) - 20 + max(0, (18 - su) * 0.5)

def su_widen(su):
    if su < 8:  return 1.5
    if su < 12: return 1.2
    if su > 17: return 1.2
    return 1.0

def compute_wsi(temp_anomaly, precip_anomaly):
    temp_stress   = max(0, min(100, ((temp_anomaly + 2) / 10) * 100))
    precip_stress = max(0, min(100, (-precip_anomaly + 20)))
    return 0.4 * temp_stress + 0.6 * precip_stress

def weather_shift(wsi):
    if wsi < 20: return -8
    return min(35, (wsi - 30) * 0.6)

def weather_sensitivity(week):
    if week < 20 or week > 38: return 0
    if 26 <= week <= 32:        return 1.0
    if 20 <= week < 26:         return (week - 20) / 6
    if 32 < week <= 38:         return (38 - week) / 6
    return 0

def cot_median_shift(pct):
    if pct > 90: return -10
    if pct > 75: return  -5
    if pct > 55: return  -1
    if pct >= 40: return  0
    if pct >= 20: return  1
    if pct >= 10: return  5
    return 10


# ──────────────────────────────────────────────
# SEASONAL BASELINE
# ──────────────────────────────────────────────
@st.cache_data
def compute_seasonal_baseline(years_to_use=20):
    all_years = sorted(historical_data.keys(), reverse=True)
    selected  = all_years[:years_to_use]

    baseline = []
    for w in range(1, 53):
        normalized = []
        for year in selected:
            year_data   = historical_data[year]
            annual_mean = np.mean([d["price"] for d in year_data])
            week_price  = next(d["price"] for d in year_data if d["week"] == w)
            normalized.append((week_price / annual_mean - 1) * 100)

        normalized = sorted(normalized)
        n    = len(normalized)
        mean = np.mean(normalized)
        std  = np.std(normalized)
        baseline.append({
            "week": w,
            "p50":  normalized[int(n * 0.50)],
            "mean": mean,
            "std":  std,
        })
    return baseline


baseline_data = compute_seasonal_baseline()
baseline_by_week = {b["week"]: b for b in baseline_data}


# ──────────────────────────────────────────────
# MONTE CARLO
# ──────────────────────────────────────────────
def run_monte_carlo(params, num_sims, horizon_week):
    current_week      = params["current_week"]
    current_price     = params["current_price"]
    stocks_to_use     = params["stocks_to_use"]
    temp_anomaly      = params["temp_anomaly"]
    precip_anomaly    = params["precip_anomaly"]
    cot_percentile    = params["cot_percentile"]
    su_uncertainty    = params["su_uncertainty"]
    weather_unc       = params["weather_uncertainty"]
    cot_unc           = params["cot_uncertainty"]
    price_noise       = params["price_noise"]

    rng = np.random.default_rng()
    n   = num_sims

    # Correlated draws (weather ↔ S/U: -0.35)
    z1 = rng.standard_normal(n)
    z2 = rng.standard_normal(n)
    corr = -0.35
    z2_corr = corr * z1 + np.sqrt(1 - corr**2) * z2
    z_cot   = rng.standard_normal(n)
    z_price = rng.standard_normal(n)

    sim_su     = np.maximum(5, stocks_to_use + z2_corr * su_uncertainty)
    sim_temp   = temp_anomaly  + z1 * weather_unc
    sim_precip = precip_anomaly - z1 * weather_unc * 10
    sim_cot    = np.clip(cot_percentile + z_cot * cot_unc * 10, 0, 100)

    sim_wsi = np.vectorize(compute_wsi)(sim_temp, sim_precip)

    # Current-week factors (vectorised)
    c_su_shift  = np.vectorize(su_shift)(sim_su)
    c_wth_shift = np.vectorize(weather_shift)(sim_wsi) * weather_sensitivity(current_week)
    c_cot_shift = np.vectorize(cot_median_shift)(sim_cot)
    c_seasonal  = baseline_by_week.get(current_week, {}).get("p50", 0)
    c_total     = c_seasonal + c_su_shift + c_wth_shift + c_cot_shift

    # Horizon-week factors
    h_su_shift  = np.vectorize(su_shift)(sim_su)
    h_wth_shift = np.vectorize(weather_shift)(sim_wsi) * weather_sensitivity(horizon_week)
    h_seasonal  = baseline_by_week.get(horizon_week, {}).get("p50", 0)
    h_total     = h_seasonal + h_su_shift + h_wth_shift + c_cot_shift

    implied_mean = current_price / (1 + c_total / 100)
    hor_std      = baseline_by_week.get(horizon_week, {}).get("std", 5)
    noise_draw   = z_price * hor_std * price_noise
    projected    = implied_mean * (1 + (h_total + noise_draw) / 100)
    projected    = np.maximum(1.5, projected)

    return np.sort(projected)


def compute_stats(results):
    n = len(results)
    if n == 0: return None
    mean = float(np.mean(results))
    std  = float(np.std(results))
    def pct(p): return float(results[int(n * p)])
    return dict(
        mean=mean, std=std,
        p05=pct(0.05), p10=pct(0.10), p25=pct(0.25),
        p50=pct(0.50), p75=pct(0.75), p90=pct(0.90), p95=pct(0.95),
    )


def build_histogram(results, num_bins=30):
    mn, mx = results[0], results[-1]
    if mn == mx: return pd.DataFrame()
    bins    = np.linspace(mn, mx, num_bins + 1)
    centers = (bins[:-1] + bins[1:]) / 2
    counts, _ = np.histogram(results, bins=bins)
    pcts = counts / len(results) * 100
    return pd.DataFrame({"center": centers, "pct": pcts})


def week_to_month(week):
    jan1 = datetime.date(2024, 1, 1)
    d = jan1 + datetime.timedelta(weeks=week - 1)
    return d.strftime("%b")


# ──────────────────────────────────────────────
# SIDEBAR — CONTROLS
# ──────────────────────────────────────────────
st.sidebar.markdown("## 🌽 Model Inputs")

st.sidebar.markdown("### Market State")
current_week  = st.sidebar.slider("Current Week", 1, 52, 20)
current_price = st.sidebar.number_input("Current Price ($/bu)", min_value=1.0, max_value=15.0,
                                         value=4.65, step=0.05, format="%.2f")
horizon_weeks = st.sidebar.slider("Horizon (weeks forward)", 1, 26, 13)

st.sidebar.markdown("### Fundamental Factors")
stocks_to_use  = st.sidebar.slider("Stocks-to-Use %", 5.0, 22.0, 12.8, step=0.1)
temp_anomaly   = st.sidebar.slider("Temp Anomaly (°F)", -5.0, 10.0, 0.0, step=0.5)
precip_anomaly = st.sidebar.slider("Precip Anomaly (%)", -80, 50, 0, step=5)
cot_percentile = st.sidebar.slider("COT Percentile", 0, 100, 50)

st.sidebar.markdown("### Uncertainty Calibration")
su_uncertainty      = st.sidebar.slider("S/U Uncertainty ±%", 0.0, 4.0, 1.5, step=0.1)
weather_uncertainty = st.sidebar.slider("Weather Uncertainty ±", 0.0, 5.0, 2.0, step=0.1)
cot_uncertainty     = st.sidebar.slider("COT Uncertainty ±", 0.0, 3.0, 1.5, step=0.1)
price_noise         = st.sidebar.slider("Price Noise ×", 0.5, 2.5, 1.0, step=0.1)
num_sims            = st.sidebar.select_slider("Simulations", options=[1000, 2000, 5000, 10000, 15000], value=5000)

st.sidebar.markdown("### Price Target")
price_target = st.sidebar.slider("Price Target ($/bu)", 3.0, 10.0, 5.50, step=0.05)

# ──────────────────────────────────────────────
# RUN SIMULATION
# ──────────────────────────────────────────────
horizon_week = min(52, current_week + horizon_weeks)

params = dict(
    current_week=current_week, current_price=current_price,
    stocks_to_use=stocks_to_use, temp_anomaly=temp_anomaly,
    precip_anomaly=precip_anomaly, cot_percentile=cot_percentile,
    su_uncertainty=su_uncertainty, weather_uncertainty=weather_uncertainty,
    cot_uncertainty=cot_uncertainty, price_noise=price_noise,
)

with st.spinner(f"Running {num_sims:,} simulations…"):
    results  = run_monte_carlo(params, num_sims, horizon_week)
    stats    = compute_stats(results)
    histogram = build_histogram(results, 30)
    prob_above_target  = float(np.mean(results > price_target))
    prob_below_current = float(np.mean(results < current_price))

    # Fan chart: project at each of the next 26 weeks
    fan_rows = [dict(
        week=current_week, offset=0,
        p05=current_price, p25=current_price, p50=current_price,
        p75=current_price, p95=current_price,
    )]
    for h in range(1, 27):
        hw = min(52, current_week + h)
        hr = run_monte_carlo(params, 500, hw)
        hs = compute_stats(hr)
        fan_rows.append(dict(
            week=hw, offset=h,
            p05=hs["p05"], p25=hs["p25"], p50=hs["p50"],
            p75=hs["p75"], p95=hs["p95"],
        ))
    fan_df = pd.DataFrame(fan_rows)


# ──────────────────────────────────────────────
# HEADER
# ──────────────────────────────────────────────
st.markdown("""
<div style='border-bottom: 3px double #8b6f3f; padding-bottom: 12px; margin-bottom: 20px;'>
  <div style='font-size:11px;letter-spacing:3px;color:#8b6f3f;'>PHASE 5 — MONTE CARLO SIMULATION</div>
  <h1 style='font-size:36px;margin:0;font-weight:normal;letter-spacing:-1px;color:#2a2419;'>
    Corn Futures <em style='color:#8b6f3f;'>Probability Model</em>
  </h1>
</div>
""", unsafe_allow_html=True)
st.caption(f"{num_sims:,} simulations · Correlated factor uncertainty · Full probability distributions")

# ──────────────────────────────────────────────
# KEY METRICS
# ──────────────────────────────────────────────
c1, c2, c3, c4 = st.columns(4)

with c1:
    st.markdown(f"""
    <div class='metric-card green-card'>
      <div class='metric-title'>P(PRICE > ${price_target:.2f})</div>
      <div class='metric-value'>{prob_above_target*100:.0f}%</div>
      <div class='metric-sub'>at week {horizon_week}</div>
    </div>""", unsafe_allow_html=True)

with c2:
    st.markdown(f"""
    <div class='metric-card red-card'>
      <div class='metric-title'>P(PRICE < ${current_price:.2f})</div>
      <div class='metric-value'>{prob_below_current*100:.0f}%</div>
      <div class='metric-sub'>downside probability</div>
    </div>""", unsafe_allow_html=True)

with c3:
    st.markdown(f"""
    <div class='metric-card blue-card'>
      <div class='metric-title'>EXPECTED VALUE</div>
      <div class='metric-value'>${stats['mean']:.2f}</div>
      <div class='metric-sub'>±${stats['std']:.2f} std</div>
    </div>""", unsafe_allow_html=True)

with c4:
    st.markdown(f"""
    <div class='metric-card dark-card'>
      <div class='metric-title'>VAR (5%)</div>
      <div class='metric-value'>${stats['p05']:.2f}</div>
      <div class='metric-sub'>95% worst case</div>
    </div>""", unsafe_allow_html=True)

st.markdown("<br>", unsafe_allow_html=True)

# ──────────────────────────────────────────────
# FAN CHART
# ──────────────────────────────────────────────
st.markdown("### Monte Carlo Price Fan")
st.caption("Inner band: 25th–75th percentile · Outer band: 5th–95th percentile · Line: median path")

fig_fan = go.Figure()

# Outer band (5–95th)
fig_fan.add_trace(go.Scatter(
    x=list(fan_df["week"]) + list(fan_df["week"][::-1]),
    y=list(fan_df["p95"]) + list(fan_df["p05"][::-1]),
    fill="toself", fillcolor="rgba(139,111,63,0.18)",
    line=dict(color="rgba(0,0,0,0)"),
    name="5–95th %ile", hoverinfo="skip",
))

# Inner band (25–75th)
fig_fan.add_trace(go.Scatter(
    x=list(fan_df["week"]) + list(fan_df["week"][::-1]),
    y=list(fan_df["p75"]) + list(fan_df["p25"][::-1]),
    fill="toself", fillcolor="rgba(139,111,63,0.35)",
    line=dict(color="rgba(0,0,0,0)"),
    name="25–75th %ile", hoverinfo="skip",
))

# Median line
fig_fan.add_trace(go.Scatter(
    x=fan_df["week"], y=fan_df["p50"],
    mode="lines", line=dict(color="#2a2419", width=2.5),
    name="Median",
))

# Reference lines
fig_fan.add_hline(y=current_price, line=dict(color="#c0392b", dash="dash", width=1.5),
                  annotation_text=f"Current ${current_price:.2f}",
                  annotation_position="right")
fig_fan.add_hline(y=price_target, line=dict(color="#3a7c4e", dash="dash", width=1.5),
                  annotation_text=f"Target ${price_target:.2f}",
                  annotation_position="right")

# X-axis tick labels as month names
tick_vals = [w for w in fan_df["week"] if w == 1 or w % 8 == 0]
tick_text = [week_to_month(w) for w in tick_vals]
fig_fan.update_layout(
    xaxis=dict(tickvals=tick_vals, ticktext=tick_text, title="Week"),
    yaxis=dict(title="Price ($/bu)", tickformat="$.2f"),
    paper_bgcolor="#f5f0e8", plot_bgcolor="white",
    legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    height=420, margin=dict(l=60, r=100, t=20, b=40),
)
st.plotly_chart(fig_fan, use_container_width=True)

# ──────────────────────────────────────────────
# HISTOGRAM
# ──────────────────────────────────────────────
st.markdown(f"### Terminal Price Distribution at {week_to_month(horizon_week)}")
st.caption(
    f":red[Red: below current ${current_price:.2f}]  ·  "
    f"**Brown: between**  ·  "
    f":green[Green: above target ${price_target:.2f}]"
)

if not histogram.empty:
    colors = histogram["center"].apply(
        lambda c: "#c0392b" if c < current_price else
                  "#3a7c4e" if c > price_target  else "#8b6f3f"
    )

    fig_hist = go.Figure()
    fig_hist.add_trace(go.Bar(
        x=histogram["center"], y=histogram["pct"],
        marker_color=colors,
        name="Probability",
        hovertemplate="~$%{x:.2f}<br>%{y:.2f}%<extra></extra>",
    ))
    fig_hist.add_vline(x=current_price, line=dict(color="#c0392b", dash="dash"))
    fig_hist.add_vline(x=price_target,  line=dict(color="#3a7c4e", dash="dash"))
    fig_hist.add_vline(x=stats["mean"], line=dict(color="#2a2419", dash="dot"))

    fig_hist.update_layout(
        xaxis=dict(title="Price ($/bu)", tickformat="$.2f"),
        yaxis=dict(title="Probability (%)"),
        paper_bgcolor="#f5f0e8", plot_bgcolor="white",
        height=320, margin=dict(l=60, r=40, t=20, b=40),
        showlegend=False,
    )
    st.plotly_chart(fig_hist, use_container_width=True)

# ──────────────────────────────────────────────
# STATISTICS TABLE
# ──────────────────────────────────────────────
st.markdown("### Distribution Statistics")
stat_cols = st.columns(4)
labels = [
    ("5th %ile",  f"${stats['p05']:.2f}"),
    ("25th %ile", f"${stats['p25']:.2f}"),
    ("Median",    f"${stats['p50']:.2f}"),
    ("Mean",      f"${stats['mean']:.2f}"),
    ("75th %ile", f"${stats['p75']:.2f}"),
    ("95th %ile", f"${stats['p95']:.2f}"),
    ("Std Dev",   f"${stats['std']:.2f}"),
    ("Skew",      "Right" if stats["mean"] > stats["p50"] else
                  "Left"  if stats["mean"] < stats["p50"] else "Sym"),
]
for i, (label, value) in enumerate(labels):
    with stat_cols[i % 4]:
        st.metric(label=label, value=value)

# ──────────────────────────────────────────────
# TRADING IMPLICATIONS
# ──────────────────────────────────────────────
st.markdown("---")
st.markdown("### Trading Implications")

exp_return = (stats["mean"] / current_price - 1) * 100
prob_profit = (1 - prob_below_current) * 100
move_pct    = (price_target / current_price - 1) * 100
var_pct     = (stats["p05"] / current_price - 1) * 100
kelly       = max(0, (prob_above_target - 0.5) * 100)

skew_desc = ("Right-skewed — small edge but large upside tail"
             if stats["mean"] > stats["p50"] else
             "Left-skewed — most paths up but tail risk down"
             if stats["mean"] < stats["p50"] else
             "Symmetric distribution")

st.markdown(f"""
**Expected return:** {exp_return:.1f}% over {horizon_weeks} weeks.  
**Probability of profit (long):** {prob_profit:.0f}%.  
**Asymmetry:** {skew_desc}.

**Position sizing (Kelly approximation):**  
With {prob_above_target*100:.0f}% chance of reaching ${price_target:.2f} (a {move_pct:.0f}% move)  
and downside VaR of ${stats['p05']:.2f} (a {var_pct:.0f}% move),  
edge-adjusted position size → **{kelly:.0f}% of max** (half-Kelly in practice: **{kelly/2:.0f}%**).
""")

if prob_above_target > 0.6:
    st.success(f"**Favorable setup:** Probability of upside breakout materially exceeds 50%. "
               f"Consider defined-risk long exposure.")
elif prob_above_target < 0.3:
    st.error(f"**Unfavorable long:** Probability of reaching target is low. "
             f"Either skip or consider short-side structures.")
else:
    st.warning(f"**Mixed setup:** Probabilities are roughly balanced. "
               f"Wait for clearer setup or use non-directional structures (straddles).")

# ──────────────────────────────────────────────
# FOOTER
# ──────────────────────────────────────────────
st.markdown("---")
st.caption("""
**Model complete.** You now have a full framework: seasonality (base rate) → fundamentals (S/U regime) →
weather (conditional stress) → positioning (contrarian filter) → Monte Carlo (probabilistic outcomes with
correlated factor uncertainty).

**What's still missing for production:** (1) Real data pipelines (USDA, NOAA, CFTC, CME),
(2) backtesting framework to validate factor weights against actual P&L,
(3) ensemble with non-seasonal regime detection (spec bubbles, macro shocks),
(4) transaction cost and margin modeling, (5) multi-contract portfolio logic.

*Not financial advice. All parameters are illustrative. Always backtest against out-of-sample data before risking capital.*
""")
