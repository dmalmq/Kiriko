/**
 * Producer-facing copy for a refused tile package (#71).
 *
 * Each refusal names the part of the export to look at, in the producer's own
 * language, and never the internals: "references something outside the package"
 * is actionable, "unresolved URI graph node" is not. The offending path travels
 * in `details`, so the message stays stable while the specifics vary.
 */
import type { LocaleCode } from "../imdf/types";

/** A refusal as the ingestion endpoint reports it. */
export interface TilePackageError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const TILE_ERROR_COPY: Record<string, { ja: string; en: string } | undefined> = {
  missingRootTileset: {
    ja: "パッケージに tileset.json が見つかりません。ルートに配置してください。",
    en: "The package has no tileset.json at its root.",
  },
  malformedTileset: {
    ja: "tileset を読み取れませんでした。JSON が壊れていないか確認してください。",
    en: "A tileset could not be read. Check that its JSON is intact.",
  },
  unsupportedAssetVersion: {
    ja: "この 3D Tiles バージョンには対応していません（1.0 と 1.1 に対応）。",
    en: "That 3D Tiles version is not supported (1.0 and 1.1 are).",
  },
  unsupportedExtension: {
    ja: "対応していない拡張が宣言されています。書き出し設定を確認してください。",
    en: "The package declares an extension Kiriko cannot honour. Check the export settings.",
  },
  unsupportedFeature: {
    ja: "対応していないタイル構成（implicit tiling など）が使われています。",
    en: "The package uses a tiling feature Kiriko cannot traverse, such as implicit tiling.",
  },
  pathTraversal: {
    ja: "パッケージの外を指す参照が含まれています。",
    en: "The package contains a reference that points outside itself.",
  },
  absolutePath: {
    ja: "絶対パスの参照が含まれています。相対パスで書き出してください。",
    en: "The package references an absolute path. Export with relative paths.",
  },
  externalReference: {
    ja: "外部 URL への参照が含まれています。すべての内容をパッケージに含めてください。",
    en: "The package references an external URL. Every member must be inside the package.",
  },
  unresolvedMember: {
    ja: "参照先のファイルがパッケージに含まれていません。",
    en: "The package references a file it does not contain.",
  },
  unsupportedContentFormat: {
    ja: "対応していないコンテンツ形式です（glTF バイナリ .glb に対応）。",
    en: "That content format is not supported. Kiriko reads glTF binary (.glb).",
  },
  undecodableContent: {
    ja: "コンテンツを読み取れませんでした。書き出しが完了しているか確認してください。",
    en: "A content file could not be read. Check that the export completed.",
  },
  tilesetCycle: {
    ja: "tileset が自分自身を参照しています。",
    en: "The tileset graph references itself.",
  },
  tilesetTooDeep: {
    ja: "tileset の入れ子が深すぎます。",
    en: "The tileset graph nests too deeply.",
  },
  sizeMismatch: {
    ja: "アーカイブ内のサイズ情報が実際のデータと一致しません。再作成してください。",
    en: "An entry's declared size disagrees with its bytes. Rebuild the archive.",
  },
  memberTooLarge: {
    ja: "個別ファイルが処理上限を超えています。",
    en: "A single member is over the size limit.",
  },
  tooManyMembers: {
    ja: "パッケージ内のファイル数が処理上限を超えています。",
    en: "The package holds more files than Kiriko will process.",
  },
  packageTooLarge: {
    ja: "パッケージ全体が処理上限を超えています。",
    en: "The package is over the size limit.",
  },
  unreadableArchive: {
    ja: "アーカイブを読み取れませんでした。ZIP が壊れていないか確認してください。",
    en: "The archive could not be read. Check that the ZIP is intact.",
  },
  venue_not_found: {
    ja: "会場が見つかりません。",
    en: "That venue does not exist.",
  },
  file_required: {
    ja: "パッケージを選択してください。",
    en: "Choose a package to upload.",
  },
  unauthorized: {
    ja: "サインインしてからもう一度試してください。",
    en: "Sign in and try again.",
  },
  forbidden: {
    ja: "タイルパッケージを取り込む権限がありません。",
    en: "You do not have permission to ingest tile packages.",
  },
  bridge_error: {
    ja: "パッケージを検証できませんでした。もう一度試してください。",
    en: "The package could not be validated. Try again.",
  },
  internal_error: {
    ja: "パッケージを取り込めませんでした。もう一度試してください。",
    en: "The package could not be ingested. Try again.",
  },
  package_not_found: {
    ja: "そのパッケージはこの会場にありません。",
    en: "That package does not belong to this venue.",
  },
  package_in_use: {
    ja: "公開済みのバージョンが使用しているため削除できません。",
    en: "A published version renders this package, so it cannot be discarded.",
  },
  no_published_version: {
    ja: "先に会場データを公開してください。位置合わせは会場自身の形状に対して測ります。",
    en: "Publish the venue first: registration is measured against its own geometry.",
  },
  not_evaluated: {
    ja: "先に位置合わせを実行してください。",
    en: "Run registration before activating.",
  },
  activation_blocked: {
    ja: "有効化を妨げる項目が残っています。",
    en: "Something still blocks activation.",
  },
  evaluation_stale: {
    ja: "会場データが更新されました。位置合わせをやり直してください。",
    en: "The venue has published since this was measured. Run registration again.",
  },
  no_spatial_context: {
    ja: "このバージョンには空間基準がありません。会場を再公開してください。",
    en: "This version carries no spatial frame to register against. Republish the venue.",
  },
  undecodable_content: {
    ja: "タイルの内容を読み取れませんでした。書き出しが完了しているか確認してください。",
    en: "The tile content could not be read. Check that the export completed.",
  },
  malformed_request: {
    ja: "位置合わせの設定を読み取れませんでした。",
    en: "The registration settings could not be read.",
  },
};

/** Every refusal code the copy table answers for. */
export const TILE_ERROR_CODES: readonly string[] = Object.keys(TILE_ERROR_COPY);

/**
 * The producer-facing message for a refusal, with the offending path appended
 * when the refusal named one.
 */
export function tileErrorMessage(error: TilePackageError, locale: LocaleCode): string {
  const copy = TILE_ERROR_COPY[error.code];
  const base =
    copy?.[locale] ??
    (locale === "ja"
      ? "タイルパッケージを取り込めませんでした。"
      : "The tile package could not be ingested.");
  const path = error.details?.["path"] ?? error.details?.["uri"];
  return typeof path === "string" && path !== "" ? `${base}（${path}）` : base;
}
