import type { RequestHandler } from "./$types";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import { MongoClient, GridFSBucket, ObjectId } from "mongodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

type StoredFile = {
    filePath: string;
    type: string;
    name?: string;
    ext?: string;
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
};

const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const dataDir = path.resolve(
    process.env.UPLOADER_DATA_DIR || (isVercel ? "/tmp/uploader" : ".data/uploader"),
);
const indexPath = path.join(dataDir, "index.json");

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

    let nodeStream: any;
    if (meta.storage === "mongodb" && meta.gridfsId) {
        const { bucket } = await getMongo();
        nodeStream = bucket.openDownloadStream(new ObjectId(meta.gridfsId));
    } else if (meta.storage === "blob" && meta.filePath) {
        const blobResp = await fetch(meta.filePath);
        if (!blobResp.ok) return new Response("Not found", { status: 404 });
        return new Response(blobResp.body, {
            headers: {
                "content-type": meta.type || "application/octet-stream",
                "cache-control": "public, max-age=31536000, immutable",
            },
        });
    } else if (meta.storage === "r2" && meta.r2Bucket && meta.r2Key) {
        const endpoint = process.env.R2_ENDPOINT || "";
        const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
        const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
        if (!endpoint || !accessKeyId || !secretAccessKey) {
            return new Response("Server misconfigured", { status: 500 });
        }
        const s3 = new S3Client({
            region: "auto",
            endpoint,
            credentials: { accessKeyId, secretAccessKey },
        });
        const obj = await s3.send(
            new GetObjectCommand({ Bucket: meta.r2Bucket, Key: meta.r2Key }),
        );
        nodeStream = obj.Body as any;
    } else {
        nodeStream = createReadStream(meta.filePath);
    }
    const stream = Readable.toWeb(nodeStream) as any;
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
