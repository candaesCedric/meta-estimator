'use strict';

const crypto = require('crypto');
const {toID} = require('./database-manager');

const TEAM_LENGTH = 4;
const SUPPORT_MOVES = new Set([
	'protect', 'fakeout', 'helpinghand', 'tailwind', 'trickroom', 'wideguard', 'quickguard', 'followme', 'ragepowder',
	'spore', 'icywind', 'electroweb', 'thunderwave', 'willowisp', 'snarl', 'partingshot', 'taunt', 'encore',
]);

const SPEED_CONTROL_MOVES = new Set(['tailwind', 'trickroom', 'icywind', 'electroweb', 'thunderwave']);

const LOW_COHERENCE_MOVES = new Set([
	'hyperbeam', 'gigaimpact', 'hydrocannon', 'blastburn', 'frenzyplant', 'rockwrecker',
	'roaroftime', 'prismaticlaser', 'meteorassault', 'focuspunch',
	'fly', 'dig', 'bounce', 'skullbash', 'razorwind', 'lastresort', 'dreameater',
]);

const DEFAULT_ITEM_POOL = [
	'Life Orb', 'Focus Sash', 'Sitrus Berry', 'Leftovers', 'Safety Goggles', 'Covert Cloak',
	'Rocky Helmet', 'Clear Amulet', 'Choice Scarf', 'Choice Band', 'Choice Specs', 'Expert Belt',
];

const REQUIRED_CORE_TYPES = ['Fire', 'Water', 'Grass'];

const METAGROSS_MOVE_WEIGHTS = [
	{ name: 'Psychic Fangs', chance: 1.0 },
	{ name: 'Bullet Punch', chance: 0.778 },
	{ name: 'Protect', chance: 0.472 },
	{ name: 'Meteor Mash', chance: 0.333 },
	{ name: 'Earthquake', chance: 0.25 },
	{ name: 'Iron Head', chance: 0.25 },
	{ name: 'Knock Off', chance: 0.25 },
	{ name: 'Hammer Arm', chance: 0.222 },
	{ name: 'Hard Press', chance: 0.167 },
	{ name: 'Stomping Tantrum', chance: 0.167 },
];

class TeamGenerator {
	constructor(options) {
		this.dex = options.dex;
		this.validator = options.validator;
		this.prng = options.prng;
		this.speciesPool = options.speciesPool;
		this.megaChance = typeof options.megaChance === 'number' ? options.megaChance : 0.28;
		this.maxAttempts = options.maxAttempts || 10000;
		this.movePoolCache = new Map();
		this.preferredCategoryCache = new Map();
		this.topAbilityCache = new Map();
		this.speciesAbilityIdCache = new Map();
		this.legalMoveCache = new Map();
		this.legalItemCache = new Map();
		this.legalAbilityCache = new Map();
		this.megaStoneMap = this.buildMegaStoneMap();
	}

	buildMegaStoneMap() {
		const map = new Map();
		for (const item of this.dex.items.all()) {
			if (!item.exists || !item.megaStone) continue;
			if (!this.isItemLegal(item.name)) continue;
			for (const sourceName of Object.keys(item.megaStone)) {
				const key = toID(sourceName);
				if (!map.has(key)) map.set(key, []);
				map.get(key).push(item);
			}
		}
		return map;
	}

	isMoveLegal(moveName) {
		const move = this.dex.moves.get(moveName);
		if (!move.exists || !move.id) return false;
		if (this.legalMoveCache.has(move.id)) return this.legalMoveCache.get(move.id);
		const probeSet = {name: 'Probe', species: 'Pikachu', item: '', ability: 'Static'};
		const problem = this.validator.checkMove(probeSet, move, {});
		const legal = !problem;
		this.legalMoveCache.set(move.id, legal);
		return legal;
	}

	isItemLegal(itemName) {
		const item = this.dex.items.get(itemName);
		if (!item.exists || !item.id) return false;
		if (this.legalItemCache.has(item.id)) return this.legalItemCache.get(item.id);
		const probeSet = {name: 'Probe', species: 'Pikachu', item: item.name, ability: 'Static'};
		const problem = this.validator.checkItem(probeSet, item, {});
		const legal = !problem;
		this.legalItemCache.set(item.id, legal);
		return legal;
	}

