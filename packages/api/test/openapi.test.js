'use strict';

/**
 * C3 — the OpenAPI 3.1 reference (runs with NO database).
 *
 * Asserts the hand-authored spec in src/openapi.js against the real router in
 * src/api.js: methods, paths and path parameters must agree in BOTH
 * directions, every $ref must resolve, operationIds must be unique, every
 * operation must carry the bearer scheme, and the fields the API genuinely
 * emits as null must be typed nullable. The mount check starts the real
 * express app on an ephemeral loopback port — the only network traffic in
 * this file, and nothing here ever touches the database.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const spec = require('../src/openapi');
const { router } = require('../src/api');
const { app } = require('../src/server');

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/** Every operation in the spec, with its path item for inherited parameters. */
function* operations() {
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const key of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(key)) yield { path, method: key, op: pathItem[key], pathItem };
    }
  }
}

/** `:p` → `{p}` — the only normalisation, on both sides. */
const templated = (routerPath) => routerPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, p) => `{${p}}`);

/** {METHOD path} pairs the router actually serves, from router.stack. */
function routerPairs() {
  const pairs = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const path = templated(layer.route.path);
    for (const method of Object.keys(layer.route.methods)) {
      if (method === '_all') continue;
      pairs.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return pairs;
}

const specPairs = () => [...operations()].map(({ path, method }) => `${method.toUpperCase()} ${path}`);

/** Resolves $ref chains against the root of the spec. */
function deref(schema) {
  while (schema && typeof schema === 'object' && typeof schema.$ref === 'string') {
    schema = schema.$ref.split('/').slice(1).reduce((node, part) => (node == null ? node : node[part]), spec);
  }
  return schema;
}

/** Hands every $ref string anywhere in the spec to `fn`. */
function walkRefs(node, fn, seen = new WeakSet()) {
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, fn, seen);
    return;
  }
  if (typeof node.$ref === 'string') fn(node.$ref);
  for (const value of Object.values(node)) walkRefs(value, fn, seen);
}

/** OpenAPI 3.1 nullable: a type array containing 'null', or anyOf/oneOf with one. */
const hasNullType = (schema) => {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  return ['anyOf', 'oneOf'].some((key) => Array.isArray(schema[key]) && schema[key].some(hasNullType));
};

const typeSet = (schema) => {
  const out = new Set();
  schema = deref(schema);
  if (schema && typeof schema === 'object') {
    if (typeof schema.type === 'string') out.add(schema.type);
    if (Array.isArray(schema.type)) for (const t of schema.type) out.add(t);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(schema[key])) for (const s of schema[key]) for (const t of typeSet(s)) out.add(t);
    }
  }
  return out;
};

test('the spec is a complete OpenAPI 3.1 document', () => {
  assert.match(spec.openapi, /^3\.1\./);
  assert.equal(typeof spec.info.title, 'string');
  assert.ok(spec.info.title.length > 0);
  assert.equal(typeof spec.info.version, 'string');
  assert.ok(spec.info.version.length > 0);
});

test('paths are unprefixed; the servers url carries the /v1 prefix', () => {
  assert.ok(spec.servers.length >= 1);
  assert.ok(spec.servers[0].url.endsWith('/v1'), 'pinned convention: servers carries /v1');
  for (const path of Object.keys(spec.paths)) {
    assert.ok(path.startsWith('/'), `spec path ${path} must start with /`);
    assert.ok(!path.startsWith('/v1'), `spec path ${path} must not repeat the /v1 prefix`);
  }
});

test('spec and router serve exactly the same 21 operations', () => {
  const routerSet = new Set(routerPairs());
  const specSet = new Set(specPairs());
  assert.deepStrictEqual(specSet, routerSet);
  assert.equal(routerSet.size, 21, 'the router should expose exactly 21 public operations');
  assert.equal(specSet.size, 21, 'the spec should document exactly 21 public operations');
});

test('operationIds are present and unique', () => {
  const ids = [];
  for (const { path, method, op } of operations()) {
    assert.equal(typeof op.operationId, 'string', `${method.toUpperCase()} ${path} needs an operationId`);
    assert.ok(op.operationId.length > 0, `${method.toUpperCase()} ${path} needs a non-empty operationId`);
    ids.push(op.operationId);
  }
  assert.equal(ids.length, 21);
  assert.equal(ids.length, new Set(ids).size, 'operationIds must be unique');
});

