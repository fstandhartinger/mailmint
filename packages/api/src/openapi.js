'use strict';

/**
 * The public API (/v1) as a hand-written OpenAPI 3.1 document — the
 * machine-readable twin of /docs.
 *
 * Written by hand from src/api.js and the helpers it calls (src/mailboxes.js,
 * src/messages.js, src/webhook-endpoints.js, src/reparse.js, src/errors.js),
 * NOT derived from the express router: test/openapi.test.js compares the two
 * sides bidirectionally to catch drift in both directions, which only means
 * anything if neither side is generated from the other.
 *
 * Path convention: `servers` carries the /v1 prefix; every entry in `paths` is
 * the router path with `:param` → `{param}` and nothing else, so every
 * operation URL resolves to the real URL.
 *
 * Nullability: fields the API genuinely emits as null are typed nullable in
 * OpenAPI 3.1 form. The Error schema's hint/docs/details/request_id are
 * optional and nullable because src/errors.js OMITS them when falsy (it never
 * sends null); the stateless-parse response's id/mailbox/raw_url and
 * attachments[].url are nullable because POST /parse stores nothing, and
 * next_cursor/events[].message because lists end and events can outlive their
 * message.
 */

const opSecurity = [{ apiKey: [] }];

const json = (schema) => ({ 'application/json': { schema } });
const messageResponse = (description) => ({
  description,
  content: json({ $ref: '#/components/schemas/Message' }),
});

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'MailMint API',
    version: '1.0.0',
    description: `An inbound email address in, one frozen JSON object out. Mail arrives at a
mailbox's address, is parsed against the mailbox's schema, and the result is delivered by webhook, read by
polling, or parsed statelessly. Every error is one envelope: a stable \`code\`, a human \`message\`, and
usually a \`hint\` saying what to change. This document is the reference; /docs is the narrative.`,
  },
  servers: [{ url: 'https://mailmint.app.mintapis.com/v1' }],
  tags: [
    { name: 'Mailboxes' },
    { name: 'Webhooks' },
    { name: 'Messages' },
    { name: 'Re-parse' },
    { name: 'Parse' },
    { name: 'Events' },
    { name: 'Test delivery' },
    { name: 'Usage' },
  ],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API key',
        description: 'Every /v1 request carries `Authorization: Bearer mm_live_…` (or mm_test_…).',
      },
    },
    responses: {
      ApiError: {
        description: 'An error envelope. The 4xx codes are listed per operation; 5xx use the same shape.',
        content: json({ $ref: '#/components/schemas/ErrorResponse' }),
      },
      RawGone: {
        description: 'The bytes have aged out of retention (or were never stored). The parsed JSON is still available.',
        content: json({ $ref: '#/components/schemas/ErrorResponse' }),
      },
    },
    schemas: {
      Error: {
        type: 'object',
        description: 'The inner error object. code and message are always present; the rest are omitted when falsy.',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', description: 'Stable machine code, e.g. missing_input, message_not_found.' },
          message: { type: 'string', description: 'One-line human message.' },
          hint: {
            type: ['string', 'null'],
            description: 'What to change. Omitted when there is nothing to suggest.',
          },
          docs: {
            type: ['string', 'null'],
            description: 'Link into /docs for this error. Omitted when there is none.',
          },
          details: {
            type: ['object', 'null'],
            additionalProperties: true,
            description: 'Structured extras, e.g. which input failed. Omitted when empty.',
          },
          request_id: {
            type: ['string', 'null'],
            description: 'The X-Request-Id of the failing call; quote it when contacting support.',
          },
        },
      },
      ErrorResponse: {
        type: 'object',
        required: ['error'],
        properties: { error: { $ref: '#/components/schemas/Error' } },
      },
      SchemaField: {
        type: 'object',
        description: 'One field definition of a mailbox schema (the normalised form).',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Becomes a key in the result\'s "fields" object.' },
          type: {
            type: 'string',
            description: 'Defaults to string when omitted.',
            enum: ['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'email', 'url', 'phone', 'currency', 'enum', 'array', 'object'],
          },
          description: { type: 'string', description: 'Tells the model what to look for.' },
          hint: { type: 'string', description: 'Optional extra guidance for the model.' },
          required: { type: 'boolean', description: 'Missing values raise missing_required:<name> and need review.' },
          options: { type: 'array', items: { type: 'string' }, description: 'enum fields only. Off-list values become null and raise enum_violation.' },
          items: {
            type: 'object',
            description: 'array fields only: the item type.',
            properties: {
              type: { $ref: '#/components/schemas/SchemaField/properties/type' },
              options: { type: 'array', items: { type: 'string' } },
              fields: { type: 'array', items: { $ref: '#/components/schemas/SchemaField' } },
            },
          },
          fields: { type: 'array', items: { $ref: '#/components/schemas/SchemaField' }, description: 'object fields only; two levels of nesting is the limit.' },
        },
      },
      MailboxRef: {
        type: 'object',
        description: 'The mailbox a message belongs to, as embedded in the message object.',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          address: { type: ['string', 'null'] },
          name: { type: ['string', 'null'] },
        },
      },
      Mailbox: {
        type: 'object',
        description: 'One inbound address plus its schema and webhook configuration.',
        required: ['id', 'name', 'address', 'alias', 'token', 'schema', 'schema_version', 'webhooks', 'paused', 'created_at'],
        properties: {
          id: { type: 'string', description: 'Prefixed mbx_.' },
          name: { type: 'string' },
          address: { type: 'string', description: 'The canonical token address mail is delivered to.' },
          // aliasFor() returns null whenever slug is null (addresses.js) — always emitted,
          // sometimes null (review F2).
          alias: { type: ['string', 'null'], description: 'The slug sub-address, or null when the mailbox has no slug.' },
          token: { type: 'string', description: 'The local part of the address; never reissued after deletion.' },
          slug: { type: ['string', 'null'], description: 'Convenience alias, or null when it collided inside the account.' },
          schema: { type: 'array', items: { $ref: '#/components/schemas/SchemaField' } },
          schema_version: { type: 'integer', description: 'Increments on every schema change; recorded per parse.' },
          webhook_url: {
            type: ['string', 'null'],
            description: 'Alias for the first webhook endpoint; null when none.',
          },
          webhook_secret: {
            type: ['string', 'null'],
            description: 'Signing secret of the first endpoint. Returned only on create/get/update responses, never on list.',
          },
          webhooks: {
            type: 'array',
            description: 'All endpoints, in creation order.',
            items: { $ref: '#/components/schemas/MailboxWebhook' },
          },
          forward_to: { type: ['string', 'null'], description: 'Optional forwarding address.' },
          paused: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      WebhookEndpoint: {
        type: 'object',
        description: 'One webhook registration. A mailbox can have several; each signs with its own secret.',
        required: ['id', 'mailbox_id', 'url', 'active', 'created_at', 'consecutive_failures'],
        properties: {
          id: { type: 'string', description: 'Prefixed whe_.' },
          mailbox_id: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          description: { type: ['string', 'null'] },
          active: { type: 'boolean' },
          secret: { type: ['string', 'null'], description: 'Shown only when minted (create, or secret rotation).' },
          created_at: { type: 'string', format: 'date-time' },
          last_status: { type: ['integer', 'null'], description: 'HTTP status of the last delivery attempt.' },
          last_delivered_at: { type: ['string', 'null'], format: 'date-time' },
          last_error: { type: ['string', 'null'] },
          consecutive_failures: { type: 'integer' },
          disabled_at: { type: ['string', 'null'], format: 'date-time', description: 'Set when the endpoint is switched off after ten failed deliveries in a row.' },
          disabled_reason: { type: ['string', 'null'] },
        },
      },
      // The slim endpoint shape embedded in Mailbox.webhooks (mailboxes.js publicMailbox):
      // reusing the full WebhookEndpoint here would lie — mailbox_id, created_at,
      // disabled_at and last_error exist only on the standalone /v1/webhooks routes (review F3).
      MailboxWebhook: {
        type: 'object',
        description: 'One endpoint as embedded in a mailbox response; slimmer than GET /v1/webhooks/{id}.',
        required: ['id', 'url', 'description', 'active', 'last_status', 'last_delivered_at', 'consecutive_failures', 'disabled_reason'],
        properties: {
          id: { type: 'string', description: 'Prefixed whe_.' },
          url: { type: 'string', format: 'uri' },
          description: { type: ['string', 'null'] },
          active: { type: 'boolean' },
          last_status: { type: ['integer', 'null'], description: 'HTTP status of the last delivery attempt.' },
          last_delivered_at: { type: ['string', 'null'], format: 'date-time' },
          consecutive_failures: { type: 'integer' },
          disabled_reason: { type: ['string', 'null'] },
          secret: { type: ['string', 'null'], description: 'Only on create/secret-rotation responses, never on plain GET.' },
        },
      },
      Deleted: {
        type: 'object',
        required: ['id', 'deleted'],
        properties: { id: { type: 'string' }, deleted: { type: 'boolean', enum: [true] } },
      },
      MailboxList: {
        type: 'object',
        required: ['data', 'inbound_domain'],
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Mailbox' } },
          inbound_domain: { type: 'string' },
        },
      },
      MailboxResponse: {
        type: 'object',
        required: ['mailbox'],
        properties: { mailbox: { $ref: '#/components/schemas/Mailbox' } },
      },
      WebhookList: {
        type: 'object',
        required: ['data'],
        properties: { data: { type: 'array', items: { $ref: '#/components/schemas/WebhookEndpoint' } } },
      },
      WebhookResponse: {
        type: 'object',
        required: ['webhook'],
        properties: { webhook: { $ref: '#/components/schemas/WebhookEndpoint' } },
      },
      FieldValue: {
        type: 'object',
        description: 'One schema field\'s answer: exactly value, confidence, source and evidence.',
        required: ['value', 'confidence', 'source', 'evidence'],
        properties: {
          value: { description: 'The extracted value; null when not found. Never invented.' },
          confidence: { type: 'number', description: 'Computed, 0..1 — never the model\'s self-report.' },
          source: { type: 'string', enum: ['rule', 'llm', 'rule+llm', 'header', 'attachment', 'none'] },
          evidence: { type: ['string', 'null'], description: 'Verbatim substring of the input the value came from, or null.' },
        },
      },
      FieldValues: {
        type: 'object',
        description: 'The schema\'s answers, keyed by field name. {} when the mailbox has no schema (flag no_schema).',
        additionalProperties: { $ref: '#/components/schemas/FieldValue' },
      },
      Attachment: {
        type: 'object',
        required: ['id', 'size', 'inline'],
        properties: {
          id: { type: 'string' },
          filename: { type: ['string', 'null'] },
          content_type: { type: ['string', 'null'] },
          size: { type: 'integer' },
          sha256: { type: ['string', 'null'] },
          inline: { type: 'boolean' },
          content_id: { type: ['string', 'null'] },
          url: {
            type: ['string', 'null'],
            description: 'GET /v1/attachments/{id}, authenticated. null from POST /v1/parse — nothing was stored, so there is nothing to fetch later.',
          },
          content_base64: { type: 'string', description: 'The bytes, base64 — only with ?include=attachments.' },
          extracted: {
            type: 'object',
            description: 'What was lifted out of the file: kind, pages, tables, text (truncated preview unless ?include=extracted_text) and text_length/text_truncated.',
            additionalProperties: true,
          },
        },
      },
      Message: {
        type: 'object',
        description: 'The frozen result shape. One function builds it, so the API response, the webhook body and events[].message are identical.',
        // status is emitted on every stored message (renderResult); POST /v1/parse stores
        // nothing, so its 200 body has no status — optional, not required (review F1).
        required: ['id', 'mailbox', 'received_at', 'flags', 'needs_review', 'attachments', 'raw_url'],
        properties: {
          id: { type: ['string', 'null'], description: 'Prefixed msg_. null from POST /v1/parse, which stores nothing.' },
          mailbox: {
            anyOf: [{ $ref: '#/components/schemas/MailboxRef' }, { type: 'null' }],
            description: 'null from POST /v1/parse.',
          },
          received_at: { type: 'string', format: 'date-time', description: 'When we accepted the message, not the sender\'s Date: header.' },
          status: { type: 'string', description: 'received → parsed (or failed). Filter GET /v1/messages by it.' },
          envelope: {
            type: 'object',
            description: 'What the SMTP conversation said — frequently not what headers.from says.',
            additionalProperties: true,
            properties: {
              from: { type: ['string', 'null'] },
              to: { type: 'array', items: { type: 'string' } },
              helo: { type: ['string', 'null'] },
              remote_ip: { type: ['string', 'null'] },
              tls: { type: 'boolean' },
            },
          },
          headers: {
            type: 'object',
            description: 'Decoded and unfolded, RFC 2047 encoded words resolved. Everything not named explicitly is under headers.raw.',
            additionalProperties: true,
            properties: {
              message_id: { type: ['string', 'null'] },
              date: { type: ['string', 'null'] },
              subject: { type: ['string', 'null'] },
              from: { type: 'object', additionalProperties: true },
              to: { type: 'array', items: { type: 'object', additionalProperties: true } },
              cc: { type: 'array', items: { type: 'object', additionalProperties: true } },
              reply_to: { type: 'array', items: { type: 'object', additionalProperties: true } },
              references: { type: 'array', items: { type: 'string' } },
              raw: { type: 'object', description: 'Every header we do not name explicitly, lowercased keys.', additionalProperties: { type: 'string' } },
            },
          },
          body: {
            type: 'object',
            properties: {
              text: { type: ['string', 'null'] },
              html: { type: ['string', 'null'] },
              text_from_html: { type: ['string', 'null'] },
              stripped_text: { type: ['string', 'null'], description: 'Quoted reply chain and signature removed — usually what you extract from.' },
              language: { type: ['string', 'null'] },
            },
          },
          attachments: { type: 'array', items: { $ref: '#/components/schemas/Attachment' } },
          auth: {
            type: 'object',
            description: 'SPF, DKIM and DMARC as decided at the receiving edge.',
            additionalProperties: true,
            properties: {
              spf: { type: ['string', 'null'] },
              dkim: { type: ['string', 'null'], description: '"body_altered" is its own case: signed and valid, but forwarded or gateway-rewritten.' },
              dmarc: { type: ['string', 'null'] },
              spam_score: { type: ['number', 'null'] },
            },
          },
          auth_details: { type: ['object', 'null'], additionalProperties: true },
          tables: {
            type: 'array',
            description: 'Deterministic table extraction.',
            items: { type: 'object', additionalProperties: true },
          },
          detected: {
            type: 'object',
            description: 'Deterministic, no schema needed: type plus every emails, urls, phones, amounts, dates, ids and addresses found.',
            additionalProperties: true,
            properties: {
              type: { type: ['string', 'null'], description: 'invoice, receipt, order, shipping, form, calendar or generic.' },
            },
          },
          fields: { $ref: '#/components/schemas/FieldValues' },
          flags: { type: 'array', items: { type: 'string' } },
          needs_review: { type: 'boolean' },
          parse: {
            type: 'object',
            description: 'How this result was produced.',
            properties: {
              request_id: { type: 'string' },
              schema_version: { type: ['integer', 'null'] },
              model: { type: ['string', 'null'], description: 'The model that answered, or null when the rules layer resolved everything.' },
              llm_used: { type: 'boolean' },
              timings_ms: { type: 'object', additionalProperties: { type: 'number' } },
              cost: {
                type: 'object',
                description: 'What this parse cost: input_tokens, output_tokens, llm_calls, usd.',
                additionalProperties: true,
              },
              warnings: { type: 'array', items: { type: 'string' } },
            },
          },
          raw_url: { type: ['string', 'null'], description: 'The original RFC822 bytes, API-key authenticated. null once aged out, or from POST /v1/parse.' },
        },
      },
      MessageSummary: {
        type: 'object',
        description: 'The cheap row GET /v1/messages pages over: no body, no evidence spans, attachment metadata without bytes or text.',
        required: ['id', 'mailbox_id', 'received_at', 'size', 'status', 'needs_review', 'flags', 'fields', 'attachments'],
        properties: {
          id: { type: 'string' },
          mailbox_id: { type: 'string' },
          received_at: { type: 'string', format: 'date-time' },
          from: { type: ['string', 'null'] },
          subject: { type: ['string', 'null'] },
          size: { type: 'integer' },
          status: { type: 'string' },
          needs_review: { type: 'boolean' },
          flags: { type: 'array', items: { type: 'string' } },
          spam_score: { type: ['number', 'null'] },
          fields: { $ref: '#/components/schemas/FieldValues' },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'size'],
              properties: {
                id: { type: 'string' },
                filename: { type: ['string', 'null'] },
                content_type: { type: ['string', 'null'] },
                size: { type: 'integer' },
                extracted: {
                  type: ['object', 'null'],
                  description: 'Shape only: kind, pages, table count and text length — never the text itself.',
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
      MessageList: {
        type: 'object',
        required: ['data', 'next_cursor'],
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/MessageSummary' } },
          next_cursor: {
            type: ['string', 'null'],
            description: 'The id to pass back as ?cursor; null when the list has ended.',
          },
        },
      },
      Event: {
        type: 'object',
        description: 'One entry of the polling feed. The cursor is a strictly monotonic bigint id.',
        required: ['id', 'type', 'cursor', 'created_at', 'message'],
        properties: {
          id: { type: 'integer' },
          type: { type: 'string', description: 'message.received, message.reparsed, …' },
          cursor: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          message: {
            anyOf: [{ $ref: '#/components/schemas/Message' }, { type: 'null' }],
            description: 'The message object, or null for an event whose message no longer resolves.',
          },
        },
      },
      EventList: {
        type: 'object',
        required: ['events', 'next_cursor', 'has_more'],
        properties: {
          events: { type: 'array', items: { $ref: '#/components/schemas/Event' } },
          next_cursor: { type: 'string' },
          has_more: { type: 'boolean' },
        },
      },
      ReparseJob: {
        type: 'object',
        description: 'A bulk re-parse job over a mailbox\'s stored history.',
        required: ['job_id', 'mailbox_id', 'status', 'dry_run', 'redeliver', 'total', 'done', 'changed', 'failed', 'params', 'diffs', 'diffs_truncated', 'error', 'created_at'],
        properties: {
          job_id: { type: 'string', description: 'Prefixed rpj_.' },
          mailbox_id: { type: 'string' },
          status: { type: 'string', description: 'queued → running → succeeded | failed.' },
          dry_run: { type: 'boolean' },
          redeliver: { type: 'boolean' },
          total: { type: 'integer' },
          done: { type: 'integer' },
          changed: { type: 'integer' },
          failed: { type: 'integer' },
          params: { type: 'object', description: 'The selection and schema the job runs with.', additionalProperties: true },
          diffs: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Capped at 200; diffs_truncated says when.' },
          diffs_truncated: { type: 'boolean' },
          error: { type: ['string', 'null'] },
          created_at: { type: 'string', format: 'date-time' },
          started_at: { type: ['string', 'null'], format: 'date-time' },
          finished_at: { type: ['string', 'null'], format: 'date-time' },
          poll: { type: 'string', description: 'Only on the 202 create response: where to poll.' },
        },
      },
      Usage: {
        type: 'object',
        description: 'This billing period, at a glance.',
        required: ['plan', 'period_start', 'used', 'remaining', 'messages', 'mailboxes', 'retention_days', 'key_mode'],
        properties: {
          plan: {
            type: 'object',
            required: ['id', 'name', 'quota', 'price_usd'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              quota: { type: 'integer', description: 'Messages per calendar month.' },
              price_usd: { type: 'number' },
            },
          },
          period_start: { type: 'string', format: 'date-time' },
          used: { type: 'integer' },
          remaining: { type: 'integer' },
          messages: {
            type: 'object',
            required: ['this_month', 'last_24h', 'needs_review', 'stored'],
            properties: {
              this_month: { type: 'integer' },
              last_24h: { type: 'integer' },
              needs_review: { type: 'integer' },
              stored: { type: 'integer' },
            },
          },
          mailboxes: { type: 'integer' },
          retention_days: { type: 'integer' },
          key_mode: { type: 'string', enum: ['live', 'test'] },
        },
      },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    '/mailboxes': {
      post: {
        tags: ['Mailboxes'],
        operationId: 'createMailbox',
        security: opSecurity,
        summary: 'Create a mailbox and mint its address.',
        description: 'Up to 100 per account. Returns the signing secret and, when a webhook_url is given, the first endpoint\'s secret.',
        requestBody: {
          required: false,
          content: json({
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Defaults to "Inbox"; trimmed to 80 characters.' },
              schema: { type: 'array', items: { $ref: '#/components/schemas/SchemaField' } },
              webhook_url: { type: 'string', description: 'Where parsed messages are POSTed; http or https.' },
              forward_to: { type: 'string' },
              slug: { type: 'string', description: 'Local-part alias; dropped silently on collision.' },
            },
          }),
        },
        responses: {
          '201': { description: 'Created. The mailbox including its secrets, shown this once.', content: json({ $ref: '#/components/schemas/MailboxResponse' }) },
          '409': { description: 'The account already has 100 mailboxes.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
      get: {
        tags: ['Mailboxes'],
        operationId: 'listMailboxes',
        security: opSecurity,
        summary: 'List the account\'s mailboxes.',
        responses: {
          '200': { description: 'The mailboxes, in creation order, without secrets.', content: json({ $ref: '#/components/schemas/MailboxList' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/mailboxes/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Mailbox id, prefixed mbx_.' }],
      get: {
        tags: ['Mailboxes'],
        operationId: 'getMailbox',
        security: opSecurity,
        summary: 'One mailbox, including its first endpoint\'s secret.',
        responses: {
          '200': { description: 'The mailbox.', content: json({ $ref: '#/components/schemas/MailboxResponse' }) },
          '404': { description: 'No such mailbox on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
      patch: {
        tags: ['Mailboxes'],
        operationId: 'updateMailbox',
        security: opSecurity,
        summary: 'Rename, change the schema (mints a new version), or change webhook/forwarding settings.',
        requestBody: {
          required: false,
          content: json({
            type: 'object',
            properties: {
              name: { type: 'string' },
              schema: { type: 'array', items: { $ref: '#/components/schemas/SchemaField' }, description: 'Replaces the schema and increments schema_version.' },
              webhook_url: { type: ['string', 'null'], description: 'Edits the first endpoint; null or "" removes it.' },
              webhook_secret: { type: ['string', 'null'], description: 'At least 16 characters; empty string mints a fresh one.' },
              forward_to: { type: ['string', 'null'] },
              paused: { type: 'boolean' },
              slug: { type: ['string', 'null'] },
            },
          }),
        },
        responses: {
          '200': { description: 'The updated mailbox.', content: json({ $ref: '#/components/schemas/MailboxResponse' }) },
          '404': { description: 'No such mailbox on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
      delete: {
        tags: ['Mailboxes'],
        operationId: 'deleteMailbox',
        security: opSecurity,
        summary: 'Soft-delete a mailbox. The address stops accepting mail; stored messages stay readable until retention runs out.',
        responses: {
          '200': { description: 'Deleted.', content: json({ $ref: '#/components/schemas/Deleted' }) },
          '404': { description: 'No such mailbox on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/mailboxes/{id}/webhooks': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Mailbox id, prefixed mbx_.' }],
      post: {
        tags: ['Webhooks'],
        operationId: 'createWebhookEndpoint',
        security: opSecurity,
        summary: 'Register another webhook endpoint on a mailbox.',
        description: 'Each registration gets its own row and signing secret, so two n8n triggers on one mailbox stay independent. The secret is shown here and never again.',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', description: 'Absolute http(s) URL of the receiver.' },
              description: { type: 'string', description: 'Up to 200 characters, for the dashboard.' },
              secret: { type: 'string', description: 'Signing secret; at least 16 characters. Omit to have one generated.' },
            },
          }),
        },
        responses: {
          '201': { description: 'Created, with the secret shown once.', content: json({ $ref: '#/components/schemas/WebhookResponse' }) },
          '404': { description: 'No such mailbox on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
      get: {
        tags: ['Webhooks'],
        operationId: 'listWebhookEndpoints',
        security: opSecurity,
        summary: 'The mailbox\'s webhook endpoints, in creation order.',
        responses: {
          '200': { description: 'The endpoints, without secrets.', content: json({ $ref: '#/components/schemas/WebhookList' }) },
          '404': { description: 'No such mailbox on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/webhooks/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Webhook endpoint id, prefixed whe_.' }],
      get: {
        tags: ['Webhooks'],
        operationId: 'getWebhookEndpoint',
        security: opSecurity,
        summary: 'One webhook endpoint.',
        responses: {
          '200': { description: 'The endpoint.', content: json({ $ref: '#/components/schemas/WebhookResponse' }) },
          '404': { description: 'No such endpoint on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
      patch: {
        tags: ['Webhooks'],
        operationId: 'updateWebhookEndpoint',
        security: opSecurity,
        summary: 'Change url, description, secret or active. Re-activating clears the auto-disable.',
        requestBody: {
          required: false,
          content: json({
            type: 'object',
            properties: {
              url: { type: 'string' },
              description: { type: ['string', 'null'] },
              secret: { type: 'string', description: 'Empty or omitted mints a fresh one; the new value is returned in this response.' },
              active: { type: 'boolean' },
            },
          }),
        },
        responses: {
          '200': { description: 'The updated endpoint.', content: json({ $ref: '#/components/schemas/WebhookResponse' }) },
          '404': { description: 'No such endpoint on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
      delete: {
        tags: ['Webhooks'],
        operationId: 'deleteWebhookEndpoint',
        security: opSecurity,
        summary: 'Delete one endpoint. Other endpoints on the mailbox keep delivering.',
        responses: {
          '200': { description: 'Deleted.', content: json({ $ref: '#/components/schemas/Deleted' }) },
          '404': { description: 'No such endpoint on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/messages': {
      get: {
        tags: ['Messages'],
        operationId: 'listMessages',
        security: opSecurity,
        summary: 'Paged, newest-first. The cursor is the message id, so pages never drift as new mail arrives.',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
          { name: 'mailbox_id', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string' }, description: 'E.g. parsed, received, failed.' },
          { name: 'since', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'until', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Exclusive upper bound on received_at.' },
          { name: 'from', in: 'query', required: false, schema: { type: 'string' }, description: 'Case-insensitive substring of the sender address.' },
          { name: 'subject', in: 'query', required: false, schema: { type: 'string' }, description: 'Case-insensitive substring of the subject.' },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'The previous next_cursor.' },
          { name: 'needs_review', in: 'query', required: false, schema: { type: 'string' }, description: 'Any value other than "false" turns the review filter on.' },
          { name: 'flag', in: 'query', required: false, schema: { type: 'string' }, description: 'Messages whose flags contain this value.' },
          { name: 'view', in: 'query', required: false, schema: { type: 'string', enum: ['review'] }, description: 'view=review adds, per row, which flag fired on which field and its evidence.' },
        ],
        responses: {
          '200': { description: 'One page of summaries.', content: json({ $ref: '#/components/schemas/MessageList' }) },
          '400': { description: 'since or until is not a date (invalid_since, invalid_until), or from/subject is over 200 characters (query_too_long).', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/messages/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Message id, prefixed msg_.' }],
      get: {
        tags: ['Messages'],
        operationId: 'getMessage',
        security: opSecurity,
        summary: 'The full message object.',
        parameters: [
          { name: 'include', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma list: attachments (inline base64 bytes), extracted_text (full text instead of the preview).' },
          { name: 'exclude', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma list: extracted drops the extraction entirely.' },
        ],
        responses: {
          '200': messageResponse('The message object.'),
          '404': { description: 'No such message on this account (or it has aged out).', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/messages/{id}/raw': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Message id, prefixed msg_.' }],
      get: {
        tags: ['Messages'],
        operationId: 'getMessageRaw',
        security: opSecurity,
        summary: 'The original RFC822 bytes, as message/rfc822.',
        responses: {
          '200': {
            description: 'The raw MIME, as an .eml attachment.',
            content: { 'message/rfc822': { schema: { type: 'string', format: 'binary' } } },
          },
          '404': { description: 'No such message on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          '410': { $ref: '#/components/responses/RawGone' },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/attachments/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Attachment id.' }],
      get: {
        tags: ['Messages'],
        operationId: 'getAttachment',
        security: opSecurity,
        summary: 'The attachment\'s bytes, as stored at parse time.',
        responses: {
          '200': {
            description: 'The file bytes, with the attachment\'s content type.',
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          '404': { description: 'No such attachment on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          '410': { $ref: '#/components/responses/RawGone' },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/messages/{id}/reparse': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Message id, prefixed msg_.' }],
      post: {
        tags: ['Re-parse'],
        operationId: 'reparseMessage',
        security: opSecurity,
        summary: 'Re-run the parser on one stored message, from the original bytes.',
        description: 'Never billed, and the webhook does not re-fire unless deliver is true. The tuning loop: change the schema, re-parse yesterday\'s real message, look at what came out.',
        parameters: [
          { name: 'include', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'exclude', in: 'query', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: false,
          content: json({
            type: 'object',
            properties: {
              schema: { type: 'array', items: { $ref: '#/components/schemas/SchemaField' }, description: 'A one-off schema for this run.' },
              schema_version: { type: 'integer', description: 'Use an older schema version — the honest way to reproduce an old result.' },
              deliver: { type: 'boolean', default: false, description: 'Re-fire the webhook.' },
            },
          }),
        },
        responses: {
          '200': messageResponse('The message object with the new result.'),
          '404': { description: 'No such message on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/mailboxes/{id}/reparse': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Mailbox id, prefixed mbx_.' }],
      post: {
        tags: ['Re-parse'],
        operationId: 'createReparseJob',
        security: opSecurity,
        summary: 'Re-parse a mailbox\'s stored history as a background job.',
        description: 'Answers 202 immediately and is polled at GET /v1/reparse/{job_id}. redeliver defaults to false and dry_run writes nothing, so the dangerous things have to be asked for by name.',
        requestBody: {
          required: false,
          content: json({
            type: 'object',
            properties: {
              schema: { type: 'array', items: { $ref: '#/components/schemas/SchemaField' } },
              schema_version: { type: 'integer' },
              since: { type: 'string', format: 'date-time' },
              until: { type: 'string', format: 'date-time' },
              limit: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
              status: { type: 'string' },
              needs_review: { type: 'boolean' },
              flag: { type: 'string' },
              dry_run: { type: 'boolean', default: false, description: 'Show the diff without writing.' },
              redeliver: { type: 'boolean', default: false, description: 'Fire the webhook for each re-parsed message.' },
            },
          }),
        },
        responses: {
          '202': { description: 'The queued job, with its poll URL.', content: json({ $ref: '#/components/schemas/ReparseJob' }) },
          '404': { description: 'No such mailbox on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          '400': { description: 'An invalid date in since/until.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/reparse/{job_id}': {
      parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' }, description: 'Re-parse job id, prefixed rpj_.' }],
      get: {
        tags: ['Re-parse'],
        operationId: 'getReparseJob',
        security: opSecurity,
        summary: 'Poll a re-parse job.',
        responses: {
          '200': { description: 'The job, with its progress and diffs.', content: json({ $ref: '#/components/schemas/ReparseJob' }) },
          '404': { description: 'No such job on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/parse': {
      post: {
        tags: ['Parse'],
        operationId: 'parseMessageStateless',
        security: opSecurity,
        summary: 'Parse an email you already have, without an address and without storing anything.',
        description: 'Send raw_mime (plain or base64 RFC822), or subject/text/html. The response is the message object with id, mailbox and raw_url null, and every attachment\'s url null. Counts against quota.',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            description: 'Either raw_mime, or at least one of subject/text/html. Send neither and you get 400 missing_input.',
            properties: {
              raw_mime: { type: 'string', description: 'A whole RFC822 message, plain text or base64, up to the size limit.' },
              subject: { type: 'string' },
              text: { type: 'string' },
              html: { type: 'string' },
              schema: { type: 'array', items: { $ref: '#/components/schemas/SchemaField' }, description: 'Omit it and you still get detected, tables, decoded headers and a cleaned body.' },
            },
          }),
        },
        responses: {
          '200': messageResponse('The message object, unstored: id, mailbox, raw_url and attachments[].url are null.'),
          '400': { description: 'missing_input, invalid_schema or too_large.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/events': {
      get: {
        tags: ['Events'],
        operationId: 'listEvents',
        security: opSecurity,
        summary: 'The polling feed the n8n trigger lives on, ordered by strictly monotonic event id.',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Pass back the previous next_cursor; omit to start at the beginning of the retained window.' },
          { name: 'mailbox_id', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'The feed page.', content: json({ $ref: '#/components/schemas/EventList' }) },
          '400': { description: 'invalid_cursor.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/test/deliver': {
      post: {
        tags: ['Test delivery'],
        operationId: 'deliverTestMessage',
        security: opSecurity,
        summary: 'Inject a message as if it had been received, and get the parsed result synchronously.',
        description: 'Same code path as real delivery. Send raw_mime, or subject/text/from to have a plain invoice built for you. A duplicate Message-ID returns 200 with the existing message instead of 201.',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['mailbox_id'],
            properties: {
              mailbox_id: { type: 'string' },
              raw_mime: { type: 'string', description: 'Overrides the generated message.' },
              from: { type: 'string' },
              subject: { type: 'string' },
              text: { type: 'string' },
              deliver: { type: 'boolean', default: true, description: 'Fire the mailbox\'s webhooks; false leaves them quiet.' },
            },
          }),
        },
        responses: {
          '201': messageResponse('The parsed message.'),
          '200': messageResponse('The already-stored message (a duplicate Message-ID).'),
          '404': { description: 'No such mailbox on this account.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
    '/usage': {
      get: {
        tags: ['Usage'],
        operationId: 'getUsage',
        security: opSecurity,
        summary: 'Quota and message counts for this account.',
        responses: {
          '200': { description: 'This period, at a glance.', content: json({ $ref: '#/components/schemas/Usage' }) },
          default: { $ref: '#/components/responses/ApiError' },
        },
      },
    },
  },
};

module.exports = spec;