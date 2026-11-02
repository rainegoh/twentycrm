import fs from 'fs';
import { dirname } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { type ReadableStream as NodeReadableStream } from 'stream/web';

import {
  BlobNotFoundError,
  BlobPreconditionFailedError,
  copy,
  del,
  get,
  head,
  list,
  put,
} from '@vercel/blob';
import { isDefined } from 'twenty-shared/utils';

import { type StorageDriver } from 'src/engine/core-modules/file-storage/drivers/interfaces/storage-driver.interface';
import {
  FileStorageException,
  FileStorageExceptionCode,
} from 'src/engine/core-modules/file-storage/interfaces/file-storage-exception';
import { type ByteRange } from 'src/engine/core-modules/file-storage/types/byte-range.type';
import { type FileStorageMetadata } from 'src/engine/core-modules/file-storage/types/file-storage-metadata.type';

export type VercelBlobDriverOptions = {
  token: string;
};

// Blobs are private: every read goes through the server, which keeps Twenty's
// content-type and disposition guarantees, so presigned URLs are not offered.
export class VercelBlobDriver implements StorageDriver {
  private readonly token: string;

  constructor(options: VercelBlobDriverOptions) {
    this.token = options.token;
  }

  private joinPath(folderPath: string, filename?: string): string {
    return isDefined(filename) ? `${folderPath}/${filename}` : folderPath;
  }

  private notFound(): FileStorageException {
    return new FileStorageException(
      'File not found',
      FileStorageExceptionCode.FILE_NOT_FOUND,
    );
  }

  private async getBlob(filePath: string, headers?: HeadersInit) {
    const result = await get(filePath, {
      access: 'private',
      token: this.token,
      useCache: false,
      headers,
    });

    if (!isDefined(result) || result.statusCode !== 200) {
      throw this.notFound();
    }

    return result;
  }

  async readFile(params: {
    filePath: string;
    byteRange?: ByteRange;
  }): Promise<Readable> {
    const { stream } = await this.getBlob(
      params.filePath,
      isDefined(params.byteRange)
        ? {
            Range: `bytes=${params.byteRange.startByte}-${params.byteRange.endByte}`,
          }
        : undefined,
    );

    return Readable.fromWeb(stream as NodeReadableStream<Uint8Array>);
  }

  async readFilePrefix(params: {
    filePath: string;
    byteCount: number;
  }): Promise<Buffer> {
    if (params.byteCount <= 0) {
      return Buffer.alloc(0);
    }

    const { stream } = await this.getBlob(params.filePath, {
      Range: `bytes=0-${params.byteCount - 1}`,
    });
    const buffer = Buffer.from(await new Response(stream).arrayBuffer());

    // Guard against a backend that ignores the Range header.
    return buffer.subarray(0, params.byteCount);
  }

  async writeFile(params: {
    filePath: string;
    sourceFile: Buffer | Uint8Array | string;
    mimeType: string | undefined;
  }): Promise<void> {
    await put(
      params.filePath,
      typeof params.sourceFile === 'string'
        ? params.sourceFile
        : Buffer.from(params.sourceFile),
      {
        access: 'private',
        token: this.token,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: params.mimeType,
      },
    );
  }

  async writeFileStream(params: {
    filePath: string;
    stream: Readable;
    mimeType: string | undefined;
  }): Promise<void> {
    await put(params.filePath, params.stream, {
      access: 'private',
      token: this.token,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: params.mimeType,
      multipart: true,
    });
  }

