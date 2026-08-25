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

	documentationUrl = 'https://mailmint.dev/docs#authentication';

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
				'Create an account at https://mailmint.dev and copy the key from your dashboard. It starts with mm_live_.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.mailmint.dev',
			description: 'Only change this if you run your own MailMint instance',
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
