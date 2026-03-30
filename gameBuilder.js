const mlb        = require('./mlbService');
const statcast    = require('./statcastService');
const { calculateHRScore, ratePitcherMatchup, getThreatRating } = require('./hrEngine');

// Build one fully-scored player object
async function buildPlayer(rosterEntry, officialBattingOrder, opposingPitcherStats, venue, weather) {
  const pid  = rosterEntry.person?.id || rosterEntry.playerId;
  const name = rosterEntry.person?.fullName || rosterEntry.name || 'Unknown';
  const pos  = rosterEntry.position?.abbreviation || rosterEntry.position || 'UNK';

  // Fetch player season stats + recent form + injury
  const playerData = await mlb.getPlayerData(pid);
  if (!playerData) return null;

  // Fetch real or derived Statcast
  const statcastData = await statcast.getStatcastForPlayer(pid, playerData.seasonStats);

  // Build pitcher matchup display rating
  const matchup = ratePitcherMatchup(opposingPitcherStats, playerData.seasonStats);

  // Determine batting order
  const battingOrder = officialBattingOrder ?? 0;

  // Run HR Score formula
  const hrResult = calculateHRScore({
    statcast:          statcastData,
    pitcherStats:      opposingPitcherStats,
    parkFactor:        venue.hrFactor,
    weather,
    seasonStats:       playerData.seasonStats,
    recentForm:        playerData.recentForm,
    battingOrder,
    isOfficialStarter: battingOrder > 0,
    isAvailable:       playerData.isAvailable,
    injuryStatus:      playerData.injuryStatus,
  });

  return {
    playerId:    pid,
    name,
    position:    pos,
    battingOrder,
    isOfficialStarter: battingOrder > 0,
    isAvailable:       playerData.isAvailable,
    injuryStatus:      playerData.injuryStatus,
    seasonStats:       playerData.seasonStats,
    recentForm:        playerData.recentForm,
    advancedMetrics: {
      barrelRate:     parseFloat(statcastData.barrelRate  || 0),
      hardHitRate:    parseFloat(statcastData.hardHitRate || 0),
      avgExitVelocity:parseFloat(statcastData.avgExitVelo || 0),
      maxExitVelocity:parseFloat(statcastData.maxExitVelo || 0),
      xSLG:           parseFloat(statcastData.xSLG        || 0),
      xwOBA:          parseFloat(statcastData.xwOBA       || 0),
      flyBallRate:    parseFloat(statcastData.flyBallRate  || 0),
      launchAngle:    parseFloat(statcastData.launchAngle  || 0),
      sweetSpotRate:  parseFloat(statcastData.sweetSpotRate|| 0),
      iso:            parseFloat(
        (parseFloat(playerData.seasonStats.slg || '0.400') -
         parseFloat(playerData.seasonStats.avg || '0.250')).toFixed(3)
      ),
      threatRating:   getThreatRating(hrResult.hrScore),
      dataSource:     statcastData.source,
    },
    vsOpposingPitcher: matchup,
    confidenceRating:  hrResult.hrScore,
    hrScoreComponents: hrResult.components,
    hrScoreInputs:     hrResult.inputs,
  };
}

