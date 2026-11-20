# Upload files to an existing part

Read the owning project's WorkshopAssembly with identifiers enabled. Select the saved item ID and current project revision. For a referenced item, open the source project. Assembly edits that change hierarchy, quantities or native CAD features still use UpdateWorkshopAssembly.

Call the production MCP mutation UploadWorkshopAssemblyFile with an input object containing projectId, itemId, expectedRevision, fileName, sha256 (lowercase hex), and bytes. For STL include meshBounds with min and max XYZ arrays in millimeters, in the part's local coordinates. Workshop uses the item's saved placements to position it. File names are case-sensitive. Supported suffixes are .stl, .step, .stp, .mp4, .webm and .gif. Each file may be up to 25 MiB.

If the result is awaiting_upload, PUT the exact file bytes to upload.url with the supplied upload.headers, then repeat the mutation with identical input. Treat the signed URL as temporary and private. An attached result contains the new project revision. Use it for the next file. On conflict, reread the project before proceeding.

Call VerifyWorkshopAssemblyFile with input containing projectId, itemId and fileName. A verified receipt means the server read the stored bytes and matched their SHA-256 and length. Compare both to the local file. Open the item in the project overview to see its mesh, download files or play clips. The downloadPath in the receipt is relative to the installation mount. A clip is a recording. Interactive mechanism playback uses saved driveMotion.

Files use the same organization-private storage as Workshop build artifacts, with one-year retention. Keep the fabrication originals.
