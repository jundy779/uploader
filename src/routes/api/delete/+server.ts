import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { rm } from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MongoClient, GridFSBucket, ObjectId } from "mongodb";
import { del } from "@vercel/blob";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getMongo, getFileMetadata, deleteFileMetadata } from "$lib/db";

const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const dataDir = path.resolve(
    process.env.UPLOADER_DATA_DIR || (isVercel ? "/tmp/uploader" : ".data/uploader"),
);
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

const handleDelete = async (url: URL) => {
    const key = url.searchParams.get("key");
    if (!key) {
        return json(
            { error: 400, message: 'Missing query param "key"' },
            { status: 400 },
        );
    }

    const meta = await getFileMetadata(key, 'key');
    
    if (!meta) {
        return json({ error: 404, message: "File not found" }, { status: 404 });
    }
    
    const id = meta.id;

    // Attempt deletions across all present backends
    try {
        if (meta.gridfsId) {
            const { bucket } = await getMongo();
            try { await bucket.delete(new ObjectId(meta.gridfsId)); } catch {}
        }
        if (meta.blobPathname) {
            const token = process.env.BLOB_READ_WRITE_TOKEN || undefined;
            try { await del(meta.blobPathname, { token }); } catch {}
        }
        if (meta.r2Bucket && meta.r2Key) {
            const endpoint = process.env.R2_ENDPOINT || "";
            const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
            const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
            if (endpoint && accessKeyId && secretAccessKey) {
                const s3 = new S3Client({
                    region: "auto",
                    endpoint,
                    credentials: { accessKeyId, secretAccessKey },
                });
                try {
                    await s3.send(
                        new DeleteObjectCommand({
                            Bucket: meta.r2Bucket,
                            Key: meta.r2Key,
                        }),
                    );
                } catch {}
            }
        }
        if (meta.filePath && !meta.filePath.startsWith("gridfs://") && !meta.filePath.startsWith("r2://") && !meta.filePath.startsWith("http")) {
            try { await rm(meta.filePath, { force: true }); } catch {}
        }
    } catch {
        return json(
            { error: 500, message: "Failed deleting file" },
            { status: 500 },
        );
    }

    await deleteFileMetadata(id);
    return json({ success: true });
};

export const POST: RequestHandler = async ({ request, url }) => {
    if (!checkToken(request, url)) {
        return json(
            { error: 401, message: "Unauthorized" },
            { status: 401 },
        );
    }
    const retryAt = checkRateLimit(request, 60, 60_000);
    if (retryAt) {
        const retrySeconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
        return json(
            { error: 429, message: "Too many requests" },
            { status: 429, headers: { "retry-after": String(retrySeconds) } },
        );
    }
    return handleDelete(url);
};
