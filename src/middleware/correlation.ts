import type { FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

const CORRELATION_HEADER = 'x-correlation-id';

export function correlationIdPlugin(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const id = (request.headers[CORRELATION_HEADER] as string) || uuidv4();
  request.id = id;
  reply.header(CORRELATION_HEADER, id);
  done();
}
