import { useEffect, useId, useRef } from "react";
import { gdbErrorMessage, type GdbError } from "./api";
import { facilitiesSummaryText, routingSummaryText } from "./GdbImportDialog";
import type { LocaleCode } from "../imdf/types";
import type { FacilitiesInspectResponse, NetworkInspectResponse } from "../gdb/types";

const ui = {
  title: { ja: "経路・地点データを追加", en: "Add routing / facilities" },
  hint: {
    ja: "既存データの形状を再利用し、経路・地点データを追加した新しいバージョンを作成します。",
    en: "Creates a new version reusing the existing geometry, with routing / point data added.",
  },
  addNetwork: { ja: "ルーティングネットワークを追加", en: "Add routing network" },
  addFacilities: { ja: "地点施設を追加", en: "Add point facilities" },
  cancel: { ja: "キャンセル", en: "Cancel" },
  import: { ja: "追加", en: "Add" },
} as const;

/**
 * Focused dialog for attaching routing and/or point-facility `.gdb.zip` data
 * to an already-published dataset. The venue geometry is reused server-side;
 * this only collects the network/facilities archives and their summaries.
 * Import is enabled once at least one of them is attached.
 */
export interface AddDataDialogProps {
  locale: LocaleCode;
  venueName: string;
  network: NetworkInspectResponse | null;
  facilities: FacilitiesInspectResponse | null;
  busy: boolean;
  error: GdbError | null;
  onAddNetwork: (file: File) => void;
  onAddFacilities: (file: File) => void;
  onImport: () => void;
  actionLabel?: string | undefined;
  canSubmit?: boolean | undefined;
  cancelDisabled?: boolean | undefined;
  cancelLocked?: boolean | undefined;
  onCancel: () => void;
}

export function AddDataDialog({
  locale,
  venueName,
  network,
  facilities,
  busy,
  error,
  onAddNetwork,
  onAddFacilities,
  onImport,
  onCancel,
  actionLabel,
  canSubmit,
  cancelDisabled = false,
  cancelLocked = false,
}: AddDataDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const locked = cancelDisabled || cancelLocked;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.open = true;
    }
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      if (!locked) onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [locked, onCancel]);

  const canImport = !busy && (canSubmit ?? (network !== null || facilities !== null));

  return (
    <dialog
      ref={dialogRef}
      className="gdb-dialog"
      aria-labelledby={headingId}
      onClick={(event) => {
        if (event.target === dialogRef.current && !locked) onCancel();
      }}
    >
      <form
        method="dialog"
        className="gdb-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canImport) onImport();
        }}
      >
        <h2 id={headingId} className="gdb-dialog__title">
          {ui.title[locale]}
        </h2>
        <section className="gdb-dialog__section">
          <p className="gdb-dialog__summary">{venueName}</p>
          <p className="gdb-dialog__summary">{ui.hint[locale]}</p>
          <label className="gdb-dialog__btn gdb-dialog__network-add">
            {ui.addNetwork[locale]}
            <input
              type="file"
              accept=".zip,.gdb.zip"
              style={{ display: "none" }}
              aria-label={ui.addNetwork[locale]}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onAddNetwork(file);
                event.target.value = "";
              }}
            />
          </label>
          {network ? (
            <p className="gdb-dialog__network-summary">
              {routingSummaryText[locale](network.nodeCount, network.edgeCount, network.floors.length)}
            </p>
          ) : null}
          <label className="gdb-dialog__btn gdb-dialog__facilities-add">
            {ui.addFacilities[locale]}
            <input
              type="file"
              accept=".zip,.gdb.zip"
              style={{ display: "none" }}
              aria-label={ui.addFacilities[locale]}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onAddFacilities(file);
                event.target.value = "";
              }}
            />
          </label>
          {facilities ? (
            <p className="gdb-dialog__facilities-summary">
              {facilitiesSummaryText[locale](facilities.facilityCount, facilities.floors.length)}
            </p>
          ) : null}
          {error ? (
            <div className="gdb-dialog__error" role="alert">
              <p>{gdbErrorMessage(error, locale)}</p>
            </div>
          ) : null}
          <div className="gdb-dialog__actions">
            <button type="button" className="gdb-dialog__btn" onClick={onCancel} disabled={locked}>
              {ui.cancel[locale]}
            </button>
            <button
              type="submit"
              className="gdb-dialog__btn gdb-dialog__btn--primary"
              disabled={!canImport}
            >
              {actionLabel ?? ui.import[locale]}
            </button>
          </div>
        </section>
      </form>
    </dialog>
  );
}
