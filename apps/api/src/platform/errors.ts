import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/** Maps DB errors to clean HTTP errors; never leaks SQL or stack traces to clients. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private log = new Logger('Error');

  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof HttpException) return res.status(e.getStatus()).json(e.getResponse());
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      const map: Record<string, [number, string]> = {
        P2002: [409, `Already exists: ${String((e.meta?.target as string[] | string | undefined) ?? '')}`],
        P2025: [404, 'Not found'],
        P2003: [400, 'Linked record does not exist or is still in use'],
      };
      const hit = map[e.code];
      if (hit) return res.status(hit[0]).json({ statusCode: hit[0], message: hit[1] });
    }
    this.log.error(e instanceof Error ? e.stack : String(e));
    return res.status(500).json({ statusCode: 500, message: 'Internal error' });
  }
}
