import type { INodeProperties } from 'n8n-workflow';

const show = {
	resource: ['message', 'parse'],
	operation: ['parse', 'get', 'getAll', 'reparse'],
};

/**
 * Shown wherever the node can hand back a parsed message. Simplify is on by
 * default because the contract's full object is deep and the next node in a
 * real workflow is nearly always a spreadsheet, a database or an IF.
 */
export const outputFields: INodeProperties[] = [
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description:
			'Whether to return a flat object of the extracted fields plus a _meta object, instead of the full parse result with headers, body, tables and per-field confidence',
		displayOptions: { show },
	},
	{
		displayName: 'Output',
		name: 'output',
		type: 'options',
		noDataExpression: true,
		default: 'message',
		description: 'How many n8n items one email turns into',
		displayOptions: { show },
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
		displayOptions: { show: { ...show, output: ['lineItems'] } },
	},
	{
		displayName: 'Route Messages Needing Review Separately',
		name: 'splitNeedsReview',
		type: 'boolean',
		default: false,
		description:
			'Whether to add a second output for messages the parser is not confident about. A missing required field, a low confidence value, a type it could not coerce or evidence it could not find sends the item down the Needs Review branch, so a human can look at it without an IF node.',
		displayOptions: { show },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show },
		options: [
			{
				displayName: 'Include Attachment Bytes',
				name: 'includeAttachments',
				type: 'boolean',
				default: false,
				description:
					'Whether to include each attachment base64-encoded. The filenames, sizes and anything the parser read out of a PDF or spreadsheet are always there without this; the bytes are not, because one PDF is usually larger than the rest of the message put together.',
			},
			{
				displayName: 'Include Confidence',
				name: 'includeConfidence',
				type: 'boolean',
				default: false,
				description:
					'Whether to add a _confidence object next to the fields, with the confidence, the source and the verbatim evidence for each one. Only applies when Simplify is on; the full output always carries them.',
			},
		],
	},
];

/**
 * n8n resolves this to one output, or to two named ones, from the node's own
 * parameters. Mailbox operations never split.
 */
export const OUTPUTS_EXPRESSION =
	'={{ $parameter["splitNeedsReview"] && ["parse","get","getAll","reparse"].includes($parameter["operation"]) ? [{ "type": "main", "displayName": "Parsed" }, { "type": "main", "displayName": "Needs Review" }] : [{ "type": "main" }] }}';
