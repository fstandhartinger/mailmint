'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const { MailMint } = require('../dist/nodes/MailMint/MailMint.node.js');
const { MailMintTrigger } = require('../dist/nodes/MailMintTrigger/MailMintTrigger.node.js');
const { MailMintApi } = require('../dist/credentials/MailMintApi.credentials.js');

test('the package meets the n8n community-node rules', () => {
	assert.deepEqual(pkg.dependencies, {}, 'a verified community node may have no runtime dependencies');
	assert.equal(pkg.license, 'MIT');
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
	assert.equal(pkg.n8n.n8nNodesApiVersion, 1);
	assert.equal(pkg.n8n.nodes.length, 2);
	assert.equal(pkg.n8n.credentials.length, 1);
});

test('no forbidden runtime API is used in the shipped code', () => {
	const root = path.join(__dirname, '..', 'dist');
	const walk = (dir) =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
		});
	for (const file of walk(root)) {
		const source = fs.readFileSync(file, 'utf8');
		assert.ok(!/require\(["']fs["']\)/.test(source), `${file} requires fs`);
		assert.ok(!/require\(["']child_process["']\)/.test(source), `${file} requires child_process`);
		assert.ok(!/process\.env/.test(source), `${file} reads process.env`);
		assert.ok(!/require\(["']axios["']\)/.test(source), `${file} requires axios`);
	}
});

test('the node describes every resource and operation', () => {
	const description = new MailMint().description;
	assert.equal(description.name, 'mailMint');
	assert.equal(description.usableAsTool, true);

	const resources = description.properties.find((p) => p.name === 'resource');
	assert.deepEqual(
		resources.options.map((o) => o.value).sort(),
		['mailbox', 'message', 'parse'],
	);
	assert.equal(resources.default, 'parse', 'Parse Email is the default operation');

	const operations = description.properties.filter((p) => p.name === 'operation');
	const values = operations.flatMap((p) => p.options.map((o) => o.value));
	for (const op of ['parse', 'get', 'getAll', 'getRaw', 'downloadAttachment', 'reparse', 'create', 'update', 'delete']) {
		assert.ok(values.includes(op), `missing operation ${op}`);
	}

	// Every operation option carries an action, which is what the node panel shows.
	for (const property of operations) {
		for (const option of property.options) assert.ok(option.action, `${option.value} has no action`);
	}
});

test('the schema editor exposes every field type in the contract', () => {
	const description = new MailMint().description;
	const fields = description.properties.filter((p) => p.name === 'schemaFields');
	assert.ok(fields.length >= 3, 'the schema editor is offered on parse, reparse and mailbox writes');

	const values = fields[0].options[0].values;
	const type = values.find((v) => v.name === 'type');
	assert.deepEqual(
		type.options.map((o) => o.value).sort(),
		[
			'array', 'boolean', 'currency', 'date', 'datetime', 'email',
			'enum', 'integer', 'number', 'object', 'phone', 'string', 'url',
		],
	);
	for (const name of ['name', 'type', 'description', 'required', 'hint', 'enumOptions', 'itemType', 'nestedFields']) {
		assert.ok(values.some((v) => v.name === name), `the schema editor has no ${name}`);
	}
});

test('Simplify defaults to on', () => {
	const simplify = new MailMint().description.properties.find((p) => p.name === 'simplify');
	assert.equal(simplify.default, true);
});

test('the trigger offers both modes and defaults to webhook', () => {
	const description = new MailMintTrigger().description;
	assert.equal(description.name, 'mailMintTrigger');
	assert.equal(description.polling, true);
	assert.equal(description.webhooks.length, 1);
	assert.equal(description.webhooks[0].httpMethod, 'POST');
	assert.deepEqual(description.inputs, []);

	const mode = description.properties.find((p) => p.name === 'deliveryMode');
	assert.equal(mode.default, 'webhook');
	assert.deepEqual(mode.options.map((o) => o.value).sort(), ['poll', 'webhook']);

	const filters = description.properties.find((p) => p.name === 'filters');
	assert.deepEqual(
		filters.options.map((o) => o.name).sort(),
		['fromSender', 'mailboxId', 'needsReviewOnly'],
	);
});

test('the credential tests itself against a real endpoint', () => {
	const credential = new MailMintApi();
	assert.equal(credential.name, 'mailMintApi');
	assert.equal(credential.test.request.url, '/v1/usage');
	assert.match(credential.authenticate.properties.headers.Authorization, /Bearer \{\{\$credentials\.apiKey\}\}/);
});

test('both nodes and the credential ship an icon in each theme', () => {
	for (const dir of ['nodes/MailMint', 'nodes/MailMintTrigger', 'credentials']) {
		for (const file of ['mailmint.svg', 'mailmint.dark.svg']) {
			const full = path.join(__dirname, '..', 'dist', dir, file);
			assert.ok(fs.existsSync(full), `${dir}/${file} is missing from dist`);
			assert.ok(fs.readFileSync(full, 'utf8').startsWith('<svg'), `${dir}/${file} is not an SVG`);
		}
	}
});
