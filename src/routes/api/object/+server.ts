import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { readFile } from "node:fs/promises";
import path from "node:path";

type StoredFile = {
    id: string;
    name: string;
    type: string;
    checksum: string;
    size: number;
    createdAt: number;
};

type Index = {
    filesById: Record<string, StoredFile>;
    idByKey: Record<string, string>;
};

const dataDir = path.resolve(
    process.env.UPLOADER_DATA_DIR ||
        (process.env.VERCEL ? "/tmp/uploader" : ".data/uploader"),
);
const indexPath = path.join(dataDir, "index.json");
const rateLimitState = new Map<string, { count: number; resetAt: number }>();

const getClientIp = (request: Request) => {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
    return (
        request.headers.get("x-real-ip") ||
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("true-client-ip") ||
        "unknown"
    );
};

const checkRateLimit = (request: Request, limit: number, windowMs: number) => {
    const ip = getClientIp(request);
    const now = Date.now();
    const current = rateLimitState.get(ip);
    if (!current || now > current.resetAt) {
        rateLimitState.set(ip, { count: 1, resetAt: now + windowMs });
        return null;
    }
    if (current.count >= limit) return current.resetAt;
    current.count += 1;
    return null;
};

const checkToken = (request: Request, url: URL) => {
    const token = process.env.UPLOADER_API_TOKEN;
    if (!token) return true;
    const bearer = request.headers.get("authorization");
    const apiKey = request.headers.get("x-api-key");
    const queryToken = url.searchParams.get("token");
    if (bearer?.startsWith("Bearer ") && bearer.slice(7) === token) return true;
    if (apiKey && apiKey === token) return true;
    if (queryToken && queryToken === token) return true;
    return false;
};

const loadIndex = async (): Promise<Index> => {
    try {
        const raw = await readFile(indexPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<Index>;
        return {
            filesById: parsed.filesById ?? {},
            idByKey: parsed.idByKey ?? {},
        };
    } catch {
        return { filesById: {}, idByKey: {} };
    }
};

export const GET: RequestHandler = async ({ request, url }) => {
    if (!checkToken(request, url)) {
        return json(
            { error: 401, message: "Unauthorized" },
            { status: 401 },
        );
    }
    const retryAt = checkRateLimit(request, 120, 60_000);
    if (retryAt) {
        const retrySeconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
        return json(
            { error: 429, message: "Too many requests" },
            { status: 429, headers: { "retry-after": String(retrySeconds) } },
        );
    }
    const idParam = url.searchParams.get("id");
    const keyParam = url.searchParams.get("key");
    if (!idParam && !keyParam) {
        return json(
            { error: 400, message: 'Missing query param "id" or "key"' },
            { status: 400 },
        );
    }

    const index = await loadIndex();
    const id = idParam ? idParam.split(".")[0] : index.idByKey[keyParam || ""];
    if (!id || !index.filesById[id]) {
        return json({ error: 404, message: "File not found" }, { status: 404 });
    }

    const meta = index.filesById[id];
    return json({
        id: meta.id,
        type: meta.type,
        date: Number(meta.createdAt),
        size: Number(meta.size),
        checksums: { md5: meta.checksum },
        name: meta.name,
    });
};
