import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	IPollFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export const CREDENTIAL_NAME = 'mailMintApi';



export type MailMintContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IPollFunctions
	| IHookFunctions
	| IWebhookFunctions;

export interface MailMintResponse {
	body: Buffer | IDataObject;
	headers: Record<string, string>;
	statusCode: number;
}

export async function mailMintBaseUrl(context: MailMintContext): Promise<string> {
	const credentials = await context.getCredentials(CREDENTIAL_NAME);
	const raw = ((credentials?.baseUrl as string) ?? '').trim();
	if (!raw) {
		throw new NodeOperationError(context.getNode(), 'No MailMint API URL is set', {
			description:
				'Open the MailMint credential and fill in Base URL — the root URL of the MailMint API you are talking to.',
		});
	}
	return raw.replace(/\/+$/, '');
}

/**
 * The API's hints are client-neutral because curl users read them too. These add
 * the n8n-shaped half — what to click, which field to change — for the failures
 * an n8n operator actually hits.
 */
const N8N_ADVICE: Record<string, string> = {
	missing_api_key: 'Open the node and pick a MailMint credential in the Credential dropdown.',
	invalid_api_key: 'Open the credential in n8n and paste the key from your MailMint dashboard again.',
	quota_exceeded: 'Add a Wait node to spread the work out, or upgrade the plan.',
	rate_limited:
		'Turn on Settings > Retry On Fail, or put a Loop Over Items node in front with a batch interval.',
	mailbox_not_found: 'Reopen the Mailbox dropdown to reload the list from your account.',
	message_not_found: 'Messages are kept for 30 days. Check the Message ID.',
	attachment_not_found: 'Attachments are kept for 7 days after the message arrives.',
	invalid_schema:
		'Check Schema > Fields: every field needs a Name, an enum needs Options, an array needs an Item Type.',
	missing_input: 'Set Input to match what the previous node produces, or switch it back to Automatic.',
	invalid_mime: 'The raw message could not be parsed as MIME. Check the binary field really holds an .eml.',
	llm_unavailable: 'The extraction model was unreachable. Turn on Settings > Retry On Fail.',
};

function bufferFrom(value: unknown): Buffer | undefined {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
	// A Buffer that has been through JSON, as it is once n8n saves an execution.
	const serialised = value as { type?: string; data?: unknown };
	if (serialised?.type === 'Buffer' && Array.isArray(serialised.data)) {
		return Buffer.from(serialised.data as number[]);
	}
	return undefined;
}

interface DecodedBody {
	json?: IDataObject;
	text?: string;
}

function decodeBody(value: unknown): DecodedBody | undefined {
	if (value === undefined || value === null || value === '') return undefined;

	const buffer = bufferFrom(value);
	const text = buffer ? buffer.toString('utf8') : typeof value === 'string' ? value : undefined;

	if (text !== undefined) {
		try {
			const parsed = JSON.parse(text) as unknown;
			if (parsed && typeof parsed === 'object') return { json: parsed as IDataObject, text };
		} catch {
			// Not JSON — a proxy's HTML page, say. The text is still readable.
		}
		return { text };
	}
	if (typeof value === 'object') return { json: value as IDataObject };
	return undefined;
}

/** Every place an error body can hide, from the outermost wrapper inwards. */
function errorBody(error: unknown): DecodedBody | undefined {
	const err = (error ?? {}) as JsonObject & {
		cause?: JsonObject & { response?: JsonObject };
		context?: JsonObject;
		errorResponse?: JsonObject;
	};
	const response = (err.response ?? {}) as JsonObject;
	const causeResponse = (err.cause?.response ?? {}) as JsonObject;
	const candidates = [
		response.body,
		response.data,
		err.body,
		causeResponse.body,
		causeResponse.data,
		err.context?.data,
		err.errorResponse,
	];

	let fallback: DecodedBody | undefined;
	for (const candidate of candidates) {
		const decoded = decodeBody(candidate);
		if (decoded?.json?.error) return decoded;
		if (decoded && !fallback) fallback = decoded;
	}
	return fallback;
}

function statusCodeOf(error: unknown): string {
	const err = (error ?? {}) as JsonObject & {
		httpCode?: string;
		cause?: JsonObject & { response?: JsonObject };
	};
	const response = (err.response ?? {}) as JsonObject;
	const causeResponse = (err.cause?.response ?? {}) as JsonObject;
	const code =
		err.httpCode ?? response.status ?? response.statusCode ?? causeResponse.status ?? err.statusCode;
	return code === undefined || code === null ? '' : String(code);
}