	isAbilityLegal(species, abilityName) {
		const ability = this.dex.abilities.get(abilityName);
		if (!ability.exists || !ability.id) return false;
		const cacheKey = `${species.id}:${ability.id}`;
		if (this.legalAbilityCache.has(cacheKey)) return this.legalAbilityCache.get(cacheKey);
		const legalAbilityIds = new Set(Object.values(species.abilities).filter(Boolean).map(name => toID(name)));
		if (!legalAbilityIds.has(ability.id)) {
			this.legalAbilityCache.set(cacheKey, false);
			return false;
		}
		const probeSet = {name: species.name, species: species.name, item: '', ability: ability.name};
		const problem = this.validator.checkAbility(probeSet, ability, {});
		const legal = !problem;
		this.legalAbilityCache.set(cacheKey, legal);
		return legal;
	}

	isGeneratedSetLegal(set) {
		if (!set) return false;
		const species = this.dex.species.get(set.species);
		if (!species.exists) return false;
		if (!this.isAbilityLegal(species, set.ability)) return false;
		if (!this.isItemLegal(set.item)) return false;
		return set.moves.every(moveName => this.isMoveLegal(moveName));
	}

	generatePool(targetSize, existingPool = []) {
		const pool = [...existingPool];
		const existingIds = new Set(pool.map(team => team.id));
		let attempts = 0;
		let generatedCount = 0;
		let rejectedCount= {team: 0, strategic: 0, validation: 0};

		while (pool.length < targetSize && attempts < this.maxAttempts) {
			attempts += 1;
			const team = this.generateTeamCandidate();
			if (!team) {
				rejectedCount.team += 1;
				continue;
			}

			// if (!this.passesStrategicValidation(team)) {
			// 	rejectedCount.strategic += 1;
			// 	continue;
			// }

			const id = this.computeTeamId(team);
			if (existingIds.has(id)) continue;

			const members = team.map(set => set.species);
			const now = new Date().toISOString();
			pool.push({id, team, members, createdAt: now, updatedAt: now});
			existingIds.add(id);
			generatedCount += 1;
		}

		return {pool, generatedCount, rejectedCount, attempts};
	}

	generateTeamCandidate() {
		if (this.speciesPool.length < TEAM_LENGTH) return null;
		const shuffledSpecies = [...this.speciesPool];
		this.prng.shuffle(shuffledSpecies);

		const team = [];
		const usedSpecies = new Set();
		const usedItems = new Set();
		let restrictedCount = 0;

		for (const candidate of shuffledSpecies) {
			if (team.length >= TEAM_LENGTH) break;
			if (usedSpecies.has(candidate.id)) continue;
			if (candidate.isRestricted && restrictedCount >= 1) continue;

			const set = this.buildPokemonSet(candidate, usedItems);
			if (!set) continue;

			team.push(set);
			usedSpecies.add(candidate.id);
			usedItems.add(toID(set.item));
			if (candidate.isRestricted) restrictedCount += 1;
		}

		if (team.length !== TEAM_LENGTH) return null;
		if (!this.enforceVictreebelDrought(team, usedSpecies, usedItems)) return null;
		return team;
	}

	buildPokemonSet(candidate, usedItems) {
		let species = this.dex.species.get(candidate.name);
		if (species.id === 'ninetales') {
			species = this.dex.species.get('Ninetales-Alola');
		}
		if (!species.exists) return null;

		const movePool = this.getMovePool(species);
		if (movePool.length < 4) return null;

		const forcedSet = this.buildForcedSet(species, movePool, usedItems);
		if (forcedSet !== undefined) return this.isGeneratedSetLegal(forcedSet) ? forcedSet : null;

		const preferredCategory = this.getPreferredCategory(species);
		const ability = this.pickAbility(species);
		const item = this.pickItem(species, preferredCategory, usedItems);
		if (!ability || !item) return null;

		const moves = this.pickMoves(species, movePool, preferredCategory, item);
		if (moves.length < 4) return null;

		const nature = this.pickNature(species, preferredCategory);
		const evs = this.pickEVs(preferredCategory);
		const teraType = this.pickTeraType(species, moves);

		const set = {
			name: species.name,
			species: species.name,
			ability,
			item,
			nature,
			level: 50,
			teraType,
			evs,
			ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
			moves: moves.map(move => move.name),
		};
		return this.isGeneratedSetLegal(set) ? set : null;
	}

