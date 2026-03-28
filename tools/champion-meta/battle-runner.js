'use strict';

const BattleStreams = require('../../dist/sim/battle-stream.js');
const {RandomPlayerAI} = require('../../dist/sim/tools/random-player-ai.js');

function toID(value) {
	return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

class BattleRunner {
	constructor(options) {
		this.formatId = options.formatId;
		this.prng = options.prng;
		this.concurrency = Math.max(1, Number(options.concurrency) || 1);
		this.reportEvery = Math.max(1, Number(options.reportEvery) || 100);
		this.aiMoveChance = typeof options.aiMoveChance === 'number' ? options.aiMoveChance : 0.9;
		this.aiMegaChance = typeof options.aiMegaChance === 'number' ? options.aiMegaChance : 0.6;
	}

	newSeed() {
		return [
			this.prng.random(2 ** 16),
			this.prng.random(2 ** 16),
			this.prng.random(2 ** 16),
			this.prng.random(2 ** 16),
		].join(',');
	}

	sampleTeams(teamPool) {
		const firstIndex = this.prng.random(teamPool.length);
		let secondIndex = firstIndex;
		if (teamPool.length > 1) secondIndex = (firstIndex + 1 + this.prng.random(teamPool.length - 1)) % teamPool.length;
		return [teamPool[firstIndex], teamPool[secondIndex]];
	}

	teamHasTrickRoomSetter(team) {
		return (team.team || []).some(set => (set.moves || []).some(move => toID(move) === 'trickroom'));
	}

	prepareTeamForBattle(team, opponentTeam) {
		const mutableTeam = {...team, team: [...team.team]};
		const torkoalIndex = mutableTeam.team.findIndex(set => toID(set.species) === 'torkoal');
		if (torkoalIndex < 0) return mutableTeam;

		const allyTrickRoom = mutableTeam.team.some((set, index) => (
			index !== torkoalIndex && (set.moves || []).some(move => toID(move) === 'trickroom')
		));
		const opponentTrickRoom = this.teamHasTrickRoomSetter(opponentTeam);
		const shouldIncludeTorkoal = allyTrickRoom || opponentTrickRoom;

		if (shouldIncludeTorkoal && torkoalIndex >= 4) {
			[mutableTeam.team[torkoalIndex], mutableTeam.team[0]] = [mutableTeam.team[0], mutableTeam.team[torkoalIndex]];
		}
		if (!shouldIncludeTorkoal && torkoalIndex < 4 && mutableTeam.team.length > 4) {
			[mutableTeam.team[torkoalIndex], mutableTeam.team[4]] = [mutableTeam.team[4], mutableTeam.team[torkoalIndex]];
		}

		return mutableTeam;
	}

	registerActivePokemon(line, activeBySide) {
		const parts = line.split('|');
		if (parts.length < 4) return;
		const sideToken = parts[2];
		const side = sideToken.startsWith('p1') ? 'p1' : sideToken.startsWith('p2') ? 'p2' : null;
		if (!side) return;
		const speciesName = (parts[3] || '').split(',', 1)[0].trim();
		if (!speciesName) return;
		activeBySide[side].add(speciesName);
	}

	async runSingleBattle(teamA, teamB) {
		const battleStream = new BattleStreams.BattleStream();
		const streams = BattleStreams.getPlayerStreams(battleStream);
		const p1Name = 'AI 1';
		const p2Name = 'AI 2';
		const activeBySide = {p1: new Set(), p2: new Set()};

		const p1 = new RandomPlayerAI(streams.p1, {
			seed: this.newSeed(),
			move: this.aiMoveChance,
			mega: this.aiMegaChance,
		});
		const p2 = new RandomPlayerAI(streams.p2, {
			seed: this.newSeed(),
			move: this.aiMoveChance,
			mega: this.aiMegaChance,
		});

		void p1.start();
		void p2.start();

		const spec = {formatid: this.formatId, seed: this.newSeed()};
		const initMessage = `>start ${JSON.stringify(spec)}\n` +
			`>player p1 ${JSON.stringify({name: p1Name, team: teamA.team})}\n` +
			`>player p2 ${JSON.stringify({name: p2Name, team: teamB.team})}`;
		void streams.omniscient.write(initMessage);

		let winner = 'tie';
		for await (const chunk of streams.omniscient) {
			if (chunk.includes('|switch|') || chunk.includes('|drag|') || chunk.includes('|replace|')) {
				for (const line of chunk.split('\n')) {
					if (line.startsWith('|switch|') || line.startsWith('|drag|') || line.startsWith('|replace|')) {
						this.registerActivePokemon(line, activeBySide);
					}
				}
			}
			if (chunk.includes('|tie|')) winner = 'tie';
			const winIndex = chunk.lastIndexOf('|win|');
			if (winIndex >= 0) {
				const winnerName = chunk.slice(winIndex + 5).split('\n', 1)[0].trim();
				if (winnerName === p1Name) winner = 'p1';
				if (winnerName === p2Name) winner = 'p2';
			}
		}
		await streams.omniscient.writeEnd();
		return {
			winner,
			activeParticipants: {
				p1: [...activeBySide.p1],
				p2: [...activeBySide.p2],
			},
		};
	}

	async run(options) {
		const teamPool = options.teamPool;
		const battles = Number(options.battles) || 0;
		if (!Array.isArray(teamPool) || teamPool.length < 2) {
			throw new Error('At least two teams are required in the pool.');
		}
		if (battles < 1) {
			return {completed: 0, errors: 0};
		}

		const summary = {
			completed: 0,
			errors: 0,
			winsP1: 0,
			winsP2: 0,
			ties: 0,
		};

		const isEligible = options.isTeamEligible || (() => true);
		let eligibleTeams = teamPool.filter(isEligible);
		if (eligibleTeams.length < 2) {
			throw new Error('Not enough eligible teams to start battles.');
		}

		let nextBattleIndex = 0;
		const workerCount = Math.min(this.concurrency, battles);
		const workers = [];
		for (let workerId = 0; workerId < workerCount; workerId++) {
			workers.push((async () => {
				while (true) {
					const battleIndex = nextBattleIndex;
					nextBattleIndex += 1;
					if (battleIndex >= battles) return;
					if (eligibleTeams.length < 2) return;

					const [teamA, teamB] = this.sampleTeams(eligibleTeams);
					const preparedTeamA = this.prepareTeamForBattle(teamA, teamB);
					const preparedTeamB = this.prepareTeamForBattle(teamB, teamA);
					try {
						const result = await this.runSingleBattle(preparedTeamA, preparedTeamB);
						const winner = result.winner;
						summary.completed += 1;
						if (winner === 'p1') summary.winsP1 += 1;
						if (winner === 'p2') summary.winsP2 += 1;
						if (winner === 'tie') summary.ties += 1;

						if (options.onBattleResult) {
							options.onBattleResult({
								teamA,
								teamB,
								winner,
								activeParticipants: result.activeParticipants,
								battleIndex: battleIndex + 1,
								summary,
							});
						}

						if (!isEligible(teamA) || !isEligible(teamB)) {
							eligibleTeams = eligibleTeams.filter(isEligible);
						}
						if (options.onProgress && summary.completed % this.reportEvery === 0) {
							options.onProgress({battleIndex: battleIndex + 1, summary});
						}
					} catch (error) {
						summary.errors += 1;
						if (options.onError) {
							options.onError({error, battleIndex: battleIndex + 1, teamA, teamB, summary});
						}
					}
				}
			})());
		}
		await Promise.all(workers);
		return summary;
	}
}

module.exports = {BattleRunner};
