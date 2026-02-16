import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { put } from "@vercel/blob";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getMongo, saveFileMetadata, getFileMetadata } from "$lib/db";

import { env } from "$env/dynamic/private";

const isVercel = Boolean(env.VERCEL || env.VERCEL_ENV);
const dataDir = path.resolve(
    env.UPLOADER_DATA_DIR || (isVercel ? "/tmp/uploader" : ".data/uploader"),
);
const filesDir = path.join(dataDir, "files");
const maxBytes = Number(env.UPLOADER_MAX_BYTES || 104_857_600);
const rateLimitState = new Map<string, { count: number; resetAt: number }>();
const dualThreshold = Number(env.UPLOADER_DUAL_THRESHOLD_BYTES || 7 * 1024 * 1024);

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
    const token = env.UPLOADER_API_TOKEN;
    if (!token) return true;
    const bearer = request.headers.get("authorization");
    const apiKey = request.headers.get("x-api-key");
    const queryToken = url.searchParams.get("token");
    if (bearer?.startsWith("Bearer ") && bearer.slice(7) === token) return true;
    if (apiKey && apiKey === token) return true;
    if (queryToken && queryToken === token) return true;
    return false;
};

const safeExt = (name: string) => {
    const ext = path.extname(name || "").slice(0, 16);
    if (!ext || ext === ".") return "";
    if (!/^\.[a-zA-Z0-9]+$/.test(ext)) return "";
    return ext.toLowerCase();
};

const makeId = () => {
    const alphabet =
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const bytes = crypto.randomBytes(8);
    let out = "";
    for (const b of bytes) out += alphabet[b % alphabet.length];
    return out.slice(0, 6);
};

