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

	documentationUrl = 'https://github.com/fstandhartinger/n8n-nodes-mailmint#credential';

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
			// MailMint is not a hosted service yet, so there is no URL to default
			// to. Guessing one here would only produce a credential that fails its
			// own test with a DNS error.
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://api.example.com',
			description: 'The root URL of the MailMint API this credential talks to, with no trailing slash',
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