  async getFileMetadata(params: {
    filePath: string;
  }): Promise<FileStorageMetadata | null> {
    try {
      const blob = await head(params.filePath, { token: this.token });

      return { size: blob.size, checksum: blob.etag };
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        return null;
      }

      throw error;
    }
  }

  async downloadFile(params: {
    onStoragePath: string;
    localPath: string;
  }): Promise<void> {
    fs.mkdirSync(dirname(params.localPath), { recursive: true });

    const fileStream = await this.readFile({ filePath: params.onStoragePath });

    await pipeline(fileStream, fs.createWriteStream(params.localPath));
  }

  private async listPathnames(prefix: string): Promise<string[]> {
    const pathnames: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await list({ prefix, cursor, token: this.token });

      pathnames.push(...page.blobs.map((blob) => blob.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (isDefined(cursor));

    return pathnames;
  }

  async delete(params: {
    folderPath: string;
    filename?: string;
  }): Promise<void> {
    if (isDefined(params.filename)) {
      await del(this.joinPath(params.folderPath, params.filename), {
        token: this.token,
      });

      return;
    }

    const pathnames = await this.listPathnames(`${params.folderPath}/`);

    for (let index = 0; index < pathnames.length; index += 1000) {
      await del(pathnames.slice(index, index + 1000), { token: this.token });
    }
  }

  private async copyBlob(fromPath: string, toPath: string, ifMatch?: string) {
    try {
      const source = await head(fromPath, { token: this.token });

      if (isDefined(ifMatch) && source.etag !== ifMatch) {
        throw new FileStorageException(
          `Object at ${fromPath} changed since it was inspected`,
          FileStorageExceptionCode.PRECONDITION_FAILED,
        );
      }

      await copy(fromPath, toPath, {
        access: 'private',
        token: this.token,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: source.contentType,
      });
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        throw this.notFound();
      }

      if (error instanceof BlobPreconditionFailedError) {
        throw new FileStorageException(
          `Object at ${fromPath} changed since it was inspected`,
          FileStorageExceptionCode.PRECONDITION_FAILED,
        );
      }

      throw error;
    }
  }

  // Applies a per-file operation to every blob under `from`, keeping relative paths.
  private async forEachInFolder(
    fromFolder: string,
    toFolder: string,
    operation: (fromPath: string, toPath: string) => Promise<void>,
  ): Promise<void> {
    const pathnames = await this.listPathnames(`${fromFolder}/`);

    if (pathnames.length === 0) {
      throw new Error(`No objects found in the source folder ${fromFolder}.`);
    }

    for (const pathname of pathnames) {
      await operation(
        pathname,
        `${toFolder}${pathname.slice(fromFolder.length)}`,
      );
    }
  }

  async move(params: {
    from: { folderPath: string; filename?: string };
    to: { folderPath: string; filename?: string };
    ifMatchChecksum?: string;
  }): Promise<void> {
    const moveBlob = async (
      fromPath: string,
      toPath: string,
      ifMatch?: string,
    ) => {
      await this.copyBlob(fromPath, toPath, ifMatch);
      await del(fromPath, { token: this.token });
    };

    if (!params.from.filename || !params.to.filename) {
      await this.forEachInFolder(
        params.from.folderPath,
        params.to.folderPath,
        moveBlob,
      );

      return;
    }

    await moveBlob(
      this.joinPath(params.from.folderPath, params.from.filename),
      this.joinPath(params.to.folderPath, params.to.filename),
      params.ifMatchChecksum,
    );
  }

  async copy(params: {
    from: { folderPath: string; filename?: string };
    to: { folderPath: string; filename?: string };
  }): Promise<void> {
    if (!params.from.filename && params.to.filename) {
      throw new Error('Cannot copy folder to file');
    }

    if (isDefined(params.from.filename)) {
      await this.copyBlob(
        this.joinPath(params.from.folderPath, params.from.filename),
        this.joinPath(
          params.to.folderPath,
          params.to.filename ?? params.from.filename,
        ),
      );

      return;
    }

    await this.forEachInFolder(
      params.from.folderPath,
      params.to.folderPath,
      (fromPath, toPath) => this.copyBlob(fromPath, toPath),
    );
  }

  async checkFileExists(params: { filePath: string }): Promise<boolean> {
    return isDefined(await this.getFileMetadata(params));
  }

  async checkFolderExists(params: { folderPath: string }): Promise<boolean> {
    const page = await list({
      prefix: params.folderPath,
      limit: 1,
      token: this.token,
    });

    return page.blobs.length > 0;
  }

  async getPresignedUrl(): Promise<string | null> {
    return null;
  }

  async getPresignedUploadUrl(): Promise<string | null> {
    return null;
  }
}
