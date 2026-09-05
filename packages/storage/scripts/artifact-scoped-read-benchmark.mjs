/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Build core/storage first. Requires Node >=22.19 (registerHooks) and esbuild.
// Example: node packages/storage/scripts/artifact-scoped-read-benchmark.mjs \
//   --before=eca7778b1 --after=HEAD --growth=target --sizes=10,1000,12000
// Both revisions' three changed modules (including schema) compile identically in memory;
// dependencies use this checkout's dist. No checkout, database or source is overwritten.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '../../..');
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const split = arg.indexOf('=');
    if (!arg.startsWith('--') || split < 0) throw new Error(`Expected --key=value: ${arg}`);
    return [arg.slice(2, split), arg.slice(split + 1)];
  }),
);

if (args.worker) {
  process.stdout.write(JSON.stringify(await runWorker(JSON.parse(args.worker))));
} else {
  process.stdout.write(`${JSON.stringify(runComparison(), null, 2)}\n`);
}

function git(...params) {
  return execFileSync('git', params, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function positiveInteger(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid count: ${value}`);
  return number;
}

function quantile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function runComparison() {
  const before = git('rev-parse', '--verify', `${args.before ?? 'HEAD^'}^{commit}`).trim();
  const after = git('rev-parse', '--verify', `${args.after ?? 'HEAD'}^{commit}`).trim();
  const modulePaths = ['artifact-store', 'sqlite-artifact-metadata', 'sqlite-artifact-schema'].map(
    (name) => `packages/storage/src/${name}.ts`,
  );
  // Refuse comparisons that silently leave other product changes out of the loader.
  const unexpectedChanges = git('diff', '--name-only', before, after)
    .trim()
    .split('\n')
    .filter(
      (path) =>
        path &&
        !modulePaths.includes(path) &&
        !path.includes('/__tests__/') &&
        !path.endsWith('.md'),
    );
  assert.deepEqual(
    unexpectedChanges,
    [],
    'The compared revisions must differ only in the three Artifact modules and tests/docs',
  );
  const sizes = (args.sizes ?? '100,1000,12000,50000')
    .split(',')
    .map((value) => positiveInteger(value));
  const config = {
    growth: args.growth ?? 'other',
    operationNames: args.operations?.split(','),
    rounds: positiveInteger(args.rounds, 3),
    samples: positiveInteger(args.samples, 15),
    writeSamples: positiveInteger(args['write-samples'], 8),
    copySamples: positiveInteger(args['copy-samples'], 5),
    warmup: positiveInteger(args.warmup, 30),
    warmupMs: positiveInteger(args['warmup-ms'], 1000),
    timeoutMs: positiveInteger(args['timeout-ms'], 180_000),
  };
  assert.ok(['target', 'other'].includes(config.growth));
  if (config.growth === 'target') assert.ok(sizes.every((size) => size >= 10));
  const runs = [];
  const startedAt = new Date().toISOString();
  for (const [sizeIndex, size] of sizes.entries()) {
    const backgroundCount = config.growth === 'other' ? size : 100;
    const targetCount = config.growth === 'target' ? size : 10;
    for (let round = 0; round < config.rounds; round++) {
      const order = (round + sizeIndex) % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
      for (const variant of order) {
        process.stderr.write(
          `background=${backgroundCount} target=${targetCount} round=${round + 1}/${config.rounds} ${variant}\n`,
        );
        const options = {
          ...config,
          backgroundCount,
          targetCount,
          size,
          round,
          variant,
          revision: variant === 'before' ? before : after,
        };
        const child = spawnSync(
          process.execPath,
          ['--expose-gc', scriptPath, `--worker=${JSON.stringify(options)}`],
          {
            cwd: repoRoot,
            encoding: 'utf8',
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
            maxBuffer: 8 * 1024 * 1024,
            timeout: config.timeoutMs,
          },
        );
        if (child.status !== 0)
          throw new Error(child.stderr || String(child.error ?? `worker exit ${child.status}`));
        runs.push(JSON.parse(child.stdout));
      }
    }
  }
  const summary = [];
  for (const size of sizes) {
    const names = runs
      .find((run) => run.size === size)
      .operations.map((operation) => operation.name);
    for (const name of names) {
      const pair = {};
      for (const variant of ['before', 'after']) {
        const entries = runs
          .filter((run) => run.size === size && run.variant === variant)
          .map((run) => run.operations.find((operation) => operation.name === name));
        for (const entry of entries) assert.deepEqual(entry.counts, entries[0].counts);
        const samples = entries.flatMap((entry) => entry.samplesMs);
        pair[variant] = {
          samples: samples.length,
          medianMs: quantile(samples, 0.5),
          p95Ms: quantile(samples, 0.95),
          roundMedianMs: entries.map((entry) => quantile(entry.samplesMs, 0.5)),
          warmupByRound: entries.map((entry) => entry.warmup),
          sampleHalfMediansByRound: entries.map((entry) => {
            const middle = Math.ceil(entry.samplesMs.length / 2);
            return [
              quantile(entry.samplesMs.slice(0, middle), 0.5),
              quantile(entry.samplesMs.slice(middle), 0.5),
            ];
          }),
          ...entries[0].counts,
        };
      }
      summary.push({
        size,
        backgroundCount: config.growth === 'other' ? size : 100,
        targetCount: config.growth === 'target' ? size : 10,
        name,
        ...pair,
        medianSpeedup: pair.before.medianMs / pair.after.medianMs,
      });
    }
  }
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      release: release(),
      cpu: cpus()[0]?.model,
    },
    before,
    after,
    config,
    sizes,
    method:
      'Sequential fresh processes, alternating variants and rotating operations. Each revision uses its own Artifact store, repository and schema, compiled identically in memory. Grow either unrelated Sessions (target fixed at 10) or the target Session (background fixed at 100). Ten target records and one link have real 4 KiB payloads; all additional growth records are valid metadata only. Create writes into the existing target Session. Warmup satisfies both minimum call count and API time; convergence is not assumed. Setup, assertions, cleanup and count instrumentation are outside timings. Mutations reset fixture rows after every call. No physical purge, cold-cache or end-to-end UI measurement.',
    summary,
    runs,
  };
}

async function runWorker(options) {
  const moduleSources = new Map();
  let scopedReads = false;
  let persistedRevisions = false;
  for (const name of ['artifact-store', 'sqlite-artifact-metadata', 'sqlite-artifact-schema']) {
    const source = git('show', `${options.revision}:packages/storage/src/${name}.ts`);
    if (name === 'artifact-store') scopedReads = source.includes('listBySession(');
    if (name === 'sqlite-artifact-metadata')
      persistedRevisions = source.includes('getSessionRevision(');
    moduleSources.set(
      pathToFileURL(join(repoRoot, `packages/storage/dist/${name}.js`)).href,
      transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code,
    );
  }
  const loaded = new Set();
  const hook = registerHooks({
    load(url, context, nextLoad) {
      if (moduleSources.has(url)) {
        loaded.add(url);
        return { format: 'module', source: moduleSources.get(url), shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
  const { createSqliteArtifactStoreWriteAuthority } = await import('../dist/artifact-store.js');
  const { createSqliteArtifactMetadataRepository } = await import(
    '../dist/sqlite-artifact-metadata.js'
  );
  const { acquireOperationalStateDatabase } = await import('../dist/operational-state-store.js');
  assert.equal(loaded.size, 3, 'All three compared modules must come from the requested revision');
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-benchmark-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  const repository = createSqliteArtifactMetadataRepository(root);
  const lease = acquireOperationalStateDatabase(root);
  const { store } = authority;
  try {
    const text = 'x'.repeat(4096);
    const inputs = Array.from({ length: 10 }, (_, i) => ({
      id: `bench-target-${i}`,
      sessionId: 'bench-target-session',
      turnId: i < 5 ? 'selected-turn' : 'other-turn',
      name: `target-${i}.txt`,
      kind: 'file',
      source: 'tool_result',
      content: text,
      now: i,
    }));
    const target = [];
    for (const input of inputs) target.push(await store.create(input));
    await store.create({ ...inputs[0], id: 'bench-linked', sessionId: 'bench-linked-session' });
    repository.applyChanges({
      upserts: Array.from({ length: options.targetCount - 10 }, (_, offset) => {
        const i = offset + 10;
        const id = `bench-target-${i}`;
        const name = `target-${i}.txt`;
        return {
          ...target[0],
          id,
          name,
          turnId: 'other-turn',
          createdAt: i,
          relativePath: `bench-target-session/${id}-${name}`,
        };
      }),
    });
    seedBackground(repository, options.backgroundCount);
    const totalRecords = options.backgroundCount + options.targetCount + 1;
    async function cleanupRecords(records) {
      repository.applyChanges({ deleteIds: records.map((record) => record.id) });
      await Promise.all(records.map((record) => rm(join(root, 'artifacts', record.relativePath))));
    }
    const operations = [
      {
        name: 'readText',
        rowsAfter: 1,
        invoke: () => store.readTextInSession('bench-target-session', 'bench-target-0'),
        verify: (result) => assert.deepEqual(result, { ok: true, text }),
      },
      {
        name: 'listPage',
        rowsAfter: options.targetCount,
        invoke: () => store.listPage('bench-target-session', { offset: 2, limit: 2 }),
        verify: (result) => {
          assert.equal(result.total, options.targetCount);
          assert.deepEqual(
            result.records.map((record) => record.id),
            [`bench-target-${options.targetCount - 3}`, `bench-target-${options.targetCount - 4}`],
          );
        },
      },
      {
        name: 'getInSession',
        rowsAfter: persistedRevisions ? 1 : options.targetCount,
        invoke: () => store.getInSession('bench-target-session', 'bench-target-0'),
        verify: (result) => assert.deepEqual(result.record, target[0]),
      },
      {
        name: 'listTurn',
        rowsAfter: options.targetCount,
        invoke: () => store.listTurnArtifacts('bench-target-session', 'selected-turn'),
        verify: (result) =>
          assert.deepEqual(
            result.map((record) => record.id),
            [4, 3, 2, 1, 0].map((i) => `bench-target-${i}`),
          ),
      },
      {
        name: 'replay',
        rowsAfter: 1,
        invoke: () => store.create(inputs[0]),
        verify: (result) => assert.deepEqual(result, target[0]),
      },
      {
        name: 'create',
        rowsAfter: 0,
        samples: options.writeSamples,
        invoke: () =>
          store.create({ ...inputs[0], id: 'bench-created', sessionId: 'bench-target-session' }),
        verify: (result) => assert.equal(result.sizeBytes, 4096),
        cleanup: (result) => cleanupRecords([result]),
      },
      {
        name: 'copyConversation',
        rowsAfter: options.targetCount + 1,
        rowsBefore: totalRecords * 7 + 15,
        samples: options.copySamples,
        invoke: () =>
          store.copyConversationArtifacts({
            sourceSessionId: 'bench-target-session',
            targetSessionId: 'bench-copy-session',
            turnIds: ['selected-turn'],
            excludeArtifactIds: ['bench-target-1'],
            includeArtifactIds: ['bench-target-6'],
            linkedArtifacts: [{ sessionId: 'bench-linked-session', artifactIds: ['bench-linked'] }],
          }),
        verify: (result) =>
          assert.deepEqual(
            [...result.artifactIds.keys()],
            [
              'bench-target-0',
              'bench-target-2',
              'bench-target-3',
              'bench-target-4',
              'bench-linked',
              'bench-target-6',
            ],
          ),
        cleanup: async (result) => {
          repository.applyChanges({ deleteIds: [...result.artifactIds.values()] });
          await Promise.all(
            [...result.relativePaths.values()].map((path) => rm(join(root, 'artifacts', path))),
          );
        },
      },
    ].filter(
      (operation) => !options.operationNames || options.operationNames.includes(operation.name),
    );
    if (options.operationNames) assert.equal(operations.length, options.operationNames.length);
    const results = [];
    // Rotate operation order between rounds to reduce fixed JIT/order bias.
    const rotated = [...operations.slice(options.round), ...operations.slice(0, options.round)];
    for (const operation of rotated) {
      global.gc?.();
      const warmup = { iterations: 0, apiTimeMs: 0 };
      while (warmup.iterations < options.warmup || warmup.apiTimeMs < options.warmupMs) {
        const started = performance.now();
        const result = await operation.invoke();
        warmup.apiTimeMs += performance.now() - started;
        warmup.iterations++;
        operation.verify(result);
        if (operation.cleanup) await operation.cleanup(result);
      }
      const samplesMs = [];
      for (let i = 0; i < (operation.samples ?? options.samples); i++) {
        const started = performance.now();
        const result = await operation.invoke();
        const elapsed = performance.now() - started;
        operation.verify(result);
        if (operation.cleanup) await operation.cleanup(result);
        samplesMs.push(elapsed);
      }
      // Count on a separate call after all timed samples, then restore hooks.
      const counter = instrumentReads(lease.database);
      let countedResult;
      try {
        countedResult = await operation.invoke();
        operation.verify(countedResult);
      } finally {
        counter.restore();
        if (countedResult && operation.cleanup) await operation.cleanup(countedResult);
      }
      const expected = scopedReads ? operation.rowsAfter : (operation.rowsBefore ?? totalRecords);
      const expectedRevisionRows =
        persistedRevisions && ['getInSession', 'listPage'].includes(operation.name) ? 1 : 0;
      assert.deepEqual(
        counter.counts,
        { returnedRows: expected, decodedRecords: expected, revisionRows: expectedRevisionRows },
        operation.name,
      );
      assert.equal(
        lease.database.prepare('SELECT count(*) AS count FROM artifact_records').get().count,
        totalRecords,
      );
      results.push({ name: operation.name, warmup, samplesMs, counts: counter.counts });
    }
    return {
      variant: options.variant,
      revision: options.revision,
      backgroundCount: options.backgroundCount,
      targetCount: options.targetCount,
      size: options.size,
      schemaVersion: lease.database
        .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'artifact'")
        .get().version,
      scopedReads,
      persistedRevisions,
      round: options.round,
      operations: results,
    };
  } finally {
    lease.close();
    repository.close();
    authority.close();
    hook.deregister();
    await rm(root, { recursive: true, force: true });
  }
}

function seedBackground(repository, count) {
  const records = Array.from({ length: count }, (_, i) => ({
    id: `bench-background-${i}`,
    sessionId: `bench-background-session-${i % 100}`,
    turnId: 'background-turn',
    name: 'record.txt',
    kind: 'file',
    source: 'tool_result',
    createdAt: i,
    sizeBytes: 4096,
    relativePath: `bench-background-session-${i % 100}/bench-background-${i}-record.txt`,
  }));
  repository.applyChanges({ upserts: records });
}

function instrumentReads(database) {
  const counts = { returnedRows: 0, decodedRecords: 0, revisionRows: 0 };
  const originalPrepare = database.prepare;
  const originalParse = JSON.parse;
  database.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (/\bSELECT\b/i.test(sql) && /\bartifact_(records|session_revisions)\b/i.test(sql)) {
      const field = /\bartifact_session_revisions\b/.test(sql) ? 'revisionRows' : 'returnedRows';
      const all = statement.all;
      const get = statement.get;
      statement.all = function (...params) {
        const result = all.apply(this, params);
        counts[field] += result.length;
        return result;
      };
      statement.get = function (...params) {
        const result = get.apply(this, params);
        if (result) counts[field]++;
        return result;
      };
    }
    return statement;
  };
  JSON.parse = function (...params) {
    const parsed = originalParse(...params);
    if (parsed && typeof parsed.relativePath === 'string' && typeof parsed.source === 'string')
      counts.decodedRecords++;
    return parsed;
  };
  return {
    counts,
    restore() {
      database.prepare = originalPrepare;
      JSON.parse = originalParse;
    },
  };
}
