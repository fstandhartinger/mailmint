'use strict';
/**
 * A stand-in for the MailMint API while packages/api is still being written.
 * It answers the endpoints in §3 of docs/CONTRACT.md with the §1 object shape,
 * signs webhook deliveries the way §5 says, and does a small amount of real
 * label-based extraction so a parse looks like a parse rather than a fixture.
 *
 * Node builtins only. Run: node test/mock-api.js [port]
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8787);
const DOMAIN = 'parse.mailmint.dev';

const ulid = (prefix) =>
	`${prefix}_${crypto.randomBytes(13).toString('hex').toUpperCase().slice(0, 26)}`;
const token = () => {
	const alphabet = 'abcdefghjkmnpqrstvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 12; i++) out += alphabet[crypto.randomInt(alphabet.length)];
	return out;
};

/* ------------------------------------------------------------------- state */

const state = { mailboxes: [], messages: [], events: [], deliveries: [], endpoints: [] };

function seedMailbox(name, schema) {
	const mailbox = {
		id: ulid('mbx'),
		name,
		address: `${token()}@${DOMAIN}`,
		schema: schema || [],
		schema_version: 1,
		webhook_url: null,
		webhook_secret: null,
		created_at: new Date().toISOString(),
	};
	state.mailboxes.push(mailbox);
	return mailbox;
}

const invoices = seedMailbox('Invoices', [
	{ name: 'invoice_number', type: 'string', description: 'the invoice number', required: true, hint: 'labelled Invoice' },
	{ name: 'total', type: 'number', description: 'grand total incl. tax', required: true, hint: 'labelled Total' },
	{ name: 'due_date', type: 'date', description: 'when payment is due', hint: 'labelled Due' },
]);
seedMailbox('Support', []);

/* -------------------------------------------------------------- extraction */

function labelsFor(field) {
	const labels = [field.name.replace(/[_-]+/g, ' ')];
	if (field.hint) {
		for (const word of String(field.hint).split(/\s+/)) {
			if (/^[A-Z][A-Za-z]{2,}$/.test(word)) labels.push(word);
		}
		const quoted = String(field.hint).match(/labelled\s+(.+)$/i);
		if (quoted) labels.push(...quoted[1].split(/\s+or\s+|,\s*/).map((s) => s.trim()));
	}
	return [...new Set(labels.filter(Boolean))];
}

function coerce(type, raw) {
	const text = String(raw).trim();
	switch (type) {
		case 'number':
		case 'currency': {
			const cleaned = text.replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}\b)/g, '');
			const value = Number(cleaned.replace(',', '.'));
			if (!Number.isFinite(value)) return { ok: false };
			if (type === 'currency') {
				const symbol = /€/.test(text) ? 'EUR' : /£/.test(text) ? 'GBP' : 'USD';
				return { ok: true, value: { amount: value, currency: symbol } };
			}
			return { ok: true, value };
		}
		case 'integer': {
			const value = parseInt(text.replace(/[^0-9-]/g, ''), 10);
			return Number.isFinite(value) ? { ok: true, value } : { ok: false };
		}
		case 'boolean':
			return { ok: true, value: /^(y|yes|true|1)$/i.test(text) };
		case 'date':
		case 'datetime': {
			const parsed = new Date(text);
			if (Number.isNaN(parsed.getTime())) return { ok: false };
			return { ok: true, value: type === 'date' ? parsed.toISOString().slice(0, 10) : parsed.toISOString() };
		}
		default:
			return { ok: true, value: text };
	}
}

