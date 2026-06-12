import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../errors/index.js';
import { logger } from '../logger/index.js';

export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof AppError) {
    logger.error('api.error', {
      code: error.code,
      statusCode: error.statusCode,
      message: error.message,
      correlationId: request.id,
      retryable: error.retryable,
      context: error.context,
    });

    reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        details: error.details.length > 0 ? error.details : undefined,
        request_id: request.id,
      },
    });
    return;
  }

  // Fastify validation errors
  if ('validation' in error && Array.isArray((error as FastifyError).validation)) {
    const validation = (error as FastifyError).validation!;
    const details = validation.map((v: { instancePath?: string; schemaPath?: string; message?: string }) => ({
      field: v.instancePath || v.schemaPath,
      message: v.message || 'Validation failed',
    }));
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details, request_id: request.id },
    });
    return;
  }

  // Unknown error — log full stack, return generic message
  logger.error('unhandled_error', {
    error: error.message,
    stack: error.stack,
    correlationId: request.id,
  });
  reply.status(500).send({
    error: { code: 'SYSTEM_INTERNAL_ERROR', message: 'An unexpected error occurred', request_id: request.id },
  });
}
