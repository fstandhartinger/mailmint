import type {
	IBinaryData,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	buildSchema,
	errorItemJson,
	getMailboxes,
	mailMintRequest,
	mailMintRequestAll,
	needsReview,
	parseJsonParameter,
	rethrow,
	shapeItems,
	unwrapMessage,
	type OutputShape,
} from './GenericFunctions';
import { mailboxFields, mailboxOperations } from './descriptions/MailboxDescription';
import { messageFields, messageOperations } from './descriptions/MessageDescription';
import { OUTPUTS_EXPRESSION, outputFields } from './descriptions/OutputDescription';
import {
	AUTO_HTML_KEYS,
	AUTO_RAW_KEYS,
	AUTO_SUBJECT_KEYS,
	AUTO_TEXT_KEYS,
	parseFields,
} from './descriptions/ParseDescription';

export class MailMint implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MailMint',
		name: 'mailMint',
		icon: { light: 'file:mailmint.svg', dark: 'file:mailmint.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Turn an email into structured JSON, with the fields defined here in n8n',
		defaults: { name: 'MailMint' },
		inputs: [NodeConnectionTypes.Main],
		outputs: OUTPUTS_EXPRESSION,
		usableAsTool: true,
		credentials: [{ name: 'mailMintApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'parse',
				options: [
					{
						name: 'Mailbox',
						value: 'mailbox',
						description: 'Manage the inbound addresses on your account and the schema each one uses',
					},
					{
						name: 'Message',
						value: 'message',
						description: 'Read the messages MailMint has already received and parsed',
					},
					{
						name: 'Parse',
						value: 'parse',
						description: 'Parse an email this workflow already has, without storing anything',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'parse',
				displayOptions: { show: { resource: ['parse'] } },
				options: [
					{
						name: 'Parse Email',
						value: 'parse',
						description:
							'Extract your fields from an email the workflow already has — from the Email Trigger (IMAP), from Gmail, or from raw text. Nothing is stored.',
						action: 'Parse an email',
					},
				],
			},
			messageOperations,
			mailboxOperations,
			...parseFields,
			...messageFields,
			...mailboxFields,
			...outputFields,
		],
	};

	methods = {
		loadOptions: { getMailboxes },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const split =
			SPLITTABLE.includes(operation) &&
			(this.getNodeParameter('splitNeedsReview', 0, false) as boolean);

		const parsed: INodeExecutionData[] = [];
		const review: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const produced = await runOne.call(this, resource, operation, i);
				for (const item of produced) {
					// A fan-out of line items follows its message down whichever
					// branch that message belongs on — rows never get separated.
					if (split && item.json.__needsReview === true) {
						delete item.json.__needsReview;
						review.push(item);
					} else {
						delete item.json.__needsReview;
						parsed.push(item);
					}
				}
			} catch (error) {
				if (this.continueOnFail()) {
					parsed.push({ json: errorItemJson(error), pairedItem: { item: i } });
					continue;
				}
				throw rethrow(this, error, i);
			}
		}

		return split ? [parsed, review] : [parsed];
	}
}

const SPLITTABLE = ['parse', 'get', 'getAll', 'reparse'];

async function runOne(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	if (resource === 'parse' && operation === 'parse') return await parseEmail.call(this, i);

	if (resource === 'message') {
		if (operation === 'get') return await getMessage.call(this, i);
		if (operation === 'getAll') return await getMessages.call(this, i);
		if (operation === 'getRaw') return await getRawMessage.call(this, i);
		if (operation === 'downloadAttachment') return await downloadAttachment.call(this, i);
		if (operation === 'reparse') return await reparseMessage.call(this, i);
	}

	if (resource === 'mailbox') {
		if (operation === 'create') return await createMailbox.call(this, i);
		if (operation === 'reparseAll') return await reparseMailbox.call(this, i);
		if (operation === 'getAll') return await getMailboxList.call(this, i);
		if (operation === 'update') return await updateMailbox.call(this, i);
		if (operation === 'delete') return await deleteMailbox.call(this, i);
	}

	throw new NodeOperationError(this.getNode(), `Unknown operation "${resource}: ${operation}"`, {
		itemIndex: i,
	});
}

/* ------------------------------------------------------------------- output */

function outputOptions(this: IExecuteFunctions, i: number): OutputShape {
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	return {
		simplify: this.getNodeParameter('simplify', i, true) as boolean,
		output: this.getNodeParameter('output', i, 'message') as 'message' | 'lineItems',
		lineItemsSource: this.getNodeParameter('lineItemsSource', i, '') as string,
		includeAttachments: Boolean(options.includeAttachments),
		includeConfidence: Boolean(options.includeConfidence),
	};
}

