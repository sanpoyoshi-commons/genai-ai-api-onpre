/**
 * API エラー（横断ラッパが status + {error:message} に整形する起点）。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string): ApiError => new ApiError(400, message);
export const unauthorized = (message: string): ApiError => new ApiError(401, message);
export const forbidden = (message: string): ApiError => new ApiError(403, message);
export const notFound = (message: string): ApiError => new ApiError(404, message);
export const serverError = (message: string): ApiError => new ApiError(500, message);
export const serviceUnavailable = (message: string): ApiError => new ApiError(503, message);
