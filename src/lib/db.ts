import { MongoClient, GridFSBucket, ObjectId } from "mongodb";
import { env } from "$env/dynamic/private";

/**
 * @typedef {Object} StoredFile
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {string} ext
 * @property {string} key
 * @property {string} checksum
 * @property {number} size
 * @property {number} createdAt
 * @property {string} filePath
 * @property {boolean} [private]
 * @property {string} [passwordSalt]
 * @property {string} [passwordHash]
 * @property { "fs" | "mongodb" | "blob" | "r2" } [storage]
 * @property {string} [gridfsId]
 * @property {string} [blobPathname]
 * @property {string} [r2Bucket]
 * @property {string} [r2Key]
 */

const uri = env.MONGODB_URI || "";
const dbName = env.MONGODB_DB || "uploader";
const bucketName = env.MONGODB_BUCKET || "uploads";

/** @type {MongoClient | null} */
let client = null;

/**
 * @returns {Promise<{db: import("mongodb").Db, bucket: GridFSBucket, bucketName: string, client: MongoClient}>}
 */
export const getMongo = async () => {
  if (!uri) throw new Error("Missing MONGODB_URI");
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  const db = client.db(dbName);
  const bucket = new GridFSBucket(db, { bucketName });
  return { db, bucket, bucketName, client };
};

/**
 * Retrieves file metadata by ID (public ID) or Key (admin/delete key).
 * @param {string} identifier - The file ID or the administrative Key.
 * @param {'id'|'key'} type - Whether searching by 'id' or 'key'.
 * @returns {Promise<StoredFile | null>}
 */
export const getFileMetadata = async (identifier, type = "id") => {
  const { db } = await getMongo();
  const collection = db.collection("files");
  const query = type === "id" ? { id: identifier } : { key: identifier };
  return await collection.findOne(query);
};

/**
 * Saves file metadata to the database.
 * @param {StoredFile} fileData
 * @returns {Promise<void>}
 */
export const saveFileMetadata = async (fileData) => {
  const { db } = await getMongo();
  const collection = db.collection("files");

  // Ensure uniqueness if needed, though ID generation logic handles collisions reasonably well.
  // Ideally we would create an index on 'id' and 'key' in a real setup script.

  await collection.insertOne(fileData);
};

/**
 * Deletes file metadata from the database.
 * @param {string} id
 * @returns {Promise<void>}
 */
export const deleteFileMetadata = async (id) => {
  const { db } = await getMongo();
  const collection = db.collection("files");
  await collection.deleteOne({ id });
};