const API_ERROR_PROPERTY = 'mailMintApiError';

function compactApiError(apiError: IDataObject, httpCode: string): IDataObject {
	const info: IDataObject = { message: String(apiError.message) };
	if (apiError.code) info.code = String(apiError.code);
	if (apiError.hint) info.hint = String(apiError.hint);
	if (apiError.docs) info.docs = String(apiError.docs);
	if (apiError.request_id) info.request_id = String(apiError.request_id);
	if (apiError.details !== undefined) info.details = apiError.details;
	if (httpCode) info.httpCode = httpCode;
	return info;
}

function mailMintApiError(error: unknown): IDataObject | undefined {
	const attached = (error as { [API_ERROR_PROPERTY]?: IDataObject })?.[API_ERROR_PROPERTY];
	if (attached) return attached;

	const apiError = errorBody(error)?.json?.error as IDataObject | undefined;
	if (!apiError?.message) return undefined;
	return compactApiError(apiError, statusCodeOf(error));
}

/**
 * The item Continue On Fail emits. `error` is an object so a workflow can test
 * `$json.error.code` in an IF node; `errorMessage` keeps the plain sentence.
 */
export function errorItemJson(error: unknown): IDataObject {
	const info = mailMintApiError(error);
	const thrown = (error ?? {}) as { message?: string; description?: string };
	const message = String(info?.message ?? thrown.message ?? 'Unknown error');
	const details: IDataObject = { ...(info ?? {}), message };
	if (!info && thrown.description) details.hint = thrown.description;

	const json: IDataObject = { error: details, errorMessage: message };
	if (thrown.description) json.errorDescription = thrown.description;
	return json;
}

/**
 * NodeApiError hands back its second argument untouched when that argument is
 * already a NodeApiError, so the only honest way to add the item index to an
 * error the node already built is to annotate it in place.
 */
export function withItemIndex<T>(error: T, itemIndex: number): T {
	const context = (error as { context?: IDataObject })?.context;
	if (context && typeof context === 'object' && context.itemIndex === undefined) {
		context.itemIndex = itemIndex;
	}
	return error;
}

export function rethrow(context: MailMintContext, error: unknown, itemIndex: number): Error {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		return withItemIndex(error, itemIndex);
	}
	return new NodeOperationError(context.getNode(), error as Error, { itemIndex });
}

/**
 * The API answers every failure with
 *   { error: { code, message, hint?, docs?, request_id? } }
 * so the node can show a sentence the operator can act on instead of
 * "Request failed with status code 400".
 */
function describeError(context: MailMintContext, error: JsonObject): never {
	const decoded = errorBody(error);
	const apiError = (decoded?.json?.error ?? {}) as IDataObject;
	const httpCode = statusCodeOf(error);

	if (apiError.message) {
		const info = compactApiError(apiError, httpCode);
		const parts: string[] = [];
		if (info.hint) parts.push(String(info.hint));
		const advice = N8N_ADVICE[String(info.code ?? '')];
		if (advice) parts.push(advice);
		if (info.docs) parts.push(`Docs: ${String(info.docs)}`);
		if (info.request_id) parts.push(`Request ID: ${String(info.request_id)}`);

		// The plain object is what stops NodeApiError from short-circuiting.
		const failure = new NodeApiError(context.getNode(), decoded?.json as JsonObject, {
			message: String(info.message),
			description: parts.join(' '),
			httpCode: httpCode || undefined,
		});
		failure.context.data = decoded?.json as IDataObject;
		Object.assign(failure, { [API_ERROR_PROPERTY]: info });
		throw failure;
	}

	const code = String((error as JsonObject).code ?? '');
	if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code)) {
		throw new NodeApiError(
			context.getNode(),
			{ code, message: String((error as JsonObject).message ?? code) },
			{
				message: 'Could not reach the MailMint API',
				description:
					'Check that this n8n instance has outbound internet access, and that the Base URL in the credential is correct.',
			},
		);
	}

	const failure = new NodeApiError(context.getNode(), error);
	if (decoded?.text !== undefined) {
		failure.context.data = decoded.text.slice(0, 2000);
	}
	throw failure;
}

