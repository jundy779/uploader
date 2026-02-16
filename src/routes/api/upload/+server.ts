import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { MongoClient, GridFSBucket, ObjectId } from "mongodb";
import { put } from "@vercel/blob";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

type StoredFile = {
    id: string;
    name: string;
    type: string;
    ext: string;
    key: string;
    checksum: string;
    size: number;
    createdAt: number;
    filePath: string;
    private?: boolean;
    passwordSalt?: string;
    passwordHash?: string;
    storage?: "fs" | "mongodb" | "blob" | "r2";
    gridfsId?: string;
    blobPathname?: string;
    r2Bucket?: string;
    r2Key?: string;
};

type Index = {
    filesById: Record<string, StoredFile>;
    idByKey: Record<string, string>;
};

const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const dataDir = path.resolve(
    process.env.UPLOADER_DATA_DIR || (isVercel ? "/tmp/uploader" : ".data/uploader"),
);
const filesDir = path.join(dataDir, "files");
const indexPath = path.join(dataDir, "index.json");
const maxBytes = Number(process.env.UPLOADER_MAX_BYTES || 104_857_600);
const rateLimitState = new Map<string, { count: number; resetAt: number }>();
const dualThreshold = Number(process.env.UPLOADER_DUAL_THRESHOLD_BYTES || 7 * 1024 * 1024);

let mongoClient: MongoClient | null = null;
const getMongo = async () => {
    const uri = process.env.MONGODB_URI || "";
    const dbName = process.env.MONGODB_DB || "uploader";
    const bucketName = process.env.MONGODB_BUCKET || "uploads";
    if (!uri) throw new Error("Missing MONGODB_URI");
    if (!mongoClient) {
        mongoClient = await MongoClient.connect(uri);
    }
    const db = mongoClient.db(dbName);
    const bucket = new GridFSBucket(db, { bucketName });
    return { db, bucket, bucketName };
};

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

const corsHeaders = (request: Request) => {
    const origin = request.headers.get("origin") || "*";
    return {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-api-key",
        "access-control-max-age": "86400",
    };
};

