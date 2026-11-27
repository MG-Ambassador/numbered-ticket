// 来場者・スタッフで共通の小さな部品（docs/mockup.html と同じ見た目）
import type { ReactNode } from 'react';
import { BOARD_STATUS_LABELS, type BoardSlot, type BoardStatus } from '@nt/shared';

const ICONS = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  undo: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  vol: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

export function Chip({ kind, icon, children }: { kind: string; icon?: IconName; children: ReactNode }) {
  return (
    <span className={`st st-${kind}`}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

const STATUS_ICON: Partial<Record<BoardStatus, IconName>> = { available: 'check', paused: 'pause' };

/** 枠の状態（V-02）。色だけでなく文言でも示す */
export function StatusChip({ slot }: { slot: Pick<BoardSlot, 'status'> }) {
  return (
    <Chip kind={slot.status} icon={STATUS_ICON[slot.status]}>
      {BOARD_STATUS_LABELS[slot.status]}
    </Chip>
  );
}

export function Notice({ kind, icon, children, onClose }: { kind: 'info' | 'warn' | 'danger' | 'ok'; icon: IconName; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`notice n-${kind}`} role={kind === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <span>{children}</span>
      {onClose && (
        <button className="x" onClick={onClose} aria-label="お知らせを閉じる">
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  );
}

export function Switch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button className="sw" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Loading({ text = '読み込んでいます' }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <span className="hl">{text}</span>
      <span className="small">そのまま少しお待ちください。</span>
    </div>
  );
}

/** 相談員の頭文字アイコン */
export function Avatar({ name, off }: { name: string; off?: boolean }) {
  return (
    <span className={`win${off ? ' off' : ''}`} aria-hidden="true">
      {name.charAt(0)}
    </span>
  );
}

export function Header({ eyebrow }: { eyebrow: string }) {
  return (
    <div className="between">
      <span className="eyebrow">{eyebrow}</span>
      <span className="mg">MG</span>
    </div>
  );
}
