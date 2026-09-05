'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSchema } = require('../src/schema');

test('schema text fields reject objects instead of storing [object Object]', () => {
  for (const [property, value] of [
    ['name', { value: 'total' }],
    ['type', { value: 'number' }],
    ['description', { value: 'grand total' }],
    ['hint', ['labelled Total']],
  ]) {
    assert.throws(
      () => validateSchema([{ name: 'total', type: 'number', [property]: value }]),
      (error) => error.code === 'invalid_schema' && error.message.includes(property),
      property,
    );
  }
});

test('enum options reject objects instead of coercing them to strings', () => {
  assert.throws(
    () => validateSchema([{ name: 'status', type: 'enum', options: ['open', { value: 'paid' }] }]),
    (error) => error.code === 'invalid_schema' && error.message.includes('options[1]'),
  );
  assert.throws(
    () => validateSchema([{
      name: 'statuses', type: 'array', items: { type: 'enum', options: ['open', { value: 'paid' }] },
    }]),
    (error) => error.code === 'invalid_schema' && error.message.includes('items.options'),
  );
});

test('valid schema shorthand and nested schemas stay unchanged', () => {
  assert.deepEqual(validateSchema({
    total: { type: 'number', description: 'grand total', hint: 'labelled Total' },
    status: { type: 'enum', options: ['open', 'paid'] },
  }), [
    { name: 'total', type: 'number', description: 'grand total', required: false, hint: 'labelled Total' },
    { name: 'status', type: 'enum', description: '', required: false, options: ['open', 'paid'] },
  ]);
});
