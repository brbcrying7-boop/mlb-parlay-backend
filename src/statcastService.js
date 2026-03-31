const axios = require('axios');
const NodeCache = require('node-cache');

const statcastCache = new NodeCache({ stdTTL: 7200 });
const SAVANT_BASE   = 'https://baseballsavant.mlb.com';
const CURRENT_SEASON = 2026;

let evBarrelIndex      = null;
let expectedStatsIndex = null;

async function loadEVBarrelLeaderboard() {
  if (evBarrelIndex) return evBarrelIndex;
  const cacheKey = `savant_ev_barrels_${CURRENT_SEASON}`;
  const cached = statcastCache.get(cacheKey);
  if (cached) { evBarrelIndex = cached; return evBarrelIndex; }

  try {
    console.log('[Savant] Fetching EV/Barrel leaderboard...');
    const res = await axios.get(
      `${SAVANT_BASE}/leaderboard/statcast?type=batter&year=${CURRENT_SEASON}&position=&team=&min=10&sort_col=barrels&sort_order=desc&csv=true`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MLBParlayBackend/2.0)',
          'Accept': 'text/csv,*/*',
          'Referer': 'https://baseballsavant.mlb.com/leaderboard/statcast',
        },
        timeout: 25000,
        responseType: 'text',
      }
    );

    const text = res.data || '';
    if (text.trim().startsWith('<') || text.length < 100) {
      console.error('[Savant] EV/Barrel response is not CSV. Length:', text.length);
      evBarrelIndex = {};
      return evBarrelIndex;
    }

    const index = parseCSV(text, row => {
      const pid = row.player_id || row.batter_id;
      if (!pid) return null;
      return {
        pid,
        pa:           parseInt(row.pa || '0'),
        bbe:          parseInt(row.attempts || row.bbe || '0'),
        avgExitVelo:  parseFloat(row.avg_hit_speed    || '0'),
        maxExitVelo:  parseFloat(row.max_hit_speed    || '0'),
        barrelRate:   parseFloat(row.brl_percent      || row.barrel_batted_rate || row.barrels || '0'),
        hardHitRate:  parseFloat(row.hard_hit_percent || row['hard hit%'] || row.hard_hit_rate || row.hh_percent || '0'),
        sweetSpotRate:parseFloat(row.anglesweetspotpercent || row.sweet_spot_percent || row.la_sweet_spot_percent || '0'),
        launchAngle:  parseFloat(row.avg_launch_angle || row.launch_angle_avg || '0'),
        flyBallRate:  parseFloat(row.flb_percent      || row.fb_percent || row.fly_ball_percent || '0'),
      };
    });

    console.log(`[Savant] EV/Barrel loaded: ${Object.keys(index).length} players`);
    evBarrelIndex = index;
    statcastCache.set(cacheKey, index);
    return evBarrelIndex;
  } catch (err) {
    console.error('[Savant] EV/Barrel fetch failed:', err.message);
    evBarrelIndex = {};
    return evBarrelIndex;
  }
}

async function loadExpectedStatsLeaderboard() {
  if (expectedStatsIndex) return expectedStatsIndex;
  const cacheKey = `savant_xstats_${CURRENT_SEASON}`;
  const cached = statcastCache.get(cacheKey);
  if (cached) { expectedStatsIndex = cached; return expectedStatsIndex; }

  try {
    console.log('[Savant] Fetching Expected Stats leaderboard...');
    const res = await axios.get(
      `${SAVANT_BASE}/leaderboard/expected_statistics?type=batter&year=${CURRENT_SEASON}&position=&team=&min=10&csv=true`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MLBParlayBackend/2.0)',
          'Accept': 'text/csv,*/*',
          'Referer': 'https://baseballsavant.mlb.com/leaderboard/expected_statistics',
        },
        timeout: 25000,
        responseType: 'text',
      }
    );

    const text = res.data || '';
    if (text.trim().startsWith('<') || text.length < 100) {
      console.error('[Savant] Expected stats response is not CSV. Length:', text.length);
      expectedStatsIndex = {};
      return expectedStatsIndex;
    }

    const index = parseCSV(text, row => {
      const pid = row.player_id || row.batter_id;
      if (!pid) return null;
      return {
        pid,
        pa:    parseInt(row.pa   || '0'),
        xBA:   parseFloat(row.est_ba   || row.xba   || '0'),
        xSLG:  parseFloat(row.est_slg  || row.xslg  || '0'),
        xwOBA: parseFloat(row.est_woba || row.xwoba || '0'),
      };
    });

    console.log(`[Savant] Expected Stats loaded: ${Object.keys(index).length} players`);
    expectedStatsIndex = index;
    statcastCache.set(cacheKey, index);
    return expectedStatsIndex;
  } catch (err) {
    console.error('[Savant] Expected Stats fetch failed:', err.message);
    expectedStatsIndex = {};
    return expectedStatsIndex;
  }
}

function splitCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(text, transformRow) {
  const lines   = text.trim().split('\n');
  if (lines.length < 2) return {};
  const headers = splitCSVLine(lines[0]);
  const index   = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = splitCSVLine(line);
    const row  = {};
    headers.forEach((h, j) => { row[h] = cols[j] || ''; });
    const result = transformRow(row);
    if (result && result.pid) index[String(result.pid)] = result;
  }
  return index;
}

