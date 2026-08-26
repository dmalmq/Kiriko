import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatasetCard } from "./DatasetCard";
import type { VenueSummary } from "./api";

const venue: VenueSummary = {
  id: 3,
  slug: "tokyo-station",
  name: "Tokyo Station",
  createdAt: "2026-07-20 00:00:00",
  latest: {
    seq: 1,
    publicVersionId: "a".repeat(64),
    status: "published",
    stats: { levels: 2, features: 10 },
    createdAt: "2026-07-20 00:00:00",
  },
};

describe("DatasetCard", () => {
  it("shows Import GDB and calls onImportGdb when provided", () => {
    const onImportGdb = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onImportGdb={onImportGdb}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import GDB" }));
    expect(onImportGdb).toHaveBeenCalledTimes(1);
  });

  it("hides Import GDB when onImportGdb is omitted", () => {
    render(
      <DatasetCard venue={venue} locale="en" onOpen={() => {}} onDelete={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Import GDB" })).toBeNull();
  });

  it("uses Japanese label when locale is ja", () => {
    render(
      <DatasetCard
        venue={venue}
        locale="ja"
        onOpen={() => {}}
        onDelete={() => {}}
        onImportGdb={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "GDB を取り込む" })).toBeTruthy();
  });

  it("shows Upload IMDF and calls onUploadImdf when provided", () => {
    const onUploadImdf = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onUploadImdf={onUploadImdf}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload IMDF" }));
    expect(onUploadImdf).toHaveBeenCalledTimes(1);
  });

  it("hides Upload IMDF when onUploadImdf is omitted", () => {
    render(
      <DatasetCard venue={venue} locale="en" onOpen={() => {}} onDelete={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Upload IMDF" })).toBeNull();
  });

  it("uses Japanese Upload IMDF label when locale is ja", () => {
    render(
      <DatasetCard
        venue={venue}
        locale="ja"
        onOpen={() => {}}
        onDelete={() => {}}
        onUploadImdf={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "IMDF をアップロード" })).toBeTruthy();
  });

  it("shows Add routing / facilities and calls onAddData when provided", () => {
    const onAddData = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onAddData={onAddData}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add routing / facilities" }));
    expect(onAddData).toHaveBeenCalledTimes(1);
  });

  it("hides Add routing / facilities when onAddData is omitted", () => {
    render(
      <DatasetCard venue={venue} locale="en" onOpen={() => {}} onDelete={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Add routing / facilities" })).toBeNull();
  });

  it("shows Edit mapping and calls onEditMapping when provided", () => {
    const onEditMapping = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onEditMapping={onEditMapping}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit mapping" }));
    expect(onEditMapping).toHaveBeenCalledTimes(1);
  });

  it("hides Edit mapping when onEditMapping is omitted", () => {
    render(
      <DatasetCard venue={venue} locale="en" onOpen={() => {}} onDelete={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Edit mapping" })).toBeNull();
  });

  it("shows Generate routing and calls onGenerateRouting when provided", () => {
    const onGenerateRouting = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onGenerateRouting={onGenerateRouting}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate routing" }));
    expect(onGenerateRouting).toHaveBeenCalledTimes(1);
  });

  it("uses the regenerate label when generateRoutingLabel is provided", () => {
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onGenerateRouting={() => {}}
        generateRoutingLabel="Regenerate routing"
      />,
    );
    expect(screen.getByRole("button", { name: "Regenerate routing" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate routing" })).toBeNull();
  });

  it("hides Generate routing when onGenerateRouting is omitted", () => {
    render(<DatasetCard venue={venue} locale="en" onOpen={() => {}} onDelete={() => {}} />);
    expect(screen.queryByRole("button", { name: "Generate routing" })).toBeNull();
  });

  it("shows Regenerate 3D and calls onRegenerateScene when provided", () => {
    const onRegenerateScene = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onRegenerateScene={onRegenerateScene}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Regenerate 3D" }));
    expect(onRegenerateScene).toHaveBeenCalledTimes(1);
  });

  it("uses the in-flight label when regenerateSceneLabel is provided", () => {
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onRegenerateScene={() => {}}
        regenerateSceneLabel="Check status"
      />,
    );
    expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Regenerate 3D" })).toBeNull();
  });

  it("labels Regenerate 3D in Japanese when locale is ja", () => {
    render(
      <DatasetCard
        venue={venue}
        locale="ja"
        onOpen={() => {}}
        onDelete={() => {}}
        onRegenerateScene={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "3Dを再生成" })).toBeTruthy();
  });

  it("hides Regenerate 3D when onRegenerateScene is omitted", () => {
    render(<DatasetCard venue={venue} locale="en" onOpen={() => {}} onDelete={() => {}} />);
    expect(screen.queryByRole("button", { name: "Regenerate 3D" })).toBeNull();
  });

  it("shows Export network and calls onExportNetwork when provided", () => {
    const onExportNetwork = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onExportNetwork={onExportNetwork}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export network" }));
    expect(onExportNetwork).toHaveBeenCalledTimes(1);
  });

  it("hides Export network when onExportNetwork is omitted", () => {
    render(<DatasetCard venue={venue} locale="en" onOpen={() => {}} onDelete={() => {}} />);
    expect(screen.queryByRole("button", { name: "Export network" })).toBeNull();
  });

  it("shows Review network and calls onReviewNetwork when provided", () => {
    const onReviewNetwork = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onReviewNetwork={onReviewNetwork}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review network" }));
    expect(onReviewNetwork).toHaveBeenCalledTimes(1);
  });

  it("hides Review network when onReviewNetwork is omitted", () => {
    render(<DatasetCard venue={venue} locale="en" onOpen={() => {}} onDelete={() => {}} />);
    expect(screen.queryByRole("button", { name: "Review network" })).toBeNull();
  });

  it("shows Open in 3D and calls onView3d when provided", () => {
    const onView3d = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onView3d={onView3d}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in 3D" }));
    expect(onView3d).toHaveBeenCalledTimes(1);
  });

  it("hides Open in 3D when onView3d is omitted", () => {
    // Omitted covers both refusals: a device below the 3D floor, and a venue
    // with no published version to render.
    render(<DatasetCard venue={venue} locale="en" onOpen={() => {}} onDelete={() => {}} />);
    expect(screen.queryByRole("button", { name: "Open in 3D" })).toBeNull();
  });

  it("labels the 3D action in Japanese when locale is ja", () => {
    render(
      <DatasetCard
        venue={venue}
        locale="ja"
        onOpen={() => {}}
        onDelete={() => {}}
        onView3d={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "3D で開く" })).toBeTruthy();
  });

  it("shows 3D Tiles and calls onManageTiles when provided", () => {
    const onManageTiles = vi.fn();
    render(
      <DatasetCard
        venue={venue}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onManageTiles={onManageTiles}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "3D Tiles" }));
    expect(onManageTiles).toHaveBeenCalledTimes(1);
  });

  it("chips a venue whose latest version renders tiles", () => {
    render(
      <DatasetCard
        venue={{ ...venue, tiles: { packages: 1, activeOnLatest: true } }}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText("3D Tiles live")).toBeTruthy();
  });

  it("distinguishes holding a package from rendering one", () => {
    // Activation is explicit, so this state lasts as long as the producer takes
    // to decide. A card that chipped both the same way would be lying.
    render(
      <DatasetCard
        venue={{ ...venue, tiles: { packages: 2, activeOnLatest: false } }}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText("3D Tiles inactive")).toBeTruthy();
    expect(screen.queryByText("3D Tiles live")).toBeNull();
  });

  it("chips nothing for a venue with no packages", () => {
    render(
      <DatasetCard
        venue={{ ...venue, tiles: { packages: 0, activeOnLatest: false } }}
        locale="en"
        onOpen={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByText(/3D Tiles/)).toBeNull();
  });
});
