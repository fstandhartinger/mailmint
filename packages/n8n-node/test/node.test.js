'use strict';
process.env.MOCK_PORT = process.env.MOCK_PORT || '8799';
process.env.MAILMINT_TEST_URL = `http://127.0.0.1:${process.env.MOCK_PORT}`;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const mock = require('./mock-api.js');
const { createContext, request, BASE_URL, waitForMock } = require('./harness.js');
const { MailMint } = require('../dist/nodes/MailMint/MailMint.node.js');
const { MailMintTrigger } = require('../dist/nodes/MailMintTrigger/MailMintTrigger.node.js');
const { verifySignature, passesFilters } = require('../dist/nodes/MailMintTrigger/MailMintTrigger.node.js');

after(() => mock.server.close());

const SCHEMA_FIELDS = {
	field: [
		{ name: 'invoice_number', type: 'string', description: 'the invoice number', required: true, hint: 'labelled Invoice' },
		{ name: 'total', type: 'number', description: 'grand total', required: true, hint: 'labelled Total' },
		{ name: 'due_date', type: 'date', description: 'payment due', hint: 'labelled Due' },
	],
};

const RAW_EMAIL = [
	'From: Acme Billing <billing@acme.com>',
	'Subject: Invoice INV-2291 from Acme Ltd',
	'Date: Mon, 25 Aug 2026 09:14:01 +0000',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Invoice: INV-2291',
	'Total: $31.50',
	'Due: 2026-09-08',
].join('\r\n');

const run = (options) => MailMint.prototype.execute.call(createContext(options).context);
const hooks = new MailMintTrigger().webhookMethods.default;

test('the mock API is up', async () => {
	await waitForMock();
});

test('Parse Email reads a raw .eml straight off a binary field, with nothing configured', async () => {
	const items = [
		{
			json: {},
			binary: {
				data: {
					data: Buffer.from(RAW_EMAIL, 'utf8').toString('base64'),
					mimeType: 'message/rfc822',
					fileName: 'message.eml',
				},
			},
		},
	];
	const [output] = await run({
		items,
		params: {
			resource: 'parse',
			operation: 'parse',
			inputSource: 'auto',
			schemaSource: 'fields',
			schemaFields: SCHEMA_FIELDS,
			simplify: true,
			options: {},
		},
	});

	assert.equal(output.length, 1);
	assert.deepEqual(output[0].pairedItem, { item: 0 });
	assert.equal(output[0].json.invoice_number, 'INV-2291');
	assert.equal(output[0].json.total, 31.5);
	assert.equal(output[0].json.due_date, '2026-09-08');
	assert.equal(output[0].json._meta.subject, 'Invoice INV-2291 from Acme Ltd');
	assert.equal(output[0].json._meta.from_email, 'billing@acme.com');
	assert.equal(output[0].json._meta.needs_review, false);
	assert.equal(output[0].json._confidence, undefined);
});

test('Parse Email falls back to the JSON the IMAP node produces in Resolved format', async () => {
	const items = [
		{
			json: {
				subject: 'Invoice INV-7001 from Acme Ltd',
				textPlain: 'Invoice: INV-7001\nTotal: $99.00\nDue: 2026-10-01',
				textHtml: '<p>Invoice: INV-7001</p>',
			},
			binary: {
				attachment_0: { data: 'JVBERi0=', mimeType: 'application/pdf', fileName: 'invoice.pdf' },
			},
		},
	];
	const [output] = await run({
		items,
		params: {
			resource: 'parse',
			operation: 'parse',
			inputSource: 'auto',
			schemaSource: 'fields',
			schemaFields: SCHEMA_FIELDS,
			simplify: true,
			options: { includeConfidence: true },
		},
	});

	// The attached PDF must not be mistaken for the message itself.
	assert.equal(output[0].json.invoice_number, 'INV-7001');
	assert.equal(output[0].json.total, 99);
	assert.equal(output[0].json._confidence.total.source, 'rule');
	assert.equal(output[0].json._confidence.total.evidence, 'Total: $99.00');
});

