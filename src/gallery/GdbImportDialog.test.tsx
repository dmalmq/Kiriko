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
});
