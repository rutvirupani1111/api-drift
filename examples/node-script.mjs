// Node script: learn the contract of the APIs you call, then get told when it drifts.
//
//   node examples/node-script.mjs
//
// First run (auto mode) learns each endpoint for 20 samples or 1 hour, then freezes it.
// Every later run compares live responses with the frozen contract.
import { consoleReporter, createDrift } from 'api-drift';
import { fileStore, jsonlReporter } from 'api-drift/node';

const drift = createDrift({
  store: fileStore('.api-drift/runtime-baseline.json'), // same format as `api-drift snapshot`
  mode: 'auto',
  freezeAfter: { samples: 20, duration: '1h' },
  include: ['api.github.com', 'registry.npmjs.org'],
  sampleRate: 1, // inspect every response; lower it on hot paths
  reporters: [consoleReporter(), jsonlReporter('.api-drift/drift.log.jsonl')],
  onDrift: (event) => {
    if (event.severity === 'breaking') process.exitCode = 1;
  },
});

// Option 1: patch the global fetch (every library that uses fetch is covered).
const restore = drift.patchGlobalFetch();

const repo = await fetch('https://api.github.com/repos/nodejs/node', {
  headers: { 'user-agent': 'api-drift-example' },
}).then((r) => r.json());
console.log(`${repo.full_name}: ${repo.stargazers_count} stars`);

const react = await fetch('https://registry.npmjs.org/react/latest').then((r) => r.json());
console.log(`react@${react.version}`);

// Option 2: check payloads that do not come from fetch (queues, websockets, SDKs).
const message = { type: 'order.paid', id: 'evt_1', amount: 1999, currency: 'usd' };
const result = await drift.check('queue orders.paid', message);
console.log(`queue sample: ${result.action}`);

restore();
await drift.flush(); // wait for background inspection and write the store
