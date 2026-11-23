import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import { ERROR_REASONS, type ErrorDetails, type ErrorReason } from '@nt/shared';

/** 画面が理由を出し分けられるよう、details.reason を付けて投げる */
export function fail(code: FunctionsErrorCode, reason: ErrorReason, extra: Omit<ErrorDetails, 'reason'> = {}): never {
  const details: ErrorDetails = { reason, ...extra };
  throw new HttpsError(code, ERROR_REASONS[reason], details);
}
