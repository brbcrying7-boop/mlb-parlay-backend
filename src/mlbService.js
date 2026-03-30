const axios = require('axios');
const NodeCache = require('node-cache');

// Cache: roster/player data for 30 min, schedule for 10 min, pitcher stats for 60 min
const scheduleCache = new NodeCache({ stdTTL: 600 });
const playerCache   = new NodeCache({ stdTTL: 1800 });
const pitcherCache  = new NodeCache({ stdTTL: 3600 });

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const CURRENT_SEASON = 2026;

const HEADERS = {
  'User-Agent': 'MLBParlayBackend/1.0',
  'Accept': 'application/json'
};

async function mlbGet(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// BALLPARK HR FACTORS  (verified multi-year averages)
// ─────────────────────────────────────────────────────────────────────────────
const PARK_FACTORS = {
  1:    { name: 'loanDepot park',           hrFactor: 0.95, altitude: 9    },
  2:    { name: 'Truist Park',              hrFactor: 1.05, altitude: 1050 },
  3:    { name: 'Comerica Park',            hrFactor: 0.92, altitude: 585  },
  4:    { name: 'Fenway Park',              hrFactor: 1.12, altitude: 21   },
  5:    { name: 'Wrigley Field',            hrFactor: 1.08, altitude: 595  },
  7:    { name: 'Guaranteed Rate Field',    hrFactor: 1.05, altitude: 595  },
  15:   { name: 'Coors Field',              hrFactor: 1.35, altitude: 5200 },
  17:   { name: 'Dodger Stadium',           hrFactor: 1.01, altitude: 515  },
  19:   { name: 'Kauffman Stadium',         hrFactor: 0.92, altitude: 750  },
  22:   { name: 'Tropicana Field',          hrFactor: 0.88, altitude: 50   },
  31:   { name: 'T-Mobile Park',            hrFactor: 0.93, altitude: 175  },
  2392: { name: 'Progressive Field',        hrFactor: 0.94, altitude: 660  },
  2394: { name: 'Minute Maid Park',         hrFactor: 0.98, altitude: 43   },
  2395: { name: 'Great American Ball Park', hrFactor: 1.01, altitude: 550  },
  2396: { name: 'PNC Park',                 hrFactor: 0.89, altitude: 730  },
  2397: { name: 'American Family Field',    hrFactor: 1.03, altitude: 635  },
  2398: { name: 'Busch Stadium',            hrFactor: 0.97, altitude: 465  },
  2680: { name: 'Petco Park',               hrFactor: 0.84, altitude: 62   },
  2681: { name: 'Oracle Park',              hrFactor: 0.79, altitude: 63   },
  2889: { name: 'Progressive Field',        hrFactor: 0.94, altitude: 660  },
  4169: { name: 'Globe Life Field',         hrFactor: 1.00, altitude: 551  },
  4705: { name: 'Chase Field',              hrFactor: 1.04, altitude: 1082 },
  5325: { name: 'Camden Yards',             hrFactor: 1.06, altitude: 55   },
  7  :  { name: 'Guaranteed Rate Field',    hrFactor: 1.05, altitude: 595  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────
async function getTodaysSchedule(date) {
  const key = `schedule_${date}`;
  const hit = scheduleCache.get(key);
  if (hit) return hit;

  const data = await mlbGet(
    `${MLB_BASE}/schedule?sportId=1&date=${date}` +
    `&hydrate=team,linescore,weather,probablePitcher,decisions`
  );

  const games = data.dates?.[0]?.games || [];
  scheduleCache.set(key, games);
  return games;
}

// ─────────────────────────────────────────────────────────────────────────────
// PITCHER SEASON STATS
// ─────────────────────────────────────────────────────────────────────────────
async function getPitcherStats(pitcherId) {
  if (!pitcherId) return null;
  const key = `pitcher_${pitcherId}`;
  const hit = pitcherCache.get(key);
  if (hit) return hit;

  try {
    const data = await mlbGet(
      `${MLB_BASE}/people/${pitcherId}` +
      `?hydrate=stats(type=season,season=${CURRENT_SEASON},group=pitching)`
    );
    const person = data.people?.[0];
    const stats  = person?.stats?.[0]?.splits?.[0]?.stat || {};

    const result = {
      id:        pitcherId,
      fullName:  person?.fullName || 'Unknown',
      throwsHand: person?.pitchHand?.code || 'R',
      era:       parseFloat(stats.era  || '0') || null,
      whip:      parseFloat(stats.whip || '0') || null,
      // HR9 = (homeRunsAllowed / inningsPitched) * 9
      hr9:       stats.homeRuns && stats.inningsPitched
                   ? parseFloat(((stats.homeRuns / parseFloat(stats.inningsPitched)) * 9).toFixed(2))
                   : null,
      strikeoutsPer9: parseFloat(stats.strikeoutsPer9Inn || '0') || null,
      inningsPitched: parseFloat(stats.inningsPitched   || '0') || null,
      homeRunsAllowed: parseInt(stats.homeRuns || '0')  || null,
    };

    pitcherCache.set(key, result);
    return result;
  } catch (err) {
    console.error(`Pitcher stats error for ${pitcherId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER SEASON STATS + GAME LOGS + INJURY CHECK
// ─────────────────────────────────────────────────────────────────────────────
async function getPlayerData(playerId) {
  const key = `player_${playerId}`;
  const hit = playerCache.get(key);
  if (hit) return hit;

  try {
    const [seasonRes, logRes, txRes] = await Promise.all([
      mlbGet(
        `${MLB_BASE}/people/${playerId}` +
        `?hydrate=stats(type=season,season=${CURRENT_SEASON},group=hitting)`
      ),
      mlbGet(
        `${MLB_BASE}/people/${playerId}/stats` +
        `?stats=gameLog&season=${CURRENT_SEASON}&group=hitting`
      ).catch(() => ({ stats: [] })),
      mlbGet(
        `${MLB_BASE}/people/${playerId}?hydrate=transactions`
      ).catch(() => ({ people: [{ transactions: [] }] }))
    ]);

    const person       = seasonRes.people?.[0] || {};
    const seasonStats  = person.stats?.[0]?.splits?.[0]?.stat || {};
    const gameLogs     = logRes.stats?.[0]?.splits?.slice(0, 15) || [];
    const transactions = txRes.people?.[0]?.transactions || [];

    // Injury check — any active IL in last 30 days
    const now = Date.now();
    const activeIL = transactions.find(t => {
      const daysAgo = (now - new Date(t.date).getTime()) / 86400000;
      return daysAgo <= 30 &&
             ['IL10', 'IL15', 'IL60'].includes(t.typeCode);
    });

    // Recent form (last 10 games)
    const recent10    = gameLogs.slice(0, 10);
    const recentAB    = recent10.reduce((s, g) => s + (g.stat?.atBats    || 0), 0);
    const recentH     = recent10.reduce((s, g) => s + (g.stat?.hits      || 0), 0);
    const recentHR    = recent10.reduce((s, g) => s + (g.stat?.homeRuns  || 0), 0);
    const recentRBI   = recent10.reduce((s, g) => s + (g.stat?.rbi       || 0), 0);
    const recentAvg   = recentAB > 0 ? (recentH / recentAB).toFixed(3) : '0.000';

    let trend = 'stable';
    if (recentHR >= 3 || (recentHR >= 2 && recentRBI >= 8)) trend = 'hot';
    else if (recentHR === 0 && recentAB > 15 && parseFloat(recentAvg) < 0.180) trend = 'cold';

    const result = {
      playerId,
      seasonStats: {
        gamesPlayed:  parseInt(seasonStats.gamesPlayed  || 0),
        atBats:       parseInt(seasonStats.atBats       || 0),
        hits:         parseInt(seasonStats.hits         || 0),
        homeRuns:     parseInt(seasonStats.homeRuns     || 0),
        rbi:          parseInt(seasonStats.rbi          || 0),
        avg:          seasonStats.avg  || '0.000',
        obp:          seasonStats.obp  || '0.000',
        slg:          seasonStats.slg  || '0.000',
        ops:          seasonStats.ops  || '0.000',
        strikeOuts:   parseInt(seasonStats.strikeOuts   || 0),
        baseOnBalls:  parseInt(seasonStats.baseOnBalls  || 0),
      },
      recentForm: {
        games:     recent10.length,
        avg:       recentAvg,
        homeRuns:  recentHR,
        rbi:       recentRBI,
        trend,
        last10HR:  recentHR,
      },
      isAvailable:  !activeIL,
      injuryStatus: activeIL
        ? { isInjured: true, type: activeIL.typeCode, description: activeIL.description || 'IL' }
        : { isInjured: false },
    };

    playerCache.set(key, result);
    return result;
  } catch (err) {
    console.error(`Player data error for ${playerId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEAM ROSTER
// ─────────────────────────────────────────────────────────────────────────────
async function getTeamRoster(teamId) {
  const key = `roster_${teamId}`;
  const hit = playerCache.get(key);
  if (hit) return hit;

  const data = await mlbGet(
    `${MLB_BASE}/teams/${teamId}/roster?rosterType=active`
  );

  const positionPlayers = (data.roster || []).filter(
    p => p.position?.abbreviation !== 'P'
  );

  playerCache.set(key, positionPlayers);
  return positionPlayers;
}

// ─────────────────────────────────────────────────────────────────────────────
// OFFICIAL LINEUPS (from boxscore when available)
// ─────────────────────────────────────────────────────────────────────────────
async function getOfficialLineups(gamePk) {
  const key = `lineups_${gamePk}`;
  const hit = scheduleCache.get(key);
  if (hit) return hit;

  try {
    const data = await mlbGet(`${MLB_BASE}/game/${gamePk}/boxscore`);
    const lineups = { away: [], home: [] };

    for (const side of ['away', 'home']) {
      const team = data.teams?.[side];
      if (!team?.battingOrder?.length) continue;

      team.battingOrder.slice(0, 9).forEach((pid, idx) => {
        const p = team.players?.[`ID${pid}`];
        if (p) {
          lineups[side].push({
            playerId:     pid,
            name:         p.person?.fullName || '',
            position:     p.position?.abbreviation || 'UNK',
            battingOrder: idx + 1,
          });
        }
      });
    }

    scheduleCache.set(key, lineups);
    return lineups;
  } catch {
    return { away: [], home: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEATHER helper
// ─────────────────────────────────────────────────────────────────────────────
function resolveWeather(venueId, hydratedWeather) {
  if (hydratedWeather?.temp) {
    return {
      temperature:   parseInt(hydratedWeather.temp, 10) || 72,
      conditions:    hydratedWeather.condition || 'Clear',
      windSpeed:     parseInt(hydratedWeather.wind?.speed || '0', 10),
      windDirection: (hydratedWeather.wind?.dir || 'N').trim().toUpperCase(),
      isRealData:    true,
    };
  }

  // Dome / roof fallbacks
  const domes = new Set([22, 2394, 2397, 4169]);
  if (domes.has(venueId)) {
    return { temperature: 72, conditions: 'Dome', windSpeed: 0, windDirection: 'N', isRealData: false };
  }

  return { temperature: 72, conditions: 'Clear', windSpeed: 8, windDirection: 'N', isRealData: false };
}

module.exports = {
  getTodaysSchedule,
  getPitcherStats,
  getPlayerData,
  getTeamRoster,
  getOfficialLineups,
  resolveWeather,
  PARK_FACTORS,
  CURRENT_SEASON,
};
