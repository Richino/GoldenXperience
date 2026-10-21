import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Exercise the shipped worker: repeat launch, updated bundles, and live data.
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const listeners = new Map();
const stores = new Map();
const origin = 'https://goldenxperience.test';
let requests = 0;
let offline = false;
let storageUnavailable = false;
let preloadEnabled = false;
const key = (request) => typeof request === 'string' ? request : request.url;
const caches = {
  keys: async () => [...stores.keys()],
  delete: async (name) => stores.delete(name),
  open: async (name) => {
    if (storageUnavailable) throw new Error('Storage unavailable');
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      match: async (request) => store.get(key(request))?.clone(),
      put: async (request, response) => { store.set(key(request), response); },
      addAll: async () => {},
    };
  },
};
runInNewContext(source, {
  URL, Response, caches,
  fetch: async () => {
    requests++;
    if (offline) throw new Error('Offline');
    return new Response(`network-${requests}`);
  },
  self: {
    location: { origin },
    addEventListener: (name, callback) => listeners.set(name, callback),
    clients: { claim: async () => {} },
    registration: { navigationPreload: { enable: async () => { preloadEnabled = true; } } },
  },
});

async function dispatch(path, options = {}) {
  let response;
  const pending = [];
  listeners.get('fetch')({
    request: { url: new URL(path, origin).href, method: 'GET', mode: 'cors', ...options.request },
    preloadResponse: Promise.resolve(options.preload),
    respondWith: (value) => { response = value; },
    waitUntil: (value) => pending.push(value),
  });
  const result = await response;
  await Promise.all(pending);
  return result;
}

const asset = '/_next/static/chunks/app-a123.js';
assert.equal(await (await dispatch(asset)).text(), 'network-1');
assert.equal(await (await dispatch(asset)).text(), 'network-1');
assert.equal(requests, 1, 'Warm launches must not fetch cached immutable bundles');
assert.equal(await (await dispatch('/_next/static/chunks/app-b456.js')).text(), 'network-2', 'New deployments get their new bundle');
const beforeBypass = requests;
for (const path of ['/api/oanda/account-summary', '/api/auth/me', 'https://external.test/code.js']) {
  assert.equal(await dispatch(path), undefined, `${path} must bypass worker caching`);
}
assert.equal(await dispatch(asset, { request: { method: 'POST' } }), undefined);
assert.equal(requests, beforeBypass);
assert.equal(await (await dispatch('/')).text(), 'network-3');
assert.equal(await (await dispatch('/')).text(), 'network-4', 'HTML must remain network-first');
const beforePreload = requests;
assert.equal(await (await dispatch('/', { request: { mode: 'navigate' }, preload: new Response('preloaded') })).text(), 'preloaded');
assert.equal(requests, beforePreload, 'Use navigation preload without a duplicate request');
offline = true;
assert.equal(await (await dispatch(asset)).text(), 'network-1', 'Cached bundles remain available offline');
assert.equal(await (await dispatch('/')).text(), 'preloaded', 'Preserve existing offline navigation fallback');
assert.equal((await dispatch('/settings')).status, 503, 'Uncached offline navigation fails explicitly');
offline = false;
storageUnavailable = true;
assert.equal((await dispatch(asset)).status, 200, 'Cache failure must not block online launch');
assert.equal((await dispatch('/')).status, 200);
storageUnavailable = false;
stores.set('goldenxperience-v4', new Map());
stores.set('unrelated-app', new Map());
const activation = [];
listeners.get('activate')({ waitUntil: (value) => activation.push(value) });
await Promise.all(activation);
assert.equal(preloadEnabled, true);
assert.equal(stores.has('goldenxperience-v4'), false);
assert.equal(stores.has('unrelated-app'), true);
console.log('Passed PWA startup caching, update, navigation preload, bypass, offline, and storage-failure checks.');
