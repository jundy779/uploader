import type { RequestHandler } from "./$types";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getMongo, getFileMetadata } from "$lib/db";
import { ObjectId } from "mongodb";

export const GET: RequestHandler = async ({ params, url, request }) => {
    const id = (params.id || "").split(".")[0];
    const skipCd = url.searchParams.get("skip-cd") === "true";
    
    const meta = await getFileMetadata(id, 'id');

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