/**
 * `__needsReview` is a routing marker, stripped again in execute before the
 * item leaves the node, so the branch decision is made once per message even
 * when that message became forty line items.
 */
function messageItems(
	message: IDataObject,
	shape: OutputShape,
	i: number,
): INodeExecutionData[] {
	const review = needsReview(message);
	return shapeItems(message, shape, i).map((item) => ({
		...item,
		json: { ...item.json, __needsReview: review },
	}));
}

/* -------------------------------------------------------------------- schema */

async function resolveSchema(
	this: IExecuteFunctions,
	i: number,
): Promise<IDataObject[] | undefined> {
	const source = this.getNodeParameter('schemaSource', i, 'fields') as string;

	if (source === 'none') return undefined;

	if (source === 'fields') {
		const collection = this.getNodeParameter('schemaFields', i, {}) as IDataObject;
		return buildSchema(this, collection, i);
	}

	if (source === 'json') {
		const parsed = parseJsonParameter(this, this.getNodeParameter('schemaJson', i, ''), 'Schema JSON', i);
		if (parsed === undefined) return undefined;
		if (!Array.isArray(parsed)) {
			throw new NodeOperationError(this.getNode(), 'Schema JSON must be an array of fields', {
				itemIndex: i,
				description: 'For example [{"name":"total","type":"number","description":"grand total"}].',
			});
		}
		return parsed;
	}

	// From a mailbox: read the schema the account already has saved there.
	const mailboxId = this.getNodeParameter('schemaMailboxId', i, '') as string;
	if (!mailboxId) {
		throw new NodeOperationError(this.getNode(), 'No mailbox chosen for the schema', {
			itemIndex: i,
			description: 'Pick one in Schema Mailbox, or switch Schema to Define Fields.',
		});
	}
	const response = await mailMintRequest.call(this, 'GET', `/v1/mailboxes/${encodeURIComponent(mailboxId)}`);
	const mailbox = unwrapMessage(response.body);
	const schema = mailbox.schema as IDataObject[] | undefined;
	return Array.isArray(schema) && schema.length ? schema : undefined;
}

/* --------------------------------------------------------------------- parse */

function firstString(json: IDataObject, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = json[key];
		if (typeof value === 'string' && value.trim() !== '') return value;
	}
	return undefined;
}

/** Does this binary field look like a whole email rather than an attachment? */
function looksLikeEmail(binary: IBinaryData | undefined): boolean {
	if (!binary) return false;
	const mime = (binary.mimeType ?? '').toLowerCase();
	if (mime === 'message/rfc822' || mime === 'application/mbox') return true;
	const name = `${binary.fileName ?? ''}.${binary.fileExtension ?? ''}`.toLowerCase();
	return /\.(eml|mime|msg)\b/.test(name);
}

/**
 * The Email Trigger (IMAP) node is the obvious thing to put in front of this
 * one, and it has three output formats. RAW puts the whole message in the
 * binary field `data`; Resolved and Simple put textPlain / textHtml / subject
 * on the JSON and any real attachments in their own binary fields. Automatic
 * covers all three without the operator choosing anything — and it refuses to
 * mistake an attached PDF for the message itself.
 */
async function collectEmailInput(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const source = this.getNodeParameter('inputSource', i, 'auto') as string;
	const item = this.getInputData()[i];
	const body: IDataObject = {};

	if (source === 'rawMime') {
		body.raw_mime = this.getNodeParameter('rawMime', i) as string;
		return body;
	}

	if (source === 'fields') {
		const subject = this.getNodeParameter('subject', i, '') as string;
		const text = this.getNodeParameter('text', i, '') as string;
		const html = this.getNodeParameter('html', i, '') as string;
		if (!subject && !text && !html) {
			throw new NodeOperationError(this.getNode(), 'Nothing to parse on this item', {
				itemIndex: i,
				description: 'Fill in at least one of Subject, Text or HTML, or set Input back to Automatic.',
			});
		}
		if (subject) body.subject = subject;
		if (text) body.text = text;
		if (html) body.html = html;
		return body;
	}

	if (source === 'binary') {
		const property = this.getNodeParameter('binaryPropertyName', i) as string;
		if (!item.binary?.[property]) {
			throw new NodeOperationError(
				this.getNode(),
				`This item has no binary field called "${property}"`,
				{
					itemIndex: i,
					description: `Binary fields on this item: ${Object.keys(item.binary ?? {}).join(', ') || 'none'}. The Email Trigger (IMAP) node puts the raw message in "data" when its Format is RAW.`,
				},
			);
		}
		const buffer = await this.helpers.getBinaryDataBuffer(i, property);
		body.raw_mime = buffer.toString('utf8');
		return body;
	}

	// Automatic.
	const binaryNames = Object.keys(item.binary ?? {});
	const emailProperty =
		binaryNames.find((name) => name === 'data' && looksLikeEmail(item.binary?.[name])) ??
		binaryNames.find((name) => looksLikeEmail(item.binary?.[name])) ??
		(binaryNames.includes('data') && binaryNames.length === 1 ? 'data' : undefined);

	if (emailProperty) {
		const buffer = await this.helpers.getBinaryDataBuffer(i, emailProperty);
		body.raw_mime = buffer.toString('utf8');
		return body;
	}

	const json = item.json ?? {};
	const raw = firstString(json, AUTO_RAW_KEYS);
	if (raw && /^[\w-]+:\s/m.test(raw)) {
		body.raw_mime = raw;
		return body;
	}

	const subject = firstString(json, AUTO_SUBJECT_KEYS);
	const text = firstString(json, AUTO_TEXT_KEYS);
	const html = firstString(json, AUTO_HTML_KEYS);
	if (!subject && !text && !html) {
		throw new NodeOperationError(this.getNode(), 'Could not find an email on this item', {
			itemIndex: i,
			description:
				'Automatic looks for a binary .eml field, then for subject / textPlain / textHtml on the JSON. This item has neither — set Input to Fields and map them yourself.',
		});
	}
	if (subject) body.subject = subject;
	if (text) body.text = text;
	if (html) body.html = html;
	return body;
}

