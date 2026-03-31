const express = require('express');
const cors    = require('cors');
const NodeCache = require('node-cache');
const mlb     = require('./mlbService');
const { buildGame } = require('./gameBuilder');
const { warmStatcastCache } = require('./statcastService');

// ─────────────────────────────────────────────────────────────────────────────
// PARLAY ENGINE — inlined to avoid module resolution issues
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

function getThreatLevelFromPlayers(players) {
  const scores = { EXTREME: 4, HIGH: 3, MODERATE: 2, LOW: 1, MINIMAL: 0 };
  const avg = players.reduce((s, p) => s + (scores[p.advancedMetrics?.threatRating] || 2), 0) / players.length;
  if (avg >= 3.5) return 'EXTREME';
  if (avg >= 2.5) return 'HIGH';
  if (avg >= 1.5) return 'MODERATE';
  return 'LOW';
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

function miniPlayer(p) {
  return {
    playerId: p.playerId, name: p.name, position: p.position,
    teamAbbreviation: p.teamAbbreviation, hrScore: p.confidenceRating,
    threatRating: p.advancedMetrics?.threatRating || 'MODERATE',
    dataSource: p.advancedMetrics?.dataSource || 'derived',
    barrelRate: p.advancedMetrics?.barrelRate || 0,
    hardHitRate: p.advancedMetrics?.hardHitRate || 0,
    avgExitVelocity: p.advancedMetrics?.avgExitVelocity || 0,
    seasonHR: p.seasonStats?.homeRuns || 0,
    recentTrend: p.recentForm?.trend || 'stable',
    battingOrder: p.battingOrder || 0,
    isOfficialStarter: p.isOfficialStarter || false,
    gameId: p.gameId, gameTime: p.gameTime, venueName: p.venueName,
    venueHRFactor: p.venueHRFactor || 1.0,
    matchupAdvantage: p.vsOpposingPitcher?.advantage || 'neutral',
  };
}

function buildParlay(players, label, isLongShot = false) {
  const prob = calcProbability(players);
  return {
    id: `parlay_${players.map(p => p.playerId).join('_')}`,
    label, isLongShot, players: players.map(miniPlayer), probability: prob,
    odds: calcOdds(prob),
    avgHRScore: Math.round(players.reduce((s, p) => s + p.confidenceRating, 0) / players.length),
    reasoning: buildReasoning(players),
    avgBarrelRate: parseFloat((players.reduce((s, p) => s + (p.advancedMetrics?.barrelRate || 0), 0) / players.length).toFixed(1)),
    avgExitVelocity: parseFloat((players.reduce((s, p) => s + (p.advancedMetrics?.avgExitVelocity || 0), 0) / players.length).toFixed(1)),
    threatLevel: getThreatLevelFromPlayers(players),
  };
}

function buildDailyPayload(games) {
  const allPicks = [];
  games.forEach(game => {
    (game.topPicks || []).forEach(p => {
      if (!allPicks.find(x => x.playerId === p.playerId)) allPicks.push(p);
    });
  });
  allPicks.sort((a, b) => b.confidenceRating - a.confidenceRating);

  // Daily AI Pick — best 3-player combo
  const pool = allPicks.filter(p => p.isAvailable && !p.injuryStatus?.isInjured).slice(0, 15);
  let dailyPick = null;
  if (pool.length >= 2) {
    let bestCombo = null, bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        for (let k = j + 1; k < Math.min(pool.length, j + 8); k++) {
          const combo = [pool[i], pool[j], pool[k]];
          const score = scoreParlayCombo(combo);
          if (score > bestScore) { bestScore = score; bestCombo = combo; }
        }
      }
    }
    if (bestCombo) {
      const prob = calcProbability(bestCombo);
      dailyPick = {
        players: bestCombo.map(miniPlayer), probability: prob, odds: calcOdds(prob),
        score: Math.round(bestScore), strength: getStrength(bestScore),
        reasoning: buildReasoning(bestCombo), isDailyPick: true,
      };
    }
  }

  // Smart parlays
  const smartPool = allPicks.filter(p => p.isAvailable && !p.injuryStatus?.isInjured).slice(0, 10);
  const smartParlays = [];
  if (smartPool.length >= 2) {
    const twos = [];
    for (let i = 0; i < smartPool.length; i++)
      for (let j = i + 1; j < smartPool.length; j++)
        twos.push([smartPool[i], smartPool[j]]);
    twos.sort((a, b) => scoreParlayCombo(b) - scoreParlayCombo(a));
    twos.slice(0, 3).forEach(c => smartParlays.push(buildParlay(c, '2-Leg Smart')));

    if (smartPool.length >= 3) {
      const threes = [];
      for (let i = 0; i < smartPool.length; i++)
        for (let j = i + 1; j < smartPool.length; j++)
          for (let k = j + 1; k < smartPool.length; k++)
            threes.push([smartPool[i], smartPool[j], smartPool[k]]);
      threes.sort((a, b) => scoreParlayCombo(b) - scoreParlayCombo(a));
      threes.slice(0, 3).forEach(c => smartParlays.push(buildParlay(c, '3-Leg Smart')));
    }

    if (smartPool.length >= 4) {
      const fours = [];
      for (let i = 0; i < smartPool.length; i++)
        for (let j = i + 1; j < smartPool.length; j++)
          for (let k = j + 1; k < smartPool.length; k++)
            for (let l = k + 1; l < smartPool.length; l++)
              fours.push([smartPool[i], smartPool[j], smartPool[k], smartPool[l]]);
      fours.sort((a, b) => scoreParlayCombo(b) - scoreParlayCombo(a));
      fours.slice(0, 3).forEach(c => smartParlays.push(buildParlay(c, '4-Leg Smart')));
    }
  }

  // Long shots
  const longShots = [];
  const lsPool = allPicks.filter(p => p.isAvailable && !p.injuryStatus?.isInjured).slice(0, 12);
  if (lsPool.length >= 2) {
    const lsTwos = [];
    for (let i = 0; i < lsPool.length; i++)
      for (let j = i + 1; j < lsPool.length; j++)
        lsTwos.push([lsPool[i], lsPool[j]]);
    lsTwos.sort((a, b) => upsideScore(b) - upsideScore(a));
    lsTwos.slice(0, 3).forEach(c => longShots.push(buildParlay(c, '2-Leg Long Shot', true)));

    if (lsPool.length >= 3) {
      const lsThrees = [];
      for (let i = 0; i < lsPool.length; i++)
        for (let j = i + 1; j < lsPool.length; j++)
          for (let k = j + 1; k < lsPool.length; k++)
            lsThrees.push([lsPool[i], lsPool[j], lsPool[k]]);
      lsThrees.sort((a, b) => upsideScore(b) - upsideScore(a));
      lsThrees.slice(0, 3).forEach(c => longShots.push(buildParlay(c, '3-Leg Long Shot', true)));
    }
  }

  // Top threats
  const topThreats = allPicks.slice(0, 10).map(p => ({
    playerId: p.playerId, name: p.name, position: p.position,
    teamAbbreviation: p.teamAbbreviation, gameTime: p.gameTime,
    venueName: p.venueName, hrScore: p.confidenceRating,
    threatRating: p.advancedMetrics?.threatRating || 'MODERATE',
    dataSource: p.advancedMetrics?.dataSource || 'derived',
    barrelRate: p.advancedMetrics?.barrelRate || 0,
    hardHitRate: p.advancedMetrics?.hardHitRate || 0,
    avgExitVelocity: p.advancedMetrics?.avgExitVelocity || 0,
    seasonHR: p.seasonStats?.homeRuns || 0,
    recentTrend: p.recentForm?.trend || 'stable',
    last10HR: p.recentForm?.last10HR || 0,
    battingOrder: p.battingOrder || 0,
    isOfficialStarter: p.isOfficialStarter || false,
    pitcherHand: p.vsOpposingPitcher?.pitcherHand || 'R',
    pitcherERA: p.vsOpposingPitcher?.pitcherERA || null,
    matchupAdvantage: p.vsOpposingPitcher?.advantage || 'neutral',
    venueHRFactor: p.venueHRFactor || 1.0,
    injuryStatus: p.injuryStatus || { isInjured: false },
    isAvailable: p.isAvailable !== false,
  }));

  return { dailyPick, smartParlays, longShots, topThreats };
}

