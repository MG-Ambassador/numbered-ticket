import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import { REGION } from '@nt/shared';

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 10 });

/**
 * 7.4「callable 関数で利用者の実 IP が取れるか」の検証用（P0 のみ。P2 で削除）。
 * Emulator では 127.0.0.1 になるため、判定は本番プロジェクトへのデプロイ後に行う。
 */
export const verifyIp = onCall((req) => {
  const raw = req.rawRequest;
  return {
    ip: raw.ip ?? null,
    ips: raw.ips ?? [],
    xForwardedFor: raw.headers['x-forwarded-for'] ?? null,
    fastlyClientIp: raw.headers['fastly-client-ip'] ?? null,
  };
});
