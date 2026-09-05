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
//   --before=eca7778b1 --after=46b131dfe > /tmp/artifact-benchmark.json
// Both revisions' two changed modules are compiled identically in memory;
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
  const modulePaths = ['artifact-store', 'sqlite-artifact-metadata'].map(
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
    'The compared revisions must differ only in the two Artifact modules and tests/docs',
  );
  const sizes = (args.sizes ?? '100,1000,12000,50000')
    .split(',')
    .map((value) => positiveInteger(value));
  const config = {
    rounds: positiveInteger(args.rounds, 3),
    samples: positiveInteger(args.samples, 15),
    writeSamples: positiveInteger(args['write-samples'], 8),
    copySamples: positiveInteger(args['copy-samples'], 5),
    warmup: positiveInteger(args.warmup, 3),
    warmupMs: args['warmup-ms'] === undefined ? 0 : positiveInteger(args['warmup-ms']),
    timeoutMs: positiveInteger(args['timeout-ms'], 180_000),
  };
  const runs = [];
  const startedAt = new Date().toISOString();
  for (const [sizeIndex, backgroundCount] of sizes.entries()) {
    for (let round = 0; round < config.rounds; round++) {
      const order = (round + sizeIndex) % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
      for (const variant of order) {
        process.stderr.write(
          `background=${backgroundCount} round=${round + 1}/${config.rounds} ${variant}\n`,
        );
        const options = {
          ...config,
          backgroundCount,
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
  for (const backgroundCount of sizes) {
    const names = runs
      .find((run) => run.backgroundCount === backgroundCount)
      .operations.map((operation) => operation.name);
    for (const name of names) {
      const pair = {};
      for (const variant of ['before', 'after']) {
        const entries = runs
          .filter((run) => run.backgroundCount === backgroundCount && run.variant === variant)
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
        backgroundCount,
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
      'Sequential fresh processes, alternating variants; fixed 10-record source Session and 1 linked record, 4 KiB payloads; prewarmed API latency. Each operation warms up until both minimum call count and cumulative API time are satisfied; convergence is not assumed. Setup, assertions, cleanup and count instrumentation excluded from timed samples. Mutations reset fixture metadata after every call. Background is valid metadata only, without payload files. No physical purge, cold-cache or end-to-end UI benchmark.',
    summary,
    runs,
  };
}

async function runWorker(options) {
  const moduleSources = new Map();
  for (const name of ['artifact-store', 'sqlite-artifact-metadata']) {
    const source = git('show', `${options.revision}:packages/storage/src/${name}.ts`);
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
  assert.equal(loaded.size, 2, 'Both compared modules must come from the requested revision');
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
    seedBackground(repository, options.backgroundCount);
    const totalRecords = options.backgroundCount + 11;
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
        rowsAfter: 10,
        invoke: () => store.listPage('bench-target-session', { offset: 2, limit: 2 }),
        verify: (result) => {
          assert.equal(result.total, 10);
          assert.deepEqual(
            result.records.map((record) => record.id),
            ['bench-target-7', 'bench-target-6'],
          );
        },
      },
      {
        name: 'getInSession',
        rowsAfter: 10,
        invoke: () => store.getInSession('bench-target-session', 'bench-target-0'),
        verify: (result) => assert.deepEqual(result.record, target[0]),
      },
      {
        name: 'listTurn',
        rowsAfter: 10,
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
          store.create({ ...inputs[0], id: 'bench-created', sessionId: 'bench-new-session' }),
        verify: (result) => assert.equal(result.sizeBytes, 4096),
        cleanup: (result) => cleanupRecords([result]),
      },
      {
        name: 'copyConversation',
        rowsAfter: 11,
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
    ];
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
      const expected =
        options.variant === 'after' ? operation.rowsAfter : (operation.rowsBefore ?? totalRecords);
      assert.deepEqual(
        counter.counts,
        { returnedRows: expected, decodedRecords: expected },
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
  const counts = { returnedRows: 0, decodedRecords: 0 };
  const originalPrepare = database.prepare;
  const originalParse = JSON.parse;
  database.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (/\bSELECT\b/i.test(sql) && /\bartifact_records\b/i.test(sql)) {
      const all = statement.all;
      const get = statement.get;
      statement.all = function (...params) {
        const result = all.apply(this, params);
        counts.returnedRows += result.length;
        return result;
      };
      statement.get = function (...params) {
        const result = get.apply(this, params);
        if (result) counts.returnedRows++;
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