export interface MailMintRequestOptions {
	body?: IDataObject;
	qs?: IDataObject;
	binary?: boolean;
}

export async function mailMintRequest(
	this: MailMintContext,
	method: IHttpRequestMethods,
	endpoint: string,
	extra: MailMintRequestOptions = {},
): Promise<MailMintResponse> {
	const { body, qs, binary = false } = extra;
	const options: IHttpRequestOptions = {
		method,
		url: `${await mailMintBaseUrl(this)}${endpoint}`,
		headers: {
			'User-Agent': 'n8n-nodes-mailmint',
			Accept: binary ? '*/*' : 'application/json',
		},
		json: !binary,
		returnFullResponse: true,
		ignoreHttpStatusErrors: false,
	};
	if (body !== undefined) options.body = body;
	if (qs !== undefined && Object.keys(qs).length) options.qs = qs;
	if (binary) options.encoding = 'arraybuffer';

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			options,
		)) as unknown as MailMintResponse;
	} catch (error) {
		return describeError(this, error as JsonObject);
	}
}

/** GET a `{data, next_cursor}` list, following the cursor until `limit` is met. */
export async function mailMintRequestAll(
	this: MailMintContext,
	endpoint: string,
	qs: IDataObject,
	limit?: number,
): Promise<IDataObject[]> {
	const collected: IDataObject[] = [];
	let cursor: string | undefined;

	do {
		const page: IDataObject = { ...qs };
		if (cursor) page.cursor = cursor;
		if (limit !== undefined) page.limit = Math.min(100, limit - collected.length);

		const response = await mailMintRequest.call(this, 'GET', endpoint, { qs: page });
		const payload = response.body as IDataObject;
		const rows = (Array.isArray(payload) ? payload : (payload?.data ?? [])) as IDataObject[];
		collected.push(...rows);

		cursor = (payload?.next_cursor as string) || undefined;
		if (!rows.length) break;
		if (limit !== undefined && collected.length >= limit) break;
	} while (cursor);

	return limit === undefined ? collected : collected.slice(0, limit);
}

/* --------------------------------------------------------------- load options */

export async function getMailboxes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const response = await mailMintRequest.call(this, 'GET', '/v1/mailboxes');
	const payload = response.body as IDataObject;
	const rows = (Array.isArray(payload) ? payload : (payload?.data ?? [])) as IDataObject[];
	return rows.map((mailbox) => ({
		name: mailbox.name ? `${String(mailbox.name)} (${String(mailbox.address ?? '')})` : String(mailbox.address ?? mailbox.id),
		value: String(mailbox.id),
		description: mailbox.address ? `Mailbox ID ${String(mailbox.id)}` : undefined,
	}));
}

/* -------------------------------------------------------------------- schema */

interface SchemaFieldInput {
	name?: string;
	type?: string;
	description?: string;
	required?: boolean;
	hint?: string;
	enumOptions?: string;
	itemType?: string;
	nestedFields?: string;
}

/**
 * Turns the node's fixedCollection into the contract's schema array. Everything
 * a user can type in the UI maps onto §2 of the API contract, including the
 * three types that need a second parameter: enum, array and object.
 */
export function buildSchema(
	context: MailMintContext,
	collection: IDataObject,
	itemIndex: number,
): IDataObject[] | undefined {
	const rows = (collection?.field ?? []) as SchemaFieldInput[];
	if (!Array.isArray(rows) || !rows.length) return undefined;

	return rows.map((row, position) => {
		const name = (row.name ?? '').trim();
		if (!name) {
			throw new NodeOperationError(context.getNode(), `Schema field ${position + 1} has no name`, {
				itemIndex,
				description: 'Every field in Schema > Fields needs a Name — this is the JSON key you get back.',
			});
		}
		const type = row.type ?? 'string';
		const field: IDataObject = { name, type };
		if (row.description) field.description = row.description;
		if (row.required) field.required = true;
		if (row.hint) field.hint = row.hint;

		if (type === 'enum') {
			const values = String(row.enumOptions ?? '')
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean);
			if (!values.length) {
				throw new NodeOperationError(context.getNode(), `Enum field "${name}" has no options`, {
					itemIndex,
					description: 'Fill in Options with the allowed values, separated by commas.',
				});
			}
			field.options = values;
		}

		if (type === 'array') {
			field.items = { type: row.itemType ?? 'string' };
		}

		if (type === 'object') {
			const nested = String(row.nestedFields ?? '').trim();
			if (!nested) {
				throw new NodeOperationError(context.getNode(), `Object field "${name}" has no sub-fields`, {
					itemIndex,
					description:
						'Fill in Sub-Fields with a JSON array, for example [{"name":"street","type":"string"}].',
				});
			}
			try {
				const parsed = JSON.parse(nested) as unknown;
				if (!Array.isArray(parsed)) throw new Error('not an array');
				field.fields = parsed as IDataObject[];
			} catch (error) {
				throw new NodeOperationError(
					context.getNode(),
					`Sub-Fields of "${name}" is not a JSON array`,
					{
						itemIndex,
						description: `Use a JSON array such as [{"name":"street","type":"string"}]. The parser said: ${(error as Error).message}`,
					},
				);
			}
		}

		return field;
	});
}

