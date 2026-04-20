import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

type ExportStreamSession = {
	streamId: string;
	tempPath: string;
	fileHandle: fs.promises.FileHandle;
	bytesWritten: number;
	highestWatermark: number;
	writeQueue: Promise<void>;
	aborted: boolean;
};

const exportStreamSessions = new Map<string, ExportStreamSession>();

const EXTENSION_ALLOWLIST = /^[a-z0-9]{1,8}$/;

function generateStreamId() {
	return `recordly-export-stream-${randomUUID()}`;
}

export async function openExportStream(options?: { extension?: string }): Promise<{
	streamId: string;
	tempPath: string;
}> {
	const extension = options?.extension ?? "mp4";
	if (!EXTENSION_ALLOWLIST.test(extension)) {
		throw new Error(`Invalid export stream extension: ${extension}`);
	}
	const streamId = generateStreamId();
	const tempPath = path.join(app.getPath("temp"), `${streamId}.${extension}`);
	await fsp.mkdir(path.dirname(tempPath), { recursive: true });
	const fileHandle = await fsp.open(tempPath, "w+");

	exportStreamSessions.set(streamId, {
		streamId,
		tempPath,
		fileHandle,
		bytesWritten: 0,
		highestWatermark: 0,
		writeQueue: Promise.resolve(),
		aborted: false,
	});

	return { streamId, tempPath };
}

export async function writeToExportStream(
	streamId: string,
	position: number,
	chunk: Uint8Array,
): Promise<void> {
	const session = exportStreamSessions.get(streamId);
	if (!session) {
		throw new Error(`Export stream not found: ${streamId}`);
	}

	if (session.aborted) {
		throw new Error("Export stream was aborted");
	}

	// Serialize writes against the session to keep byte counters consistent when
	// the renderer issues concurrent chunks.
	const previous = session.writeQueue;
	const next = previous.then(async () => {
		if (session.aborted) {
			return;
		}
		const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		await session.fileHandle.write(buffer, 0, buffer.byteLength, position);
		session.bytesWritten += buffer.byteLength;
		const end = position + buffer.byteLength;
		if (end > session.highestWatermark) {
			session.highestWatermark = end;
		}
	});
	session.writeQueue = next.catch(() => undefined);
	await next;
}

export async function closeExportStream(
	streamId: string,
	options?: { abort?: boolean },
): Promise<{ tempPath: string; bytesWritten: number }> {
	const session = exportStreamSessions.get(streamId);
	if (!session) {
		throw new Error(`Export stream not found: ${streamId}`);
	}

	const abort = options?.abort === true;
	if (abort) {
		session.aborted = true;
	}

	try {
		await session.writeQueue;
	} catch {
		// Propagated to the in-flight write promise; closure proceeds regardless.
	}

	try {
		await session.fileHandle.close();
	} catch {
		// File handle may already be closed; ignore so abort paths stay best-effort.
	}

	exportStreamSessions.delete(streamId);

	if (abort) {
		try {
			await fsp.rm(session.tempPath, { force: true });
		} catch {
			// Temp file may be gone already.
		}
	}

	return {
		tempPath: session.tempPath,
		bytesWritten: session.highestWatermark,
	};
}

export function hasExportStream(streamId: string): boolean {
	return exportStreamSessions.has(streamId);
}

export async function cleanupAllExportStreams(): Promise<void> {
	const sessions = Array.from(exportStreamSessions.values());
	exportStreamSessions.clear();
	await Promise.allSettled(
		sessions.map(async (session) => {
			try {
				await session.fileHandle.close();
			} catch {
				// ignore
			}
			try {
				await fsp.rm(session.tempPath, { force: true });
			} catch {
				// ignore
			}
		}),
	);
}
