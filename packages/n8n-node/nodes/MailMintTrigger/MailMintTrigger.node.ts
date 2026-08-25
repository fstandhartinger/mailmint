import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	getMailboxes,
	mailMintRequest,
	needsReview,
	shapeItems,
	unwrapMessage,
	type OutputShape,
} from '../MailMint/GenericFunctions';

/**
 * One output, or two named ones, resolved from the node's own parameters.
 */
const OUTPUTS_EXPRESSION =
	'={{ $parameter["splitNeedsReview"] ? [{ "type": "main", "displayName": "Parsed" }, { "type": "main", "displayName": "Needs Review" }] : [{ "type": "main" }] }}';

/** How many event pages to walk when seeding the cursor on first activation. */
const MAX_SEED_PAGES = 50;

interface TriggerStaticData {
	cursor?: string;
	webhookUrl?: string;
	webhookSecret?: string;
	mailboxId?: string;
}

export class MailMintTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MailMint Trigger',
		name: 'mailMintTrigger',
		icon: { light: 'file:mailmint.svg', dark: 'file:mailmint.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{ $parameter["deliveryMode"] === "webhook" ? "webhook" : "polling" }}',
		description: 'Starts the workflow when MailMint has parsed a new email',
		defaults: { name: 'MailMint Trigger' },
		inputs: [],
		outputs: OUTPUTS_EXPRESSION,
		credentials: [{ name: 'mailMintApi', required: true }],
		polling: true,
		// n8n resolves a webhook's `path` as an expression and drops the webhook
		// when it comes back undefined. That is what lets one node hold both
		// modes honestly: in Polling the node declares no webhook at all, so the
		// editor's "Fetch Test Event" runs poll() instead of sitting on a
		// webhook listener that MailMint was never told to call.
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: '={{ $parameter["deliveryMode"] === "poll" ? undefined : "webhook" }}',
			},
		],
		properties: [
			{
				// Not called "Mode": n8n injects its own Poll Times > Mode into
				// every polling node, and two parameters with that label in one
				// panel is a trap for the operator and for anything scripting it.
				displayName: 'Delivery',
				name: 'deliveryMode',
				type: 'options',
				noDataExpression: true,
				default: 'webhook',
				description: 'How this workflow learns about a new message',
				options: [
					{
						name: 'Polling',
						value: 'poll',
						description:
							'Ask MailMint for new events on a schedule. Use this when this n8n cannot be reached from the internet.',
					},
					{
						name: 'Webhook',
						value: 'webhook',
						description:
							'MailMint calls this workflow the moment a message is parsed. Instant, and the node registers and signs the webhook for you.',
					},
				],
			},
			{
				displayName: 'Mailbox Name or ID',
				name: 'mailboxId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getMailboxes' },
				default: '',
				required: true,
				description:
					'The mailbox to receive from. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { deliveryMode: ['webhook'] } },
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description:
					'Whether to return a flat object of the extracted fields plus a _meta object, instead of the full parse result with headers, body, tables and per-field confidence',
			},
			{
				displayName: 'Output',
				name: 'output',
				type: 'options',
				noDataExpression: true,
				default: 'message',
				description: 'How many n8n items one email turns into',
				options: [
					{
						name: 'One Item Per Line Item',
						value: 'lineItems',
						description:
							'Fan the rows out: one item per invoice line, order line or table row, with the header fields repeated on each. Every row carries _row_count, so a table that came back short is visible instead of silent.',
					},
					{
						name: 'One Item Per Message',
						value: 'message',
						description: 'One n8n item for the whole email',
					},
				],
			},
			{
				displayName: 'Line Items From',
				name: 'lineItemsSource',
				type: 'string',
				default: '',
				placeholder: 'line_items',
				description:
					'The name of the array field or table to fan out. Leave empty and the node takes the first array field, then the largest table in the body, then the largest table read out of an attachment.',
				displayOptions: { show: { output: ['lineItems'] } },
			},
			{
				displayName: 'Route Messages Needing Review Separately',
				name: 'splitNeedsReview',
				type: 'boolean',
				default: false,
				description:
					'Whether to add a second output for messages the parser is not confident about, so a human can look at them without an IF node',
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				options: [
					{
						displayName: 'From Sender',
						name: 'fromSender',
						type: 'string',
						default: '',
						placeholder: 'billing@acme.com',
						description:
							'Only messages whose sender contains this text. Use a full address for one sender, or a domain such as acme.com for all of them.',
					},
					{
						displayName: 'Mailbox Name or ID',
						name: 'mailboxId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getMailboxes' },
						default: '',
						description:
							'Only messages that arrived at this mailbox. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Needs Review Only',
						name: 'needsReviewOnly',
						type: 'boolean',
						default: false,
						description:
							'Whether to trigger only on messages the parser is not confident about — a missing required field, a low confidence value, a type it could not coerce, or evidence it could not find in the mail',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Include Attachment Bytes',
						name: 'includeAttachments',
						type: 'boolean',
						default: false,
						description:
							'Whether to include each attachment base64-encoded. The filenames, sizes and anything the parser read out of a PDF or spreadsheet are always there without this.',
					},
					{
						displayName: 'Include Confidence',
						name: 'includeConfidence',
						type: 'boolean',
						default: false,
						description:
							'Whether to add a _confidence object next to the fields, with the confidence, the source and the verbatim evidence for each one. Only applies when Simplify is on.',
					},
					{
						displayName: 'Signature Tolerance (Seconds)',
						name: 'signatureTolerance',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 300,
						description:
							'How far the timestamp on a signed delivery may be from this machine’s clock before it is rejected as a replay. Set to 0 to accept any age.',
					},
					{
						displayName: 'Webhook Secret',
						name: 'webhookSecret',
						type: 'string',
						typeOptions: { password: true },
						default: '',
						description:
							'Only needed if the mailbox already has a signing secret set outside n8n. Left empty, the node generates one and registers it when the workflow is activated.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: { getMailboxes },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				if ((this.getNodeParameter('deliveryMode', 0) as string) !== 'webhook') return true;

				const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;
				const mailboxId = this.getNodeParameter('mailboxId', 0) as string;
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				if (!staticData.webhookSecret) return false;

				const response = await mailMintRequest.call(
					this,
					'GET',
					`/v1/mailboxes/${encodeURIComponent(mailboxId)}`,
				);
				const mailbox = unwrapMessage(response.body);
				return mailbox.webhook_url === webhookUrl;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				if ((this.getNodeParameter('deliveryMode', 0) as string) !== 'webhook') return true;

				const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;
				const options = this.getNodeParameter('options', 0, {}) as IDataObject;
				const mailboxId = this.getNodeParameter('mailboxId', 0) as string;
				const webhookUrl = this.getNodeWebhookUrl('default') as string;

				// A secret the operator never has to think about. Kept on the node
				// so the same one survives a deactivate/activate cycle.
				const secret =
					(options.webhookSecret as string) ||
					staticData.webhookSecret ||
					randomBytes(32).toString('hex');

				await mailMintRequest.call(this, 'PATCH', `/v1/mailboxes/${encodeURIComponent(mailboxId)}`, {
					body: { webhook_url: webhookUrl, webhook_secret: secret },
				});

				staticData.webhookSecret = secret;
				staticData.webhookUrl = webhookUrl;
				staticData.mailboxId = mailboxId;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				if ((this.getNodeParameter('deliveryMode', 0) as string) !== 'webhook') return true;

				const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;
				const mailboxId = (this.getNodeParameter('mailboxId', 0) as string) || staticData.mailboxId;
				if (mailboxId) {
					await mailMintRequest.call(
						this,
						'PATCH',
						`/v1/mailboxes/${encodeURIComponent(mailboxId)}`,
						{ body: { webhook_url: null } },
					);
				}
				delete staticData.webhookUrl;
				delete staticData.mailboxId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const response = this.getResponseObject();
		const headers = this.getHeaderData() as Record<string, string>;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;

		const secret = (options.webhookSecret as string) || staticData.webhookSecret || '';
		const rawBody = rawBodyOf(request);
		const verdict = verifySignature(
			headers['x-mailmint-signature'],
			rawBody,
			secret,
			Number(options.signatureTolerance ?? 300),
		);

		if (verdict !== 'ok') {
			// A body we cannot authenticate is not our event. Say so and stop —
			// never start a workflow on it.
			response.status(401).json({ error: `mailmint signature ${verdict}` });
			return { noWebhookResponse: true };
		}

		const message = unwrapMessage(this.getBodyData() as IDataObject);
		const filters = this.getNodeParameter('filters', {}) as IDataObject;
		if (!passesFilters(message, filters)) {
			return { webhookResponse: { ok: true, skipped: 'filtered' } };
		}

		const shape = outputShape.call(this);
		const emitted = shapeItems(message, shape, 0);
		const split = this.getNodeParameter('splitNeedsReview', false) as boolean;
		const workflowData = split
			? needsReview(message)
				? [[], emitted]
				: [emitted, []]
			: [emitted];

		return {
			workflowData,
			webhookResponse: { ok: true, delivery: headers['x-mailmint-delivery'] ?? null },
		};
	}

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		if ((this.getNodeParameter('deliveryMode', 0) as string) !== 'poll') return null;

		const manual = this.getMode() === 'manual';
		const filters = this.getNodeParameter('filters', {}) as IDataObject;
		const shape = outputShape.call(this);
		const split = this.getNodeParameter('splitNeedsReview', false) as boolean;

		const wrap = (rows: IDataObject[]): INodeExecutionData[][] => {
			const parsed: INodeExecutionData[] = [];
			const review: INodeExecutionData[] = [];
			rows.forEach((message, index) => {
				const emitted = shapeItems(message, shape, index);
				(split && needsReview(message) ? review : parsed).push(...emitted);
			});
			return split ? [parsed, review] : [parsed];
		};

		// "Fetch Test Event" in the editor. Show the operator a real message from
		// their account rather than an invented one, and leave the cursor alone so
		// the live workflow does not skip anything.
		if (manual) {
			const qs: IDataObject = { limit: 1 };
			if (filters.mailboxId) qs.mailbox_id = filters.mailboxId;
			if (filters.needsReviewOnly) qs.status = 'needs_review';
			if (shape.includeAttachments) qs.include = 'attachments';

			const listed = await mailMintRequest.call(this, 'GET', '/v1/messages', { qs });
			const payload = listed.body as IDataObject;
			const rows = (Array.isArray(payload) ? payload : (payload?.data ?? [])) as IDataObject[];
			const matching = rows.filter((message) => passesFilters(message, filters));
			if (!matching.length) {
				throw new NodeOperationError(
					this.getNode(),
					'No message matching these filters has arrived yet',
					{
						description:
							'Send a mail to the mailbox address, or relax the filters, then press Fetch Test Event again.',
					},
				);
			}
			return wrap(matching);
		}

		const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;

		// First activation: remember where the feed is now and emit nothing, so
		// activating a workflow never floods it with a week of old mail.
		if (staticData.cursor === undefined) {
			staticData.cursor = await seedCursor.call(this);
			return null;
		}

		const collected: IDataObject[] = [];
		let cursor = staticData.cursor;
		for (let page = 0; page < MAX_SEED_PAGES; page++) {
			const feed = await fetchEvents.call(this, cursor);
			if (!feed.events.length) {
				if (feed.nextCursor) cursor = feed.nextCursor;
				break;
			}
			for (const event of feed.events) {
				const message = unwrapMessage((event.message ?? {}) as IDataObject);
				if (Object.keys(message).length && passesFilters(message, filters)) collected.push(message);
			}
			cursor = feed.nextCursor ?? cursor;
			if (!feed.nextCursor) break;
		}

		staticData.cursor = cursor;
		return collected.length ? wrap(collected) : null;
	}
}

