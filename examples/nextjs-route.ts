// Next.js App Router route handler: app/api/repo/route.ts
//
// Serverless file systems are read-only, so the contract comes from the
// baseline you commit with `npx api-drift snapshot`, and drift goes to Slack.
// The instance lives at module scope so it survives across requests.
import { createDrift, memoryStore, webhookReporter } from 'api-drift';
import baseline from '../../../.api-drift/baseline.json';

const drift = createDrift({
  store: memoryStore(baseline as Parameters<typeof memoryStore>[0]),
  mode: 'watch', // never learn in production: compare against the committed contract
  include: ['api.github.com'],
  sampleRate: 0.1, // inspect 10% of responses
  cooldown: '6h', // one Slack message per change per 6 hours
  reporters: process.env.SLACK_WEBHOOK_URL
    ? [webhookReporter(process.env.SLACK_WEBHOOK_URL, { format: 'slack', minSeverity: 'risky' })]
    : [],
});

const trackedFetch = drift.wrapFetch(fetch);

export async function GET(): Promise<Response> {
  // The Response is the original object; inspection happens on a clone, off the request path.
  const res = await trackedFetch('https://api.github.com/repos/nodejs/node', {
    headers: { 'user-agent': 'my-app' },
    next: { revalidate: 60 },
  } as RequestInit);
  const repo = (await res.json()) as { full_name: string; stargazers_count: number };
  return Response.json({ name: repo.full_name, stars: repo.stargazers_count });
}
