/**
 * Producer-facing copy for a blocked tile activation (#74).
 *
 * A gate is not a bug report. Each message says what about the producer's own
 * export stopped it and, where the gate is numeric, how far outside the band it
 * measured — a producer deciding whether to re-export or to widen a floor's
 * band needs the gap, not the verdict.
 *
 * The subject travels separately from the sentence: it is a canonical floor id,
 * a composite level identity, or a source object id, and none of those are
 * translatable.
 */
import type { LocaleCode } from "../imdf/types";

/** One blocked gate, as the activation endpoint reports it. */
export interface TileActivationGate {
  code: string;
  subject: string;
  measured: number | null;
  band: number | null;
}

const TILE_GATE_COPY: Record<string, { ja: string; en: string } | undefined> = {
  integrityUnresolved: {
    ja: "パッケージの一部が保管庫にありません。取り込み直してください。",
    en: "Part of the package is missing from storage. Ingest it again.",
  },
  capabilityProfileMissing: {
    ja: "対応環境のプロファイルが記録されていません。有効化の前に選択してください。",
    en: "No capability profile was recorded. Choose one before activating.",
  },
  registrationOutOfBand: {
    ja: "この階の位置ずれが許容範囲を超えています。",
    en: "This floor sits further from the venue geometry than its band allows.",
  },
  coherentShiftOutOfBand: {
    ja: "この階が一方向にずれています。ノイズではなく位置合わせの問題です。",
    en: "This floor is displaced in one direction — not noise, but registration.",
  },
  coherentResidual: {
    ja: "限られた範囲でまとまった大きなずれがあります。",
    en: "A localised area disagrees with the venue geometry by a large, consistent amount.",
  },
  levelPlaneUnresolved: {
    ja: "この階の床面をタイル形状から求められません。床のジオメトリが含まれているか確認してください。",
    en: "No floor plane could be read from this level's surfaces. Check that floor geometry was exported.",
  },
  levelNotMapped: {
    ja: "この階に対応する会場のフロアがありません。標高のオフセットを確認してください。",
    en: "No venue floor corresponds to this level. Check the profile's vertical offset.",
  },
  unclassifiedOpaqueContent: {
    ja: "フロアに属さない不透明な要素です。コンテキストとして分類してください。",
    en: "This opaque element belongs to no floor. Classify it as context before activating.",
  },
};

/** Every gate the copy table answers for. */
export const TILE_GATE_CODES: readonly string[] = Object.keys(TILE_GATE_COPY);

/**
 * The producer-facing message for a blocked gate: what stopped it, on what, and
 * — when the gate is numeric — the measurement beside the band it failed.
 */
export function tileGateMessage(gate: TileActivationGate, locale: LocaleCode): string {
  const copy = TILE_GATE_COPY[gate.code];
  const base =
    copy?.[locale] ??
    (locale === "ja" ? "有効化できませんでした。" : "The package cannot be activated.");
  const measurement =
    gate.measured !== null && gate.band !== null
      ? locale === "ja"
        ? `（${gate.subject}：${gate.measured.toFixed(2)} m／許容 ${gate.band.toFixed(2)} m）`
        : ` (${gate.subject}: ${gate.measured.toFixed(2)} m against ${gate.band.toFixed(2)} m)`
      : locale === "ja"
        ? `（${gate.subject}）`
        : ` (${gate.subject})`;
  return `${base}${measurement}`;
}

/**
 * Producer-facing copy for the tile routes' own refusals, as distinct from a
 * gate: a gate is a measurement about the package, these are about the request.
 *
 * `no_published_version` is the one that is not a failure. Registration measures
 * against the venue's own canonical geometry, and there is none until something
 * is published — so the copy says what to do rather than offering a retry.
 */
const TILE_ERROR_COPY: Record<string, { ja: string; en: string } | undefined> = {
  file_required: {
    ja: "アップロードするファイルを選択してください。",
    en: "Choose a file to upload.",
  },
  venue_not_found: {
    ja: "この会場は見つかりません。",
    en: "This venue no longer exists.",
  },
  package_not_found: {
    ja: "このパッケージは見つかりません。削除された可能性があります。",
    en: "This package no longer exists. It may have been discarded.",
  },
  package_in_use: {
    ja: "公開済みのバージョンが使用中のため削除できません。",
    en: "A published version serves this package, so it cannot be discarded.",
  },
  no_published_version: {
    ja: "位置合わせは会場自身のデータに対して測ります。先に IMDF か GDB を公開してください。",
    en: "Registration is measured against the venue's own data. Publish IMDF or GDB first.",
  },
  not_evaluated: {
    ja: "先に位置合わせを実行してください。",
    en: "Run registration before activating.",
  },
  evaluation_stale: {
    ja: "この会場はその後公開されています。現在のジオメトリに対して測り直してください。",
    en: "The venue has published since. Measure again against its current geometry.",
  },
  activation_blocked: {
    ja: "ゲートにより有効化できません。",
    en: "A gate blocks activation.",
  },
  unsafe_archive_path: {
    ja: "パッケージの外を参照する項目が含まれています。",
    en: "The package contains an entry that points outside itself.",
  },
  invalid_archive: {
    ja: "この ZIP は暗号化・破損しているか、記録が矛盾しています。",
    en: "This ZIP is encrypted, damaged, or has conflicting archive records.",
  },
};

/**
 * The message for a route refusal. An unknown code never leaks a server string:
 * internal messages are not producer copy, and a raw code is not either.
 */
export function tileErrorMessage(code: string, locale: LocaleCode): string {
  return (
    TILE_ERROR_COPY[code]?.[locale] ??
    (locale === "ja"
      ? "処理できませんでした。もう一度お試しください。"
      : "That could not be completed. Try again.")
  );
}
