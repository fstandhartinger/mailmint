import type { INodeProperties } from 'n8n-workflow';

import { schemaProperties } from './SchemaDescription';

const resource = { resource: ['mailbox'] };

export const mailboxOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	default: 'getAll',
	displayOptions: { show: resource },
	options: [
		{
			name: 'Create',
			value: 'create',
			description: 'Create an inbound address with a schema attached to it',
			action: 'Create a mailbox',
		},
		{
			name: 'Delete',
			value: 'delete',
			description: 'Delete a mailbox and stop accepting mail at its address',
			action: 'Delete a mailbox',
		},
		{
			name: 'Get Many',
			value: 'getAll',
			description: 'List the mailboxes on this account with their addresses',
			action: 'Get many mailboxes',
		},
		{
			name: 'Reparse Messages',
			value: 'reparseAll',
			description:
				'Re-run every stored message in a mailbox, after you have fixed the schema. Dry Run first if you want to see what would change.',
			action: 'Reparse every message in a mailbox',
		},
		{
			name: 'Update',
			value: 'update',
			description: 'Change the name, the schema or the webhook of a mailbox',
			action: 'Update a mailbox',
		},
	],
};

export const mailboxFields: INodeProperties[] = [
	{
		displayName: 'Name',
		name: 'mailboxName',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'Invoices',
		description: 'A label for you. The email address itself is generated and returned by the API.',
		displayOptions: { show: { ...resource, operation: ['create'] } },
	},
	{
		displayName: 'Mailbox Name or ID',
		name: 'mailboxId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getMailboxes' },
		default: '',
		required: true,
		description:
			'The mailbox to act on. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: { ...resource, operation: ['delete', 'reparseAll', 'update'] } },
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: true,
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
		displayName: 'Update Schema',
		name: 'updateSchema',
		type: 'boolean',
		default: false,
		description:
			'Whether to replace the schema on this mailbox. Leave off to change only the name or the webhook.',
		displayOptions: { show: { ...resource, operation: ['update'] } },
	},
	{
		displayName: 'Dry Run',
		name: 'dryRun',
		type: 'boolean',
		default: false,
		description:
			'Whether to report what would change without writing anything. Nothing is re-parsed, re-stored or re-delivered.',
		displayOptions: { show: { ...resource, operation: ['reparseAll'] } },
	},
	{
		displayName: 'Redeliver',
		name: 'redeliver',
		type: 'boolean',
		default: false,
		description:
			'Whether to fire the mailbox webhook again for every re-parsed message. Off by default, because a month of stored mail arriving at once is rarely what anyone wants.',
		displayOptions: { show: { ...resource, operation: ['reparseAll'] } },
	},
	{
		displayName: 'Reparse With a New Schema',
		name: 'reparseSchema',
		type: 'boolean',
		default: false,
		description:
			'Whether to reparse against a schema defined here instead of the one saved on the mailbox',
		displayOptions: { show: { ...resource, operation: ['reparseAll'] } },
	},
	...schemaProperties({ ...resource, operation: ['reparseAll'], reparseSchema: [true] }),
	...schemaProperties({ ...resource, operation: ['create'] }),
	...schemaProperties({ ...resource, operation: ['update'], updateSchema: [true] }),
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { ...resource, operation: ['update'] } },
		options: [
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'A new label for the mailbox',
			},
			{
				displayName: 'Webhook Secret',
				name: 'webhookSecret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description:
					'The secret used to sign the x-mailmint-signature header on every delivery. Rotate it here.',
			},
			{
				displayName: 'Webhook URL',
				name: 'webhookUrl',
				type: 'string',
				default: '',
				placeholder: 'https://example.com/hook',
				description:
					'Where parsed messages are POSTed. Leave this to the MailMint Trigger node unless you are wiring up something outside n8n.',
			},
		],
	},
	{
		displayName: 'Options',
		name: 'mailboxOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { ...resource, operation: ['create'] } },
		options: [
			{
				displayName: 'Webhook URL',
				name: 'webhookUrl',
				type: 'string',
				default: '',
				placeholder: 'https://example.com/hook',
				description: 'Where parsed messages are POSTed as they arrive',
			},
		],
	},
];