async function parseEmail(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const shape = outputOptions.call(this, i);
	const body = await collectEmailInput.call(this, i);
	const schema = await resolveSchema.call(this, i);
	if (schema) body.schema = schema;

	const qs: IDataObject = {};
	if (shape.includeAttachments) qs.include = 'attachments';

	const response = await mailMintRequest.call(this, 'POST', '/v1/parse', { body, qs });
	return messageItems(unwrapMessage(response.body), shape, i);
}

/* ------------------------------------------------------------------ messages */

async function getMessage(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const shape = outputOptions.call(this, i);
	const messageId = this.getNodeParameter('messageId', i) as string;
	const qs: IDataObject = {};
	if (shape.includeAttachments) qs.include = 'attachments';

	const response = await mailMintRequest.call(
		this,
		'GET',
		`/v1/messages/${encodeURIComponent(messageId)}`,
		{ qs },
	);
	return messageItems(unwrapMessage(response.body), shape, i);
}

async function getMessages(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const shape = outputOptions.call(this, i);
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;

	const qs: IDataObject = {};
	if (filters.mailboxId) qs.mailbox_id = filters.mailboxId;
	if (filters.since) qs.since = new Date(filters.since as string).toISOString();
	if (filters.needsReviewOnly) qs.status = 'needs_review';
	if (shape.includeAttachments) qs.include = 'attachments';

	const limit = returnAll ? undefined : (this.getNodeParameter('limit', i, 50) as number);
	const rows = await mailMintRequestAll.call(this, '/v1/messages', qs, limit);
	return rows.flatMap((message) => messageItems(message, shape, i));
}

async function reparseMessage(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const shape = outputOptions.call(this, i);
	const messageId = this.getNodeParameter('messageId', i) as string;
	const schema = await resolveSchema.call(this, i);
	const body: IDataObject = {};
	if (schema) body.schema = schema;

	const response = await mailMintRequest.call(
		this,
		'POST',
		`/v1/messages/${encodeURIComponent(messageId)}/reparse`,
		{ body },
	);
	return messageItems(unwrapMessage(response.body), shape, i);
}

async function getRawMessage(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const messageId = this.getNodeParameter('messageId', i) as string;
	const property = this.getNodeParameter('binaryPropertyName', i, 'data') as string;

	const response = await mailMintRequest.call(
		this,
		'GET',
		`/v1/messages/${encodeURIComponent(messageId)}/raw`,
		{ binary: true },
	);
	const buffer = Buffer.from(response.body as Buffer);
	const fileName = `${messageId}.eml`;
	const binary: IBinaryData = await this.helpers.prepareBinaryData(
		buffer,
		fileName,
		'message/rfc822',
	);

	return [
		{
			json: { id: messageId, fileName, mimeType: 'message/rfc822', size: buffer.length },
			binary: { [property]: binary },
			pairedItem: { item: i },
		},
	];
}

function fileNameFromHeaders(headers: Record<string, string>, fallback: string): string {
	const disposition = headers['content-disposition'] ?? '';
	const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
	if (utf8) {
		try {
			return decodeURIComponent(utf8[1]);
		} catch {
			// A malformed value is not worth failing the item over.
		}
	}
	const plain = /filename="?([^";]+)"?/i.exec(disposition);
	return plain ? plain[1] : fallback;
}