const md5File = (filePath: string) => {
    return new Promise<string>((resolve, reject) => {
        const hash = crypto.createHash("md5");
        const stream = createReadStream(filePath);
        stream.on("data", (buf) => hash.update(buf));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
};

const hashPassword = (salt: string, password: string) => {
    return crypto
        .createHash("sha256")
        .update(`${salt}${password}`)
        .digest("hex");
};

export const POST: RequestHandler = async ({ request, url }) => {
    if (!checkToken(request, url)) {
        return json(
            { error: 401, message: "Unauthorized" },
            { status: 401 },
        );
    }
    const retryAt = checkRateLimit(request, 20, 60_000);
    if (retryAt) {
        const retrySeconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
        return json(
            { error: 429, message: "Too many requests" },
            { status: 429, headers: { "retry-after": String(retrySeconds) } },
        );
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
        return json(
            { error: 400, message: 'Missing multipart form field "file"' },
            { status: 400 },
        );
    }
    const visibility = form.get("visibility");
    const rawPassword = form.get("password");
    const isPrivate =
        visibility === "private" || form.get("private") === "true";
    const password =
        typeof rawPassword === "string" ? rawPassword.trim() : "";
    if (isPrivate && !password) {
        return json(
            { error: 400, message: "Password is required for private files" },
            { status: 400 },
        );
    }
    if (Number.isFinite(maxBytes) && maxBytes > 0 && file.size > maxBytes) {
        return json(
            { error: 413, message: `File too large (max ${maxBytes} bytes)` },
            { status: 413 },
        );
    }

    const id = await (async () => {
        let tries = 0;
        while (tries++ < 10) {
            const candidate = makeId();
            const exists = await getFileMetadata(candidate);
            if (!exists) return candidate;
        }
        return crypto.randomBytes(6).toString("hex");
    })();

    const ext = safeExt(file.name);
    let storage =
        (typeof form.get("storage") === "string" ? String(form.get("storage")) : undefined) ||
        url.searchParams.get("storage") ||
        env.UPLOADER_STORAGE_DEFAULT ||
        "fs";

    let filePath = "";
    let checksum = "";
    let gridfsId: string | undefined = undefined;
    let blobPathname: string | undefined = undefined;
    let r2Bucket: string | undefined = undefined;
    let r2Key: string | undefined = undefined;

    // Auto dual for large files if not explicitly set
    const isDual = (!url.searchParams.get("storage") && !(typeof form.get("storage") === "string")) && file.size > dualThreshold;

    if (isDual) {
        try {
            const webStream: ReadableStream = (file.stream() as any);
            const teeFn = (webStream as any).tee;
            const [mongoStream, r2Stream] = teeFn ? teeFn.call(webStream) : [webStream, webStream];

            const { bucket, bucketName } = await getMongo();
            const hasher = crypto.createHash("md5");
            const hasherTransform = new Transform({
                transform(chunk, _enc, cb) {
                    hasher.update(chunk as Buffer);
                    cb(null, chunk);
                },
            });
            const uploadMongo = bucket.openUploadStream(`${id}${ext}`, {
                metadata: {
                    originalName: file.name || id,
                    contentType: file.type || "application/octet-stream",
                },
            });

            const endpoint = env.R2_ENDPOINT || "";
            const bucketR2 = env.R2_BUCKET || "";
            const accessKeyId = env.R2_ACCESS_KEY_ID || "";
            const secretAccessKey = env.R2_SECRET_ACCESS_KEY || "";
            if (!endpoint || !bucketR2 || !accessKeyId || !secretAccessKey) {
                return json(
                    { error: 500, message: "Missing R2 configuration env" },
                    { status: 500 },
                );
            }
            const s3 = new S3Client({
                region: "auto",
                endpoint,
                credentials: { accessKeyId, secretAccessKey },
            });
            const keyObj = `${id}${ext}`;

            await Promise.all([
                pipeline(Readable.fromWeb(mongoStream as any), hasherTransform, uploadMongo),
                s3.send(
                    new PutObjectCommand({
                        Bucket: bucketR2,
                        Key: keyObj,
                        Body: Readable.fromWeb(r2Stream as any) as any,
                        ContentType: file.type || "application/octet-stream",
                    }),
                ),
            ]);

            checksum = hasher.digest("hex");
            gridfsId = String(uploadMongo.id);
            filePath = `r2://${bucketR2}/${keyObj}`;
            r2Bucket = bucketR2;
            r2Key = keyObj;
            storage = "r2";
        } catch (err) {
            return json({ error: 500, message: `Dual upload failed: ${err}` }, { status: 500 });
        }
    } else if (storage === "mongodb") {
        try {
            const { bucket, bucketName } = await getMongo();
            const hasher = crypto.createHash("md5");
            const hasherTransform = new Transform({
                transform(chunk, _enc, cb) {
                    hasher.update(chunk as Buffer);
                    cb(null, chunk);
                },
            });
            const uploadStream = bucket.openUploadStream(`${id}${ext}`, {
                metadata: {
                    originalName: file.name || id,
                    contentType: file.type || "application/octet-stream",
                },
            });
            await pipeline(Readable.fromWeb(file.stream() as any), hasherTransform, uploadStream);
            checksum = hasher.digest("hex");
            gridfsId = String(uploadStream.id);
            filePath = `gridfs://${bucketName}/${id}${ext}`;
        } catch (err) {
            return json({ error: 500, message: `MongoDB upload failed: ${err}` }, { status: 500 });
        }
    } else if (storage === "blob") {
        try {
            const hasher = crypto.createHash("md5");
            const hasherTransform = new Transform({
                transform(chunk, _enc, cb) {
                    hasher.update(chunk as Buffer);
                    cb(null, chunk);
                },
            });
            
            // Pipe connection: web stream -> node readable -> hasher -> upload
            // We use the transformed stream for upload so it pulls data through the hasher
            const sourceStream = Readable.fromWeb(file.stream() as any);
            const uploadStream = sourceStream.pipe(hasherTransform);

            const token = env.BLOB_READ_WRITE_TOKEN || undefined;

            // put() consumes the stream. As it reads, hasherTransform updates the hash.
            const result = await put(`${id}${ext}`, uploadStream, {
                access: "public",
                addRandomSuffix: false,
                token,
            });

            checksum = hasher.digest("hex");
            filePath = result.url;
            blobPathname = (result as any).pathname || undefined;
        } catch (err) {
            return json({ error: 500, message: `Blob upload failed: ${err}` }, { status: 500 });
        }
    } else if (storage === "r2") {
        try {
            const endpoint = env.R2_ENDPOINT || "";
            const bucket = env.R2_BUCKET || "";
            const accessKeyId = env.R2_ACCESS_KEY_ID || "";
            const secretAccessKey = env.R2_SECRET_ACCESS_KEY || "";
            if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
                return json(
                    { error: 500, message: "Missing R2 configuration env" },
                    { status: 500 },
                );
            }
            const s3 = new S3Client({
                region: "auto",
                endpoint,
                credentials: { accessKeyId, secretAccessKey },
            });

            const hasher = crypto.createHash("md5");
            const hasherTransform = new Transform({
                transform(chunk, _enc, cb) {
                    hasher.update(chunk as Buffer);
                    cb(null, chunk);
                },
            });

            // Pipe connection: web stream -> node readable -> hasher -> upload
            const sourceStream = Readable.fromWeb(file.stream() as any);
            const uploadStream = sourceStream.pipe(hasherTransform);

            const keyObj = `${id}${ext}`;
            
            // S3 Upload consumes the stream
            await s3.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: keyObj,
                    Body: uploadStream,
                    ContentType: file.type || "application/octet-stream",
                }),
            );

            checksum = hasher.digest("hex");
            filePath = `r2://${bucket}/${keyObj}`;
            r2Bucket = bucket;
            r2Key = keyObj;
        } catch (err) {
            return json({ error: 500, message: `R2 upload failed: ${err}` }, { status: 500 });
        }
    } else {
        await mkdir(filesDir, { recursive: true });
        filePath = path.join(filesDir, `${id}${ext}`);
        await pipeline(Readable.fromWeb(file.stream() as any), createWriteStream(filePath));
        checksum = await md5File(filePath);
    }
    const key = crypto.randomBytes(24).toString("hex");
    const createdAt = Date.now();
    const passwordSalt = isPrivate ? crypto.randomBytes(16).toString("hex") : "";
    const passwordHash = isPrivate ? hashPassword(passwordSalt, password) : "";

    await saveFileMetadata({
        id,
        name: file.name || id,
        type: file.type || "application/octet-stream",
        ext,
        key,
        checksum,
        size: file.size,
        createdAt,
        filePath,
        private: isPrivate,
        passwordSalt: passwordSalt || undefined,
        passwordHash: passwordHash || undefined,
        storage:
            storage === "mongodb"
                ? "mongodb"
                : storage === "blob"
                ? "blob"
                : storage === "r2"
                ? "r2"
                : "fs",
        gridfsId: gridfsId,
        blobPathname,
        r2Bucket,
        r2Key,
    });

    return json({
        id,
        ext,
        type: file.type || "application/octet-stream",
        checksum,
        key,
        origin: url.origin,
        private: isPrivate,
    });
};
