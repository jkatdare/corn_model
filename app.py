"""
Corn Futures Probability Model — Streamlit App
Faithful port of corn_seasonal_model_phase5.jsx
Layout: all controls inline on the main page, matching the original exactly.
"""

import streamlit as st
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import datetime

# ──────────────────────────────────────────────
# PAGE CONFIG
# ──────────────────────────────────────────────
st.set_page_config(
    page_title="Corn Futures Probability Model",
    page_icon="🌽",
    layout="wide",
)

st.markdown("""
<style>
  /* Overall page background and font */
  .stApp, [data-testid="stAppViewContainer"] {
      background-color: #f5f0e8 !important;
      color: #2a2419;
      font-family: Georgia, serif;
  }
  [data-testid="stHeader"] { background-color: #f5f0e8 !important; }
  [data-testid="stSidebar"] { display: none; }

  /* Remove default Streamlit widget label styling so ours shows through */
  .stSlider label, .stNumberInput label { display: none !important; }

  /* Metric cards */
  .metric-card {
      padding: 16px;
      color: #fff;
      margin-bottom: 8px;
  }
  .metric-label { font-size: 10px; letter-spacing: 2px; color: rgba(255,255,255,0.92); }
  .metric-value { font-size: 32px; font-weight: bold; line-height: 1.1; color: #fff; }
  .metric-sub   { font-size: 11px; color: rgba(255,255,255,0.85); }

  /* Stats table */
  .stats-label { font-size: 11px; color: #6b4f2a; font-weight: 600; }
  .stats-value { font-size: 18px; }
  .stats-value-bold { font-size: 18px; font-weight: bold; }

  /* Tighten slider spacing */
  .stSlider { margin-top: -6px !important; margin-bottom: 0 !important; }

  /* Override Streamlit's default yellow/orange slider to brown theme */
  [data-testid="stSlider"] [data-baseweb="slider"] [data-testid="stTickBarMin"],
  [data-testid="stSlider"] [data-baseweb="slider"] [data-testid="stTickBarMax"] {
      color: #8b6f3f !important;
  }
  /* Filled track (left of thumb) */
  [data-testid="stSlider"] [data-baseweb="slider"] div[role="slider"] ~ div,
  [data-testid="stSlider"] [data-baseweb="slider"] div[class*="Track"] {
      background: #8b6f3f !important;
  }
  /* Thumb */
  [data-testid="stSlider"] [data-baseweb="slider"] div[role="slider"] {
      background: #6b4f2a !important;
      border-color: #6b4f2a !important;
  }
  /* Active/filled portion of track */
  [data-testid="stSlider"] [data-baseweb="slider"] [class*="sliderInnerTrack"] {
      background: #8b6f3f !important;
  }
  div[data-baseweb="slider"] div[class*="Track"] > div:first-child {
      background: #8b6f3f !important;
  }
  .stNumberInput { margin-top: -6px !important; }
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
        w = i + 1
        s = (0.04 * np.exp(-((w-22)/8)**2)
           + 0.06 * np.exp(-((w-28)/4)**2)
           - 0.07 * np.exp(-((w-40)/5)**2)
           + 0.02 * np.exp(-((w-6)/6)**2))
        seasonal_shape.append(s)

    rng = np.random.default_rng(42)
    data = {}
    for y in range(years):
        year = start_year + y
        if 2020 <= year <= 2022:   base = 6.5 + rng.random() * 1.3
        elif 2010 <= year <= 2013: base = 5.8 + rng.random() * 1.5
        elif 2014 <= year <= 2019: base = 3.8 + rng.random() * 0.6
        else:                      base = 4.2 + (rng.random() - 0.5) * 1.2
        base = max(3.0, base)

        year_data = []
        for w in range(52):
            seasonal   = seasonal_shape[w]
            year_shock = (rng.random() - 0.5) * 0.1
            noise      = (rng.random() - 0.5) * 0.03
            drought    = 0.08 if (year % 7 == 0 and 25 <= w <= 32) else 0
            price = base * (1 + seasonal + year_shock + noise + drought)
            year_data.append({"week": w + 1, "price": round(price, 2), "year": year})
        data[year] = year_data
    return data


historical_data = generate_historical_data()


# ──────────────────────────────────────────────
# REGIME FUNCTIONS
# ──────────────────────────────────────────────
def su_shift(su):
    return 45 * np.exp(-(su - 5) / 4) - 20 + max(0, (18 - su) * 0.5)

def compute_wsi(temp_anomaly, precip_anomaly):
    ts = max(0, min(100, ((temp_anomaly + 2) / 10) * 100))
    ps = max(0, min(100, (-precip_anomaly + 20)))
    return 0.4 * ts + 0.6 * ps

def weather_shift(wsi):
    if wsi < 20: return -8.0
    return min(35.0, (wsi - 30) * 0.6)

def weather_sensitivity(week):
    if week < 20 or week > 38: return 0.0
    if 26 <= week <= 32:       return 1.0
    if 20 <= week < 26:        return (week - 20) / 6
    if 32 < week <= 38:        return (38 - week) / 6
    return 0.0

def cot_median_shift(pct):
    if pct > 90:  return -10
    if pct > 75:  return  -5
    if pct > 55:  return  -1
    if pct >= 40: return   0
    if pct >= 20: return   1
    if pct >= 10: return   5
    return 10


# ──────────────────────────────────────────────
# SEASONAL BASELINE
# ──────────────────────────────────────────────
@st.cache_data
def compute_seasonal_baseline(years_to_use=20):
    all_years = sorted(historical_data.keys(), reverse=True)[:years_to_use]
    baseline = []
    for w in range(1, 53):
        normalized = []
        for year in all_years:
            yd = historical_data[year]
            ann_mean = np.mean([d["price"] for d in yd])
            wp = next(d["price"] for d in yd if d["week"] == w)
            normalized.append((wp / ann_mean - 1) * 100)
        normalized.sort()
        n = len(normalized)
        baseline.append({
            "week": w,
            "p50":  normalized[int(n * 0.50)],
            "mean": float(np.mean(normalized)),
            "std":  float(np.std(normalized)),
        })
    return baseline


baseline_data    = compute_seasonal_baseline()
baseline_by_week = {b["week"]: b for b in baseline_data}


# ──────────────────────────────────────────────
# MONTE CARLO
# ──────────────────────────────────────────────
def run_monte_carlo(params, num_sims, horizon_week):
    cw   = params["current_week"]
    cp   = params["current_price"]
    stu  = params["stocks_to_use"]
    ta   = params["temp_anomaly"]
    pa   = params["precip_anomaly"]
    cot  = params["cot_percentile"]
    su_u = params["su_uncertainty"]
    w_u  = params["weather_uncertainty"]
    c_u  = params["cot_uncertainty"]
    pn   = params["price_noise"]

    n  = num_sims
    z1 = np.random.standard_normal(n)
    z2 = np.random.standard_normal(n)
    corr    = -0.35
    z2_corr = corr * z1 + np.sqrt(1 - corr**2) * z2
    z_cot   = np.random.standard_normal(n)
    z_price = np.random.standard_normal(n)

    sim_su     = np.maximum(5, stu + z2_corr * su_u)
    sim_temp   = ta  + z1 * w_u
    sim_precip = pa  - z1 * w_u * 10
    sim_cot    = np.clip(cot + z_cot * c_u * 10, 0, 100)

    sim_wsi = np.vectorize(compute_wsi)(sim_temp, sim_precip)

    c_su  = np.vectorize(su_shift)(sim_su)
    c_wth = np.vectorize(weather_shift)(sim_wsi) * weather_sensitivity(cw)
    c_cot = np.vectorize(cot_median_shift)(sim_cot)
    c_sea = baseline_by_week.get(cw, {}).get("p50", 0)
    c_tot = c_sea + c_su + c_wth + c_cot

    h_su  = np.vectorize(su_shift)(sim_su)
    h_wth = np.vectorize(weather_shift)(sim_wsi) * weather_sensitivity(horizon_week)
    h_sea = baseline_by_week.get(horizon_week, {}).get("p50", 0)
    h_tot = h_sea + h_su + h_wth + c_cot

    implied = cp / (1 + c_tot / 100)
    hor_std = baseline_by_week.get(horizon_week, {}).get("std", 5)
    noise   = z_price * hor_std * pn
    proj    = implied * (1 + (h_tot + noise) / 100)
    return np.sort(np.maximum(1.5, proj))


def compute_stats(results):
    n = len(results)
    if n == 0: return None
    def pct(p): return float(results[int(n * p)])
    return dict(
        mean=float(np.mean(results)), std=float(np.std(results)),
        p05=pct(0.05), p10=pct(0.10), p25=pct(0.25), p50=pct(0.50),
        p75=pct(0.75), p90=pct(0.90), p95=pct(0.95),
    )


def build_histogram(results, num_bins=30):
    mn, mx = results[0], results[-1]
    if mn == mx: return pd.DataFrame()
    bins    = np.linspace(mn, mx, num_bins + 1)
    centers = (bins[:-1] + bins[1:]) / 2
    counts, _ = np.histogram(results, bins=bins)
    return pd.DataFrame({"center": centers, "pct": counts / len(results) * 100})


def week_to_month(week):
    d = datetime.date(2024, 1, 1) + datetime.timedelta(weeks=int(week) - 1)
    return d.strftime("%b")


# ══════════════════════════════════════════════
# PAGE LAYOUT
# ══════════════════════════════════════════════

# ── HEADER ────────────────────────────────────
st.markdown("""
<div style="border-bottom:3px double #8b6f3f;padding-bottom:16px;margin-bottom:24px;">
  <div style="font-size:11px;letter-spacing:3px;color:#8b6f3f;margin-bottom:4px;">
    PHASE 5 — MONTE CARLO SIMULATION
  </div>
  <h1 style="font-size:36px;margin:0;font-weight:normal;letter-spacing:-1px;color:#2a2419;font-family:Georgia,serif;">
    Corn Futures <span style="font-style:italic;color:#8b6f3f;">Probability Model</span>
  </h1>
</div>
""", unsafe_allow_html=True)


# ── CONTROL ROW 1: Market State (3 cols, tan bg) ──
with st.container():
    st.markdown('<div style="background:#ede4d3;border:1px solid #c4a76a;padding:14px;margin-bottom:12px;">', unsafe_allow_html=True)
    c1, c2, c3 = st.columns(3)
    with c1:
        st.markdown('<span style="font-size:10px;letter-spacing:2px;color:#8b6f3f;">CURRENT WEEK</span>', unsafe_allow_html=True)
        current_week = st.slider("cw", 1, 52, 20, label_visibility="collapsed")
        st.markdown(f'<div style="font-size:13px;color:#2a2419;">W{current_week} · {week_to_month(current_week)}</div>', unsafe_allow_html=True)
    with c2:
        st.markdown('<span style="font-size:10px;letter-spacing:2px;color:#8b6f3f;">CURRENT PRICE</span>', unsafe_allow_html=True)
        current_price = st.number_input("cp", min_value=1.0, max_value=15.0, value=4.65,
                                         step=0.05, format="%.2f", label_visibility="collapsed")
    with c3:
        st.markdown('<span style="font-size:10px;letter-spacing:2px;color:#8b6f3f;">HORIZON (WEEKS)</span>', unsafe_allow_html=True)
        horizon_weeks = st.slider("hw", 1, 26, 13, label_visibility="collapsed")
        horizon_week  = min(52, current_week + horizon_weeks)
        st.markdown(f'<div style="font-size:13px;color:#2a2419;">{horizon_weeks}w → {week_to_month(horizon_week)}</div>', unsafe_allow_html=True)
    st.markdown('</div>', unsafe_allow_html=True)


# ── CONTROL ROW 2: Fundamental Factors (4 cols, tan bg) ──
with st.container():
    st.markdown('<div style="background:#ede4d3;border:1px solid #c4a76a;padding:14px;margin-bottom:12px;">', unsafe_allow_html=True)
    f1, f2, f3, f4 = st.columns(4)
    with f1:
        st.markdown('<span style="font-size:10px;letter-spacing:2px;color:#8b6f3f;">S/U %</span>', unsafe_allow_html=True)
        stocks_to_use = st.slider("stu", 5.0, 22.0, 12.8, step=0.1, label_visibility="collapsed")
        st.markdown(f'<div style="font-size:13px;color:#2a2419;">{stocks_to_use:.1f}%</div>', unsafe_allow_html=True)
    with f2:
        st.markdown('<span style="font-size:10px;letter-spacing:2px;color:#8b6f3f;">TEMP (°F)</span>', unsafe_allow_html=True)
        temp_anomaly = st.slider("ta", -5.0, 10.0, 0.0, step=0.5, label_visibility="collapsed")
        sign = "+" if temp_anomaly > 0 else ""
        st.markdown(f'<div style="font-size:13px;color:#2a2419;">{sign}{temp_anomaly:.1f}°F</div>', unsafe_allow_html=True)
    with f3:
        st.markdown('<span style="font-size:10px;letter-spacing:2px;color:#8b6f3f;">PRECIP (%)</span>', unsafe_allow_html=True)
        precip_anomaly = st.slider("pa", -80, 50, 0, step=5, label_visibility="collapsed")
        psign = "+" if precip_anomaly > 0 else ""
        st.markdown(f'<div style="font-size:13px;color:#2a2419;">{psign}{precip_anomaly}%</div>', unsafe_allow_html=True)
    with f4:
        st.markdown('<span style="font-size:10px;letter-spacing:2px;color:#8b6f3f;">COT %ILE</span>', unsafe_allow_html=True)
        cot_percentile = st.slider("cot", 0, 100, 50, label_visibility="collapsed")
        st.markdown(f'<div style="font-size:13px;color:#2a2419;">{cot_percentile}</div>', unsafe_allow_html=True)
    st.markdown('</div>', unsafe_allow_html=True)


# ── CONTROL ROW 3: Uncertainty Calibration (5 cols, dark bg) ──
st.markdown("""
<div style="background:#2a2419;padding:6px 14px 0 14px;margin-bottom:0;">
  <div style="font-size:10px;letter-spacing:2px;color:#c4a76a;padding-top:8px;padding-bottom:4px;">
    UNCERTAINTY CALIBRATION · HOW UNCERTAIN ARE YOUR INPUTS?
  </div>
</div>
""", unsafe_allow_html=True)

u1, u2, u3, u4, u5 = st.columns(5)
with u1:
    st.markdown('<span style="font-size:10px;font-weight:600;color:#4a3820;letter-spacing:1px;">S/U ± (%)</span>', unsafe_allow_html=True)
    su_uncertainty = st.slider("suu", 0.0, 4.0, 1.5, step=0.1, label_visibility="collapsed")
    st.markdown(f'<div style="font-size:13px;font-weight:bold;color:#2a2419;">±{su_uncertainty:.1f}</div>', unsafe_allow_html=True)
with u2:
    st.markdown('<span style="font-size:10px;font-weight:600;color:#4a3820;letter-spacing:1px;">Weather ±</span>', unsafe_allow_html=True)
    weather_uncertainty = st.slider("wu", 0.0, 5.0, 2.0, step=0.1, label_visibility="collapsed")
    st.markdown(f'<div style="font-size:13px;font-weight:bold;color:#2a2419;">±{weather_uncertainty:.1f}</div>', unsafe_allow_html=True)
with u3:
    st.markdown('<span style="font-size:10px;font-weight:600;color:#4a3820;letter-spacing:1px;">COT ±</span>', unsafe_allow_html=True)
    cot_uncertainty = st.slider("cu", 0.0, 3.0, 1.5, step=0.1, label_visibility="collapsed")
    st.markdown(f'<div style="font-size:13px;font-weight:bold;color:#2a2419;">±{cot_uncertainty:.1f}</div>', unsafe_allow_html=True)
with u4:
    st.markdown('<span style="font-size:10px;font-weight:600;color:#4a3820;letter-spacing:1px;">Price noise ×</span>', unsafe_allow_html=True)
    price_noise = st.slider("pn", 0.5, 2.5, 1.0, step=0.1, label_visibility="collapsed")
    st.markdown(f'<div style="font-size:13px;font-weight:bold;color:#2a2419;">{price_noise:.1f}×</div>', unsafe_allow_html=True)
with u5:
    st.markdown('<span style="font-size:10px;font-weight:600;color:#4a3820;letter-spacing:1px;">Simulations</span>', unsafe_allow_html=True)
    num_sims = st.slider("ns", 1000, 15000, 5000, step=1000, label_visibility="collapsed")
    st.markdown(f'<div style="font-size:13px;font-weight:bold;color:#2a2419;">{num_sims:,}</div>', unsafe_allow_html=True)

st.markdown("<div style='margin-bottom:12px;'></div>", unsafe_allow_html=True)


# ── PRICE TARGET ROW ──
pt_label, pt_slider, pt_val = st.columns([2, 6, 1])
with pt_label:
    st.markdown('<span style="font-size:11px;letter-spacing:2px;color:#8b6f3f;line-height:2.8;display:block;">PRICE TARGET FOR PROBABILITY:</span>', unsafe_allow_html=True)
with pt_slider:
    price_target = st.slider("pt", 3.0, 10.0, 5.50, step=0.05, label_visibility="collapsed")
with pt_val:
    st.markdown(f'<div style="font-size:18px;color:#3a7c4e;padding-top:4px;">${price_target:.2f}</div>', unsafe_allow_html=True)

st.markdown("<div style='margin-bottom:24px;'></div>", unsafe_allow_html=True)


# ──────────────────────────────────────────────
# RUN SIMULATION
# ──────────────────────────────────────────────
params = dict(
    current_week=current_week,       current_price=current_price,
    stocks_to_use=stocks_to_use,     temp_anomaly=temp_anomaly,
    precip_anomaly=precip_anomaly,   cot_percentile=cot_percentile,
    su_uncertainty=su_uncertainty,   weather_uncertainty=weather_uncertainty,
    cot_uncertainty=cot_uncertainty, price_noise=price_noise,
)

with st.spinner(f"Running {num_sims:,} simulations…"):
    results   = run_monte_carlo(params, num_sims, horizon_week)
    stats     = compute_stats(results)
    histogram = build_histogram(results, 30)
    prob_above = float(np.mean(results > price_target))
    prob_below = float(np.mean(results < current_price))

    fan_rows = [dict(week=current_week,
                     p05=current_price, p25=current_price, p50=current_price,
                     p75=current_price, p95=current_price)]
    for h in range(1, 27):
        hw = min(52, current_week + h)
        hr = run_monte_carlo(params, 500, hw)
        hs = compute_stats(hr)
        fan_rows.append(dict(week=hw,
                             p05=hs["p05"], p25=hs["p25"], p50=hs["p50"],
                             p75=hs["p75"], p95=hs["p95"]))
    fan_df = pd.DataFrame(fan_rows)


# ── KEY PROBABILITY METRICS (4 colored cards) ──
st.markdown(f"""
<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
  <div class="metric-card" style="background:#3a7c4e;">
    <div class="metric-label">P(PRICE &gt; ${price_target:.2f})</div>
    <div class="metric-value">{prob_above*100:.0f}%</div>
    <div class="metric-sub">at week {horizon_week}</div>
  </div>
  <div class="metric-card" style="background:#c0392b;">
    <div class="metric-label">P(PRICE &lt; ${current_price:.2f})</div>
    <div class="metric-value">{prob_below*100:.0f}%</div>
    <div class="metric-sub">downside probability</div>
  </div>
  <div class="metric-card" style="background:#2a4d6e;">
    <div class="metric-label">EXPECTED VALUE</div>
    <div class="metric-value">${stats['mean']:.2f}</div>
    <div class="metric-sub">±${stats['std']:.2f} std</div>
  </div>
  <div class="metric-card" style="background:#2a2419;">
    <div class="metric-label">VAR (5%)</div>
    <div class="metric-value">${stats['p05']:.2f}</div>
    <div class="metric-sub">95% worst case</div>
  </div>
</div>
<div style="font-size:13px;color:#4a3820;margin-bottom:24px;">
  {num_sims:,} simulations · Correlated factor uncertainty · Full probability distributions
</div>
""", unsafe_allow_html=True)


# ── FAN CHART ──
st.markdown("""
<div style="background:#fff;border:1px solid #c4a76a;padding:24px 24px 0 24px;margin-bottom:0;">
  <h2 style="font-size:20px;margin:0 0 4px 0;font-weight:normal;font-family:Georgia,serif;color:#2a2419;">
    Monte Carlo price fan
  </h2>
  <div style="font-size:12px;color:#4a3820;margin-bottom:4px;">
    Inner band: 25th–75th percentile · Outer band: 5th–95th percentile · Line: median path
  </div>
</div>
""", unsafe_allow_html=True)

fig_fan = go.Figure()
fig_fan.add_trace(go.Scatter(
    x=list(fan_df["week"]) + list(fan_df["week"][::-1]),
    y=list(fan_df["p95"])  + list(fan_df["p05"][::-1]),
    fill="toself", fillcolor="rgba(139,111,63,0.18)",
    line=dict(color="rgba(0,0,0,0)"), name="5–95th %ile", hoverinfo="skip",
))
fig_fan.add_trace(go.Scatter(
    x=list(fan_df["week"]) + list(fan_df["week"][::-1]),
    y=list(fan_df["p75"])  + list(fan_df["p25"][::-1]),
    fill="toself", fillcolor="rgba(139,111,63,0.35)",
    line=dict(color="rgba(0,0,0,0)"), name="25–75th %ile", hoverinfo="skip",
))
fig_fan.add_trace(go.Scatter(
    x=fan_df["week"], y=fan_df["p50"],
    mode="lines", line=dict(color="#2a2419", width=2.5), name="Median",
))
fig_fan.add_hline(y=current_price, line=dict(color="#c0392b", dash="dash", width=1.5),
                  annotation_text="Current", annotation_font_color="#c0392b",
                  annotation_position="right")
fig_fan.add_hline(y=price_target, line=dict(color="#3a7c4e", dash="dash", width=1.5),
                  annotation_text="Target", annotation_font_color="#3a7c4e",
                  annotation_position="right")

tick_vals = sorted(set([int(fan_df["week"].iloc[0])] + [int(w) for w in fan_df["week"] if w % 8 == 0]))
tick_text = [week_to_month(w) for w in tick_vals]
fig_fan.update_layout(
    xaxis=dict(tickvals=tick_vals, ticktext=tick_text, showgrid=True, gridcolor="#c8b48a", tickfont=dict(color="#1a1008", size=12)),
    yaxis=dict(tickformat="$.2f", showgrid=True, gridcolor="#c8b48a", tickfont=dict(color="#1a1008", size=12)),
    paper_bgcolor="#ffffff", plot_bgcolor="#ffffff",
    legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1,
                font=dict(family="Georgia, serif", size=12)),
    height=400, margin=dict(l=60, r=100, t=10, b=40),
    font=dict(family="Georgia, serif", color="#1a1008"),
)
st.plotly_chart(fig_fan, use_container_width=True)
st.markdown("<div style='margin-bottom:24px;'></div>", unsafe_allow_html=True)


# ── HISTOGRAM ──
st.markdown(f"""
<div style="background:#fff;border:1px solid #c4a76a;padding:24px 24px 0 24px;margin-bottom:0;">
  <h2 style="font-size:20px;margin:0 0 4px 0;font-weight:normal;font-family:Georgia,serif;color:#2a2419;">
    Terminal price distribution at {week_to_month(horizon_week)}
  </h2>
  <div style="font-size:12px;color:#4a3820;margin-bottom:4px;">
    <span style="color:#c0392b;">Red: below current ${current_price:.2f}</span> ·
    <span style="color:#7a5230;">Brown: between</span> ·
    <span style="color:#3a7c4e;">Green: above target ${price_target:.2f}</span>
  </div>
</div>
""", unsafe_allow_html=True)

if not histogram.empty:
    bar_colors = [
        "#c0392b" if c < current_price else
        "#3a7c4e" if c > price_target  else "#8b6f3f"
        for c in histogram["center"]
    ]
    fig_hist = go.Figure()
    fig_hist.add_trace(go.Bar(
        x=histogram["center"], y=histogram["pct"],
        marker_color=bar_colors,
        hovertemplate="~$%{x:.2f}<br>%{y:.2f}%<extra></extra>",
    ))
    fig_hist.add_vline(x=current_price, line=dict(color="#c0392b", dash="dash", width=1.5))
    fig_hist.add_vline(x=price_target,  line=dict(color="#3a7c4e", dash="dash", width=1.5))
    fig_hist.add_vline(x=stats["mean"], line=dict(color="#2a2419", dash="dot",  width=1.5))
    fig_hist.update_layout(
        xaxis=dict(tickformat="$.2f", showgrid=True, gridcolor="#c8b48a", tickfont=dict(color="#1a1008", size=12)),
        yaxis=dict(tickformat=".1f",  showgrid=True, gridcolor="#c8b48a", tickfont=dict(color="#1a1008", size=12)),
        paper_bgcolor="#ffffff", plot_bgcolor="#ffffff",
        height=300, margin=dict(l=60, r=40, t=10, b=40),
        showlegend=False, bargap=0.05,
        font=dict(family="Georgia, serif", color="#1a1008"),
    )
    st.plotly_chart(fig_hist, use_container_width=True)

st.markdown("<div style='margin-bottom:24px;'></div>", unsafe_allow_html=True)


# ── STATISTICS TABLE ──
skew = ("Right" if stats["mean"] > stats["p50"] else
        "Left"  if stats["mean"] < stats["p50"] else "Sym")

st.markdown(f"""
<div style="background:#fff;border:1px solid #c4a76a;padding:20px;margin-bottom:24px;">
  <div style="font-size:14px;letter-spacing:2px;color:#6b4f2a;margin-bottom:16px;font-weight:600;font-family:Georgia,serif;">
    DISTRIBUTION STATISTICS
  </div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;font-size:14px;font-family:Georgia,serif;">
    <div><div class="stats-label">5th %ile</div><div class="stats-value">${stats['p05']:.2f}</div></div>
    <div><div class="stats-label">25th %ile</div><div class="stats-value">${stats['p25']:.2f}</div></div>
    <div><div class="stats-label">MEDIAN</div><div class="stats-value-bold">${stats['p50']:.2f}</div></div>
    <div><div class="stats-label">MEAN</div><div class="stats-value">${stats['mean']:.2f}</div></div>
    <div><div class="stats-label">75th %ile</div><div class="stats-value">${stats['p75']:.2f}</div></div>
    <div><div class="stats-label">95th %ile</div><div class="stats-value">${stats['p95']:.2f}</div></div>
    <div><div class="stats-label">STD DEV</div><div class="stats-value">${stats['std']:.2f}</div></div>
    <div><div class="stats-label">SKEW</div><div class="stats-value">{skew}</div></div>
  </div>
</div>
""", unsafe_allow_html=True)


# ── TRADING IMPLICATIONS ──
exp_ret  = (stats["mean"] / current_price - 1) * 100
prob_p   = (1 - prob_below) * 100
move_pct = (price_target / current_price - 1) * 100
var_pct  = (stats["p05"]  / current_price - 1) * 100
kelly    = max(0.0, (prob_above - 0.5) * 100)

skew_desc = ("Right-skewed — small edge but large upside tail"
             if stats["mean"] > stats["p50"] else
             "Left-skewed — most paths up but tail risk down"
             if stats["mean"] < stats["p50"] else
             "Symmetric distribution")

if prob_above > 0.6:
    signal = '<span style="color:#5ca86b;"><strong>Favorable setup:</strong> Probability of upside breakout materially exceeds 50%. Consider defined-risk long exposure.</span>'
elif prob_above < 0.3:
    signal = '<span style="color:#e08080;"><strong>Unfavorable long:</strong> Probability of reaching target is low. Either skip or consider short-side structures.</span>'
else:
    signal = '<span style="color:#c4a76a;"><strong>Mixed setup:</strong> Probabilities are roughly balanced. Wait for clearer setup or use non-directional structures (straddles).</span>'

st.markdown(f"""
<div style="background:#2a2419;color:#f5f0e8;border:1px solid #8b6f3f;padding:24px;margin-bottom:24px;font-size:15px;line-height:1.8;font-family:Georgia,serif;">
  <div style="font-size:11px;letter-spacing:3px;color:#c4a76a;margin-bottom:12px;">TRADING IMPLICATIONS</div>
  <strong>Expected return:</strong> {exp_ret:.1f}% over {horizon_weeks} weeks.&nbsp;
  <strong>Probability of profit (long):</strong> {prob_p:.0f}%.&nbsp;
  <strong>Asymmetry:</strong> {skew_desc}.<br><br>
  <strong>Position sizing (Kelly approximation):</strong> With {prob_above*100:.0f}% chance of reaching
  ${price_target:.2f} (a {move_pct:.0f}% move) and downside VaR of ${stats['p05']:.2f}
  (a {var_pct:.0f}% move), the edge-adjusted position size is modest.
  Real Kelly: size at {kelly:.0f}% of max — and half-Kelly in practice.<br><br>
  {signal}
</div>
""", unsafe_allow_html=True)