test('Simplify off hands back the full contract object', async () => {
	const [output] = await run({
		params: {
			resource: 'parse',
			operation: 'parse',
			inputSource: 'fields',
			subject: 'Invoice INV-3',
			text: 'Invoice: INV-3\nTotal: $5.00',
			html: '',
			schemaSource: 'fields',
			schemaFields: SCHEMA_FIELDS,
			simplify: false,
			options: {},
		},
	});
	const json = output[0].json;
	for (const key of ['id', 'mailbox', 'envelope', 'headers', 'body', 'attachments', 'auth', 'tables', 'detected', 'fields', 'flags', 'parse', 'raw_url']) {
		assert.ok(key in json, `the full output is missing ${key}`);
	}
	assert.equal(json.fields.invoice_number.value, 'INV-3');
	assert.equal(json.fields.due_date.value, null, 'a field that is not there is null, never a guess');
	assert.ok(json.flags.includes('missing_required:due_date') === false);
});

test('the schema editor sends enum, array and object fields in the contract shape', async () => {
	const { context, calls } = createContext({
		params: {
			resource: 'parse',
			operation: 'parse',
			inputSource: 'fields',
			subject: 'Order 7',
			text: 'Status: paid',
			html: '',
			schemaSource: 'fields',
			schemaFields: {
				field: [
					{ name: 'status', type: 'enum', enumOptions: 'open, paid, overdue', description: 'the state' },
					{ name: 'skus', type: 'array', itemType: 'string', description: 'line items' },
					{ name: 'shipping', type: 'object', nestedFields: '[{"name":"street","type":"string"}]', description: 'address' },
				],
			},
			simplify: true,
			options: {},
		},
	});
	await MailMint.prototype.execute.call(context);

	const sent = calls[0].body.schema;
	assert.deepEqual(sent[0], { name: 'status', type: 'enum', description: 'the state', options: ['open', 'paid', 'overdue'] });
	assert.deepEqual(sent[1], { name: 'skus', type: 'array', description: 'line items', items: { type: 'string' } });
	assert.deepEqual(sent[2], { name: 'shipping', type: 'object', description: 'address', fields: [{ name: 'street', type: 'string' }] });
});

test('an enum without options fails the item with a fixable message', async () => {
	await assert.rejects(
		run({
			params: {
				resource: 'parse',
				operation: 'parse',
				inputSource: 'fields',
				subject: 'x',
				text: 'y',
				html: '',
				schemaSource: 'fields',
				schemaFields: { field: [{ name: 'status', type: 'enum', enumOptions: '' }] },
				simplify: true,
				options: {},
			},
		}),
		(error) => {
			assert.match(error.message, /Enum field "status" has no options/);
			assert.equal(error.context.itemIndex, 0);
			return true;
		},
	);
});

test('Get Many filters, and Get returns one message', async () => {
	const mailboxes = await request({ method: 'GET', url: `${BASE_URL}/v1/mailboxes` });
	const mailbox = mailboxes.body.data[0];

	const [listed] = await run({
		params: {
			resource: 'message',
			operation: 'getAll',
			returnAll: false,
			limit: 10,
			filters: { mailboxId: mailbox.id },
			simplify: true,
			options: {},
		},
	});
	assert.ok(listed.length >= 1);
	assert.equal(listed[0].json._meta.mailbox_id, mailbox.id);
	assert.deepEqual(listed[0].pairedItem, { item: 0 });

	const [single] = await run({
		params: {
			resource: 'message',
			operation: 'get',
			messageId: listed[0].json._meta.id,
			simplify: true,
			options: {},
		},
	});
	assert.equal(single[0].json._meta.id, listed[0].json._meta.id);
});

test('Get Raw and Download Attachment produce binary data', async () => {
	const [listed] = await run({
		params: { resource: 'message', operation: 'getAll', returnAll: true, filters: {}, simplify: true, options: {} },
	});
	const id = listed[0].json._meta.id;

	const [raw] = await run({
		params: { resource: 'message', operation: 'getRaw', messageId: id, binaryPropertyName: 'data' },
	});
	assert.equal(raw[0].binary.data.mimeType, 'message/rfc822');
	assert.equal(raw[0].binary.data.fileName, `${id}.eml`);
	assert.match(Buffer.from(raw[0].binary.data.data, 'base64').toString('utf8'), /^From: Acme Billing/);

	const [attachment] = await run({
		params: { resource: 'message', operation: 'downloadAttachment', attachmentId: 'att_demo', binaryPropertyName: 'file' },
	});
	assert.equal(attachment[0].binary.file.mimeType, 'application/pdf');
	assert.equal(attachment[0].binary.file.fileName, 'invoice.pdf', 'the filename comes off Content-Disposition');
});

