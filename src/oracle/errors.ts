import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from 'openai';
import type { OracleResponse, OracleResponseMetadata, TransportFailureReason } from './types.js';

export class OracleTransportError extends Error {
  readonly reason: TransportFailureReason;

  constructor(reason: TransportFailureReason, message: string, cause?: unknown) {
    super(message);
    this.name = 'OracleTransportError';
    this.reason = reason;
    if (cause) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class OracleResponseError extends Error {
  readonly metadata: OracleResponseMetadata;
  readonly response?: OracleResponse;

  constructor(message: string, response?: OracleResponse) {
    super(message);
    this.name = 'OracleResponseError';
    this.response = response;
    this.metadata = extractResponseMetadata(response);
  }
}

export function extractResponseMetadata(response?: OracleResponse | null): OracleResponseMetadata {
  if (!response) {
    return {};
  }
  const metadata: OracleResponseMetadata = {
    responseId: response.id,
    status: response.status,
    incompleteReason: response.incomplete_details?.reason ?? undefined,
  };
  const requestId = response._request_id;
  if (requestId !== undefined) {
    metadata.requestId = requestId;
  }
  return metadata;
}

export function toTransportError(error: unknown): OracleTransportError {
  if (error instanceof OracleTransportError) {
    return error;
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new OracleTransportError('client-timeout', 'OpenAI request timed out before completion.', error);
  }
  if (error instanceof APIUserAbortError) {
    return new OracleTransportError('client-abort', 'The request was aborted before OpenAI finished responding.', error);
  }
  if (error instanceof APIConnectionError) {
    return new OracleTransportError(
      'connection-lost',
      'Connection to OpenAI dropped before the response completed.',
      error,
    );
  }
  return new OracleTransportError(
    'unknown',
    error instanceof Error ? error.message : 'Unknown transport failure.',
    error,
  );
}

export function describeTransportError(error: OracleTransportError): string {
  switch (error.reason) {
    case 'client-timeout':
      return 'Client-side timeout: OpenAI streaming call exceeded the 20m deadline.';
    case 'connection-lost':
      return 'Connection to OpenAI ended unexpectedly before the response completed.';
    case 'client-abort':
      return 'Request was aborted before OpenAI completed the response.';
    default:
      return 'OpenAI streaming call ended with an unknown transport error.';
  }
}