// Build one fully-processed game
async function buildGame(rawGame) {
  try {
    const venue = mlb.PARK_FACTORS[rawGame.venue?.id] || {
      name: rawGame.venue?.name || 'Unknown Venue',
      hrFactor: 1.0,
      altitude: 500,
    };
    const weather = mlb.resolveWeather(rawGame.venue?.id, rawGame.weather);

    // Fetch pitcher stats for both probable pitchers concurrently
    const [awayPitcher, homePitcher] = await Promise.all([
      mlb.getPitcherStats(rawGame.teams?.away?.probablePitcher?.id),
      mlb.getPitcherStats(rawGame.teams?.home?.probablePitcher?.id),
    ]);

    // Augment pitcher objects with fetched stats
    const awayPitcherFull = rawGame.teams?.away?.probablePitcher
      ? { ...rawGame.teams.away.probablePitcher, ...awayPitcher }
      : null;
    const homePitcherFull = rawGame.teams?.home?.probablePitcher
      ? { ...rawGame.teams.home.probablePitcher, ...homePitcher }
      : null;

    // Fetch rosters and official lineups concurrently
    const [awayRosterRaw, homeRosterRaw, lineups] = await Promise.all([
      mlb.getTeamRoster(rawGame.teams?.away?.team?.id),
      mlb.getTeamRoster(rawGame.teams?.home?.team?.id),
      mlb.getOfficialLineups(rawGame.gamePk),
    ]);

    // Build batting order maps from official lineups
    const awayOrderMap = {};
    const homeOrderMap = {};
    lineups.away.forEach(p => { awayOrderMap[p.playerId] = p.battingOrder; });
    lineups.home.forEach(p => { homeOrderMap[p.playerId] = p.battingOrder; });

    // Build players concurrently — limit concurrency to avoid API rate limiting
    const buildBatch = async (rosterRaw, orderMap, opposingPitcherStats) => {
      const results = [];
      // Process in batches of 5 to be respectful of the MLB API
      for (let i = 0; i < rosterRaw.length; i += 5) {
        const batch = rosterRaw.slice(i, i + 5);
        const built = await Promise.all(
          batch.map(r => buildPlayer(r, orderMap[r.person?.id] || 0, opposingPitcherStats, venue, weather)
            .catch(err => {
              console.error(`Player build error:`, err.message);
              return null;
            })
          )
        );
        results.push(...built.filter(Boolean));
      }
      return results;
    };

    const [awayPlayers, homePlayers] = await Promise.all([
      buildBatch(awayRosterRaw, awayOrderMap, homePitcherFull),
      buildBatch(homeRosterRaw, homeOrderMap, awayPitcherFull),
    ]);

    // Sort each team by HR score descending
    awayPlayers.sort((a, b) => b.confidenceRating - a.confidenceRating);
    homePlayers.sort((a, b) => b.confidenceRating - a.confidenceRating);

    // Build lineup arrays (official starters first, then bench sorted by score)
    const awayLineup = [
      ...awayPlayers.filter(p => p.isOfficialStarter).sort((a, b) => a.battingOrder - b.battingOrder),
      ...awayPlayers.filter(p => !p.isOfficialStarter).slice(0, Math.max(0, 9 - lineups.away.length)),
    ].slice(0, 9);

    const homeLineup = [
      ...homePlayers.filter(p => p.isOfficialStarter).sort((a, b) => a.battingOrder - b.battingOrder),
      ...homePlayers.filter(p => !p.isOfficialStarter).slice(0, Math.max(0, 9 - lineups.home.length)),
    ].slice(0, 9);

    return {
      id:       rawGame.gamePk,
      status:   rawGame.status?.detailedState || 'Scheduled',
      gameTime: rawGame.gameDate,
      dayNight: rawGame.dayNight,
      venue: {
        id:        rawGame.venue?.id,
        name:      venue.name,
        hrFactor:  venue.hrFactor,
        altitude:  venue.altitude,
      },
      weather,
      lineupStatus: (lineups.away.length > 0 && lineups.home.length > 0) ? 'Official' : 'Projected',
      awayTeam: {
        id:               rawGame.teams?.away?.team?.id,
        name:             rawGame.teams?.away?.team?.name,
        abbreviation:     rawGame.teams?.away?.team?.abbreviation,
        record:           `${rawGame.teams?.away?.leagueRecord?.wins || 0}-${rawGame.teams?.away?.leagueRecord?.losses || 0}`,
        probablePitcher:  awayPitcherFull,
        lineup:           awayLineup,
        allPlayers:       awayPlayers,
        hasOfficialLineup: lineups.away.length > 0,
      },
      homeTeam: {
        id:               rawGame.teams?.home?.team?.id,
        name:             rawGame.teams?.home?.team?.name,
        abbreviation:     rawGame.teams?.home?.team?.abbreviation,
        record:           `${rawGame.teams?.home?.leagueRecord?.wins || 0}-${rawGame.teams?.home?.leagueRecord?.losses || 0}`,
        probablePitcher:  homePitcherFull,
        lineup:           homeLineup,
        allPlayers:       homePlayers,
        hasOfficialLineup: lineups.home.length > 0,
      },
    };
  } catch (err) {
    console.error(`buildGame error for gamePk ${rawGame.gamePk}:`, err.message);
    return null;
  }
}

module.exports = { buildGame };