test('a mailbox can be created, updated and deleted from the node', async () => {
	const [created] = await run({
		params: {
			resource: 'mailbox',
			operation: 'create',
			mailboxName: 'Purchase Orders',
			schemaSource: 'fields',
			schemaFields: { field: [{ name: 'po_number', type: 'string', description: 'the PO number' }] },
			mailboxOptions: {},
		},
	});
	const id = created[0].json.id;
	assert.match(created[0].json.address, /@parse\.mailmint\.dev$/);
	assert.equal(created[0].json.schema[0].name, 'po_number');

	const [updated] = await run({
		params: {
			resource: 'mailbox',
			operation: 'update',
			mailboxId: id,
			updateSchema: true,
			schemaSource: 'fields',
			schemaFields: { field: [{ name: 'po_number', type: 'string', description: 'the PO number' }, { name: 'total', type: 'currency', description: 'order value' }] },
			updateFields: { name: 'POs', webhookUrl: 'https://example.com/hook' },
		},
	});
	assert.equal(updated[0].json.name, 'POs');
	assert.equal(updated[0].json.webhook_url, 'https://example.com/hook');
	assert.equal(updated[0].json.schema.length, 2);

	const [deleted] = await run({ params: { resource: 'mailbox', operation: 'delete', mailboxId: id } });
	assert.equal(deleted[0].json.deleted, true);
});

test('the mailbox dropdown is filled from the account', async () => {
	const { context } = createContext({ params: {} });
	const { getMailboxes } = require('../dist/nodes/MailMint/GenericFunctions.js');
	const options = await getMailboxes.call(context);
	assert.ok(options.length >= 1);
	assert.match(options[0].name, /\(.+@parse\.mailmint\.dev\)$/);
	assert.match(options[0].value, /^mbx_/);
});

test('Continue On Fail emits a branchable error item instead of throwing', async () => {
	const { context } = createContext({
		continueOnFail: true,
		params: { resource: 'message', operation: 'get', messageId: 'msg_nope', simplify: true, options: {} },
	});
	const [output] = await MailMint.prototype.execute.call(context);
	assert.equal(output[0].json.error.code, 'message_not_found');
	assert.equal(output[0].json.error.httpCode, '404');
	assert.ok(output[0].json.errorMessage.includes('msg_nope'));
	assert.deepEqual(output[0].pairedItem, { item: 0 });
});

test('an API failure carries the message and the hint onto the node error', async () => {
	await assert.rejects(
		run({ params: { resource: 'message', operation: 'get', messageId: 'msg_nope', simplify: true, options: {} } }),
		(error) => {
			assert.match(error.message, /No message msg_nope/);
			assert.equal(error.context.itemIndex, 0);
			return true;
		},
	);
});

/* ------------------------------------------------------------------ trigger */

function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
	const signature = crypto
		.createHmac('sha256', secret)
		.update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), body]))
		.digest('hex');
	return `t=${t},v1=${signature}`;
}

test('the webhook signature is really verified', () => {
	const body = Buffer.from('{"id":"msg_1"}', 'utf8');
	assert.equal(verifySignature(sign('s3cret', body), body, 's3cret', 300), 'ok');
	assert.equal(verifySignature(sign('other', body), body, 's3cret', 300), 'mismatch');
	assert.equal(verifySignature(undefined, body, 's3cret', 300), 'missing');
	assert.equal(verifySignature('nonsense', body, 's3cret', 300), 'malformed');
	assert.equal(verifySignature(sign('s3cret', body, 1000), body, 's3cret', 300), 'stale');
	assert.equal(verifySignature(sign('s3cret', body, 1000), body, 's3cret', 0), 'ok');
	// A body that was tampered with after signing must not pass.
	assert.equal(verifySignature(sign('s3cret', body), Buffer.from('{"id":"msg_2"}'), 's3cret', 300), 'mismatch');
});

const sampleMessage = () =>
	mock.state.messages.find((m) => m.headers.subject === 'Invoice INV-2291 from Acme Ltd');

