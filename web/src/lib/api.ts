// callable の呼び出しとエラーの文言（P2 の details.reason で出し分ける）
import { FirebaseError } from 'firebase/app';
import { httpsCallable, type Functions } from 'firebase/functions';
import { ERROR_REASONS, type ErrorDetails, type ErrorReason } from '@nt/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly reason: ErrorReason | null,
    readonly details: ErrorDetails | null,
  ) {
    super(message);
  }
}

export async function call<Req, Res = void>(functions: Functions, name: string, data?: Req): Promise<Res> {
  try {
    const res = await httpsCallable<Req, Res>(functions, name)(data as Req);
    return res.data;
  } catch (e) {
    throw toApiError(e);
  }
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof FirebaseError) {
    const details = (e as FirebaseError & { details?: unknown }).details;
    if (details && typeof details === 'object' && 'reason' in details) {
      const d = details as ErrorDetails;
      const msg = ERROR_REASONS[d.reason] ?? '操作できませんでした';
      return new ApiError(msg, d.reason, d);
    }
    if (e.code === 'functions/unavailable' || e.code === 'functions/deadline-exceeded') {
      return new ApiError('通信できませんでした。電波のよい場所でもう一度お試しください', null, null);
    }
  }
  console.error(e);
  return new ApiError('うまくいきませんでした。もう一度お試しください', null, null);
}

export function errorMessage(e: unknown): string {
  return toApiError(e).message;
}