function extract(schema, text, subject) {
	const fields = {};
	const flags = [];
	const haystack = `${subject || ''}\n${text || ''}`;

	for (const field of schema || []) {
		let hit = null;
		// A labelled "Total: $31.50" is worth more than a loose mention, so every
		// label is tried in its strict form before any of them is tried loosely.
		for (const strict of [true, false]) {
			for (const label of labelsFor(field)) {
				const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
				const separator = strict ? '[:#]' : '[:#]?';
				const pattern = new RegExp(
					`${escaped}\\s*(?:number|no\\.?|#)?\\s*${separator}\\s*([^\\n\\r]{1,80})`,
					'i',
				);
				const match = pattern.exec(haystack);
				if (match && match[1].trim()) {
					hit = { raw: match[1].trim().replace(/[.;,]$/, ''), evidence: match[0].trim() };
					break;
				}
			}
			if (hit) break;
		}

		if (!hit) {
			fields[field.name] = { value: null, confidence: 0, source: 'none', evidence: null };
			if (field.required) flags.push(`missing_required:${field.name}`);
			continue;
		}

		const coerced = coerce(field.type || 'string', hit.raw);
		if (!coerced.ok) {
			fields[field.name] = { value: null, confidence: 0, source: 'rule', evidence: hit.evidence };
			flags.push(`type_error:${field.name}`);
			continue;
		}

		if (field.type === 'enum' && Array.isArray(field.options) && !field.options.includes(coerced.value)) {
			fields[field.name] = { value: null, confidence: 0, source: 'rule', evidence: hit.evidence };
			flags.push(`enum_violation:${field.name}`);
			continue;
		}

		// Evidence has to be a verbatim substring or the confidence is halved,
		// exactly as §1 requires. It always is here, because we cut it out of
		// the input, but the check runs so the shape is honest.
		const verbatim = haystack.includes(hit.evidence);
		const confidence = verbatim ? 0.96 : 0.48;
		if (!verbatim) flags.push(`hallucinated_evidence:${field.name}`);
		if (confidence < 0.6) flags.push(`low_confidence:${field.name}`);
		fields[field.name] = {
			value: coerced.value,
			confidence,
			source: 'rule',
			evidence: hit.evidence,
		};
	}

	if (!schema || !schema.length) flags.push('no_schema');
	return { fields, flags };
}

/* ------------------------------------------------------------------ parsing */

function parseMime(raw) {
	const split = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
	const headerBlock = split >= 0 ? raw.slice(0, split) : raw;
	const body = split >= 0 ? raw.slice(split).replace(/^\r?\n\r?\n/, '') : '';
	const headers = {};
	for (const line of headerBlock.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
		const at = line.indexOf(':');
		if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
	}
	return { headers, text: body };
}

function address(value) {
	if (!value) return { name: null, email: null };
	const angle = /^(.*?)<([^>]+)>\s*$/.exec(value);
	if (angle) return { name: angle[1].trim().replace(/^"|"$/g, '') || null, email: angle[2].trim() };
	return { name: null, email: value.trim() };
}

function findAll(pattern, text) {
	return [...new Set((text || '').match(pattern) || [])];
}