test('the webhook starts the workflow on a good signature and rejects a bad one', async () => {
	const message = sampleMessage();
	const body = Buffer.from(JSON.stringify(message), 'utf8');

	const good = createContext({
		params: { simplify: true, filters: {}, options: {} },
		staticData: { webhookSecret: 's3cret' },
		headers: { 'x-mailmint-signature': sign('s3cret', body), 'x-mailmint-delivery': 'dlv_1' },
		body: message,
		rawBody: body,
	});
	const accepted = await MailMintTrigger.prototype.webhook.call(good.context);
	assert.equal(accepted.workflowData[0][0].json.invoice_number, 'INV-2291');
	assert.equal(accepted.webhookResponse.delivery, 'dlv_1');

	const bad = createContext({
		params: { simplify: true, filters: {}, options: {} },
		staticData: { webhookSecret: 's3cret' },
		headers: { 'x-mailmint-signature': sign('wrong', body) },
		body: message,
		rawBody: body,
	});
	const rejected = await MailMintTrigger.prototype.webhook.call(bad.context);
	assert.equal(rejected.workflowData, undefined, 'a forged delivery must never start the workflow');
	assert.equal(rejected.noWebhookResponse, true);
	assert.equal(bad.responses[0].code, 401);
});

test('a filtered delivery answers 200 but does not start the workflow', async () => {
	const message = sampleMessage();
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	const { context } = createContext({
		params: { simplify: true, filters: { fromSender: 'someone-else@example.com' }, options: {} },
		staticData: { webhookSecret: 's3cret' },
		headers: { 'x-mailmint-signature': sign('s3cret', body) },
		body: message,
		rawBody: body,
	});
	const result = await MailMintTrigger.prototype.webhook.call(context);
	assert.equal(result.workflowData, undefined);
	assert.equal(result.webhookResponse.skipped, 'filtered');
});

test('each trigger registers its own webhook endpoint on the mailbox', async () => {
	const mailbox = mock.state.mailboxes[0];
	const staticData = {};
	const params = { deliveryMode: 'webhook', mailboxId: mailbox.id, options: {} };

	const before = createContext({ params, staticData });
	assert.equal(await hooks.checkExists.call(before.context), false);

	const create = createContext({ params, staticData });
	assert.equal(await hooks.create.call(create.context), true);
	assert.match(staticData.endpointId, /^wep_/);
	assert.equal(staticData.webhookSecret.length, 64);

	const mine = mock.state.endpoints.find((e) => e.id === staticData.endpointId);
	assert.equal(mine.url, 'http://n8n.test/webhook/abc');
	assert.equal(mine.secret, staticData.webhookSecret);
	assert.match(mine.description, /^n8n: /);
	assert.equal(mailbox.webhook_url, null, 'the shared alias is left alone');

	const again = createContext({ params, staticData });
	assert.equal(await hooks.checkExists.call(again.context), true);

	// A second trigger on the same mailbox gets its own endpoint and its own
	// secret, and neither can switch the other one off.
	const otherStatic = {};
	const other = createContext({ params, staticData: otherStatic });
	assert.equal(await hooks.create.call(other.context), true);
	assert.notEqual(otherStatic.endpointId, staticData.endpointId);
	assert.notEqual(otherStatic.webhookSecret, staticData.webhookSecret);
	assert.equal(mock.state.endpoints.filter((e) => e.mailbox_id === mailbox.id).length, 2);

	const remove = createContext({ params, staticData });
	assert.equal(await hooks.delete.call(remove.context), true);
	assert.equal(mock.state.endpoints.some((e) => e.id === staticData.endpointId), false);
	assert.equal(
		mock.state.endpoints.some((e) => e.id === otherStatic.endpointId),
		true,
		'the other workflow keeps its delivery',
	);

	await hooks.delete.call(createContext({ params, staticData: otherStatic }).context);
});

test('polling seeds its cursor on first activation and emits nothing', async () => {
	const staticData = {};
	const params = { deliveryMode: 'poll', simplify: true, filters: {}, options: {} };

	const first = createContext({ params, staticData, mode: 'trigger' });
	assert.equal(await MailMintTrigger.prototype.poll.call(first.context), null);
	assert.notEqual(staticData.cursor, undefined, 'the cursor is remembered');

	const idle = createContext({ params, staticData, mode: 'trigger' });
	assert.equal(await MailMintTrigger.prototype.poll.call(idle.context), null);

	await request({
		method: 'POST',
		url: `${BASE_URL}/v1/test/deliver`,
		body: { mailbox_id: mock.state.mailboxes[0].id },
	});

	const second = createContext({ params, staticData, mode: 'trigger' });
	const emitted = await MailMintTrigger.prototype.poll.call(second.context);
	assert.equal(emitted[0].length, 1, 'exactly the one new message');
	assert.equal(emitted[0][0].json.invoice_number, 'INV-2291');

	const third = createContext({ params, staticData, mode: 'trigger' });
	assert.equal(await MailMintTrigger.prototype.poll.call(third.context), null, 'no re-emit');
});

