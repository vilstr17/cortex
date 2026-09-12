import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import type ChronotePlugin from "../../main.js";
import type { ChronoteTest } from "../../settingsTypes.js";
import { TestService } from "../testService.js";

type FrontmatterByPath = Record<string, Record<string, unknown>>;

function createService(tests: ChronoteTest[], frontmatterByPath: FrontmatterByPath) {
  const files = new Map(Object.keys(frontmatterByPath).map((path) => {
    const file = new TFile();
    file.path = path;
    return [path, file] as const;
  }));
  const saveData = vi.fn().mockResolvedValue(undefined);
  const plugin = {
    settings: { tests },
    saveData,
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      },
      fileManager: {
        processFrontMatter: async (
          file: TFile,
          update: (frontmatter: Record<string, unknown>) => void,
        ) => {
          const frontmatter = frontmatterByPath[file.path] ?? {};
          frontmatterByPath[file.path] = frontmatter;
          update(frontmatter);
        },
      },
    },
  } as unknown as ChronotePlugin;

  return { service: new TestService(plugin), saveData };
}

describe("TestService", () => {
  it("removes a note's test link and its derived exam frontmatter", async () => {
    const test: ChronoteTest = {
      id: "biology",
      name: "Biology",
      date: "2026-09-05",
      filePaths: ["Biology/Cells.md"],
    };
    const frontmatterByPath: FrontmatterByPath = {
      "Biology/Cells.md": {
        confidence: 4,
        exam_date: "2026-09-05",
        exclude_from_exam: true,
      },
    };
    const { service, saveData } = createService([test], frontmatterByPath);

    await service.removeFileFromTest(test.id, "Biology/Cells.md");

    expect(test.filePaths).toEqual([]);
    expect(frontmatterByPath["Biology/Cells.md"]).toEqual({ confidence: 4 });
    expect(saveData).toHaveBeenCalledOnce();
  });

  it("preserves a note's test date when another test still links it", async () => {
    const removedTest: ChronoteTest = {
      id: "history",
      name: "History",
      date: "2026-09-05",
      filePaths: ["Shared/Essay.md"],
    };
    const remainingTest: ChronoteTest = {
      id: "literature",
      name: "Literature",
      date: "2026-09-12",
      filePaths: ["Shared/Essay.md"],
    };
    const frontmatterByPath: FrontmatterByPath = {
      "Shared/Essay.md": {
        exam_date: removedTest.date,
        exclude_from_exam: true,
      },
    };
    const { service } = createService([removedTest, remainingTest], frontmatterByPath);

    await service.removeFileFromTest(removedTest.id, "Shared/Essay.md");

    expect(removedTest.filePaths).toEqual([]);
    expect(frontmatterByPath["Shared/Essay.md"]).toEqual({
      exam_date: remainingTest.date,
    });
  });

  it("cleans up linked notes when an entire test is removed", async () => {
    const test: ChronoteTest = {
      id: "chemistry",
      name: "Chemistry",
      date: "2026-09-20",
      filePaths: ["Chemistry/Atoms.md"],
    };
    const frontmatterByPath: FrontmatterByPath = {
      "Chemistry/Atoms.md": { exam_date: test.date },
    };
    const { service, saveData } = createService([test], frontmatterByPath);

    await service.removeTest(test.id);

    expect(service.getAllTests()).toEqual([]);
    expect(frontmatterByPath["Chemistry/Atoms.md"]).toEqual({});
    expect(saveData).toHaveBeenCalledOnce();
  });
});