/* ------------------------------------------------------------------- helpers */

function outputShape(this: IPollFunctions | IWebhookFunctions): OutputShape {
	const options = this.getNodeParameter('options', {}) as IDataObject;
	return {
		simplify: this.getNodeParameter('simplify', true) as boolean,
		output: this.getNodeParameter('output', 'message') as 'message' | 'lineItems',
		lineItemsSource: this.getNodeParameter('lineItemsSource', '') as string,
		includeAttachments: Boolean(options.includeAttachments),
		includeConfidence: Boolean(options.includeConfidence),
	};
}

interface EventPage {
	events: IDataObject[];
	nextCursor?: string;
}

async function fetchEvents(this: IPollFunctions, cursor?: string): Promise<EventPage> {
	const qs: IDataObject = {};
	if (cursor) qs.cursor = cursor;
	const response = await mailMintRequest.call(this, 'GET', '/v1/events', { qs });
	const payload = (response.body ?? {}) as IDataObject;
	return {
		events: (payload.events ?? []) as IDataObject[],
		nextCursor: (payload.next_cursor as string) || undefined,
	};
}

/** Walk the feed to its head without emitting anything. */
async function seedCursor(this: IPollFunctions): Promise<string> {
	let cursor: string | undefined;
	for (let page = 0; page < MAX_SEED_PAGES; page++) {
		const feed = await fetchEvents.call(this, cursor);
		if (feed.nextCursor) cursor = feed.nextCursor;
		if (!feed.events.length || !feed.nextCursor) break;
	}
	return cursor ?? '';
}

