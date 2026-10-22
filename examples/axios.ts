// axios: one interceptor, no axios dependency inside api-drift (duck-typed).
import axios from 'axios';
import { consoleReporter, createDrift } from 'api-drift';
import { attachAxios } from 'api-drift/axios';
import { fileStore } from 'api-drift/node';

const drift = createDrift({
  store: fileStore('.api-drift/baseline.json'),
  mode: 'auto',
  reporters: [consoleReporter({ minSeverity: 'risky' })],
});

const client = axios.create({ baseURL: 'https://api.github.com', headers: { 'user-agent': 'api-drift-example' } });

// Observes every response, including 4xx/5xx error responses. Never alters or delays them.
const detach = attachAxios(drift, client);

const { data } = await client.get('/repos/nodejs/node');
console.log(data.full_name);

detach();
await drift.flush();
