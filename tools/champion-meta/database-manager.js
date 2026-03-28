'use strict';

const fs = require('fs');
const path = require('path');

function toID(value) {
	return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function readJSON(filePath, fallbackValue) {
	if (!fs.existsSync(filePath)) return fallbackValue;
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch {
		return fallbackValue;
	}
}

function writeJSONAtomic(filePath, payload, pretty = true) {
	const directory = path.dirname(filePath);
	fs.mkdirSync(directory, {recursive: true});
	const tempPath = `${filePath}.tmp`;
	const spacing = pretty ? 2 : 0;
	fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, spacing)}\n`);
	fs.renameSync(tempPath, filePath);
}

class DatabaseManager {
	constructor(options) {
		this.formatId = options.formatId;
		this.databaseDir = options.databaseDir;
		this.teamPoolPath = options.teamPoolPath;
		this.statsPath = options.statsPath;
		this.flushEvery = Math.max(1, Number(options.flushEvery) || 25);
		this.pendingUpdates = 0;

		fs.mkdirSync(this.databaseDir, {recursive: true});
		this.teamPool = this.loadTeamPool();
		this.stats = this.loadStats();
	}

	loadTeamPool() {
		const teamPool = readJSON(this.teamPoolPath, []);
		return Array.isArray(teamPool) ? teamPool : [];
	}

	saveTeamPool(teamPool) {
		this.teamPool = teamPool;
		writeJSONAtomic(this.teamPoolPath, this.teamPool, true);
	}

	loadStats() {
		const now = new Date().toISOString();
		const initial = {
			version: 1,
			formatId: this.formatId,
			createdAt: now,
			updatedAt: now,
			totals: {
				battles: 0,
				teamSlots: 0,
				winsP1: 0,
				winsP2: 0,
				ties: 0,
				errors: 0,
			},
			teams: {},
			pokemon: {},
		};
		const loaded = readJSON(this.statsPath, initial);
		if (!loaded || typeof loaded !== 'object') return initial;
		loaded.teams ||= {};
		loaded.pokemon ||= {};
		loaded.totals ||= initial.totals;
		loaded.updatedAt ||= now;
		loaded.createdAt ||= now;
		loaded.formatId ||= this.formatId;
		return loaded;
	}

	ensureTeamRecord(team) {
		if (!this.stats.teams[team.id]) {
			this.stats.teams[team.id] = {
				id: team.id,
				members: team.members,
				uses: 0,
				wins: 0,
				losses: 0,
				ties: 0,
				score: 0,
				winRate: 0,
				lastUsedAt: null,
			};
		}
		return this.stats.teams[team.id];
	}

	ensurePokemonRecord(speciesName) {
		const id = toID(speciesName);
		if (!this.stats.pokemon[id]) {
			this.stats.pokemon[id] = {
				id,
				name: speciesName,
				uses: 0,
				wins: 0,
				losses: 0,
				ties: 0,
				usageRate: 0,
				winRate: 0,
				lastSeenAt: null,
			};
		}
		return this.stats.pokemon[id];
	}

	recordError() {
		this.stats.totals.errors += 1;
		this.pendingUpdates += 1;
		this.flushIfNeeded();
	}

	recordBattle(teamA, teamB, winner) {
		const now = new Date().toISOString();
		this.stats.totals.battles += 1;
		this.stats.totals.teamSlots += teamA.members.length + teamB.members.length;

		const recordA = this.ensureTeamRecord(teamA);
		const recordB = this.ensureTeamRecord(teamB);
		recordA.uses += 1;
		recordB.uses += 1;
		recordA.lastUsedAt = now;
		recordB.lastUsedAt = now;

		let sideAResult = 'loss';
		let sideBResult = 'loss';
		if (winner === 'p1') {
			recordA.wins += 1;
			recordA.score += 1;
			recordB.losses += 1;
			this.stats.totals.winsP1 += 1;
			sideAResult = 'win';
		} else if (winner === 'p2') {
			recordB.wins += 1;
			recordB.score += 1;
			recordA.losses += 1;
			this.stats.totals.winsP2 += 1;
			sideBResult = 'win';
		} else {
			recordA.ties += 1;
			recordB.ties += 1;
			this.stats.totals.ties += 1;
			sideAResult = 'tie';
			sideBResult = 'tie';
		}

		for (const member of teamA.members) {
			const pokemon = this.ensurePokemonRecord(member);
			pokemon.uses += 1;
			pokemon.lastSeenAt = now;
			if (sideAResult === 'win') pokemon.wins += 1;
			if (sideAResult === 'loss') pokemon.losses += 1;
			if (sideAResult === 'tie') pokemon.ties += 1;
		}
		for (const member of teamB.members) {
			const pokemon = this.ensurePokemonRecord(member);
			pokemon.uses += 1;
			pokemon.lastSeenAt = now;
			if (sideBResult === 'win') pokemon.wins += 1;
			if (sideBResult === 'loss') pokemon.losses += 1;
			if (sideBResult === 'tie') pokemon.ties += 1;
		}

		this.pendingUpdates += 1;
		this.flushIfNeeded();
	}

	computeDerivedMetrics() {
		const totalSlots = this.stats.totals.teamSlots || 1;
		for (const teamRecord of Object.values(this.stats.teams)) {
			teamRecord.winRate = teamRecord.uses ? teamRecord.wins / teamRecord.uses : 0;
		}
		for (const pokemonRecord of Object.values(this.stats.pokemon)) {
			pokemonRecord.usageRate = pokemonRecord.uses / totalSlots;
			pokemonRecord.winRate = pokemonRecord.uses ? pokemonRecord.wins / pokemonRecord.uses : 0;
		}
	}

	flushIfNeeded(force = false) {
		if (!force && this.pendingUpdates < this.flushEvery) return;
		this.stats.updatedAt = new Date().toISOString();
		if (force) this.computeDerivedMetrics();
		writeJSONAtomic(this.statsPath, this.stats, force);
		this.pendingUpdates = 0;
	}
}

module.exports = {DatabaseManager, toID};