	buildForcedSet(species, movePool, usedItems) {
		if (species.id === 'victreebel') {
			const item = this.pickForcedMegaItem(species, usedItems);
			if (!item) return null;
			return this.buildConfiguredSet(species, movePool, {
				ability: 'Chlorophyll',
				item,
			});
		}
		if (species.id === 'glimmora') {
			const item = this.pickForcedMegaItem(species, usedItems);
			if (!item) return null;
			return this.buildConfiguredSet(species, movePool, {
				ability: 'Toxic Debris',
				item,
				nature: 'Timid',
				evs: {hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252},
				preferredCategory: 'Special',
			});
		}
		if (species.id === 'tsareena') {
			const item = this.dex.items.get('Wide Lens');
			if (!item.exists || usedItems.has(item.id)) return null;
			return this.buildConfiguredSet(species, movePool, {
				ability: 'Queenly Majesty',
				item: item.name,
				nature: 'Adamant',
				evs: {hp: 252, atk: 76, def: 68, spa: 0, spd: 100, spe: 12},
				ivs: {spe: 0},
				preferredCategory: 'Physical',
			});
		}
		if (species.id === 'pikachu') {
			const item = this.dex.items.get('Light Ball');
			if (!item.exists || usedItems.has(item.id)) return null;
			return this.buildConfiguredSet(species, movePool, {
				ability: this.pickAbility(species),
				item: item.name,
			});
		}
		if (species.id === 'metagross') {
			return this.buildMetagrossSet(species, movePool, usedItems);
		}
		if (species.id === 'incineroar') {
			return this.buildIncineroarSet(species, movePool, usedItems);
		}
		if (species.id === 'raichu' || species.id === 'raichualola') {
			return this.buildRaichuSet(species, movePool, usedItems);
		}
		if (species.id === 'maushold' || species.id === 'mausholdfour') {
			return this.buildMausholdSet(species, movePool, usedItems);
		}
		if (species.id === 'chesnaught') {
			return this.buildChesnaughtSet(species, movePool, usedItems);
		}
		return undefined;
	}

	buildConfiguredSet(species, movePool, config) {
		if (!this.isAbilityLegal(species, config.ability)) return null;
		if (!this.isItemLegal(config.item)) return null;
		const preferredCategory = config.preferredCategory || this.getPreferredCategory(species);
		const moves = this.pickMoves(species, movePool, preferredCategory, config.item);
		if (moves.length < 4) return null;
		const teraType = this.pickTeraType(species, moves);
		const ivs = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...(config.ivs || {})};

