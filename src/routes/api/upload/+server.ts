import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
};

type Index = {
    filesById: Record<string, StoredFile>;
    idByKey: Record<string, string>;
};

const dataDir = path.resolve(
    process.env.UPLOADER_DATA_DIR ||
        (process.env.VERCEL ? "/tmp/uploader" : ".data/uploader"),
);
const filesDir = path.join(dataDir, "files");
const indexPath = path.join(dataDir, "index.json");
const maxBytes = Number(process.env.UPLOADER_MAX_BYTES || 104_857_600);
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
    await mkdir(filesDir, { recursive: true });
    const filePath = path.join(filesDir, `${id}${ext}`);

    await pipeline(
        Readable.fromWeb(file.stream() as any),
        createWriteStream(filePath),
    );

    const checksum = await md5File(filePath);
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
    };
    index.idByKey[key] = id;
    await saveIndex(index);

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
