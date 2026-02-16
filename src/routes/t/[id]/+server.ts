import type { RequestHandler } from "./$types";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getMongo, getFileMetadata } from "$lib/db";
import { ObjectId } from "mongodb";
import { env } from "$env/dynamic/private";

export const GET: RequestHandler = async ({ params, url, request }) => {
    const id = (params.id || "").split(".")[0];
    
    const meta = await getFileMetadata(id, 'id');

    if (!meta || !meta.type?.startsWith("image/")) {
        return new Response("Not found", { status: 404 });
    }

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
                "content-type": meta.type,
                "cache-control": "public, max-age=31536000, immutable",
            },
        });
    } else if (meta.storage === "r2" && meta.r2Bucket && meta.r2Key) {
        const endpoint = env.R2_ENDPOINT || "";
        const accessKeyId = env.R2_ACCESS_KEY_ID || "";
        const secretAccessKey = env.R2_SECRET_ACCESS_KEY || "";
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
    return new Response(stream, {
        headers: {
            "content-type": meta.type,
            "cache-control": "public, max-age=31536000, immutable",
        },
    });
};
