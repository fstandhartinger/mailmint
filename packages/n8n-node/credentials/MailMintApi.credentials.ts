import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class MailMintApi implements ICredentialType {
	name = 'mailMintApi';

	icon = { light: 'file:mailmint.svg', dark: 'file:mailmint.dark.svg' } as const;

	displayName = 'MailMint API';

	documentationUrl = 'https://mailmint.app.mintapis.com/docs#authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'mm_live_...',
			description:
				'The key for your MailMint account. It starts with mm_live_.',
		},
		{
			// The hosted service. Anyone who signed up at mailmint.app.mintapis.com
			// can leave this alone; it is a field rather than a constant only so a
			// self-hosted MailMint can be pointed at instead.
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://mailmint.app.mintapis.com',
			required: true,
			placeholder: 'https://mailmint.app.mintapis.com',
			description: 'The root URL of the MailMint API this credential talks to, with no trailing slash. Leave the default unless you run MailMint yourself.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// A real call, so the credential shows a green tick instead of "untested".
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(new RegExp("/+$"), "")}}',
			url: '/v1/usage',
		},
	};
}