test('Fetch Test Event returns the most recent real message and leaves the cursor alone', async () => {
	const staticData = { cursor: '000000000001' };
	const { context } = createContext({
		params: { deliveryMode: 'poll', simplify: true, filters: {}, options: {} },
		staticData,
		mode: 'manual',
	});
	const emitted = await MailMintTrigger.prototype.poll.call(context);
	assert.equal(emitted[0].length, 1);
	assert.ok(emitted[0][0].json._meta.id.startsWith('msg_'));
	assert.equal(staticData.cursor, '000000000001');
});

test('the webhook mode never polls, and the poll mode never registers a webhook', async () => {
	const webhookMode = createContext({
		params: { deliveryMode: 'webhook', simplify: true, filters: {}, options: {} },
		staticData: {},
		mode: 'trigger',
	});
	assert.equal(await MailMintTrigger.prototype.poll.call(webhookMode.context), null);

	const pollMode = createContext({ params: { deliveryMode: 'poll' }, staticData: {} });
	assert.equal(await hooks.create.call(pollMode.context), true);
	assert.equal(pollMode.calls.length, 0, 'poll mode must not touch the mailbox');
});

test('the filters match on sender, mailbox and needs-review, in both output shapes', () => {
	const full = { headers: { from: { email: 'billing@acme.com' } }, mailbox: { id: 'mbx_1' }, flags: ['low_confidence:total'] };
	const simple = { _meta: { from_email: 'billing@acme.com', mailbox_id: 'mbx_1', needs_review: true, flags: [] } };

	for (const message of [full, simple]) {
		assert.equal(passesFilters(message, {}), true);
		assert.equal(passesFilters(message, { fromSender: 'acme.com' }), true);
		assert.equal(passesFilters(message, { fromSender: 'other.com' }), false);
		assert.equal(passesFilters(message, { mailboxId: 'mbx_1' }), true);
		assert.equal(passesFilters(message, { mailboxId: 'mbx_2' }), false);
		assert.equal(passesFilters(message, { needsReviewOnly: true }), true);
	}
	assert.equal(passesFilters({ flags: [], needs_review: false }, { needsReviewOnly: true }), false);
});

/* ------------------------------------------------- line items and review branch */

const { findLineItems, shapeItems, simplifyMessage } = require('../dist/nodes/MailMint/GenericFunctions.js');

const listAll = (extra = {}) =>
	run({
		params: {
			resource: 'message',
			operation: 'getAll',
			returnAll: true,
			filters: {},
			simplify: true,
			output: 'message',
			lineItemsSource: '',
			splitNeedsReview: false,
			options: {},
			...extra,
		},
	});

test('one email with a table becomes one item per line item', async () => {
	const [rows] = await listAll({
		output: 'lineItems',
		filters: {},
	});
	const lines = rows.filter((r) => r.json.invoice_number === 'INV-2292');
	assert.equal(lines.length, 3, 'three table rows, three items');
	assert.deepEqual(lines.map((r) => r.json.Item), ['Widget', 'Gadget', 'Support']);
	// the header fields ride along on every row
	assert.equal(lines[0].json.total, 132);
	assert.equal(lines[0].json._row_count, 3);
	assert.equal(lines[2].json._row_index, 2);
	assert.equal(lines[0].json._line_items_truncated, false);
	// every row traces back to the input item it came from
	for (const line of lines) assert.deepEqual(line.pairedItem, { item: 0 });

	// a message with no table still produces exactly one item, never zero
	const plain = rows.filter((r) => r.json.invoice_number === 'INV-2291');
	assert.ok(plain.length >= 1);
	for (const item of plain) assert.equal(item.json._row_count, 0);
});

