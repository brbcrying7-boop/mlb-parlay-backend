// ─────────────────────────────────────────────────────────────────────────────
// HR SCORE ENGINE
//
// HR Score =
//   (Barrel%       * 0.35)  ← strongest Statcast HR predictor
//   (HardHit%      * 0.20)  ← contact quality
//   (Exit Velocity * 0.15)  ← raw power ceiling
//   (Pitcher HR/9  * 0.20)  ← pitcher vulnerability
//   (Park Factor   * 0.10)  ← venue context
//
// Each component is normalized 0–100 before weighting.
// Context modifiers (weather, lineup, form, availability) applied after.
// Final score clamped to 5–95.
// ─────────────────────────────────────────────────────────────────────────────

function calculateHRScore({
  statcast,        // from statcastService
  pitcherStats,    // from mlbService.getPitcherStats
  parkFactor,      // number, e.g. 1.35 for Coors
  weather,         // { temperature, windSpeed, windDirection }
  seasonStats,     // player season batting stats
  recentForm,      // { trend, homeRuns, last10HR }
  battingOrder,    // 1–9 or 0 if unknown
  isOfficialStarter,
  isAvailable,
  injuryStatus,
}) {
  // ── COMPONENT 1: Barrel% (weight 0.35) ───────────────────────────────────
  // MLB elite ceiling ~20–22%. Normalize against 25 as max.
  const barrelPct  = Math.min(statcast?.barrelRate  || 0, 25);
  const barrelNorm = (barrelPct / 25) * 100;

  // ── COMPONENT 2: Hard Hit% (weight 0.20) ─────────────────────────────────
  // MLB elite ~55%+. Normalize against 65.
  const hardHitPct  = Math.min(statcast?.hardHitRate || 0, 65);
  const hardHitNorm = (hardHitPct / 65) * 100;

  // ── COMPONENT 3: Exit Velocity (weight 0.15) ─────────────────────────────
  // Meaningful range 80–105 mph.
  const ev     = statcast?.avgExitVelo || 87;
  const evNorm = Math.min(Math.max(((ev - 80) / (105 - 80)) * 100, 0), 100);

  // ── COMPONENT 4: Pitcher HR/9 (weight 0.20) ──────────────────────────────
  // Scale 0–2.5; higher means pitcher gives up more HRs → better for batter.
  let pitcherHR9 = pitcherStats?.hr9;

  if (!pitcherHR9 || pitcherHR9 <= 0) {
    // ERA proxy: MLB avg ~4.00 ERA maps to ~1.15 HR9
    const era  = pitcherStats?.era || 4.00;
    pitcherHR9 = Math.max(0.4, (era / 4.00) * 1.15);
  }

  const hr9Norm = Math.min((pitcherHR9 / 2.5) * 100, 100);

  // ── COMPONENT 5: Park Factor (weight 0.10) ────────────────────────────────
  // Range 0.75 (pitcher parks) to 1.40 (Coors). Normalize to 0–100.
  const pf     = parkFactor || 1.0;
  const pfNorm = Math.min(Math.max(((pf - 0.75) / (1.40 - 0.75)) * 100, 0), 100);

  // ── WEIGHTED BASE SCORE ───────────────────────────────────────────────────
  const baseScore =
    (barrelNorm  * 0.35) +
    (hardHitNorm * 0.20) +
    (evNorm      * 0.15) +
    (hr9Norm     * 0.20) +
    (pfNorm      * 0.10);

  let score = baseScore;

  // ── CONTEXT MODIFIERS ─────────────────────────────────────────────────────

  // Weather — wind blowing out meaningfully raises HR probability
  if (weather) {
    const outDirs = ['S', 'SW', 'SE'];
    const inDirs  = ['N', 'NW', 'NE'];
    if (outDirs.includes(weather.windDirection) && weather.windSpeed >= 10) {
      score += Math.min(weather.windSpeed * 0.35, 8);
    } else if (inDirs.includes(weather.windDirection) && weather.windSpeed >= 12) {
      score -= Math.min(weather.windSpeed * 0.25, 6);
    }
    if (weather.temperature >= 85) score += 4;
    else if (weather.temperature >= 75) score += 2;
    else if (weather.temperature <= 50) score -= 4;
  }

  // Lineup position — more plate appearances = more chances
  if (battingOrder >= 1 && battingOrder <= 4) score += 7;
  else if (battingOrder >= 5 && battingOrder <= 6) score += 3;

  // Confirmed in official lineup
  if (isOfficialStarter) score += 8;

  // Pitcher handedness — most batters hit better vs LHP
  if (pitcherStats?.throwsHand === 'L') score += 4;

  // Recent form
  if (recentForm?.trend === 'hot')  score += 8;
  if (recentForm?.trend === 'cold') score -= 7;
  score += Math.min((recentForm?.homeRuns || 0) * 3, 9);

  // Season HR total — validates the power profile
  const seasonHR = seasonStats?.homeRuns || 0;
  if (seasonHR >= 30) score += 8;
  else if (seasonHR >= 22) score += 5;
  else if (seasonHR >= 14) score += 2;

  // ISO sanity — if near zero, power profile is unreliable
  const slg = parseFloat(seasonStats?.slg || '0.400');
  const avg  = parseFloat(seasonStats?.avg || '0.250');
  const iso  = slg - avg;
  if (iso < 0.080) score -= 10;

  // Availability
  if (!isAvailable) score -= 35;
  if (injuryStatus?.isInjured) score -= 20;

  // ── SCORE COMPONENTS (returned for transparency) ──────────────────────────
  const components = {
    barrelComponent:   parseFloat((barrelNorm  * 0.35).toFixed(2)),
    hardHitComponent:  parseFloat((hardHitNorm * 0.20).toFixed(2)),
    evComponent:       parseFloat((evNorm      * 0.15).toFixed(2)),
    pitcherComponent:  parseFloat((hr9Norm     * 0.20).toFixed(2)),
    parkComponent:     parseFloat((pfNorm      * 0.10).toFixed(2)),
    contextAdjustment: parseFloat((score - baseScore).toFixed(2)),
    dataSource:        statcast?.source || 'derived',
  };

  return {
    hrScore:    Math.min(Math.max(Math.round(score), 5), 95),
    components,
    inputs: {
      barrelPct:   barrelPct.toFixed(1),
      hardHitPct:  hardHitPct.toFixed(1),
      exitVelo:    ev.toFixed(1),
      pitcherHR9:  pitcherHR9.toFixed(2),
      parkFactor:  pf.toFixed(2),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pitcher matchup rating (separate from main HR score — used for display)
// ─────────────────────────────────────────────────────────────────────────────
function ratePitcherMatchup(pitcherStats, playerSeasonStats) {
  if (!pitcherStats) return { advantage: 'neutral', confidence: 50 };

  let score = 50;

  const era  = pitcherStats.era  || 4.00;
  const whip = pitcherStats.whip || 1.30;
  const hr9  = pitcherStats.hr9  || 1.15;

  if (era  >= 5.00) score += 15;
  else if (era  >= 4.50) score += 10;
  else if (era  >= 4.00) score += 5;
  else if (era  <= 2.50) score -= 12;
  else if (era  <= 3.25) score -= 7;

  if (whip >= 1.50) score += 8;
  else if (whip >= 1.30) score += 4;
  else if (whip <= 1.00) score -= 8;
  else if (whip <= 1.10) score -= 4;

  if (hr9 >= 1.50) score += 12;
  else if (hr9 >= 1.20) score += 7;
  else if (hr9 <= 0.80) score -= 8;

  if (pitcherStats.throwsHand === 'L') score += 5;

  const ops = parseFloat(playerSeasonStats?.ops || '0.700');
  if (ops >= 0.900) score += 8;
  else if (ops >= 0.800) score += 4;
  else if (ops <= 0.600) score -= 6;

  score = Math.min(Math.max(score, 10), 90);
  const advantage = score >= 60 ? 'favorable' : score <= 40 ? 'unfavorable' : 'neutral';

  return {
    advantage,
    confidence: Math.round(score),
    pitcherHand: pitcherStats.throwsHand || 'R',
    pitcherERA:  pitcherStats.era  || null,
    pitcherWHIP: pitcherStats.whip || null,
    pitcherHR9:  pitcherStats.hr9  || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Threat rating label from HR score
// ─────────────────────────────────────────────────────────────────────────────
function getThreatRating(hrScore) {
  if (hrScore >= 75) return 'EXTREME';
  if (hrScore >= 60) return 'HIGH';
  if (hrScore >= 45) return 'MODERATE';
  if (hrScore >= 30) return 'LOW';
  return 'MINIMAL';
}

module.exports = { calculateHRScore, ratePitcherMatchup, getThreatRating };
