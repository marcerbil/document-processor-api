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
require("dotenv").config();
const app = express();
const multerStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({
  storage: multerStorage,
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024, // 10mb
    files: 10,
  },
});
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // limit each IP to 15 requests per windowMs
});
const PORT = process.env.PORT;
const corsOptions = {
  origin: process.env.REACT_APP_URL,
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
const maxSize = 10 * 1024 * 1024; // 10 MB

const client = new DocumentProcessorServiceClient();
const storage = new Storage();

// add api key auth
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || !validKeys.includes(apiKey)) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};
app.use(apiKeyAuth);

async function uploadFile(file, destFileName) {
  const options = {
    destination: destFileName,
  };

  if (file.size > maxSize) {
    console.log(`${destFileName} is ${file.size}. Max file size ${maxSize}.`);
  } else {
    try {
      await storage.bucket(gcsInputUri).upload(file.path, options);
      console.log(`${destFileName} uploaded to ${gcsInputUri}`);
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

async function cleanup() {
  console.log("Cleaning up...");
  // read all files in the directory
  let directoryPath = path.join(__dirname, "processed");
  let uploadsPath = path.join(__dirname, "uploads");
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

// app.post("/process-invoice", async (req, res) => {
//   const { content } = req.body;
//   // console.log(content);

//   const request = {
//     name: `projects/${projectId}/locations/${location}/processors/${processorId}`,
//     rawDocument: {
//       content: content,
//       mimeType: "application/pdf",
//     },
//   };

//   try {
//     // Send the document for processing
//     const [result] = await client.processDocument(request);

//     // Extract the invoice data
//     const { document } = result;
//     const invoiceData = document.entities;

//     if (!invoiceData) {
//       throw new Error("Could not extract invoice data from the document");
//     } else {
//       // Send the extracted invoice data back as JSON
//       res.json({
//         ...invoiceData,
//       });
//     }
//   } catch (err) {
//     console.error("Error processing document:", err);
//     res.status(500).send("Error processing document");
//   }
// });

// Batch processing

app.post(
  "/process-multiple",
  upload.array("files[]"),
  async function (req, res, next) {
    const files = req.files;

    // 1. Upload docs to gcs bucket
    const promises = [];
    files.forEach((file) => {
      promises.push(uploadFile(file, file.filename));
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
          gcsUri: `${gcsOutputUri}/${gcsOutputUriPrefix}`,
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
          .getFiles({ prefix: `${gcsOutputUriPrefix}/` });
        console.log(filesArray);

        // 3. Download resulting files from output bucket
        const downloadedFiles = [];
        for (const file of filesArray) {
          const fileName = path.basename(file.name);
          const destination = path.join(__dirname, "processed", fileName);
          await file.download({ destination });

          downloadedFiles.push({
            name: fileName,
            path: path.resolve(destination),
          });
        }
        res.json(downloadedFiles);

        console.log("Document processing complete.");
      } catch (err) {
        console.error("Error processing documents:", err);
        res.status(500).send("Error processing documents");
      }
    }
  }
);

// download all processed files
app.get("/processed", async (req, res) => {
  try {
    let directoryPath = path.join(__dirname, "processed");

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
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
