const { calculateHRScore, ratePitcherMatchup, getThreatRating } = require('./hrEngine');

// ─────────────────────────────────────────────────────────────────────────────
// All parlay and prediction logic lives here on the server.
// The app receives finished picks — it never runs a loop.
// ─────────────────────────────────────────────────────────────────────────────

function buildDailyPayload(games) {
  // Collect top 2 HR threats per game — lean objects only
  const allPicks = [];
  games.forEach(game => {
    (game.topPicks || []).forEach(p => {
      if (!allPicks.find(x => x.playerId === p.playerId)) {
        allPicks.push(p);
      }
    });
  });

  allPicks.sort((a, b) => b.confidenceRating - a.confidenceRating);

  // Daily AI Pick — best 3-player combo from top picks
  const dailyPick  = buildDailyAIPick(allPicks);

  // Smart parlays — top combinations by HR score
  const smartParlays = buildSmartParlays(allPicks);

  // Long shot parlays — high upside combinations
  const longShots = buildLongShotParlays(allPicks, smartParlays.usedIds);

  // Top 10 individual HR threats
  const topThreats = allPicks.slice(0, 10).map(p => ({
    playerId:         p.playerId,
    name:             p.name,
    position:         p.position,
    teamAbbreviation: p.teamAbbreviation,
    gameTime:         p.gameTime,
    venueName:        p.venueName,
    hrScore:          p.confidenceRating,
    threatRating:     p.advancedMetrics?.threatRating || 'MODERATE',
    dataSource:       p.advancedMetrics?.dataSource   || 'derived',
    barrelRate:       p.advancedMetrics?.barrelRate    || 0,
    hardHitRate:      p.advancedMetrics?.hardHitRate   || 0,
    avgExitVelocity:  p.advancedMetrics?.avgExitVelocity || 0,
    seasonHR:         p.seasonStats?.homeRuns          || 0,
    recentTrend:      p.recentForm?.trend              || 'stable',
    last10HR:         p.recentForm?.last10HR           || 0,
    battingOrder:     p.battingOrder                   || 0,
    isOfficialStarter:p.isOfficialStarter              || false,
    pitcherHand:      p.vsOpposingPitcher?.pitcherHand || 'R',
    pitcherERA:       p.vsOpposingPitcher?.pitcherERA  || null,
    matchupAdvantage: p.vsOpposingPitcher?.advantage   || 'neutral',
    venueHRFactor:    p.venueHRFactor                  || 1.0,
    injuryStatus:     p.injuryStatus                   || { isInjured: false },
    isAvailable:      p.isAvailable !== false,
  }));

  return { dailyPick, smartParlays: smartParlays.parlays, longShots, topThreats };
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily AI Pick — best single 3-player parlay across the full slate
// ─────────────────────────────────────────────────────────────────────────────
function buildDailyAIPick(players) {
  if (players.length < 2) return null;

  const pool = players.filter(p => p.isAvailable && !p.injuryStatus?.isInjured).slice(0, 15);
  let bestParlay = null;
  let bestScore  = -1;

  // Try all 3-player combinations from top 15 — server can handle this, phone cannot
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const combo  = [pool[i], pool[j], pool[k]];
        const score  = scoreParlayCombo(combo);
        if (score > bestScore) {
          bestScore  = score;
          bestParlay = combo;
        }
      }
    }
  }

  if (!bestParlay) return null;

  return {
    players:     bestParlay.map(miniPlayer),
    probability: calcProbability(bestParlay),
    odds:        calcOdds(calcProbability(bestParlay)),
    score:       Math.round(bestScore),
    strength:    getStrength(bestScore),
    reasoning:   buildReasoning(bestParlay),
    isDailyPick: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Parlays — top 2-leg, 3-leg, 4-leg combos by value
// ─────────────────────────────────────────────────────────────────────────────
function buildSmartParlays(players) {
  const pool    = players.filter(p => p.isAvailable && !p.injuryStatus?.isInjured).slice(0, 12);
  const usedIds = new Set();
  const parlays = [];

  // 2-leg: top 3
  const twos = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      twos.push([pool[i], pool[j]]);
    }
  }
  twos.sort((a, b) => scoreParlayCombo(b) - scoreParlayCombo(a));
  twos.slice(0, 3).forEach(combo => {
    parlays.push(buildParlay(combo, '2-Leg'));
    combo.forEach(p => usedIds.add(p.playerId));
  });

  // 3-leg: top 3
  const threes = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        threes.push([pool[i], pool[j], pool[k]]);
      }
    }
  }
  threes.sort((a, b) => scoreParlayCombo(b) - scoreParlayCombo(a));
  threes.slice(0, 3).forEach(combo => {
    parlays.push(buildParlay(combo, '3-Leg'));
    combo.forEach(p => usedIds.add(p.playerId));
  });

  // 4-leg: top 3
  const fours = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        for (let l = k + 1; l < pool.length; l++) {
          fours.push([pool[i], pool[j], pool[k], pool[l]]);
        }
      }
    }
  }
  fours.sort((a, b) => scoreParlayCombo(b) - scoreParlayCombo(a));
  fours.slice(0, 3).forEach(combo => {
    parlays.push(buildParlay(combo, '4-Leg'));
    combo.forEach(p => usedIds.add(p.playerId));
  });

  return { parlays, usedIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Long Shot Parlays — high upside from remaining players
// ─────────────────────────────────────────────────────────────────────────────
function buildLongShotParlays(players, usedIds) {
  const pool = players
    .filter(p => p.isAvailable && !p.injuryStatus?.isInjured)
    .slice(0, 15);

  const parlays = [];

  // 2-leg long shots
  const twos = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      twos.push([pool[i], pool[j]]);
    }
  }
  twos.sort((a, b) => upsideScore(b) - upsideScore(a));
  twos.slice(0, 3).forEach(combo => parlays.push(buildParlay(combo, '2-Leg Long Shot', true)));

  // 3-leg long shots
  const threes = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        threes.push([pool[i], pool[j], pool[k]]);
      }
    }
  }
  threes.sort((a, b) => upsideScore(b) - upsideScore(a));
  threes.slice(0, 3).forEach(combo => parlays.push(buildParlay(combo, '3-Leg Long Shot', true)));

  return parlays;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function scoreParlayCombo(players) {
  const avgHR     = players.reduce((s, p) => s + p.confidenceRating, 0) / players.length;
  const diversity = new Set(players.map(p => p.gameId)).size * 5;
  const hotBonus  = players.filter(p => p.recentForm?.trend === 'hot').length * 4;
  const official  = players.filter(p => p.isOfficialStarter).length * 3;
  return avgHR + diversity + hotBonus + official;
}