export function parseJsonParameter(
	context: MailMintContext,
	value: unknown,
	field: string,
	itemIndex: number,
): IDataObject | IDataObject[] | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'object') return value as IDataObject;
	try {
		return JSON.parse(String(value)) as IDataObject;
	} catch (error) {
		throw new NodeOperationError(context.getNode(), `"${field}" is not valid JSON`, {
			itemIndex,
			description: `Use an expression that yields an object, for example {{ $json.schema }}, or fix the JSON by hand. The parser said: ${(error as Error).message}`,
		});
	}
}

/* ------------------------------------------------------------------ simplify */

function emailList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => (entry as IDataObject)?.email)
		.filter((email): email is string => typeof email === 'string');
}

export interface OutputShape {
	simplify: boolean;
	/** 'message' emits one item per email; 'lineItems' fans the table out. */
	output?: 'message' | 'lineItems';
	lineItemsSource?: string;
	includeConfidence?: boolean;
	includeAttachments?: boolean;
}

/** §4: needs_review is true when any of these four flag families is present. */
const REVIEW_FLAG = /^(low_confidence|missing_required|type_error|hallucinated_evidence):/;

export function needsReview(message: IDataObject): boolean {
	if (typeof message.needs_review === 'boolean') return message.needs_review;
	const meta = (message._meta ?? {}) as IDataObject;
	if (typeof meta.needs_review === 'boolean') return meta.needs_review;
	const flags = (message.flags ?? meta.flags ?? []) as string[];
	return flags.some((flag) => REVIEW_FLAG.test(flag));
}

/**
 * Attachment metadata always travels with a simplified message, including the
 * text and tables we pulled out of a PDF or a spreadsheet. "The data is only in
 * the attachment" is the second most common complaint in this market and it
 * must not need a checkbox. The bytes stay behind Include Attachments, because
 * one PDF is usually larger than the rest of the mail put together.
 */
function attachmentSummary(attachments: IDataObject[], includeBytes: boolean): IDataObject[] {
	return attachments.map((attachment) => {
		const summary: IDataObject = {
			id: attachment.id ?? null,
			filename: attachment.filename ?? null,
			content_type: attachment.content_type ?? null,
			size: attachment.size ?? null,
			inline: attachment.inline ?? false,
			url: attachment.url ?? null,
		};
		if (attachment.extracted !== undefined) summary.extracted = attachment.extracted;
		if (includeBytes && attachment.content_base64 !== undefined) {
			summary.content_base64 = attachment.content_base64;
		}
		return summary;
	});
}

interface TableLike {
	records?: IDataObject[];
	rows?: unknown[];
	headers?: unknown[];
	row_count?: number;
	truncated?: boolean;
	name?: string;
	index?: number;
	source?: string;
}

function tablesOf(message: IDataObject): Array<{ table: TableLike; origin: string }> {
	const found: Array<{ table: TableLike; origin: string }> = [];
	for (const table of (message.tables ?? []) as TableLike[]) {
		found.push({ table, origin: `tables[${table.index ?? found.length}]` });
	}
	const attachments = (message.attachments ?? []) as IDataObject[];
	attachments.forEach((attachment, position) => {
		const extracted = (attachment.extracted ?? {}) as IDataObject;
		for (const table of (extracted.tables ?? []) as TableLike[]) {
			found.push({
				table,
				origin: `attachments[${position}].extracted.tables[${table.index ?? 0}]`,
			});
		}
	});
	return found;
}

