'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * The dashboard's schema editor, exercised the way a browser exercises it:
 * render the page, serialise the form exactly as a form submission would, POST
 * it back unchanged, and read the schema out again.
 *
 * A save that changes nothing must change nothing. The editor only renders
 * name/type/description/required, so anything structural — an `array`'s
 * `items`, an `object`'s `fields`, an `enum`'s `options` — has to survive a
 * round trip it is not visibly part of. It did not: an array of objects came
 * back as an array of strings, silently, and an enum or object could not be
 * saved at all.
 */

let account;

before(async () => { await H.start(); account = await H.newAccount(); });
after(H.stop);

/**
 * Serialises the field editor's form the way a browser would: text and hidden
 * inputs by value, selects by their selected option, checkboxes only when
 * checked. Deliberately reads the rendered HTML rather than calling the
 * renderer's own data structures, so a change to the markup that drops a
 * control shows up here.
 */
function serialiseFieldEditor(html) {
  const start = html.indexOf('<div id="fields">');
  assert.ok(start >= 0, 'the mailbox page must contain the field editor');
  // Stop before the <template> that holds the blank row, or its placeholder
  // names would be submitted too — a browser does not submit template content.
  const end = html.indexOf('<template id="fieldtpl">', start);
  const region = html.slice(start, end > 0 ? end : undefined);

  const body = {};
  for (const m of region.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = m[1];
    const name = (/\bname="([^"]+)"/.exec(attrs) || [])[1];
    if (!name) continue;
    const type = (/\btype="([^"]+)"/.exec(attrs) || [])[1] || 'text';
    if (type === 'checkbox') {
      if (/\bchecked\b/.test(attrs)) body[name] = (/\bvalue="([^"]*)"/.exec(attrs) || [, '1'])[1];
      continue;
    }
    body[name] = decode((/\bvalue="([^"]*)"/.exec(attrs) || [, ''])[1]);
  }
  for (const m of region.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = (/\bname="([^"]+)"/.exec(m[1]) || [])[1];
    if (!name) continue;
    const selected = /<option value="([^"]*)" selected>/.exec(m[2]);
    const first = /<option value="([^"]*)"/.exec(m[2]);
    body[name] = decode((selected || first || [, ''])[1]);
  }
  return body;
}

const decode = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function roundTrip(schema) {
  const mb = await H.newMailbox(account.key, { schema });
  const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
  assert.equal(page.res.status, 200, 'the mailbox page must render');
  const form = serialiseFieldEditor(page.text);
  const saved = await H.req(`/dashboard/mailboxes/${mb.id}/schema`, {
    method: 'POST', cookie: account.cookie, form: true, body: form,
  });
  const after = await H.req(`/v1/mailboxes/${mb.id}`, { key: account.key });
  return { mb, form, saved, after: after.json.mailbox, error: saveError(saved) };
}

/**
 * The dashboard reports a rejected save by redirecting back with `?err=`, so a
 * 302 is not by itself success. This is what "the save worked" actually means.
 */
function saveError(saved) {
  const location = saved.res.headers.get('location') || '';
  const q = location.includes('?') ? new URLSearchParams(location.slice(location.indexOf('?') + 1)) : new URLSearchParams();
  if (q.get('err')) return q.get('err');
  if (saved.res.status >= 400) return `HTTP ${saved.res.status}`;
  return null;
}