async function getStatcastForPlayer(playerId, seasonStats) {
  const key    = `statcast_player_${playerId}`;
  const cached = statcastCache.get(key);
  if (cached) return cached;

  const [evIndex, xIndex] = await Promise.all([
    loadEVBarrelLeaderboard(),
    loadExpectedStatsLeaderboard(),
  ]);

  const pid    = String(playerId);
  const evData = evIndex[pid];
  const xData  = xIndex[pid];

  if (evData && evData.avgExitVelo > 0 && evData.bbe >= 5) {
    const result = {
      source:       'statcast',
      pa:           evData.pa,
      barrelRate:   evData.barrelRate,
      hardHitRate:  evData.hardHitRate,
      avgExitVelo:  evData.avgExitVelo,
      maxExitVelo:  evData.maxExitVelo,
      sweetSpotRate:evData.sweetSpotRate,
      launchAngle:  evData.launchAngle,
      flyBallRate:  evData.flyBallRate,
      xSLG:  xData?.xSLG  || parseFloat((parseFloat(seasonStats?.slg || '0.400') * 1.02).toFixed(3)),
      xwOBA: xData?.xwOBA || parseFloat((0.220 + parseFloat(seasonStats?.obp || '0.320') * 0.55).toFixed(3)),
      xBA:   xData?.xBA   || parseFloat(seasonStats?.avg || '0.250'),
    };
    statcastCache.set(key, result);
    return result;
  }

  const derived = deriveStatcastFromSeasonStats(seasonStats);
  statcastCache.set(key, derived);
  return derived;
}

function deriveStatcastFromSeasonStats(s) {
  if (!s) {
    return {
      barrelRate: 8.0, hardHitRate: 35.0, avgExitVelo: 88.5,
      maxExitVelo: 96.0, xSLG: 0.420, xwOBA: 0.320, xBA: 0.250,
      flyBallRate: 32.0, launchAngle: 14.0, sweetSpotRate: 14.0,
      source: 'derived',
    };
  }
  const ab  = s.atBats   || 50;
  const hr  = s.homeRuns || 0;
  const avg = parseFloat(s.avg || '0.250');
  const slg = parseFloat(s.slg || '0.400');
  const obp = parseFloat(s.obp || '0.320');
  const ops = parseFloat(s.ops || '0.700');
  const hrRate     = hr / Math.max(ab, 1);
  const iso        = Math.max(slg - avg, 0);
  const barrelRate = Math.min(hrRate * 140 + Math.max(iso - 0.150, 0) * 35, 22);
  const avgExitVelo= Math.min(86.5 + (slg - 0.350) * 18 + (ops - 0.650) * 8, 97);
  const hardHitRate= Math.min(barrelRate * 2.4 + Math.max(iso - 0.100, 0) * 55, 62);
  return {
    barrelRate:    parseFloat(Math.max(barrelRate, 0).toFixed(1)),
    hardHitRate:   parseFloat(Math.max(hardHitRate, 18).toFixed(1)),
    avgExitVelo:   parseFloat(avgExitVelo.toFixed(1)),
    maxExitVelo:   parseFloat(Math.min(avgExitVelo + iso * 8, 105).toFixed(1)),
    xSLG:          parseFloat(Math.min(slg + iso * 0.08, 0.900).toFixed(3)),
    xwOBA:         parseFloat(Math.min(0.220 + obp * 0.55 + iso * 0.65, 0.480).toFixed(3)),
    xBA:           parseFloat(avg.toFixed(3)),
    flyBallRate:   parseFloat(Math.min(28 + hrRate * 90 + Math.max(iso - 0.150, 0) * 40, 52).toFixed(1)),
    launchAngle:   parseFloat((12 + hrRate * 40 + Math.max(iso - 0.120, 0) * 20).toFixed(1)),
    sweetSpotRate: parseFloat((Math.max(barrelRate, 0) * 1.75).toFixed(1)),
    source:        'derived',
  };
}

async function getStatcastDiagnostics() {
  const [evIndex, xIndex] = await Promise.all([
    loadEVBarrelLeaderboard(),
    loadExpectedStatsLeaderboard(),
  ]);

  // Also fetch raw headers for debugging
  let evHeaders = [];
  try {
    const res = await axios.get(
      `${SAVANT_BASE}/leaderboard/statcast?type=batter&year=${CURRENT_SEASON}&position=&team=&min=10&sort_col=barrels&sort_order=desc&csv=true`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv,*/*' }, timeout: 15000, responseType: 'text' }
    );
    const firstLine = (res.data || '').split('\n')[0];
    evHeaders = splitCSVLine(firstLine);
  } catch (e) { evHeaders = ['fetch failed: ' + e.message]; }

  return {
    season:               CURRENT_SEASON,
    evBarrelPlayers:      Object.keys(evIndex).length,
    expectedStatsPlayers: Object.keys(xIndex).length,
    dataFlowing:          Object.keys(evIndex).length > 0,
    evCSVHeaders:         evHeaders,
    evSample:             Object.values(evIndex).slice(0, 3),
    xSample:              Object.values(xIndex).slice(0, 3),
  };
}

function warmStatcastCache() {
  Promise.all([
    loadEVBarrelLeaderboard(),
    loadExpectedStatsLeaderboard(),
  ]).catch(err => console.error('[Savant] Warm failed:', err.message));
}

module.exports = {
  getStatcastForPlayer,
  deriveStatcastFromSeasonStats,
  warmStatcastCache,
  getStatcastDiagnostics,
};
