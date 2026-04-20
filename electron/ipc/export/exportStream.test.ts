import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
	const tmpRoot = path.join(os.tmpdir(), `recordly-export-stream-test-${Date.now()}`);
	return {
		app: {
			getPath: (key: string) => {
				if (key === "temp") {
					return tmpRoot;
				}
				throw new Error(`Unexpected app.getPath key: ${key}`);
			},
		},
	};
});

import {
	cleanupAllExportStreams,
	closeExportStream,
	hasExportStream,
	openExportStream,
	writeToExportStream,
} from "./exportStream";

async function readBytes(filePath: string): Promise<Uint8Array> {
	return new Uint8Array(await fs.readFile(filePath));
}

describe("exportStream", () => {
	const openedTempPaths: string[] = [];

	beforeEach(() => {
		openedTempPaths.length = 0;
	});

	afterEach(async () => {
		await cleanupAllExportStreams();
		await Promise.allSettled(
			openedTempPaths.map((tempPath) => fs.rm(tempPath, { force: true })),
		);
	});

	it("persists multiple chunks in order and reports the highest watermark on close", async () => {
		const { streamId, tempPath } = await openExportStream();
		openedTempPaths.push(tempPath);
		expect(hasExportStream(streamId)).toBe(true);

		await writeToExportStream(streamId, 0, new Uint8Array([1, 2, 3, 4]));
		await writeToExportStream(streamId, 4, new Uint8Array([5, 6, 7, 8]));

		const result = await closeExportStream(streamId);
		expect(result.tempPath).toBe(tempPath);
		expect(result.bytesWritten).toBe(8);

		const bytes = await readBytes(tempPath);
		expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(hasExportStream(streamId)).toBe(false);
	});

	it("supports out-of-order writes and keeps the watermark at the highest offset", async () => {
		const { streamId, tempPath } = await openExportStream();
		openedTempPaths.push(tempPath);

		await writeToExportStream(streamId, 16, new Uint8Array([0xff, 0xee]));
		await writeToExportStream(streamId, 0, new Uint8Array([0x01, 0x02]));

		const result = await closeExportStream(streamId);
		expect(result.bytesWritten).toBe(18);

		const bytes = await readBytes(tempPath);
		expect(bytes.byteLength).toBe(18);
		expect(bytes[0]).toBe(0x01);
		expect(bytes[1]).toBe(0x02);
		expect(bytes[16]).toBe(0xff);
		expect(bytes[17]).toBe(0xee);
	});

	it("removes the temp file when closed with abort", async () => {
		const { streamId, tempPath } = await openExportStream();
		openedTempPaths.push(tempPath);
		await writeToExportStream(streamId, 0, new Uint8Array([9, 9, 9]));

		await closeExportStream(streamId, { abort: true });

		await expect(fs.access(tempPath)).rejects.toThrow();
		expect(hasExportStream(streamId)).toBe(false);
	});

	it("rejects writes after the stream has been aborted", async () => {
		const { streamId, tempPath } = await openExportStream();
		openedTempPaths.push(tempPath);
		await closeExportStream(streamId, { abort: true });

		await expect(writeToExportStream(streamId, 0, new Uint8Array([1]))).rejects.toThrow(
			/Export stream not found/,
		);
	});

	it("rejects an extension that would escape the temp directory", async () => {
		await expect(openExportStream({ extension: "mp4/../etc/passwd" })).rejects.toThrow(
			/Invalid export stream extension/,
		);
		await expect(openExportStream({ extension: ".." })).rejects.toThrow(
			/Invalid export stream extension/,
		);
		await expect(openExportStream({ extension: "MP4" })).rejects.toThrow(
			/Invalid export stream extension/,
		);
	});
});
