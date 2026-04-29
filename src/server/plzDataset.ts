import fs from "node:fs";

export function loadPostalCodes(filePath: string): Set<string> {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected postal code list at ${filePath}`);
  }

  return new Set(
    parsed
      .map((value) => String(value))
      .filter((value) => /^\d{5}$/.test(value))
  );
}
