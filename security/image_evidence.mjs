import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function tarEntries(bytes) {
  const entries = new Map();
  const extract = tar.extract();
  const completed = new Promise((resolve, reject) => {
    extract.on('error', reject);
    extract.on('finish', resolve);
    extract.on('entry', (header, stream, next) => {
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > 512 * 1024 * 1024) stream.destroy(new Error('Image entry exceeds the size limit'));
        else chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        const name = header.name.replace(/^\.\//, '');
        if (entries.has(name)) return reject(new Error('Duplicate archive entry ' + header.name));
        entries.set(name, Buffer.concat(chunks));
        next();
      });
    });
  });
  Readable.from(bytes).pipe(extract);
  await completed;
  return entries;
}

function blob(entries, digest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Unrecognized OCI digest');
  const bytes = entries.get('blobs/sha256/' + digest.slice(7));
  if (!bytes || sha256(bytes) !== digest.slice(7)) throw new Error('OCI blob missing or digest mismatch');
  return bytes;
}

export async function inspectImage(file, marker) {
  if (!marker || marker.length < 16) throw new Error('A synthetic build marker of at least 16 characters is required');
  const bytes = fs.readFileSync(file);
  const entries = await tarEntries(bytes);
  if (!entries.has('index.json') || !entries.has('oci-layout')) throw new Error('Expected an OCI image archive');
  const index = JSON.parse(entries.get('index.json').toString('utf8'));
  if (index.manifests?.length !== 1) throw new Error('The demo supports one image manifest');
  const descriptor = index.manifests[0];
  const manifest = JSON.parse(blob(entries, descriptor.digest).toString('utf8'));
  if (!manifest.config || !Array.isArray(manifest.layers) || !manifest.layers.length) throw new Error('OCI image manifest is incomplete');
  const configBytes = blob(entries, manifest.config.digest);
  const config = JSON.parse(configBytes.toString('utf8'));
  const hits = [];
  if (configBytes.includes(Buffer.from(marker))) hits.push('image configuration or history');
  for (const [number, layer] of manifest.layers.entries()) {
    if (!['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
      'application/vnd.docker.image.rootfs.diff.tar', 'application/vnd.docker.image.rootfs.diff.tar.gzip'].includes(layer.mediaType)) {
      throw new Error('Unsupported image layer format: ' + layer.mediaType);
    }
    let data = blob(entries, layer.digest);
    if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data, { maxOutputLength: 512 * 1024 * 1024 });
    if (data.includes(Buffer.from(marker))) hits.push('exported layer ' + number);
  }
  return {
    evidence_level: 'LOCAL_OCI_ARTIFACT',
    archive_sha256: sha256(bytes), digest: descriptor.digest,
    platform: { os: config.os, architecture: config.architecture },
    layers_checked: manifest.layers.length, marker_hits: hits,
    marker_sha256: sha256(Buffer.from(marker)), digest_verified: true
  };
}