export function passesFilters(message: IDataObject, filters: IDataObject): boolean {
	const headers = (message.headers ?? {}) as IDataObject;
	const envelope = (message.envelope ?? {}) as IDataObject;
	const mailbox = (message.mailbox ?? {}) as IDataObject;
	const meta = (message._meta ?? {}) as IDataObject;
	const flags = (message.flags ?? meta.flags ?? []) as string[];

	if (filters.mailboxId) {
		const id = mailbox.id ?? meta.mailbox_id;
		if (id !== undefined && id !== filters.mailboxId) return false;
	}

	if (filters.needsReviewOnly) {
		const needsReview =
			typeof message.needs_review === 'boolean'
				? message.needs_review
				: typeof meta.needs_review === 'boolean'
					? meta.needs_review
					: flags.some((flag) =>
							/^(low_confidence|missing_required|type_error|hallucinated_evidence):/.test(flag),
						);
		if (!needsReview) return false;
	}

	const wanted = String(filters.fromSender ?? '').trim().toLowerCase();
	if (wanted) {
		const from = (headers.from ?? {}) as IDataObject;
		const candidates = [from.email, envelope.from, meta.from_email]
			.filter((value): value is string => typeof value === 'string')
			.map((value) => value.toLowerCase());
		if (!candidates.some((value) => value.includes(wanted))) return false;
	}

	return true;
}