describe('saving the schema editor unchanged changes nothing', () => {
  test('an array of objects does not become an array of strings', async () => {
    const schema = [
      { name: 'invoice_number', type: 'string', description: 'the number' },
      {
        name: 'line_items',
        type: 'array',
        description: 'one entry per invoice line',
        items: {
          type: 'object',
          fields: [
            { name: 'sku', type: 'string' },
            { name: 'qty', type: 'integer' },
            { name: 'amount', type: 'number' },
          ],
        },
      },
    ];
    const { after, error } = await roundTrip(schema);
    assert.equal(error, null, 'the save must be accepted, not bounced back with an error');

    const line = after.schema.find((f) => f.name === 'line_items');
    assert.ok(line, 'the field must still be there');
    assert.equal(line.type, 'array');
    assert.equal(line.items.type, 'object',
      'an array of objects must not silently become an array of strings');
    assert.deepEqual(line.items.fields.map((f) => f.name), ['sku', 'qty', 'amount']);
    assert.deepEqual(line.items.fields.map((f) => f.type), ['string', 'integer', 'number']);
  });

  test('an enum keeps its options, and the save is not rejected', async () => {
    const schema = [{ name: 'status', type: 'enum', description: 'where it stands', options: ['open', 'paid', 'overdue'] }];
    const { after, error } = await roundTrip(schema);
    assert.equal(error, null, 'the save must be accepted, not bounced back with an error');
    const f = after.schema.find((x) => x.name === 'status');
    assert.equal(f.type, 'enum');
    assert.deepEqual(f.options, ['open', 'paid', 'overdue']);
  });

  test('an object keeps its nested fields, and the save is not rejected', async () => {
    const schema = [{
      name: 'billing_address', type: 'object', description: 'where to send it',
      fields: [{ name: 'street', type: 'string' }, { name: 'city', type: 'string' }, { name: 'postcode', type: 'string' }],
    }];
    const { after, error } = await roundTrip(schema);
    assert.equal(error, null, 'the save must be accepted, not bounced back with an error');
    const f = after.schema.find((x) => x.name === 'billing_address');
    assert.equal(f.type, 'object');
    assert.deepEqual(f.fields.map((x) => x.name), ['street', 'city', 'postcode']);
  });

  test('an array of a scalar type keeps that type', async () => {
    const schema = [{ name: 'tags', type: 'array', items: { type: 'integer' } }];
    const { after, error } = await roundTrip(schema);
    assert.equal(error, null);
    assert.equal(after.schema[0].items.type, 'integer');
  });

  test('a schema at the validator\'s limits still round-trips', async () => {
    // The widest thing validateSchema will accept in one field: the nested part
    // is what the hidden control has to carry, so this is the case where a cap
    // that is too low would put the original defect back.
    const nested = Array.from({ length: 60 }, (unused, i) => ({
      name: `field_${i}`,
      type: 'string',
      description: `d${i}`.padEnd(400, '.'),
      hint: `h${i}`.padEnd(250, '.'),
    }));
    const schema = [{ name: 'line_items', type: 'array', items: { type: 'object', fields: nested } }];
    const { after, error } = await roundTrip(schema);
    assert.equal(error, null, 'a schema the API accepts must survive the dashboard');
    assert.equal(after.schema[0].items.type, 'object');
    assert.equal(after.schema[0].items.fields.length, 60);
    assert.equal(after.schema[0].items.fields[59].name, 'field_59');
  });

  test('everything else about the field survives too', async () => {
    const schema = [
      { name: 'total', type: 'number', description: 'grand total incl. tax', required: true },
      { name: 'note', type: 'string', description: '', required: false },
    ];
    const { after, error } = await roundTrip(schema);
    assert.equal(error, null);
    assert.equal(after.schema[0].description, 'grand total incl. tax');
    assert.equal(after.schema[0].required, true);
    assert.equal(after.schema[1].required, false);
    assert.equal(after.schema.length, 2);
  });
});

describe('the editor still lets the type actually be changed', () => {
  test('changing an array of objects to a plain string drops the old structure', async () => {
    const mb = await H.newMailbox(account.key, {
      schema: [{ name: 'line_items', type: 'array', items: { type: 'object', fields: [{ name: 'sku', type: 'string' }] } }],
    });
    const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
    const form = serialiseFieldEditor(page.text);
    form.f_0_type = 'string';                       // what a person does with the dropdown
    const saved = await H.req(`/dashboard/mailboxes/${mb.id}/schema`, {
      method: 'POST', cookie: account.cookie, form: true, body: form,
    });
    assert.equal(saveError(saved), null, 'changing a type is a legitimate save');
    const after = (await H.req(`/v1/mailboxes/${mb.id}`, { key: account.key })).json.mailbox;
    assert.equal(after.schema[0].type, 'string');
    assert.equal(after.schema[0].items, undefined, 'the array structure must not be carried into a string field');
  });

  test('structure the browser never rendered cannot be smuggled past validation', async () => {
    const mb = await H.newMailbox(account.key, { schema: [{ name: 'total', type: 'number' }] });
    const saved = await H.req(`/dashboard/mailboxes/${mb.id}/schema`, {
      method: 'POST',
      cookie: account.cookie,
      form: true,
      body: {
        f_0_name: 'line_items',
        f_0_type: 'array',
        // A hand-written payload claiming an item type that does not exist.
        f_0_struct: JSON.stringify({ type: 'array', items: { type: 'not_a_type' } }),
      },
    });
    const err = saveError(saved);
    assert.ok(err && /not a field type|invalid/i.test(err),
      `a structural payload still has to pass the same validation as the API, got ${JSON.stringify(err)}`);
    const after = (await H.req(`/v1/mailboxes/${mb.id}`, { key: account.key })).json.mailbox;
    assert.deepEqual(after.schema.map((f) => f.name), ['total'], 'and nothing is written');
  });

  test('a corrupt structural payload does not take the page down', async () => {
    const mb = await H.newMailbox(account.key, { schema: [{ name: 'total', type: 'number' }] });
    for (const junk of ['{', 'null', '[]', '"x"', 'x'.repeat(200000)]) {
      // eslint-disable-next-line no-await-in-loop
      const saved = await H.req(`/dashboard/mailboxes/${mb.id}/schema`, {
        method: 'POST', cookie: account.cookie, form: true,
        body: { f_0_name: 'total', f_0_type: 'number', f_0_struct: junk },
      });
      assert.ok(saved.res.status < 500, `junk struct ${junk.slice(0, 12)} must not 500 (got ${saved.res.status})`);
    }
  });
});
