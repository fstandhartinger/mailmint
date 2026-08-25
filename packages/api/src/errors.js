'use strict';

/**
 * ApiError carries what the n8n node and the dashboard both need: a stable
 * machine code, a one-line human message, and a hint that says what to change.
 */
class ApiError extends Error {
  constructor(status, code, message, opts = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = opts.hint || null;
    this.docs = opts.docs || null;
    this.details = opts.details || null;
  }

  toJSON(requestId) {
    const body = { error: { code: this.code, message: this.message } };
    if (this.hint) body.error.hint = this.hint;
    if (this.docs) body.error.docs = this.docs;
    if (this.details) body.error.details = this.details;
    if (requestId) body.error.request_id = requestId;
    return body;
  }
}

const bad = (code, message, opts) => new ApiError(400, code, message, opts);
const notFound = (code, message, opts) => new ApiError(404, code, message, opts);

module.exports = { ApiError, bad, notFound };
