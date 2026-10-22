// Cloudflare Worker (also works on Vercel Edge, Deno Deploy and Bun).
//
// The engine is runtime-agnostic: no Node built-ins. Inspection runs in the
// background, so hand `drift.flush()` to `ctx.waitUntil` to let it finish
// after the response is sent.
import { createDrift, memoryStore, webhookReporter } from 'api-drift';
import baseline from './baseline.json'; // committed output of `api-drift snapshot`

interface Env {
  DISCORD_WEBHOOK_URL?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

let drift: ReturnType<typeof createDrift> | undefined;

function getDrift(env: Env) {
  drift ??= createDrift({
    store: memoryStore(baseline as Parameters<typeof memoryStore>[0]),
    mode: 'watch',
    include: ['api.stripe.com', /\.githubusercontent\.com$/],
    sampleRate: 0.05,
    reporters: env.DISCORD_WEBHOOK_URL ? [webhookReporter(env.DISCORD_WEBHOOK_URL, { format: 'discord' })] : [],
  });
  return drift;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const d = getDrift(env);
    const trackedFetch = d.wrapFetch(fetch);
    const upstream = await trackedFetch(`https://raw.githubusercontent.com/nodejs/node/main/package.json`);
    ctx.waitUntil(d.flush());
    return new Response(upstream.body, upstream);
  },
};
