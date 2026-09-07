# File and folder uploads

The backend accepts every file extension, including executables, installers,
archives, source code, dotfiles, extensionless files, and custom formats.
Known extensions use a normalized MIME type. Unknown formats keep a valid supplied
MIME type or fall back to `application/octet-stream` when it is absent or invalid.
Files are stored as objects; accepting a format does not add a preview for it.

Authentication, folder ownership, storage-object ownership, and actual uploaded
size checks still apply. The API file limit is 100 GiB; deployment storage limits
may be lower. The server-buffered `/upload/file` fallback is limited to 100 MiB.
Use multipart uploads for large files. Zero-byte files use single uploads.

## Single file

1. POST `/api/v1/upload/presigned-url` with `fileName`, `fileSize`, optional
   `mimeType`, and optional `folderId`.
2. PUT the bytes to the returned `url`, using the returned `mimeType` as the
   `Content-Type` header.
3. POST `/api/v1/files` with the returned `key`, `fileId`, `uploadSessionId`,
   normalized `mimeType`, original filename as `originalName`, byte count as
   `size`, and the destination `folderId` if applicable.

These responses wrap the service result in `data`.

## Folder tree

POST `/api/v1/upload/folder`:

```json
{
  "folderName": "Project",
  "directories": ["empty", "assets/unused"],
  "files": [
    {
      "fileName": "setup.exe",
      "mimeType": "application/octet-stream",
      "fileSize": 1024,
      "relativePath": "tools/setup.exe"
    },
    {
      "fileName": "README",
      "fileSize": 0,
      "relativePath": "README"
    }
  ]
}
```

`relativePath` and `directories` are relative to `folderName`: send
`tools/setup.exe`, not `Project/tools/setup.exe`. Forward slashes and Windows
backslashes are accepted. Absolute paths, `.` or `..` segments, empty segments,
control characters, duplicate file paths, and file/directory collisions are
rejected before creating the hierarchy. Each file path must end with `fileName`.

`directories` is optional and preserves empty directories. An empty root can be
created with `{ "folderName": "Empty", "files": [] }`; `files` can also be omitted.
Add `parentFolderId` to place the uploaded tree inside an existing writable folder.

For each entry in `data.files`:

- `uploadType: "single"`: PUT bytes to `uploadUrl` using the returned `mimeType`.
- `uploadType: "multipart"`: request each part URL from
  `/api/v1/upload/multipart/part-url` using `uploadId`, `key`, and `partNumber`.
  Upload the chunks using the returned `partSize` and `partCount`, retain each
  response ETag, then POST `/api/v1/upload/multipart/complete` with `uploadId`,
  `key`, and `parts: [{ "partNumber": 1, "etag": "..." }]`.

After storage upload completes, POST `/api/v1/files/batch` with
`{ "files": [...] }`. Each entry includes `fileId`, `fileName`, `originalName`,
`mimeType`, `size`, `key`, `folderId`, and `uploadSessionId` from the upload result
(`size` is the returned `fileSize`; `originalName` is the original `fileName`).
There is no metadata call for empty directories or an empty root.

## Frontend integration

The frontend must allow all file extensions in its picker and validation, send
directory paths in the format above, and explicitly include empty directories
when its directory-selection mechanism can enumerate them. Backend changes alone
do not update the frontend picker. Keep file uploads concurrent with a bounded
limit instead of sending the whole folder through the server-buffered endpoint.

Live browser-to-R2 uploads require the existing bucket CORS configuration.
