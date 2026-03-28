#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const util = require('util');
const {execSync} = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

function printHelp() {
	console.log('node tools/champion-meta/index.js [options]');
	console.log('');
	console.log('--format=champion           Battle format id (default: champion)');
	console.log('--battles=5000              Number of AI vs AI battles to run (0 = pool only)');
	console.log('--pool-size=300             Target amount of validated teams in team pool');
	console.log('--concurrency=4             Number of async battle workers');
	console.log('--report-every=100          Progress interval in battles');
	console.log('--flush-every=25            Persist stats every N updates');
	console.log('--retire-after=750          Retire teams after this many matches');
	console.log('--seed=1,2,3,4              Seed for deterministic runs');
	console.log('--mega-chance=0.28          Chance to assign a Mega stone in team generation');
	console.log('--ai-move=0.9               Probability AI chooses move over switch');
	console.log('--ai-mega=0.6               Probability AI attempts form-change options');
	console.log('--max-team-attempts=12000   Max attempts to fill missing teams in pool');
	console.log('--db-dir=databases/champion-meta  Output directory for persisted files');
	console.log('--available=data/available.json    Available species JSON path');
	console.log('--reset-history             Remove old stats and team pool before run');
	console.log('--skip-build                Skip `node build` before running');
	console.log('--force-build               Force `node build` even if dist already exists');
	console.log('--help                      Show this help');
}

function ensureBuild(skipBuild, forceBuild) {
	if (skipBuild) return;
	const distEntrypoint = path.join(ROOT, 'dist', 'sim', 'index.js');
	if (!forceBuild && fs.existsSync(distEntrypoint)) return;
	execSync('node build', {cwd: ROOT, stdio: 'inherit'});
}

function getString(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	return String(value);
}

