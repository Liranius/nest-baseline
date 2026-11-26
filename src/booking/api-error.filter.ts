import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { NodeResponse } from '@nestjs/platform-node';

@Catch(HttpException)
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: HttpException, host: ArgumentsHost) {
    const status = error.getStatus();
    const details = error.getResponse();
    const known = typeof details === 'object' && 'code' in details && 'message' in details;
    const fallback = status === 400 ? 'INVALID_INPUT' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
    host
      .switchToHttp()
      .getResponse<NodeResponse>()
      .status(status)
      .json(known ? details : { code: fallback, message: error.message });
  }
}
