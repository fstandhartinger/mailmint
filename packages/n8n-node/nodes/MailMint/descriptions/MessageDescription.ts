import type { INodeProperties } from 'n8n-workflow';

import { schemaProperties } from './SchemaDescription';

const resource = { resource: ['message'] };

export const messageOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	default: 'getAll',
	displayOptions: { show: resource },
	options: [
		{
			name: 'Download Attachment',
			value: 'downloadAttachment',
			description: 'Get the bytes of one attachment as a binary field',
			action: 'Download an attachment',
		},
		{
			name: 'Get',
			value: 'get',
			description: 'Get one parsed message by its ID',
			action: 'Get a message',
		},
		{
			name: 'Get Many',
			value: 'getAll',
			description: 'List parsed messages, newest first',
			action: 'Get many messages',
		},
		{
			name: 'Get Raw',
			value: 'getRaw',
			description: 'Get the original RFC822 message as a binary .eml file',
			action: 'Get the raw message',
		},
		{
			name: 'Reparse',
			value: 'reparse',
			description: 'Run a message through the parser again, optionally against a different schema',
			action: 'Reparse a message',
		},
	],
};

const messageIdField = (operations: string[]): INodeProperties => ({
	displayName: 'Message ID',
	name: 'messageId',
	type: 'string',
	default: '',
	required: true,
	placeholder: 'msg_01JQ8Z3K4M5N6P7Q8R9S',
	description: 'The ID of the message, as returned by Get Many or by the MailMint Trigger',
	displayOptions: { show: { ...resource, operation: operations } },
});

export const messageFields: INodeProperties[] = [
	messageIdField(['get', 'getRaw', 'reparse']),
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show: { ...resource, operation: ['getAll'] } },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { ...resource, operation: ['getAll'], returnAll: [false] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { ...resource, operation: ['getAll'] } },
		options: [
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
					'Whether to return only messages the parser is not confident about — a missing required field, a low confidence value, a type it could not coerce, or evidence it could not find in the mail',
			},
			{
				displayName: 'Since',
				name: 'since',
				type: 'dateTime',
				default: '',
				description: 'Only messages received after this moment',
			},
		],
	},
	{
		displayName: 'Attachment ID',
		name: 'attachmentId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'att_01JQ8Z3K4M5N6P7Q8R9S',
		description: 'The ID of the attachment. A parsed message lists them under _attachments when Simplify is on, and under attachments when it is off.',
		displayOptions: { show: { ...resource, operation: ['downloadAttachment'] } },
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		placeholder: 'data',
		description: 'The name of the binary field to write the file to',
		displayOptions: { show: { ...resource, operation: ['downloadAttachment', 'getRaw'] } },
	},
	...schemaProperties({ ...resource, operation: ['reparse'] }, true),
];