const safeExt = (name: string) => {
    const ext = path.extname(name || "").slice(0, 16);
    if (!ext || ext === ".") return "";
    if (!/^\.[a-zA-Z0-9]+$/.test(ext)) return "";
    return ext.toLowerCase();
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

const saveIndex = async (index: Index) => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(indexPath, JSON.stringify(index), "utf8");
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
            { status: 401, headers: corsHeaders(request) },
        );
    }
    const retryAt = checkRateLimit(request, 20, 60_000);
    if (retryAt) {
        const retrySeconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
        return json(
            { error: 429, message: "Too many requests" },
            {
                status: 429,
                headers: { "retry-after": String(retrySeconds), ...corsHeaders(request) },
            },
        );
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
        return json(
            { error: 400, message: 'Missing multipart form field "file"' },
            { status: 400, headers: corsHeaders(request) },
        );
    }
    const visibility = form.get("visibility");
    const rawPassword = form.get("password");
    const providedChecksum =
        typeof form.get("checksum") === "string" ? String(form.get("checksum")) : "";
    const useClientChecksum = Boolean(providedChecksum && providedChecksum.trim().length > 0);
    const isPrivate =
        visibility === "private" || form.get("private") === "true";
    const password =
        typeof rawPassword === "string" ? rawPassword.trim() : "";
    if (isPrivate && !password) {
        return json(
            { error: 400, message: "Password is required for private files" },
            { status: 400, headers: corsHeaders(request) },
        );
    }
    if (Number.isFinite(maxBytes) && maxBytes > 0 && file.size > maxBytes) {
        return json(
            { error: 413, message: `File too large (max ${maxBytes} bytes)` },
            { status: 413, headers: corsHeaders(request) },
        );
    }
    const contentLength =
        Number.isFinite(file.size) && file.size > 0 ? file.size : 0;

    const index = await loadIndex();
    const id = (() => {
        let tries = 0;
        while (tries++ < 10) {
            const candidate = makeId();
            if (!index.filesById[candidate]) return candidate;
        }
        return crypto.randomBytes(6).toString("hex");
    })();

    const ext = safeExt(file.name);
    let storage =
        (typeof form.get("storage") === "string" ? String(form.get("storage")) : undefined) ||
        url.searchParams.get("storage") ||
        process.env.UPLOADER_STORAGE_DEFAULT ||
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
            const uploadMongo = bucket.openUploadStream(`${id}${ext}`, {
                metadata: {
                    originalName: file.name || id,
                    contentType: file.type || "application/octet-stream",
                },
            });

            const endpoint = process.env.R2_ENDPOINT || "";
            const bucketR2 = process.env.R2_BUCKET || "";
            const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
            const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
            if (!endpoint || !bucketR2 || !accessKeyId || !secretAccessKey) {
                return json(
                    { error: 500, message: "Missing R2 configuration env" },
                    { status: 500, headers: corsHeaders(request) },
                );
            }
            const s3 = new S3Client({
                region: "auto",
                endpoint,
                credentials: { accessKeyId, secretAccessKey },
            });
            const keyObj = `${id}${ext}`;

            if (useClientChecksum) {
                await Promise.all([
                    pipeline(Readable.fromWeb(mongoStream as any), uploadMongo),
                    s3.send(
                        new PutObjectCommand({
                            Bucket: bucketR2,
                            Key: keyObj,
                            Body: Readable.fromWeb(r2Stream as any) as any,
                            ContentType: file.type || "application/octet-stream",
                            ContentLength: contentLength,
                        }),
                    ),
                ]);
                checksum = providedChecksum.trim();
            } else {
                const hasher = crypto.createHash("md5");
                const hasherTransform = new Transform({
                    transform(chunk, _enc, cb) {
                        hasher.update(chunk as Buffer);
                        cb(null, chunk);
                    },
                });
                await Promise.all([
                    pipeline(Readable.fromWeb(mongoStream as any), hasherTransform, uploadMongo),
                    s3.send(
                        new PutObjectCommand({
                            Bucket: bucketR2,
                            Key: keyObj,
                            Body: Readable.fromWeb(r2Stream as any) as any,
                            ContentType: file.type || "application/octet-stream",
                            ContentLength: contentLength,
                        }),
                    ),
                ]);
                checksum = hasher.digest("hex");
            }
            gridfsId = String(uploadMongo.id);
            filePath = `r2://${bucketR2}/${keyObj}`;
            r2Bucket = bucketR2;
            r2Key = keyObj;
            storage = "r2";
        } catch (err) {
            return json(
                { error: 500, message: `Dual upload failed: ${err}` },
                { status: 500, headers: corsHeaders(request) },
            );
        }
    } else if (storage === "mongodb") {
        try {
            const { bucket, bucketName } = await getMongo();
            const uploadStream = bucket.openUploadStream(`${id}${ext}`, {
                metadata: {
                    originalName: file.name || id,
                    contentType: file.type || "application/octet-stream",
                },
            });
            if (useClientChecksum) {
                await pipeline(Readable.fromWeb(file.stream() as any), uploadStream);
                checksum = providedChecksum.trim();
            } else {
                const hasher = crypto.createHash("md5");
                const hasherTransform = new Transform({
                    transform(chunk, _enc, cb) {
                        hasher.update(chunk as Buffer);
                        cb(null, chunk);
                    },
                });
                await pipeline(Readable.fromWeb(file.stream() as any), hasherTransform, uploadStream);
                checksum = hasher.digest("hex");
            }
            gridfsId = String(uploadStream.id);
            filePath = `gridfs://${bucketName}/${id}${ext}`;
        } catch (err) {
            return json(
                { error: 500, message: `MongoDB upload failed: ${err}` },
                { status: 500, headers: corsHeaders(request) },
            );
        }
    } else if (storage === "blob") {
        try {
            const webStream: ReadableStream = (file.stream() as any);
            const token = process.env.BLOB_READ_WRITE_TOKEN || undefined;
            if (useClientChecksum) {
                const result = await put(`${id}${ext}`, webStream as any, {
                    access: "public",
                    addRandomSuffix: false,
                    token,
                });
                checksum = providedChecksum.trim();
                filePath = result.url;
                blobPathname = (result as any).pathname || undefined;
            } else {
                const [uploadStream, hashStream] = (webStream as any).tee
                    ? (webStream as any).tee()
                    : [webStream, webStream];
                const hasher = crypto.createHash("md5");
                const hasherTransform = new Transform({
                    transform(chunk, _enc, cb) {
                        hasher.update(chunk as Buffer);
                        cb(null, chunk);
                    },
                });
                const putPromise = put(`${id}${ext}`, uploadStream as any, {
                    access: "public",
                    addRandomSuffix: false,
                    token,
                });
                await Promise.all([
                    putPromise,
                    pipeline(Readable.fromWeb(hashStream as any), hasherTransform),
                ]);
                checksum = hasher.digest("hex");
                const result = await putPromise;
                filePath = result.url;
                blobPathname = (result as any).pathname || undefined;
            }
        } catch (err) {
            try {
                const endpoint = process.env.R2_ENDPOINT || "";
                const bucket = process.env.R2_BUCKET || "";
                const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
                const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
                if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
                    return json(
                        { error: 500, message: `Blob upload failed, R2 fallback unavailable: ${err}` },
                        { status: 500, headers: corsHeaders(request) },
                    );
                }
                const s3 = new S3Client({
                    region: "auto",
                    endpoint,
                    credentials: { accessKeyId, secretAccessKey },
                });
                const webStream2: ReadableStream = (file.stream() as any);
                const keyObj = `${id}${ext}`;
                if (useClientChecksum) {
                    await s3.send(
                        new PutObjectCommand({
                            Bucket: bucket,
                            Key: keyObj,
                            Body: Readable.fromWeb(webStream2 as any) as any,
                            ContentType: file.type || "application/octet-stream",
                            ContentLength: contentLength,
                        }),
                    );
                    checksum = providedChecksum.trim();
                } else {
                    const [uploadStream2, hashStream2] = (webStream2 as any).tee
                        ? (webStream2 as any).tee()
                        : [webStream2, webStream2];
                    const hasher2 = crypto.createHash("md5");
                    const hasherTransform2 = new Transform({
                        transform(chunk, _enc, cb) {
                            hasher2.update(chunk as Buffer);
                            cb(null, chunk);
                        },
                    });
                    const r2Promise = s3.send(
                        new PutObjectCommand({
                            Bucket: bucket,
                            Key: keyObj,
                            Body: Readable.fromWeb(uploadStream2 as any) as any,
                            ContentType: file.type || "application/octet-stream",
                            ContentLength: contentLength,
                        }),
                    );
                    await Promise.all([
                        r2Promise,
                        pipeline(Readable.fromWeb(hashStream2 as any), hasherTransform2),
                    ]);
                    checksum = hasher2.digest("hex");
                }
                filePath = `r2://${bucket}/${keyObj}`;
                r2Bucket = bucket;
                r2Key = keyObj;
                storage = "r2";
            } catch (err2) {
                return json(
                    { error: 500, message: `Blob upload failed and R2 fallback failed: ${err2}` },
                    { status: 500, headers: corsHeaders(request) },
                );
            }
        }
    } else if (storage === "r2") {
        try {
            const endpoint = process.env.R2_ENDPOINT || "";
            const bucket = process.env.R2_BUCKET || "";
            const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
            const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
            let usedBlobFallback = false;
            if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
                try {
                    const token = process.env.BLOB_READ_WRITE_TOKEN || undefined;
                    if (!token) {
                        return json(
                            { error: 500, message: "Missing R2 configuration env" },
                            { status: 500, headers: corsHeaders(request) },
                        );
                    }
                    const webStreamFallback: ReadableStream = (file.stream() as any);
                    if (useClientChecksum) {
                        const result = await put(`${id}${ext}`, webStreamFallback as any, {
                            access: "public",
                            addRandomSuffix: false,
                            token,
                        });
                        checksum = providedChecksum.trim();
                        filePath = result.url;
                        blobPathname = (result as any).pathname || undefined;
                        storage = "blob";
                        usedBlobFallback = true;
                    }
                    if (!usedBlobFallback) {
                        const [uploadStream, hashStream] = (webStreamFallback as any).tee
                            ? (webStreamFallback as any).tee()
                            : [webStreamFallback, webStreamFallback];
                        const hasher = crypto.createHash("md5");
                        const hasherTransform = new Transform({
                            transform(chunk, _enc, cb) {
                                hasher.update(chunk as Buffer);
                                cb(null, chunk);
                            },
                        });
                        const putPromise = put(`${id}${ext}`, uploadStream as any, {
                            access: "public",
                            addRandomSuffix: false,
                            token,
                        });
                        await Promise.all([
                            putPromise,
                            pipeline(Readable.fromWeb(hashStream as any), hasherTransform),
                        ]);
                        checksum = hasher.digest("hex");
                        const result = await putPromise;
                        filePath = result.url;
                        blobPathname = (result as any).pathname || undefined;
                        storage = "blob";
                        usedBlobFallback = true;
                    }
                } catch (errFallback) {
                    return json(
                        { error: 500, message: `Missing R2 configuration env and Blob fallback failed: ${errFallback}` },
                        { status: 500, headers: corsHeaders(request) },
                    );
                }
            }
            if (!usedBlobFallback) {
                const s3 = new S3Client({
                    region: "auto",
                    endpoint,
                    credentials: { accessKeyId, secretAccessKey },
                });
                const webStream: ReadableStream = (file.stream() as any);
                const keyObj = `${id}${ext}`;
                if (useClientChecksum) {
                    await s3.send(
                        new PutObjectCommand({
                            Bucket: bucket,
                            Key: keyObj,
                            Body: Readable.fromWeb(webStream as any) as any,
                            ContentType: file.type || "application/octet-stream",
                            ContentLength: contentLength,
                        }),
                    );
                    checksum = providedChecksum.trim();
                } else {
                    const [uploadStream, hashStream] = (webStream as any).tee
                        ? (webStream as any).tee()
                        : [webStream, webStream];
                    const hasher = crypto.createHash("md5");
                    const hasherTransform = new Transform({
                        transform(chunk, _enc, cb) {
                            hasher.update(chunk as Buffer);
                            cb(null, chunk);
                        },
                    });
                    const r2Promise = s3.send(
                        new PutObjectCommand({
                            Bucket: bucket,
                            Key: keyObj,
                            Body: Readable.fromWeb(uploadStream as any) as any,
                            ContentType: file.type || "application/octet-stream",
                            ContentLength: contentLength,
                        }),
                    );
                    await Promise.all([
                        r2Promise,
                        pipeline(Readable.fromWeb(hashStream as any), hasherTransform),
                    ]);
                    checksum = hasher.digest("hex");
                }
                filePath = `r2://${bucket}/${keyObj}`;
                r2Bucket = bucket;
                r2Key = keyObj;
            }
        } catch (err) {
            return json(
                { error: 500, message: `R2 upload failed: ${err}` },
                { status: 500, headers: corsHeaders(request) },
            );
        }
    } else {
        await mkdir(filesDir, { recursive: true });
        filePath = path.join(filesDir, `${id}${ext}`);
        if (useClientChecksum) {
            await pipeline(Readable.fromWeb(file.stream() as any), createWriteStream(filePath));
            checksum = providedChecksum.trim();
        } else {
            const hasher = crypto.createHash("md5");
            const hasherTransform = new Transform({
                transform(chunk, _enc, cb) {
                    hasher.update(chunk as Buffer);
                    cb(null, chunk);
                },
            });
            await pipeline(
                Readable.fromWeb(file.stream() as any),
                hasherTransform,
                createWriteStream(filePath),
            );
            checksum = hasher.digest("hex");
        }
    }
    const key = crypto.randomBytes(24).toString("hex");
    const createdAt = Date.now();
    const passwordSalt = isPrivate ? crypto.randomBytes(16).toString("hex") : "";
    const passwordHash = isPrivate ? hashPassword(passwordSalt, password) : "";

    index.filesById[id] = {
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
    };
    index.idByKey[key] = id;
    await saveIndex(index);


    return json(
        {
            id,
            ext,
            type: file.type || "application/octet-stream",
            checksum,
            key,
            origin: url.origin,
            private: isPrivate,
        },
        { headers: corsHeaders(request) },
    );
};

export const OPTIONS: RequestHandler = async ({ request }) => {
    return new Response("ok", {
        status: 200,
        headers: corsHeaders(request),
    });
};