function getNumber(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
	const cli = util.parseArgs({
		options: {
			help: {type: 'boolean', short: 'h', default: false},
			'skip-build': {type: 'boolean', default: false},
			'force-build': {type: 'boolean', default: false},
			format: {type: 'string', default: 'champion'},
			battles: {type: 'string', default: '1000'},
			'pool-size': {type: 'string', default: '250'},
			concurrency: {type: 'string', default: '4'},
			'report-every': {type: 'string', default: '100'},
			'flush-every': {type: 'string', default: '25'},
			'retire-after': {type: 'string', default: '750'},
			seed: {type: 'string'},
			'mega-chance': {type: 'string', default: '0.28'},
			'ai-move': {type: 'string', default: '0.9'},
			'ai-mega': {type: 'string', default: '0.6'},
			'max-team-attempts': {type: 'string', default: '12000'},
			'db-dir': {type: 'string', default: 'databases/champion-meta'},
			available: {type: 'string', default: 'data/available.json'},
			'reset-history': {type: 'boolean', default: false},
		},
		strict: true,
		allowPositionals: false,
	});

	if (cli.values.help) {
		printHelp();
		return;
	}

	ensureBuild(cli.values['skip-build'], cli.values['force-build']);
	global.Config = {allowrequestingties: false};

	const {Dex} = require('../../dist/sim/dex.js');
	const {PRNG} = require('../../dist/sim/prng.js');
	const {TeamValidator} = require('../../dist/sim/team-validator.js');
	const {AvailableLoader} = require('./available-loader');
	const {DatabaseManager} = require('./database-manager');
	const {TeamGenerator} = require('./team-generator');
	const {BattleRunner} = require('./battle-runner');

	Dex.includeModData();

	const formatId = getString(cli.values.format, 'champion');
	const format = Dex.formats.get(formatId);
	if (!format.exists) {
		throw new Error(`Unknown format: ${formatId}`);
	}

	const availablePath = path.resolve(ROOT, getString(cli.values.available, 'data/available.json'));
	const databaseDir = path.resolve(ROOT, getString(cli.values['db-dir'], 'databases/champion-meta'));
	const teamPoolPath = path.join(databaseDir, 'team-pool.json');
	const statsPath = path.join(databaseDir, 'stats.json');
	const retireAfter = Math.max(1, getNumber(cli.values['retire-after'], 750));

	if (cli.values['reset-history']) {
		if (fs.existsSync(teamPoolPath)) fs.rmSync(teamPoolPath, {force: true});
		if (fs.existsSync(statsPath)) fs.rmSync(statsPath, {force: true});
		console.log('[reset] old stats and team pool removed');
	}

	const db = new DatabaseManager({
		formatId,
		databaseDir,
		teamPoolPath,
		statsPath,
		flushEvery: getNumber(cli.values['flush-every'], 25),
	});

	const stopHandler = () => {
		db.flushIfNeeded(true);
		process.exit(130);
	};
	process.on('SIGINT', stopHandler);
	process.on('SIGTERM', stopHandler);

	const validator = TeamValidator.get(formatId);
	const loader = new AvailableLoader({dex: Dex, availablePath, validator});
	const speciesPool = loader.loadSpeciesPool();
	if (speciesPool.length < 4) {
		throw new Error(`available.json must provide at least 4 valid species (current: ${speciesPool.length}).`);
	}

	const prng = PRNG.get(cli.values.seed || null);
	const targetPoolSize = Math.max(2, getNumber(cli.values['pool-size'], 250));
	let teamPool = db.teamPool;

	if (teamPool.length < targetPoolSize) {
		const generator = new TeamGenerator({
			dex: Dex,
			validator,
			prng,
			speciesPool,
			megaChance: getNumber(cli.values['mega-chance'], 0.28),
			maxAttempts: getNumber(cli.values['max-team-attempts'], 12000),
		});

		console.log(`[pool] existing=${teamPool.length}, target=${targetPoolSize}, generating...`);
		const generation = generator.generatePool(targetPoolSize, teamPool);
		teamPool = generation.pool;
		db.saveTeamPool(teamPool);
		console.log(`[pool] generated=${generation.generatedCount}, rejected=${generation.rejectedCount.strategic}, validation=${generation.rejectedCount.validation}, team=${generation.rejectedCount.team}, attempts=${generation.attempts}, total=${teamPool.length}`);
	} else {
		console.log(`[pool] using persisted team pool (${teamPool.length} teams)`);
	}

	if (teamPool.length < 2) {
		throw new Error('Need at least two teams in the pool to run simulations.');
	}

	const totalBattles = Math.max(0, getNumber(cli.values.battles, 1000));
	if (totalBattles > 0) {
		console.log(`[run] format=${formatId}, battles=${totalBattles}, concurrency=${getNumber(cli.values.concurrency, 4)}`);

		const battleRunner = new BattleRunner({
			formatId,
			prng,
			concurrency: getNumber(cli.values.concurrency, 4),
			reportEvery: getNumber(cli.values['report-every'], 100),
			aiMoveChance: getNumber(cli.values['ai-move'], 0.9),
			aiMegaChance: getNumber(cli.values['ai-mega'], 0.6),
		});

		const startedAt = Date.now();
		const summary = await battleRunner.run({
			battles: totalBattles,
			teamPool,
			isTeamEligible: team => !db.isTeamRetired(team.id, retireAfter),
			onBattleResult: ({teamA, teamB, winner, activeParticipants}) => {
				db.recordBattle(teamA, teamB, winner, activeParticipants);
			},
			onProgress: ({summary: progress}) => {
				console.log(`[progress] done=${progress.completed}, p1=${progress.winsP1}, p2=${progress.winsP2}, ties=${progress.ties}, errors=${progress.errors}`);
			},
			onError: ({error, battleIndex}) => {
				db.recordError();
				console.error(`[error] battle=${battleIndex}: ${error.message}`);
			},
		});

		db.flushIfNeeded(true);
		const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`[done] completed=${summary.completed}, errors=${summary.errors}, elapsed=${elapsedSec}s`);
	} else {
		db.flushIfNeeded(true);
		console.log('[run] skipped battle simulation (battles=0)');
	}
	console.log(`[db] teamPool=${teamPoolPath}`);
	console.log(`[db] stats=${statsPath}`);
}

main().catch(error => {
	console.error(error.stack || error);
	process.exit(1);
});
