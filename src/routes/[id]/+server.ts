import type { RequestHandler } from "./$types";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import crypto from "node:crypto";

type StoredFile = {
    filePath: string;
    type: string;
    name?: string;
    ext?: string;
    private?: boolean;
    passwordSalt?: string;
    passwordHash?: string;
};

type Index = {
    filesById: Record<string, StoredFile>;
};

const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const dataDir = path.resolve(
    process.env.UPLOADER_DATA_DIR || (isVercel ? "/tmp/uploader" : ".data/uploader"),
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

export const GET: RequestHandler = async ({ params, url, request }) => {
    const id = (params.id || "").split(".")[0];
    const skipCd = url.searchParams.get("skip-cd") === "true";
    const index = await loadIndex();
    const meta = index.filesById[id];
    if (!meta) return new Response("Not found", { status: 404 });
    if (meta.private && meta.passwordHash && meta.passwordSalt) {
        const provided =
            url.searchParams.get("pw") ||
            request.headers.get("x-file-password") ||
            "";
        const hashed = crypto
            .createHash("sha256")
            .update(`${meta.passwordSalt}${provided}`)
            .digest("hex");
        if (!provided || hashed !== meta.passwordHash) {
            return new Response("Forbidden", { status: 403 });
        }
    }

    const stream = Readable.toWeb(createReadStream(meta.filePath)) as any;
    const filename = (meta.name || `${id}${meta.ext || ""}`).replace(/[\r\n"]/g, "_");
    const headers: Record<string, string> = {
        "content-type": meta.type || "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
    };
    if (!skipCd && filename) {
        headers["content-disposition"] =
            `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }
    return new Response(stream, {
        headers,
    });
};
