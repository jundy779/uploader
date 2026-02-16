import { MongoClient, GridFSBucket, type Db } from "mongodb";
import { env } from "$env/dynamic/private";

export interface StoredFile {
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
}

const uri = env.MONGODB_URI || "";
const dbName = env.MONGODB_DB || "uploader";
const bucketName = env.MONGODB_BUCKET || "uploads";

let client: MongoClient | null = null;

export const getMongo = async (): Promise<{db: Db, bucket: GridFSBucket, bucketName: string, client: MongoClient}> => {
  if (!uri) throw new Error("Missing MONGODB_URI");
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  const db = client.db(dbName);
  const bucket = new GridFSBucket(db, { bucketName });
  return { db, bucket, bucketName, client };
};

export const getFileMetadata = async (identifier: string, type: 'id' | 'key' = "id"): Promise<StoredFile | null> => {
  const { db } = await getMongo();
  const collection = db.collection<StoredFile>("files");
  // @ts-ignore
  const query = type === "id" ? { id: identifier } : { key: identifier };
  return await collection.findOne(query);
};

export const saveFileMetadata = async (fileData: StoredFile): Promise<void> => {
  const { db } = await getMongo();
  const collection = db.collection<StoredFile>("files");
  // @ts-ignore: MongoDB adds _id automatically
  await collection.insertOne(fileData);
};

export const deleteFileMetadata = async (id: string): Promise<void> => {
  const { db } = await getMongo();
  const collection = db.collection<StoredFile>("files");
  // @ts-ignore
  await collection.deleteOne({ id });
};