async function downloadAttachment(
	this: IExecuteFunctions,
	i: number,
): Promise<INodeExecutionData[]> {
	const attachmentId = this.getNodeParameter('attachmentId', i) as string;
	const property = this.getNodeParameter('binaryPropertyName', i, 'data') as string;

	const response = await mailMintRequest.call(
		this,
		'GET',
		`/v1/attachments/${encodeURIComponent(attachmentId)}`,
		{ binary: true },
	);
	const buffer = Buffer.from(response.body as Buffer);
	const headers = response.headers ?? {};
	const mimeType = (headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
	const fileName = fileNameFromHeaders(headers, attachmentId);

	const binary: IBinaryData = await this.helpers.prepareBinaryData(buffer, fileName, mimeType);
	return [
		{
			json: { id: attachmentId, fileName, mimeType, size: buffer.length },
			binary: { [property]: binary },
			pairedItem: { item: i },
		},
	];
}

/* ----------------------------------------------------------------- mailboxes */

async function createMailbox(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const options = this.getNodeParameter('mailboxOptions', i, {}) as IDataObject;
	const body: IDataObject = { name: this.getNodeParameter('mailboxName', i) as string };

	const schema = await resolveSchema.call(this, i);
	if (schema) body.schema = schema;
	if (options.webhookUrl) body.webhook_url = options.webhookUrl;

	const response = await mailMintRequest.call(this, 'POST', '/v1/mailboxes', { body });
	return [{ json: unwrapMessage(response.body), pairedItem: { item: i } }];
}

async function getMailboxList(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const returnAll = this.getNodeParameter('returnAll', i, true) as boolean;
	const limit = returnAll ? undefined : (this.getNodeParameter('limit', i, 50) as number);
	const rows = await mailMintRequestAll.call(this, '/v1/mailboxes', {}, limit);
	return rows.map((mailbox) => ({ json: mailbox, pairedItem: { item: i } }));
}

async function updateMailbox(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const mailboxId = this.getNodeParameter('mailboxId', i) as string;
	const updateFields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
	const updateSchema = this.getNodeParameter('updateSchema', i, false) as boolean;

	const body: IDataObject = {};
	if (updateFields.name) body.name = updateFields.name;
	if (updateFields.webhookUrl !== undefined && updateFields.webhookUrl !== '') {
		body.webhook_url = updateFields.webhookUrl;
	}
	if (updateFields.webhookSecret) body.webhook_secret = updateFields.webhookSecret;
	if (updateSchema) {
		const schema = await resolveSchema.call(this, i);
		body.schema = schema ?? [];
	}

	if (!Object.keys(body).length) {
		throw new NodeOperationError(this.getNode(), 'Nothing to update', {
			itemIndex: i,
			description: 'Add at least one entry under Update Fields, or turn on Update Schema.',
		});
	}

	const response = await mailMintRequest.call(
		this,
		'PATCH',
		`/v1/mailboxes/${encodeURIComponent(mailboxId)}`,
		{ body },
	);
	return [{ json: unwrapMessage(response.body), pairedItem: { item: i } }];
}

/**
 * Re-running an old mailbox against a schema you have just fixed is the thing
 * Zapier answers with "there is no way to replay them" and Mailparser caps at
 * the last 300 messages. Dry Run answers "what would change" without touching
 * anything, and re-delivery is a separate decision from re-parsing so nobody
 * accidentally fires a month of webhooks at their own workflow.
 */
async function reparseMailbox(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const mailboxId = this.getNodeParameter('mailboxId', i) as string;
	const body: IDataObject = {
		dry_run: this.getNodeParameter('dryRun', i, false) as boolean,
		redeliver: this.getNodeParameter('redeliver', i, false) as boolean,
	};
	if (this.getNodeParameter('reparseSchema', i, false) as boolean) {
		const schema = await resolveSchema.call(this, i);
		if (schema) body.schema = schema;
	}

	const response = await mailMintRequest.call(
		this,
		'POST',
		`/v1/mailboxes/${encodeURIComponent(mailboxId)}/reparse`,
		{ body },
	);
	return [{ json: unwrapMessage(response.body), pairedItem: { item: i } }];
}

async function deleteMailbox(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const mailboxId = this.getNodeParameter('mailboxId', i) as string;
	const response = await mailMintRequest.call(
		this,
		'DELETE',
		`/v1/mailboxes/${encodeURIComponent(mailboxId)}`,
	);
	const payload = response.body as IDataObject;
	const json = payload && typeof payload === 'object' && Object.keys(payload).length
		? unwrapMessage(payload)
		: { id: mailboxId, deleted: true };
	return [{ json, pairedItem: { item: i } }];
}
