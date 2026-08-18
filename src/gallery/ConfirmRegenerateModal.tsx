import type { ReactElement } from "react";
import type { LocaleCode } from "../imdf/types";

const ui = {
  title: { ja: "経路を再生成しますか？", en: "Regenerate routing?" },
  body: {
    ja: "会場の形状から新しいバージョンを作ります。今のネットワークは前のバージョンに残ります。",
    en: "This creates a new version from the venue geometry. The current network stays on the previous version.",
  },
  cancel: { ja: "キャンセル", en: "Cancel" },
  confirm: { ja: "再生成", en: "Regenerate" },
} as const;

export interface ConfirmRegenerateModalProps {
  locale: LocaleCode;
  venueName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmRegenerateModal({
  locale,
  venueName,
  onConfirm,
  onCancel,
}: ConfirmRegenerateModalProps): ReactElement {
  return (
    <div className="modal-overlay">
      <div className="confirm-modal" role="alertdialog" aria-label={ui.title[locale]}>
        <h2 className="confirm-modal__title">{ui.title[locale]}</h2>
        <p className="confirm-modal__body">
          <strong>{venueName}</strong>
          {" — "}
          {ui.body[locale]}
        </p>
        <div className="confirm-modal__footer">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {ui.cancel[locale]}
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm}>
            {ui.confirm[locale]}
          </button>
        </div>
      </div>
    </div>
  );
}