		return {
			name: species.name,
			species: species.name,
			ability: config.ability,
			item: config.item,
			nature: config.nature || this.pickNature(species, preferredCategory),
			level: 50,
			teraType,
			evs: config.evs || this.pickEVs(preferredCategory),
			ivs,
			moves: moves.map(move => move.name),
		};
	}

	pickSpecificItem(itemNames, usedItems) {
		for (const itemName of itemNames) {
			const item = this.dex.items.get(itemName);
			if (!item.exists) continue;
			if (!this.isItemLegal(item.name)) continue;
			if (usedItems.has(item.id)) continue;
			return item.name;
		}
		return null;
	}

	fillMoves(baseMoves, movePool, preferredCategory, itemName, bannedMoveIds = new Set()) {
		const moveMap = new Map(movePool.map(move => [move.id, move]));
		const chosen = [];
		const chosenIds = new Set();
		for (const moveName of baseMoves) {
			const move = moveMap.get(toID(moveName));
			if (!move) continue;
			if (bannedMoveIds.has(move.id)) continue;
			if (chosenIds.has(move.id)) continue;
			chosen.push(move);
			chosenIds.add(move.id);
		}

		const allowStatus = toID(itemName) !== 'assaultvest';
		const fallback = movePool
			.filter(move => !chosenIds.has(move.id))
			.filter(move => !bannedMoveIds.has(move.id))
			.filter(move => allowStatus || move.category !== 'Status')
			.sort((a, b) => this.rankMove(b, preferredCategory) - this.rankMove(a, preferredCategory));
		for (const move of fallback) {
			if (chosen.length >= 4) break;
			chosen.push(move);
			chosenIds.add(move.id);
		}
		return chosen.slice(0, 4);
	}

	chooseWeightedMoves(movePool, weightedMoves, preferredCategory, itemName, bannedMoveIds = new Set()) {
		const moveMap = new Map(movePool.map(move => [move.id, move]));
		const chosen = [];
		const chosenIds = new Set();
		const allowStatus = toID(itemName) !== 'assaultvest';
		for (const entry of weightedMoves) {
			const move = moveMap.get(toID(entry.name));
			if (!move) continue;
			if (bannedMoveIds.has(move.id)) continue;
			if (!allowStatus && move.category === 'Status') continue;
			if (chosenIds.has(move.id)) continue;
			if (entry.chance >= 1 || this.prng.random() < entry.chance) {
				chosen.push(move);
				chosenIds.add(move.id);
			}
		}

		const fallback = movePool
			.filter(move => !chosenIds.has(move.id))
			.filter(move => !bannedMoveIds.has(move.id))
			.filter(move => allowStatus || move.category !== 'Status')
			.sort((a, b) => this.rankMove(b, preferredCategory) - this.rankMove(a, preferredCategory));
		for (const move of fallback) {
			if (chosen.length >= 4) break;
			chosen.push(move);
			chosenIds.add(move.id);
		}
		return chosen.slice(0, 4);
	}

	buildMetagrossSet(species, movePool, usedItems) {
		const megaItem = this.pickForcedMegaItem(species, usedItems);
		const itemChoices = ['Assault Vest', 'Weakness Policy', 'X Accuracy'];
		if (megaItem) itemChoices.push(megaItem);
		const item = this.pickSpecificItem(itemChoices, usedItems);
		if (!item) return null;

		const moves = this.chooseWeightedMoves(movePool, METAGROSS_MOVE_WEIGHTS, 'Physical', item);
		if (moves.length < 4) return null;
		const teraType = this.pickTeraType(species, moves);
		return {
			name: species.name,
			species: species.name,
			ability: 'Clear Body',
			item,
			nature: 'Adamant',
			level: 50,
			teraType,
			evs: {hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252},
			ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
			moves: moves.map(move => move.name),
		};
	}

	buildIncineroarSet(species, movePool, usedItems) {
		const item = this.pickItem(species, 'Physical', usedItems);
		if (!item) return null;
		const moves = this.fillMoves(
			['Fake Out', 'Flare Blitz', 'Parting Shot', 'Protect'],
			movePool,
			'Physical',
			item,
			new Set(['knockoff'])
		);
		if (moves.length < 4 || !moves.some(move => move.id === 'fakeout')) return null;
		const teraType = this.pickTeraType(species, moves);
		return {
			name: species.name,
			species: species.name,
			ability: 'Intimidate',
			item,
			nature: 'Adamant',
			level: 50,
			teraType,
			evs: {hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252},
			ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
			moves: moves.map(move => move.name),
		};
	}

	buildRaichuSet(species, movePool, usedItems) {
		const megaKey = toID(species.baseSpecies || species.name);
		const megaChoices = this.megaStoneMap.get(megaKey) || [];
		const freeMegaChoices = megaChoices.filter(item => !usedItems.has(item.id));
		if (!freeMegaChoices.length) return null;
		const megaItem = this.prng.sample(freeMegaChoices);
		const moves = this.pickMoves(species, movePool, this.getPreferredCategory(species), megaItem.name);
		if (moves.length < 4) return null;
		const teraType = this.pickTeraType(species, moves);
		return {
			name: species.name,
			species: species.name,
			ability: this.pickAbility(species),
			item: megaItem.name,
			nature: this.pickNature(species, this.getPreferredCategory(species)),
			level: 50,
			teraType,
			evs: this.pickEVs(this.getPreferredCategory(species)),
			ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
			moves: moves.map(move => move.name),
		};
	}

	buildMausholdSet(species, movePool, usedItems) {
		const item = this.pickItem(species, 'Physical', usedItems);
		if (!item) return null;
		const moves = this.fillMoves(
			['Follow Me', 'Population Bomb', 'Protect', 'Helping Hand'],
			movePool,
			'Physical',
			item
		);
		if (moves.length < 4) return null;
		const allowedAbilities = ['Friend Guard', 'Technician'];
		const legalAbilities = allowedAbilities.filter(name => this.dex.abilities.get(name).exists);
		const ability = legalAbilities.length ? this.prng.sample(legalAbilities) : this.pickAbility(species);
		const teraType = this.pickTeraType(species, moves);
		return {
			name: species.name,
			species: species.name,
			ability,
			item,
			nature: 'Jolly',
			level: 50,
			teraType,
			evs: {hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252},
			ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
			moves: moves.map(move => move.name),
		};
	}

	buildChesnaughtSet(species, movePool, usedItems) {
		const item = this.pickForcedMegaItem(species, usedItems);
		if (!item) return null;
		const moves = this.fillMoves(
			['Feint', 'Wide Guard', 'Spiky Shield', 'Body Press'],
			movePool,
			'Physical',
			item
		);
		if (moves.length < 4) return null;
		const teraType = this.pickTeraType(species, moves);
		return {
			name: species.name,
			species: species.name,
			ability: 'Bulletproof',
			item,
			nature: 'Impish',
			level: 50,
			teraType,
			evs: {hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0},
			ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
			moves: moves.map(move => move.name),
		};
	}

	pickForcedMegaItem(species, usedItems) {
		const megaKey = toID(species.baseSpecies || species.name);
		const megaChoices = this.megaStoneMap.get(megaKey) || [];
		const freeMegaChoices = megaChoices.filter(item => !usedItems.has(item.id));
		if (!freeMegaChoices.length) return null;
		return this.prng.sample(freeMegaChoices).name;
	}

	speciesHasAbility(speciesName, abilityId) {
		const species = this.dex.species.get(speciesName);
		if (!species.exists) return false;
		let cached = this.speciesAbilityIdCache.get(species.id);
		if (!cached) {
			cached = new Set(Object.values(species.abilities).map(name => toID(name)));
			this.speciesAbilityIdCache.set(species.id, cached);
		}
		return cached.has(abilityId);
	}

	enforceVictreebelDrought(team, usedSpecies, usedItems) {
		const hasVictreebel = team.some(set => toID(set.species) === 'victreebel');
		if (!hasVictreebel) return true;
		const hasDroughtAlly = team.some(set => toID(set.ability) === 'drought');
		if (hasDroughtAlly) return true;

		const droughtCandidates = this.speciesPool.filter(candidate => (
			!usedSpecies.has(candidate.id) && this.speciesHasAbility(candidate.name, 'drought')
		));
		if (!droughtCandidates.length) return false;

		const replaceableIndexes = team
			.map((set, index) => ({set, index}))
			.filter(entry => toID(entry.set.species) !== 'victreebel');
		if (!replaceableIndexes.length) return false;

		const replacement = this.prng.sample(droughtCandidates);
		const toReplace = this.prng.sample(replaceableIndexes);
		const oldSet = toReplace.set;

		usedSpecies.delete(toID(oldSet.species));
		usedItems.delete(toID(oldSet.item));

		const newSet = this.buildPokemonSet(replacement, usedItems);
		if (!newSet || toID(newSet.ability) !== 'drought') {
			usedSpecies.add(toID(oldSet.species));
			usedItems.add(toID(oldSet.item));
			return false;
		}

		team[toReplace.index] = newSet;
		usedSpecies.add(toID(newSet.species));
		usedItems.add(toID(newSet.item));
		return true;
	}

	normalizeTeamForStrategy(team) {
		return team.map(set => ({
			speciesId: toID(set.species),
			abilityId: toID(set.ability),
			itemName: set.item,
			itemId: toID(set.item),
			teraType: set.teraType,
			baseTypes: this.dex.species.get(set.species).types || [],
			moveIds: set.moves.map(move => toID(move)),
		}));
	}

	getWeatherSupport(normalizedTeam) {
		let sun = false;
		let rain = false;
		let sand = false;
		let snow = false;
		let drought = false;

		for (const set of normalizedTeam) {
			const ability = set.abilityId;
			const moves = set.moveIds;

			if (ability === 'drought') {
				drought = true;
				sun = true;
			}
			if (ability === 'orichalcumpulse') sun = true;
			if (ability === 'drizzle' || ability === 'primordialsea') rain = true;
			if (ability === 'sandstream') sand = true;
			if (ability === 'snowwarning') snow = true;

			if (moves.includes('sunnyday')) sun = true;
			if (moves.includes('raindance')) rain = true;
			if (moves.includes('sandstorm')) sand = true;
			if (moves.includes('snowscape') || moves.includes('hail')) snow = true;
		}

		return {sun, rain, sand, snow, drought, any: sun || rain || sand || snow};
	}

	passesStrategicValidation(team) {
		const normalizedTeam = this.normalizeTeamForStrategy(team);
		const weather = this.getWeatherSupport(normalizedTeam);
		const hasVictreebel = normalizedTeam.some(set => set.speciesId === 'victreebel');
		if (hasVictreebel && !weather.drought) return false;

		const baseTypes = new Set(normalizedTeam.flatMap(set => set.baseTypes));
		const teraTypes = new Set(normalizedTeam.map(set => set.teraType));
		for (const type of REQUIRED_CORE_TYPES) {
			if (!baseTypes.has(type) && !teraTypes.has(type)) return false;
		}

		for (const set of normalizedTeam) {
			const ability = set.abilityId;
			const moves = set.moveIds;
			const isMegaMeganium = this.isMegaMeganiumSet(set);

			if ((moves.includes('solarbeam') || moves.includes('weatherball') || moves.includes('synthesis')) &&
				!weather.sun && !isMegaMeganium) return false;
			if (ability === 'swiftswim' && !weather.rain) return false;
			if ((moves.includes('hurricane') || moves.includes('thunder')) && !weather.rain) return false;

			if ((set.speciesId === 'raichu' || set.speciesId === 'raichualola') && this.isLevitateRaichuMegaSet(set)) {
				const hasEarthquakeAlly = normalizedTeam.some(ally => ally !== set && ally.moveIds.includes('earthquake'));
				if (!hasEarthquakeAlly) return false;
			}
		}
		return true;
	}

	isMegaMeganiumSet(set) {
		if (set.speciesId !== 'meganium') return false;
		const item = this.dex.items.get(set.itemName);
		if (!item.exists || !item.megaStone) return false;
		return item.megaStone['Meganium'] === 'Meganium-Mega';
	}

	isLevitateRaichuMegaSet(set) {
		if (set.speciesId !== 'raichu' && set.speciesId !== 'raichualola') return false;
		const item = this.dex.items.get(set.itemName);
		if (!item.exists || !item.megaStone) return false;
		const megaSpeciesName = item.megaStone['Raichu'] || item.megaStone['Raichu-Alola'];
		if (!megaSpeciesName) return false;
		const megaSpecies = this.dex.species.get(megaSpeciesName);
		const megaAbilityIds = Object.values(megaSpecies.abilities).map(ability => toID(ability));
		return megaAbilityIds.includes('levitate');
	}

	getMovePool(species) {
		const cached = this.movePoolCache.get(species.id);
		if (cached) return cached;
		const movePool = this.collectMovePool(species);
		this.movePoolCache.set(species.id, movePool);
		return movePool;
	}

	collectMovePool(species) {
		const preferred = new Set();
		const fallback = new Set();
		const fullLearnset = this.dex.species.getFullLearnset(species.id);

		for (const entry of fullLearnset) {
			if (!entry.learnset) continue;
			for (const [moveid, sources] of Object.entries(entry.learnset)) {
				if (!Array.isArray(sources)) continue;
				fallback.add(moveid);
				if (sources.some(source => source.startsWith('9'))) {
					preferred.add(moveid);
				}
			}
		}

		const source = preferred.size >= 4 ? preferred : fallback;
		const result = [];
		for (const moveid of source) {
			const move = this.dex.moves.get(moveid);
			if (!move.exists || !move.name) continue;
			if (move.isNonstandard === 'Unobtainable') continue;
			if (!this.isMoveLegal(move.name)) continue;
			result.push(move);
		}
		const filtered = result.filter(move => !LOW_COHERENCE_MOVES.has(move.id));
		return filtered.length >= 4 ? filtered : result;
	}

	getPreferredCategory(species) {
		const cached = this.preferredCategoryCache.get(species.id);
		if (cached) return cached;
		const atk = species.baseStats.atk;
		const spa = species.baseStats.spa;
		let preferredCategory = 'Mixed';
		if (atk >= spa * 1.15) preferredCategory = 'Physical';
		if (spa >= atk * 1.15) preferredCategory = 'Special';
		this.preferredCategoryCache.set(species.id, preferredCategory);
		return preferredCategory;
	}

	pickAbility(species) {
		let topAbilities = this.topAbilityCache.get(species.id);
		if (!topAbilities) {
			const abilityNames = Object.values(species.abilities).filter(Boolean);
			const abilities = abilityNames
				.map(name => this.dex.abilities.get(name))
				.filter(ability => ability.exists)
				.filter(ability => this.isAbilityLegal(species, ability.name));
			if (!abilities.length) return null;
			abilities.sort((a, b) => (b.rating || 0) - (a.rating || 0));
			const topRating = abilities[0].rating || 0;
			topAbilities = abilities.filter(ability => (ability.rating || 0) === topRating).map(ability => ability.name);
			this.topAbilityCache.set(species.id, topAbilities);
		}
		return this.prng.sample(topAbilities);
	}

	pickItem(species, preferredCategory, usedItems) {
		const megaKey = toID(species.baseSpecies || species.name);
		const megaChoices = this.megaStoneMap.get(megaKey) || [];
		if (megaChoices.length && this.prng.random() < this.megaChance) {
			const freeMegaChoices = megaChoices.filter(item => !usedItems.has(item.id));
			if (freeMegaChoices.length) {
				return this.prng.sample(freeMegaChoices).name;
			}
		}

		const roleItems = [];
		if (preferredCategory === 'Physical') {
			roleItems.push('Clear Amulet', 'Life Orb', 'Choice Band', 'Choice Scarf');
		} else if (preferredCategory === 'Special') {
			roleItems.push('Life Orb', 'Choice Specs', 'Choice Scarf', 'Expert Belt');
		} else {
			roleItems.push('Sitrus Berry', 'Leftovers', 'Covert Cloak', 'Safety Goggles');
		}

		const uniqueItems = [...new Set([...roleItems, ...DEFAULT_ITEM_POOL])];
		for (const itemName of uniqueItems) {
			const item = this.dex.items.get(itemName);
			if (!item.exists) continue;
			if (!this.isItemLegal(item.name)) continue;
			if (usedItems.has(item.id)) continue;
			return item.name;
		}
		return null;
	}

	pickMoves(species, movePool, preferredCategory, itemName) {
		const chosen = [];
		const chosenIds = new Set();
		const isChoiceItem = ['Choice Band', 'Choice Specs', 'Choice Scarf'].includes(itemName);

		const damagingMoves = movePool.filter(move => move.category !== 'Status' && move.basePower > 0);
		const statusMoves = movePool.filter(move => move.category === 'Status');
		const supportMoves = statusMoves.filter(move => SUPPORT_MOVES.has(move.id));
		const stabDamagingMoves = damagingMoves.filter(move => species.types.includes(move.type));

		const addMove = move => {
			if (!move || chosenIds.has(move.id)) return;
			chosen.push(move);
			chosenIds.add(move.id);
		};

		if (!isChoiceItem) {
			const protect = supportMoves.find(move => move.id === 'protect');
			if (protect && this.prng.randomChance(3, 4)) addMove(protect);

			const speedControl = supportMoves.filter(move => SPEED_CONTROL_MOVES.has(move.id));
			if (speedControl.length && this.prng.randomChance(1, 2)) {
				addMove(this.prng.sample(speedControl));
			}
		}

		addMove(this.pickBestDamagingMove(stabDamagingMoves, preferredCategory, chosenIds));
		addMove(this.pickBestDamagingMove(damagingMoves, preferredCategory, chosenIds));

		if (!isChoiceItem) {
			for (const supportMove of supportMoves) {
				if (chosen.length >= 4) break;
				if (this.prng.randomChance(1, 3)) addMove(supportMove);
			}
		}

		const preferredDamaging = damagingMoves
			.filter(move => !chosenIds.has(move.id))
			.sort((a, b) => this.rankMove(b, preferredCategory) - this.rankMove(a, preferredCategory));
		for (const move of preferredDamaging) {
			if (chosen.length >= 4) break;
			addMove(move);
		}

		const fallbackSource = isChoiceItem ? damagingMoves : movePool;
		const fallback = fallbackSource
			.filter(move => !chosenIds.has(move.id))
			.sort((a, b) => this.rankMove(b, preferredCategory) - this.rankMove(a, preferredCategory));
		for (const move of fallback) {
			if (chosen.length >= 4) break;
			addMove(move);
		}

		return chosen.slice(0, 4);
	}

	pickBestDamagingMove(moves, preferredCategory, chosenIds) {
		const candidates = moves
			.filter(move => !chosenIds.has(move.id))
			.sort((a, b) => this.rankMove(b, preferredCategory) - this.rankMove(a, preferredCategory));
		return candidates[0] || null;
	}

	rankMove(move, preferredCategory) {
		if (move.category === 'Status') {
			let supportWeight = SUPPORT_MOVES.has(move.id) ? 60 : 35;
			if (SPEED_CONTROL_MOVES.has(move.id)) supportWeight += 20;
			return supportWeight;
		}
		let score = move.basePower || 0;
		if (typeof move.accuracy === 'number') {
			score *= (move.accuracy / 100);
		}
		if (preferredCategory !== 'Mixed' && move.category === preferredCategory) score += 20;
		if (preferredCategory === 'Physical' && move.category === 'Special') score -= 30;
		if (preferredCategory === 'Special' && move.category === 'Physical') score -= 30;
		if (move.recoil || move.mindBlownRecoil) score -= 12;
		if (move.priority > 0) score += 10;
		if (['allAdjacentFoes', 'allAdjacent', 'foeSide'].includes(move.target)) score += 8;
		return score;
	}

	pickNature(species, preferredCategory) {
		if (preferredCategory === 'Physical') {
			return species.baseStats.spe >= 90 ? 'Jolly' : 'Adamant';
		}
		if (preferredCategory === 'Special') {
			return species.baseStats.spe >= 90 ? 'Timid' : 'Modest';
		}
		if (species.baseStats.hp + species.baseStats.def + species.baseStats.spd >= 300) {
			return species.baseStats.def >= species.baseStats.spd ? 'Impish' : 'Calm';
		}
		return 'Serious';
	}

	pickEVs(preferredCategory) {
		if (preferredCategory === 'Physical') {
			return {hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252};
		}
		if (preferredCategory === 'Special') {
			return {hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252};
		}
		return {hp: 252, atk: 0, def: 132, spa: 0, spd: 124, spe: 0};
	}

	pickTeraType(species, moves) {
		const damaging = moves.filter(move => move.category !== 'Status');
		if (!damaging.length) return species.types[0];
		damaging.sort((a, b) => this.rankMove(b, 'Mixed') - this.rankMove(a, 'Mixed'));
		return damaging[0].type;
	}

	computeTeamId(team) {
		const canonical = team
			.map(set => ({
				species: toID(set.species),
				item: toID(set.item),
				ability: toID(set.ability),
				nature: toID(set.nature),
				teraType: set.teraType,
				moves: set.moves.map(move => toID(move)).sort(),
			}))
			.sort((a, b) => a.species.localeCompare(b.species));
		const hash = crypto.createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
		return `team-${hash}`;
	}
}

module.exports = {TeamGenerator};