test('every $ref is internal and resolves', () => {
  const refs = [];
  walkRefs(spec, (ref) => refs.push(ref));
  assert.ok(refs.length > 0, 'the spec should reference its components');
  for (const ref of refs) {
    assert.ok(ref.startsWith('#/components/'), `${ref} must point inside this document`);
    const target = ref.split('/').slice(1).reduce((node, part) => (node == null ? node : node[part]), spec);
    assert.ok(target !== null && typeof target === 'object', `${ref} must resolve to an object under components`);
  }
});

test('every path template parameter is declared required, in path', () => {
  for (const { path, method, op, pathItem } of operations()) {
    const declared = [...(op.parameters || []), ...(pathItem.parameters || [])];
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      const found = declared.some(
        (p) => p && p.name === match[1] && p.in === 'path' && p.required === true,
      );
      assert.ok(found, `${method.toUpperCase()} ${path} must declare {${match[1]}} as in:path required:true`);
    }
  }
});

test('every operation requires the bearer apiKey scheme', () => {
  assert.equal(spec.components.securitySchemes.apiKey.type, 'http');
  assert.equal(spec.components.securitySchemes.apiKey.scheme, 'bearer');
  for (const { path, method, op } of operations()) {
    assert.ok(Array.isArray(op.security), `${method.toUpperCase()} ${path} must carry security`);
    assert.ok(
      op.security.some((s) => Object.hasOwn(s, 'apiKey') && s.apiKey.length === 0),
      `${method.toUpperCase()} ${path} must require { apiKey: [] }`,
    );
  }
});

test('the Error schema models src/errors.js truthfully', () => {
  const err = spec.components.schemas.Error;
  assert.deepEqual([...err.required].sort(), ['code', 'message']);
  for (const key of ['hint', 'docs', 'details', 'request_id']) {
    assert.ok(Object.hasOwn(err.properties, key), `Error.${key} must be documented`);
    assert.ok(!err.required.includes(key), `Error.${key} is omitted when falsy, never null, so not required`);
    assert.ok(hasNullType(err.properties[key]), `Error.${key} must be typed nullable (3.1 form)`);
  }
  assert.equal(err.properties.code.type, 'string');
  assert.equal(err.properties.message.type, 'string');
});

test('genuinely-null success fields are typed nullable', () => {
  // GET /messages: next_cursor is null at the end of the list (api.js:154).
  const list = deref(spec.paths['/messages'].get.responses['200'].content['application/json'].schema);
  assert.ok(hasNullType(list.properties.next_cursor), 'GET /messages next_cursor must be nullable');
  assert.ok(typeSet(list.properties.next_cursor).has('string'), 'next_cursor must allow string');

  // GET /events: events[].message is null for events without a stored message
  // (api.js:398–405).
  const feed = deref(spec.paths['/events'].get.responses['200'].content['application/json'].schema);
  const eventMessage = deref(feed.properties.events.items).properties.message;
  assert.ok(hasNullType(eventMessage), 'GET /events events[].message must be nullable');
  assert.ok(typeSet(eventMessage).has('object'), 'events[].message must allow object');

  // POST /parse: id, mailbox and raw_url are set to null because nothing was
  // stored, and every attachment's url is null too (api.js:336–341).
  const parse = deref(spec.paths['/parse'].post.responses['200'].content['application/json'].schema);
  for (const field of ['id', 'raw_url']) {
    assert.ok(hasNullType(parse.properties[field]), `POST /parse ${field} must be nullable`);
    assert.ok(typeSet(parse.properties[field]).has('string'), `POST /parse ${field} must allow string`);
  }
  assert.ok(hasNullType(parse.properties.mailbox), 'POST /parse mailbox must be nullable');
  assert.ok(typeSet(parse.properties.mailbox).has('object'), 'POST /parse mailbox must allow object');
  const attachment = deref(parse.properties.attachments.items);
  assert.ok(hasNullType(attachment.properties.url), 'POST /parse attachments[].url must be nullable');
  assert.ok(typeSet(attachment.properties.url).has('string'), 'attachments[].url must allow string');
});

test('the app serves GET /openapi.json — public, no-store, byte-identical to the spec module', async () => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await res.json(), spec);
  } finally {
    server.close();
  }
});
