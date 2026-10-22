import { describe, expect, it } from 'vitest';
import {
  endpointKey,
  isDynamicKey,
  isIdSegment,
  parseEndpointKey,
  redactUrl,
  routeOf,
  statusClass,
  templatePath,
} from '../src/core/endpoint';
import { compileMatchers } from '../src/core/match';

describe('templatePath', () => {
  it.each([
    ['/users/123', '/users/:id'],
    ['/users/550e8400-e29b-41d4-a716-446655440000/orders', '/users/:id/orders'],
    ['/objects/507f1f77bcf86cd799439011', '/objects/:id'],
    ['/commits/a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', '/commits/:id'],
    ['/people/rutvi%40example.com', '/people/:id'],
    ['/products/iphone-15-pro', '/products/:id'],
    ['/customers/cus_N3x8aB2kQ', '/customers/:id'],
    ['/reports/2026-10-23', '/reports/:id'],
    ['/react/18.2.0', '/react/:id'],
    ['/items/a1b2c3d4e5', '/items/:id'],
  ])('%s -> %s', (input, expected) => {
    expect(templatePath(input)).toBe(expected);
  });

  it.each([
    ['/v1/users', '/v1/users'],
    ['/apis/apps/v2beta1/deployments', '/apis/apps/v2beta1/deployments'],
    ['/oauth2/token', '/oauth2/token'],
    ['/2.0/repositories', '/2.0/repositories'],
    ['/repos/nodejs/node', '/repos/nodejs/node'],
    ['/react/latest', '/react/latest'],
    ['/h264/base64/sha256', '/h264/base64/sha256'],
  ])('keeps route names: %s', (input, expected) => {
    expect(templatePath(input)).toBe(expected);
  });

  it('normalises slashes', () => {
    expect(templatePath('/')).toBe('/');
    expect(templatePath('')).toBe('/');
    expect(templatePath('//users///42/')).toBe('/users/:id');
  });

  it('isIdSegment rejects empty segments', () => {
    expect(isIdSegment('')).toBe(false);
  });
});

describe('endpointKey', () => {
  it('builds METHOD host /path status-class', () => {
    expect(endpointKey({ method: 'get', url: 'https://API.GitHub.com/repos/nodejs/node/pulls/123?state=open', status: 200 })).toBe(
      'GET api.github.com /repos/nodejs/node/pulls/:id 2xx',
    );
  });

  it('keeps non-default ports and drops query strings by default', () => {
    expect(endpointKey({ url: 'http://localhost:5184/a?b=c', status: 404 })).toBe('GET localhost:5184 /a 4xx');
  });

  it('keeps selected query parameters, sorted, with ids templated', () => {
    const key = endpointKey(
      { method: 'GET', url: 'https://x.test/search?type=repo&page=2&q=hello', status: 200 },
      { keepQuery: ['type', 'page'] },
    );
    expect(key).toBe('GET x.test /search?page=:id&type=repo 2xx');
  });

  it('omits the status class when no status is known', () => {
    expect(endpointKey({ method: 'POST', url: 'https://x.test/orders' })).toBe('POST x.test /orders');
  });

  it('accepts URL objects and relative URLs', () => {
    expect(endpointKey({ url: new URL('https://x.test/a/1'), status: 201 })).toBe('GET x.test /a/:id 2xx');
    expect(endpointKey({ url: '/relative/7', status: 200 })).toBe('GET localhost /relative/:id 2xx');
  });

  it('statusClass groups by hundreds', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(503)).toBe('5xx');
  });
});

describe('key parsing', () => {
  it('round-trips a generated key', () => {
    expect(parseEndpointKey('GET api.github.com /repos/:id 2xx')).toEqual({
      method: 'GET',
      host: 'api.github.com',
      path: '/repos/:id',
      status: '2xx',
    });
    expect(routeOf('GET api.github.com /repos/:id 2xx')).toBe('GET api.github.com /repos/:id');
  });

  it('returns undefined for custom keys', () => {
    expect(parseEndpointKey('orders-queue')).toBeUndefined();
    expect(routeOf('orders-queue')).toBe('orders-queue');
  });

  it('redactUrl removes query string and fragment', () => {
    expect(redactUrl('https://x.test/a/b?token=secret#frag')).toBe('https://x.test/a/b');
  });
});

describe('isDynamicKey', () => {
  it.each(['123', '0', '550e8400-e29b-41d4-a716-446655440000', '1.0.0', '2026-10-23', 'me@example.com', 'a94a8fe5ccb19ba6', 'k8H2mQ9xL3pR7tY1z'])(
    '%s is data',
    (k) => expect(isDynamicKey(k)).toBe(true),
  );
  it.each(['name', 'line_2', 'utf8', 'address2', 'createdAt', 'x86_64', ''])('%s is a field name', (k) => expect(isDynamicKey(k)).toBe(false));
});

describe('compileMatchers', () => {
  const u = (s: string) => new URL(s);
  it('matches hosts and subdomains', () => {
    const m = compileMatchers('stripe.com');
    expect(m(u('https://api.stripe.com/v1/charges'), 'GET')).toBe(true);
    expect(m(u('https://stripe.com/'), 'GET')).toBe(true);
    expect(m(u('https://notstripe.com/'), 'GET')).toBe(false);
  });

  it('supports wildcard subdomains, host:port and host/path prefixes', () => {
    expect(compileMatchers('*.example.com')(u('https://a.example.com/'), 'GET')).toBe(true);
    expect(compileMatchers('*.example.com')(u('https://example.com/'), 'GET')).toBe(false);
    expect(compileMatchers('localhost:5184')(u('http://localhost:5184/x'), 'GET')).toBe(true);
    const prefix = compileMatchers('api.example.com/v2');
    expect(prefix(u('https://api.example.com/v2/users'), 'GET')).toBe(true);
    expect(prefix(u('https://api.example.com/v1/users'), 'GET')).toBe(false);
  });

  it('tests RegExps against the host, then the full URL', () => {
    expect(compileMatchers(/\.githubusercontent\.com$/)(u('https://raw.githubusercontent.com/x/y'), 'GET')).toBe(true);
    expect(compileMatchers(/\/v2\//g)(u('https://x.test/v2/a'), 'GET')).toBe(true);
    expect(compileMatchers(/\/v2\//g)(u('https://x.test/v2/a'), 'GET')).toBe(true);
  });

  it('applies functions, and exclude wins over include', () => {
    const m = compileMatchers([(url, method) => method === 'GET' && url.pathname.startsWith('/api')], 'internal.test');
    expect(m(u('https://x.test/api/a'), 'GET')).toBe(true);
    expect(m(u('https://x.test/api/a'), 'POST')).toBe(false);
    expect(m(u('https://internal.test/api/a'), 'GET')).toBe(false);
    expect(compileMatchers()(u('https://anything.test/'), 'GET')).toBe(true);
  });
});