function buildMessage(input, schema, mailbox, include) {
	let headers = {};
	let text = input.text || '';
	let html = input.html || null;
	let subject = input.subject || '';

	if (input.raw_mime) {
		const parsed = parseMime(String(input.raw_mime));
		headers = parsed.headers;
		subject = headers.subject || subject;
		if (/text\/html/i.test(headers['content-type'] || '')) html = parsed.text;
		else text = parsed.text;
	}

	const from = address(headers.from || input.from || 'billing@acme.com');
	const now = new Date().toISOString();
	const { fields, flags } = extract(schema, text || stripHtml(html), subject);
	const needsReview = flags.some((f) =>
		/^(low_confidence|missing_required|type_error|hallucinated_evidence):/.test(f),
	);

	const attachments = (input.attachments || []).map((a) => ({
		id: ulid('att'),
		filename: a.filename,
		content_type: a.content_type,
		size: a.size,
		sha256: crypto.createHash('sha256').update(a.filename).digest('hex'),
		inline: false,
		content_id: null,
		url: `http://localhost:${PORT}/v1/attachments/att_x`,
		extracted: a.extracted,
		...(include === 'attachments' ? { content_base64: Buffer.from(a.filename).toString('base64') } : {}),
	}));

	return {
		id: ulid('msg'),
		mailbox: mailbox
			? { id: mailbox.id, address: mailbox.address, name: mailbox.name }
			: { id: null, address: null, name: null },
		received_at: now,
		envelope: {
			from: from.email,
			to: mailbox ? [mailbox.address] : [],
			helo: 'mail.acme.com',
			remote_ip: '203.0.113.7',
			tls: true,
		},
		headers: {
			message_id: headers['message-id'] || `<${crypto.randomUUID()}@acme.com>`,
			date: headers.date ? new Date(headers.date).toISOString() : now,
			subject,
			from,
			to: mailbox ? [{ name: null, email: mailbox.address }] : [],
			cc: [],
			reply_to: [],
			in_reply_to: null,
			references: [],
			raw: headers,
		},
		body: {
			text,
			html,
			text_from_html: html ? stripHtml(html) : '',
			stripped_text: text.split(/\r?\n>/)[0],
			language: 'en',
		},
		attachments,
		auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', spam_score: 0.4 },
		tables: extractTables(html, text),
		detected: {
			type: /invoice/i.test(subject + text) ? 'invoice' : 'generic',
			emails: findAll(/[\w.+-]+@[\w-]+\.[\w.]+/g, `${text} ${from.email}`),
			urls: findAll(/https?:\/\/[^\s"'<>]+/g, text),
			phones: findAll(/\+?\d[\d\s()-]{7,}\d/g, text).filter(
				(value) => !/^\d{4}-\d{2}-\d{2}$/.test(value.trim()),
			),
			amounts: findAll(/[$€£]\s?\d[\d.,]*/g, text).map((raw) => ({
				value: Number(raw.replace(/[^0-9.]/g, '')),
				currency: raw.includes('€') ? 'EUR' : raw.includes('£') ? 'GBP' : 'USD',
				raw,
			})),
			dates: [],
			ids: [],
			addresses: [],
		},
		fields,
		flags,
		needs_review: needsReview,
		parse: {
			request_id: ulid('req'),
			schema_version: mailbox ? mailbox.schema_version : 1,
			model: null,
			llm_used: false,
			timings_ms: { total: 14, mime: 3, deterministic: 11, llm: 0, persist: 0 },
			warnings: [],
		},
		raw_url: `http://localhost:${PORT}/v1/messages/x/raw`,
	};
}

/** Deterministic table extraction, the way §1 tables[] is specified. */
function extractTables(html, text) {
	const tables = [];
	const blocks = String(html || '').match(/<table[\s\S]*?<\/table>/gi) || [];
	blocks.forEach((block, index) => {
		const rows = (block.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((row) =>
			(row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map((cell) => stripHtml(cell)),
		);
		if (rows.length < 2) return;
		const headers = rows[0];
		const body = rows.slice(1);
		tables.push({
			source: 'html',
			index,
			headers,
			rows: body,
			row_count: body.length,
			truncated: false,
			records: body.map((row) =>
				Object.fromEntries(headers.map((header, i) => [header, row[i] ?? null])),
			),
		});
	});

	// A pipe table in text/plain, which is what most receipts actually send.
	const lines = String(text || '').split(/\r?\n/).filter((line) => line.includes('|'));
	if (!tables.length && lines.length >= 2) {
		const cells = lines.map((line) => line.split('|').map((c) => c.trim()).filter(Boolean));
		const headers = cells[0];
		const body = cells.slice(1).filter((row) => row.length === headers.length);
		if (body.length) {
			tables.push({
				source: 'text',
				index: 0,
				headers,
				rows: body,
				row_count: body.length,
				truncated: false,
				records: body.map((row) =>
					Object.fromEntries(headers.map((header, i) => [header, row[i] ?? null])),
				),
			});
		}
	}
	return tables;
}

function stripHtml(html) {
	return String(html || '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.split('\n')
		.map((line) => line.replace(/[ \t]+/g, ' ').trim())
		.filter((line, index, all) => line !== '' || all[index - 1] !== '')
		.join('\n')
		.trim();
}

/* -------------------------------------------------------------- seed a mail */

const SAMPLE_RAW = [
	'From: Acme Billing <billing@acme.com>',
	'To: ' + invoices.address,
	'Subject: Invoice INV-2291 from Acme Ltd',
	'Date: Mon, 25 Aug 2026 09:14:01 +0000',
	'Message-ID: <CAF9911@mail.acme.com>',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Hello,',
	'',
	'Invoice: INV-2291',
	'Total: $31.50',
	'Due: 2026-09-08',
	'',
	'Pay at https://acme.com/pay/2291',
	'Thanks,',
	'Acme Billing',
].join('\r\n');

function deliver(mailbox, raw) {
	const message = buildMessage({ raw_mime: raw }, mailbox.schema, mailbox);
	state.messages.unshift(message);
	const event = {
		id: ulid('evt'),
		type: 'message.parsed',
		cursor: String(state.events.length + 1).padStart(12, '0'),
		message,
	};
	state.events.push(event);
	if (endpointsFor(mailbox).length) postWebhook(mailbox, message);
	return message;
}

/** Every endpoint a parsed message should be delivered to, §5 and the API. */
function endpointsFor(mailbox) {
	const rows = state.endpoints.filter((e) => e.mailbox_id === mailbox.id && e.active);
	if (rows.length) return rows;
	if (mailbox.webhook_url) {
		return [{ id: 'wep_alias', url: mailbox.webhook_url, secret: mailbox.webhook_secret || '' }];
	}
	return [];
}

function postWebhook(mailbox, message) {
	for (const endpoint of endpointsFor(mailbox)) deliverTo(endpoint, message);
}

function deliverTo(endpoint, message) {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	const t = Math.floor(Date.now() / 1000);
	const signature = crypto
		.createHmac('sha256', endpoint.secret || '')
		.update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), body]))
		.digest('hex');
	const target = new URL(endpoint.url);
	const request = http.request(
		{
			hostname: target.hostname,
			port: target.port || 80,
			path: target.pathname + target.search,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': body.length,
				'x-mailmint-event': 'message.parsed',
				'x-mailmint-delivery': ulid('dlv'),
				'x-mailmint-signature': `t=${t},v1=${signature}`,
			},
		},
		(res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () =>
				log('webhook.attempt', {
					status: res.statusCode,
					endpoint_id: endpoint.id,
					url: endpoint.url,
					body: Buffer.concat(chunks).toString('utf8').slice(0, 200),
				}),
			);
		},
	);
	request.on('error', (error) => log('webhook.failed', { error: error.message }));
	request.end(body);
}

