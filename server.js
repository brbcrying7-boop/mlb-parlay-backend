const express = require('express');
const cors    = require('cors');
const NodeCache = require('node-cache');
const mlb     = require('./mlbService');
const { buildGame } = require('./gameBuilder');
const { warmStatcastCache } = require('./statcastService');

const app  = express();
const PORT = process.env.PORT || 3001;

// Full slate cache — rebuilt every 10 min
const slateCache = new NodeCache({ stdTTL: 600 });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    season:    mlb.CURRENT_SEASON,
  });
});

// ── GET /api/slate  ───────────────────────────────────────────────────────────
// Returns the full day's slate with every player scored.
// Query param: ?date=YYYY-MM-DD  (defaults to today)
app.get('/api/slate', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const cacheKey = `slate_${date}`;
    const cached = slateCache.get(cacheKey);
    if (cached) {
      return res.json({ date, games: cached, fromCache: true });
    }

    console.log(`Building full slate for ${date}...`);
    const rawGames = await mlb.getTodaysSchedule(date);

    // Bettable statuses — all pre-game variants
    const bettable = new Set([
      'Scheduled', 'Pre-Game', 'Warmup', 'Delayed Start', 'Postponed',
    ]);
    const toProcess = rawGames.filter(g => {
      const s = g.status?.detailedState || '';
      return bettable.has(s) || s.toLowerCase().includes('scheduled');
    });

    console.log(`Processing ${toProcess.length} of ${rawGames.length} games`);

    // Build games sequentially to respect MLB API rate limits
    const builtGames = [];
    for (const rawGame of toProcess) {
      const game = await buildGame(rawGame);
      if (game) builtGames.push(game);
    }

    slateCache.set(cacheKey, builtGames);
    console.log(`Slate ready: ${builtGames.length} games, ${
      builtGames.reduce((s, g) => s + g.awayTeam.allPlayers.length + g.homeTeam.allPlayers.length, 0)
    } players`);

    res.json({ date, games: builtGames, fromCache: false });
  } catch (err) {
    console.error('Slate error:', err);
    res.status(500).json({ error: 'Failed to build slate', detail: err.message });
  }
});

// ── GET /api/players  ─────────────────────────────────────────────────────────
// Returns all scored players from today's slate in a flat list, sorted by HR score.
app.get('/api/players', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const cacheKey = `slate_${date}`;
    const cached = slateCache.get(cacheKey);

    let games = cached;
    if (!games) {
      // Trigger full slate build
      const slateRes = await fetch(`http://localhost:${PORT}/api/slate?date=${date}`).then(r => r.json()).catch(() => null);
      games = slateRes?.games || [];
    }

    const players = [];
    games.forEach(game => {
      [...game.awayTeam.allPlayers, ...game.homeTeam.allPlayers].forEach(p => {
        players.push({
          ...p,
          gameId:           game.id,
          gameTime:         game.gameTime,
          venueName:        game.venue.name,
          venueHRFactor:    game.venue.hrFactor,
          weather:          game.weather,
          teamAbbreviation: game.awayTeam.allPlayers.find(ap => ap.playerId === p.playerId)
            ? game.awayTeam.abbreviation
            : game.homeTeam.abbreviation,
        });
      });
    });

    players.sort((a, b) => b.confidenceRating - a.confidenceRating);
    res.json({ date, count: players.length, players });
  } catch (err) {
    console.error('Players error:', err);
    res.status(500).json({ error: 'Failed to fetch players', detail: err.message });
  }
});