export interface LineItems {
	rows: IDataObject[];
	source: string;
	rowCount: number;
	truncated: boolean;
}

/**
 * Finds the repeating rows in a message: an array-of-object field first, then
 * the biggest table on the body, then the biggest table pulled out of an
 * attachment. "I got one item instead of forty" is the single most reported
 * failure in this category, so the row count travels with every row and a
 * truncated table is said out loud rather than quietly shortened.
 */
export function findLineItems(message: IDataObject, preferred?: string): LineItems {
	const fields = (message.fields ?? {}) as Record<string, IDataObject>;
	const flags = (message.flags ?? []) as string[];
	const wanted = (preferred ?? '').trim();

	const isRecord = (row: unknown): row is IDataObject =>
		Boolean(row) && typeof row === 'object' && !Array.isArray(row);

	const fromField = (
		name: string,
		field: IDataObject | undefined,
		requireObjects: boolean,
	): LineItems | undefined => {
		const value = field?.value;
		if (!Array.isArray(value) || !value.length) return undefined;
		// A `tags` or `skus` field is a list, but it is not the line items. Only
		// an array of objects is taken automatically; a list of scalars is a last
		// resort, and only when nothing better exists anywhere in the message.
		if (requireObjects && !value.every(isRecord)) return undefined;
		const rows = value.map((row) => (isRecord(row) ? row : ({ value: row } as IDataObject)));
		return {
			rows,
			source: `fields.${name}`,
			rowCount: rows.length,
			truncated: flags.includes(`table_truncated:${name}`) || flags.includes('table_truncated'),
		};
	};

	const fromTable = (entry: { table: TableLike; origin: string }): LineItems | undefined => {
		const records = entry.table.records ?? [];
		if (!records.length) return undefined;
		return {
			rows: records,
			source: entry.origin,
			rowCount: entry.table.row_count ?? records.length,
			truncated: Boolean(entry.table.truncated) || flags.includes('table_truncated'),
		};
	};

	const tables = () =>
		tablesOf(message)
			.map((entry) => ({ entry, size: (entry.table.records ?? []).length }))
			.sort((a, b) => b.size - a.size);

	if (wanted) {
		// An explicitly named source is used as given, objects or not.
		const named = fromField(wanted, fields[wanted], false);
		if (named) return named;
		const table = tablesOf(message).find(
			(entry) => entry.table.name === wanted || entry.origin === wanted,
		);
		if (table) {
			const found = fromTable(table);
			if (found) return found;
		}
		return { rows: [], source: wanted, rowCount: 0, truncated: false };
	}

	for (const [name, field] of Object.entries(fields)) {
		const found = fromField(name, field, true);
		if (found) return found;
	}

	for (const { entry } of tables()) {
		const found = fromTable(entry);
		if (found) return found;
	}

	for (const [name, field] of Object.entries(fields)) {
		const found = fromField(name, field, false);
		if (found) return found;
	}

	return { rows: [], source: 'none', rowCount: 0, truncated: false };
}

/**
 * The contract's §1 object is complete but deep, and n8n users pipe a parsed
 * message straight into a spreadsheet or a database node. This flattens it to
 * `{ field: value }` plus a flat `_meta`, which is what those nodes want, and
 * keeps the rest reachable through the options.
 */