/** An invoice whose detail is a table, plus a PDF we read the table out of. */
const SAMPLE_LINE_ITEMS = [
	'From: Acme Billing <billing@acme.com>',
	'To: ' + invoices.address,
	'Subject: Invoice INV-2292 from Acme Ltd',
	'Date: Mon, 25 Aug 2026 10:02:00 +0000',
	'Message-ID: <CAF9912@mail.acme.com>',
	'Content-Type: text/html; charset=utf-8',
	'',
	'<html><body>',
	'<p>Invoice: INV-2292<br>Total: $132.00<br>Due: 2026-09-15</p>',
	'<table>',
	'<tr><th>Item</th><th>Qty</th><th>Amount</th></tr>',
	'<tr><td>Widget</td><td>3</td><td>$27.00</td></tr>',
	'<tr><td>Gadget</td><td>1</td><td>$55.00</td></tr>',
	'<tr><td>Support</td><td>2</td><td>$50.00</td></tr>',
	'</table>',
	'</body></html>',
].join('\r\n');

deliver(invoices, SAMPLE_RAW);

const withTable = deliver(invoices, SAMPLE_LINE_ITEMS);
withTable.attachments = [
	{
		id: ulid('att'),
		filename: 'invoice-2292.pdf',
		content_type: 'application/pdf',
		size: 48213,
		sha256: crypto.createHash('sha256').update('invoice-2292.pdf').digest('hex'),
		inline: false,
		content_id: null,
		url: `http://localhost:${PORT}/v1/attachments/att_demo`,
		extracted: {
			kind: 'pdf',
			pages: 1,
			text: 'ACME LTD\nInvoice INV-2292\nWidget 3 27.00\nGadget 1 55.00\nSupport 2 50.00\nTotal 132.00',
			meta: { producer: 'Acme Billing 4.1' },
			tables: [
				{
					source: 'pdf',
					index: 0,
					headers: ['Item', 'Qty', 'Amount'],
					rows: [['Widget', '3', '27.00'], ['Gadget', '1', '55.00'], ['Support', '2', '50.00']],
					row_count: 3,
					truncated: false,
					records: [
						{ Item: 'Widget', Qty: '3', Amount: '27.00' },
						{ Item: 'Gadget', Qty: '1', Amount: '55.00' },
						{ Item: 'Support', Qty: '2', Amount: '50.00' },
					],
				},
			],
		},
	},
];

