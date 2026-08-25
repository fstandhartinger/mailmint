'use strict';

const { bad } = require('./errors');

/**
 * Validation for the per-mailbox field definitions of §2.
 *
 * A schema is rejected loudly at write time rather than quietly at parse time.
 * A field the user thought they defined but which the parser silently ignored
 * is the worst possible failure here: mail arrives, the field is null, and
 * nothing anywhere says why.
 */
const TYPES = new Set([
  'string', 'number', 'integer', 'boolean', 'date', 'datetime',
  'email', 'url', 'phone', 'currency', 'enum', 'array', 'object',
]);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_FIELDS = 60;

function validateField(f, path, depth) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    throw bad('invalid_schema', `${path} must be an object like {"name":"total","type":"number"}.`, { docs: '/docs#schema' });
  }
  const name = f.name;
  if (!NAME_RE.test(String(name || ''))) {
    throw bad('invalid_schema', `${path}.name "${name}" is not usable as a JSON key.`, {
      hint: 'Use letters, digits and underscores, starting with a letter or underscore — it becomes a key in the "fields" object.',
      docs: '/docs#schema',
    });
  }
  const type = f.type || 'string';
  if (!TYPES.has(type)) {
    throw bad('invalid_schema', `${path}.type "${type}" is not a field type.`, {
      hint: `Accepted types: ${[...TYPES].join(', ')}.`,
      docs: '/docs#schema',
    });
  }
  const out = {
    name: String(name),
    type,
    description: f.description ? String(f.description).slice(0, 500) : '',
    required: Boolean(f.required),
  };
  if (f.hint) out.hint = String(f.hint).slice(0, 300);

  if (type === 'enum') {
    if (!Array.isArray(f.options) || !f.options.length) {
      throw bad('invalid_schema', `${path} is an enum, so it needs "options": ["a","b"].`, {
        hint: 'A value the model returns that is not in the list becomes null and raises enum_violation.',
        docs: '/docs#schema',
      });
    }
    out.options = f.options.map((o) => String(o)).slice(0, 200);
  }
  if (type === 'array') {
    const itemType = (f.items && f.items.type) || 'string';
    if (!TYPES.has(itemType)) throw bad('invalid_schema', `${path}.items.type "${itemType}" is not a field type.`, { docs: '/docs#schema' });
    out.items = { type: itemType };
    if (itemType === 'object') {
      if (depth >= 2) throw bad('invalid_schema', `${path} nests too deeply; two levels of objects is the limit.`, { docs: '/docs#schema' });
      out.items.fields = validateSchema(f.items.fields || [], `${path}.items.fields`, depth + 1);
    }
    if (itemType === 'enum') out.items.options = (f.items.options || []).map(String);
  }
  if (type === 'object') {
    if (depth >= 2) throw bad('invalid_schema', `${path} nests too deeply; two levels of objects is the limit.`, { docs: '/docs#schema' });
    if (!Array.isArray(f.fields) || !f.fields.length) {
      throw bad('invalid_schema', `${path} is an object, so it needs "fields": [...].`, { docs: '/docs#schema' });
    }
    out.fields = validateSchema(f.fields, `${path}.fields`, depth + 1);
  }
  return out;
}

/**
 * Accepts either the array form `[{name,type},…]` or the object shorthand
 * `{"total": "number", "vendor": {"type":"string","hint":"…"}}` that people
 * reach for first, and always returns the array form. Normalising here means
 * the parser, the dashboard and the stored version all see one shape.
 */
function validateSchema(schema, path = 'schema', depth = 0) {
  if (schema === null || schema === undefined) return [];
  let list = schema;
  if (!Array.isArray(schema)) {
    if (typeof schema !== 'object') {
      throw bad('invalid_schema', `${path} must be an array of field definitions.`, { docs: '/docs#schema' });
    }
    list = Object.entries(schema).map(([name, v]) => (
      typeof v === 'string' ? { name, type: v } : { name, ...(v || {}) }
    ));
  }
  if (list.length > MAX_FIELDS) {
    throw bad('invalid_schema', `${path} has ${list.length} fields, over the limit of ${MAX_FIELDS}.`, {
      hint: 'A schema this wide costs accuracy as well as tokens. Split it across mailboxes.',
      docs: '/docs#schema',
    });
  }
  const seen = new Set();
  return list.map((f, i) => {
    const out = validateField(f, `${path}[${i}]`, depth);
    if (seen.has(out.name)) {
      throw bad('invalid_schema', `${path} defines "${out.name}" twice.`, {
        hint: 'Field names become keys in one JSON object, so they have to be unique.',
        docs: '/docs#schema',
      });
    }
    seen.add(out.name);
    return out;
  });
}

module.exports = { validateSchema, TYPES };
