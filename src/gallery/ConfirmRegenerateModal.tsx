import type { ReactElement } from "react";
import type { LocaleCode } from "../imdf/types";

const routingCopy = {
  title: { ja: "経路を再生成しますか？", en: "Regenerate routing?" },
  body: {
    ja: "会場の形状から新しいバージョンを作ります。今のネットワークは前のバージョンに残ります。",
    en: "This creates a new version from the venue geometry. The current network stays on the previous version.",
  },
} as const;

const sceneCopy = {
  title: { ja: "3Dを再生成しますか？", en: "Regenerate 3D?" },
  body: {
    ja: "会場の形状から新しいバージョンを作ります。経路ネットワークは今の状態のまま新しいバージョンに引き継がれます。",
    en: "This creates a new version from the venue geometry. Routing stays on the new version as it is now.",
  },
  tilesNote: {
    ja: "有効な 3D タイルは前のバージョンに残ります。新しいバージョンで使うには再有効化してください。",
    en: "Activated 3D Tiles stay on the previous version. Re-activate them on the new version if you still need them.",
  },
} as const;

const shared = {
  cancel: { ja: "キャンセル", en: "Cancel" },
  confirm: { ja: "再生成", en: "Regenerate" },
} as const;

export interface ConfirmRegenerateModalProps {
  locale: LocaleCode;
  venueName: string;
  kind?: "routing" | "scene";
  tilesActive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmRegenerateModal({
  locale,
  venueName,
  kind = "routing",
  tilesActive = false,
  onConfirm,
  onCancel,
}: ConfirmRegenerateModalProps): ReactElement {
  const copy = kind === "scene" ? sceneCopy : routingCopy;
  return (
    <div className="modal-overlay">
      <div className="confirm-modal" role="alertdialog" aria-label={copy.title[locale]}>
        <h2 className="confirm-modal__title">{copy.title[locale]}</h2>
        <p className="confirm-modal__body">
          <strong>{venueName}</strong>
          {" — "}
          {copy.body[locale]}
        </p>
        {kind === "scene" && tilesActive ? (
          <p className="confirm-modal__body">{sceneCopy.tilesNote[locale]}</p>
        ) : null}
        <div className="confirm-modal__footer">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {shared.cancel[locale]}
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm}>
            {shared.confirm[locale]}
          </button>
        </div>
      </div>
    </div>
  );
}
