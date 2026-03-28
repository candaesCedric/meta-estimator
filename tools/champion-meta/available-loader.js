'use strict';

const fs = require('fs');

class AvailableLoader {
	constructor(options) {
		this.dex = options.dex;
		this.availablePath = options.availablePath;
		this.validator = options.validator || null;
	}

	isSpeciesLegal(species) {
		if (!this.validator) return true;
		const abilities = Object.values(species.abilities || {}).filter(Boolean);
		const probeSet = {
			name: species.baseSpecies || species.name,
			species: species.name,
			ability: abilities[0] || 'No Ability',
			item: '',
			nature: 'Serious',
			moves: ['Protect'],
			level: 50,
		};
		const setHas = {};
		const validationSpecies = this.validator.getValidationSpecies(probeSet);
		const problem = this.validator.checkSpecies(
			probeSet,
			species,
			validationSpecies.tierSpecies,
			setHas
		);
		return !problem;
	}

	loadSpeciesPool() {
		const raw = JSON.parse(fs.readFileSync(this.availablePath, 'utf8'));
		const source = Array.isArray(raw.available) ? raw.available : [];
		const seen = new Set();
		const speciesPool = [];

		for (const entry of source) {
			const species = this.dex.species.get(entry);
			if (!species.exists || !species.id) continue;
			if (species.battleOnly) continue;
			if (species.requiredItems?.length) continue;
			if (species.requiredMove) continue;
			if (species.requiredAbility) continue;
			if (!this.isSpeciesLegal(species)) continue;
			if (seen.has(species.id)) continue;
			seen.add(species.id);
			speciesPool.push({
				id: species.id,
				name: species.name,
				baseSpecies: species.baseSpecies,
				types: species.types,
				baseStats: species.baseStats,
				tags: species.tags || [],
				isRestricted: (species.tags || []).includes('Restricted Legendary'),
			});
		}

		return speciesPool;
	}
}

module.exports = {AvailableLoader};
