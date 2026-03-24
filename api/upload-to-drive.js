const { google } = require("googleapis");
const { Readable } = require("stream");

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function normalizePrivateKey(rawValue) {
  let key = String(rawValue || "").trim();
  if (!key) return "";

  // Handle cases where env value is wrapped in quotes.
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  // Convert escaped newlines into real newlines.
  key = key.replace(/\\n/g, "\n");

  // Basic sanity for PEM format.
  if (!key.includes("-----BEGIN PRIVATE KEY-----") || !key.includes("-----END PRIVATE KEY-----")) {
    return "";
  }
  return key;
}

async function createFolder(drive, name, parentFolderId) {
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentFolderId ? [parentFolderId] : undefined
    },
    fields: "id,name",
    supportsAllDrives: true
  });
  return response.data;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "submission";
}

async function uploadTextFile(drive, folderId, fileName, content) {
  const textStream = Readable.from([Buffer.from(content, "utf8")]);
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType: "application/json",
      body: textStream
    },
    fields: "id,name",
    supportsAllDrives: true
  });
  return response.data;
}

async function uploadImageFile(drive, folderId, fileName, mimeType, base64Content) {
  const fileBuffer = Buffer.from(base64Content, "base64");
  const imageStream = Readable.from([fileBuffer]);
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: imageStream
    },
    fields: "id,name",
    supportsAllDrives: true
  });
  return response.data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const {
      payload,
      imageBase64,
      imageName,
      imageMimeType
    } = req.body || {};

    if (!payload || !payload.companyName || !imageBase64 || !imageName || !imageMimeType) {
      return json(res, 400, { error: "Missing required fields" });
    }

    if (imageMimeType !== "image/png" || !imageName.toLowerCase().endsWith(".png")) {
      return json(res, 400, { error: "Only PNG files are allowed" });
    }

    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
    const parentFolderId = String(process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || "").trim();

    if (!clientEmail || !privateKey || !parentFolderId) {
      return json(res, 500, {
        error: "Missing or invalid Google Drive environment variables",
        details:
          "Check GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY (full PEM), and GOOGLE_DRIVE_PARENT_FOLDER_ID."
      });
    }

    // Fast-fail with clearer message for malformed folder IDs.
    if (!/^[a-zA-Z0-9_-]{10,}$/.test(parentFolderId)) {
      return json(res, 500, {
        error: "Invalid Google Drive parent folder ID",
        details: "GOOGLE_DRIVE_PARENT_FOLDER_ID format looks invalid."
      });
    }

    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/drive"]
    });

    // Force token initialization here so key parsing/auth errors are explicit.
    await auth.authorize();
    const drive = google.drive({ version: "v3", auth });
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const companySlug = slugify(payload.companyName);

    let targetFolderId = parentFolderId;
    let createdFolder = null;

    // Optional behavior: set GOOGLE_CREATE_SUBMISSION_FOLDER=true to create
    // one subfolder per submit. Default is false (upload directly to root folder).
    if (String(process.env.GOOGLE_CREATE_SUBMISSION_FOLDER || "").toLowerCase() === "true") {
      createdFolder = await createFolder(
        drive,
        `${companySlug}-${timestamp}`,
        parentFolderId
      );
      targetFolderId = createdFolder.id;
    }

    const storesFile = await uploadTextFile(
      drive,
      targetFolderId,
      `${companySlug}-${timestamp}-selected-stores.json`,
      JSON.stringify(
        {
          submittedAt: new Date().toISOString(),
          submission: payload
        },
        null,
        2
      )
    );
    const imageFile = await uploadImageFile(
      drive,
      targetFolderId,
      `${companySlug}-${timestamp}-${imageName}`,
      imageMimeType,
      imageBase64
    );

    return json(res, 200, {
      success: true,
      folderId: targetFolderId,
      createdSubmissionFolder: createdFolder
        ? { id: createdFolder.id, name: createdFolder.name }
        : null,
      imageFileId: imageFile.id,
      storesFileId: storesFile.id
    });
  } catch (error) {
    const apiMessage =
      error &&
      error.response &&
      error.response.data &&
      error.response.data.error &&
      error.response.data.error.message;

    return json(res, 500, {
      error: "Google Drive upload failed",
      details: apiMessage || error.message
    });
  }
};
