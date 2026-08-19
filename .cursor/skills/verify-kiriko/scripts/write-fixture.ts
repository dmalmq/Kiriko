import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMinimalImdfZip } from "../../../../tests/fixtures/buildMinimalImdfZip.ts";

const outPath = path.resolve(process.argv[2] ?? "minimal-imdf.zip");
const bytes = await buildMinimalImdfZip();
await writeFile(outPath, bytes);
console.log(outPath);