export function simplifyMessage(message: IDataObject, options: OutputShape): IDataObject {
	const fields = (message.fields ?? {}) as Record<string, IDataObject>;
	const headers = (message.headers ?? {}) as IDataObject;
	const mailbox = (message.mailbox ?? {}) as IDataObject;
	const detected = (message.detected ?? {}) as IDataObject;
	const body = (message.body ?? {}) as IDataObject;
	const auth = (message.auth ?? {}) as IDataObject;
	const parse = (message.parse ?? {}) as IDataObject;
	const attachments = (message.attachments ?? []) as IDataObject[];
	const flags = (message.flags ?? []) as string[];
	const from = (headers.from ?? {}) as IDataObject;

	const simplified: IDataObject = {};
	const confidence: IDataObject = {};
	for (const [name, field] of Object.entries(fields)) {
		simplified[name] = field?.value ?? null;
		confidence[name] = {
			confidence: field?.confidence ?? null,
			source: field?.source ?? null,
			evidence: field?.evidence ?? null,
		};
	}

	const review = needsReview(message);
	// Right at the top level, because routing on it is the whole point of
	// having a confidence at all and nobody wants to write {{ $json._meta... }}.
	simplified._needs_review = review;

	simplified._meta = {
		id: message.id ?? null,
		message_id: headers.message_id ?? null,
		received_at: message.received_at ?? null,
		date: headers.date ?? null,
		subject: headers.subject ?? null,
		from_name: from.name ?? null,
		from_email: from.email ?? null,
		to: emailList(headers.to),
		cc: emailList(headers.cc),
		reply_to: emailList(headers.reply_to),
		mailbox_id: mailbox.id ?? null,
		mailbox_address: mailbox.address ?? null,
		mailbox_name: mailbox.name ?? null,
		type: detected.type ?? null,
		language: body.language ?? null,
		forwarded: flags.includes('forwarded'),
		forwarded_from: body.forwarded_from ?? null,
		needs_review: review,
		flags,
		spam_score: auth.spam_score ?? null,
		spf: auth.spf ?? null,
		dkim: auth.dkim ?? null,
		dmarc: auth.dmarc ?? null,
		attachment_count: attachments.length,
		attachment_names: attachments.map((attachment) => attachment.filename ?? null),
		has_extracted_attachments: attachments.some((attachment) => attachment.extracted !== undefined),
		schema_version: parse.schema_version ?? null,
		model: parse.model ?? null,
		llm_used: parse.llm_used ?? null,
		request_id: parse.request_id ?? null,
		raw_url: message.raw_url ?? null,
	};

	if (attachments.length) {
		simplified._attachments = attachmentSummary(attachments, Boolean(options.includeAttachments));
	}
	if (options.includeConfidence) simplified._confidence = confidence;

	return simplified;
}

/** Both endpoints answer either the message itself or `{data: message}`. */
export function unwrapMessage(payload: unknown): IDataObject {
	const object = (payload ?? {}) as IDataObject;
	if (object.data && typeof object.data === 'object' && !Array.isArray(object.data)) {
		return object.data as IDataObject;
	}
	return object;
}

/**
 * One parsed message in, one or many n8n items out. `pairedItem` points at the
 * input item every row came from, so a fan-out of forty line items still traces
 * back to the mail it was read out of.
 */
export function shapeItems(
	message: IDataObject,
	shape: OutputShape,
	itemIndex: number,
): INodeExecutionData[] {
	const pairedItem = { item: itemIndex };

	if (shape.output !== 'lineItems') {
		const json = shape.simplify ? simplifyMessage(message, shape) : message;
		return [{ json, pairedItem }];
	}

	const items = findLineItems(message, shape.lineItemsSource);
	const header = shape.simplify ? simplifyMessage(message, shape) : message;

	// No rows is not the same as no message. Emitting the header on its own with
	// a row count of zero is how a workflow can tell "nothing to itemise" from
	// "the table silently came back short".
	if (!items.rows.length) {
		const json: IDataObject = shape.simplify
			? {
					...header,
					_row_index: null,
					_row_count: 0,
					_line_items_source: items.source,
					_line_items_truncated: items.truncated,
				}
			: {
					...header,
					line_item: null,
					line_item_index: null,
					line_item_count: 0,
					_row_count: 0,
					line_items_source: items.source,
					line_items_truncated: items.truncated,
				};
		return [{ json, pairedItem }];
	}

	return items.rows.map((row, index) => {
		if (!shape.simplify) {
			return {
				json: {
					...header,
					line_item: row,
					line_item_index: index,
					line_item_count: items.rowCount,
					line_items_source: items.source,
					line_items_truncated: items.truncated,
				},
				pairedItem,
			};
		}
		// The row wins on a name the header also uses — a per-row `total` is
		// what that row's `total` means. The message-level value is not thrown
		// away though: it is kept under _shadowed, and named, so nothing is
		// quietly lost.
		const shadowed: IDataObject = {};
		for (const key of Object.keys(row)) {
			if (key in header) shadowed[key] = header[key];
		}
		const json: IDataObject = {
			...header,
			...row,
			_row_index: index,
			_row_count: items.rowCount,
			_line_items_source: items.source,
			_line_items_truncated: items.truncated,
		};
		if (Object.keys(shadowed).length) json._shadowed = shadowed;
		return { json, pairedItem };
	});
}
