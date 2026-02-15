import type { RequestHandler } from "./$types";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

type StoredFile = {
    filePath: string;
    type: string;
};

type Index = {
    filesById: Record<string, StoredFile>;
};

const dataDir = path.resolve(
    process.env.UPLOADER_DATA_DIR ||
        (process.env.VERCEL ? "/tmp/uploader" : ".data/uploader"),
);
const indexPath = path.join(dataDir, "index.json");

const loadIndex = async (): Promise<Index> => {
    try {
        const raw = await readFile(indexPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<Index>;
        return { filesById: parsed.filesById ?? {} };
    } catch {
        return { filesById: {} };
    }
};

export const GET: RequestHandler = async ({ params }) => {
    const id = (params.id || "").split(".")[0];
    const index = await loadIndex();
    const meta = index.filesById[id];
    if (!meta || !meta.type?.startsWith("image/")) {
        return new Response("Not found", { status: 404 });
    }

    const stream = Readable.toWeb(createReadStream(meta.filePath)) as any;
    return new Response(stream, {
        headers: {
            "content-type": meta.type,
            "cache-control": "public, max-age=31536000, immutable",
        },
    });
};