// ── GET /api/player/:id  ──────────────────────────────────────────────────────
// Deep profile for a single player including HR score breakdown.
app.get('/api/player/:id', async (req, res) => {
  try {
    const playerId = parseInt(req.params.id);
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const cacheKey = `slate_${date}`;
    const games = slateCache.get(cacheKey) || [];

    for (const game of games) {
      const found =
        game.awayTeam.allPlayers.find(p => p.playerId === playerId) ||
        game.homeTeam.allPlayers.find(p => p.playerId === playerId);

      if (found) {
        return res.json({
          player:  found,
          game: {
            id:         game.id,
            gameTime:   game.gameTime,
            venue:      game.venue,
            weather:    game.weather,
            awayTeam:   { id: game.awayTeam.id, name: game.awayTeam.name, abbreviation: game.awayTeam.abbreviation },
            homeTeam:   { id: game.homeTeam.id, name: game.homeTeam.name, abbreviation: game.homeTeam.abbreviation },
            lineupStatus: game.lineupStatus,
          },
        });
      }
    }

    res.status(404).json({ error: 'Player not found in today\'s slate' });
  } catch (err) {
    console.error('Player detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pitcher/:id  ─────────────────────────────────────────────────────
// Pitcher stats endpoint for direct lookups.
app.get('/api/pitcher/:id', async (req, res) => {
  try {
    const stats = await mlb.getPitcherStats(parseInt(req.params.id));
    if (!stats) return res.status(404).json({ error: 'Pitcher not found' });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/top-picks  ───────────────────────────────────────────────────────
// Returns today's top HR threats, optionally filtered by minimum score.
app.get('/api/top-picks', async (req, res) => {
  try {
    const date     = req.query.date  || new Date().toISOString().split('T')[0];
    const minScore = parseInt(req.query.minScore || '50');
    const limit    = parseInt(req.query.limit    || '20');
    const cacheKey = `slate_${date}`;
    const games    = slateCache.get(cacheKey) || [];

    const picks = [];
    games.forEach(game => {
      [...game.awayTeam.allPlayers, ...game.homeTeam.allPlayers]
        .filter(p => p.isAvailable && !p.injuryStatus?.isInjured && p.confidenceRating >= minScore)
        .forEach(p => {
          picks.push({
            playerId:        p.playerId,
            name:            p.name,
            position:        p.position,
            hrScore:         p.confidenceRating,
            threatRating:    p.advancedMetrics?.threatRating,
            dataSource:      p.advancedMetrics?.dataSource,
            battingOrder:    p.battingOrder,
            isOfficialStarter: p.isOfficialStarter,
            barrelRate:      p.advancedMetrics?.barrelRate,
            hardHitRate:     p.advancedMetrics?.hardHitRate,
            avgExitVelocity: p.advancedMetrics?.avgExitVelocity,
            teamAbbr:        game.awayTeam.allPlayers.find(ap => ap.playerId === p.playerId)
              ? game.awayTeam.abbreviation
              : game.homeTeam.abbreviation,
            venueName:       game.venue.name,
            hrFactor:        game.venue.hrFactor,
            gameTime:        game.gameTime,
            recentFormTrend: p.recentForm?.trend,
            last10HR:        p.recentForm?.last10HR,
            seasonHR:        p.seasonStats?.homeRuns,
          });
        });
    });

    picks.sort((a, b) => b.hrScore - a.hrScore);
    res.json({ date, count: picks.length, picks: picks.slice(0, limit) });
  } catch (err) {
    console.error('Top picks error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/status  ──────────────────────────────────────────────────────────
// Shows cache state and slate readiness.
app.get('/api/status', (req, res) => {
  const date     = new Date().toISOString().split('T')[0];
  const slate    = slateCache.get(`slate_${date}`);
  const gameCount    = slate?.length || 0;
  const playerCount  = slate?.reduce(
    (s, g) => s + g.awayTeam.allPlayers.length + g.homeTeam.allPlayers.length, 0
  ) || 0;

  res.json({
    slateReady:    gameCount > 0,
    gamesLoaded:   gameCount,
    playersScored: playerCount,
    date,
    season:        mlb.CURRENT_SEASON,
    cacheKeys:     slateCache.keys(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MLB Parlay Backend running on port ${PORT}`);
  console.log(`Season: ${mlb.CURRENT_SEASON}`);
  // Warm Statcast cache in background so first request is fast
  warmStatcastCache();
});

module.exports = app;
