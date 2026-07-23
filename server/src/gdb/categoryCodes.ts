// Company internal category codes → IMDF categories. Copied verbatim from
// shp2imdf-converter/backend/config/{a,b,c}-codes.json. This is a MANUAL COPY
// (the converter is a separate repo); keep in sync if those tables change.
// The value's prefix letter selects the table: A → venue, B → unit,
// C → fixture/detail. Non-code values pass through unchanged.

interface CodeTable {
  default_category: string;
  mappings: Record<string, string>;
}

const A_CODES: CodeTable = {
  default_category: "other",
  mappings: {
    A001: "transitstation", A002: "airport", A003: "stadium", A004: "shoppingcenter",
    A005: "conventioncenter", A006: "governmentfacility", A007: "medicalfacility",
    A008: "welfare", A009: "communitycenter", A010: "hotel", A011: "parkingfacility",
    A012: "university", A013: "theater", A014: "aquarium", A015: "museum", A016: "other",
    A017: "retailstore", A018: "shoppingcenter", A019: "resort", A020: "themepark",
    A021: "casino", A022: "other", A023: "businesscampus", A024: "publictoilet", A999: "other",
  },
};

const B_CODES: CodeTable = {
  default_category: "unspecified",
  mappings: {
    B001: "retail", B002: "office", B003: "publicfacility", B004: "waitingroom",
    B005: "tickets", B006: "information", B007: "restroom.male", B008: "restroom.female",
    B009: "restroom.unisex", B010: "restroom", B011: "restroom", B012: "restroom",
    B013: "restroom", B014: "restroom", B015: "smokingarea", B016: "mothersroom",
    B017: "firstaid", B018: "room", B019: "room", B020: "opentobelow", B021: "stairs",
    B022: "elevator", B023: "escalator", B024: "walkway", B025: "walkway", B026: "nonpublic",
    B027: "parking", B028: "platform", B029: "walkway",
  },
};

const C_CODES: CodeTable = {
  default_category: "unspecified",
  mappings: {
    C001: "column", C002: "bench", C003: "reception", C004: "cubicle", C005: "rubbishbin",
    C006: "furniture", C007: "kiosk", C008: "obstruction", C009: "vegetation", C010: "wall",
    C011: "water", C012: "locker", C013: "vendingmachine", C014: "atm", C015: "stage",
    C016: "fence", C017: "twsi.hazard", C018: "twsi.guidance", C019: "twsi.crossing",
    C101: "platform.screen", C102: "platform.gate", C103: "ticket.vending", C104: "ticketgate",
    C201: "baggage.carousel", C202: "checkin.kiosk", C999: "unspecified",
  },
};

/**
 * Translate a company internal category code to its IMDF category. The prefix
 * letter (A/B/C) selects the table; unknown codes fall back to that table's
 * default; a value that is not an A/B/C code is returned unchanged.
 */
export function mapCategoryCode(raw: string): string {
  const m = /^([ABC])(\d+)$/.exec(raw.trim());
  if (m === null) return raw;
  const table = m[1] === "A" ? A_CODES : m[1] === "B" ? B_CODES : C_CODES;
  const key = raw.trim().toUpperCase();
  return table.mappings[key] ?? table.default_category;
}
