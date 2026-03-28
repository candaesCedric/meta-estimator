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
				activeSlots: 0,
				winsP1: 0,
				winsP2: 0,
				ties: 0,
				errors: 0,
			},
			teams: {},
			pokemon: {},
			items: {},
		};
		const loaded = readJSON(this.statsPath, initial);
		if (!loaded || typeof loaded !== 'object') return initial;
		loaded.teams ||= {};
		loaded.pokemon ||= {};
		loaded.items ||= {};
		loaded.totals ||= initial.totals;
		loaded.totals.activeSlots ??= 0;
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
				pokemonScores: Object.fromEntries((team.members || []).map(member => [member, {
					score: 0,
					sent: 0,
					wins: 0,
					losses: 0,
					ties: 0,
				}])),
			};
		}
		this.stats.teams[team.id].pokemonScores ||= {};
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
				score: 0,
				usageRate: 0,
				winRate: 0,
				lastSeenAt: null,
			};
		}
		return this.stats.pokemon[id];
	}

	ensureItemRecord(itemName) {
		const id = toID(itemName);
		if (!this.stats.items[id]) {
			this.stats.items[id] = {
				id,
				name: itemName,
				uses: 0,
				wins: 0,
				losses: 0,
				ties: 0,
				winRate: 0,
				lastSeenAt: null,
			};
		}
		return this.stats.items[id];
	}

	findTeamMemberBySpeciesId(team, speciesId) {
		for (const set of team.team || []) {
			const setId = toID(set.species);
			if (setId === speciesId || setId.startsWith(speciesId) || speciesId.startsWith(setId)) {
				return set;
			}
		}
		return null;
	}

	applyActiveStats(team, teamRecord, activeSpeciesIds, sideResult, now) {
		for (const speciesId of activeSpeciesIds) {
			const teamMember = this.findTeamMemberBySpeciesId(team, speciesId);
			if (!teamMember) continue;
			const speciesName = teamMember.species;
			const pokemon = this.ensurePokemonRecord(speciesName);
			pokemon.uses += 1;
			pokemon.score += 1;
			pokemon.lastSeenAt = now;
			if (sideResult === 'win') pokemon.wins += 1;
			if (sideResult === 'loss') pokemon.losses += 1;
			if (sideResult === 'tie') pokemon.ties += 1;

			const item = this.ensureItemRecord(teamMember.item || 'No Item');
			item.uses += 1;
			item.lastSeenAt = now;
			if (sideResult === 'win') item.wins += 1;
			if (sideResult === 'loss') item.losses += 1;
			if (sideResult === 'tie') item.ties += 1;

			teamRecord.pokemonScores ||= {};
			teamRecord.pokemonScores[speciesName] ||= {score: 0, sent: 0, wins: 0, losses: 0, ties: 0};
			teamRecord.pokemonScores[speciesName].score += 1;
			teamRecord.pokemonScores[speciesName].sent += 1;
			if (sideResult === 'win') teamRecord.pokemonScores[speciesName].wins += 1;
			if (sideResult === 'loss') teamRecord.pokemonScores[speciesName].losses += 1;
			if (sideResult === 'tie') teamRecord.pokemonScores[speciesName].ties += 1;
		}
	}

	recordError() {
		this.stats.totals.errors += 1;
		this.pendingUpdates += 1;
		this.flushIfNeeded();
	}

	recordBattle(teamA, teamB, winner, activeParticipants = {}) {
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

		const activeP1 = new Set((activeParticipants.p1 || []).map(toID));
		const activeP2 = new Set((activeParticipants.p2 || []).map(toID));
		this.stats.totals.activeSlots += activeP1.size + activeP2.size;
		this.applyActiveStats(teamA, recordA, activeP1, sideAResult, now);
		this.applyActiveStats(teamB, recordB, activeP2, sideBResult, now);

		this.pendingUpdates += 1;
		this.flushIfNeeded();
	}

	computeDerivedMetrics() {
		const totalSlots = this.stats.totals.activeSlots || 1;
		for (const teamRecord of Object.values(this.stats.teams)) {
			teamRecord.winRate = teamRecord.uses ? teamRecord.wins / teamRecord.uses : 0;
		}
		for (const pokemonRecord of Object.values(this.stats.pokemon)) {
			pokemonRecord.usageRate = pokemonRecord.uses / totalSlots;
			pokemonRecord.winRate = pokemonRecord.uses ? pokemonRecord.wins / pokemonRecord.uses : 0;
		}
		for (const itemRecord of Object.values(this.stats.items)) {
			itemRecord.winRate = itemRecord.uses ? itemRecord.wins / itemRecord.uses : 0;
		}
	}

	isTeamRetired(teamId, threshold = 750) {
		const teamRecord = this.stats.teams[teamId];
		if (!teamRecord) return false;
		return teamRecord.uses > threshold;
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
