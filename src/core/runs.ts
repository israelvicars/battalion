import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { assertSafeSlug } from "./ids.ts";

export type RunProcess = { pid?: number; pgid?: number };

export type LiveRunRecord = {
  run_id: string;
  pid: number;
  pgid: number | null;
  agent: string;
  task_id: string;
  thread_id: string;
  started_at: string;
};

export class RunStore {
  readonly directory: string;

  constructor(ttbHome: string) {
    this.directory = path.join(path.resolve(ttbHome), "runs");
  }

  pathFor(runId: string): string {
    assertSafeSlug(runId, "run_id");
    return path.join(this.directory, `${runId}.json`);
  }

  killedPathFor(runId: string): string {
    assertSafeSlug(runId, "run_id");
    return path.join(this.directory, `${runId}.killed`);
  }

  async markKilled(runId: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const handle = await open(this.killedPathFor(runId), "wx", 0o600);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  async isKilled(runId: string): Promise<boolean> {
    try {
      await readFile(this.killedPathFor(runId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async clearKilled(runId: string): Promise<void> {
    try {
      await unlink(this.killedPathFor(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async add(input: Omit<LiveRunRecord, "started_at">): Promise<LiveRunRecord> {
    const record: LiveRunRecord = { ...input, started_at: new Date().toISOString() };
    assertSafeSlug(record.task_id, "task_id");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const handle = await open(this.pathFor(record.run_id), "wx", 0o600);
    try {
      await handle.write(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return record;
  }

  async remove(runId: string): Promise<void> {
    try {
      await unlink(this.pathFor(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async list(): Promise<LiveRunRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: LiveRunRecord[] = [];
    for (const name of names.sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(name)) continue;
      try {
        const parsed = JSON.parse(await readFile(path.join(this.directory, name), "utf8")) as LiveRunRecord;
        if (parsed.run_id === name.slice(0, -5) && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) {
          records.push(parsed);
        }
      } catch {
        // Malformed run records are retained for manual review and ignored by kill.
      }
    }
    return records;
  }
}