test('line items are read out of an attachment when the body has none', () => {
	const message = {
		fields: {},
		tables: [],
		attachments: [
			{
				filename: 'invoice.pdf',
				extracted: {
					kind: 'pdf',
					tables: [
						{
							index: 0,
							row_count: 2,
							truncated: true,
							records: [{ Item: 'A', Amount: '1.00' }, { Item: 'B', Amount: '2.00' }],
						},
					],
				},
			},
		],
	};
	const found = findLineItems(message);
	assert.equal(found.rows.length, 2);
	assert.equal(found.source, 'attachments[0].extracted.tables[0]');
	assert.equal(found.truncated, true, 'a short table is said out loud, never silently short');
});

test('an array field wins over a table, and a named source is honoured', () => {
	const message = {
		fields: { line_items: { value: [{ sku: 'X' }] }, other: { value: [{ sku: 'Y' }] } },
		tables: [{ index: 0, records: [{ Item: 'Z' }] }],
	};
	assert.equal(findLineItems(message).source, 'fields.line_items');
	assert.equal(findLineItems(message, 'other').rows[0].sku, 'Y');
	assert.deepEqual(findLineItems(message, 'nothing_here').rows, []);
});

test('what the parser read out of an attachment is there without any option', async () => {
	const [rows] = await listAll();
	const withPdf = rows.find((r) => r.json.invoice_number === 'INV-2292');
	assert.equal(withPdf.json._meta.attachment_count, 1);
	assert.deepEqual(withPdf.json._meta.attachment_names, ['invoice-2292.pdf']);
	assert.equal(withPdf.json._meta.has_extracted_attachments, true);
	assert.equal(withPdf.json._attachments[0].extracted.kind, 'pdf');
	assert.equal(withPdf.json._attachments[0].extracted.tables[0].records.length, 3);
	assert.match(withPdf.json._attachments[0].extracted.text, /Invoice INV-2292/);
	assert.equal(withPdf.json._attachments[0].content_base64, undefined, 'bytes stay behind the option');
});

test('needs_review is at the top level and routes to a second output', async () => {
	const [parsed, review] = await listAll({ splitNeedsReview: true });
	assert.ok(parsed.length >= 2);
	assert.equal(review.length, 1);
	assert.equal(review[0].json._needs_review, true);
	assert.equal(review[0].json._meta.subject, 'your order');
	assert.ok(review[0].json._meta.flags.includes('missing_required:invoice_number'));
	for (const item of parsed) assert.equal(item.json._needs_review, false);
	// the routing marker never leaks out of the node
	for (const item of [...parsed, ...review]) assert.equal('__needsReview' in item.json, false);
});

test('the line items of a doubtful message stay with that message', () => {
	const message = {
		fields: { line_items: { value: [{ sku: 'A' }, { sku: 'B' }] } },
		flags: ['low_confidence:total'],
	};
	const simplified = simplifyMessage(message, { simplify: true });
	assert.equal(simplified._needs_review, true);
	assert.equal(simplified._meta.needs_review, true);
});

test('a mailbox can be reparsed in bulk, and a dry run changes nothing', async () => {
	const mailboxes = await request({ method: 'GET', url: `${BASE_URL}/v1/mailboxes` });
	const mailbox = mailboxes.body.data[0];

	const [dry] = await run({
		params: {
			resource: 'mailbox',
			operation: 'reparseAll',
			mailboxId: mailbox.id,
			dryRun: true,
			redeliver: false,
			reparseSchema: false,
		},
	});
	assert.equal(dry[0].json.dry_run, true);
	assert.ok(dry[0].json.messages_matched >= 3);
	assert.equal(dry[0].json.messages_reparsed, 0);

	const [real] = await run({
		params: {
			resource: 'mailbox',
			operation: 'reparseAll',
			mailboxId: mailbox.id,
			dryRun: false,
			redeliver: false,
			reparseSchema: true,
			schemaSource: 'fields',
			schemaFields: { field: [{ name: 'invoice_number', type: 'string', description: 'the number', hint: 'labelled Invoice' }] },
		},
	});
	assert.equal(real[0].json.messages_reparsed, real[0].json.messages_matched);
});

test('the node declares its outputs from its own parameters', () => {
	const { MailMint: Node } = require('../dist/nodes/MailMint/MailMint.node.js');
	const outputs = new Node().description.outputs;
	assert.equal(typeof outputs, 'string');
	assert.match(outputs, /Needs Review/);
	assert.match(new MailMintTrigger().description.outputs, /Needs Review/);
});

/* ------------------------------------------------- the fixes from the review */