/** One message the parser is not sure about, so the review branch has traffic. */
const SAMPLE_DOUBTFUL = [
	'From: Someone <ops@vendor.example>',
	'To: ' + invoices.address,
	'Subject: your order',
	'Date: Mon, 25 Aug 2026 11:00:00 +0000',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Hi, the shipment went out today. Thanks!',
].join('\r\n');

deliver(invoices, SAMPLE_DOUBTFUL);

/* -------------------------------------------------------------------- server */

function log(event, extra) {
	process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event, ...extra }) + '\n');
}

function send(res, status, payload, headers) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': body.length,
		...(headers || {}),
	});
	res.end(body);
}

function fail(res, status, code, message, hint) {
	send(res, status, {
		error: { code, message, hint, docs: 'https://mailmint.dev/docs', request_id: ulid('req') },
	});
}

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', () => {
		const url = new URL(req.url, 'http://localhost');
		const path = url.pathname.replace(/\/+$/, '') || '/';
		const query = url.searchParams;
		let body = {};
		if (chunks.length) {
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				return fail(res, 400, 'invalid_json', 'The request body is not valid JSON');
			}
		}
		log('api.request', { method: req.method, path, status: 0 });

		if (path === '/healthz') return send(res, 200, { ok: true });

		const auth = req.headers.authorization || '';
		if (!/^Bearer\s+mm_(live|test)_\w+/.test(auth)) {
			return fail(
				res,
				401,
				auth ? 'invalid_api_key' : 'missing_api_key',
				auth ? 'That API key is not valid' : 'No API key was sent',
				'Paste the key from your MailMint dashboard. It starts with mm_live_.',
			);
		}

		if (path === '/v1/usage' && req.method === 'GET') {
			return send(res, 200, {
				plan: 'starter',
				messages_this_month: state.messages.length,
				messages_included: 5000,
				mailboxes: state.mailboxes.length,
				period_end: '2026-09-01T00:00:00.000Z',
			});
		}

		if (path === '/v1/mailboxes' && req.method === 'GET') {
			return send(res, 200, { data: state.mailboxes, next_cursor: null });
		}
		if (path === '/v1/mailboxes' && req.method === 'POST') {
			if (!body.name) return fail(res, 400, 'invalid_request', 'A mailbox needs a name');
			const mailbox = seedMailbox(body.name, body.schema || []);
			if (body.webhook_url) mailbox.webhook_url = body.webhook_url;
			return send(res, 201, mailbox);
		}

		const mailboxMatch = /^\/v1\/mailboxes\/([^/]+)$/.exec(path);
		if (mailboxMatch) {
			const mailbox = state.mailboxes.find((m) => m.id === mailboxMatch[1]);
			if (!mailbox) return fail(res, 404, 'mailbox_not_found', `No mailbox ${mailboxMatch[1]}`);
			if (req.method === 'GET') return send(res, 200, mailbox);
			if (req.method === 'PATCH') {
				if (body.name !== undefined) mailbox.name = body.name;
				if (body.schema !== undefined) {
					mailbox.schema = body.schema;
					mailbox.schema_version += 1;
				}
				if (body.webhook_url !== undefined) mailbox.webhook_url = body.webhook_url;
				if (body.webhook_secret !== undefined) mailbox.webhook_secret = body.webhook_secret;
				log('mailbox.updated', { id: mailbox.id, webhook_url: mailbox.webhook_url });
				return send(res, 200, mailbox);
			}
			if (req.method === 'DELETE') {
				state.mailboxes = state.mailboxes.filter((m) => m.id !== mailbox.id);
				return send(res, 200, { id: mailbox.id, deleted: true });
			}
		}

		if (path === '/v1/messages' && req.method === 'GET') {
			let rows = state.messages.slice();
			if (query.get('mailbox_id')) rows = rows.filter((m) => m.mailbox.id === query.get('mailbox_id'));
			if (query.get('status') === 'needs_review') rows = rows.filter((m) => m.needs_review);
			if (query.get('since')) {
				const since = new Date(query.get('since')).getTime();
				rows = rows.filter((m) => new Date(m.received_at).getTime() >= since);
			}
			const limit = Math.min(Number(query.get('limit') || 50), 100);
			return send(res, 200, { data: rows.slice(0, limit), next_cursor: null });
		}

		const rawMatch = /^\/v1\/messages\/([^/]+)\/raw$/.exec(path);
		if (rawMatch && req.method === 'GET') {
			const message = state.messages.find((m) => m.id === rawMatch[1]);
			if (!message) return fail(res, 404, 'message_not_found', `No message ${rawMatch[1]}`);
			return send(res, 200, Buffer.from(SAMPLE_RAW, 'utf8'), {
				'Content-Type': 'message/rfc822',
			});
		}

		const reparseMatch = /^\/v1\/messages\/([^/]+)\/reparse$/.exec(path);
		if (reparseMatch && req.method === 'POST') {
			const index = state.messages.findIndex((m) => m.id === reparseMatch[1]);
			if (index < 0) return fail(res, 404, 'message_not_found', `No message ${reparseMatch[1]}`);
			const mailbox = state.mailboxes.find((m) => m.id === state.messages[index].mailbox.id);
			const schema = body.schema || (mailbox ? mailbox.schema : []);
			const rebuilt = buildMessage({ raw_mime: SAMPLE_RAW }, schema, mailbox);
			rebuilt.id = state.messages[index].id;
			state.messages[index] = rebuilt;
			return send(res, 200, rebuilt);
		}

		const hooksMatch = module.exports.disableEndpointApi
			? null
			: /^\/v1\/mailboxes\/([^/]+)\/webhooks$/.exec(path);
		if (hooksMatch) {
			const mailbox = state.mailboxes.find((m) => m.id === hooksMatch[1]);
			if (!mailbox) return fail(res, 404, 'mailbox_not_found', `No mailbox ${hooksMatch[1]}`);
			if (req.method === 'GET') {
				return send(res, 200, {
					data: state.endpoints
						.filter((e) => e.mailbox_id === mailbox.id)
						.map(({ secret, ...rest }) => rest),
				});
			}
			if (req.method === 'POST') {
				if (!body.url) return fail(res, 400, 'missing_url', 'A webhook endpoint needs a "url"');
				const endpoint = {
					id: ulid('wep'),
					mailbox_id: mailbox.id,
					url: body.url,
					description: body.description || null,
					active: true,
					secret: body.secret || crypto.randomBytes(24).toString('hex'),
					created_at: new Date().toISOString(),
				};
				state.endpoints.push(endpoint);
				log('webhook_endpoint.created', { endpoint_id: endpoint.id, mailbox_id: mailbox.id, url: endpoint.url });
				return send(res, 201, { webhook: endpoint });
			}
		}

		const hookMatch = /^\/v1\/webhooks\/([^/]+)$/.exec(path);
		if (hookMatch) {
			const index = state.endpoints.findIndex((e) => e.id === hookMatch[1]);
			if (index < 0) return fail(res, 404, 'webhook_not_found', `No webhook ${hookMatch[1]}`);
			const endpoint = state.endpoints[index];
			if (req.method === 'GET') {
				const { secret, ...rest } = endpoint;
				return send(res, 200, { webhook: rest });
			}
			if (req.method === 'PATCH') {
				Object.assign(endpoint, body);
				const { secret, ...rest } = endpoint;
				return send(res, 200, { webhook: rest });
			}
			if (req.method === 'DELETE') {
				state.endpoints.splice(index, 1);
				log('webhook_endpoint.deleted', { endpoint_id: endpoint.id });
				return send(res, 200, { id: endpoint.id, deleted: true });
			}
		}

		const bulkMatch = /^\/v1\/mailboxes\/([^/]+)\/reparse$/.exec(path);
		if (bulkMatch && req.method === 'POST') {
			const mailbox = state.mailboxes.find((m) => m.id === bulkMatch[1]);
			if (!mailbox) return fail(res, 404, 'mailbox_not_found', `No mailbox ${bulkMatch[1]}`);
			const schema = body.schema || mailbox.schema;
			const targets = state.messages.filter((m) => m.mailbox.id === mailbox.id);
			if (!body.dry_run) {
				for (const message of targets) {
					const rebuilt = buildMessage({ raw_mime: SAMPLE_RAW }, schema, mailbox);
					rebuilt.id = message.id;
					state.messages[state.messages.indexOf(message)] = rebuilt;
					if (body.redeliver && mailbox.webhook_url) postWebhook(mailbox, rebuilt);
				}
			}
			return send(res, 200, {
				mailbox_id: mailbox.id,
				dry_run: Boolean(body.dry_run),
				redeliver: Boolean(body.redeliver),
				messages_matched: targets.length,
				messages_reparsed: body.dry_run ? 0 : targets.length,
			});
		}

		const messageMatch = /^\/v1\/messages\/([^/]+)$/.exec(path);
		if (messageMatch && req.method === 'GET') {
			const message = state.messages.find((m) => m.id === messageMatch[1]);
			if (!message) return fail(res, 404, 'message_not_found', `No message ${messageMatch[1]}`);
			return send(res, 200, message);
		}

		const attachmentMatch = /^\/v1\/attachments\/([^/]+)$/.exec(path);
		if (attachmentMatch && req.method === 'GET') {
			const pdf = Buffer.from(
				'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
				'utf8',
			);
			return send(res, 200, pdf, {
				'Content-Type': 'application/pdf',
				'Content-Disposition': 'attachment; filename="invoice.pdf"',
			});
		}

		if (path === '/v1/parse' && req.method === 'POST') {
			if (!body.raw_mime && !body.subject && !body.text && !body.html) {
				return fail(
					res,
					400,
					'missing_input',
					'Send raw_mime, or at least one of subject, text and html',
					'Set Input to match what the previous node produces.',
				);
			}
			const message = buildMessage(body, body.schema || [], null, query.get('include'));
			return send(res, 200, message);
		}

		if (path === '/v1/events' && req.method === 'GET') {
			const cursor = query.get('cursor') || '';
			const events = state.events.filter((e) => e.cursor > cursor);
			return send(res, 200, {
				events,
				next_cursor: events.length ? events[events.length - 1].cursor : cursor,
			});
		}

		if (path === '/v1/test/deliver' && req.method === 'POST') {
			const mailbox = state.mailboxes.find((m) => m.id === body.mailbox_id) || state.mailboxes[0];
			if (!mailbox) return fail(res, 404, 'mailbox_not_found', 'No mailbox to deliver to');
			const message = deliver(mailbox, body.raw_mime || SAMPLE_RAW);
			return send(res, 202, { id: message.id, mailbox_id: mailbox.id });
		}

		return fail(res, 404, 'not_found', `No route for ${req.method} ${path}`);
	});
});

server.listen(PORT, '0.0.0.0', () => {
	log('server.listening', { port: PORT, mailbox: invoices.address, mailbox_id: invoices.id });
});

/** Flipped by a test to emulate a MailMint that predates webhook endpoints. */
module.exports = { server, state, buildMessage, extract, disableEndpointApi: false };
