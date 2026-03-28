# Champion Meta Simulator

Mass AI-vs-AI battle runner for the custom Gen 9 `champion` format.

## What it does

- Loads candidate species **only** from `data/available.json`
- Generates a persistent validated team pool (validation is done only on pool creation)
- Runs async AI-vs-AI battles in loop
- Persists cumulative team score + Pokemon usage/win stats in JSON files

## Files

- `tools/champion-meta/index.js` - CLI orchestrator
- `tools/champion-meta/available-loader.js` - available.json loader
- `tools/champion-meta/team-generator.js` - coherent team generation + one-time validation
- `tools/champion-meta/battle-runner.js` - async battle loop
- `tools/champion-meta/database-manager.js` - persistence layer

## Run

```bash
node tools/champion-meta/index.js --battles=5000 --pool-size=300 --concurrency=4
```

Build team pool only (no battles):

```bash
node tools/champion-meta/index.js --reset-history --pool-size=50000 --battles=0 --max-team-attempts=2000000
```

## Docker (VPS)

Build image from project root:

```bash
docker build -t champion-meta .
```

Run simulation with persistent stats/team pool:

```bash
docker run --rm \
  -e CHAMPION_POOL_SIZE=50000 \
  -e CHAMPION_BATTLES=1000000 \
  -e CHAMPION_CONCURRENCY=8 \
  -e CHAMPION_EXTRA_ARGS="--reset-history --max-team-attempts=2000000" \
  -v "$(pwd)/databases/champion-meta:/app/databases/champion-meta" \
  champion-meta
```

By default, persisted data is written to:

- `databases/champion-meta/team-pool.json`
- `databases/champion-meta/stats.json`
