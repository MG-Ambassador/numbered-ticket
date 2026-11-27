// Firestore と Storage のパス。ルール（firestore.rules / storage.rules）と同じ形を保つこと。

export const paths = {
  event: (eid: string) => `events/${eid}`,
  secretCodes: (eid: string) => `events/${eid}/secrets/codes`,
  slots: (eid: string) => `events/${eid}/slots`,
  slot: (eid: string, slotId: string) => `events/${eid}/slots/${slotId}`,
  queue: (eid: string, slotId: string) => `events/${eid}/queues/${slotId}`,
  board: (eid: string) => `events/${eid}/board/public`,
  tickets: (eid: string) => `events/${eid}/tickets`,
  ticket: (eid: string, ticketId: string) => `events/${eid}/tickets/${ticketId}`,
  visitor: (eid: string, uid: string) => `events/${eid}/visitors/${uid}`,
  staff: (eid: string, uid: string) => `events/${eid}/staff/${uid}`,
  rateLimit: (eid: string, key: string) => `events/${eid}/rateLimits/${key}`,
  auditLog: (eid: string) => `events/${eid}/auditLog`,
  /** 運営アカウント（イベントに属さない） */
  operator: (loginId: string) => `operators/${loginId}`,
  operators: 'operators',
  operatorAudit: 'operatorAudit',
  /** 運営ログインの試行制限（コレクション名 rateLimits の TTL をそのまま使う） */
  authRateLimit: (key: string) => `rateLimits/${key}`,
  stats: (eid: string, date: string) => `events/${eid}/stats/${date}`,
} as const;

export const storagePaths = {
  /** プロフィール画像。クライアントは getBlob() で取得し、公開 URL は使わない */
  avatar: (eid: string, slotId: string) => `events/${eid}/avatars/${slotId}`,
} as const;
