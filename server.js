import "dotenv/config";
import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

import { BlobServiceClient } from "@azure/storage-blob";
import { CosmosClient } from "@azure/cosmos";

const app = express();
const PORT = process.env.PORT || 3000;

// Needed because we're using ES Modules import syntax
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== 1) Basic middleware =====
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Serve HTML pages
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "index.html")),
);
app.get("/profile/:id", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "profile.html")),
);

// ===== 2) Validate env =====
const requiredEnv = [
  "COSMOS_ENDPOINT",
  "COSMOS_KEY",
  "COSMOS_DATABASE",
  "COSMOS_CONTAINER",
  "BLOB_CONNECTION_STRING",
  "BLOB_CONTAINER",
];

for (const k of requiredEnv) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`);
  }
}

// ===== 3) Cosmos DB client =====
const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,
});

const cosmosDb = cosmosClient.database(process.env.COSMOS_DATABASE);
const cosmosContainer = cosmosDb.container(process.env.COSMOS_CONTAINER);

// ===== 4) Blob Storage client =====
const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.BLOB_CONNECTION_STRING,
);
const blobContainerClient = blobServiceClient.getContainerClient(
  process.env.BLOB_CONTAINER,
);

// ===== 5) File upload (Multer memory) =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB limit
});

// Health check
app.get("/api/health", async (req, res) => {
  res.json({ ok: true, message: "Service is running" });
});

// ===== API: Upload image to Blob =====
app.post("/api/upload", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .send("No file uploaded. Field name must be 'photo'.");

    // Ensure container exists (safe to call)
    await blobContainerClient.createIfNotExists();

    const ext = path.extname(req.file.originalname) || ".jpg";
    const blobName = `${uuidv4()}${ext}`;

    const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    // Public URL (works if container is public)
    const imageUrl = blockBlobClient.url;

    res.json({ imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).send("Upload failed.");
  }
});

// ===== API: Create profile in Cosmos (store imageUrl) =====
app.post("/api/profiles", async (req, res) => {
  try {
    const { name, age, bio, imageUrl } = req.body;

    if (!name || age === undefined || !bio || !imageUrl) {
      return res
        .status(400)
        .send("Missing fields: name, age, bio, imageUrl are required.");
    }

    const id = uuidv4();
    const doc = {
      id,
      name,
      age,
      bio,
      imageUrl,
      createdAt: new Date().toISOString(),
    };

    await cosmosContainer.items.create(doc);

    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).send("Create profile failed.");
  }
});

// ===== API: Read profile by id =====
app.get("/api/profiles/:id", async (req, res) => {
  try {
    const id = req.params.id;

    // If your partition key is /id, read works directly
    // Otherwise we do a query to keep it simple for any partition key.
    const query = {
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: id }],
    };

    const { resources } = await cosmosContainer.items.query(query).fetchAll();

    if (!resources || resources.length === 0) {
      return res.status(404).send("Not found");
    }

    res.json(resources[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Read profile failed.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
