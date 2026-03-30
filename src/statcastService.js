const axios = require('axios');
const NodeCache = require('node-cache');

// Statcast data is stable across the day — cache for 2 hours
const statcastCache = new NodeCache({ stdTTL: 7200 });

const SAVANT_BASE = 'https://baseballsavant.mlb.com';
const CURRENT_SEASON = 2026;

// ─────────────────────────────────────────────────────────────────────────────
// Fetch the full Statcast leaderboard once per session and index by MLBAM ID.
// Baseball Savant returns a CSV or JSON payload depending on the endpoint.
// We use the statcast_search CSV export which is publicly accessible
// server-side (no CORS restriction when called from Node).
// ─────────────────────────────────────────────────────────────────────────────

let leaderboardByPlayerId = null;  // in-memory index built on first call

async function loadStatcastLeaderboard() {
  if (leaderboardByPlayerId) return leaderboardByPlayerId;

  const cacheKey = `savant_leaderboard_${CURRENT_SEASON}`;
  const cached = statcastCache.get(cacheKey);
  if (cached) {
    leaderboardByPlayerId = cached;
    return leaderboardByPlayerId;
  }

  try {
    console.log('Fetching Baseball Savant leaderboard...');

    // Savant expected Statcast leaderboard endpoint (season-level batter metrics)
    const res = await axios.get(
      `${SAVANT_BASE}/leaderboard/statcast` +
      `?type=batter&year=${CURRENT_SEASON}&position=&team=&min=10` +
      `&sort_col=barrels&sort_order=desc&csv=true`,
      {
        headers: {
          'User-Agent': 'MLBParlayBackend/1.0',
          'Accept': 'text/csv,application/json,*/*',
        },
        timeout: 20000,
        responseType: 'text',
      }
    );

    const index = parseStatcastCSV(res.data);
    leaderboardByPlayerId = index;
    statcastCache.set(cacheKey, index);
    console.log(`Loaded Statcast data for ${Object.keys(index).length} players`);
    return index;
  } catch (err) {
    console.error('Savant leaderboard fetch failed:', err.message);
    // Return empty index — callers will fall back to derived metrics
    leaderboardByPlayerId = {};
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse the CSV Savant returns
// ─────────────────────────────────────────────────────────────────────────────
function parseStatcastCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return {};

  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const index   = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    const row  = {};
    headers.forEach((h, j) => { row[h] = cols[j] || ''; });

    // Savant uses 'player_id' (MLBAM ID) as the key
    const pid = row.player_id || row.batter;
    if (!pid) continue;

    index[pid] = {
      playerId:     pid,
      name:         row.last_name ? `${row.last_name}, ${row.first_name}` : row.player_name || '',
      pa:           parseInt(row.pa || row.attempts || '0'),
      barrelRate:   parseFloat(row.barrel_batted_rate || row.brl_percent || '0'),
      hardHitRate:  parseFloat(row.hard_hit_percent   || '0'),
      avgExitVelo:  parseFloat(row.avg_hit_speed       || row.launch_speed || '0'),
      maxExitVelo:  parseFloat(row.max_hit_speed       || '0'),
      xSLG:         parseFloat(row.xslg                || '0'),
      xwOBA:        parseFloat(row.xwoba               || '0'),
      flyBallRate:  parseFloat(row.flb_percent         || row.fb_percent  || '0'),
      launchAngle:  parseFloat(row.avg_launch_angle    || '0'),
      sweetSpotRate:parseFloat(row.sweet_spot_percent  || '0'),
    };
  }

  return index;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: get Statcast data for one player.
// Returns real data when available, derived fallback otherwise.
// ─────────────────────────────────────────────────────────────────────────────
async function getStatcastForPlayer(playerId, seasonStats) {
  const key = `statcast_player_${playerId}`;
  const cached = statcastCache.get(key);
  if (cached) return cached;

  // Try to get from leaderboard first
  const leaderboard = await loadStatcastLeaderboard();
  const real = leaderboard[String(playerId)];

  if (real && real.pa >= 10 && real.avgExitVelo > 0) {
    // Real Statcast data — tag it so the app knows
    const result = { ...real, source: 'statcast' };
    statcastCache.set(key, result);
    return result;
  }

  // Fallback: derive from season stats (deterministic, no randomness)
  const derived = deriveStatcastFromSeasonStats(seasonStats);
  statcastCache.set(key, derived);
  return derived;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic derivation when Savant data is unavailable or insufficient
// ─────────────────────────────────────────────────────────────────────────────
function deriveStatcastFromSeasonStats(s) {
  if (!s) {
    return {
      barrelRate: 8.0, hardHitRate: 35.0, avgExitVelo: 88.5,
      maxExitVelo: 96.0, xSLG: 0.420, xwOBA: 0.320,
      flyBallRate: 32.0, launchAngle: 14.0, sweetSpotRate: 14.0,
      source: 'derived',
    };
  }

  const ab   = s.atBats  || 50;
  const hr   = s.homeRuns || 0;
  const avg  = parseFloat(s.avg  || '0.250');
  const slg  = parseFloat(s.slg  || '0.400');
  const obp  = parseFloat(s.obp  || '0.320');
  const ops  = parseFloat(s.ops  || '0.700');

  const hrRate = hr / Math.max(ab, 1);
  const iso    = Math.max(slg - avg, 0);

  const barrelRate   = Math.min(hrRate * 140 + Math.max(iso - 0.150, 0) * 35, 22);
  const avgExitVelo  = Math.min(86.5 + (slg - 0.350) * 18 + (ops - 0.650) * 8, 97);
  const hardHitRate  = Math.min(barrelRate * 2.4 + Math.max(iso - 0.100, 0) * 55, 62);
  const xSLG         = Math.min(slg + iso * 0.08, 0.900);
  const xwOBA        = Math.min(0.220 + obp * 0.55 + iso * 0.65, 0.480);
  const flyBallRate  = Math.min(28 + hrRate * 90 + Math.max(iso - 0.150, 0) * 40, 52);
  const launchAngle  = 12 + hrRate * 40 + Math.max(iso - 0.120, 0) * 20;
  const sweetSpot    = barrelRate * 1.75;

  return {
    barrelRate:    parseFloat(Math.max(barrelRate, 0).toFixed(1)),
    hardHitRate:   parseFloat(Math.max(hardHitRate, 18).toFixed(1)),
    avgExitVelo:   parseFloat(avgExitVelo.toFixed(1)),
    maxExitVelo:   parseFloat(Math.min(avgExitVelo + iso * 8, 105).toFixed(1)),
    xSLG:          parseFloat(xSLG.toFixed(3)),
    xwOBA:         parseFloat(xwOBA.toFixed(3)),
    flyBallRate:   parseFloat(flyBallRate.toFixed(1)),
    launchAngle:   parseFloat(launchAngle.toFixed(1)),
    sweetSpotRate: parseFloat(sweetSpot.toFixed(1)),
    source:        'derived',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Warm the leaderboard cache at server startup (non-blocking)
// ─────────────────────────────────────────────────────────────────────────────
function warmStatcastCache() {
  loadStatcastLeaderboard().catch(err =>
    console.error('Statcast warm failed:', err.message)
  );
}

module.exports = {
  getStatcastForPlayer,
  deriveStatcastFromSeasonStats,
  warmStatcastCache,
};
