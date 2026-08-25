import type { INodeProperties } from 'n8n-workflow';

import { schemaProperties } from './SchemaDescription';

const show = { resource: ['parse'], operation: ['parse'] };

export const parseFields: INodeProperties[] = [
	{
		displayName: 'Input',
		name: 'inputSource',
		type: 'options',
		noDataExpression: true,
		default: 'auto',
		description: 'Where the email to parse comes from',
		displayOptions: { show },
		options: [
			{
				name: 'Automatic',
				value: 'auto',
				description:
					'Use the binary .eml on the item if there is one, otherwise the subject, text and html on the JSON. Works with the Email Trigger (IMAP) node in every one of its formats, with nothing to configure.',
			},
			{
				name: 'Binary File',
				value: 'binary',
				description: 'A raw .eml or .mime file in a binary field on the item',
			},
			{
				name: 'Fields',
				value: 'fields',
				description: 'Type the subject, plain text and HTML in, or map them with expressions',
			},
			{
				name: 'Raw MIME Text',
				value: 'rawMime',
				description: 'The whole RFC822 message as text, headers and all',
			},
		],
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		placeholder: 'data',
		description:
			'The binary field holding the raw message. The Email Trigger (IMAP) node in RAW format puts it in "data", which is the default here.',
		displayOptions: { show: { ...show, inputSource: ['binary'] } },
	},
	{
		displayName: 'Raw MIME',
		name: 'rawMime',
		type: 'string',
		typeOptions: { rows: 8 },
		default: '',
		required: true,
		placeholder: 'From: billing@acme.com\nSubject: Invoice INV-2291\n\n...',
		description: 'The complete RFC822 message. Headers, then a blank line, then the body.',
		displayOptions: { show: { ...show, inputSource: ['rawMime'] } },
	},
	{
		displayName: 'Subject',
		name: 'subject',
		type: 'string',
		default: '',
		placeholder: 'Invoice INV-2291 from Acme Ltd',
		description: 'The subject line. Often carries the reference number, so it is worth mapping.',
		displayOptions: { show: { ...show, inputSource: ['fields'] } },
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 6 },
		default: '',
		description: 'The plain text body. Map it from an earlier node, for example {{ $JSON.textPlain }}.',
		displayOptions: { show: { ...show, inputSource: ['fields'] } },
	},
	{
		displayName: 'HTML',
		name: 'html',
		type: 'string',
		typeOptions: { rows: 6 },
		default: '',
		description: 'The HTML body, if there is one. Tables in it are extracted as rows either way.',
		displayOptions: { show: { ...show, inputSource: ['fields'] } },
	},
	...schemaProperties(show, true),
];

/** The Automatic input source reads these JSON keys, in this order. */
export const AUTO_TEXT_KEYS = ['textPlain', 'text', 'body', 'textAsHtml', 'plain'];
export const AUTO_HTML_KEYS = ['textHtml', 'html', 'bodyHtml'];
export const AUTO_SUBJECT_KEYS = ['subject', 'Subject', 'title'];
export const AUTO_RAW_KEYS = ['raw', 'rawMime', 'raw_mime', 'eml', 'message'];