const app  = express();
const PORT = process.env.PORT || 3001;

const slateCache = new NodeCache({ stdTTL: 600 });

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared: build and cache the full slate
// ─────────────────────────────────────────────────────────────────────────────
async function getOrBuildSlate(date) {
  const cacheKey = `slate_${date}`;
  const cached = slateCache.get(cacheKey);
  if (cached) return cached;

  console.log(`Building full slate for ${date}...`);
  const rawGames = await mlb.getTodaysSchedule(date);

  const bettable = new Set(['Scheduled', 'Pre-Game', 'Warmup', 'Delayed Start', 'Postponed']);
  const toProcess = rawGames.filter(g => {
    const s = g.status?.detailedState || '';
    return bettable.has(s) || s.toLowerCase().includes('scheduled');
  });

  console.log(`Processing ${toProcess.length} of ${rawGames.length} games`);

  const builtGames = [];
  for (const rawGame of toProcess) {
    const game = await buildGame(rawGame);
    if (game) builtGames.push(game);
  }

  slateCache.set(cacheKey, builtGames);
  console.log(`Slate ready: ${builtGames.length} games`);
  return builtGames;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a lean player object — only what the app needs
// ─────────────────────────────────────────────────────────────────────────────
function leanPlayer(p, game, teamAbbr) {
  return {
    playerId:          p.playerId,
    name:              p.name,
    position:          p.position,
    battingOrder:      p.battingOrder || 0,
    isOfficialStarter: p.isOfficialStarter || false,
    isAvailable:       p.isAvailable !== false,
    injuryStatus:      p.injuryStatus || { isInjured: false },
    confidenceRating:  p.confidenceRating || 0,
    seasonStats: {
      homeRuns:   p.seasonStats?.homeRuns   || 0,
      avg:        p.seasonStats?.avg        || '0.000',
      obp:        p.seasonStats?.obp        || '0.000',
      slg:        p.seasonStats?.slg        || '0.000',
      ops:        p.seasonStats?.ops        || '0.000',
      atBats:     p.seasonStats?.atBats     || 0,
    },
    advancedMetrics: {
      barrelRate:     p.advancedMetrics?.barrelRate     || 0,
      hardHitRate:    p.advancedMetrics?.hardHitRate    || 0,
      avgExitVelocity:p.advancedMetrics?.avgExitVelocity|| 0,
      xwOBA:          p.advancedMetrics?.xwOBA          || 0,
      threatRating:   p.advancedMetrics?.threatRating   || 'MODERATE',
      dataSource:     p.advancedMetrics?.dataSource     || 'derived',
      iso:            p.advancedMetrics?.iso            || 0,
    },
    recentForm: {
      trend:    p.recentForm?.trend    || 'stable',
      homeRuns: p.recentForm?.homeRuns || 0,
      last10HR: p.recentForm?.last10HR || 0,
      avg:      p.recentForm?.avg      || '0.000',
    },
    vsOpposingPitcher: {
      advantage:   p.vsOpposingPitcher?.advantage   || 'neutral',
      confidence:  p.vsOpposingPitcher?.confidence  || 50,
      pitcherHand: p.vsOpposingPitcher?.pitcherHand || 'R',
      pitcherERA:  p.vsOpposingPitcher?.pitcherERA  || null,
      pitcherHR9:  p.vsOpposingPitcher?.pitcherHR9  || null,
    },
    hrScoreComponents: p.hrScoreComponents || null,
    // Game context
    gameId:        game.id,
    gameTime:      game.gameTime,
    teamAbbreviation: teamAbbr,
    venueName:     game.venue?.name    || '',
    venueHRFactor: game.venue?.hrFactor || 1.0,
    weather:       game.weather || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/daily  ← THE ONLY ENDPOINT THE APP NEEDS
// Returns everything pre-computed: top threats, smart parlays, daily AI pick.
// App renders this directly — zero processing on the phone.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/daily', async (req, res) => {
  try {
    const date     = req.query.date || new Date().toISOString().split('T')[0];
    const cacheKey = `daily_${date}`;
    const cached   = slateCache.get(cacheKey);
    if (cached) return res.json({ date, fromCache: true, ...cached });

    // Build game picks first
    const games = await getOrBuildSlate(date);
    const gamePicks = buildLeanGamePicks(games, 2);

    // Build all predictions server-side
    const payload = buildDailyPayload(gamePicks);

    // Add lean game schedule for display
    payload.games = gamePicks.map(game => ({
      id:          game.id,
      status:      game.status,
      gameTime:    game.gameTime,
      dayNight:    game.dayNight,
      lineupStatus:game.lineupStatus,
      venue:       game.venue,
      weather:     game.weather,
      awayTeam: {
        id:              game.awayTeam.id,
        name:            game.awayTeam.name,
        abbreviation:    game.awayTeam.abbreviation,
        record:          game.awayTeam.record,
        probablePitcher: game.awayTeam.probablePitcher
          ? { id: game.awayTeam.probablePitcher.id, fullName: game.awayTeam.probablePitcher.fullName, throwsHand: game.awayTeam.probablePitcher.throwsHand, era: game.awayTeam.probablePitcher.era }
          : null,
        hasOfficialLineup: game.awayTeam.hasOfficialLineup,
        lineup: (game.awayTeam.lineup || []).slice(0, 9).map(p => ({
          playerId: p.playerId, name: p.name, position: p.position,
          battingOrder: p.battingOrder, isOfficialStarter: p.isOfficialStarter,
        })),
        topPicks: game.topPicks.filter(p => p.teamAbbreviation === game.awayTeam.abbreviation),
      },
      homeTeam: {
        id:              game.homeTeam.id,
        name:            game.homeTeam.name,
        abbreviation:    game.homeTeam.abbreviation,
        record:          game.homeTeam.record,
        probablePitcher: game.homeTeam.probablePitcher
          ? { id: game.homeTeam.probablePitcher.id, fullName: game.homeTeam.probablePitcher.fullName, throwsHand: game.homeTeam.probablePitcher.throwsHand, era: game.homeTeam.probablePitcher.era }
          : null,
        hasOfficialLineup: game.homeTeam.hasOfficialLineup,
        lineup: (game.homeTeam.lineup || []).slice(0, 9).map(p => ({
          playerId: p.playerId, name: p.name, position: p.position,
          battingOrder: p.battingOrder, isOfficialStarter: p.isOfficialStarter,
        })),
        topPicks: game.topPicks.filter(p => p.teamAbbreviation === game.homeTeam.abbreviation),
      },
    }));

    payload.totalGames = gamePicks.length;
    payload.totalPicks = payload.topThreats.length;

    slateCache.set(cacheKey, payload);
    console.log(`/api/daily ready: ${payload.totalGames} games, ${payload.totalPicks} threats, dailyPick=${!!payload.dailyPick}`);
    res.json({ date, fromCache: false, ...payload });
  } catch (err) {
    console.error('/api/daily error:', err);
    res.status(500).json({ error: 'Failed to build daily payload', detail: err.message });
  }
});

function buildLeanGamePicks(games, topN) {
  return games.map(game => {
    const eligible = [
      ...game.awayTeam.allPlayers.map(p => ({ p, abbr: game.awayTeam.abbreviation })),
      ...game.homeTeam.allPlayers.map(p => ({ p, abbr: game.homeTeam.abbreviation })),
    ].filter(({ p }) => p.isAvailable && !p.injuryStatus?.isInjured);
    eligible.sort((a, b) => b.p.confidenceRating - a.p.confidenceRating);
    const topPicks = eligible.slice(0, topN).map(({ p, abbr }) => leanPlayer(p, game, abbr));
    return { ...game, topPicks };
  });
}


// Returns top 2 HR threats per game — lean objects only.
// Max payload: 15 games × 2 players = 30 lean objects. Never crashes the app.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/game-picks', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const topN = Math.min(parseInt(req.query.topN || '2'), 5); // max 5 per game

    const cacheKey = `game_picks_${date}_${topN}`;
    const cached = slateCache.get(cacheKey);
    if (cached) return res.json({ date, fromCache: true, ...cached });

    const games = await getOrBuildSlate(date);

    const gamePicksResponse = [];
    const allTopPlayers = [];

    games.forEach(game => {
      // Score all available players from both teams
      const eligible = [
        ...game.awayTeam.allPlayers.map(p => ({ p, abbr: game.awayTeam.abbreviation })),
        ...game.homeTeam.allPlayers.map(p => ({ p, abbr: game.homeTeam.abbreviation })),
      ].filter(({ p }) => p.isAvailable && !p.injuryStatus?.isInjured);

      // Sort by HR score descending
      eligible.sort((a, b) => b.p.confidenceRating - a.p.confidenceRating);

      // Take top N per game
      const topForGame = eligible.slice(0, topN).map(({ p, abbr }) => leanPlayer(p, game, abbr));

      // Build lean game object — NO allPlayers arrays
      gamePicksResponse.push({
        id:          game.id,
        status:      game.status,
        gameTime:    game.gameTime,
        dayNight:    game.dayNight,
        lineupStatus:game.lineupStatus,
        venue: {
          id:       game.venue?.id,
          name:     game.venue?.name,
          hrFactor: game.venue?.hrFactor,
          altitude: game.venue?.altitude,
        },
        weather: game.weather,
        awayTeam: {
          id:               game.awayTeam.id,
          name:             game.awayTeam.name,
          abbreviation:     game.awayTeam.abbreviation,
          record:           game.awayTeam.record,
          probablePitcher:  game.awayTeam.probablePitcher
            ? {
                id:          game.awayTeam.probablePitcher.id,
                fullName:    game.awayTeam.probablePitcher.fullName,
                throwsHand:  game.awayTeam.probablePitcher.throwsHand,
                era:         game.awayTeam.probablePitcher.era,
                hr9:         game.awayTeam.probablePitcher.hr9,
              }
            : null,
          hasOfficialLineup: game.awayTeam.hasOfficialLineup,
          lineup: (game.awayTeam.lineup || []).map(p => ({
            playerId: p.playerId, name: p.name,
            position: p.position, battingOrder: p.battingOrder,
            isOfficialStarter: p.isOfficialStarter,
          })),
        },
        homeTeam: {
          id:               game.homeTeam.id,
          name:             game.homeTeam.name,
          abbreviation:     game.homeTeam.abbreviation,
          record:           game.homeTeam.record,
          probablePitcher:  game.homeTeam.probablePitcher
            ? {
                id:          game.homeTeam.probablePitcher.id,
                fullName:    game.homeTeam.probablePitcher.fullName,
                throwsHand:  game.homeTeam.probablePitcher.throwsHand,
                era:         game.homeTeam.probablePitcher.era,
                hr9:         game.homeTeam.probablePitcher.hr9,
              }
            : null,
          hasOfficialLineup: game.homeTeam.hasOfficialLineup,
          lineup: (game.homeTeam.lineup || []).map(p => ({
            playerId: p.playerId, name: p.name,
            position: p.position, battingOrder: p.battingOrder,
            isOfficialStarter: p.isOfficialStarter,
          })),
        },
        topPicks: topForGame,
      });

      allTopPlayers.push(...topForGame);
    });

    // Sort all top players across the full slate by HR score
    allTopPlayers.sort((a, b) => b.confidenceRating - a.confidenceRating);

    const payload = {
      totalGames:   gamePicksResponse.length,
      totalPicks:   allTopPlayers.length,
      games:        gamePicksResponse,
      allTopPlayers,
    };

    slateCache.set(cacheKey, payload);
    console.log(`game-picks: ${gamePicksResponse.length} games, ${allTopPlayers.length} top players`);
    res.json({ date, fromCache: false, ...payload });
  } catch (err) {
    console.error('game-picks error:', err);
    res.status(500).json({ error: 'Failed to build game picks', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), season: mlb.CURRENT_SEASON });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/slate  (kept for debugging — not used by app)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/slate', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const games = await getOrBuildSlate(date);
    res.json({ date, gameCount: games.length, fromCache: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/player/:id
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/player/:id', async (req, res) => {
  try {
    const playerId = parseInt(req.params.id);
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const games = slateCache.get(`slate_${date}`) || [];

    for (const game of games) {
      const found =
        game.awayTeam.allPlayers?.find(p => p.playerId === playerId) ||
        game.homeTeam.allPlayers?.find(p => p.playerId === playerId);
      if (found) {
        const abbr = game.awayTeam.allPlayers?.find(p => p.playerId === playerId)
          ? game.awayTeam.abbreviation : game.homeTeam.abbreviation;
        return res.json({ player: leanPlayer(found, game, abbr), gameId: game.id });
      }
    }
    res.status(404).json({ error: 'Player not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/statcast-check
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/statcast-check', async (_req, res) => {
  try {
    const { getStatcastDiagnostics } = require('./statcastService');
    res.json(await getStatcastDiagnostics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/status
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const date  = new Date().toISOString().split('T')[0];
  const slate = slateCache.get(`slate_${date}`);
  res.json({
    slateReady:  !!slate,
    gamesLoaded: slate?.length || 0,
    date,
    season: mlb.CURRENT_SEASON,
    cacheKeys: slateCache.keys(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MLB Parlay Backend running on port ${PORT}`);
  console.log(`Season: ${mlb.CURRENT_SEASON}`);
  warmStatcastCache();
});

module.exports = app;