function upsideScore(players) {
  return players.reduce((s, p) => {
    let score = p.confidenceRating * 0.5;
    if (p.advancedMetrics?.barrelRate >= 12) score += 20;
    if (p.advancedMetrics?.avgExitVelocity >= 92) score += 15;
    if (p.recentForm?.trend === 'hot') score += 10;
    return s + score;
  }, 0) / players.length;
}

function calcProbability(players) {
  const probs = players.map(p => Math.min(p.confidenceRating / 100, 0.92));
  return parseFloat((probs.reduce((a, b) => a * b, 1) * 100).toFixed(2));
}

function calcOdds(probability) {
  if (probability <= 0) return 9999;
  return Math.round(((100 / probability) - 1) * 100);
}

function getStrength(score) {
  if (score >= 85) return { rating: 'ELITE',       color: '#4CAF50', description: 'Premium pick' };
  if (score >= 70) return { rating: 'STRONG',      color: '#8BC34A', description: 'High confidence' };
  if (score >= 55) return { rating: 'SOLID',       color: '#FF9800', description: 'Solid play' };
  if (score >= 40) return { rating: 'GOOD',        color: '#FF5722', description: 'Good value' };
  return              { rating: 'SPECULATIVE', color: '#9E9E9E', description: 'Speculative' };
}

