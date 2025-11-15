import OpenAI from 'openai';
import type { ClientLike, OracleRequestBody } from './types.js';

export function createDefaultClientFactory(): (apiKey: string) => ClientLike {
  return (key: string): ClientLike => {
    const instance = new OpenAI({
      apiKey: key,
      timeout: 20 * 60 * 1000,
    });
    return {
      responses: {
        stream: (body: OracleRequestBody) =>
          instance.responses.stream(body) as unknown as ClientLike['responses']['stream'],
      },
    };
  };
}
