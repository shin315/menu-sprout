// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

type LunarDate = { lunarDay: number; lunarMonth: number; lunarYear: number; lunarLeap: number };
type ConvertSolar2Lunar = (dd: number, mm: number, yy: number, timeZone?: number) => LunarDate;

async function loadRecipeLunarAlgorithm(): Promise<ConvertSolar2Lunar> {
  const html = await readFile(join(import.meta.dirname, "../extensions/recipes/vietnamese-lunar-calendar.html"), "utf8");
  const source = new DOMParser().parseFromString(html, "text/html").getElementById("lunar-algorithm")?.textContent;
  if (!source) throw new Error("lunar algorithm code block not found");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  // Evaluate in this realm: vm sandbox global lookups make the full-range sweep ~15x slower.
  const moduleExports: { convertSolar2Lunar?: ConvertSolar2Lunar } = {};
  new Function("exports", outputText)(moduleExports);
  if (!moduleExports.convertSolar2Lunar) throw new Error("convertSolar2Lunar is not exported");
  return moduleExports.convertSolar2Lunar;
}

describe("Vietnamese lunar calendar recipe algorithm", () => {
  let convertSolar2Lunar: ConvertSolar2Lunar;

  beforeAll(async () => {
    convertSolar2Lunar = await loadRecipeLunarAlgorithm();
  });

  it.each([
    ["2026-10-04", 4, 10, 2026, { lunarDay: 24, lunarMonth: 8, lunarYear: 2026, lunarLeap: 0 }],
    ["2026-02-17 (Tết Bính Ngọ)", 17, 2, 2026, { lunarDay: 1, lunarMonth: 1, lunarYear: 2026, lunarLeap: 0 }],
    ["2024-02-10 (Tết Giáp Thìn)", 10, 2, 2024, { lunarDay: 1, lunarMonth: 1, lunarYear: 2024, lunarLeap: 0 }],
    ["2008-11-27", 27, 11, 2008, { lunarDay: 1, lunarMonth: 11, lunarYear: 2008, lunarLeap: 0 }],
    ["2035-08-03", 3, 8, 2035, { lunarDay: 30, lunarMonth: 6, lunarYear: 2035, lunarLeap: 0 }],
    ["2044-07-24", 24, 7, 2044, { lunarDay: 30, lunarMonth: 6, lunarYear: 2044, lunarLeap: 0 }],
    ["2028-06-23 (leap month 5)", 23, 6, 2028, { lunarDay: 1, lunarMonth: 5, lunarYear: 2028, lunarLeap: 1 }],
  ])("converts %s to the expected lunar date", (_label, dd, mm, yy, expected) => {
    expect(convertSolar2Lunar(dd, mm, yy, 7)).toMatchObject(expected);
  });

  it.each([
    ["1877-04-13", 13, 4, 1877, { lunarDay: 30, lunarMonth: 2 }],
    ["1885-03-16", 16, 3, 1885, { lunarDay: 30, lunarMonth: 1 }],
    ["2054-05-07", 7, 5, 2054, { lunarDay: 30, lunarMonth: 3 }],
    ["2062-04-09", 9, 4, 2062, { lunarDay: 30, lunarMonth: 2 }],
  ])("converts %s, where the new moon estimate overshoots, to day 30 of the previous month", (_label, dd, mm, yy, expected) => {
    expect(convertSolar2Lunar(dd, mm, yy, 7)).toMatchObject(expected);
  });

  it("returns a lunar day between 1 and 30 for every date in the supported 1800-2199 range", () => {
    const invalid: string[] = [];
    for (let time = Date.UTC(1800, 0, 1); time <= Date.UTC(2199, 11, 31); time += 86_400_000) {
      const date = new Date(time);
      const { lunarDay } = convertSolar2Lunar(date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear(), 7);
      if (lunarDay < 1 || lunarDay > 30) invalid.push(`${date.toISOString().slice(0, 10)} -> ${lunarDay}`);
    }
    expect(invalid).toEqual([]);
  });
});
