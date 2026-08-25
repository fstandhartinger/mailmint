'use strict';

/**
 * A stand-in for n8n's IExecuteFunctions / IPollFunctions / IWebhookFunctions
 * that behaves like the real thing in the ways these nodes depend on:
 * parameters come back per item, binary data round-trips through a buffer, and
 * the HTTP helper really talks to the mock API over the network so the tests
 * exercise the contract rather than a fixture.
 */
const http = require('http');
const { URL } = require('url');
const { NodeApiError } = require('n8n-workflow');

const BASE_URL = process.env.MAILMINT_TEST_URL || 'http://127.0.0.1:8787';

const testNode = {
	id: 'af1b2c3d',
	name: 'MailMint',
	type: 'n8n-nodes-mailmint.mailMint',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

class AxiosError extends Error {}

function axiosError(statusCode, body, arraybuffer) {
	const error = new AxiosError(`Request failed with status code ${statusCode}`);
	error.name = 'AxiosError';
	error.isAxiosError = true;
	error.code = statusCode >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
	error.config = { url: BASE_URL, method: 'get' };
	error.response = {
		status: statusCode,
		statusText: '',
		headers: { 'content-type': 'application/json; charset=utf-8' },
		data: arraybuffer ? Buffer.from(JSON.stringify(body), 'utf8') : body,
		config: error.config,
	};
	return error;
}

/** The same request n8n's helper would make, against the mock API. */
function request(options) {
	return new Promise((resolve, reject) => {
		const url = new URL(options.url);
		for (const [key, value] of Object.entries(options.qs || {})) {
			if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
		}
		const payload =
			options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8');

		const req = http.request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				method: options.method || 'GET',
				headers: {
					Authorization: 'Bearer mm_live_test',
					'Content-Type': 'application/json',
					...(options.headers || {}),
					...(payload ? { 'Content-Length': payload.length } : {}),
				},
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					const raw = Buffer.concat(chunks);
					const binary = options.encoding === 'arraybuffer';
					let body = binary ? raw : raw.length ? JSON.parse(raw.toString('utf8')) : {};
					if (res.statusCode >= 400) {
						const parsed = binary ? JSON.parse(raw.toString('utf8')) : body;
						reject(new NodeApiError(testNode, axiosError(res.statusCode, parsed, binary)));
						return;
					}
					resolve({ body, headers: res.headers, statusCode: res.statusCode });
				});
			},
		);
		req.on('error', reject);
		if (payload) req.write(payload);
		req.end();
	});
}

function createContext({
	params = {},
	items = [{ json: {} }],
	continueOnFail = false,
	mode = 'manual',
	staticData = {},
	headers = {},
	body = {},
	rawBody,
} = {}) {
	const calls = [];
	const responses = [];
	const resolve = (name, itemIndex, fallback) => {
		if (!(name in params)) {
			if (fallback !== undefined) return fallback;
			throw new Error(`test asked for an unset parameter: ${name}`);
		}
		const value = params[name];
		return typeof value === 'function' ? value(itemIndex) : value;
	};

	const context = {
		getNode: () => testNode,
		getInputData: () => items,
		continueOnFail: () => continueOnFail,
		getMode: () => mode,
		getWorkflowStaticData: () => staticData,
		getWorkflow: () => ({ id: 'wf_test', name: 'Test workflow', active: false }),
		getCredentials: async () => ({ apiKey: 'mm_live_test', baseUrl: BASE_URL }),
		getHeaderData: () => headers,
		getBodyData: () => body,
		getRequestObject: () => ({ rawBody, body }),
		getResponseObject: () => ({
			status(code) {
				responses.push({ code });
				return {
					json(payload) {
						responses[responses.length - 1].payload = payload;
					},
				};
			},
		}),
		getNodeWebhookUrl: () => 'http://n8n.test/webhook/abc',
		// Trigger contexts take (name, fallback); execute contexts take
		// (name, itemIndex, fallback). Both land here.
		getNodeParameter(name, a, b) {
			if (typeof a === 'number') return resolve(name, a, b);
			return resolve(name, 0, a);
		},
		helpers: {
			async httpRequestWithAuthentication(_credentialsType, options) {
				calls.push(options);
				return await request(options);
			},
			async prepareBinaryData(buffer, fileName, mimeType) {
				return { data: Buffer.from(buffer).toString('base64'), fileName, mimeType };
			},
			async getBinaryDataBuffer(itemIndex, property) {
				return Buffer.from(items[itemIndex].binary[property].data, 'base64');
			},
		},
	};
	return { context, calls, responses };
}

async function waitForMock(timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await request({ method: 'GET', url: `${BASE_URL}/healthz` });
			return;
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((r) => setTimeout(r, 100));
		}
	}
}

module.exports = { createContext, testNode, request, BASE_URL, waitForMock };
