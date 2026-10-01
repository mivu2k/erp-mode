import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';

/** Repo root (folder with pnpm-workspace.yaml) so a relative UPLOAD_DIR means the same folder however the API is started. */
function projectRoot(from = process.cwd()): string {
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, 'pnpm-workspace.yaml'))) return d;
    if (dirname(d) === d) return from;
  }
}

/**
 * File storage behind the API. STORAGE=s3 uses MinIO/S3 (private bucket); anything else stores under UPLOAD_DIR.
 * Browsers never talk to the bucket directly, so no CORS or public endpoint is needed.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  readonly driver = process.env.STORAGE === 's3' ? 's3' : 'local';
  private readonly bucket = process.env.MINIO_BUCKET ?? 'erp';
  private readonly dir = resolve(projectRoot(), process.env.UPLOAD_DIR ?? 'uploads');
  private s3 = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'minio', secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'minio12345' },
  });

  async onModuleInit() {
    if (this.driver === 'local') return mkdir(this.dir, { recursive: true }).then(() => undefined);
    await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket })).catch((e: Error) => {
      if (!/BucketAlready|OwnedByYou/.test(e.name)) new Logger('Storage').warn(`Bucket check failed: ${e.message}`);
    });
  }

  /** Keys are generated server-side; the resolve check still blocks any path escaping the upload dir. */
  private path(key: string) {
    const p = resolve(join(this.dir, key));
    if (!p.startsWith(this.dir + '/')) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, body: Buffer, mimeType: string) {
    if (this.driver === 's3') return void (await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mimeType })));
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async stream(key: string): Promise<Readable> {
    if (this.driver === 's3') return (await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))).Body as Readable;
    return createReadStream(this.path(key));
  }

  async read(key: string): Promise<Buffer> {
    if (this.driver === 's3') {
      const chunks: Buffer[] = [];
      for await (const c of await this.stream(key)) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    }
    return readFile(this.path(key));
  }
}
