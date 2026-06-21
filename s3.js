const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const s3 = new S3Client({ region: process.env.S3_REGION });
const BUCKET = process.env.S3_BUCKET;

// Generates a presigned URL the browser can PUT a file to directly.
async function createUploadUrl(coachId, contentType) {
  const key = `licences/${coachId}/${crypto.randomUUID()}`;
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 minutes
  return { url, key };
}

// Generates a short-lived URL for admins to view a licence document.
async function createViewUrl(key) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: 300 }); // 5 minutes
}

module.exports = { createUploadUrl, createViewUrl };
