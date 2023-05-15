const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const { DocumentProcessorServiceClient } =
  require("@google-cloud/documentai").v1;
const { Storage } = require("@google-cloud/storage");
//require("dotenv").config();
const uuid = require('uuid');
const app = express();
const uniqueId = uuid.v4();
const multerStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Create a unique directory for the user's session ID if it doesn't exist
    const uniqueDir = `uploads/${uniqueId}`;
    if (!fs.existsSync(uniqueDir)) {
      fs.mkdirSync(uniqueDir);
    }
    cb(null, uniqueDir);
  },
  filename: function (req, file, cb) {
    cb(null, `${uniqueId}-${file.originalname}`);
  }
});
const upload = multer({
  storage: multerStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10mb
    files: 10,
  },
});
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 15 minutes
  max: 15, // limit each IP to 15 requests per windowMs
});
const PORT = process.env.PORT;
const corsOptions = {
  origin: process.env.REACT_APP_URL,
  allowedHeaders: ["X-API-KEY", "Origin"],
  methods: ['GET', 'POST', 'OPTIONS'],
  optionsSuccessStatus: 200,
};
const projectId = process.env.GOOGLE_PROJECT_ID;
const location = process.env.GOOGLE_PROJECT_LOCATION;
const processorId = process.env.GOOGLE_DOCUMENT_PROCESSOR_ID;
const gcsOutputUri = process.env.GCS_OUTPUT_BUCKET_URI;
const gcsOutputUriPrefix = process.env.GCS_OUTPUT_BUCKET_PREFIX;
const gcsInputUri = process.env.GCS_INPUT_BUCKET_URI;
const validKeys = process.env.VALID_KEYS.split(',');

app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ limit: "10mb", extended: true }));
app.use("/process-invoice", limiter);
app.use("/process-multiple", limiter);
app.use("/processed", limiter);

let filesUploaded = false;
let uDirCreated = false;
const maxSize = 10 * 1024 * 1024; // 10 MB

const client = new DocumentProcessorServiceClient();
const storage = new Storage();

// Checks for authenticated API key
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || !validKeys.includes(apiKey)) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};
app.use(apiKeyAuth);

// Asynchronously creates a directory in a GCS bucket
async function createDirectory(bucketName, directoryName) {
  const bucket = storage.bucket(bucketName);
  const options = {
    metadata: {
      contentType: 'application/x-www-form-urlencoded',
      metadata: {
        custom: 'metadata',
      },
    },
  };

  try {
    await bucket.file(`${directoryName}`).save('', options);
    console.log(`Bucket directory ${directoryName} created.`);
  } catch (err) {
    console.error(`Error creating bucket directory ${directoryName}:`, err);
    throw err;
  }
}

// Asynchronously uploads a file to a GCS bucket
async function uploadFile(file, destFileName, directory) {

  const options = {
    destination: destFileName,
  };

  if (file.size > maxSize) {
    console.log(`${destFileName} is ${file.size}. Max file size ${maxSize}.`);
  } else if (file.name == "invoices/") {
    return;
  } else {
    try {
      console.log(file.path);
      await storage.bucket(`${gcsInputUri}`).upload(`${file.path}`, options);
      console.log(`${destFileName} uploaded to ${gcsInputUri}/${directory}`);
      filesUploaded = true;
    } catch (err) {
      console.error(
        `Error uploading file ${destFileName} to ${gcsInputUri}:`,
        err
      );
      throw err;
    }
  }
}

// Asynchronously cleans up folders
async function cleanup() {
  console.log("Cleaning up...");

  // read all files in the directory
  let directoryPath = path.join(__dirname, "processed", uniqueId);
  let uploadsPath = path.join(__dirname, "uploads", uniqueId);
  let files = await fs.promises.readdir(directoryPath);
  let uploads = await fs.promises.readdir(uploadsPath);

  // cleanup: delete files in processed & uploads
  files.forEach((file) => {
    fs.unlink(path.join(directoryPath, file), (err) => {
      if (err) console.log(err);
    });
  });
  uploads.forEach((file) => {
    fs.unlink(path.join(uploadsPath, file), (err) => {
      if (err) console.log(err);
    });
  });
  
  console.log("Clean up - done");
}


app.post(
  "/process-multiple",
  upload.array("files[]"),
  async function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', process.env.REACT_APP_URL);

    const files = req.files;

    // 1. Upload docs to gcs bucket
    const promises = [];
    if (uDirCreated === false) {
      await createDirectory(gcsInputUri, uniqueId);
    }

    files.forEach((file) => {
      promises.push(uploadFile(file, file.filename, uniqueId));
    });
    await Promise.all(promises);

    // 2. Make request to bucket to process documents and save to output bucket
    const request = {
      name: `projects/${projectId}/locations/${location}/processors/${processorId}`,
      inputDocuments: {
        gcsDocuments: {
          documents: files.map((file) => {
            return {
              gcsUri: `${gcsInputUri}/${file.filename}`,
              mimeType: "application/pdf",
            };
          }),
        },
      },
      documentOutputConfig: {
        gcsOutputConfig: {
          gcsUri: `${gcsOutputUri}/${gcsOutputUriPrefix}/${uniqueId}/`,
        },
      },
    };

    if (filesUploaded === true) {
      try {
        // Batch process document using a long-running operation.
        const [operation] = await client.batchProcessDocuments(request);

        // Wait for operation to complete.
        console.log("Processing documents...");
        await operation.promise();

        // Query Storage bucket for the results file(s).
        console.log("Fetching results ...");
        const [filesArray] = await storage
          .bucket(gcsOutputUri)
          .getFiles({ prefix: `${gcsOutputUriPrefix}` });

        // 3. Download resulting files from output bucket
        const downloadedFiles = [];
        for (const file of filesArray) {
          const fileName = path.basename(file.name);
          const uPath = path.join(__dirname, "processed", uniqueId)
          const destination = path.join(__dirname, "processed", uniqueId, fileName);
          if (!fs.existsSync(uPath)) {
            fs.mkdirSync(uPath);
          }
          await file.download({ destination });

          downloadedFiles.push({
            name: fileName,
            path: path.resolve(destination),
          });
        }
        
        console.log("Document processing complete.");
        res.json(downloadedFiles);
      } catch (err) {
        console.error("Error processing documents:", err);
        res.status(500).send("Error processing documents");
      }
    }

    next();
  }
);

// download all processed files
app.get("/processed", async (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.REACT_APP_URL);

  try {
    let directoryPath = path.join(__dirname, "processed", uniqueId);

    // read all files in the directory
    let files = await fs.promises.readdir(directoryPath);

    console.log("Downloading results...");

    // create an array of file objects
    const fileObjects = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(directoryPath, file);
        const fileData = await fs.promises.readFile(filePath, "utf-8");
        return { name: file, data: fileData };
      })
    );

    // send files
    res.json(fileObjects);
    console.log("Downloading results - done");

    await cleanup();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }

  next();
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