function buildReasoning(players) {
  const reasons = [];
  const hot = players.filter(p => p.recentForm?.trend === 'hot').length;
  if (hot > 0) reasons.push(`${hot} player${hot > 1 ? 's' : ''} on hot streak`);
  const extreme = players.filter(p => p.advancedMetrics?.threatRating === 'EXTREME').length;
  if (extreme > 0) reasons.push(`${extreme} EXTREME threat rating`);
  const official = players.filter(p => p.isOfficialStarter).length;
  if (official > 0) reasons.push(`${official} confirmed starter${official > 1 ? 's' : ''}`);
  const games = new Set(players.map(p => p.gameId)).size;
  if (games > 1) reasons.push(`Spread across ${games} games`);
  const avgBarrel = players.reduce((s, p) => s + (p.advancedMetrics?.barrelRate || 0), 0) / players.length;
  if (avgBarrel >= 10) reasons.push(`${avgBarrel.toFixed(1)}% avg barrel rate`);
  return reasons.slice(0, 4);
}

function buildParlay(players, label, isLongShot = false) {
  const prob = calcProbability(players);
  return {
    id:          `parlay_${players.map(p => p.playerId).join('_')}`,
    label,
    isLongShot,
    players:     players.map(miniPlayer),
    probability: prob,
    odds:        calcOdds(prob),
    avgHRScore:  Math.round(players.reduce((s, p) => s + p.confidenceRating, 0) / players.length),
    reasoning:   buildReasoning(players),
    avgBarrelRate:    parseFloat((players.reduce((s, p) => s + (p.advancedMetrics?.barrelRate || 0), 0) / players.length).toFixed(1)),
    avgExitVelocity:  parseFloat((players.reduce((s, p) => s + (p.advancedMetrics?.avgExitVelocity || 0), 0) / players.length).toFixed(1)),
    threatLevel:  getThreatLevelFromPlayers(players),
  };
}

function miniPlayer(p) {
  return {
    playerId:         p.playerId,
    name:             p.name,
    position:         p.position,
    teamAbbreviation: p.teamAbbreviation,
    hrScore:          p.confidenceRating,
    threatRating:     p.advancedMetrics?.threatRating || 'MODERATE',
    dataSource:       p.advancedMetrics?.dataSource   || 'derived',
    barrelRate:       p.advancedMetrics?.barrelRate    || 0,
    hardHitRate:      p.advancedMetrics?.hardHitRate   || 0,
    avgExitVelocity:  p.advancedMetrics?.avgExitVelocity || 0,
    seasonHR:         p.seasonStats?.homeRuns          || 0,
    recentTrend:      p.recentForm?.trend              || 'stable',
    battingOrder:     p.battingOrder                   || 0,
    isOfficialStarter:p.isOfficialStarter              || false,
    gameId:           p.gameId,
    gameTime:         p.gameTime,
    venueName:        p.venueName,
    venueHRFactor:    p.venueHRFactor                  || 1.0,
    matchupAdvantage: p.vsOpposingPitcher?.advantage   || 'neutral',
  };
}

function getThreatLevelFromPlayers(players) {
  const scores = { EXTREME: 4, HIGH: 3, MODERATE: 2, LOW: 1, MINIMAL: 0 };
  const avg = players.reduce((s, p) => s + (scores[p.advancedMetrics?.threatRating] || 2), 0) / players.length;
  if (avg >= 3.5) return 'EXTREME';
  if (avg >= 2.5) return 'HIGH';
  if (avg >= 1.5) return 'MODERATE';
  return 'LOW';
}

module.exports = { buildDailyPayload };
