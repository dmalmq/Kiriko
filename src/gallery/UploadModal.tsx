import { useRef, useState, type DragEvent } from "react";
import type { LocaleCode } from "../imdf/types";
import { api, publishErrorMessage } from "./api";
import { IconClose } from "../components/icons";

const ui = {
  titleVersion: { ja: "IMDF バージョンをアップロード", en: "Upload IMDF version" },
  title: { ja: "ローカルデータを開く", en: "Open local data" },
  dropTitle: { ja: "IMDF ZIP", en: "IMDF ZIP" },
  dropHint: { ja: "ドロップまたはクリックで選択", en: "Drop or click to choose" },
  nameLabel: { ja: "データセット名", en: "Dataset name" },
  publish: { ja: "公開", en: "Publish" },
  uploading: { ja: "アップロード中", en: "Uploading" },
  processing: { ja: "検証・公開処理中…", en: "Validating and publishing…" },
  processingContinues: {
    ja: "公開処理はサーバーで続いています。しばらくしてから一覧を更新してください。",
    en: "Publishing is still running on the server. Refresh the list again shortly.",
  },
  checkStatus: { ja: "状況を確認", en: "Check status" },
  published: { ja: "公開しました", en: "Published" },
  open: { ja: "開く", en: "Open" },
  close: { ja: "閉じる", en: "Close" },
  cancel: { ja: "キャンセル", en: "Cancel" },
} as const;

export interface UploadModalTarget {
  venueId: number;
  venueName: string;
  slug: string;
}

export interface UploadModalProps {
  locale: LocaleCode;
  onClose: () => void;
  onPublished: () => void;
  target?: UploadModalTarget;
}

interface AcceptedUploadJob {
  jobId: string;
  slug: string;
  createdVenueId: number | null;
}

type Phase =
  | { step: "form" }
  | { step: "uploading"; fraction: number }
  | { step: "processing"; accepted: AcceptedUploadJob }
  | { step: "accepted"; accepted: AcceptedUploadJob; message: string }
  | { step: "done"; slug: string }
  | { step: "failed"; message: string };

export function UploadModal({ locale, onClose, onPublished, target }: UploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(target?.venueName ?? "");
  const [phase, setPhase] = useState<Phase>({ step: "form" });
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const acceptFile = (candidate: File | undefined) => {
    if (!candidate || !candidate.name.toLowerCase().endsWith(".zip")) {
      return;
    }
    setFile(candidate);
    if (!target && name === "") {
      setName(candidate.name.replace(/\.zip$/i, ""));
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    acceptFile(event.dataTransfer.files[0]);
  };

  const checkAccepted = (accepted: AcceptedUploadJob) => {
    setPhase({ step: "processing", accepted });
    void (async () => {
      try {
        const job = await api.waitForJob(accepted.jobId);
        if (job.status === "done") {
          setPhase({ step: "done", slug: accepted.slug });
          onPublished();
        } else if (job.status === "timeout") {
          setPhase({ step: "accepted", accepted, message: ui.processingContinues[locale] });
        } else {
          if (accepted.createdVenueId !== null) {
            try {
              await api.deleteVenue(accepted.createdVenueId);
            } catch {
              /* best effort */
            }
          }
          setPhase({ step: "failed", message: publishErrorMessage(job.error) });
        }
      } catch {
        setPhase({ step: "accepted", accepted, message: ui.processingContinues[locale] });
      }
    })();
  };

  const submit = () => {
    if (phase.step === "accepted") {
      checkAccepted(phase.accepted);
      return;
    }
    if (!file) return;
    if (!target && name.trim() === "") return;
    setPhase({ step: "uploading", fraction: 0 });
    void (async () => {
      let createdVenueId: number | null = null;
      try {
        let venueId: number;
        let slug: string;
        if (target) {
          venueId = target.venueId;
          slug = target.slug;
        } else {
          const venue = await api.createVenue(name.trim());
          createdVenueId = venue.id;
          venueId = venue.id;
          slug = venue.slug;
        }
        const { jobId } = await api.uploadVersion(venueId, file, (fraction) => {
          setPhase({ step: "uploading", fraction });
        });
        checkAccepted({ jobId, slug, createdVenueId });
      } catch (error) {
        if (createdVenueId !== null) {
          try {
            await api.deleteVenue(createdVenueId);
          } catch {
            /* best effort */
          }
        }
        setPhase({
          step: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  const busy = phase.step === "uploading" || phase.step === "processing";
  const locked = busy || phase.step === "accepted";
  const closeDisabled = busy || phase.step === "accepted";
  const close = () => {
    if (!closeDisabled) onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="upload-modal" role="dialog" aria-label={(target ? ui.titleVersion : ui.title)[locale]}>
        <header className="upload-modal__header">
          <h2 className="upload-modal__title">
            {(target ? ui.titleVersion : ui.title)[locale]}
          </h2>
          <button type="button" className="floating-panel__close" aria-label={ui.close[locale]} onClick={close} disabled={closeDisabled}>
            <IconClose />
          </button>
        </header>

        {phase.step === "done" ? (
          <div className="upload-modal__done">
            <p className="upload-modal__published">{ui.published[locale]}</p>
            <div className="upload-modal__footer">
              <button type="button" className="btn-ghost" onClick={close}>
                {ui.close[locale]}
              </button>
              <a className="btn-primary" href={`/?dataset=${encodeURIComponent(phase.slug)}`}>
                {ui.open[locale]}
              </a>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={dragActive ? "drop-target drop-target--active" : "drop-target"}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => {
                setDragActive(false);
              }}
              onDrop={onDrop}
              disabled={locked}
            >
              <span className="drop-target__title">{file ? file.name : ui.dropTitle[locale]}</span>
              <span className="drop-target__hint">{ui.dropHint[locale]}</span>
            </button>
            <input
              ref={inputRef}
              className="imdf-dropzone__input"
              type="file"
              accept=".zip,application/zip"
              aria-label={ui.dropTitle[locale]}
              disabled={locked}
              onChange={(event) => {
                acceptFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <label className="upload-modal__name">
              <span>{ui.nameLabel[locale]}</span>
              <div className="kiriko-input">
                <input
                  aria-label={ui.nameLabel[locale]}
                  value={target ? target.venueName : name}
                  disabled={locked}
                  readOnly={Boolean(target)}
                  onChange={(event) => {
                    if (target) return;
                    setName(event.target.value);
                  }}
                />
              </div>
            </label>

            {phase.step === "uploading" ? (
              <div className="upload-modal__progress">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${Math.round(phase.fraction * 100)}%` }} />
                </div>
                <span>{ui.uploading[locale]}…</span>
              </div>
            ) : null}
            {phase.step === "processing" ? <p className="upload-modal__processing">{ui.processing[locale]}</p> : null}
            {phase.step === "accepted" ? <p className="upload-modal__processing" role="status">{phase.message}</p> : null}
            {phase.step === "failed" ? (
              <p className="upload-modal__error" role="alert">
                {phase.message}
              </p>
            ) : null}

            <div className="upload-modal__footer">
              <button type="button" className="btn-ghost" onClick={close} disabled={closeDisabled}>
                {ui.cancel[locale]}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={submit}
                disabled={busy || (phase.step !== "accepted" && (!file || (!target && name.trim() === "")))}
              >
                {phase.step === "accepted" ? ui.checkStatus[locale] : ui.publish[locale]}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