test('a list of tags is not mistaken for the line items', () => {
	const message = {
		fields: {
			tags: { value: ['urgent', 'invoice'] },
			line_items: { value: [{ sku: 'A' }, { sku: 'B' }] },
		},
		tables: [],
	};
	// Object rows win over a scalar list defined before them.
	assert.equal(findLineItems(message).source, 'fields.line_items');

	// A table beats a scalar list too.
	const scalarsOnly = {
		fields: { tags: { value: ['a', 'b'] } },
		tables: [{ index: 0, records: [{ Item: 'Z' }] }],
	};
	assert.equal(findLineItems(scalarsOnly).source, 'tables[0]');

	// A scalar list is still used when there is genuinely nothing else.
	const nothingElse = { fields: { skus: { value: ['a', 'b'] } }, tables: [] };
	const found = findLineItems(nothingElse);
	assert.equal(found.source, 'fields.skus');
	assert.deepEqual(found.rows, [{ value: 'a' }, { value: 'b' }]);
});

test('a row column never silently overwrites a header field', () => {
	const message = {
		fields: { total: { value: 132 }, line_items: { value: [{ total: 27, sku: 'A' }] } },
		tables: [],
	};
	const [item] = shapeItems(message, { simplify: true, output: 'lineItems' }, 0);
	assert.equal(item.json.total, 27, 'the row value wins for that row');
	assert.deepEqual(item.json._shadowed, { total: 132 }, 'the message value is kept, not lost');

	const noClash = {
		fields: { total: { value: 132 }, line_items: { value: [{ amount: 27 }] } },
		tables: [],
	};
	const [clean] = shapeItems(noClash, { simplify: true, output: 'lineItems' }, 0);
	assert.equal(clean.json._shadowed, undefined);
});

test('_row_count is there whether Simplify is on or off', () => {
	const empty = { fields: {}, tables: [] };
	const [simple] = shapeItems(empty, { simplify: true, output: 'lineItems' }, 0);
	const [full] = shapeItems(empty, { simplify: false, output: 'lineItems' }, 0);
	assert.equal(simple.json._row_count, 0);
	assert.equal(full.json._row_count, 0);
	assert.equal(full.json.line_item_count, 0);
});

test('Fetch Test Event works in webhook mode too, and does not poll on a schedule', async () => {
	const params = { deliveryMode: 'webhook', simplify: true, filters: {}, options: {} };

	const manual = createContext({ params, staticData: {}, mode: 'manual' });
	const sample = await MailMintTrigger.prototype.poll.call(manual.context);
	assert.equal(sample[0].length, 1, 'the headline mode still returns a real sample');

	const scheduled = createContext({ params, staticData: {}, mode: 'trigger' });
	assert.equal(await MailMintTrigger.prototype.poll.call(scheduled.context), null);
});

test('the webhook is only declared when the node is actually in webhook mode', () => {
	const webhook = new MailMintTrigger().description.webhooks[0];
	assert.match(webhook.path, /deliveryMode/);
	assert.match(webhook.path, /undefined/);
});

test('an API with only one webhook per mailbox is not quietly stolen from', async () => {
	const mailbox = mock.state.mailboxes[1];
	mailbox.webhook_url = 'https://someone-else.example/hook';
	const params = { deliveryMode: 'webhook', mailboxId: mailbox.id, options: {} };
	// Pretend this MailMint predates per-registration endpoints.
	mock.disableEndpointApi = true;

	await assert.rejects(hooks.create.call(createContext({ params, staticData: {} }).context), (error) => {
		assert.match(error.message, /already delivers to another webhook/);
		assert.match(error.description, /someone-else\.example/);
		return true;
	});
	assert.equal(mailbox.webhook_url, 'https://someone-else.example/hook', 'untouched');

	// Deactivating this workflow must not switch off the other one either.
	assert.equal(await hooks.delete.call(createContext({ params, staticData: {} }).context), true);
	assert.equal(mailbox.webhook_url, 'https://someone-else.example/hook', 'still untouched');

	mailbox.webhook_url = null;
	mock.disableEndpointApi = false;
});

test('Poll Times is left to n8n, which injects exactly one of them', () => {
	const declared = new MailMintTrigger().description.properties.filter((p) => p.name === 'pollTimes');
	// Declaring our own produced a second Poll Times section in the editor next
	// to n8n's injected one, which is worse than the one it was meant to hide.
	assert.equal(declared.length, 0);
});
