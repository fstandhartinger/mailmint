import type { IDisplayOptions, INodeProperties } from 'n8n-workflow';

type Show = NonNullable<IDisplayOptions['show']>;

const NESTED_EXAMPLE = '[{ "name": "street", "type": "string" }]';

/**
 * The schema editor. Every competitor makes you leave the automation tool, open
 * their web app and build a template there before a single field comes back.
 * These properties are the whole point of this node: the fields you want
 * extracted are defined on the canvas, next to the workflow that consumes them.
 *
 * The shape mirrors §2 of the API contract exactly, including the three types
 * that need a second parameter — enum needs options, array needs an item type,
 * object needs sub-fields.
 *
 * The fields inside one entry are ordered alphabetically because n8n's own
 * community linter requires it; that is why Description comes before Name.
 */
export function schemaProperties(show: Show, includeMailboxOption = false): INodeProperties[] {
	const sourceOptions = [
		{
			name: 'Define Fields',
			value: 'fields',
			description: 'Build the schema here, in this node. No template to maintain in a web app.',
		},
		{
			name: 'JSON',
			value: 'json',
			description: 'Paste or compute the schema array, for example from an earlier node',
		},
		{
			name: 'None',
			value: 'none',
			description:
				'Skip extraction and return only the deterministic data: sender, body, tables, detected amounts and dates',
		},
	];
	if (includeMailboxOption) {
		sourceOptions.splice(1, 0, {
			name: 'From a Mailbox',
			value: 'mailbox',
			description: 'Reuse the schema already saved on one of your mailboxes',
		});
	}

	const properties: INodeProperties[] = [
		{
			displayName: 'Schema',
			name: 'schemaSource',
			type: 'options',
			noDataExpression: true,
			default: 'fields',
			description: 'Where the list of fields to extract comes from',
			displayOptions: { show },
			options: sourceOptions,
		},
	];

	if (includeMailboxOption) {
		properties.push({
			displayName: 'Schema Mailbox Name or ID',
			name: 'schemaMailboxId',
			type: 'options',
			typeOptions: { loadOptionsMethod: 'getMailboxes' },
			default: '',
			required: true,
			description:
				'The mailbox whose saved schema to use. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			displayOptions: { show: { ...show, schemaSource: ['mailbox'] } },
		});
	}

	properties.push(
		{
			displayName: 'Schema JSON',
			name: 'schemaJson',
			type: 'json',
			default:
				'[\n  {\n    "name": "invoice_number",\n    "type": "string",\n    "description": "the invoice or reference number"\n  }\n]',
			required: true,
			description:
				'A JSON array of field definitions. Each one takes name, type, description, required and hint.',
			displayOptions: { show: { ...show, schemaSource: ['json'] } },
		},
		{
			displayName: 'Fields',
			name: 'schemaFields',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true, sortable: true },
			placeholder: 'Add Field',
			default: {},
			description: 'One entry per value you want pulled out of the email',
			displayOptions: { show: { ...show, schemaSource: ['fields'] } },
			options: [
				{
					displayName: 'Field',
					name: 'field',
					values: [
						{
							displayName: 'Description',
							name: 'description',
							type: 'string',
							default: '',
							placeholder: 'grand total including tax',
							description:
								'What this field means, in your own words. This is the single biggest lever on accuracy. Write it the way you would explain it to a new colleague.',
						},
						{
							displayName: 'Hint',
							name: 'hint',
							type: 'string',
							default: '',
							placeholder: 'labelled Total or Amount Due',
							description:
								'Where to look. Naming the label the mail actually uses turns a fuzzy match into an exact one.',
						},
						{
							displayName: 'Item Type',
							name: 'itemType',
							type: 'options',
							default: 'string',
							description: 'The type of each entry in the list',
							displayOptions: { show: { type: ['array'] } },
							options: [
								{ name: 'Boolean', value: 'boolean' },
								{ name: 'Currency', value: 'currency' },
								{ name: 'Date', value: 'date' },
								{ name: 'Email', value: 'email' },
								{ name: 'Number', value: 'number' },
								{ name: 'Object', value: 'object' },
								{ name: 'String', value: 'string' },
								{ name: 'URL', value: 'url' },
							],
						},
						{
							displayName: 'Name',
							name: 'name',
							type: 'string',
							default: '',
							required: true,
							placeholder: 'invoice_number',
							description:
								'The JSON key you get back. Use the name you want in your spreadsheet or database column.',
						},
						{
							displayName: 'Options',
							name: 'enumOptions',
							type: 'string',
							default: '',
							placeholder: 'open, paid, overdue',
							description:
								'The allowed values, separated by commas. Anything else comes back as null with an enum_violation flag.',
							displayOptions: { show: { type: ['enum'] } },
						},
						{
							displayName: 'Required',
							name: 'required',
							type: 'boolean',
							default: false,
							description:
								'Whether a message without this field should be flagged. It is never invented: a missing required field still comes back as null, with missing_required in the flags and needs_review set.',
						},
						{
							displayName: 'Sub-Fields',
							name: 'nestedFields',
							type: 'json',
							default: NESTED_EXAMPLE,
							description:
								'A JSON array of field definitions for the nested object, in the same shape as the fields above',
							displayOptions: { show: { type: ['object'] } },
						},
						{
							displayName: 'Type',
							name: 'type',
							type: 'options',
							default: 'string',
							description:
								'What the value should be coerced to. A value that cannot be coerced comes back as null with a type_error flag rather than as a guess.',
							options: [
								{ name: 'Array', value: 'array', description: 'A list of values, each of the item type below' },
								{ name: 'Boolean', value: 'boolean', description: 'True or false' },
								{ name: 'Currency', value: 'currency', description: 'An amount with its currency, as amount plus currency code' },
								{ name: 'Date', value: 'date', description: 'Normalised to YYYY-MM-DD' },
								{ name: 'Date and Time', value: 'datetime', description: 'Normalised to ISO-8601 in UTC' },
								{ name: 'Email', value: 'email', description: 'A validated email address' },
								{ name: 'Enum', value: 'enum', description: 'One of a fixed list of values you give below' },
								{ name: 'Integer', value: 'integer', description: 'A whole number' },
								{ name: 'Number', value: 'number', description: 'A number, decimals allowed' },
								{ name: 'Object', value: 'object', description: 'A nested object whose sub-fields you define below' },
								{ name: 'Phone Number', value: 'phone', description: 'A phone number' },
								{ name: 'String', value: 'string', description: 'Free text, exactly as written in the mail' },
								{ name: 'URL', value: 'url', description: 'A link' },
							],
						},
					],
				},
			],
		},
	);

	return properties;
}