/**
 * n8n's webhook middleware keeps the untouched bytes on the request, which is
 * the only thing an HMAC can legitimately be checked against — re-serialising
 * the parsed body would change the whitespace and break every signature.
 */
function rawBodyOf(request: { rawBody?: unknown; body?: unknown }): Buffer | undefined {
	if (Buffer.isBuffer(request.rawBody)) return request.rawBody;
	if (typeof request.rawBody === 'string') return Buffer.from(request.rawBody, 'utf8');
	if (Buffer.isBuffer(request.body)) return request.body;
	return undefined;
}

export type SignatureVerdict = 'ok' | 'missing' | 'malformed' | 'no secret' | 'stale' | 'mismatch';

/**
 * `x-mailmint-signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`
 */
export function verifySignature(
	header: string | undefined,
	rawBody: Buffer | undefined,
	secret: string,
	toleranceSeconds: number,
): SignatureVerdict {
	if (!header) return 'missing';
	if (!secret) return 'no secret';
	if (rawBody === undefined) return 'malformed';

	let timestamp = '';
	let signature = '';
	for (const part of header.split(',')) {
		const [key, ...rest] = part.trim().split('=');
		const value = rest.join('=');
		if (key === 't') timestamp = value;
		if (key === 'v1') signature = value;
	}
	if (!timestamp || !signature) return 'malformed';

	const sent = Number(timestamp);
	if (!Number.isFinite(sent)) return 'malformed';
	if (toleranceSeconds > 0) {
		const age = Math.abs(Date.now() / 1000 - sent);
		if (age > toleranceSeconds) return 'stale';
	}

	const expected = createHmac('sha256', secret)
		.update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]))
		.digest('hex');

	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(signature, 'utf8');
	if (a.length !== b.length) return 'mismatch';
	return timingSafeEqual(a, b) ? 'ok' : 'mismatch';
}
