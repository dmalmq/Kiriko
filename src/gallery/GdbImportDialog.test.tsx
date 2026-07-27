import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GdbImportDialog } from "./GdbImportDialog";
import type { GdbInspection, GdbMappingPlan, NetworkInspectResponse, FacilitiesInspectResponse } from "../gdb/types";

const inspection: GdbInspection = {
  sourceName: "Station.gdb",
  databases: [{ id: "gdb-1", name: "Station.gdb" }],
  layers: [
    { key: { databaseId: "gdb-1", layerName: "Station_1_Floor" }, databaseName: "Station.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
  ],
  warnings: [],
};

const plan: GdbMappingPlan = {
  venueName: "Station",
  buildings: [{ id: "b1", name: "Station" }],
  layers: [
    { key: { databaseId: "gdb-1", layerName: "Station_1_Floor" }, included: true, targetType: "level", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
  ],
};

const network: NetworkInspectResponse = {
  networkBlobHash: "n".repeat(64),
  nodeCount: 120,
  edgeCount: 340,
  floors: ["1F", "2F"],
};

const facilities: FacilitiesInspectResponse = {
  facilitiesBlobHash: "f".repeat(64),
  facilityCount: 2426,
  floors: ["B1", "F1", "F2"],
};

describe("GdbImportDialog", () => {
  it("imports the plan when there are no blocking issues", () => {
    const onImport = vi.fn();
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport.mock.calls[0]![0].layers[0].targetType).toBe("level");
  });

  it("disables import while a blocking issue exists", () => {
    const brokenPlan = { ...plan, layers: [{ ...plan.layers[0]!, buildingId: null }] };
    render(<GdbImportDialog inspection={inspection} initialPlan={brokenPlan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
    expect((screen.getByRole("button", { name: /import/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the routing network summary when a network is attached", () => {
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="en" busy={false} error={null} network={network} onImport={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByText("Routing network: 120 nodes, 340 paths, 2 floors")).toBeTruthy();
  });

  it("localizes the routing network summary", () => {
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="ja" busy={false} error={null} network={network} onImport={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByText(/ルーティングネットワーク: 120/)).toBeTruthy();
  });

  it("renders no routing summary without a network", () => {
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
    expect(screen.queryByText(/routing network/i)).toBeNull();
  });

  it("notifies when a routing network file is chosen", () => {
    const onAddNetwork = vi.fn();
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="en" busy={false} error={null} onAddNetwork={onAddNetwork} onImport={vi.fn()} onCancel={() => {}} />);
    const input = screen.getByLabelText(/add routing network/i);
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], "net.gdb.zip")] } });
    expect(onAddNetwork).toHaveBeenCalledTimes(1);
  });

  it("shows the facilities summary when facilities are attached", () => {
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="en" busy={false} error={null} facilities={facilities} onImport={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByText("Facilities: 2426 places, 3 floors")).toBeTruthy();
  });

  it("localizes the facilities summary", () => {
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="ja" busy={false} error={null} facilities={facilities} onImport={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByText(/施設: 2426/)).toBeTruthy();
  });

  it("renders no facilities summary without facilities", () => {
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
    expect(screen.queryByText(/facilities:/i)).toBeNull();
  });

  it("notifies when a facilities file is chosen", () => {
    const onAddFacilities = vi.fn();
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="en" busy={false} error={null} onAddFacilities={onAddFacilities} onImport={vi.fn()} onCancel={() => {}} />);
    const input = screen.getByLabelText(/add point facilities/i);
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], "fac.gdb.zip")] } });
    expect(onAddFacilities).toHaveBeenCalledTimes(1);
  });

  it("locks the venue name field when venueNameLocked is true", () => {
    render(
      <GdbImportDialog
        inspection={inspection}
        initialPlan={plan}
        locale="en"
        busy={false}
        error={null}
        venueNameLocked
        onImport={vi.fn()}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByLabelText(/venue name/i) as HTMLInputElement;
    // Prefer getByRole('textbox', { name: /venue name/i }) if label association works.
    expect(input.readOnly || input.disabled).toBe(true);
    expect(input.value).toBe("Station");
  });

  it("excludes a whole building's layers and prunes it from the imported plan", () => {
    const twoBuildingInspection: GdbInspection = {
      sourceName: "Multi.gdb",
      databases: [{ id: "gdb-1", name: "Multi.gdb" }],
      layers: [
        { key: { databaseId: "gdb-1", layerName: "Takanawa_1_Floor" }, databaseName: "Multi.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
        { key: { databaseId: "gdb-1", layerName: "Shinagawa_1_Floor" }, databaseName: "Multi.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
      ],
      warnings: [],
    };
    const twoBuildingPlan: GdbMappingPlan = {
      venueName: "Multi",
      buildings: [
        { id: "b1", name: "Takanawa" },
        { id: "b2", name: "Shinagawa" },
      ],
      layers: [
        { key: { databaseId: "gdb-1", layerName: "Takanawa_1_Floor" }, included: true, targetType: "level", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
        { key: { databaseId: "gdb-1", layerName: "Shinagawa_1_Floor" }, included: true, targetType: "level", buildingId: "b2", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
      ],
    };
    const onImport = vi.fn();
    render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Include Shinagawa" }));
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    expect(onImport).toHaveBeenCalledTimes(1);
    const submitted = onImport.mock.calls[0]![0] as GdbMappingPlan;
    expect(submitted.layers.find((l) => l.buildingId === "b2")!.included).toBe(false);
    expect(submitted.buildings.map((b) => b.id)).toEqual(["b1"]);
  });

  it("shows a building's Include checkbox checked when it has an included layer", () => {
    render(<GdbImportDialog inspection={inspection} initialPlan={plan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
    expect((screen.getByRole("checkbox", { name: "Include Station" }) as HTMLInputElement).checked).toBe(true);
  });

  const twoBuildingPlan: GdbMappingPlan = {
    venueName: "Station",
    buildings: [
      { id: "b1", name: "North" },
      { id: "b2", name: "South" },
    ],
    layers: [
      { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, included: true, targetType: "level", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
      { key: { databaseId: "gdb-1", layerName: "South_1_Floor" }, included: true, targetType: "level", buildingId: "b2", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
    ],
  };

  const twoBuildingInspection: GdbInspection = {
    sourceName: "Station.gdb",
    databases: [{ id: "gdb-1", name: "Station.gdb" }],
    layers: [
      { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, databaseName: "Station.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
      { key: { databaseId: "gdb-1", layerName: "South_1_Floor" }, databaseName: "Station.gdb", featureCount: 5, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
    ],
    warnings: [],
  };

  it("leaves clipping off when every building stays selected", () => {
    const onImport = vi.fn();
    render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    expect(onImport.mock.calls[0]![0].clipToSelection).toBe(false);
  });

  it("auto-enables clipping the first time a building is deselected", () => {
    const onImport = vi.fn();
    render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
    // Exact match: a loose /include south/i regex would also match the layer
    // row's "Include South_1_Floor" checkbox.
    fireEvent.click(screen.getByRole("checkbox", { name: "Include South" }));
    expect((screen.getByLabelText(/clip routing/i) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    expect(onImport.mock.calls[0]![0].clipToSelection).toBe(true);
  });

  it("respects a manual clip choice over the auto-enable", () => {
    const onImport = vi.fn();
    render(<GdbImportDialog inspection={twoBuildingInspection} initialPlan={twoBuildingPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
    // Turn clipping on then off by hand; a later deselection must not re-enable it.
    fireEvent.click(screen.getByLabelText(/clip routing/i));
    fireEvent.click(screen.getByLabelText(/clip routing/i));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include South" }));
    expect((screen.getByLabelText(/clip routing/i) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    expect(onImport.mock.calls[0]![0].clipToSelection).toBe(false);
  });

  const threeBuildingPlan: GdbMappingPlan = {
    venueName: "Station",
    buildings: [
      { id: "b1", name: "North" },
      { id: "b2", name: "South" },
      { id: "b3", name: "East" },
    ],
    layers: [
      { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, included: true, targetType: "level", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
      { key: { databaseId: "gdb-1", layerName: "South_1_Floor" }, included: true, targetType: "level", buildingId: "b2", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
      { key: { databaseId: "gdb-1", layerName: "East_1_Floor" }, included: true, targetType: "level", buildingId: "b3", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
    ],
  };

  const threeBuildingInspection: GdbInspection = {
    sourceName: "Station.gdb",
    databases: [{ id: "gdb-1", name: "Station.gdb" }],
    layers: [
      { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, databaseName: "Station.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
      { key: { databaseId: "gdb-1", layerName: "South_1_Floor" }, databaseName: "Station.gdb", featureCount: 5, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
      { key: { databaseId: "gdb-1", layerName: "East_1_Floor" }, databaseName: "Station.gdb", featureCount: 7, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
    ],
    warnings: [],
  };

  it("treats a manual uncheck as a touch, so a later deselection does not re-enable clipping", () => {
    const onImport = vi.fn();
    render(<GdbImportDialog inspection={threeBuildingInspection} initialPlan={threeBuildingPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
    // Auto-enable fires on the first deselection (clipTouched is still false here).
    fireEvent.click(screen.getByRole("checkbox", { name: "Include South" }));
    expect((screen.getByLabelText(/clip routing/i) as HTMLInputElement).checked).toBe(true);
    // The user manually unchecks it — this must count as a touch even though
    // the box goes from checked to unchecked, not unchecked to checked.
    fireEvent.click(screen.getByLabelText(/clip routing/i));
    expect((screen.getByLabelText(/clip routing/i) as HTMLInputElement).checked).toBe(false);
    // A mutant that only records a touch on check-to-true would treat this
    // deselection as untouched and flip clipping back on; the real
    // implementation must leave it off.
    fireEvent.click(screen.getByRole("checkbox", { name: "Include East" }));
    expect((screen.getByLabelText(/clip routing/i) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    expect(onImport.mock.calls[0]![0].clipToSelection).toBe(false);
  });

  const partialPlan: GdbMappingPlan = {
    venueName: "Station",
    buildings: [{ id: "b1", name: "North" }],
    layers: [
      { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, included: true, targetType: "level", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: "id", ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
      { key: { databaseId: "gdb-1", layerName: "North_1_to_2_detail" }, included: false, targetType: "detail", buildingId: "b1", levelRule: { kind: "layer-name" }, idField: null, ordinalField: null, shortNameField: null, nameField: null, categoryField: null },
    ],
  };

  const partialInspection: GdbInspection = {
    sourceName: "Station.gdb",
    databases: [{ id: "gdb-1", name: "Station.gdb" }],
    layers: [
      { key: { databaseId: "gdb-1", layerName: "North_1_Floor" }, databaseName: "Station.gdb", featureCount: 3, geometryFamily: "polygon", fields: [{ name: "id", type: "String" }] },
      { key: { databaseId: "gdb-1", layerName: "North_1_to_2_detail" }, databaseName: "Station.gdb", featureCount: 2, geometryFamily: "line", fields: [{ name: "id", type: "String" }] },
    ],
    warnings: [],
  };

  it("renders a partially included building as indeterminate", () => {
    render(<GdbImportDialog inspection={partialInspection} initialPlan={partialPlan} locale="en" busy={false} error={null} onImport={vi.fn()} onCancel={() => {}} />);
    // Exact match: a loose /include north/i regex would also match the layer
    // row's "Include North_1_Floor" checkbox.
    const box = screen.getByRole("checkbox", { name: "Include North" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box.checked).toBe(false);
  });

  it("restores the suggested inclusion instead of blanket-including on re-tick", () => {
    const onImport = vi.fn();
    render(<GdbImportDialog inspection={partialInspection} initialPlan={partialPlan} locale="en" busy={false} error={null} onImport={onImport} onCancel={() => {}} />);
    const box = screen.getByRole("checkbox", { name: "Include North" });
    fireEvent.click(box); // -> all excluded
    fireEvent.click(box); // -> restore suggestion, NOT all included
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    const submitted = onImport.mock.calls[0]![0] as GdbMappingPlan;
    expect(submitted.layers.find((l) => l.key.layerName === "North_1_Floor")!.included).toBe(true);
    // The cross-floor layer was excluded by the server heuristic and must stay so.
    expect(submitted.layers.find((l) => l.key.layerName === "North_1_to_2_detail")!.included).toBe(false);
  });
});
