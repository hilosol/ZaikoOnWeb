import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../src/clock.js";
import { openDatabase } from "../src/db.js";
import { FileImageStore } from "../src/images.js";
import { InventoryService, type Actor } from "../src/inventory.js";

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

export class FakeClock implements Clock {
  current = new Date(2026, 10, 2, 9, 0, 0);
  now() {
    return new Date(this.current);
  }
  advance(minutes: number) {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

export interface Fixture {
  dir: string;
  db: DatabaseSync;
  images: FileImageStore;
  clock: FakeClock;
  service: InventoryService;
  actor: Actor;
  cleanup(): void;
}

/** 一時フォルダに本物の SQLite と画像フォルダを作る（モックではなく実際の SQL・ファイル操作を検証する）。 */
export function createFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaiko-test-"));
  const db = openDatabase(path.join(dir, "zaiko.db"));
  const images = new FileImageStore(dir);
  const clock = new FakeClock();
  const service = new InventoryService(db, images, clock);
  const actor: Actor = { userName: "山田", clientIp: "192.168.1.10" };
  service.createUser("山田", actor);
  return {
    dir,
    db,
    images,
    clock,
    service,
    actor,
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function imageFiles(dir: string): string[] {
  return fs.readdirSync(path.join(dir, "images")).sort();
}

export function uploadFiles(dir: string): string[] {
  return fs.readdirSync(path.join(dir, "uploads")).sort();
}
