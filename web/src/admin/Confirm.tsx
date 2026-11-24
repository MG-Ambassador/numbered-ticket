// 取り返しのつかない操作の前の確認（A-05「確認を挟む」）
import { useState, type ReactNode } from 'react';

interface Ask {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  run: () => Promise<void>;
}

export function useConfirm() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);

  const element = ask && (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && !busy && setAsk(null)}>
      <div className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="grip" />
        <span className="hl" id="confirm-title">
          {ask.title}
        </span>
        <div className="p small">{ask.body}</div>
        <button
          className={ask.danger ? 'btn2 danger' : 'btn'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await ask.run();
            } finally {
              setBusy(false);
              setAsk(null);
            }
          }}
        >
          {ask.confirmLabel}
        </button>
        <button className={ask.danger ? 'btn' : 'btn2'} disabled={busy} onClick={() => setAsk(null)}>
          やめる
        </button>
      </div>
    </div>
  );
  return { confirm: setAsk, element };
}
